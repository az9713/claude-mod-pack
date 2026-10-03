// Prompt Queue, the pure part: the `/q` parser, the queue's rules, and the band row's text.
// No engine calls here. The dispatcher (register.tsx) reads the lock, calls these, keeps the
// state they return, and does the sending (`$.prompt.submit`).
//
// A queued prompt is plain text. It is sent as the person's own words when a turn ends.

import type { Lock } from './feature'

// The most prompts in the queue, and the most characters in one. A longer prompt is refused,
// not cut: a cut prompt would say something else than the person wrote.
export const MAX_ITEMS = 20
export const MAX_CHARS = 2000

// Why the queue does not send. `user`: `/q pause`. `aborted`, `error`, `refusal`: the last turn did
// not end with an answer. `send-failed`: Claude Code refused the last prompt we sent.
export type PauseWhy = 'user' | 'aborted' | 'error' | 'refusal' | 'send-failed'

// What the dispatcher keeps in $.state for this mod.
export type Queue = {
  // The prompts waiting, first to send first.
  items?: string[]
  // Set: the queue sends nothing until `/q resume` (or `/q clear`).
  pause?: PauseWhy
  // True from `turn.start` to `turn.complete` of the main conversation. A prompt typed with `/q`
  // while no turn runs is sent at once; while one runs, it waits for the end of the turn.
  isWorking?: boolean
  // The `turn.complete` that last sent a prompt. The same turn never sends twice.
  sentFor?: string
}

export type Command =
  | { kind: 'add'; text: string }
  | { kind: 'list' }
  | { kind: 'rm'; n: number }
  | { kind: 'clear' }
  | { kind: 'pause' }
  | { kind: 'resume' }

// Only the exact forms are commands: the whole argument is `list`, `clear`, `pause` or `resume`,
// or it is `rm <number>`, or it starts with `add `. Anything else is a prompt to queue. So
// `/q rm the old files` queues that sentence, and `/q add pause` queues the word pause.
export const parseQ = (args: string): Command => {
  const text = args.trim()
  const word = text.toLowerCase()
  if (word === '' || word === 'list') return { kind: 'list' }
  if (word === 'clear' || word === 'pause' || word === 'resume') return { kind: word }
  const rm = /^rm\s+(\d+)$/i.exec(text)
  if (rm) return { kind: 'rm', n: Number(rm[1]) }
  if (word === 'add') return { kind: 'add', text: '' }
  const add = /^add\s+([\s\S]+)$/i.exec(text)
  if (add) return { kind: 'add', text: (add[1] as string).trim() }
  return { kind: 'add', text }
}

// A prompt as one short line for a list or the row: control characters (an escape sequence in a
// pasted text) become spaces, spaces are folded, a long one is cut with `…`.
export const oneLine = (text: string, max: number): string => {
  const flat = text.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim()
  const chars = [...flat]
  return chars.length > max ? `${chars.slice(0, Math.max(0, max - 1)).join('')}…` : flat
}

const clip = (text: string, width: number) => {
  const chars = [...text]
  return chars.length > width ? `${chars.slice(0, Math.max(0, width - 1)).join('')}…` : text
}

export const pauseText = (why: PauseWhy): string =>
  ({
    user: 'paused with /q pause',
    aborted: 'you interrupted the turn',
    error: 'the last turn ended with an error',
    refusal: 'the model refused the last turn',
    'send-failed': 'Claude Code did not accept the last prompt',
  })[why]

// The queue may send while nothing holds the lock, and while only a model call of a mod holds it:
// the next prompt cancels that call, so it never needs to hold the queue back. A compaction does,
// and so does another submission still on its way.
export const canSend = (lock: Lock | undefined) => lock === undefined || lock === 'model-call'

// ---- what `turn.complete` does ----

export const onTurnStart = (q: Queue | undefined): Queue => ({ ...q, isWorking: true })

export type Completed = { reason: 'answer' | 'aborted' | 'refusal' | 'error'; turnId: string }

// A turn of the main conversation ended. Returns the new state and, when the queue sends now, the
// prompt (already out of the state). The rules, in this order:
//   1. empty or paused: nothing.
//   2. the turn did not end with an answer (interrupted, error, refusal): PAUSE, send nothing.
//   3. this turn already sent a prompt: nothing (the same event twice).
//   4. the lock does not allow it (a compaction, another submission): nothing; the prompt waits.
//   5. otherwise the first prompt is sent, and this turn is marked as having sent it.
export const onTurnComplete = (q: Queue | undefined, e: Completed, lock: Lock | undefined): { state: Queue; send?: string } => {
  const state: Queue = { ...q, isWorking: false }
  const [first, ...rest] = state.items ?? []
  if (first === undefined || state.pause) return { state }
  if (e.reason !== 'answer') return { state: { ...state, pause: e.reason } }
  if (state.sentFor === e.turnId || !canSend(lock)) return { state }
  return { state: { ...state, items: rest, sentFor: e.turnId }, send: first }
}

// Claude Code refused or dropped the prompt just sent: it goes back to the top, the queue pauses.
export const onSendFailed = (q: Queue | undefined, text: string): Queue => ({ ...q, items: [text, ...(q?.items ?? [])], pause: 'send-failed' })

// ---- the `/q` command ----

export type QResult = { text: string; state: Queue | undefined; send?: string }

const quote = (text: string) => `"${oneLine(text, 60)}"`

// What the person is told about the next send, after a change that may start one.
const tail = (q: Queue, lock: Lock | undefined): { text: string; state: Queue; send?: string } => {
  const [first, ...rest] = q.items ?? []
  if (first === undefined) return { text: ' The queue is empty.', state: q }
  if (q.pause) return { text: ` The queue is paused (${pauseText(q.pause)}): type /q resume to send.`, state: q }
  if (q.isWorking) return { text: ' It sends when the running turn ends.', state: q }
  if (lock === 'compaction') return { text: ' A compaction is running, so nothing is sent yet. Type /q resume when it ends.', state: q }
  if (lock === 'prompt-submit') return { text: ' A queued prompt is on its way. This one sends when that turn ends.', state: q }
  return { text: ` Claude is not working, so it sends now: ${quote(first)}`, state: { ...q, items: rest }, send: first }
}

export const runQ = (args: string, q: Queue | undefined, lock: Lock | undefined): QResult => {
  const items = q?.items ?? []
  const cmd = parseQ(args)

  if (cmd.kind === 'list') {
    if (items.length === 0) return { text: 'The prompt queue is empty. Type /q <text> to add a prompt.', state: q }
    const status = q?.pause ? `paused: ${pauseText(q.pause)}` : 'sends one at a time when a turn ends'
    const lines = items.map((item, i) => `  ${i + 1}. ${oneLine(item, 100)}`)
    return { text: [`Prompt queue (${items.length} of ${MAX_ITEMS}, ${status}):`, ...lines].join('\n'), state: q }
  }

  if (cmd.kind === 'add') {
    if (cmd.text === '') return { text: 'Nothing to queue. Type /q <text>.', state: q }
    if ([...cmd.text].length > MAX_CHARS) return { text: `That prompt is ${[...cmd.text].length} characters. The limit is ${MAX_CHARS}. Nothing was queued.`, state: q }
    if (items.length >= MAX_ITEMS) return { text: `The queue is full (${MAX_ITEMS} prompts). Remove one with /q rm <n> first.`, state: q }
    const next: Queue = { ...q, items: [...items, cmd.text] }
    const after = tail(next, lock)
    return { text: `Queued ${items.length + 1} of ${MAX_ITEMS}: ${quote(cmd.text)}.${after.text}`, state: after.state, ...(after.send !== undefined ? { send: after.send } : {}) }
  }

  if (cmd.kind === 'rm') {
    if (items.length === 0) return { text: 'The queue is empty. Nothing to remove.', state: q }
    if (cmd.n < 1 || cmd.n > items.length) return { text: `There is no prompt ${cmd.n}. The queue has ${items.length}.`, state: q }
    const removed = items[cmd.n - 1] as string
    return { text: `Removed ${cmd.n}: ${quote(removed)}.`, state: { ...q, items: items.filter((_, i) => i !== cmd.n - 1) } }
  }

  if (cmd.kind === 'clear') {
    if (items.length === 0 && !q?.pause) return { text: 'The queue is already empty.', state: q }
    const { pause: _pause, ...kept } = q ?? {}
    return { text: `Cleared ${items.length} queued prompt${items.length === 1 ? '' : 's'}.`, state: { ...kept, items: [] } }
  }

  if (cmd.kind === 'pause') {
    return { text: q?.pause ? `The queue was already paused (${pauseText(q.pause)}).` : 'The queue is paused. Type /q resume to send again.', state: q?.pause ? q : { ...q, pause: 'user' } }
  }

  // resume: also the way to start a stalled queue (a prompt waited for a compaction to end).
  const { pause: was, ...rest } = q ?? {}
  const after = tail(rest, lock)
  return { text: `${was ? 'Resumed.' : 'The queue was not paused.'}${after.text}`, state: after.state, ...(after.send !== undefined ? { send: after.send } : {}) }
}

// ---- the band row ----

export const ITEM_CHARS = 24

// The row's text, or undefined when the queue is empty. At most `columns` characters.
//   queue (3): 1 fix tests · 2 update docs · …
//   queue paused (3): you interrupted the turn · /q resume sends · /q clear drops
export const queueRow = (q: Queue | undefined, columns: number): { text: string; isPaused: boolean } | undefined => {
  const items = q?.items ?? []
  if (items.length === 0) return undefined
  const width = Number.isFinite(columns) && columns > 0 ? Math.floor(columns) : 80

  if (q?.pause) return { text: clip(`queue paused (${items.length}): ${pauseText(q.pause)} · /q resume sends · /q clear drops`, width), isPaused: true }

  const parts = items.map((item, i) => `${i + 1} ${oneLine(item, ITEM_CHARS)}`)
  let text = `queue (${items.length}): ${parts[0]}`
  let shown = 1
  // Another item goes in only when it fits together with the `· …` that says more follow.
  while (shown < parts.length && `${text} · ${parts[shown]}${shown + 1 < parts.length ? ' · …' : ''}`.length <= width) {
    text += ` · ${parts[shown]}`
    shown++
  }
  if (shown < parts.length) text += ' · …'
  return { text: clip(text, width), isPaused: false }
}
