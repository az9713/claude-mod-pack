import type { ModPackSample as Sample } from '../types'

export type { Sample }

// Lower bound in percent, icon, word, colour. First row whose bound fits wins, from the top.
const WEATHER = [
  [90, '↯', 'Compact soon', 'red'],
  [75, '☇', 'Storm', 'magenta'],
  [50, '☂', 'Showers', 'blue'],
  [25, '☁', 'Cloudy', 'cyan'],
  [0, '☀', 'Clear', 'yellow'],
] as const

const BARS = '▁▂▃▄▅▆▇█'

export const weather = (percent: number) =>
  WEATHER.find(([min]) => percent >= min) ?? WEATHER[4]

// 134400 -> "134.4k", 200000 -> "200k", 1000000 -> "1M"
export const fmt = (n: number) => {
  const [v, unit] = n >= 1e6 ? [n / 1e6, 'M'] : n >= 1e3 ? [n / 1e3, 'k'] : [n, '']
  return `${v.toFixed(unit ? 1 : 0).replace(/\.0$/, '')}${unit}`
}

// One bar per sample, height = share of that sample's own window; last 12 turns.
export const chart = (history: readonly Sample[]) =>
  history
    .slice(-12)
    .map(({ tokens, window }) => BARS.charAt(Math.min(7, Math.max(0, Math.floor((tokens / window) * 8)))))
    .join('')

// Change since the previous turn (the first turn counts from zero). A compaction gives ▼.
export const delta = (history: readonly Sample[]) => {
  const d = (history.at(-1)?.tokens ?? 0) - (history.at(-2)?.tokens ?? 0)
  return `${d < 0 ? '▼ -' : '▲ +'}${fmt(Math.abs(d))} last turn`
}

// Whole percent of the window that a sample fills. A window of 0 gives 0.
export const percentOf = ({ tokens, window }: Sample) => (window > 0 ? Math.round((tokens / window) * 100) : 0)

// 0 Clear, 1 Cloudy, 2 Showers, 3 Storm, 4 Compact soon.
const rank = (percent: number) => Math.max(0, WEATHER.filter(([min]) => percent >= min).length - 1)

// Thunder plays when the band moves UP into Storm or Compact soon. Staying in a
// band, moving down, or having no earlier sample (a new session) gives no sound.
export const shouldThunder = (previous: number | undefined, current: number, isSoundAllowed: boolean) =>
  isSoundAllowed && previous !== undefined && rank(current) >= 3 && rank(current) > rank(previous)
