// Cache Keeper's pure rules: how long the prompt cache lives, how much of that is
// left, and the words for the row. No engine calls and no `$`, so every rule can
// be tested alone.
//
// What the lifetime is (code.claude.com/docs/en/prompt-caching, "Cache lifetime",
// and platform.claude.com/docs/en/build-with-claude/prompt-caching):
//   - the main conversation gets ONE HOUR on a Claude subscription within the
//     plan's included usage, and FIVE MINUTES on usage credits, an API key or a
//     cloud provider;
//   - each request that reads the cache refreshes the timer;
//   - the lifetime counts from the START of the request that wrote or read the
//     entry, not from the end of its response.
// A plugin cannot read which of the two cases the person is in (the declared API
// has no field for it), so the lifetime is a setting, `cacheTtlMinutes`.

import { fmt } from './forecast'

// 60 is the documented lifetime on a subscription. Set 5 on an API key, usage
// credits or a cloud provider.
export const DEFAULT_TTL_MINUTES = 60

// The longest setting that counts as valid: one day. Anything above it, zero,
// negative, not a number, or not finite gives the default.
export const MAX_TTL_MINUTES = 1440

// From this much time left, the row turns to a warning and one toast is shown.
export const WARN_MS = 5 * 60_000

const MINUTE_MS = 60_000

// What the dispatcher keeps in $.state for this mod.
export type CacheClock = {
  // The moment of the last main-conversation response (`turn.complete`); absent
  // before the first one, and again after a compaction or a /clear.
  at?: number
  // The context size at that moment, from $.session.usage(); absent when unreadable.
  tokens?: number
  // True from `turn.start` until `turn.complete`: the cache is in use, so there is no countdown.
  isWorking?: boolean
  // True once the "cools soon" toast was shown for this `at`.
  isWarned?: boolean
}

// The setting as minutes of lifetime, in milliseconds.
export const ttlMs = (raw: unknown) => {
  const minutes = typeof raw === 'number' && Number.isFinite(raw) && raw > 0 && raw <= MAX_TTL_MINUTES ? raw : DEFAULT_TTL_MINUTES
  return minutes * MINUTE_MS
}

export type Readout =
  | { kind: 'none' }
  | { kind: 'warm' | 'cooling' | 'cold'; leftMs: number; tokens: number | undefined }

// Where the countdown stands. A clock that reads before `at` (it was set back)
// counts as no time passed. A `now` that is not a number (the clock could not be
// read) gives no row, so a bad reading never shows a wrong countdown.
export const readout = (state: CacheClock | undefined, now: number, lifetimeMs: number): Readout => {
  if (state?.at === undefined || !Number.isFinite(state.at) || !Number.isFinite(now)) return { kind: 'none' }
  const leftMs = lifetimeMs - Math.max(0, now - state.at)
  const kind = leftMs <= 0 ? 'cold' : leftMs <= WARN_MS ? 'cooling' : 'warm'
  return { kind, leftMs: Math.max(0, leftMs), tokens: state.tokens }
}

// 43 minutes -> "43m"; 90 minutes -> "90m". Whole minutes, rounded down.
export const clockText = (ms: number) => `${Math.floor(ms / MINUTE_MS)}m`

// Whole minutes, rounded UP and at least 1, for the last five minutes.
export const coolsInText = (ms: number) => `${Math.max(1, Math.ceil(ms / MINUTE_MS))}m`

// The tokens part of the row: " · 160k tokens", or nothing when the size is unknown.
export const tokensText = (tokens: number | undefined) => (tokens === undefined || tokens <= 0 ? '' : ` · ${fmt(tokens)} tokens`)

// What the cold row says would be re-read. No price: the rates differ by model and plan.
export const coldText = (tokens: number | undefined) =>
  `cache cold: next prompt re-reads ${tokens === undefined || tokens <= 0 ? 'the whole conversation' : `${fmt(tokens)} tokens`} uncached`

// The toast, shown once per response when the cache enters its last five minutes.
export const warnText = (leftMs: number) => `Prompt cache cools in ${coolsInText(leftMs)}. Send a prompt or compact first.`
