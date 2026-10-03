// The contract between the dispatcher (register.tsx) and one mod in the pack.
//
// A feature is a plain object of PURE functions. It never receives `$`.
// Why: `claude plugin validate` refuses a `$` that is passed to an imported
// function or to an object's method ("$ itself is passed as an argument"), so
// every `$` call has to be written in register.tsx. The dispatcher therefore
// reads the engine, hands the feature plain data, and applies what the feature
// returns: its new state, and a sound to play.
//
// The dispatcher calls a callback only while the feature is ON, and an error
// in one feature never reaches another.

import type { Elements, PluginOptions, RenderElement, RenderPropsOf, SessionContextUsage, SessionEndInput, SessionStartInput, TurnCompleteInput, TurnStartInput } from 'claude-code'

// The terminal's element table: Box, Text, Button, ...
export type Terminal = Elements['terminal']

// What the dispatcher tells a feature about the moment of the call.
export type FeatureContext = {
  // True only when ALL of these hold: the global `sound` setting is ON, this
  // feature is ON, and this feature declares `hasSound`.
  isSoundAllowed: boolean
  // The engine's clock at the moment of the call, in ms. NaN when it could not be read.
  now: number
  // The plugin's settings (userConfig). A mod reads its own number settings here.
  options: PluginOptions
}

// What a callback returns. Both fields are optional; returning nothing changes nothing.
export type Step<S> = {
  // The feature's new state. The dispatcher keeps it in $.state under the
  // feature's id, so it survives a hot reload.
  state?: S
  // A sound file of this plugin, relative to the plugin folder ('assets/x.wav').
  // The dispatcher plays it only when `isSoundAllowed` is true.
  sound?: string
  // A line for `$.ui.toast`. The dispatcher shows it.
  toast?: string
}

export type Feature<S = unknown> = {
  // Short kebab-case name. Used by `/mods on <id>`. The userConfig key is the
  // camelCase of it (`token-weather` -> `tokenWeather`).
  id: string
  title: string
  // One line for the `/mods` list.
  about: string
  // True when the feature spends model tokens (shown in `/mods`).
  usesModel?: boolean
  // True when the feature can play a sound (shown in `/mods`).
  hasSound?: boolean
  // The state when neither the user's setting nor a /mods override says.
  defaultOn: boolean

  // `state` is the feature's own earlier state, undefined before its first step.
  // `context` is the engine's reading of the context window; undefined when it could not be read.
  turnComplete?: (state: S | undefined, input: { e: TurnCompleteInput; context: SessionContextUsage | undefined }, ctx: FeatureContext) => Step<S> | undefined
  turnStart?: (state: S | undefined, input: { e: TurnStartInput }, ctx: FeatureContext) => Step<S> | undefined
  sessionStart?: (state: S | undefined, input: { e: SessionStartInput }, ctx: FeatureContext) => Step<S> | undefined
  // The session ends: exit, or /clear (which raises no `session.start` after it).
  sessionEnd?: (state: S | undefined, input: { e: SessionEndInput }, ctx: FeatureContext) => Step<S> | undefined
  // The main conversation was compacted (by the person, by the engine, or by a mod).
  compacted?: (state: S | undefined, ctx: FeatureContext) => Step<S> | undefined
  // Once a minute while a feature with a `tick` is ON. The dispatcher redraws the band after it.
  tick?: (state: S | undefined, ctx: FeatureContext) => Step<S> | undefined

  // One row for the band above the prompt, or null to draw nothing now.
  // The compositor clips the row to one terminal row and counts it as one row
  // against its budget. `el` is the terminal's element table.
  // Never bind a digit hotkey here (see README, "How mods share the band").
  // `e.now` is the clock (NaN when unreadable) and `e.isCompacting` is the shared
  // automation lock. `actions` are plain callbacks the dispatcher built, for a Button's `onPress`.
  band?: (state: S | undefined, e: BandInput, el: Terminal, actions: BandActions) => RenderElement | null
}

export type BandInput = { props: RenderPropsOf['AbovePrompt']; now: number; options: PluginOptions; isCompacting: boolean }

// What a band row may trigger. Each one is fire-and-forget: it returns at once.
export type BandActions = { compact: () => void }

// Types the feature's state `S`, then stores it with the state erased, so that
// FEATURES can hold features of different state types in one list.
export const defineFeature = <S>(feature: Feature<S>): Feature => feature as unknown as Feature
