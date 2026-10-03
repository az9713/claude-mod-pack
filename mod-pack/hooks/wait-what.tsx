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
//   - A long answer of the main conversation that makes no call and no retell leaves a NOTE: one dim
//     band line `wait what: <note>` that says why (retell.ts lists them). The note goes at the next
//     `turn.start`. The normal skips (a short answer, a subagent's turn, an interrupted, failed or
//     refused turn) leave no note and draw nothing; `/mods` still says what the last turn was (`last`).

import { defineFeature } from './feature'
import {
  addCall, buildAsk, callLimit, canCall, failureNote, fitLines, fitNote, LABEL, LIMIT_TEXT, lockNote, MIN_ANSWER_CHARS, noTerminalNote, NOTE_CLOCK, NOTE_NO_TEXT,
  NOTE_SURFACES_UNREADABLE, parseReply, recentCalls, tooShortText, turnEndedText,
} from './retell'
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
  // Why a long answer got no retell (see the notes in retell.ts). Drawn as one dim band line.
  note?: string
  // Why the last answer was skipped as normal (short, interrupted, failed, refused). Never drawn in
  // the band; only `/mods` shows it.
  skipped?: string
}

// What the band draws now: the retell lines, else the note, else the one limit line, else nothing.
const view = (state: Retell | undefined, { props }: BandInput): string[] => {
  if (props.isWorking) return []
  if (state?.lines?.length) return fitLines(state.lines, props.bodyColumns - LABEL.length - 1)
  if (state?.note) return [fitNote(state.note, props.bodyColumns - 1)]
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

  turnComplete(state, { e, hasTerminal, surfaces }, ctx) {
    // A subagent's turn is not the answer the person reads.
    if (e.agentId !== undefined) return undefined

    // A main turn has ended, so what was shown or in flight is stale, whatever follows. The hourly
    // count is stored as `recentCalls` made it: old calls dropped, a call from a clock set back as now.
    const calls = Number.isFinite(ctx.now) ? recentCalls(state?.calls, ctx.now) : state?.calls
    const stale: Retell = { calls }

    // The normal skips draw nothing. `skipped` is for `/mods` only.
    if (e.reason !== 'answer' || e.isAborted) return { state: { ...stale, skipped: turnEndedText(e.reason) } }
    const answer = e.answer.trim()
    if (answer.length < MIN_ANSWER_CHARS) return { state: { ...stale, skipped: tooShortText(answer.length) } }

    // From here the answer is long and the main conversation's: no call now is a fact to show.
    const noted = (note: string): { state: Retell } => ({ state: { ...stale, note } })
    // `surfaces` is undefined when `$.session.surfaces()` rejected; a list without the terminal is another cause.
    if (!hasTerminal) return noted(surfaces === undefined ? NOTE_SURFACES_UNREADABLE : noTerminalNote(surfaces))

    // A clock that cannot be read cannot count the hour: no call (the safe side for spend).
    if (!Number.isFinite(ctx.now)) return noted(NOTE_CLOCK)
    // The lock is held (a compaction, a queued send, an earlier call): no call, and the budget is not touched.
    if (ctx.isBusy) return noted(lockNote(ctx.lock))

    if (!canCall(calls, ctx.now, callLimit(ctx.options.maxModelCallsPerHour))) return { state: { calls, isLimited: true } }
    return { state: { calls: addCall(calls, ctx.now), pending: e.turnId }, ask: buildAsk(e.turnId, answer) }
  },

  // The call ended. A reply for a turn that is no longer the pending one came late: drop it.
  // No text, for any reason, leaves a note and one log line (the band may be clipped, the log stays).
  modelDone(state, { turnId, reply }) {
    if (state?.pending !== turnId) return undefined
    const calls = state.calls
    if (!reply.isAnswered) {
      const note = failureNote(reply)
      return { state: { calls, note }, log: note }
    }
    const lines = parseReply(reply.text)
    if (lines.length === 0) return { state: { calls, note: NOTE_NO_TEXT }, log: NOTE_NO_TEXT }
    return { state: { calls, lines } }
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

  // For `/mods`: the last outcome, also when the band had no room to draw it.
  last(state) {
    if (state?.note) return state.note
    if (state?.lines?.length) return 'retell shown'
    if (state?.isLimited) return 'hourly limit reached'
    return state?.skipped ? `no retell needed: ${state.skipped}` : undefined
  },
})
