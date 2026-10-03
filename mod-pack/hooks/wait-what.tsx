// Wait What: after a long answer, a retell in plain words (at most 2 short lines) in the
// band above the prompt. It is not in the transcript and not in the model's context.
//
// It SPENDS model tokens: each retold answer is one call to the cheapest model (the
// `haiku` alias), with the answer's text (at most 4,000 characters) as its input and at
// most 120 tokens back. It is OFF by default, and capped at `maxModelCallsPerHour`.
//
// Pure: it holds no `$`. The dispatcher (register.tsx) tells it about each finished
// turn and whether the lock is free, makes the model call it asks for, and hands the
// reply back. The state is kept in `$.state`, so a hot reload keeps the hourly count.
//
// Decisions:
//   - Retold: the answer of the MAIN conversation, reason `answer`, at least 200
//     characters, while the session draws on a terminal. A subagent's turn, an
//     interrupted turn, a refused turn, an error, and a short answer are not.
//   - The call is made after `turn.complete` has answered: the turn never waits for it.
//   - A new `turn.start`, a newer finished turn, or `/clear` makes the call in flight stale:
//     its reply is dropped. The retell shows nothing while the call runs.
//   - A call counts toward the hourly cap when it STARTS, and a failed call counts too.
//   - No call while a compaction runs (the lock); no toast; no sound.

import { defineFeature } from './feature'
import { addCall, buildAsk, callLimit, canCall, fitLines, LABEL, LIMIT_TEXT, MIN_ANSWER_CHARS, parseReply, recentCalls } from './retell'
import type { BandInput } from './feature'

// What the dispatcher keeps in $.state for this mod.
export type Retell = {
  // The start times of the model calls of the last hour (the rolling cap).
  calls?: number[]
  // The turn whose call is in flight. A reply for any other turn is dropped.
  pending?: string
  // The retell to show: 1 or 2 cleaned lines.
  lines?: string[]
  // True when the last answer was long enough but the hourly cap refused the call.
  isLimited?: boolean
}

// What the band draws now: the retell lines, the one limit line, or nothing.
const view = (state: Retell | undefined, { props }: BandInput): string[] => {
  if (props.isWorking) return []
  if (state?.lines?.length) return fitLines(state.lines, props.bodyColumns - LABEL.length - 1)
  return state?.isLimited ? [LIMIT_TEXT] : []
}

export const waitWhat = defineFeature<Retell>({
  id: 'wait-what',
  title: 'Wait What',
  about: 'plain-words retell of each long answer in the band; SPENDS model tokens: one short reply from the cheapest model per answer, at most maxModelCallsPerHour an hour (default 30); OFF by default',
  usesModel: true,
  defaultOn: false,

  // The retell and the call in flight belong to the old turn. The hourly count stays.
  turnStart: state => ({ state: { calls: state?.calls } }),

  turnComplete(state, { e, hasTerminal }, ctx) {
    // A subagent's turn is not the answer the person reads.
    if (e.agentId !== undefined) return undefined

    // A main turn has ended, so what was shown or in flight is stale, whatever follows. The hourly
    // count is stored as `recentCalls` made it: old calls dropped, a call from a clock set back as now.
    const calls = Number.isFinite(ctx.now) ? recentCalls(state?.calls, ctx.now) : state?.calls
    const stale: Retell = { calls }
    const answer = e.answer.trim()
    if (e.reason !== 'answer' || e.isAborted || !hasTerminal || answer.length < MIN_ANSWER_CHARS) return { state: stale }

    // A clock that cannot be read cannot count the hour: no call (the safe side for spend).
    // The lock is held (a compaction runs): no call, and the budget is not touched.
    if (!Number.isFinite(ctx.now) || ctx.isBusy) return { state: stale }

    if (!canCall(calls, ctx.now, callLimit(ctx.options.maxModelCallsPerHour))) return { state: { calls, isLimited: true } }
    return { state: { calls: addCall(calls, ctx.now), pending: e.turnId }, ask: buildAsk(e.turnId, answer) }
  },

  // The call ended. A reply for a turn that is no longer the pending one came late: drop it.
  modelDone(state, { turnId, reply }) {
    if (state?.pending !== turnId) return undefined
    const lines = reply.isAnswered ? parseReply(reply.text) : []
    return { state: lines.length > 0 ? { calls: state.calls, lines } : { calls: state.calls } }
  },

  // /clear or an exit: the retell goes, the hourly count stays (the cap is on spend).
  sessionEnd: state => ({ state: { calls: state?.calls } }),

  band(state, e, el) {
    const lines = view(state, e)
    if (lines.length === 0) return null
    const { Box, Text } = el
    const isRetell = (state?.lines?.length ?? 0) > 0

    // One clipped Box for each line, so a long first line cannot push the second out of view.
    return (
      <Box flexDirection="column">
        {lines.map((line, i) =>
          isRetell ? (
            <Box key={`line-${i}`} height={1} overflow="hidden">
              <Text dimColor>{i === 0 ? LABEL : ' '.repeat(LABEL.length)}</Text>
              <Text>{line}</Text>
            </Box>
          ) : (
            <Box key={`line-${i}`} height={1} overflow="hidden">
              <Text dimColor>{line}</Text>
            </Box>
          ),
        )}
      </Box>
    )
  },

  bandLines: (state, e) => view(state, e).length,
})
