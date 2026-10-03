// Token Weather: the context window as a forecast, in one row above the prompt.
// Icon and word by percent band, the percent, tokens / window, a 12-turn chart,
// and the change since the last turn. Moving up into Storm or Compact soon plays
// thunder when sound is allowed.
//
// Pure: it holds no `$`. The dispatcher (register.tsx) passes in the context
// reading and the earlier history, and keeps the history this returns.

import { defineFeature } from './feature'
import { chart, delta, fmt, percentOf, shouldThunder, weather } from './forecast'
import type { Sample } from './forecast'

export const tokenWeather = defineFeature<Sample[]>({
  id: 'token-weather',
  title: 'Token Weather',
  about: 'context-window forecast above the prompt: band, percent, tokens, 12-turn chart',
  hasSound: true,
  defaultOn: true,

  turnComplete(history = [], { e, context }, ctx) {
    // A subagent's turn does not move the main window; it would only add a copy of the last sample.
    if (e.agentId !== undefined || context?.tokens === undefined) return undefined

    const sample = { tokens: context.tokens, window: context.window }
    const last = history.at(-1)

    return {
      state: [...history, sample].slice(-12),
      // `last` comes from the stored history, which survives a reload: a reload cannot replay the sound.
      sound: shouldThunder(last && percentOf(last), percentOf(sample), ctx.isSoundAllowed) ? 'assets/thunder.wav' : undefined,
    }
  },

  band(history = [], _e, el) {
    const now = history.at(-1)
    if (!now) return null

    const percent = percentOf(now)
    const [, icon, word, color] = weather(percent)!
    const { Box, Text } = el

    return (
      <Box>
        <Text color={color} bold>{icon} {word}</Text>
        <Text> {percent}% {fmt(now.tokens)} / {fmt(now.window)} </Text>
        <Text color={color}>{chart(history)}</Text>
        <Text dimColor> {delta(history)}</Text>
      </Box>
    )
  },
})
