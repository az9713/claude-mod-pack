// The flow of Cache Keeper through the plugin. The engine is stubbed beneath it:
// `clock` (a clock that moves only when the test moves it), `store`, `session.usage`
// (the context size), `session.compact` (the compaction, which can be held, skipped
// or made to fail), `ui.toast`, `turn.start`, `turn.complete`, `session.end`, and a
// stub standing for next-steps in the AbovePrompt band. Nothing is drawn on a real
// screen: `ui.mount` runs the plugin's `ui.render` hook and the kit reads the tree.

import { test, expect, mock } from 'claude-code/testing'

const MARKER = 'OTHER-PLUGIN-BAND'
const MIN = 60_000

const props = (over: Record<string, unknown> = {}) =>
  ({ hasSurvey: false, isWorking: false, maxRows: 12, bodyColumns: 100, scroll: { offset: 0, bodyRows: 12 }, view: {}, ...over }) as never

const slash = (args: string) => ({ command: 'mods', args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 100 } })

const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'm' }

// A finished main-conversation turn. `over` can set `agentId`, `reason`, `isAborted`, or drop `usage`.
const turn = (id: string, over: Record<string, unknown> = {}) =>
  ({ answer: 'ok', durationMs: 1, isAborted: false, turnId: id, reason: 'answer' as const, usage: USAGE, ...over }) as never

type Compaction = 'ok' | 'skip' | 'throw'

// `w.*` can be changed in the middle of a test: the stubs read it at each call.
const world = (on: any, init: { hold?: number; compaction?: Compaction } = {}) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  const w = {
    clock,
    tokens: 160_000,
    hold: init.hold ?? 0, // how long the compaction stub sleeps, in ms of the mocked clock
    compaction: init.compaction ?? ('ok' as Compaction),
    toasts: [] as string[],
    compacts: [] as unknown[], // the inputs the compaction stub received
    invalidates: 0,
  }
  on('ui.render', { component: 'AbovePrompt' }, ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return Text({ children: MARKER })
  })
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: w.tokens, window: 1_000_000 }, rateLimits: [] } }))
  on('turn.start', (_$: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: 'ok' }))
  on('session.end', (_$: any, e: any) => ({ sessionId: e.sessionId }))
  on('ui.toast', (_$: any, e: any) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.invalidate', async (_$: any, _e: any, next: any) => {
    w.invalidates++
    return next(_e)
  })
  on('session.compact', async (_$: any, e: any) => {
    w.compacts.push(e)
    if (w.hold) await clock.sleep(w.hold)
    if (w.compaction === 'throw') throw new Error('a turn is running')
    if (w.compaction === 'skip') return { skip: 'vetoed by a hook' }
    return { messages: [{ role: 'user', text: 'a summary', toolUses: [] }], tokensBefore: 160_000, tokensAfter: 4000 }
  })
  return w
}

const mountBand = ($: any, over: Record<string, unknown> = {}, surface: 'terminal' | 'desktop' = 'terminal') =>
  $.ui.mount({ plugin: 'mod-pack', surface, component: 'AbovePrompt', props: props(over) })

const has = async (ui: any, text: string | RegExp) => (await ui.find({ type: 'Text', text })) !== undefined
const compactButton = (ui: any) => ui.find({ type: 'Button', key: 'compact' })

const sessionEnd = (reason: 'clear' | 'other') => ({ reason, sessionId: 's1', resume: {} }) as never
const compactInput = (over: Record<string, unknown> = {}) => ({ trigger: 'manual', messages: [{ role: 'user', text: 'hi', toolUses: [] }], ...over }) as never

// ---- the row ----

test('no turn yet: no Cache Keeper row; the other plugin still draws', async ($, on) => {
  world(on)
  const ui = await mountBand($)
  expect(await has(ui, MARKER)).toBe(true)
  expect(await has(ui, /cache/)).toBe(false)
  expect(await compactButton(ui)).toBeUndefined()
  await ui.unmount()
})

test('after a response: warm, the time left, the tokens, a compact button, one row high, below the other plugin', async ($, on) => {
  world(on)
  await $.turn.complete(turn('t1'))
  const ui = await mountBand($)
  expect(await has(ui, '⏱ cache warm 60m left · 160k tokens ')).toBe(true)
  expect(await compactButton(ui)).toBeDefined()

  const tree = JSON.stringify(await ui.drawn())
  expect(tree.indexOf('cache warm')).toBeGreaterThan(tree.indexOf(MARKER))
  expect(tree).toContain('"height":1')
  await ui.unmount()
})

test('the countdown follows the clock: 43 minutes left after 17 minutes;', async ($, on) => {
  const w = world(on)
  await $.turn.complete(turn('t1'))
  const ui = await mountBand($)
  await w.clock.advance(17 * MIN)
  await ui.unmount()
  const again = await mountBand($)
  expect(await has(again, /cache warm 43m left · 160k tokens/)).toBe(true)
  await again.unmount()
})

test('the last 5 minutes: "cools in", one toast only; later cold: re-reads the token count, no price, still one toast', async ($, on) => {
  const w = world(on)
  await $.turn.complete(turn('t1'))

  await w.clock.advance(54 * MIN)
  expect(w.toasts).toEqual([])

  await w.clock.advance(MIN) // 55 minutes: 5 minutes left
  expect(w.toasts).toHaveLength(1)
  expect(w.toasts[0]).toContain('cools in 5m')
  let ui = await mountBand($)
  expect(await has(ui, /cache cools in 5m/)).toBe(true)
  await ui.unmount()

  await w.clock.advance(MIN) // 4 minutes left
  expect(w.toasts).toHaveLength(1)
  ui = await mountBand($)
  expect(await has(ui, /cache cools in 4m/)).toBe(true)
  await ui.unmount()

  await w.clock.advance(5 * MIN) // 60 minutes: cold
  ui = await mountBand($)
  expect(await has(ui, '⏱ cache cold: next prompt re-reads 160k tokens uncached ')).toBe(true)
  expect(JSON.stringify(await ui.drawn())).not.toMatch(/\$|dollar|USD/i)
  expect(await compactButton(ui)).toBeDefined()
  await ui.unmount()
  expect(w.toasts).toHaveLength(1)
})

test('a new response restarts the clock and gives the next response its own toast', async ($, on) => {
  const w = world(on)
  await $.turn.complete(turn('t1'))
  await w.clock.advance(58 * MIN)
  expect(w.toasts).toHaveLength(1)

  w.tokens = 190_000
  await $.turn.complete(turn('t2'))
  const ui = await mountBand($)
  expect(await has(ui, /cache warm 60m left · 190k tokens/)).toBe(true)

  await w.clock.advance(56 * MIN)
  expect(w.toasts).toHaveLength(2)
  await ui.unmount()
})

test('a subagent turn does not restart the clock (it has its own cache)', async ($, on) => {
  const w = world(on)
  await $.turn.complete(turn('t1'))
  await w.clock.advance(30 * MIN)
  await $.turn.complete(turn('sub1', { agentId: 'agent-1' }))
  const ui = await mountBand($)
  expect(await has(ui, /cache warm 30m left/)).toBe(true)
  await ui.unmount()
})

test('while a turn runs there is no row and no toast; the response ends that', async ($, on) => {
  const w = world(on)
  await $.turn.complete(turn('t1'))
  const working = await mountBand($, { isWorking: true })
  expect(await has(working, /cache/)).toBe(false)
  expect(await compactButton(working)).toBeUndefined()
  await working.unmount()

  await $.turn.start({ text: 'go', turnId: 't2' })
  await w.clock.advance(57 * MIN) // the cache would be cooling, but the turn keeps it in use
  expect(w.toasts).toEqual([])

  await $.turn.complete(turn('t2'))
  const ui = await mountBand($)
  expect(await has(ui, /cache warm 60m left/)).toBe(true)
  await ui.unmount()
})

test('an interrupted or failed turn restarts the clock only when it reported usage', async ($, on) => {
  const w = world(on)
  await $.turn.complete(turn('t1'))
  await w.clock.advance(10 * MIN)

  await $.turn.complete(turn('t2', { reason: 'aborted', isAborted: true, usage: undefined }))
  await $.turn.complete(turn('t3', { reason: 'error', usage: undefined }))
  let ui = await mountBand($)
  expect(await has(ui, /cache warm 50m left/)).toBe(true)
  await ui.unmount()

  await $.turn.complete(turn('t4', { reason: 'aborted', isAborted: true })) // usage present: a response was counted
  ui = await mountBand($)
  expect(await has(ui, /cache warm 60m left/)).toBe(true)
  await ui.unmount()
})

test('the context size is unknown: the row has no tokens part', async ($, on) => {
  const w = world(on)
  w.tokens = undefined as never
  await $.turn.complete(turn('t1'))
  const ui = await mountBand($)
  expect(await has(ui, '⏱ cache warm 60m left ')).toBe(true)
  await ui.unmount()
})

test('off the terminal: no row', async ($, on) => {
  world(on)
  await $.turn.complete(turn('t1'))
  const ui = await mountBand($, {}, 'desktop')
  expect(await has(ui, /cache/)).toBe(false)
  await ui.unmount()
})

// ---- the lifetime setting ----

test('cacheTtlMinutes 2: cools at once, cold after 2 minutes, and no toast (there is no warm part)', { options: { cacheTtlMinutes: 2 } }, async ($, on) => {
  const w = world(on)
  await $.turn.complete(turn('t1'))
  let ui = await mountBand($)
  expect(await has(ui, /cache cools in 2m/)).toBe(true)
  await ui.unmount()

  await w.clock.advance(2 * MIN)
  ui = await mountBand($)
  expect(await has(ui, /cache cold/)).toBe(true)
  await ui.unmount()
  expect(w.toasts).toEqual([])
})

test('cacheTtlMinutes 5 (an API key): cools in 5m right after the response', { options: { cacheTtlMinutes: 5 } }, async ($, on) => {
  world(on)
  await $.turn.complete(turn('t1'))
  const ui = await mountBand($)
  expect(await has(ui, /cache cools in 5m/)).toBe(true)
  await ui.unmount()
})

for (const bad of [0, -1, 5000]) {
  test(`cacheTtlMinutes ${bad} is invalid: the default of 60 minutes is used`, { options: { cacheTtlMinutes: bad } }, async ($, on) => {
    world(on)
    await $.turn.complete(turn('t1'))
    const ui = await mountBand($)
    expect(await has(ui, /cache warm 60m left/)).toBe(true)
    await ui.unmount()
  })
}

test('cacheTtlMinutes 90: shown in minutes', { options: { cacheTtlMinutes: 90 } }, async ($, on) => {
  world(on)
  await $.turn.complete(turn('t1'))
  const ui = await mountBand($)
  expect(await has(ui, /cache warm 90m left/)).toBe(true)
  await ui.unmount()
})

// ---- the compact button and the shared lock ----

test('compact: the engine compacts once, the row goes until the next response, no toast', async ($, on) => {
  const w = world(on)
  await $.turn.complete(turn('t1'))
  const ui = await mountBand($)

  await ui.press({ key: 'compact' })
  expect(w.compacts).toHaveLength(1)
  expect(await has(ui, /cache/)).toBe(false)
  expect(await compactButton(ui)).toBeUndefined()
  expect(await has(ui, MARKER)).toBe(true)
  expect(w.toasts).toEqual([])

  await $.turn.complete(turn('t2'))
  expect(await has(ui, /cache warm 60m left/)).toBe(true)
  await ui.unmount()
})

test('compact while a compaction runs: the press is ignored and the row says compacting…', async ($, on) => {
  const w = world(on, { hold: 1000 })
  await $.turn.complete(turn('t1'))
  const ui = await mountBand($)

  await ui.press({ key: 'compact' })
  await w.clock.settle()
  expect(await has(ui, '⏱ compacting…')).toBe(true)
  expect(await compactButton(ui)).toBeUndefined() // no second button to press while it runs
  expect(w.compacts).toHaveLength(1)

  await w.clock.advance(1000)
  expect(w.compacts).toHaveLength(1)
  expect(await has(ui, /cache|compacting/)).toBe(false)
  await ui.unmount()
})

test('two presses in the same instant: one compaction (the lock, not only the missing button)', async ($, on) => {
  const w = world(on, { hold: 1000 })
  await $.turn.complete(turn('t1'))
  const ui = await mountBand($)

  // Both presses are raised before either redraw: the button is still there for both.
  const results = await Promise.allSettled([ui.press({ key: 'compact' }), ui.press({ key: 'compact' })])
  await w.clock.advance(1000)
  expect(results.map(r => r.status)).toEqual(['fulfilled', 'fulfilled'])
  expect(w.compacts).toHaveLength(1)
  await ui.unmount()
})

test('a compaction the person started (/compact or auto) holds the lock, and clears the row when it stands', async ($, on) => {
  const w = world(on, { hold: 1000 })
  await $.turn.complete(turn('t1'))
  const ui = await mountBand($)

  const done = $.session.compact(compactInput())
  await w.clock.settle()
  expect(await has(ui, '⏱ compacting…')).toBe(true)
  expect(await compactButton(ui)).toBeUndefined()

  await w.clock.advance(1000)
  await done
  expect(w.compacts).toHaveLength(1)
  expect(await has(ui, /cache|compacting/)).toBe(false)

  // The lock is free again: after the next response the button compacts.
  w.hold = 0
  await $.turn.complete(turn('t2'))
  await ui.press({ key: 'compact' })
  expect(w.compacts).toHaveLength(2)
  await ui.unmount()
})

test('an auto compaction is handled the same way as a manual one', async ($, on) => {
  const w = world(on)
  await $.turn.complete(turn('t1'))
  const ui = await mountBand($)
  await $.session.compact(compactInput({ trigger: 'auto' }))
  expect(await has(ui, /cache/)).toBe(false)
  await ui.unmount()
  expect(w.compacts).toHaveLength(1)
})

test('a compaction that stands is not assumed for precompute or for a subagent: the row stays', async ($, on) => {
  world(on)
  await $.turn.complete(turn('t1'))
  const ui = await mountBand($)
  await $.session.compact(compactInput({ trigger: 'precompute' }))
  expect(await has(ui, /cache warm 60m left/)).toBe(true)
  await $.session.compact(compactInput({ trigger: 'auto', agentId: 'agent-1' }))
  expect(await has(ui, /cache warm 60m left/)).toBe(true)
  await ui.unmount()
})

test('a compaction a hook vetoed: a toast with the reason, the row stays, the lock is free', async ($, on) => {
  const w = world(on, { compaction: 'skip' })
  await $.turn.complete(turn('t1'))
  const ui = await mountBand($)
  await ui.press({ key: 'compact' })
  expect(w.toasts).toEqual(['Cache Keeper: compaction skipped: vetoed by a hook'])
  expect(await has(ui, /cache warm 60m left/)).toBe(true)

  await ui.press({ key: 'compact' })
  expect(w.compacts).toHaveLength(2)
  await ui.unmount()
})

test('compact rejects (a turn is running): a toast, the row stays, the lock is free', async ($, on) => {
  const w = world(on, { compaction: 'throw' })
  await $.turn.complete(turn('t1'))
  const ui = await mountBand($)
  await ui.press({ key: 'compact' })
  expect(w.toasts).toHaveLength(1)
  expect(w.toasts[0]).toContain('could not compact now')
  expect(await has(ui, /cache warm 60m left/)).toBe(true)
  expect(await has(ui, 'compacting')).toBe(false)

  await ui.press({ key: 'compact' })
  expect(w.compacts).toHaveLength(2)
  await ui.unmount()
})

// ---- /clear, session end, and the timer ----

test('/clear (session.end, reason clear): the row goes, and nothing is shown until the next response', async ($, on) => {
  world(on)
  await $.turn.complete(turn('t1'))
  const ui = await mountBand($)
  expect(await has(ui, /cache warm/)).toBe(true)

  await $.session.end(sessionEnd('clear'))
  expect(await has(ui, /cache/)).toBe(false)

  await $.turn.complete(turn('t2'))
  expect(await has(ui, /cache warm 60m left/)).toBe(true)
  await ui.unmount()
})

test('the minute timer: it redraws once a minute, stops at session.end, and is started again by the next response', async ($, on) => {
  const w = world(on)
  await $.turn.complete(turn('t1'))

  const before = w.invalidates
  await w.clock.advance(3 * MIN)
  expect(w.invalidates - before).toBeGreaterThanOrEqual(3)

  await $.session.end(sessionEnd('clear'))
  const stopped = w.invalidates
  await w.clock.advance(10 * MIN)
  expect(w.invalidates).toBe(stopped)

  await $.turn.complete(turn('t2'))
  const restarted = w.invalidates
  await w.clock.advance(2 * MIN)
  expect(w.invalidates - restarted).toBeGreaterThanOrEqual(2)
})

test('one response does not start two timers: after 5 responses, 3 minutes give 3 redraws, not 15', async ($, on) => {
  const w = world(on)
  for (let i = 0; i < 5; i++) await $.turn.complete(turn(`t${i}`))
  const before = w.invalidates
  await w.clock.advance(3 * MIN)
  expect(w.invalidates - before).toBe(3)
})

// ---- the off switch ----

test('/mods off cache-keeper: the row goes at once, no toast, the other plugin stays; /mods on brings it back', async ($, on) => {
  const w = world(on)
  await $.turn.complete(turn('t1'))
  const ui = await mountBand($)
  expect(await has(ui, /cache warm/)).toBe(true)

  expect((await $.command.run(slash('off cache-keeper'))).text).toBe('mod-pack: cache-keeper is OFF.')
  expect(await has(ui, /cache/)).toBe(false)
  expect(await has(ui, MARKER)).toBe(true)

  await w.clock.advance(58 * MIN)
  expect(w.toasts).toEqual([])
  expect(w.compacts).toEqual([])

  await $.command.run(slash('on cache-keeper'))
  expect(await has(ui, /cache cools in 2m/)).toBe(true)
  await ui.unmount()
})

test('/mods lists Cache Keeper ON by default, with no token or sound flag', async ($, on) => {
  world(on)
  const list = await $.command.run(slash(''))
  expect(list.text).toMatch(/ON\s+cache-keeper\s+Cache Keeper: countdown of how long the prompt cache stays warm/)
  const line = (list.text ?? '').split('\n').find(l => l.includes('cache-keeper')) ?? ''
  expect(line).toContain('costs no model tokens')
  expect(line).not.toContain('[')
})

test('the cacheKeeper setting off: no row, no toast, no state; a /mods on choice beats the setting', { options: { cacheKeeper: false } }, async ($, on) => {
  const w = world(on)
  await $.turn.complete(turn('t1'))
  const ui = await mountBand($)
  expect(await has(ui, /cache/)).toBe(false)
  await w.clock.advance(58 * MIN)
  expect(w.toasts).toEqual([])
  await ui.unmount()

  await $.command.run(slash('on cache-keeper'))
  await $.turn.complete(turn('t2'))
  const again = await mountBand($)
  expect(await has(again, /cache warm 60m left/)).toBe(true)
  await again.unmount()
})

// ---- beside Token Weather and another plugin's band ----

test('beside Token Weather and the next-steps stub: all three show, in order, none overwritten', async ($, on) => {
  world(on)
  await $.turn.complete(turn('t1'))
  const ui = await mountBand($)

  expect(await has(ui, MARKER)).toBe(true)
  expect(await has(ui, /16% 160k \/ 1M/)).toBe(true)
  expect(await has(ui, /cache warm 60m left · 160k tokens/)).toBe(true)

  const tree = JSON.stringify(await ui.drawn())
  const [marker, weather, cache] = [tree.indexOf(MARKER), tree.indexOf('Clear'), tree.indexOf('cache warm')]
  expect(marker).toBeGreaterThan(-1)
  expect(weather).toBeGreaterThan(marker)
  expect(cache).toBeGreaterThan(weather)
  await ui.unmount()
})

test('a row budget of 1 (maxRows 5): Token Weather has the priority, Cache Keeper waits', async ($, on) => {
  world(on)
  await $.turn.complete(turn('t1'))
  const ui = await mountBand($, { maxRows: 5 })
  expect(await has(ui, MARKER)).toBe(true)
  expect(await has(ui, /16% 160k/)).toBe(true)
  expect(await has(ui, /cache/)).toBe(false)
  await ui.unmount()
})

test('Token Weather off: the Cache Keeper row moves up and still shows', async ($, on) => {
  world(on)
  await $.turn.complete(turn('t1'))
  await $.command.run(slash('off token-weather'))
  const ui = await mountBand($, { maxRows: 5 })
  expect(await has(ui, /Clear/)).toBe(false)
  expect(await has(ui, /cache warm/)).toBe(true)
  await ui.unmount()
})

// ---- the clock cannot be read ----

test('the clock cannot be read: no row, no crash', async ($, on) => {
  mock.store(on)
  on('ui.render', { component: 'AbovePrompt' }, ($: any, e: any) => $.ui.resolve(e).Text({ children: MARKER }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 1000, window: 1_000_000 }, rateLimits: [] } }))
  on('turn.complete', () => ({ text: 'ok' }))
  await $.turn.complete(turn('t1'))
  const ui = await mountBand($)
  expect(await has(ui, MARKER)).toBe(true)
  expect(await has(ui, /cache/)).toBe(false)
  await ui.unmount()
})
