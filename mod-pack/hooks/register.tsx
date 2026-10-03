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
import type { Feature, FeatureContext, ModelAsk, ModelReply, Step } from './feature'
import { runMods } from './mods-command'
import { isFeatureOn, isSoundAllowed, isSoundOn, MAX_ROW_LINES, parseOverrides, rowBudget, STORE_KEY } from './settings'
import { tokenWeather } from './token-weather'
import { waitWhat } from './wait-what'
import type { ModPackFeatureStates } from '../types'

// The order is the row order in the band. Blast Radius draws no row.
const FEATURES: readonly Feature[] = [tokenWeather, cacheKeeper, waitWhat, blastRadius]

// Every feature's state, by feature id.
const featureStates = atom({ plugin: 'mod-pack', key: 'features' } as const, {} as ModPackFeatureStates)

// `isBusy` is added by `dispatch`, at the moment of the call.
type Active = { feature: Feature; ctx: Omit<FeatureContext, 'isBusy'> }[]

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
// starts the model call it asks for. One feature failing never stops the others.
async function dispatch($: EngineInterface, options: PluginOptions, call: (feature: Feature, state: unknown, ctx: FeatureContext) => Step<unknown> | undefined, only?: string) {
  for (const { feature, ctx } of await active($, options)) {
    if (only !== undefined && feature.id !== only) continue
    let stop: AbortController | undefined
    try {
      const states: Record<string, unknown> = await read($, featureStates)
      // `isBusy` is read here, in the same moment as the call, and the lock for a model call is
      // taken in the same moment as its answer: nothing can take the lock in between.
      const step = call(feature, states[feature.id], { ...ctx, isBusy: busyWith !== undefined })
      if (step?.ask) stop = beginAsk()
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
    } catch (error) {
      if (stop) releaseAsk(stop)
      $.ui.log(`mod-pack: ${feature.id} failed: ${String(error)}`)
    }
  }
}

// ---- The shared automation lock ----------------------------------------------------
// Only ONE automatic action runs at a time: a compaction, a model call of a mod (Wait What),
// and (a later mod) an automatic prompt submission. `busyWith` names the holder, or is
// undefined when free. It is plain module state on purpose: a hot reload drops it together
// with the running work and the timers, so it cannot stay set. A mod that sends prompts or
// calls a model by itself must check it first (`ctx.isBusy`).
//
// A compaction always takes the lock, even from a model call: the engine's own compaction
// cannot be refused, and the model call is a short side request with no history, so the two
// do not disturb each other. The model call then no longer holds the lock, and must not free it.
let busyWith: 'compaction' | 'model-call' | undefined

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
// running (the lock), and says so by a toast while a model call holds the lock (a few seconds
// at most: a call is cut after 15 seconds). `$.session.compact()` rejects while a turn runs and
// resolves `{ skip }` when a hook vetoes: both become a toast, and the row stays as it was.
// It runs through every hook but the calling one, so this plugin's own
// `session.compact` hook does not see this call: the lock and the clear are done here.
async function compactNow($: EngineInterface, options: PluginOptions) {
  if (busyWith === 'compaction') return
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
// `claude -p` run, where nobody can be asked.
async function askPerson($: EngineInterface, question: string): Promise<string | undefined> {
  return $.ui.ask(question, { options: [PROCEED, CANCEL], header: DIALOG_HEADER }).then(
    answer => answer,
    () => undefined,
  )
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

  const answer = await askPerson($, buildQuestion(command, risks, preview))
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
  const answer = await askPerson($, question)
  return isProceed(answer) ? proceed() : { deny: denyReason(answer, (risks ?? []).map(r => r.kind)) }
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    await $.command
      .register({ name: 'mods', description: 'List the mod-pack features and turn them on or off.', argumentHint: '[on|off|toggle <id> | sound on|off | reset]' })
      .catch(error => $.ui.log(`mod-pack: could not register /mods: ${String(error)}`))
    await dispatch($, options, (feature, state, ctx) => feature.sessionStart?.(state, { e }, ctx))
    await armTicker($, options)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    stopTicker()
    cancelAsk()
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
    await dispatch($, options, (feature, state, ctx) => feature.turnStart?.(state, { e }, ctx))
    await armTicker($, options)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const context = await $.session.usage().then(usage => usage.context, () => undefined)
    // A mod that spends tokens on a row only the terminal draws asks for this. Unknown counts as no terminal.
    const hasTerminal = await $.session.surfaces().then(surfaces => surfaces.includes('terminal'), () => false)
    await dispatch($, options, (feature, state, ctx) => feature.turnComplete?.(state, { e, context, hasTerminal }, ctx))
    await armTicker($, options)
    return next(e)
  })

  on('command.run', { command: 'mods' }, async ($, e) => {
    const result = runMods(e.args, FEATURES, parseOverrides(await $.store.get(STORE_KEY)), options)
    if (result.isChanged) {
      await $.store.set(STORE_KEY, result.overrides)
      $.ui.invalidate('ui.render')
    }
    return { text: result.text }
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
    const rows: { id: string; row: RenderElement; lines: number }[] = []
    let used = 0

    for (const { feature } of await active($, options)) {
      if (used >= budget) break
      try {
        const row = feature.band?.(states[feature.id], input, el, actions)
        if (!row) continue
        // A row is 1 line unless the feature says it draws more now (`bandLines`: Wait What, 2).
        // It never takes more than the rows left: then the first lines show and the rest is clipped.
        const asked = feature.bandLines?.(states[feature.id], input) ?? 1
        const wanted = Number.isFinite(asked) ? Math.floor(asked) : 1
        const lines = Math.max(1, Math.min(MAX_ROW_LINES, wanted, budget - used))
        rows.push({ id: feature.id, row, lines })
        used += lines
      } catch (error) {
        $.ui.log(`mod-pack: ${feature.id} band failed: ${String(error)}`)
      }
    }
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
