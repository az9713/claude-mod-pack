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
import type { Feature, FeatureContext, Step } from './feature'
import { runMods } from './mods-command'
import { isFeatureOn, isSoundAllowed, isSoundOn, parseOverrides, rowBudget, STORE_KEY } from './settings'
import { tokenWeather } from './token-weather'
import type { ModPackFeatureStates } from '../types'

// The order is the row order in the band. Blast Radius draws no row.
const FEATURES: readonly Feature[] = [tokenWeather, blastRadius]

// Every feature's state, by feature id.
const featureStates = atom({ plugin: 'mod-pack', key: 'features' } as const, {} as ModPackFeatureStates)

type Active = { feature: Feature; ctx: FeatureContext }[]

// The features that are ON now, each with what it may do. Read at call time,
// so a /mods change applies at once, with no reload.
async function active($: EngineInterface, options: PluginOptions): Promise<Active> {
  const overrides = parseOverrides(await $.store.get(STORE_KEY))
  const isGlobalSoundOn = isSoundOn(overrides, options)
  return FEATURES.filter(f => isFeatureOn(f, overrides, options)).map(feature => ({
    feature,
    ctx: { isSoundAllowed: isSoundAllowed(feature, true, isGlobalSoundOn) },
  }))
}

// Runs `call` on each feature that is ON, keeps the state it returns, plays the
// sound it asks for when sound is allowed. One feature failing never stops the others.
async function dispatch($: EngineInterface, options: PluginOptions, call: (feature: Feature, state: unknown, ctx: FeatureContext) => Step<unknown> | undefined) {
  for (const { feature, ctx } of await active($, options)) {
    try {
      const states: Record<string, unknown> = await read($, featureStates)
      const step = call(feature, states[feature.id], ctx)
      if (step?.state !== undefined) {
        const state = step.state
        await update($, featureStates, all => ({ ...all, [feature.id]: state }))
      }
      if (step?.sound && ctx.isSoundAllowed) void $.audio.play({ asset: step.sound }).catch(() => undefined)
    } catch (error) {
      $.ui.log(`mod-pack: ${feature.id} failed: ${String(error)}`)
    }
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
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    await dispatch($, options, (feature, state, ctx) => feature.turnStart?.(state, { e }, ctx))
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const context = await $.session.usage().then(usage => usage.context, () => undefined)
    await dispatch($, options, (feature, state, ctx) => feature.turnComplete?.(state, { e, context }, ctx))
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
    const states: Record<string, unknown> = await read($, featureStates)
    const rows: { id: string; row: RenderElement }[] = []

    for (const { feature } of await active($, options)) {
      if (rows.length >= budget) break
      try {
        const row = feature.band?.(states[feature.id], e, el)
        if (row) rows.push({ id: feature.id, row })
      } catch (error) {
        $.ui.log(`mod-pack: ${feature.id} band failed: ${String(error)}`)
      }
    }
    if (rows.length === 0) return below

    const { Box } = el
    return (
      <Box flexDirection="column">
        {below}
        {rows.map(({ id, row }) => (
          <Box key={`row-${id}`} height={1} overflow="hidden">{row}</Box>
        ))}
      </Box>
    )
  })
}
