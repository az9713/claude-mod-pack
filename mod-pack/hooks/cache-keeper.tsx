// Cache Keeper: a countdown of how long the prompt cache stays warm after the last
// response, in one row above the prompt, with a button that compacts the conversation.
// The row says warm (time left), cools in N minutes (last 5 minutes, one toast), or
// cold (the next prompt re-reads the whole context uncached).
//
// Pure: it holds no `$`. The dispatcher (register.tsx) passes in the clock, the
// context size and the setting, keeps the state this returns, shows the toast, and
// runs the compaction that the button asks for.
//
// Decisions:
//   - The clock restarts at the `turn.complete` of the MAIN conversation. A
//     subagent's turn does not restart it: a subagent has its own cache and leaves
//     the main conversation's cache as it was (code.claude.com prompt-caching, "Subagents and the cache").
//   - An interrupted or failed turn restarts it only when it reported usage (a model
//     response was counted). Otherwise the earlier time stays: that is the safe side.
//   - While a turn runs there is no row: each request of the turn refreshes the cache.
//   - A compaction, and /clear, remove the row until the next response: the old
//     cache entry no longer matches the new, shorter history.
//   - No sound. Plugin sound plays only on macOS, and the only sound in the pack
//     (thunder) means a full context, which is a different warning.

import { defineFeature } from './feature'
import { clockText, coldText, coolsInText, readout, tokensText, ttlMs, WARN_MS, warnText } from './cache-clock'
import type { CacheClock } from './cache-clock'

export const cacheKeeper = defineFeature<CacheClock>({
  id: 'cache-keeper',
  title: 'Cache Keeper',
  about: 'countdown of how long the prompt cache stays warm, with a compact button; costs no model tokens; lifetime 60 min by default (a subscription), set cacheTtlMinutes to 5 on an API key',
  usesModel: false,
  defaultOn: true,

  turnStart: state => ({ state: { ...state, isWorking: true } }),

  turnComplete(state, { e, context }, ctx) {
    if (e.agentId !== undefined) return undefined

    // A response was counted when the turn answered or was refused, or it reported usage.
    const responded = e.reason === 'answer' || e.reason === 'refusal' || e.usage !== undefined
    if (!responded || !Number.isFinite(ctx.now)) return { state: { ...state, isWorking: false } }

    return { state: { at: ctx.now, tokens: context?.tokens, isWorking: false, isWarned: false } }
  },

  // The conversation cache is gone after /clear or an exit.
  sessionEnd: () => ({ state: {} }),

  // The history is new and shorter. The next response makes the next entry.
  compacted: () => ({ state: {} }),

  // Once a minute. One toast per response, when the cache enters its last 5 minutes.
  // A lifetime of 5 minutes or less has no warm part, so it gets no toast.
  tick(state, ctx) {
    const lifetime = ttlMs(ctx.options.cacheTtlMinutes)
    const now = readout(state, ctx.now, lifetime)
    if (!state || state.isWorking || state.isWarned || now.kind !== 'cooling' || lifetime <= WARN_MS) return undefined
    return { state: { ...state, isWarned: true }, toast: warnText(now.leftMs) }
  },

  band(state, { props, now, options, isCompacting }, el, actions) {
    const { Box, Button, Text } = el
    if (isCompacting) return <Text color="yellow">⏱ compacting…</Text>
    if (props.isWorking) return null

    const r = readout(state, now, ttlMs(options.cacheTtlMinutes))
    if (r.kind === 'none') return null

    const compact = <Button key="compact" label="compact" onPress={actions.compact} />

    if (r.kind === 'warm') {
      return (
        <Box>
          <Text>⏱ cache warm {clockText(r.leftMs)} left{tokensText(r.tokens)} </Text>
          {compact}
        </Box>
      )
    }
    if (r.kind === 'cooling') {
      return (
        <Box>
          <Text color="yellow" bold>⏱ cache cools in {coolsInText(r.leftMs)}</Text>
          <Text>{tokensText(r.tokens)} </Text>
          {compact}
        </Box>
      )
    }
    return (
      <Box>
        <Text color="red">⏱ {coldText(r.tokens)} </Text>
        {compact}
      </Box>
    )
  },
})
