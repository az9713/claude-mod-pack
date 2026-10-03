import { test, expect } from 'claude-code/testing'

import { isFeatureOn, isSoundAllowed, isSoundOn, MAX_OWN_ROWS, optionKey, parseOverrides, rowBudget } from './settings'

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
