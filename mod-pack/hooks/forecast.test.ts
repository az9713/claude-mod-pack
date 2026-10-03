import { test, expect } from 'claude-code/testing'

import { chart, delta, fmt, percentOf, shouldThunder, weather } from './forecast'

test('weather bands', () => {
  const words = [0, 24, 25, 49, 50, 74, 75, 89, 90, 100].map(p => weather(p)?.[2])
  expect(words).toEqual(['Clear', 'Clear', 'Cloudy', 'Cloudy', 'Showers', 'Showers', 'Storm', 'Storm', 'Compact soon', 'Compact soon'])
})

test('fmt', () => {
  expect(fmt(134400)).toBe('134.4k')
  expect(fmt(200000)).toBe('200k')
  expect(fmt(950)).toBe('950')
})

test('chart and delta', () => {
  const h = [{ tokens: 36100, window: 200000 }, { tokens: 134400, window: 200000 }, { tokens: 200000, window: 200000 }]
  expect(chart(h)).toBe('▂▆█')
  expect(delta(h.slice(0, 2))).toBe('▲ +98.3k last turn')
  expect(delta([h[2]!, h[0]!])).toBe('▼ -163.9k last turn')
})

test('percentOf', () => {
  expect(percentOf({ tokens: 134400, window: 200000 })).toBe(67)
  expect(percentOf({ tokens: 1, window: 1000000 })).toBe(0)
  expect(percentOf({ tokens: 5, window: 0 })).toBe(0)
})

test('thunder: plays only when the band moves up into Storm or Compact soon', () => {
  const on = true
  // enters Storm from Showers: plays
  expect(shouldThunder(74, 75, on)).toBe(true)
  // enters Storm from Clear (a big jump): plays
  expect(shouldThunder(10, 80, on)).toBe(true)
  // enters Compact soon from Storm: plays
  expect(shouldThunder(89, 90, on)).toBe(true)
  // enters Compact soon from Showers (skips Storm): plays
  expect(shouldThunder(60, 95, on)).toBe(true)
  // stays in Storm: no replay
  expect(shouldThunder(75, 89, on)).toBe(false)
  expect(shouldThunder(80, 80, on)).toBe(false)
  // stays in Compact soon: no replay
  expect(shouldThunder(90, 99, on)).toBe(false)
  // moves down: no sound
  expect(shouldThunder(95, 80, on)).toBe(false)
  expect(shouldThunder(80, 30, on)).toBe(false)
  // moves up but stays below Storm: no sound
  expect(shouldThunder(10, 60, on)).toBe(false)
  // no earlier sample (new session, or a reload with no history): no sound
  expect(shouldThunder(undefined, 95, on)).toBe(false)
  // sound not allowed: no sound, whatever the band
  expect(shouldThunder(74, 75, false)).toBe(false)
  expect(shouldThunder(89, 90, false)).toBe(false)
})
