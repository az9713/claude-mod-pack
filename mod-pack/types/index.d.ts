// State that mod-pack keeps in $.state, under the plugin name 'mod-pack'.
// The dispatcher keeps one entry per feature, by the feature's id.
// A new feature adds its state type here.

export type ModPackSample = { tokens: number; window: number }

export type ModPackFeatureStates = {
  'token-weather'?: ModPackSample[]
}

declare module 'claude-code' {
  interface PluginState {
    'mod-pack': {
      features: ModPackFeatureStates
    }
  }
}
