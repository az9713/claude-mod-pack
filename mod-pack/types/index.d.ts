// State that mod-pack keeps in $.state, under the plugin name 'mod-pack'.
// The dispatcher keeps one entry per feature, by the feature's id.
// A new feature adds its state type here.

export type ModPackSample = { tokens: number; window: number }

// Cache Keeper: when the last main-conversation response came, and what it left in the context.
export type ModPackCacheClock = { at?: number; tokens?: number; isWorking?: boolean; isWarned?: boolean }

// Wait What: the start times of the model calls of the last hour (the hourly cap), the turn whose
// call is in flight, and the retell lines to show (1 or 2). `isLimited`: the cap refused the last call.
// `note`: why a long answer got no retell (drawn as one dim line). `skipped`: why the last answer was a
// normal skip (never drawn; `/mods` shows it).
export type ModPackRetell = { calls?: number[]; pending?: string; lines?: string[]; isLimited?: boolean; note?: string; skipped?: string }

// Prompt Queue: the prompts waiting (first to send first), why the queue is paused (if it is), whether a
// turn of the main conversation runs, and the turn that last sent a prompt (it never sends twice).
export type ModPackQueue = { items?: string[]; pause?: 'user' | 'aborted' | 'error' | 'refusal' | 'send-failed'; isWorking?: boolean; sentFor?: string }

// Ship Gate: the last test-like command that passed (`command` is cut to 80 characters, `at` is the clock in ms,
// `fingerprint` is the tree it passed on), and one line about the last time the gate held a command.
export type ModPackShipGate = { test?: { command: string; at: number; fingerprint: string }; gate?: string }

export type ModPackFeatureStates = {
  'token-weather'?: ModPackSample[]
  'cache-keeper'?: ModPackCacheClock
  'prompt-queue'?: ModPackQueue
  'wait-what'?: ModPackRetell
  'ship-gate'?: ModPackShipGate
}

// Snake: one cell of the board (x from the left, y from the top, both from 0).
export type ModPackSnakeCell = { x: number; y: number }

// Snake: the whole game. It lives under its own key, not in `features`, because the game writes about
// 7 times a second while it runs, and every reader of `features` (the band) would be drawn again each time.
// `body` is head first. `queue` holds the turns that wait for the next ticks (at most 2). `food` is null
// when the board is full. `pause` says why a paused game is paused: the person, Claude finished a turn, or
// a Blast Radius question is open. `seed` is the state of the random number generator (JSON, so it survives a reload).
export type ModPackSnake = {
  cols: number
  rows: number
  body: ModPackSnakeCell[]
  dir: 'up' | 'down' | 'left' | 'right'
  queue: ('up' | 'down' | 'left' | 'right')[]
  food: ModPackSnakeCell | null
  score: number
  best: number
  status: 'running' | 'paused' | 'over'
  pause?: 'person' | 'claude' | 'question'
  isWon?: true
  seed: number
}

declare module 'claude-code' {
  interface PluginState {
    'mod-pack': {
      features: ModPackFeatureStates
      snake: ModPackSnake | null
    }
  }
}
