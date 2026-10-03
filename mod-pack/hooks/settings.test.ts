import { test, expect } from 'claude-code/testing'

import { isFeatureOn, isSoundAllowed, isSoundOn, layoutRows, MAX_OWN_ROWS, optionKey, parseOverrides, rowBudget } from './settings'

const feature = { id: 'token-weather', defaultOn: true }
const none = { features: {} }

test('optionKey turns an id into the userConfig key', () => {
  expect(optionKey('token-weather')).toBe('tokenWeather')
  expect(optionKey('blast-radius')).toBe('blastRadius')
  expect(optionKey('snake')).toBe('snake')
})

test('a feature uses the setting when no override exists', () => {
  expect(isFeatureOn(feature, none, { tokenWeather: true })).toBe(true)
  expect(isFeatureOn(feature, none, { tokenWeather: false })).toBe(false)
})

test('a feature uses its own default when the setting is missing or not a boolean', () => {
  expect(isFeatureOn(feature, none, {})).toBe(true)
  expect(isFeatureOn({ id: 'x-y', defaultOn: false }, none, {})).toBe(false)
  expect(isFeatureOn(feature, none, { tokenWeather: 'yes' })).toBe(true)
})

test('an override beats the setting, in both directions', () => {
  expect(isFeatureOn(feature, { features: { 'token-weather': false } }, { tokenWeather: true })).toBe(false)
  expect(isFeatureOn(feature, { features: { 'token-weather': true } }, { tokenWeather: false })).toBe(true)
})

test('reset: with the override removed, the setting applies again', () => {
  const overridden = { features: { 'token-weather': false } }
  expect(isFeatureOn(feature, overridden, { tokenWeather: true })).toBe(false)
  expect(isFeatureOn(feature, parseOverrides(undefined), { tokenWeather: true })).toBe(true)
})

test('the global sound switch: override, else setting, else off', () => {
  expect(isSoundOn(none, {})).toBe(false)
  expect(isSoundOn(none, { sound: true })).toBe(true)
  expect(isSoundOn({ features: {}, sound: false }, { sound: true })).toBe(false)
  expect(isSoundOn({ features: {}, sound: true }, { sound: false })).toBe(true)
})

test('sound is allowed only when global sound, the feature, and the ability are all on', () => {
  expect(isSoundAllowed({ hasSound: true }, true, true)).toBe(true)
  expect(isSoundAllowed({ hasSound: true }, false, true)).toBe(false)
  expect(isSoundAllowed({ hasSound: true }, true, false)).toBe(false)
  expect(isSoundAllowed({ hasSound: false }, true, true)).toBe(false)
  expect(isSoundAllowed({}, true, true)).toBe(false)
})

test('parseOverrides keeps only well-formed data', () => {
  expect(parseOverrides(undefined)).toEqual({ features: {} })
  expect(parseOverrides('nope')).toEqual({ features: {} })
  expect(parseOverrides(null)).toEqual({ features: {} })
  expect(parseOverrides({ features: { a: true, b: 'x', c: false }, sound: true })).toEqual({ features: { a: true, c: false }, sound: true })
  expect(parseOverrides({ features: 7, sound: 'loud' })).toEqual({ features: {} })
})

test('row budget: one third of maxRows, at most MAX_OWN_ROWS, none under 3 rows', () => {
  expect(rowBudget(0)).toBe(0)
  expect(rowBudget(2)).toBe(0)
  expect(rowBudget(3)).toBe(1)
  expect(rowBudget(6)).toBe(2)
  expect(rowBudget(12)).toBe(4)
  expect(rowBudget(500)).toBe(MAX_OWN_ROWS)
})

// ---- layoutRows: who gets how many of the budget's lines ----

const ask = (...asked: number[]) => asked.map((n, i) => ({ id: `r${i + 1}`, asked: n }))
const lay = (asked: number[], budget: number) => layoutRows(ask(...asked), budget).map(r => `${r.id}:${r.lines}`)

test('layoutRows: rows take the lines they ask for (1 or 2), first row first', () => {
  expect(lay([1, 1, 1], 4)).toEqual(['r1:1', 'r2:1', 'r3:1'])
  expect(lay([1, 2], 4)).toEqual(['r1:1', 'r2:2'])
  expect(lay([5, 0, -3, NaN], 9)).toEqual(['r1:2', 'r2:1', 'r3:1', 'r4:1']) // more than 2 is cut to 2; less than 1 is 1; not a number is 1
})

test('layoutRows: a row gets no more than the lines left, then is clipped to its first lines', () => {
  expect(lay([1, 1, 2], 3)).toEqual(['r1:1', 'r2:1', 'r3:1'])
  expect(lay([1, 2], 2)).toEqual(['r1:1', 'r2:1'])
  expect(lay([2], 1)).toEqual(['r1:1'])
})

test('layoutRows: the lines of a 2-line row count against every row after it (a row that follows it can be dropped)', () => {
  // budget 3: the 2-line row takes 2, the next row 1, and the one after finds none left.
  expect(lay([2, 1, 1], 3)).toEqual(['r1:2', 'r2:1'])
  // budget 4, a row of 2 lines between: 1 + 2 + 1 = 4, the fourth row finds none left.
  expect(lay([1, 2, 1, 1], 4)).toEqual(['r1:1', 'r2:2', 'r3:1'])
  // the same rows with 1 line each would all fit: it is the 2nd line that is charged.
  expect(lay([1, 1, 1, 1], 4)).toEqual(['r1:1', 'r2:1', 'r3:1', 'r4:1'])
})

test('layoutRows: no budget, or no rows: nothing', () => {
  expect(lay([1, 2], 0)).toEqual([])
  expect(lay([], 4)).toEqual([])
})

test('layoutRows keeps what a row carries', () => {
  const rows = layoutRows([{ id: 'a', asked: 1, row: 'x' }], 2)
  expect(rows).toEqual([{ id: 'a', asked: 1, row: 'x', lines: 1 }])
})
