// State that mod-pack keeps in $.state, under the plugin name 'mod-pack'.
// The dispatcher keeps one entry per feature, by the feature's id.
// A new feature adds its state type here.

export type ModPackSample = { tokens: number; window: number }

// Cache Keeper: when the last main-conversation response came, and what it left in the context.
export type ModPackCacheClock = { at?: number; tokens?: number; isWorking?: boolean; isWarned?: boolean }

export type ModPackFeatureStates = {
  'token-weather'?: ModPackSample[]
  'cache-keeper'?: ModPackCacheClock
}

declare module 'claude-code' {
  interface PluginState {
    'mod-pack': {
      features: ModPackFeatureStates
    }
  }
}
