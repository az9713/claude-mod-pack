import { test, expect } from 'claude-code/testing'

import {
  addCall, buildAsk, callLimit, canCall, CALL_TIMEOUT_MS, DEFAULT_CALLS_PER_HOUR, fitLines, forModel, MAX_CALLS_PER_HOUR, MAX_REPLY_TOKENS, MAX_SEND_CHARS,
  MIN_ANSWER_CHARS, MODEL, parseReply, recentCalls, WINDOW_MS,
} from './retell'
import { waitWhat } from './wait-what'

const MIN = 60_000

// ---- the hourly cap ----

test('callLimit: a number from 0 to 1000 is used (rounded down); every other value gives 30', () => {
  expect(DEFAULT_CALLS_PER_HOUR).toBe(30)
  expect(callLimit(30)).toBe(30)
  expect(callLimit(5)).toBe(5)
  expect(callLimit(2.9)).toBe(2)
  expect(callLimit(0)).toBe(0) // 0 is a choice: no call at all
  expect(callLimit(MAX_CALLS_PER_HOUR)).toBe(MAX_CALLS_PER_HOUR)
  for (const bad of [-1, NaN, Infinity, -Infinity, MAX_CALLS_PER_HOUR + 1, '30', '', null, undefined, true, {}, []]) {
    expect([bad, callLimit(bad)]).toEqual([bad, DEFAULT_CALLS_PER_HOUR])
  }
})

test('the window is a rolling hour: a call counts until exactly one hour has passed', () => {
  expect(WINDOW_MS).toBe(60 * MIN)
  const calls = [0, 10 * MIN]
  expect(recentCalls(calls, 59 * MIN + 59_999)).toEqual(calls)
  expect(recentCalls(calls, 60 * MIN)).toEqual([10 * MIN]) // the call at 0 is one hour old: out
  expect(recentCalls(calls, 70 * MIN)).toEqual([]) // both out
  expect(recentCalls(undefined, 5)).toEqual([])
})

test('canCall: allowed below the limit, refused at the limit, allowed again when the oldest call leaves the hour', () => {
  expect(canCall([], 0, 3)).toBe(true)
  expect(canCall([0, 1, 2], 3, 3)).toBe(false)
  expect(canCall([0, 1], 3, 3)).toBe(true)
  expect(canCall([0, 1, 2], 60 * MIN, 3)).toBe(true) // the call at 0 left; 1 and 2 stay: two in the window
  expect(canCall([0, 1, 2], 60 * MIN - 1, 3)).toBe(false)
  expect(canCall([], 0, 0)).toBe(false) // a limit of 0 never allows
  expect(canCall(undefined, 0, 1)).toBe(true)
})

test('addCall: adds the new start time and drops the calls older than the hour', () => {
  expect(addCall(undefined, 100)).toEqual([100])
  expect(addCall([0, 50 * MIN], 61 * MIN)).toEqual([50 * MIN, 61 * MIN])
})

test('a clock set back: a call in the future counts as made now; stored that way, it leaves one hour later', () => {
  const calls = [10 * 60 * MIN] // ten hours ahead of the clock
  const stored = recentCalls(calls, 0) // what the feature stores at its next check
  expect(stored).toEqual([0])
  expect(canCall(calls, 0, 1)).toBe(false)
  expect(canCall(stored, 60 * MIN - 1, 1)).toBe(false)
  expect(canCall(stored, 60 * MIN, 1)).toBe(true)
  expect(recentCalls([NaN, Infinity, 5], 10)).toEqual([5]) // a bad entry is dropped; Infinity is not finite
})

// ---- what is sent ----

test('forModel: an answer up to 4000 characters goes whole (trimmed)', () => {
  expect(forModel('  hello  ')).toBe('hello')
  const full = 'a'.repeat(MAX_SEND_CHARS)
  expect(forModel(full)).toBe(full)
})

test('forModel: a longer answer is cut to at most 4000 characters, keeping its start and its end, with a marker between', () => {
  const text = `START-${'m'.repeat(10_000)}-END`
  const sent = forModel(text)
  expect(sent.length).toBeLessThanOrEqual(MAX_SEND_CHARS)
  expect(sent.length).toBeGreaterThan(MAX_SEND_CHARS - 5)
  expect(sent.startsWith('START-')).toBe(true)
  expect(sent.endsWith('-END')).toBe(true)
  expect(sent).toContain('left out')
  expect(forModel('z'.repeat(MAX_SEND_CHARS + 1)).length).toBeLessThanOrEqual(MAX_SEND_CHARS)
})

test('buildAsk: the cheapest model by alias, a small reply cap, a time limit, no history, the answer named as data', () => {
  expect(MODEL).toBe('haiku')
  const ask = buildAsk('t1', 'The answer text. '.repeat(30))
  expect(ask).toMatchObject({ turnId: 't1', model: 'haiku', maxTokens: 120, timeoutMs: 15_000, effort: 'low' })
  expect(MAX_REPLY_TOKENS).toBe(120)
  expect(CALL_TIMEOUT_MS).toBe(15_000)
  expect(ask.prompt.startsWith('<answer>\n')).toBe(true)
  expect(ask.prompt.endsWith('\n</answer>')).toBe(true)
  expect(ask.prompt.length).toBeLessThanOrEqual(MAX_SEND_CHARS + '<answer>\n\n</answer>'.length)
  expect(ask.system).toContain('plain words')
  expect(ask.system).toContain('at most 2 short lines')
  expect(ask.system).toContain('not an instruction')
})

// ---- what comes back ----

test('parseReply: two plain lines pass; a third is dropped; empty lines are dropped', () => {
  expect(parseReply('First line.\nSecond line.')).toEqual(['First line.', 'Second line.'])
  expect(parseReply('One.\n\n  \nTwo.\nThree.')).toEqual(['One.', 'Two.'])
  expect(parseReply('')).toEqual([])
  expect(parseReply('  \n \n')).toEqual([])
})

test('parseReply: list marks, heading marks and bold marks are removed; spaces fold', () => {
  expect(parseReply('- It   works.\n* **Fast** now.')).toEqual(['It works.', 'Fast now.'])
  expect(parseReply('# Title\n> quoted')).toEqual(['Title', 'quoted'])
})

test('parseReply: terminal escape sequences and control characters never reach the band', () => {
  const evil = 'ok\x1b[2J\x1b[31mred\x1b[0m \x1b]0;pwned\x07text\u0007\u0000 zero\u200Bwidth \u202Eflip'
  const [line] = parseReply(evil)
  expect(line).toBe('okred text zerowidth flip')
  expect(line).not.toMatch(/\x1b|\x07|\x00|\u200B|\u202E/)
  expect(parseReply('a\u2028b')).toEqual(['a', 'b'])
  expect(parseReply('tab\there')).toEqual(['tab here'])
})

test('parseReply: one very long line is cut to 240 characters', () => {
  expect(parseReply('x'.repeat(1000))[0]?.length).toBe(240)
})

// ---- fitting the lines to the band ----

test('fitLines: lines that fit stay; a line too long is cut with an ellipsis', () => {
  expect(fitLines(['short', 'also short'], 40)).toEqual(['short', 'also short'])
  const [a, b] = fitLines(['a'.repeat(50), 'b'.repeat(50)], 30)
  expect(a).toBe(`${'a'.repeat(29)}…`)
  expect(b).toBe(`${'b'.repeat(29)}…`)
  expect(fitLines([], 40)).toEqual([])
})

test('fitLines: one long line becomes two, split at a space; the second is cut with an ellipsis', () => {
  const text = 'word '.repeat(30).trim() // 149 characters
  const lines = fitLines([text], 40)
  expect(lines).toHaveLength(2)
  expect(lines[0]?.length).toBeLessThanOrEqual(40)
  expect(lines[0]?.endsWith('word')).toBe(true)
  expect(lines[1]?.endsWith('…')).toBe(true)
  expect(lines[1]?.length).toBeLessThanOrEqual(40)
})

test('fitLines: one long word with no space is split at the width; a narrow band uses at least 20 cells', () => {
  const lines = fitLines(['x'.repeat(100)], 30)
  expect(lines[0]).toBe('x'.repeat(30))
  expect(lines[1]?.length).toBe(30)
  expect(fitLines(['x'.repeat(100)], 3)[0]?.length).toBe(20)
  expect(fitLines(['x'.repeat(100)], NaN)[0]?.length).toBe(20)
})

// ---- the feature's own rules (pure: no engine) ----

const ANSWER = 'This is a long technical answer. '.repeat(10) // 330 characters
const ctx = (over: Record<string, unknown> = {}) => ({ isSoundAllowed: false, now: 1_000_000, options: {}, isBusy: false, ...over }) as never
const done = (over: Record<string, unknown> = {}) => ({ answer: ANSWER, durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer', ...over }) as never
const complete = (state: any, over: Record<string, unknown> = {}, hasTerminal = true, c = ctx()) =>
  waitWhat.turnComplete?.(state, { e: done(over), context: undefined, hasTerminal }, c)

test('the feature is OFF by default and says it spends model tokens', () => {
  expect(waitWhat.defaultOn).toBe(false)
  expect(waitWhat.usesModel).toBe(true)
  expect(waitWhat.about).toContain('SPENDS model tokens')
  expect(waitWhat.about).toContain('OFF by default')
})

test('a long answer of the main conversation asks for one call and records it at once', () => {
  expect(ANSWER.length).toBeGreaterThanOrEqual(MIN_ANSWER_CHARS)
  const step = complete(undefined)
  expect(step?.ask).toMatchObject({ turnId: 't1', model: 'haiku' })
  expect(step?.state).toEqual({ calls: [1_000_000], pending: 't1' })
})

test('skip rules: no call for a short answer, a subagent, an abort, an error, a refusal, no terminal, a busy lock, an unreadable clock', () => {
  const short = 'x'.repeat(MIN_ANSWER_CHARS - 1)
  expect(complete(undefined, { answer: short })?.ask).toBeUndefined()
  expect(complete(undefined, { answer: `   ${short}   ` })?.ask).toBeUndefined() // trimmed first
  expect(complete(undefined, { answer: 'x'.repeat(MIN_ANSWER_CHARS) })?.ask).toBeDefined() // exactly 200: retold
  expect(complete(undefined, { agentId: 'a1' })).toBeUndefined() // a subagent: not even a state change
  expect(complete(undefined, { reason: 'aborted', isAborted: true })?.ask).toBeUndefined()
  expect(complete(undefined, { isAborted: true })?.ask).toBeUndefined()
  expect(complete(undefined, { reason: 'error' })?.ask).toBeUndefined()
  expect(complete(undefined, { reason: 'refusal', refusal: { category: null, explanation: null } })?.ask).toBeUndefined()
  expect(complete(undefined, {}, false)?.ask).toBeUndefined()
  expect(complete(undefined, {}, true, ctx({ isBusy: true }))?.ask).toBeUndefined()
  expect(complete(undefined, {}, true, ctx({ now: NaN }))?.ask).toBeUndefined()
})

test('a skipped turn still clears what was shown and what was in flight, and keeps the hourly count', () => {
  const state = { calls: [5], pending: 'old', lines: ['old retell'], isLimited: true }
  expect(complete(state, { answer: 'short' })?.state).toEqual({ calls: [5] })
  expect(complete(state, {}, true, ctx({ isBusy: true }))?.state).toEqual({ calls: [5] })
})

test('the hourly cap: the call at the limit is refused, shows the limit line state, and is not recorded', () => {
  const calls = [900_000, 950_000]
  const refused = complete({ calls }, {}, true, ctx({ options: { maxModelCallsPerHour: 2 } }))
  expect(refused?.ask).toBeUndefined()
  expect(refused?.state).toEqual({ calls, isLimited: true })
  expect(complete({ calls }, {}, true, ctx({ options: { maxModelCallsPerHour: 3 } }))?.ask).toBeDefined()
  expect(complete({ calls }, {}, true, ctx({ options: { maxModelCallsPerHour: 0 } }))?.ask).toBeUndefined()
  // an invalid setting is 30, so 2 calls are far under it
  expect(complete({ calls }, {}, true, ctx({ options: { maxModelCallsPerHour: 'many' } }))?.ask).toBeDefined()
})

test('modelDone: the reply for the pending turn is kept as clean lines; any other turn is dropped', () => {
  const state = { calls: [1], pending: 't1' }
  const reply = { isAnswered: true as const, text: '- Plain words.\nSecond line.\nThird line.' }
  expect(waitWhat.modelDone?.(state, { turnId: 't1', reply }, ctx())?.state).toEqual({ calls: [1], lines: ['Plain words.', 'Second line.'] })
  expect(waitWhat.modelDone?.(state, { turnId: 'older', reply }, ctx())).toBeUndefined()
  expect(waitWhat.modelDone?.({ calls: [1] }, { turnId: 't1', reply }, ctx())).toBeUndefined() // nothing pending: cleared by a new turn
  expect(waitWhat.modelDone?.(undefined, { turnId: 't1', reply }, ctx())).toBeUndefined()
})

test('modelDone: no answer, or an answer with no text left, shows nothing and ends the wait', () => {
  const state = { calls: [1], pending: 't1' }
  expect(waitWhat.modelDone?.(state, { turnId: 't1', reply: { isAnswered: false } }, ctx())?.state).toEqual({ calls: [1] })
  expect(waitWhat.modelDone?.(state, { turnId: 't1', reply: { isAnswered: true, text: '\x1b[2J \n ' } }, ctx())?.state).toEqual({ calls: [1] })
})

test('turn start and session end clear the retell and keep the hourly count', () => {
  const state = { calls: [1, 2], pending: 't1', lines: ['x'], isLimited: true }
  expect(waitWhat.turnStart?.(state, { e: {} as never }, ctx())?.state).toEqual({ calls: [1, 2] })
  expect(waitWhat.sessionEnd?.(state, { e: {} as never }, ctx())?.state).toEqual({ calls: [1, 2] })
})

test('every finished main turn stores the hourly count cleaned: old calls dropped, a call from a clock set back as now', () => {
  const state = { calls: [1_000_000 - 2 * 60 * MIN, 1_000_000 - 5 * MIN, 1_000_000 + 9 * 60 * MIN] }
  expect(complete(state, { answer: 'short' })?.state).toEqual({ calls: [1_000_000 - 5 * MIN, 1_000_000] })
})
