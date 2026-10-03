// The dispatcher. It registers each event ONCE (the engine refuses the same
// event twice without a matcher) and hands the work to the features in FEATURES.
// Every `$` call of the pack is written in this file; see hooks/feature.ts.
//
// To add a mod: write a Feature (hooks/feature.ts), import it, add it to FEATURES,
// add a boolean to userConfig in .claude-plugin/plugin.json, and add its state
// type to types/index.d.ts. The order of FEATURES is the row order in the band,
// first on top, and so also the priority when the row budget is short.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register, RenderElement } from 'claude-code'

import type { Feature, FeatureContext, Step } from './feature'
import { runMods } from './mods-command'
import { isFeatureOn, isSoundAllowed, isSoundOn, parseOverrides, rowBudget, STORE_KEY } from './settings'
import { tokenWeather } from './token-weather'
import type { ModPackFeatureStates } from '../types'

const FEATURES: readonly Feature[] = [tokenWeather]

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
