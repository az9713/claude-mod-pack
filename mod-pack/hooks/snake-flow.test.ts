// The flow of Snake through the plugin. The engine is stubbed beneath it: `clock` (moves only when the
// test moves it), a store in memory (own stubs, so that every read can be counted: a running tick reads
// the store once, so a count that stays flat shows that the timer is gone), `session.surfaces`,
// `command.register`, `ui.open` / `ui.close` / `ui.panes` (a pane list, an open that can wait undrawn or
// throw), `turn.start`, `turn.complete`, `session.end`, the Blast Radius dialog (`tool.call` for
// AskUserQuestion, which can be held) and a stub standing for next-steps in the AbovePrompt band.
// Nothing is drawn on a real screen: `ui.mount` runs the plugin's `ui.render` hook for the Pane and the
// kit reads the tree. The kit cannot raise the person's own close of a pane (ctrl+x x, Esc): `/snake`
// and `/mods off snake` raise the same `ui.close` hook through the plugin's own `$.ui.close`.

import { test, expect, mock } from 'claude-code/testing'

import { newGame, step } from './snake-game'
import type { SnakeGame } from './snake-game'

const MARKER = 'OTHER-PLUGIN-BAND'
const PANE_MARKER = 'OTHER-PLUGIN-PANE'
const TICK = 150
const BEST_KEY = 'mod-pack/snake-best'

const bandProps = (over: Record<string, unknown> = {}) =>
  ({ hasSurvey: false, isWorking: false, maxRows: 12, bodyColumns: 100, scroll: { offset: 0, bodyRows: 12 }, view: {}, ...over }) as never
const paneProps = (over: Record<string, unknown> = {}) =>
  ({ title: 'Snake', isFocused: true, bodyColumns: 60, placement: 'inline', scroll: { offset: 0, bodyRows: 13 }, view: {}, ...over }) as never

const slash = (args: string) => ({ command: 'mods', args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 100 } })
const snakeCmd = (columns = 100) => ({ command: 'snake', args: '', origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns } })
const queueCmd = (args: string) => ({ command: 'q', args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 100 } })

const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'm' }
const turn = (id: string, over: Record<string, unknown> = {}) =>
  ({ answer: 'ok', durationMs: 1, isAborted: false, turnId: id, reason: 'answer' as const, usage: USAGE, ...over }) as never
const sessionEnd = () => ({ reason: 'clear' as const, sessionId: 's1', resume: {} }) as never

// A clock value for a game with exactly one meal: the first food lands on the head's row, 3 or more cells
// ahead of the head (the head starts at x 5, y 4), and a snake that goes straight on eats it and then
// dies at the right wall without eating again. The test plays the pure rules to find it.
const FOOD_AHEAD = (() => {
  for (let now = 1_000_000; ; now++) {
    const first = newGame(now)
    if (!first.food || first.food.y !== 4 || first.food.x < 8) continue
    let g: SnakeGame = { ...first, status: 'running', pause: undefined }
    for (let i = 0; i < 30 && g.status === 'running'; i++) g = step(g)
    if (g.score === 1) return now
  }
})()
const foodX = (now: number) => newGame(now).food!.x

type Open = 'placed' | 'waits' | 'throw'

type Init = { now?: number; surfaces?: string[] | 'throw'; open?: Open; holds?: number[]; paneBelow?: boolean }

// `w.*` can be changed in the middle of a test: the stubs read it at each call.
const world = (on: any, init: Init = {}) => {
  const clock = mock.clock(on, { now: init.now ?? 1_000_000 })
  const w = {
    clock,
    kv: new Map<string, unknown>(),
    storeGets: 0, // every store.get the plugin made
    storeFails: false, // the high score key cannot be read or written
    surfaces: init.surfaces ?? ['terminal'],
    open: init.open ?? ('placed' as Open),
    opens: [] as any[],
    closes: [] as any[],
    panes: [] as string[],
    toasts: [] as string[],
    registered: [] as any[],
    logs: [] as string[],
    submits: [] as string[],
    holds: [...(init.holds ?? [])], // how long each Blast Radius dialog stays open, in ms of the mocked clock
    questions: 0,
    reached: [] as string[],
    bandRenders: 0,
  }
  on('store.get', (_$: any, e: any) => {
    w.storeGets++
    if (w.storeFails && e.key === BEST_KEY) throw new Error('the store is down')
    return { value: w.kv.get(e.key) }
  })
  on('store.set', (_$: any, e: any) => {
    if (w.storeFails && e.key === BEST_KEY) throw new Error('the store is down')
    w.kv.set(e.key, e.value)
    return { value: undefined }
  })
  on('ui.log', (_$: any, e: any) => {
    w.logs.push(typeof e.text === 'string' ? e.text : JSON.stringify(e))
    return { value: undefined }
  })
  on('ui.render', { component: 'AbovePrompt' }, ($: any, e: any) => {
    w.bandRenders++
    const { Text } = $.ui.resolve(e)
    return Text({ children: MARKER })
  })
  if (init.paneBelow) {
    on('ui.render', { component: 'Pane', requestId: 'snake' }, ($: any, e: any) => {
      const { Text } = $.ui.resolve(e)
      return Text({ children: PANE_MARKER })
    })
  }
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 160_000, window: 1_000_000 }, rateLimits: [] } }))
  on('session.surfaces', () => {
    if (w.surfaces === 'throw') throw new Error('no surfaces')
    return { value: w.surfaces }
  })
  on('command.register', (_$: any, e: any) => {
    w.registered.push(e)
    return { value: { command: e.name } }
  })
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  on('turn.start', (_$: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: 'ok' }))
  on('session.end', (_$: any, e: any) => ({ sessionId: e.sessionId }))
  on('ui.toast', (_$: any, e: any) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.open', (_$: any, e: any) => {
    w.opens.push(e)
    // A hook that throws is skipped by the engine, so a refusal is the `{ deny }` answer.
    if (w.open === 'throw') return { deny: 'a hook refused it' }
    if (w.open === 'waits') return { value: { isPlaced: false, reason: 'the terminal is 90 columns wide' } }
    if (!w.panes.includes(e.id)) w.panes.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.close', (_$: any, e: any) => {
    w.closes.push(e)
    w.panes = w.panes.filter(id => id !== e.id)
    return { value: undefined }
  })
  on('ui.panes', () => ({ value: w.panes.map(id => ({ id, title: id, isShown: true, isFocused: true, isPlaced: true })) }))
  on('prompt.submit', (_$: any, e: any) => {
    w.submits.push(e.text)
    return { text: e.text }
  })
  // Blast Radius: the dialog, and what it needs to build its preview.
  on('session.cwd', () => ({ value: '/work' }))
  on('fs.stat', () => {
    throw new Error('ENOENT')
  })
  on('fs.list', () => ({ value: [] }))
  on('tool.call', { tool: 'AskUserQuestion' }, async (_$: any, e: any) => {
    w.questions++
    const q = e.questions[0]
    const hold = w.holds.shift() ?? 0
    if (hold) await clock.sleep(hold)
    return { result: { questions: e.questions, answers: { [q.question]: 'Proceed' } } } as any
  })
  for (const tool of ['Bash', 'PowerShell'] as const) {
    on('tool.call', { tool }, (_$: any, e: any) => {
      w.reached.push(e.command)
      return { result: { stdout: 'ran', stderr: '', interrupted: false } } as any
    })
  }
  return w
}

const mountPane = ($: any, over: Record<string, unknown> = {}, surface: 'terminal' | 'desktop' = 'terminal') =>
  $.ui.mount({ plugin: 'mod-pack', surface, component: 'Pane', requestId: 'snake', props: paneProps(over) })
const mountBand = ($: any, over: Record<string, unknown> = {}) =>
  $.ui.mount({ plugin: 'mod-pack', surface: 'terminal', component: 'AbovePrompt', props: bandProps(over) })

const texts = async (ui: any) => (await ui.findAll({ type: 'Text' })).map((t: any) => t.text as string)
const status = async (ui: any) => (await texts(ui))[1]
const title = async (ui: any) => (await texts(ui))[0]
const has = async (ui: any, text: string | RegExp) => (await ui.find({ type: 'Text', text })) !== undefined
const boardRows = async (ui: any) => (await ui.findAll({ type: 'Box' })).filter((b: any) => (b.key ?? '').startsWith('row-'))

// Where the head is: the run of the board drawn in yellow. A cell is 2 columns wide.
const headOf = async (ui: any) => {
  const rows = await boardRows(ui)
  for (let y = 0; y < rows.length; y++) {
    let column = 0
    for (const run of rows[y].children as any[]) {
      if (run.props.color === 'yellow') return { x: column / 2, y }
      column += (run.children as string[]).join('').length
    }
  }
  return undefined
}
const bodyCells = async (ui: any) => (await boardRows(ui)).map((r: any) => r.text as string).join('').split('').filter((c: string) => c === '█').length / 2

const open = async ($: any) => ((await $.command.run(snakeCmd())).text ?? '') as string
const press = (ui: any, key: string) => ui.press({ key })
// Opens the pane, mounts it, and starts the game.
const play = async ($: any, over: Record<string, unknown> = {}) => {
  await open($)
  const ui = await mountPane($, over)
  await press(ui, 'toggle')
  return ui
}

// ---- the command and the pane ----

test('session.start registers /snake as an immediate command (the point is to open it while Claude works), beside /mods and /q', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  expect(w.registered.map(r => r.name)).toEqual(['mods', 'q', 'snake'])
  expect(w.registered.find(r => r.name === 'snake').immediate).toBe(true)
})

test('/snake opens the pane with the focus, Esc to close, and room for the board; it does not hold toasts', async ($, on) => {
  const w = world(on)
  const text = await open($)
  expect(text).toContain('Snake opened.')
  expect(text).toContain('Esc or /snake closes it')
  // Exactly these options: no `holdToasts`, so the toasts of Cache Keeper and Prompt Queue still show while it is open.
  expect(w.opens).toEqual([{ id: 'snake', title: 'Snake', focus: true, closeOnEscape: true, rows: 13 }])
})

test('/snake again closes the pane, stops the timer and holds the game; the next /snake shows the game where it was, paused for the person', async ($, on) => {
  const w = world(on)
  const first = await play($)
  await w.clock.advance(2 * TICK)
  expect(await headOf(first)).toEqual({ x: 7, y: 4 })

  expect(await open($)).toContain('Snake closed.')
  await first.unmount() // the surface drops the pane that was closed
  expect(w.closes.map(c => c.id)).toEqual(['snake'])
  expect(w.closes[0].origin).toEqual({ kind: 'plugin' }) // the plugin's own close, which the ui.close hook sees
  const reads = w.storeGets
  await w.clock.advance(5_000)
  expect(w.storeGets).toBe(reads) // no tick after the close: the timer is gone

  expect(await open($)).toContain('Snake opened.')
  expect(w.opens).toHaveLength(2)
  const second = await mountPane($)
  expect(await headOf(second)).toEqual({ x: 7, y: 4 }) // the game is kept
  expect(await status(second)).toBe('PAUSED – press p to play') // and waits for the person: no turn can start it
  await $.turn.start({ text: 'x', turnId: 't1' })
  expect(await status(second)).toBe('PAUSED – press p to play')
  await press(second, 'toggle')
  await w.clock.advance(TICK)
  expect(await headOf(second)).toEqual({ x: 8, y: 4 })
  await second.unmount()
})

test('a new game: the board, the status, the keys; paused until the person presses p', async ($, on) => {
  world(on)
  await open($)
  const ui = await mountPane($)
  expect(await title(ui)).toBe('Snake  score 0  best 0')
  expect(await status(ui)).toBe('PAUSED – press p to play')

  const rows = await boardRows(ui)
  expect(rows).toHaveLength(8)
  for (const row of rows) expect((row.text as string).length).toBe(32)
  expect(await headOf(ui)).toEqual({ x: 5, y: 4 })
  expect(await bodyCells(ui)).toBe(3)
  expect(await has(ui, '● ')).toBe(true) // the food

  await ui.unmount()
})

test('the keys: w a s d turn, p plays and pauses, r restarts; all letters, plain, none a digit', async ($, on) => {
  world(on)
  await open($)
  const ui = await mountPane($)
  const buttons = (await ui.findAll({ type: 'Button' })).map((b: any) => [b.props.key, b.props.hotkey, b.props.label, b.props.plain])
  expect(buttons).toEqual([
    ['up', 'w', 'up', true],
    ['left', 'a', 'left', true],
    ['down', 's', 'down', true],
    ['right', 'd', 'right', true],
    ['toggle', 'p', 'play', true],
    ['restart', 'r', 'restart', true],
  ])
  for (const [, hotkey] of buttons) expect(/^[a-z]$/.test(hotkey as string)).toBe(true)
  await press(ui, 'toggle')
  expect((await ui.find({ type: 'Button', key: 'toggle' }))?.props.label).toBe('pause')
  await ui.unmount()
})

test('the hint says the keys need the pane focused when it is not; Esc closes it when it is', async ($, on) => {
  world(on)
  await open($)
  const focused = await mountPane($, { isFocused: true })
  expect(await has(focused, 'Esc closes the pane.')).toBe(true)
  expect(await has(focused, /Keys need the pane focused/)).toBe(false)
  await focused.unmount()
  const loose = await mountPane($, { isFocused: false })
  expect(await has(loose, 'Keys need the pane focused: click it, or ctrl+x then Tab.')).toBe(true)
  await loose.unmount()
})

test('the pane keeps what another plugin draws beneath it (next is called), and still draws when nothing is beneath', async ($, on) => {
  world(on, { paneBelow: true })
  await open($)
  const ui = await mountPane($)
  expect(await has(ui, PANE_MARKER)).toBe(true)
  expect(await has(ui, 'Snake  score 0  best 0')).toBe(true)
  const tree = JSON.stringify(await ui.drawn())
  expect(tree.indexOf('Snake  score')).toBeGreaterThan(tree.indexOf(PANE_MARKER)) // the other plugin first, the board below it
  await ui.unmount()
})

test('with nothing beneath the pane, the board is drawn all the same', async ($, on) => {
  world(on)
  await open($)
  const ui = await mountPane($)
  expect(await title(ui)).toBe('Snake  score 0  best 0')
  await ui.unmount()
})

// ---- the timer ----

test('the tick is 150 ms: the snake moves one cell for each, and the redraw follows with no invalidate', async ($, on) => {
  const w = world(on)
  const ui = await play($)
  expect(await status(ui)).toBe('playing')
  expect(await headOf(ui)).toEqual({ x: 5, y: 4 })
  await w.clock.advance(TICK - 1)
  expect(await headOf(ui)).toEqual({ x: 5, y: 4 })
  await w.clock.advance(1)
  expect(await headOf(ui)).toEqual({ x: 6, y: 4 })
  await w.clock.advance(3 * TICK)
  expect(await headOf(ui)).toEqual({ x: 9, y: 4 })
  await ui.unmount()
})

test('steering: a key turns the snake at the next tick; a 180 degree turn and a key on a paused game are ignored', async ($, on) => {
  const w = world(on)
  await open($)
  const ui = await mountPane($)
  await press(ui, 'up') // paused: dropped
  await press(ui, 'toggle')
  await w.clock.advance(TICK)
  expect(await headOf(ui)).toEqual({ x: 6, y: 4 }) // it went on to the right, it did not turn up

  await press(ui, 'left') // opposite of right: dropped
  await w.clock.advance(TICK)
  expect(await headOf(ui)).toEqual({ x: 7, y: 4 })

  await press(ui, 'up')
  await w.clock.advance(TICK)
  expect(await headOf(ui)).toEqual({ x: 7, y: 3 })
  await press(ui, 'left')
  await w.clock.advance(TICK)
  expect(await headOf(ui)).toEqual({ x: 6, y: 3 })
  await ui.unmount()
})

test('a key press and a tick that come together both land', async ($, on) => {
  const w = world(on)
  const ui = await play($)
  await Promise.all([w.clock.advance(TICK), press(ui, 'down')])
  await w.clock.advance(TICK)
  // The key landed before the first tick or between the two: either way the snake has turned down, and no tick was lost.
  expect([{ x: 5, y: 6 }, { x: 6, y: 5 }]).toContainEqual(await headOf(ui))
  expect(await status(ui)).toBe('playing')
  await ui.unmount()
})

test('there is one timer: a second start does not double the speed', async ($, on) => {
  const w = world(on)
  const ui = await play($)
  await press(ui, 'toggle') // pause
  await press(ui, 'toggle') // play again
  await press(ui, 'right') // a key on a running game arms nothing new
  const before = w.storeGets
  await w.clock.advance(10 * TICK)
  expect(w.storeGets - before).toBe(10) // 10 ticks read the store 10 times: one timer
  expect(await headOf(ui)).toEqual({ x: 15, y: 4 })
  await ui.unmount()
})

// ---- pause on turn.complete, resume on turn.start ----

test('Claude finishes: the game pauses and says PAUSED – Claude finished; the timer is gone; the next prompt resumes it', async ($, on) => {
  const w = world(on)
  const ui = await play($)
  await w.clock.advance(2 * TICK)
  expect(await headOf(ui)).toEqual({ x: 7, y: 4 })

  await $.turn.complete(turn('t1'))
  expect(await status(ui)).toBe('PAUSED – Claude finished')
  const reads = w.storeGets
  await w.clock.advance(10_000)
  expect(await headOf(ui)).toEqual({ x: 7, y: 4 }) // it did not move
  expect(w.storeGets).toBe(reads) // and no tick ran at all: the timer was cancelled

  await $.turn.start({ text: 'next', turnId: 't2' })
  expect(await status(ui)).toBe('playing')
  await w.clock.advance(TICK)
  expect(await headOf(ui)).toEqual({ x: 8, y: 4 }) // from where it stopped
  await ui.unmount()
})

test('an interrupted turn pauses the game too; a subagent turn does not', async ($, on) => {
  const w = world(on)
  const ui = await play($)
  await $.turn.complete(turn('sub', { agentId: 'agent-1' }))
  expect(await status(ui)).toBe('playing')
  await w.clock.advance(TICK)
  expect(await headOf(ui)).toEqual({ x: 6, y: 4 })

  await $.turn.complete(turn('t1', { reason: 'aborted', isAborted: true }))
  expect(await status(ui)).toBe('PAUSED – Claude finished')
  await ui.unmount()
})

test('a game that the person paused stays paused when a turn starts or ends; a game that was never started too', async ($, on) => {
  const w = world(on)
  await open($)
  const ui = await mountPane($)
  await $.turn.start({ text: 'x', turnId: 't1' })
  await $.turn.complete(turn('t1'))
  await $.turn.start({ text: 'y', turnId: 't2' })
  expect(await status(ui)).toBe('PAUSED – press p to play') // opened while idle, never started: a turn does not start it

  await press(ui, 'toggle')
  await w.clock.advance(TICK)
  await press(ui, 'toggle') // the person pauses
  expect(await status(ui)).toBe('PAUSED – press p to play')
  await $.turn.complete(turn('t2'))
  await $.turn.start({ text: 'z', turnId: 't3' })
  expect(await status(ui)).toBe('PAUSED – press p to play') // Claude's start does not resume what the person paused
  await ui.unmount()
})

test('the person can play after Claude finished (p); the next turn then leaves the running game alone', async ($, on) => {
  const w = world(on)
  const ui = await play($)
  await $.turn.complete(turn('t1'))
  expect(await status(ui)).toBe('PAUSED – Claude finished')
  await press(ui, 'toggle')
  expect(await status(ui)).toBe('playing')
  await w.clock.advance(TICK)
  expect(await headOf(ui)).toEqual({ x: 6, y: 4 })
  await $.turn.start({ text: 'x', turnId: 't2' })
  expect(await status(ui)).toBe('playing')
  await w.clock.advance(TICK)
  expect(await headOf(ui)).toEqual({ x: 7, y: 4 })
  await ui.unmount()
})

test('the pause and the resume go round again with every turn', async ($, on) => {
  const w = world(on)
  const ui = await play($)
  for (let i = 1; i <= 3; i++) {
    await $.turn.complete(turn(`c${i}`))
    expect(await status(ui)).toBe('PAUSED – Claude finished')
    await $.turn.start({ text: 'again', turnId: `s${i}` })
    expect(await status(ui)).toBe('playing')
    await w.clock.advance(TICK)
  }
  expect(await headOf(ui)).toEqual({ x: 8, y: 4 })
  await ui.unmount()
})

test('/clear (session.end) stops the timer and holds the game: a later turn does not start it', async ($, on) => {
  const w = world(on)
  const ui = await play($)
  await w.clock.advance(TICK)
  await $.session.end(sessionEnd())
  const reads = w.storeGets
  await w.clock.advance(5_000)
  expect(w.storeGets).toBe(reads)
  expect(await status(ui)).toBe('PAUSED – press p to play')
  await $.turn.start({ text: 'x', turnId: 't1' })
  expect(await status(ui)).toBe('PAUSED – press p to play')
  await ui.unmount()
})

// ---- the end of a game, the high score, restart ----

test('eating scores and grows; the wall ends the game; the high score is kept; r starts again; a turn does not revive a finished game', async ($, on) => {
  const w = world(on, { now: FOOD_AHEAD })
  const ui = await play($)
  const ticksToFood = foodX(FOOD_AHEAD) - 5
  await w.clock.advance(ticksToFood * TICK)
  expect(await title(ui)).toBe('Snake  score 1  best 1')
  expect(await bodyCells(ui)).toBe(4)

  await w.clock.advance(20 * TICK) // on to the right wall
  expect(await status(ui)).toBe('GAME OVER – press r for a new game.')
  expect(w.kv.get(BEST_KEY)).toBe(1)

  const reads = w.storeGets
  await w.clock.advance(5_000)
  expect(w.storeGets).toBe(reads) // the timer stopped when the game ended
  await $.turn.start({ text: 'x', turnId: 't1' })
  expect(await status(ui)).toBe('GAME OVER – press r for a new game.')
  await press(ui, 'up')
  await press(ui, 'toggle')
  expect(await status(ui)).toBe('GAME OVER – press r for a new game.') // keys other than r do nothing

  await press(ui, 'restart')
  expect(await status(ui)).toBe('playing')
  expect(await title(ui)).toBe('Snake  score 0  best 1')
  expect(await bodyCells(ui)).toBe(3)
  await w.clock.advance(TICK)
  expect(await headOf(ui)).toEqual({ x: 6, y: 4 })
  await ui.unmount()
})

test('the high score is read when the pane opens', async ($, on) => {
  const w = world(on)
  w.kv.set(BEST_KEY, 7)
  await open($)
  const ui = await mountPane($)
  expect(await title(ui)).toBe('Snake  score 0  best 7')
  await ui.unmount()
})

for (const bad of [-3, 'x', 2.5, null]) {
  test(`a stored high score that is not a whole number from 0 up (${JSON.stringify(bad)}) counts as 0`, async ($, on) => {
    const w = world(on)
    w.kv.set(BEST_KEY, bad)
    await open($)
    const ui = await mountPane($)
    expect(await title(ui)).toBe('Snake  score 0  best 0')
    await ui.unmount()
  })
}

test('a store that is down: the game plays, ends and restarts; nothing throws; the best of this run still shows', async ($, on) => {
  const w = world(on, { now: FOOD_AHEAD })
  w.storeFails = true
  const ui = await play($)
  await w.clock.advance((foodX(FOOD_AHEAD) - 5 + 20) * TICK)
  expect(await status(ui)).toBe('GAME OVER – press r for a new game.')
  expect(await title(ui)).toBe('Snake  score 1  best 1')
  expect(w.logs.filter(l => l.includes('snake'))).toEqual([])
  await ui.unmount()
})

// ---- the off switches ----

test('/mods off snake: the pane is closed at once, the timer stops, /snake says it is off and opens nothing; /mods on brings it back', async ($, on) => {
  const w = world(on)
  const ui = await play($)
  await w.clock.advance(TICK)

  expect((await $.command.run(slash('off snake'))).text).toBe('mod-pack: snake is OFF.')
  expect(w.closes.map(c => c.id)).toEqual(['snake'])
  const reads = w.storeGets
  await w.clock.advance(5_000)
  expect(w.storeGets).toBe(reads)

  const opens = w.opens.length
  expect((await $.command.run(snakeCmd())).text).toBe('mod-pack: snake is OFF. Turn it on with /mods on snake.')
  expect(w.opens).toHaveLength(opens)

  // A turn and a key press change nothing while it is off.
  await $.turn.complete(turn('t1'))
  await $.turn.start({ text: 'x', turnId: 't2' })
  await press(ui, 'toggle')
  expect(await status(ui)).toBe('PAUSED – press p to play')
  await w.clock.advance(5_000)
  expect(await headOf(ui)).toEqual({ x: 6, y: 4 }) // where it was when the pane closed

  await $.command.run(slash('on snake'))
  expect(await open($)).toContain('Snake opened.')
  await ui.unmount()
})

test('the snake setting off: /snake says it is off and opens nothing; a /mods on choice beats the setting', { options: { snake: false } }, async ($, on) => {
  const w = world(on)
  expect(await open($)).toContain('snake is OFF')
  expect(w.opens).toHaveLength(0)
  await $.turn.complete(turn('t1'))
  await $.turn.start({ text: 'x', turnId: 't2' })
  expect(w.logs).toEqual([])

  await $.command.run(slash('on snake'))
  expect(await open($)).toContain('Snake opened.')
  expect(w.opens).toHaveLength(1)
})

test('/mods lists Snake ON by default, with no token or sound flag; /mods off on another mod does not close the pane', async ($, on) => {
  const w = world(on)
  const list = await $.command.run(slash(''))
  expect(list.text).toMatch(/ON\s+snake\s+Snake: type \/snake to play Snake in a pane/)
  const line = (list.text ?? '').split('\n').find(l => l.includes(' snake ')) ?? ''
  expect(line).not.toContain('uses model tokens')
  expect(line).not.toContain('plays sound')
  await open($)
  await $.command.run(slash('off token-weather'))
  expect(w.closes).toEqual([])
})

// ---- surfaces and width ----

test('a session with no terminal (or one that cannot say): /snake answers in text and opens nothing', async ($, on) => {
  const w = world(on, { surfaces: ['desktop'] })
  expect(await open($)).toBe('Snake draws in a terminal pane only, and this session has no terminal. Nothing was opened.')
  w.surfaces = 'throw'
  expect(await open($)).toContain('no terminal')
  w.surfaces = ['desktop', 'terminal'] // a terminal beside a desktop: it can open
  expect(await open($)).toContain('Snake opened.')
  expect(w.opens).toHaveLength(1)
})

test('the pane on a surface that is not the terminal draws no board', async ($, on) => {
  world(on)
  await open($)
  const ui = await mountPane($, {}, 'desktop')
  expect(await ui.find({ type: 'Text', text: /Snake  score/ })).toBeUndefined()
  await ui.unmount()
})

test('a terminal narrower than the board: /snake says so and opens nothing; the pane docked narrower than the board says it too', async ($, on) => {
  const w = world(on)
  expect((await $.command.run(snakeCmd(20))).text).toBe('Snake needs a terminal at least 32 columns wide. This one is 20.')
  expect(w.opens).toHaveLength(0)
  expect((await $.command.run(snakeCmd(32))).text).toContain('Snake opened.')

  const narrow = await mountPane($, { bodyColumns: 20, placement: 'dock' })
  expect(await has(narrow, 'Snake needs a pane 32 columns wide. This one is 20. Widen the terminal.')).toBe(true)
  expect(await boardRows(narrow)).toHaveLength(0)
  await narrow.unmount()
  const exact = await mountPane($, { bodyColumns: 32 })
  expect(await boardRows(exact)).toHaveLength(8)
  await exact.unmount()
})

test('/snake closes an open pane at any width; if the engine cannot seat the pane, or refuses it, the answer says why', async ($, on) => {
  const w = world(on, { open: 'waits' })
  expect(await open($)).toBe('Snake could not be shown now: the terminal is 90 columns wide')
  w.open = 'throw'
  expect(await open($)).toMatch(/^Snake could not be opened: .*a hook refused it/)
  w.open = 'placed'
  expect(await open($)).toContain('Snake opened.')
  expect((await $.command.run(snakeCmd(10))).text).toContain('Snake closed.')
})

// ---- the Blast Radius dialog ----

const bash = (command: string) => ({ tool: 'Bash' as const, command })

test('a Blast Radius question pauses the game while it is open and resumes it when it is answered', async ($, on) => {
  const w = world(on, { holds: [3000] })
  const ui = await play($)
  await w.clock.advance(TICK)
  expect(await headOf(ui)).toEqual({ x: 6, y: 4 })

  const call = $.tool.call(bash('rm -rf build'))
  await w.clock.advance(1) // the dialog is open
  expect(w.questions).toBe(1)
  expect(await status(ui)).toBe('PAUSED – a question is open')
  await w.clock.advance(2000)
  expect(await headOf(ui)).toEqual({ x: 6, y: 4 }) // it did not move while the question was open

  await w.clock.advance(1000)
  await call
  expect(w.reached).toEqual(['rm -rf build']) // Proceed: the command ran
  expect(await status(ui)).toBe('playing')
  await w.clock.advance(TICK)
  expect(await headOf(ui)).toEqual({ x: 7, y: 4 })
  await ui.unmount()
})

test('two questions at once: the game waits for both; a game the person paused stays paused; a safe command pauses nothing', async ($, on) => {
  const w = world(on, { holds: [2000, 4000] })
  const ui = await play($)
  const first = $.tool.call(bash('rm -rf a'))
  const second = $.tool.call(bash('rm -rf b'))
  await w.clock.advance(1)
  expect(w.questions).toBe(2)
  await w.clock.advance(2500) // the first is answered, the second is not
  expect(await status(ui)).toBe('PAUSED – a question is open')
  await w.clock.advance(2000)
  await Promise.all([first, second])
  expect(await status(ui)).toBe('playing')

  await press(ui, 'toggle') // the person pauses
  w.holds.push(1000)
  const third = $.tool.call(bash('rm -rf c'))
  await w.clock.advance(1500)
  await third
  expect(await status(ui)).toBe('PAUSED – press p to play') // the question closed: it did not resume the person's pause

  await press(ui, 'toggle')
  const safe: any = await $.tool.call(bash('ls'))
  expect(safe.deny).toBeUndefined()
  expect(w.questions).toBe(3) // no question for `ls`
  expect(await status(ui)).toBe('playing')
  await ui.unmount()
})

test('a question that Claude finishing overtakes: the game stays paused for Claude; a later question pauses and resumes it again', async ($, on) => {
  const w = world(on, { holds: [3000, 1000] })
  const ui = await play($)
  const call = $.tool.call(bash('rm -rf build'))
  await w.clock.advance(1)
  expect(await status(ui)).toBe('PAUSED – a question is open')
  await $.turn.complete(turn('t1')) // the turn ends while the question is open
  expect(await status(ui)).toBe('PAUSED – Claude finished')
  await w.clock.advance(3000)
  await call
  expect(await status(ui)).toBe('PAUSED – Claude finished') // the end of the question does not resume it

  await $.turn.start({ text: 'x', turnId: 't2' })
  expect(await status(ui)).toBe('playing')
  const again = $.tool.call(bash('rm -rf build'))
  await w.clock.advance(1)
  expect(await status(ui)).toBe('PAUSED – a question is open')
  await w.clock.advance(1000)
  await again
  expect(await status(ui)).toBe('playing')
  await ui.unmount()
})

test('with Blast Radius off there is no question, so nothing pauses the game', async ($, on) => {
  const w = world(on, { holds: [3000] })
  const ui = await play($)
  await $.command.run(slash('off blast-radius'))
  const call: any = await $.tool.call(bash('rm -rf build'))
  expect(w.questions).toBe(0)
  expect(call.deny).toBeUndefined()
  expect(await status(ui)).toBe('playing')
  await ui.unmount()
})

test('a question with no game open changes nothing and does not break the dialog', async ($, on) => {
  const w = world(on, { holds: [500] })
  const call = $.tool.call(bash('rm -rf build'))
  await w.clock.advance(500)
  const result: any = await call
  expect(result.deny).toBeUndefined()
  expect(w.reached).toEqual(['rm -rf build'])
  expect(w.logs.filter(l => l.includes('snake'))).toEqual([])
})

// ---- beside the other mods ----

test('beside Token Weather, Cache Keeper and the next-steps stub: all three show in order with the pane open, and the band is identical with Snake off', async ($, on) => {
  world(on, { paneBelow: true })
  await $.turn.complete(turn('t0')) // a response, so the other rows exist
  const pane = await play($)
  const band = await mountBand($)
  // A Button's press handle is a new number at each draw: it is not part of what is compared.
  const tree = async () => JSON.stringify(await band.drawn()).replace(/"handle":\d+/g, '"handle":0')
  const withSnake = await tree()
  const [marker, weather, cache] = [withSnake.indexOf(MARKER), withSnake.indexOf('Clear'), withSnake.indexOf('cache warm')]
  expect(marker).toBeGreaterThan(-1)
  expect(weather).toBeGreaterThan(marker)
  expect(cache).toBeGreaterThan(weather)
  expect(withSnake).not.toContain('Snake') // Snake draws no row of the band
  expect(await has(pane, PANE_MARKER)).toBe(true) // and the pane beside it still draws what is beneath it

  await $.command.run(slash('off snake')) // the clock has not moved: the same moment
  expect(await tree()).toBe(withSnake)
  await band.unmount()
  await pane.unmount()
})

test('10 ticks redraw the pane and not the band: the game has its own state key', async ($, on) => {
  const w = world(on)
  await $.turn.complete(turn('t0'))
  const pane = await play($)
  const band = await mountBand($)
  const renders = w.bandRenders
  await w.clock.advance(10 * TICK)
  expect(await headOf(pane)).toEqual({ x: 15, y: 4 }) // the pane followed every tick
  expect(w.bandRenders).toBe(renders) // the band hook did not run again for any of them
  await band.unmount()
  await pane.unmount()
})

test('the band budget is not touched: at every maxRows the same rows show with Snake open as without', async ($, on) => {
  world(on)
  await $.turn.complete(turn('t0'))
  const pane = await play($)
  for (const maxRows of [5, 6, 9, 12]) {
    const band = await mountBand($, { maxRows })
    const rows = [await has(band, MARKER), await has(band, /Clear/), await has(band, /cache warm/)]
    expect([maxRows, rows]).toEqual([maxRows, [true, true, maxRows >= 6]])
    await band.unmount()
  }
  await pane.unmount()
})

test('beside Prompt Queue: the queue sends the next prompt as a turn ends, the game pauses at the end and goes on when that prompt starts its turn', async ($, on) => {
  const w = world(on)
  const ui = await play($)
  await $.turn.start({ text: 'first', turnId: 't1' })
  expect((await $.command.run(queueCmd('second'))).text).toContain('Queued 1 of 20')
  await w.clock.advance(TICK)
  expect(await headOf(ui)).toEqual({ x: 6, y: 4 })

  await $.turn.complete(turn('t1'))
  await w.clock.settle()
  expect(w.submits).toEqual(['second'])
  expect(await status(ui)).toBe('PAUSED – Claude finished') // between the two turns
  await $.turn.start({ text: 'second', turnId: 't2' })
  expect(await status(ui)).toBe('playing')
  await w.clock.advance(TICK)
  expect(await headOf(ui)).toEqual({ x: 7, y: 4 })
  await ui.unmount()
})
