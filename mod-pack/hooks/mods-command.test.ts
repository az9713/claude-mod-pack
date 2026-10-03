import { test, expect } from 'claude-code/testing'

import { runMods } from './mods-command'

const features = [
  { id: 'token-weather', title: 'Token Weather', about: 'forecast', hasSound: true, defaultOn: true },
  { id: 'wait-what', title: 'Wait What', about: 'explains a pause', usesModel: true, defaultOn: false },
]
const none = { features: {} }
const run = (args: string, overrides: { features: Record<string, boolean>; sound?: boolean } = none, options = {}) =>
  runMods(args, features, overrides, options)

test('/mods lists every feature with state, description and flags', () => {
  const { text, isChanged } = run('')
  expect(isChanged).toBe(false)
  expect(text).toContain('sound: OFF')
  expect(text).toMatch(/ON\s+token-weather\s+Token Weather: forecast \[plays sound\]/)
  expect(text).toMatch(/OFF\s+wait-what\s+Wait What: explains a pause \[uses model tokens\]/)
  expect(run('list').text).toBe(text)
})

test('/mods list follows overrides and settings', () => {
  const text = run('', { features: { 'wait-what': true }, sound: true }, { tokenWeather: false }).text
  expect(text).toContain('sound: ON')
  expect(text).toMatch(/OFF\s+token-weather/)
  expect(text).toMatch(/ON\s+wait-what/)
})

test('/mods on and off set an override', () => {
  const off = run('off token-weather')
  expect(off.isChanged).toBe(true)
  expect(off.overrides).toEqual({ features: { 'token-weather': false } })
  expect(off.text).toBe('mod-pack: token-weather is OFF.')
  const on = run('on wait-what', off.overrides)
  expect(on.overrides).toEqual({ features: { 'token-weather': false, 'wait-what': true } })
})

test('/mods toggle flips the effective state, from override or from setting', () => {
  expect(run('toggle token-weather').overrides.features['token-weather']).toBe(false)
  expect(run('toggle wait-what').overrides.features['wait-what']).toBe(true)
  expect(run('toggle token-weather', none, { tokenWeather: false }).overrides.features['token-weather']).toBe(true)
  const twice = run('toggle token-weather', run('toggle token-weather').overrides)
  expect(twice.overrides.features['token-weather']).toBe(true)
})

test('verbs and ids are case-insensitive and tolerate extra spaces', () => {
  expect(run('  OFF   Token-Weather ').overrides).toEqual({ features: { 'token-weather': false } })
})

test('/mods sound on and off', () => {
  const on = run('sound on')
  expect(on.overrides).toEqual({ features: {}, sound: true })
  expect(on.text).toContain('sound is ON')
  expect(on.text).toContain('macOS')
  const off = run('sound off', on.overrides)
  expect(off.overrides.sound).toBe(false)
  expect(off.text).toBe('mod-pack: sound is OFF.')
})

test('/mods sound with a missing or wrong word shows the usage and changes nothing', () => {
  for (const args of ['sound', 'sound maybe', 'sound on now']) {
    const result = run(args)
    expect(result.isChanged).toBe(false)
    expect(result.text).toContain('Usage:')
  }
})

test('/mods reset clears every override', () => {
  const result = run('reset', { features: { 'token-weather': false }, sound: true })
  expect(result.isChanged).toBe(true)
  expect(result.overrides).toEqual({ features: {} })
})

test('an unknown id gives a helpful error and changes nothing', () => {
  const result = run('on snake')
  expect(result.isChanged).toBe(false)
  expect(result.overrides).toBe(none)
  expect(result.text).toBe('mod-pack: no feature named "snake". Known: token-weather, wait-what.')
})

test('on, off and toggle without an id show the usage', () => {
  for (const args of ['on', 'off', 'toggle', 'on token-weather extra']) {
    const result = run(args)
    expect(result.isChanged).toBe(false)
    expect(result.text).toContain('Usage:')
  }
})

test('an unknown verb names it and shows the usage', () => {
  const result = run('frobnicate')
  expect(result.isChanged).toBe(false)
  expect(result.text).toContain('"frobnicate" is not a command')
  expect(result.text).toContain('Usage:')
  expect(run('help').text).toContain('Usage:')
})
