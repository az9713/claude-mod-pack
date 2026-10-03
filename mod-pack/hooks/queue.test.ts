import { test, expect } from 'claude-code/testing'

import { promptQueue } from './prompt-queue'
import { canSend, ITEM_CHARS, MAX_CHARS, MAX_ITEMS, oneLine, onSendFailed, onTurnComplete, onTurnStart, parseQ, queueRow, runQ } from './queue'
import type { Queue } from './queue'

const q = (...items: string[]): Queue => ({ items })

// ---- the parser ----

test('parseQ: the exact forms are commands', () => {
  expect(parseQ('')).toEqual({ kind: 'list' })
  expect(parseQ('   ')).toEqual({ kind: 'list' })
  expect(parseQ('list')).toEqual({ kind: 'list' })
  expect(parseQ('clear')).toEqual({ kind: 'clear' })
  expect(parseQ('PAUSE')).toEqual({ kind: 'pause' })
  expect(parseQ(' resume ')).toEqual({ kind: 'resume' })
  expect(parseQ('rm 2')).toEqual({ kind: 'rm', n: 2 })
  expect(parseQ('RM   10')).toEqual({ kind: 'rm', n: 10 })
})

test('parseQ: anything else is a prompt, trimmed; `add` forces a prompt', () => {
  expect(parseQ('  fix the tests  ')).toEqual({ kind: 'add', text: 'fix the tests' })
  expect(parseQ('rm the old files')).toEqual({ kind: 'add', text: 'rm the old files' })
  expect(parseQ('rm 2 and 3')).toEqual({ kind: 'add', text: 'rm 2 and 3' })
  expect(parseQ('clear the cache then rerun')).toEqual({ kind: 'add', text: 'clear the cache then rerun' })
  expect(parseQ('pause')).toEqual({ kind: 'pause' })
  expect(parseQ('add pause')).toEqual({ kind: 'add', text: 'pause' })
  expect(parseQ('add   two\nlines ')).toEqual({ kind: 'add', text: 'two\nlines' })
  expect(parseQ('add')).toEqual({ kind: 'add', text: '' })
})

// ---- /q add: caps, order, trimming ----

test('add: the prompt is queued last, in order, and counted', () => {
  const a = runQ('first', { isWorking: true }, undefined)
  const b = runQ('second', a.state, undefined)
  expect(a.text).toContain('Queued 1 of 20')
  expect(b.text).toContain('Queued 2 of 20')
  expect(b.state?.items).toEqual(['first', 'second'])
})

test('add: an empty prompt is refused, and `add` alone too', () => {
  const state = q('keep')
  for (const args of ['add', 'add   ']) {
    const r = runQ(args, state, undefined)
    expect(r.text).toBe('Nothing to queue. Type /q <text>.')
    expect(r.state).toBe(state) // nothing changed
  }
})

test('add: the limit of 20 prompts: the 21st is refused with the way out', () => {
  let state: Queue | undefined = { isWorking: true }
  for (let i = 1; i <= MAX_ITEMS; i++) state = runQ(`p${i}`, state, undefined).state
  expect(state?.items).toHaveLength(MAX_ITEMS)
  const r = runQ('one too many', state, undefined)
  expect(r.text).toBe('The queue is full (20 prompts). Remove one with /q rm <n> first.')
  expect(r.state).toBe(state)
})

test('add: the limit of 2000 characters: 2000 pass, 2001 are refused, not cut', () => {
  const ok = runQ('x'.repeat(MAX_CHARS), { isWorking: true }, undefined)
  expect(ok.state?.items?.[0]).toHaveLength(MAX_CHARS)
  const state = { isWorking: true }
  const tooLong = runQ('x'.repeat(MAX_CHARS + 1), state, undefined)
  expect(tooLong.text).toBe('That prompt is 2001 characters. The limit is 2000. Nothing was queued.')
  expect(tooLong.state).toBe(state)
})

test('add while a turn runs: it waits; while paused: it waits and says how to resume', () => {
  const running = runQ('go', { isWorking: true }, undefined)
  expect(running.send).toBeUndefined()
  expect(running.text).toContain('It sends when the running turn ends.')

  const paused = runQ('go', { isWorking: true, pause: 'aborted' }, undefined)
  expect(paused.send).toBeUndefined()
  expect(paused.text).toContain('paused (you interrupted the turn)')
  expect(paused.text).toContain('/q resume')
})

test('add while no turn runs: it is sent at once, as the first of the queue', () => {
  const r = runQ('go', undefined, undefined)
  expect(r.send).toBe('go')
  expect(r.state?.items).toEqual([])
  expect(r.text).toContain('sends now')

  const older = runQ('later', q('earlier'), undefined) // an earlier prompt that waited: first in, first out
  expect(older.send).toBe('earlier')
  expect(older.state?.items).toEqual(['later'])
})

test('add while no turn runs but a compaction runs, or a prompt is on its way: it waits and says so', () => {
  const compaction = runQ('go', undefined, 'compaction')
  expect(compaction.send).toBeUndefined()
  expect(compaction.state?.items).toEqual(['go'])
  expect(compaction.text).toContain('A compaction is running')

  const sending = runQ('go', undefined, 'prompt-submit')
  expect(sending.send).toBeUndefined()
  expect(sending.text).toContain('on its way')
})

test('add while a model call of a mod runs: that does not hold the queue back', () => {
  expect(runQ('go', undefined, 'model-call').send).toBe('go')
})

// ---- list, rm, clear, pause, resume ----

test('list: numbered, with the status; empty gives the hint', () => {
  expect(runQ('', undefined, undefined).text).toBe('The prompt queue is empty. Type /q <text> to add a prompt.')
  const list = runQ('list', { items: ['fix tests', 'update docs'] }, undefined).text
  expect(list).toBe('Prompt queue (2 of 20, sends one at a time when a turn ends):\n  1. fix tests\n  2. update docs')
  expect(runQ('list', { items: ['a'], pause: 'user' }, undefined).text).toContain('paused: paused with /q pause')
})

test('rm: removes by number (counting from 1) and keeps the order; a bad number changes nothing', () => {
  const state = q('a', 'b', 'c')
  const r = runQ('rm 2', state, undefined)
  expect(r.text).toBe('Removed 2: "b".')
  expect(r.state?.items).toEqual(['a', 'c'])
  for (const bad of ['rm 0', 'rm 4', 'rm 99']) {
    const r2 = runQ(bad, state, undefined)
    expect(r2.text).toBe(`There is no prompt ${bad.slice(3)}. The queue has 3.`)
    expect(r2.state).toBe(state)
  }
  expect(runQ('rm 1', undefined, undefined).text).toBe('The queue is empty. Nothing to remove.')
})

test('clear: empties the queue and also lifts a pause; an empty queue is told so', () => {
  const r = runQ('clear', { items: ['a', 'b'], pause: 'aborted', isWorking: true }, undefined)
  expect(r.text).toBe('Cleared 2 queued prompts.')
  expect(r.state).toEqual({ items: [], isWorking: true }) // the pause is gone, the turn flag stays
  expect(runQ('clear', q('a'), undefined).text).toBe('Cleared 1 queued prompt.')
  expect(runQ('clear', undefined, undefined).text).toBe('The queue is already empty.')
})

test('pause and resume: pause sets, resume lifts and, with no turn running, sends the first prompt', () => {
  const paused = runQ('pause', { items: ['a'], isWorking: true }, undefined)
  expect(paused.state?.pause).toBe('user')
  expect(runQ('pause', paused.state, undefined).text).toContain('already paused')

  const resumedBusy = runQ('resume', { items: ['a'], pause: 'user', isWorking: true }, undefined)
  expect(resumedBusy.state?.pause).toBeUndefined()
  expect(resumedBusy.send).toBeUndefined()
  expect(resumedBusy.text).toContain('Resumed.')
  expect(resumedBusy.text).toContain('It sends when the running turn ends.')

  const resumedIdle = runQ('resume', { items: ['a', 'b'], pause: 'aborted', isWorking: false }, undefined)
  expect(resumedIdle.send).toBe('a')
  expect(resumedIdle.state?.items).toEqual(['b'])
  expect(resumedIdle.state?.pause).toBeUndefined()

  expect(runQ('resume', { items: ['a'], isWorking: true }, undefined).text).toContain('The queue was not paused.')
  expect(runQ('resume', { pause: 'user' }, undefined).text).toBe('Resumed. The queue is empty.')
})

test('resume with a compaction running: nothing is sent, the person is told', () => {
  const r = runQ('resume', { items: ['a'], pause: 'user' }, 'compaction')
  expect(r.send).toBeUndefined()
  expect(r.state?.items).toEqual(['a'])
})

// ---- the lock rule ----

test('canSend: free or a model call: yes; a compaction or a prompt on its way: no', () => {
  expect(canSend(undefined)).toBe(true)
  expect(canSend('model-call')).toBe(true)
  expect(canSend('compaction')).toBe(false)
  expect(canSend('prompt-submit')).toBe(false)
})

// ---- turn.complete ----

test('a turn that answered sends the first prompt, once, and marks the turn', () => {
  const done = onTurnComplete({ items: ['a', 'b'], isWorking: true }, { reason: 'answer', turnId: 't1' }, undefined)
  expect(done.send).toBe('a')
  expect(done.state).toEqual({ items: ['b'], isWorking: false, sentFor: 't1' })
})

test('the same turn.complete twice sends once (the double-submit guard)', () => {
  const first = onTurnComplete({ items: ['a', 'b'] }, { reason: 'answer', turnId: 't1' }, undefined)
  const again = onTurnComplete(first.state, { reason: 'answer', turnId: 't1' }, undefined)
  expect(again.send).toBeUndefined()
  expect(again.state.items).toEqual(['b'])
  const next = onTurnComplete(again.state, { reason: 'answer', turnId: 't2' }, undefined) // another turn: sends
  expect(next.send).toBe('b')
})

test('an interrupted turn pauses the queue and sends nothing; so do an error and a refusal', () => {
  for (const [reason, why] of [['aborted', 'aborted'], ['error', 'error'], ['refusal', 'refusal']] as const) {
    const done = onTurnComplete({ items: ['a'] }, { reason, turnId: 't1' }, undefined)
    expect(done.send).toBeUndefined()
    expect(done.state.pause).toBe(why)
    expect(done.state.items).toEqual(['a'])
  }
})

test('a paused queue stays paused and sends nothing, even after an answer', () => {
  const done = onTurnComplete({ items: ['a'], pause: 'aborted' }, { reason: 'answer', turnId: 't1' }, undefined)
  expect(done.send).toBeUndefined()
  expect(done.state.pause).toBe('aborted')
})

test('an empty queue: no send and no pause, whatever the turn did', () => {
  for (const reason of ['answer', 'aborted', 'error', 'refusal'] as const) {
    const done = onTurnComplete(undefined, { reason, turnId: 't1' }, undefined)
    expect(done.send).toBeUndefined()
    expect(done.state.pause).toBeUndefined()
    expect(done.state.items).toBeUndefined()
  }
})

test('a compaction in progress: nothing is sent and the prompts stay; a model call does not hold it back', () => {
  const held = onTurnComplete({ items: ['a'] }, { reason: 'answer', turnId: 't1' }, 'compaction')
  expect(held.send).toBeUndefined()
  expect(held.state.items).toEqual(['a'])
  expect(held.state.sentFor).toBeUndefined() // the turn did not send: a later event may

  expect(onTurnComplete({ items: ['a'] }, { reason: 'answer', turnId: 't1' }, 'prompt-submit').send).toBeUndefined()
  expect(onTurnComplete({ items: ['a'] }, { reason: 'answer', turnId: 't1' }, 'model-call').send).toBe('a')
})

test('onTurnStart marks the turn as running and keeps the rest', () => {
  expect(onTurnStart({ items: ['a'], pause: 'user' })).toEqual({ items: ['a'], pause: 'user', isWorking: true })
  expect(onTurnStart(undefined)).toEqual({ isWorking: true })
})

test('a refused send puts the prompt back on top and pauses the queue', () => {
  expect(onSendFailed({ items: ['b'] }, 'a')).toEqual({ items: ['a', 'b'], pause: 'send-failed' })
  expect(onSendFailed(undefined, 'a')).toEqual({ items: ['a'], pause: 'send-failed' })
})

// ---- the feature itself (pure callbacks) ----

test('the feature: a subagent turn does nothing; a main turn sends; /clear empties', () => {
  const ctx = { isSoundAllowed: false, now: 0, options: {}, isBusy: false, lock: undefined }
  const state: Queue = { items: ['a'] }
  const sub = promptQueue.turnComplete?.(state, { e: { answer: '', durationMs: 1, isAborted: false, turnId: 's1', reason: 'answer', agentId: 'sub' } as never, context: undefined, hasTerminal: true }, ctx)
  expect(sub).toBeUndefined()

  const main = promptQueue.turnComplete?.(state, { e: { answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as never, context: undefined, hasTerminal: true }, ctx)
  expect(main?.submit).toBe('a')
  expect(main?.toast).toBeUndefined()

  const aborted = promptQueue.turnComplete?.(state, { e: { answer: '', durationMs: 1, isAborted: true, turnId: 't2', reason: 'aborted' } as never, context: undefined, hasTerminal: true }, ctx)
  expect(aborted?.submit).toBeUndefined()
  expect(aborted?.toast).toContain('you interrupted the turn')

  expect(promptQueue.sessionEnd?.(state, { e: {} as never }, ctx)).toEqual({ state: {} })
  expect(promptQueue.usesModel).toBe(false)
  expect(promptQueue.defaultOn).toBe(true)
})

// ---- the row ----

test('queueRow: nothing when empty; the numbered prompts, and `· …` when more follow', () => {
  expect(queueRow(undefined, 100)).toBeUndefined()
  expect(queueRow({ items: [] }, 100)).toBeUndefined()
  expect(queueRow(q('fix tests', 'update docs'), 100)).toEqual({ text: 'queue (2): 1 fix tests · 2 update docs', isPaused: false })
  const long = q('fix tests', 'update docs', 'write the changelog for the release', 'push')
  expect(queueRow(long, 100)?.text).toBe('queue (4): 1 fix tests · 2 update docs · 3 write the changelog for… · 4 push')
  // Narrow: the third and fourth do not fit; the row says more follow.
  expect(queueRow(long, 48)?.text).toBe('queue (4): 1 fix tests · 2 update docs · …')
})

test('queueRow: never wider than the band; one long prompt is cut with `…`', () => {
  const r = queueRow(q('a'.repeat(500)), 30)
  expect(r?.text).toHaveLength(30)
  expect(r?.text.endsWith('…')).toBe(true)
  for (const width of [1, 5, 12, 20, 40, 80]) {
    expect([...(queueRow(q('one', 'two', 'three', 'four'), width)?.text ?? '')].length).toBeLessThanOrEqual(width)
  }
  expect(queueRow(q('x'), NaN)?.text).toBe('queue (1): 1 x') // an unknown width counts as 80
})

test('queueRow: paused says so and why, in the pause colour; a long text is cut to the width', () => {
  const r = queueRow({ items: ['a', 'b', 'c'], pause: 'aborted' }, 100)
  expect(r).toEqual({ text: 'queue paused (3): you interrupted the turn · /q resume sends · /q clear drops', isPaused: true })
  expect(queueRow({ items: ['a'], pause: 'aborted' }, 20)?.text).toHaveLength(20)
})

test('oneLine: control characters and escape sequences become spaces, spaces fold, long text is cut', () => {
  expect(oneLine('a\n\n  b\tc', 50)).toBe('a b c')
  expect(oneLine('x\x1b[2Jy\x07z', 50)).toBe('x [2Jy z')
  expect(oneLine('x'.repeat(40), ITEM_CHARS)).toBe(`${'x'.repeat(ITEM_CHARS - 1)}…`)
  expect(oneLine('😀'.repeat(30), 10)).toBe(`${'😀'.repeat(9)}…`) // by character, not by half a pair
})
