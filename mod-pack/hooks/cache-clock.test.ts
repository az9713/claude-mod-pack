import { test, expect } from 'claude-code/testing'

import { clockText, coldText, coolsInText, DEFAULT_TTL_MINUTES, MAX_TTL_MINUTES, readout, tokensText, ttlMs, WARN_MS, warnText } from './cache-clock'

const MIN = 60_000
const HOUR = 60 * MIN

test('ttlMs: a valid number of minutes is used; every invalid value gives the default of 60 minutes', () => {
  expect(DEFAULT_TTL_MINUTES).toBe(60)
  expect(ttlMs(5)).toBe(5 * MIN)
  expect(ttlMs(60)).toBe(HOUR)
  expect(ttlMs(2.5)).toBe(2.5 * MIN)
  expect(ttlMs(MAX_TTL_MINUTES)).toBe(MAX_TTL_MINUTES * MIN)
  for (const bad of [0, -1, -60, NaN, Infinity, -Infinity, MAX_TTL_MINUTES + 1, '30', '', 'x', null, undefined, true, {}, []]) {
    expect([bad, ttlMs(bad)]).toEqual([bad, HOUR])
  }
})

test('readout: no state, no time, or a clock that cannot be read gives no row', () => {
  expect(readout(undefined, 1000, HOUR)).toEqual({ kind: 'none' })
  expect(readout({}, 1000, HOUR)).toEqual({ kind: 'none' })
  expect(readout({ isWorking: true }, 1000, HOUR)).toEqual({ kind: 'none' })
  expect(readout({ at: 0 }, NaN, HOUR)).toEqual({ kind: 'none' })
  expect(readout({ at: NaN }, 1000, HOUR)).toEqual({ kind: 'none' })
  expect(readout({ at: Infinity }, 1000, HOUR)).toEqual({ kind: 'none' })
})

test('readout: a response at time zero counts (zero is a time)', () => {
  expect(readout({ at: 0, tokens: 100 }, 0, HOUR)).toEqual({ kind: 'warm', leftMs: HOUR, tokens: 100 })
})

test('readout: warm above 5 minutes left, cooling from 5 minutes down to 1 ms, cold at zero', () => {
  const at = 10_000
  expect(readout({ at }, at + 54 * MIN, HOUR).kind).toBe('warm')
  expect(readout({ at }, at + 55 * MIN - 1, HOUR).kind).toBe('warm') // 5 min + 1 ms left
  expect(readout({ at }, at + 55 * MIN, HOUR)).toEqual({ kind: 'cooling', leftMs: WARN_MS, tokens: undefined })
  expect(readout({ at }, at + HOUR - 1, HOUR).kind).toBe('cooling') // 1 ms left
  expect(readout({ at }, at + HOUR, HOUR)).toEqual({ kind: 'cold', leftMs: 0, tokens: undefined })
  expect(readout({ at }, at + 3 * HOUR, HOUR)).toEqual({ kind: 'cold', leftMs: 0, tokens: undefined })
})

test('readout: a clock set back counts as no time passed', () => {
  expect(readout({ at: 5 * HOUR }, 4 * HOUR, HOUR)).toEqual({ kind: 'warm', leftMs: HOUR, tokens: undefined })
})

test('readout: a lifetime of 5 minutes or less has no warm part', () => {
  expect(readout({ at: 0 }, 0, 5 * MIN).kind).toBe('cooling')
  expect(readout({ at: 0 }, 0, 2 * MIN)).toEqual({ kind: 'cooling', leftMs: 2 * MIN, tokens: undefined })
  expect(readout({ at: 0 }, 2 * MIN, 2 * MIN).kind).toBe('cold')
})

test('clockText: whole minutes, rounded down', () => {
  expect(clockText(43 * MIN)).toBe('43m')
  expect(clockText(43 * MIN + 59_999)).toBe('43m')
  expect(clockText(5 * MIN + 1)).toBe('5m')
  expect(clockText(60 * MIN)).toBe('60m')
  expect(clockText(90 * MIN)).toBe('90m')
})

test('coolsInText: whole minutes up, never under 1m', () => {
  expect(coolsInText(5 * MIN)).toBe('5m')
  expect(coolsInText(4 * MIN + 1)).toBe('5m')
  expect(coolsInText(4 * MIN)).toBe('4m')
  expect(coolsInText(3 * MIN + 1)).toBe('4m')
  expect(coolsInText(1)).toBe('1m')
  expect(coolsInText(0)).toBe('1m')
})

test('the tokens words: a size, or nothing when it is unknown or zero', () => {
  expect(tokensText(160_000)).toBe(' · 160k tokens')
  expect(tokensText(134_400)).toBe(' · 134.4k tokens')
  expect(tokensText(undefined)).toBe('')
  expect(tokensText(0)).toBe('')
  expect(coldText(160_000)).toBe('cache cold: next prompt re-reads 160k tokens uncached')
  expect(coldText(undefined)).toBe('cache cold: next prompt re-reads the whole conversation uncached')
})

test('no text states a price', () => {
  for (const text of [coldText(160_000), coldText(undefined), warnText(3 * MIN), tokensText(160_000)]) expect(text).not.toMatch(/[$€£]|dollar|USD|\bcents?\b/i)
})

test('warnText names the minutes left', () => {
  expect(warnText(4 * MIN)).toContain('cools in 4m')
})
