// Prompt Queue: type `/q <text>` while Claude works to stack follow-up prompts. They are sent one at
// a time, each when the turn before it ends. One row above the prompt shows what waits.
//
// It costs no model tokens of its own. Each prompt it sends is a normal turn of your session, on your
// plan, with your permissions: read what you queue as if you had typed it at that moment.
//
// Pure: it holds no `$`. The dispatcher (register.tsx) tells it about each turn and the lock, sends
// the prompt it asks for (`$.prompt.submit`), keeps the state, and serves `/q` (hooks/queue.ts).
//
// Decisions:
//   - Only the main conversation's turn sends. A subagent's turn never does.
//   - Only a turn that ended with an answer sends. An interrupted turn, an error or a refusal PAUSES
//     the queue (the row says why) until `/q resume`.
//   - The lock (see register.tsx): a compaction in progress holds the queue back, and so does a prompt
//     it sent that has not started its turn yet. A Wait What model call does not: the next prompt cancels it.
//   - `/q` with no turn running sends the first prompt at once: nothing else would ever send it.
//   - `/clear` and the end of the session empty the queue. `/mods off prompt-queue` empties it too.
//   - The row draws while a turn runs (that is when the queue matters). No Button, no hotkey.

import { defineFeature } from './feature'
import { onSendFailed, onTurnComplete, onTurnStart, pauseText, queueRow } from './queue'
import type { Queue } from './queue'

export const promptQueue = defineFeature<Queue>({
  id: 'prompt-queue',
  title: 'Prompt Queue',
  about: 'type /q <text> while Claude works to queue follow-up prompts; they send one at a time when a turn ends; costs no model tokens itself; queued prompts run with your permissions',
  usesModel: false,
  defaultOn: true,
  isSerial: true,

  turnStart: state => ({ state: onTurnStart(state) }),

  turnComplete(state, { e }, ctx) {
    // A subagent's turn is not the person's turn.
    if (e.agentId !== undefined) return undefined

    const done = onTurnComplete(state, { reason: e.reason, turnId: e.turnId }, ctx.lock)
    const isNewPause = done.state.pause !== undefined && state?.pause === undefined
    return {
      state: done.state,
      ...(done.send !== undefined ? { submit: done.send } : {}),
      ...(isNewPause ? { toast: `Prompt Queue paused: ${pauseText(done.state.pause!)}. Type /q resume to send.` } : {}),
    }
  },

  // The prompt just sent was refused: it goes back to the top, and the queue pauses.
  submitFailed: (state, { text, why }) => ({
    state: onSendFailed(state, text),
    toast: `Prompt Queue: could not send a queued prompt (${why}). It is back at the top and the queue is paused. Type /q resume to try again.`,
  }),

  // /clear or an exit.
  sessionEnd: () => ({ state: {} }),

  band(state, { props }, el) {
    const row = queueRow(state, props.bodyColumns)
    if (!row) return null
    const { Text } = el
    return row.isPaused ? <Text color="yellow">{row.text}</Text> : <Text>{row.text}</Text>
  },
})
