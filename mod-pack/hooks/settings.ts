// Pure helpers: which features are ON, which rows fit. No engine calls here,
// so they can be tested without the engine.

import type { PluginOptions } from 'claude-code'

import type { Feature } from './feature'

// Runtime choices made with /mods. They beat the user's settings until `/mods reset`.
export type Overrides = { features: Record<string, boolean>; sound?: boolean }

// Key in $.store.
export const STORE_KEY = 'mod-pack/overrides'

export const NO_OVERRIDES: Overrides = { features: {} }

// `token-weather` -> `tokenWeather`: the userConfig key of a feature.
export const optionKey = (id: string) => id.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase())

// Read what $.store returned. Anything that is not the expected shape counts as no override.
export const parseOverrides = (raw: unknown): Overrides => {
  if (typeof raw !== 'object' || raw === null) return { features: {} }
  const { features, sound } = raw as { features?: unknown; sound?: unknown }
  const clean: Record<string, boolean> = {}
  if (typeof features === 'object' && features !== null) {
    for (const [id, value] of Object.entries(features)) if (typeof value === 'boolean') clean[id] = value
  }
  return typeof sound === 'boolean' ? { features: clean, sound } : { features: clean }
}

// Override, else the user's setting, else the feature's own default.
export const isFeatureOn = (feature: Pick<Feature, 'id' | 'defaultOn'>, overrides: Overrides, options: PluginOptions) => {
  const set = options[optionKey(feature.id)]
  return overrides.features[feature.id] ?? (typeof set === 'boolean' ? set : feature.defaultOn)
}

// The global sound switch: override, else the `sound` setting, else OFF.
export const isSoundOn = (overrides: Overrides, options: PluginOptions) => overrides.sound ?? options.sound === true

// Sound plays only if the global switch is ON, the feature is ON and the feature can play sound.
export const isSoundAllowed = (feature: Pick<Feature, 'hasSound'>, isOn: boolean, isGlobalSoundOn: boolean) =>
  isGlobalSoundOn && isOn && feature.hasSound === true

// How many rows the pack may add to the band. `maxRows` is what the whole band
// may take, for all plugins together. The pack cannot measure what the plugins
// beneath it drew, so it claims at most one third of `maxRows`, and never more
// than MAX_OWN_ROWS. Under 3 rows of room it adds none.
export const MAX_OWN_ROWS = 4
// The most lines one mod's row may take (a feature's `bandLines`). Wait What takes 2.
export const MAX_ROW_LINES = 2
export const rowBudget = (maxRows: number) => Math.max(0, Math.min(MAX_OWN_ROWS, Math.floor(maxRows / 3)))
