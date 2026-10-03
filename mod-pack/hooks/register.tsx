// The dispatcher. It registers each event ONCE (the engine refuses the same
// event twice without a matcher) and hands the work to the features in FEATURES.
// Every `$` call of the pack is written in this file; see hooks/feature.ts.
//
// To add a mod: write a Feature (hooks/feature.ts), import it, add it to FEATURES,
// add a boolean to userConfig in .claude-plugin/plugin.json, and add its state
// type to types/index.d.ts. The order of FEATURES is the row order in the band,
// first on top, and so also the priority when the row budget is short.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register, RenderElement, ToolCallResult } from 'claude-code'

import {
  blastRadius, branchTargets, buildQuestion, cleanDryRun, CANCEL, classify, denyReason, DIALOG_HEADER, ENTRY_CAP, GIT_READ, hasGitOptions, isProceed,
  MAX_PATHS, MAX_RISKS_PREVIEWED, NO_GIT_PREVIEW, NO_PREVIEW, OUTPUT_CAP, pathArgs, previewBranch, previewClean, previewPaths, previewPush,
  previewStash, previewStatus, PROCEED, pushPlan, resolvePath, STEP_TIMEOUT_MS,
} from './blast-radius'
import type { GitOut, PathFact, Risk } from './blast-radius'
import { cacheKeeper } from './cache-keeper'
import type { Feature, FeatureContext, Lock, ModelAsk, ModelReply, Step } from './feature'
import { runMods } from './mods-command'
import { promptQueue } from './prompt-queue'
import { runQ } from './queue'
import type { Queue } from './queue'
import { isFeatureOn, isSoundAllowed, isSoundOn, layoutRows, parseOverrides, rowBudget, STORE_KEY } from './settings'
import { MIN_COLUMNS, PANE_ROWS, snake, snakeView } from './snake'
import { halt, newGame, parseBest, pauseFor, restart, resumeFrom, steer, step, toggle } from './snake-game'
import type { Dir, SnakeGame } from './snake-game'
import { tokenWeather } from './token-weather'
import { waitWhat } from './wait-what'
import type { ModPackFeatureStates } from '../types'

// The order is the row order in the band. Blast Radius and Snake draw no row (Snake draws a pane).
// Prompt Queue stands before Wait What on purpose: its row is 1 line and must not be starved by a
// 2-line retell.
const FEATURES: readonly Feature[] = [tokenWeather, cacheKeeper, promptQueue, waitWhat, blastRadius, snake]

// Every feature's state, by feature id.
const featureStates = atom({ plugin: 'mod-pack', key: 'features' } as const, {} as ModPackFeatureStates)

// `isBusy` and `lock` are added by `dispatch`, at the moment of the call.
type Active = { feature: Feature; ctx: Omit<FeatureContext, 'isBusy' | 'lock'> }[]

// The features that are ON now, each with what it may do. Read at call time,
// so a /mods change applies at once, with no reload.
async function active($: EngineInterface, options: PluginOptions): Promise<Active> {
  const overrides = parseOverrides(await $.store.get(STORE_KEY))
  const isGlobalSoundOn = isSoundOn(overrides, options)
  const now = await $.clock.now().catch(() => NaN)
  return FEATURES.filter(f => isFeatureOn(f, overrides, options)).map(feature => ({
    feature,
    ctx: { isSoundAllowed: isSoundAllowed(feature, true, isGlobalSoundOn), now, options },
  }))
}

// Runs `call` on each feature that is ON (or only on the one named by `only`), keeps the state
// it returns, shows the toast it asks for, plays the sound it asks for when sound is allowed, and
// starts the model call it asks for, and sends the prompt it asks for. One feature failing never
// stops the others.
async function dispatch($: EngineInterface, options: PluginOptions, call: (feature: Feature, state: unknown, ctx: FeatureContext) => Step<unknown> | undefined, only?: string) {
  for (const { feature, ctx } of await active($, options)) {
    if (only !== undefined && feature.id !== only) continue
    // A feature that a command also changes (`/q`) runs one call at a time, in the order they came.
    if (feature.isSerial) await inOrder(() => dispatchOne($, options, feature, ctx, call))
    else await dispatchOne($, options, feature, ctx, call)
  }
}

async function dispatchOne($: EngineInterface, options: PluginOptions, feature: Feature, ctx: Active[number]['ctx'], call: (feature: Feature, state: unknown, ctx: FeatureContext) => Step<unknown> | undefined) {
  let stop: AbortController | undefined
  let sending: object | undefined
  try {
    const states: Record<string, unknown> = await read($, featureStates)
    // `isBusy` and `lock` are read here, in the same moment as the call, and the lock for a model call
    // or a prompt is taken in the same moment as its answer: nothing can take the lock in between.
    const step = call(feature, states[feature.id], { ...ctx, isBusy: busyWith !== undefined, lock: busyWith })
    if (step?.ask) stop = beginAsk()
    if (step?.submit !== undefined) {
      sending = beginSubmit()
      // The feature read the lock a moment ago, so this cannot happen. If it does, nothing is
      // changed and nothing is sent: the prompt stays where it was.
      if (!sending) return $.ui.log(`mod-pack: ${feature.id} did not send: the lock is held`)
    }
    if (step?.state !== undefined) {
      const state = step.state
      await update($, featureStates, all => ({ ...all, [feature.id]: state }))
    }
    if (step?.toast) $.ui.toast(step.toast)
    if (step?.sound && ctx.isSoundAllowed) void $.audio.play({ asset: step.sound }).catch(() => undefined)
    if (step?.ask && stop) {
      // Detached: the event that raised this call never waits for the model.
      void runAsk($, options, feature, step.ask, stop)
      stop = undefined
    }
    if (step?.submit !== undefined && sending) {
      // Detached: `$.prompt.submit` resolves when the new turn starts, and a hook that waits for it
      // inside `turn.complete` would wait for ever.
      void runSubmit($, options, feature, step.submit, sending)
      sending = undefined
      $.ui.invalidate('ui.render')
    }
  } catch (error) {
    if (stop) releaseAsk(stop)
    if (sending) releaseSubmit(sending)
    $.ui.log(`mod-pack: ${feature.id} failed: ${String(error)}`)
  }
}

// Runs the jobs of `inOrder` one after the other. Plain module state: a hot reload drops it.
let orderTail: Promise<unknown> = Promise.resolve()
function inOrder<T>(job: () => Promise<T>): Promise<T> {
  const run = orderTail.then(job, job)
  orderTail = run.catch(() => undefined)
  return run
}

// ---- The shared automation lock ----------------------------------------------------
// Only ONE automatic action runs at a time: a compaction, a model call of a mod (Wait What),
// and an automatic prompt submission (Prompt Queue). `busyWith` names the holder, or is
// undefined when free. It is plain module state on purpose: a hot reload drops it together
// with the running work and the timers, so it cannot stay set. A mod that sends prompts or
// calls a model by itself must check it first (`ctx.isBusy`, and `ctx.lock` for who holds it).
//
// A compaction always takes the lock, even from a model call or a prompt on its way: the engine's
// own compaction cannot be refused, and the model call is a short side request with no history, so
// the two do not disturb each other. The call then no longer holds the lock, and must not free it.
//
// Which holders block the Prompt Queue: a compaction, and another prompt of the queue that is still
// on its way. A model call does not: the queue's prompt starts a turn, a new turn cancels the call
// anyway, and `beginSubmit` cancels it at once and takes the lock.
let busyWith: Lock | undefined

// ---- Model calls (Wait What) ---------------------------------------------------------
// At most ONE model call of a mod is in flight. `askStop` is its AbortController, and also the
// proof of who owns the lock: only the owner frees it. A call is cancelled when a turn starts
// or the session ends, and its reply is then dropped.
let askStop: AbortController | undefined

// Takes the lock for a model call. Undefined when the lock is held by someone else.
function beginAsk(): AbortController | undefined {
  if (busyWith !== undefined) return undefined
  cancelAsk()
  busyWith = 'model-call'
  askStop = new AbortController()
  return askStop
}

// The call ended: free the lock if this call still owns it.
function releaseAsk(stop: AbortController) {
  if (askStop !== stop) return
  askStop = undefined
  if (busyWith === 'model-call') busyWith = undefined
}

// Cancels the call in flight, if any, and frees its lock at once.
function cancelAsk() {
  const stop = askStop
  if (!stop) return
  stop.abort()
  releaseAsk(stop)
}

// ---- Prompt submissions (Prompt Queue) ----------------------------------------------
// At most ONE queued prompt is on its way. `submitOwner` is its token, and the proof of who owns the
// lock: only the owner frees it. The lock is held from the decision to send until the prompt's turn
// starts (`turn.start`), the call settles, the session ends, or SUBMIT_LOCK_MS has passed.
let submitOwner: object | undefined
const SUBMIT_LOCK_MS = 30_000

// Takes the lock for a prompt. Undefined when a compaction or another prompt holds it. A model call
// of a mod does not stop it: the call is cancelled here, and its reply is dropped.
function beginSubmit(): object | undefined {
  if (busyWith === 'compaction' || busyWith === 'prompt-submit') return undefined
  cancelAsk()
  busyWith = 'prompt-submit'
  submitOwner = {}
  return submitOwner
}

// Frees the lock if `owner` still owns it. With no `owner`: whoever owns it (a turn started, or the
// session ended). A compaction that took the lock over is not freed: the holder is checked.
function releaseSubmit(owner?: object) {
  if (owner !== undefined && submitOwner !== owner) return
  submitOwner = undefined
  if (busyWith === 'prompt-submit') busyWith = undefined
}

// Sends one prompt for a feature, as the person's own words. It is called with `void`, so it never
// throws. The call resolves when the new turn starts (or the prompt is queued behind a running one),
// and a hook may answer it with `{ drop }`. A drop and a rejection both go back to the feature.
async function runSubmit($: EngineInterface, options: PluginOptions, feature: Feature, text: string, owner: object) {
  // If the call never settles, the lock is not held for ever.
  const guard = $.clock.after(SUBMIT_LOCK_MS, () => releaseSubmit(owner))
  try {
    let why: string | undefined
    try {
      const result = await $.prompt.submit({ text, asUser: true })
      if (result.drop !== undefined) why = `a hook dropped it: ${String(result.drop).slice(0, 120)}`
    } catch (error) {
      why = String(error).slice(0, 120)
    }
    guard.cancel()
    releaseSubmit(owner)
    if (why !== undefined) {
      const reason = why
      $.ui.log(`mod-pack: ${feature.id} could not send a prompt: ${reason}`)
      await dispatch($, options, (f, state, ctx) => f.submitFailed?.(state, { text, why: reason }, ctx), feature.id)
      $.ui.invalidate('ui.render')
    }
  } catch (error) {
    $.ui.log(`mod-pack: ${feature.id} send failed: ${String(error)}`)
  } finally {
    guard.cancel()
    releaseSubmit(owner)
  }
}

// One model call for a feature, then the reply to the feature (`modelDone`). It is called with
// `void`, so it never throws: every failure ends as "no reply". The call is `$.model.complete`:
// no history, so the conversation and its cache are not touched. It always resolves a result,
// and rejects only for a request the engine refuses to send (a blocked model).
async function runAsk($: EngineInterface, options: PluginOptions, feature: Feature, ask: ModelAsk, stop: AbortController) {
  try {
    let reply: ModelReply = { isAnswered: false }
    try {
      const result = await $.model.complete(
        { model: ask.model, system: ask.system, prompt: ask.prompt, maxTokens: ask.maxTokens, timeoutMs: ask.timeoutMs, ...(ask.effort ? { effort: ask.effort } : {}) },
        { signal: stop.signal },
      )
      if (result.isAnswered) reply = { isAnswered: true, text: result.text }
    } catch (error) {
      $.ui.log(`mod-pack: ${feature.id} model call failed: ${String(error).slice(0, 200)}`)
    } finally {
      releaseAsk(stop)
    }
    // Cancelled (a turn started or the session ended): the reply is of no use.
    if (stop.signal.aborted) return
    await dispatch($, options, (f, state, ctx) => f.modelDone?.(state, { turnId: ask.turnId, reply }, ctx), feature.id)
    $.ui.invalidate('ui.render')
  } catch (error) {
    $.ui.log(`mod-pack: ${feature.id} model reply failed: ${String(error)}`)
  }
}

// ---- The minute timer ---------------------------------------------------------------
// Features with a `tick` (Cache Keeper) get one call a minute. The timer is started
// from events (session.start, turn.start, turn.complete), not only session.start,
// because a /clear raises no session.start. A hot reload drops the timer and resets
// `ticker`, so the next event starts one. It stops at session.end, and by itself
// when no feature with a `tick` is ON.
let ticker: { cancel: () => void } | undefined

function stopTicker() {
  ticker?.cancel()
  ticker = undefined
}

async function minuteTick($: EngineInterface, options: PluginOptions) {
  try {
    if (!(await active($, options)).some(({ feature }) => feature.tick)) return stopTicker()
    await dispatch($, options, (feature, state, ctx) => feature.tick?.(state, ctx))
    $.ui.invalidate('ui.render')
  } catch (error) {
    $.ui.log(`mod-pack: minute tick failed: ${String(error)}`)
  }
}

async function armTicker($: EngineInterface, options: PluginOptions) {
  if (ticker || !(await active($, options).catch(() => [])).some(({ feature }) => feature.tick)) return
  ticker = $.clock.every(60_000, () => void minuteTick($, options))
}

// ---- Cache Keeper -------------------------------------------------------------------

// A compaction of the main conversation stands: every feature that watches for it clears.
async function afterCompaction($: EngineInterface, options: PluginOptions) {
  await dispatch($, options, (feature, state, ctx) => feature.compacted?.(state, ctx))
  $.ui.invalidate('ui.render')
}

// What the band's "compact" button does. It ignores the press while any compaction is
// running (the lock), and says so by a toast while a model call or a queued prompt holds the lock
// (a few seconds at most: a call is cut after 15 seconds). `$.session.compact()` rejects while a turn runs and
// resolves `{ skip }` when a hook vetoes: both become a toast, and the row stays as it was.
// It runs through every hook but the calling one, so this plugin's own
// `session.compact` hook does not see this call: the lock and the clear are done here.
async function compactNow($: EngineInterface, options: PluginOptions) {
  if (busyWith === 'compaction') return
  if (busyWith === 'prompt-submit') return $.ui.toast('Cache Keeper: Prompt Queue is sending a prompt. Press compact again in a moment.')
  if (busyWith !== undefined) return $.ui.toast('Cache Keeper: a Wait What retell is running. Press compact again in a few seconds.')
  busyWith = 'compaction'
  $.ui.invalidate('ui.render')
  try {
    const result = await $.session.compact()
    if (result.skip === undefined) await afterCompaction($, options)
    else $.ui.toast(`Cache Keeper: compaction skipped: ${result.skip}`)
  } catch (error) {
    $.ui.toast(`Cache Keeper: could not compact now (${String(error).slice(0, 120)})`)
  } finally {
    busyWith = undefined
    $.ui.invalidate('ui.render')
  }
}

// ---- Blast Radius -----------------------------------------------------------------
// The pure rules and text are in blast-radius.ts. The engine calls are here.

// Read at call time, so `/mods off blast-radius` applies at once, with no reload.
async function isBlastRadiusOn($: EngineInterface, options: PluginOptions) {
  return isFeatureOn(blastRadius, parseOverrides(await $.store.get(STORE_KEY)), options)
}

// One read-only git call: argv, no shell, its own timeout, its output cut to OUTPUT_CAP.
// Undefined when git cannot start or runs out of time. Never throws.
async function git($: EngineInterface, args: readonly string[], cwd: string | undefined): Promise<GitOut | undefined> {
  const run = await $.process.run([...GIT_READ, ...args], { cwd, timeoutMs: STEP_TIMEOUT_MS }).catch(() => undefined)
  if (!run) return undefined
  return { ok: run.exitCode === 0, text: run.stdout.slice(0, OUTPUT_CAP), isCut: run.isStdoutTruncated || run.stdout.length > OUTPUT_CAP }
}

// How many entries are inside a directory, counting every level. At most ENTRY_CAP
// entries are visited, and a symbolic link is an entry that is never entered
// ($.fs.list says `other` for a link), so a link cycle cannot loop.
async function countEntries($: EngineInterface, root: string) {
  const waiting = [root]
  let entries = 0
  while (waiting.length > 0 && entries <= ENTRY_CAP) {
    const dir = waiting.pop() as string
    for (const entry of await $.fs.list(dir).catch(() => [])) {
      entries++
      if (entry.kind === 'dir') waiting.push(`${dir.replace(/[\\/]+$/, '')}/${entry.name}`)
    }
  }
  return { entries: Math.min(entries, ENTRY_CAP), isCapped: entries > ENTRY_CAP }
}

// What one path is. `path` is as typed (it is shown), `resolved` is where to look.
async function describePath($: EngineInterface, path: string, resolved: string): Promise<PathFact> {
  const stat = await $.fs.stat(resolved).catch(() => undefined)
  if (!stat) return { path, kind: 'missing' }
  if (stat.isLink) return { path, kind: 'link' }
  if (stat.kind === 'dir') return { path, kind: 'dir', ...(await countEntries($, resolved)) }
  return { path, kind: stat.kind }
}

// The lines that say what one risky segment would change. Best effort: any failure
// becomes "no preview available". Never throws, so the dialog is always shown.
async function previewRisk($: EngineInterface, risk: Risk, cwd: string | undefined): Promise<string[]> {
  try {
    if (risk.preview === 'paths') {
      const args = pathArgs(risk.segment)
      // `cd x && rm -rf y`: y is not in the session folder, so it is not looked at.
      const looked = risk.hasCd || cwd === undefined ? [] : args.paths.slice(0, MAX_PATHS)
      const facts = await Promise.all(looked.map(path => describePath($, path, resolvePath(cwd as string, path))))
      return previewPaths(facts, args, risk.hasCd)
    }

    // Every other kind runs git. The command's own git options (-C, -c) are not followed.
    if (hasGitOptions(risk.segment)) return [NO_GIT_PREVIEW]

    if (risk.preview === 'status-all' || risk.preview === 'status-worktree') {
      const [status, shortstat] = await Promise.all([git($, ['status', '--porcelain'], cwd), git($, ['diff', '--shortstat', '--no-ext-diff', 'HEAD'], cwd)])
      return previewStatus(status, shortstat, risk.preview === 'status-all' ? 'all' : 'worktree')
    }

    if (risk.preview === 'clean') {
      const dryRun = cleanDryRun(risk.segment)
      return dryRun ? previewClean(await git($, dryRun, cwd)) : [NO_GIT_PREVIEW]
    }

    if (risk.preview === 'push') {
      const plan = pushPlan(risk.segment)
      const [branch, upstream, count, log] = await Promise.all([
        git($, ['rev-parse', '--abbrev-ref', 'HEAD'], cwd),
        git($, ['rev-parse', '--abbrev-ref', '@{u}'], cwd),
        plan.range ? git($, ['rev-list', '--count', plan.range], cwd) : undefined,
        plan.range ? git($, ['log', '--oneline', '-n', '10', plan.range], cwd) : undefined,
      ])
      return previewPush({ branch, upstream, count, log, plan })
    }

    if (risk.preview === 'branch') {
      const items = await Promise.all(branchTargets(risk.segment).map(async name => ({ name, count: await git($, ['rev-list', '--count', `HEAD..${name}`], cwd) })))
      return previewBranch(items)
    }

    return previewStash(await git($, ['stash', 'list'], cwd))
  } catch (error) {
    $.ui.log(`mod-pack: blast-radius preview failed: ${String(error)}`)
    return [NO_PREVIEW]
  }
}

// Asks the person. Resolves the label chosen, or the text typed under "Other", or
// undefined when `$.ui.ask` rejects. It rejects when the dialog is dismissed, and in a
// `claude -p` run, where nobody can be asked. While the question is open a Snake game that is
// running is paused (`holdSnake`): the dialog takes the keyboard, so the person cannot steer.
async function askPerson($: EngineInterface, options: PluginOptions, question: string): Promise<string | undefined> {
  await holdSnake($, options, true)
  try {
    return await $.ui.ask(question, { options: [PROCEED, CANCEL], header: DIALOG_HEADER }).then(
      answer => answer,
      () => undefined,
    )
  } finally {
    await holdSnake($, options, false)
  }
}

// The `tool.call` guard for the shell tools. A safe command, or the mod switched off,
// goes straight on. A risky one waits for the dialog. Only an explicit Proceed lets it
// run. Cancel, a dismissed dialog, no one to ask, and any other answer deny it (fail
// closed), so a `claude -p` run denies every risky command.
async function guardShell($: EngineInterface, options: PluginOptions, command: string, proceed: () => Promise<ToolCallResult>): Promise<ToolCallResult> {
  if (!(await isBlastRadiusOn($, options))) return proceed()
  const risks = classify(command)
  if (risks.length === 0) return proceed()

  const cwd = await $.session.cwd().catch(() => undefined)
  const preview: string[] = []
  for (const risk of risks.slice(0, MAX_RISKS_PREVIEWED)) preview.push(...(await previewRisk($, risk, cwd)))
  if (risks.length > MAX_RISKS_PREVIEWED) preview.push(`...and ${risks.length - MAX_RISKS_PREVIEWED} more risky parts of the command`)

  const answer = await askPerson($, options, buildQuestion(command, risks, preview))
  return isProceed(answer) ? proceed() : { deny: denyReason(answer, risks.map(r => r.kind)) }
}

// If the guard crashes or runs out of its 10 seconds, the engine skips the hook and the
// command would run. This handler runs in its place. It has 1 second of its own time,
// and the time inside `$` calls (the dialog too) does not count. It asks again, without
// a preview. Only a command it can show to be safe, or the mod being off, goes on unasked.
async function guardShellFailed($: EngineInterface, options: PluginOptions, command: string, failure: { message?: string; called: boolean }, proceed: () => Promise<ToolCallResult>): Promise<ToolCallResult> {
  // The guard had already called `next`: replay what it settled to, and do not ask twice.
  if (failure.called) return proceed()
  if (!(await isBlastRadiusOn($, options).catch(() => true))) return proceed()

  let risks: Risk[] | undefined
  try {
    risks = classify(command)
  } catch {
    risks = undefined
  }
  if (risks?.length === 0) return proceed()

  const why = failure.message ? ` (${failure.message.slice(0, 120)})` : ''
  const question = buildQuestion(command, risks ?? [], [`${NO_PREVIEW}: the Blast Radius check itself failed${why}.`])
  const answer = await askPerson($, options, question)
  return isProceed(answer) ? proceed() : { deny: denyReason(answer, (risks ?? []).map(r => r.kind)) }
}

// ---- Prompt Queue -----------------------------------------------------------------
// The rules and the text are in queue.ts. The lock, the state and the sending are here.

const QUEUE_OFF_TEXT = 'mod-pack: prompt-queue is OFF. Nothing is queued and nothing is sent. Turn it on with /mods on prompt-queue.'

// `/q`. It runs one at a time with the mod's own callbacks (`isSerial`), so a prompt added in the
// same moment as a turn ends is neither lost nor sent twice. When the command starts a send (`/q`
// with no turn running), the lock is taken in the same moment as the decision, as `dispatch` does.
async function queueCommand($: EngineInterface, options: PluginOptions, args: string): Promise<{ text: string }> {
  if (!isFeatureOn(promptQueue, parseOverrides(await $.store.get(STORE_KEY)), options)) return { text: QUEUE_OFF_TEXT }
  return inOrder(async () => {
    const states: Record<string, unknown> = await read($, featureStates)
    const before = states[promptQueue.id] as Queue | undefined
    const result = runQ(args, before, busyWith)
    const owner = result.send !== undefined ? beginSubmit() : undefined
    if (result.send !== undefined && !owner) return { text: 'Prompt Queue: nothing was sent, because a compaction or another send is running. Nothing changed.' }
    try {
      const state = result.state ?? {}
      if (result.state !== before) await update($, featureStates, all => ({ ...all, [promptQueue.id]: state }))
    } catch (error) {
      if (owner) releaseSubmit(owner)
      throw error
    }
    if (owner && result.send !== undefined) {
      // The engine refuses `$.prompt.submit` from inside a command.run hook ("it would wait on the
      // turn this hook is holding"; found by the kit's host check). A timer of 0 ms sends it from an
      // event of its own, right after this hook has answered.
      const text = result.send
      $.clock.after(0, () => void runSubmit($, options, promptQueue, text, owner))
    }
    $.ui.invalidate('ui.render')
    return { text: result.text }
  })
}

// ---- Snake ------------------------------------------------------------------------
// The rules are in snake-game.ts, the drawing in snake.tsx. The engine calls are here: the pane, the
// timer, the pause and the resume, the command and the high score.
//
// The game has its OWN state key (`snakeGame`), not an entry of `featureStates`: it is written about
// 7 times a second while it runs, and every reader of `featureStates` (the band compositor) would be
// drawn again each time. Only the pane reads `snakeGame`, so only the pane is redrawn: `$.state.set`
// draws its readers, and nobody calls `$.ui.invalidate`.
//
// The tick is 150 ms: about 7 moves and 7 redraws a second. The engine folds redraws above 10 a second
// (30 for the pane that is shown), so every tick draws. A faster tick would be a faster game, not a
// smoother one. The timer is plain module state: a hot reload drops it with the old environment, and
// the game then waits (state `running`, no timer) until the next event that arms it: `session.start`,
// `turn.start` or a key press. No timer is left behind: it is cancelled when the pane closes, when the
// game stops running, when the session ends and when the mod is turned off.

const snakeGame = atom({ plugin: 'mod-pack', key: 'snake' } as const, null as SnakeGame | null)

const SNAKE_PANE = 'snake'
const SNAKE_TICK_MS = 150
// The high score. Best effort: a store that cannot be read or written gives 0 and a lost score.
const SNAKE_BEST_KEY = 'mod-pack/snake-best'
const SNAKE_OFF_TEXT = 'mod-pack: snake is OFF. Turn it on with /mods on snake.'
const SNAKE_NO_TERMINAL_TEXT = 'Snake draws in a terminal pane only, and this session has no terminal. Nothing was opened.'

let snakeTimer: { cancel: () => void } | undefined
function stopSnake() {
  snakeTimer?.cancel()
  snakeTimer = undefined
}

// How many Blast Radius questions are open now. The game is paused while there is one or more.
let questionsOpen = 0

// Read at call time, so `/mods off snake` applies at once, with no reload.
async function isSnakeOn($: EngineInterface, options: PluginOptions) {
  return isFeatureOn(snake, parseOverrides(await $.store.get(STORE_KEY)), options)
}

// Starts the timer when the game is running and no timer exists. The check and the start follow each
// other with no wait between, so two calls cannot start two timers.
async function armSnake($: EngineInterface, options: PluginOptions) {
  const game = await read($, snakeGame).catch(() => null)
  if (game?.status !== 'running' || snakeTimer) return
  snakeTimer = $.clock.every(SNAKE_TICK_MS, () => void snakeTick($, options))
}

// One move. It stops its own timer when the game is no longer running. When the game ends, the high
// score is kept (best effort). It never throws.
async function snakeTick($: EngineInterface, options: PluginOptions) {
  try {
    if (!(await isSnakeOn($, options))) return stopSnake()
    const before = await read($, snakeGame)
    if (before?.status !== 'running') return stopSnake()
    const after = await update($, snakeGame, game => (game?.status === 'running' ? step(game) : game))
    if (after?.status !== 'running') stopSnake()
    if (after?.status === 'over' && after.best > 0) await $.store.set(SNAKE_BEST_KEY, after.best).catch(() => undefined)
  } catch (error) {
    $.ui.log(`mod-pack: snake tick failed: ${String(error)}`)
  }
}

// Applies one change to the game (a key, a pause, a resume), then starts or stops the timer to match.
// `update` reads the game again at the moment of the write, so a key and a tick that come together both
// land. A mod that is OFF changes nothing. It never throws.
async function snakeChange($: EngineInterface, options: PluginOptions, change: (game: SnakeGame) => SnakeGame) {
  try {
    if (!(await isSnakeOn($, options))) return
    const game = await update($, snakeGame, current => (current ? change(current) : current))
    if (game?.status === 'running') await armSnake($, options)
    else stopSnake()
  } catch (error) {
    $.ui.log(`mod-pack: snake failed: ${String(error)}`)
  }
}

// A Blast Radius question opens or closes. The first one opened pauses a running game, and the last one
// closed resumes the game that it paused. It never throws, so the dialog is always shown.
async function holdSnake($: EngineInterface, options: PluginOptions, isOpening: boolean) {
  questionsOpen = isOpening ? questionsOpen + 1 : Math.max(0, questionsOpen - 1)
  if (isOpening ? questionsOpen !== 1 : questionsOpen !== 0) return
  await snakeChange($, options, game => (isOpening ? pauseFor(game, 'question') : resumeFrom(game, 'question')))
}

// The pane closed (the person's Esc or close mark, `/snake`, or `/mods off snake`): the timer stops and
// the game waits, so a later turn does not start it with nothing to draw it.
async function snakeClosed($: EngineInterface) {
  stopSnake()
  try {
    await update($, snakeGame, game => (game ? halt(game) : game))
  } catch (error) {
    $.ui.log(`mod-pack: snake close failed: ${String(error)}`)
  }
}

// `/snake`. It opens the pane, or closes it when it is open. The person's command seats a pane at any
// width (the declared `$.ui.open`), but the board needs MIN_COLUMNS: a narrower terminal is told so,
// and the pane itself says it when it is docked narrower than the board. A session with no terminal
// gets a text answer: the Pane component is raised on every surface, but only the terminal draws it here.
async function snakeCommand($: EngineInterface, options: PluginOptions, columns: number): Promise<{ text: string }> {
  if (!(await isSnakeOn($, options))) return { text: SNAKE_OFF_TEXT }
  const hasTerminal = await $.session.surfaces().then(surfaces => surfaces.includes('terminal'), () => false)
  if (!hasTerminal) return { text: SNAKE_NO_TERMINAL_TEXT }

  const panes = await $.ui.panes().catch(() => [])
  if (panes.some(pane => pane.id === SNAKE_PANE)) {
    await $.ui.close({ id: SNAKE_PANE }).catch(error => $.ui.log(`mod-pack: snake could not close: ${String(error)}`))
    return { text: 'Snake closed. /snake opens it again, with the game where you left it.' }
  }
  if (columns < MIN_COLUMNS) return { text: `Snake needs a terminal at least ${MIN_COLUMNS} columns wide. This one is ${columns}.` }

  const best = parseBest(await $.store.get(SNAKE_BEST_KEY).catch(() => undefined))
  const now = await $.clock.now().catch(() => NaN)
  await update($, snakeGame, game => (game ? (game.best >= best ? game : { ...game, best }) : newGame(Number.isFinite(now) ? now : 1, best)))

  try {
    const opened = await $.ui.open({ id: SNAKE_PANE, title: 'Snake', focus: true, closeOnEscape: true, rows: PANE_ROWS })
    if (!opened.isPlaced) return { text: `Snake could not be shown now: ${opened.reason}` }
  } catch (error) {
    return { text: `Snake could not be opened: ${String(error).slice(0, 120)}` }
  }
  return { text: 'Snake opened. Press p to play. The keys w a s d p r work while the pane has the keyboard (click it, or ctrl+x then Tab). Esc or /snake closes it.' }
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    await $.command
      .register({ name: 'mods', description: 'List the mod-pack features and turn them on or off.', argumentHint: '[on|off|toggle <id> | sound on|off | reset]' })
      .catch(error => $.ui.log(`mod-pack: could not register /mods: ${String(error)}`))
    // `immediate`: /q must run while a turn is in flight. That is the point of a queue.
    await $.command
      .register({ name: 'q', description: 'Queue follow-up prompts. They send one at a time when a turn ends.', argumentHint: '<text> | rm <n> | clear | pause | resume', immediate: true })
      .catch(error => $.ui.log(`mod-pack: could not register /q: ${String(error)}`))
    // `immediate`: the point of Snake is to open it while Claude works.
    await $.command
      .register({ name: 'snake', description: 'Play Snake in a pane. It pauses when Claude finishes and goes on at your next prompt.', immediate: true })
      .catch(error => $.ui.log(`mod-pack: could not register /snake: ${String(error)}`))
    await dispatch($, options, (feature, state, ctx) => feature.sessionStart?.(state, { e }, ctx))
    await armTicker($, options)
    // A hot reload drops the timer and keeps the game: a running game gets its timer back.
    await armSnake($, options)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    stopTicker()
    cancelAsk()
    releaseSubmit()
    stopSnake()
    await snakeChange($, options, halt)
    await dispatch($, options, (feature, state, ctx) => feature.sessionEnd?.(state, { e }, ctx)).catch(() => undefined)
    return next(e)
  })

  // Any compaction of the main conversation: the person's /compact, the engine's own
  // at its threshold, or a mod's. Held as the lock while it runs; the features are told
  // when it stands. `precompute` installs nothing, and a subagent's own compaction is
  // not the main conversation's, so neither counts.
  on('session.compact', async ($, e, next) => {
    if (e.trigger === 'precompute' || e.agentId !== undefined) return next(e)
    // Another compaction already holds the lock: this one is not its owner. A model call does not
    // keep a compaction out: the compaction takes the lock, and the model call must not free it.
    const isOwner = busyWith !== 'compaction'
    if (isOwner) busyWith = 'compaction'
    $.ui.invalidate('ui.render')
    try {
      const result = await next(e)
      if (result.skip === undefined) await afterCompaction($, options)
      return result
    } finally {
      if (isOwner) busyWith = undefined
      $.ui.invalidate('ui.render')
    }
  })

  on('turn.start', async ($, e, next) => {
    cancelAsk()
    // The turn of a prompt on its way has started: the prompt is in, the lock is free.
    releaseSubmit()
    await dispatch($, options, (feature, state, ctx) => feature.turnStart?.(state, { e }, ctx))
    await armTicker($, options)
    // A game that Claude's end paused goes on: the next prompt has started a turn.
    await snakeChange($, options, game => resumeFrom(game, 'claude'))
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const context = await $.session.usage().then(usage => usage.context, () => undefined)
    // A mod that spends tokens on a row only the terminal draws asks for this. Unknown counts as no terminal.
    const hasTerminal = await $.session.surfaces().then(surfaces => surfaces.includes('terminal'), () => false)
    await dispatch($, options, (feature, state, ctx) => feature.turnComplete?.(state, { e, context, hasTerminal }, ctx))
    await armTicker($, options)
    // The main conversation's turn ended: a running game pauses. A subagent's turn is not Claude finishing.
    if (e.agentId === undefined) await snakeChange($, options, game => pauseFor(game, 'claude'))
    return next(e)
  })

  on('command.run', { command: 'mods' }, async ($, e) => {
    const before = parseOverrides(await $.store.get(STORE_KEY))
    const result = runMods(e.args, FEATURES, before, options)
    if (result.isChanged) {
      await $.store.set(STORE_KEY, result.overrides)
      // Snake switched off: its pane closes and its timer stops at once.
      if (isFeatureOn(snake, before, options) && !isFeatureOn(snake, result.overrides, options)) {
        stopSnake()
        await $.ui.close({ id: SNAKE_PANE }).catch(() => undefined)
      }
      // A queue that is switched off is emptied: prompts that were queued must not send by themselves
      // later, after /mods on, when the person has forgotten them.
      if (!isFeatureOn(promptQueue, result.overrides, options)) {
        await inOrder(() => update($, featureStates, all => Object.fromEntries(Object.entries(all).filter(([id]) => id !== promptQueue.id)) as ModPackFeatureStates))
      }
      $.ui.invalidate('ui.render')
    }
    return { text: result.text }
  })

  // Prompt Queue. Matched by command name, so it does not clash with other plugins' command.run hooks.
  on('command.run', { command: 'q' }, ($, e) => queueCommand($, options, e.args))

  // Snake. Matched by command name, by pane id and by request id, so none of these clash with other plugins.
  on('command.run', { command: 'snake' }, ($, e) => snakeCommand($, options, e.presentation.columns))

  // The pane closed. A hook that answers without `next` keeps the pane open, so this one calls it.
  on('ui.close', { id: SNAKE_PANE }, async ($, e, next) => {
    const result = await next(e)
    await snakeClosed($)
    return result
  })

  // The Snake pane. It calls `next` and keeps what is below, as every `ui.render` hook of the pack does,
  // although only this plugin draws this pane: another plugin that hooks this pane still shows. Nothing
  // may be beneath a pane that only this plugin draws, and in the test kit the bottom of the chain then
  // throws (no implementation for ui.render). So a failing `next` counts as nothing below, and the pane
  // is drawn all the same. What the real engine answers there was not seen. The hook reads the game, so
  // a write to the game (a tick, a key) draws the pane again.
  on('ui.render', { component: 'Pane', requestId: SNAKE_PANE }, async ($, e, next) => {
    const below = await next(e).catch(() => undefined)
    if (e.surface !== 'terminal') {
      const { Box } = $.ui.resolve(e)
      return below ?? <Box />
    }
    const el = $.ui.resolve(e)
    const { Box } = el
    const game = await read($, snakeGame)
    if (!game) return below ?? <Box />

    const actions = {
      steer: (dir: Dir) => void snakeChange($, options, current => steer(current, dir)),
      toggle: () => void snakeChange($, options, toggle),
      restart: () => void snakeChange($, options, restart),
    }
    return (
      <Box flexDirection="column">
        {below}
        {snakeView(game, e.props, el, actions)}
      </Box>
    )
  })

  // Blast Radius. Matched by tool name, so it does not clash with the tool.call hooks
  // of other plugins. PowerShell is a tool of its own with the same `command` field.
  // The @ts-ignore lines: with many MCP servers connected, the engine writes a large
  // `.claude-plugin/types/claude-code-mcp/` and tsc then stops on a matcher for
  // `tool.call` with TS2589 (excessively deep). The types inside the hook still check.
  // @ts-ignore
  on('tool.call', { tool: 'Bash' }, ($, e, next) => guardShell($, options, e.command, () => next(e)))
    .catch(($, e, next) => guardShellFailed($, options, e.command, { message: next.error.message, called: next.called }, () => next(e)))
  // @ts-ignore
  on('tool.call', { tool: 'PowerShell' }, ($, e, next) => guardShell($, options, e.command, () => next(e)))
    .catch(($, e, next) => guardShellFailed($, options, e.command, { message: next.error.message, called: next.called }, () => next(e)))

  // The compositor: the one hook that draws in the band above the prompt.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (e.surface !== 'terminal' || e.props.hasSurvey) return below

    const el = $.ui.resolve(e)
    const budget = rowBudget(e.props.maxRows)
    const now = await $.clock.now().catch(() => NaN)
    const input = { props: e.props, now, options, isCompacting: busyWith === 'compaction' }
    const actions = { compact: () => void compactNow($, options) }
    const states: Record<string, unknown> = await read($, featureStates)
    // The rows that draw, in FEATURES order. A row is 1 line unless the feature says it draws more now
    // (`bandLines`: Wait What, 2). `layoutRows` (settings.ts) gives out the lines of the budget.
    const drawn: { id: string; row: RenderElement; asked: number }[] = []
    for (const { feature } of await active($, options)) {
      try {
        const row = feature.band?.(states[feature.id], input, el, actions)
        if (row) drawn.push({ id: feature.id, row, asked: feature.bandLines?.(states[feature.id], input) ?? 1 })
      } catch (error) {
        $.ui.log(`mod-pack: ${feature.id} band failed: ${String(error)}`)
      }
    }
    const rows = layoutRows(drawn, budget)
    if (rows.length === 0) return below

    const { Box } = el
    return (
      <Box flexDirection="column">
        {below}
        {rows.map(({ id, row, lines }) => (
          <Box key={`row-${id}`} height={lines} overflow="hidden">{row}</Box>
        ))}
      </Box>
    )
  })
}
