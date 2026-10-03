import { test, expect } from 'claude-code/testing'

import {
  boardRows, CELL_WIDTH, COLS, halt, makeRng, MAX_QUEUED_TURNS, newGame, parseBest, pauseFor, placeFood, restart, resumeFrom, ROWS, START_LENGTH, statusText, step, steer, tick, toggle,
} from './snake-game'
import type { Cell, SnakeGame } from './snake-game'

// A small board by hand: 6 across, 4 down, a snake of 3 in row 1 heading right, food at the far corner.
const game = (over: Partial<SnakeGame> = {}): SnakeGame => ({
  cols: 6,
  rows: 4,
  body: [{ x: 2, y: 1 }, { x: 1, y: 1 }, { x: 0, y: 1 }],
  dir: 'right',
  queue: [],
  food: { x: 5, y: 3 },
  score: 0,
  best: 0,
  status: 'running',
  seed: 7,
  ...over,
})

const first = () => 0 // the generator that always gives the first free cell
const last = () => 0.999999 // and the last one
const heads = (g: SnakeGame) => g.body[0]

// ---- the generator ----

test('makeRng: the same seed gives the same numbers, all in [0, 1); the state continues the sequence', () => {
  const a = makeRng(123)
  const b = makeRng(123)
  const seq = [a.next(), a.next(), a.next()]
  expect(seq).toEqual([b.next(), b.next(), b.next()])
  for (const n of seq) {
    expect(n).toBeGreaterThanOrEqual(0)
    expect(n).toBeLessThan(1)
  }
  expect(new Set(seq).size).toBe(3)

  // A generator started from the state of another goes on where it stopped: that is how a stored game goes on.
  const c = makeRng(123)
  c.next()
  const resumed = makeRng(c.state())
  expect(resumed.next()).toBe(seq[1])
})

test('makeRng: a seed that is not a finite number counts as 1', () => {
  expect(makeRng(NaN).next()).toBe(makeRng(1).next())
  expect(makeRng(Infinity).next()).toBe(makeRng(1).next())
})

// ---- food ----

test('placeFood: chooses among the free cells in row order, never on the snake', () => {
  const body: Cell[] = [{ x: 0, y: 0 }, { x: 1, y: 0 }]
  expect(placeFood(3, 2, body, first)).toEqual({ x: 2, y: 0 }) // (0,0) and (1,0) are taken: the first free is (2,0)
  expect(placeFood(3, 2, body, last)).toEqual({ x: 2, y: 1 })
  expect(placeFood(3, 2, body, () => 1)).toEqual({ x: 2, y: 1 }) // a generator that gives 1 is held inside the board
  for (let i = 0; i < 200; i++) {
    const food = placeFood(3, 2, body, makeRng(i).next)
    expect(food).not.toBeNull()
    expect(body.some(c => c.x === food!.x && c.y === food!.y)).toBe(false)
  }
})

test('placeFood: no free cell gives null', () => {
  const body: Cell[] = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }]
  expect(placeFood(2, 2, body, first)).toBeNull()
})

// ---- a new game ----

test('newGame: a 16 by 8 board, a snake of 3 heading right, food off the snake, paused by the person, score 0', () => {
  const g = newGame(42, 9)
  expect([g.cols, g.rows]).toEqual([COLS, ROWS])
  expect(g.body).toHaveLength(START_LENGTH)
  expect(g.body.map(c => c.y)).toEqual([4, 4, 4])
  expect(g.body[0]!.x - g.body[1]!.x).toBe(1) // head first, the body to its left
  expect(g.dir).toBe('right')
  expect(g.queue).toEqual([])
  expect(g.score).toBe(0)
  expect(g.best).toBe(9)
  expect(g.status).toBe('paused')
  expect(g.pause).toBe('person')
  expect(g.food).not.toBeNull()
  expect(g.body.some(c => c.x === g.food!.x && c.y === g.food!.y)).toBe(false)
  // The seed has moved on: the same food is not drawn again at a restart.
  expect(g.seed).not.toBe(42)
})

test('newGame: the same seed gives the same game; the first move to the right is free', () => {
  expect(newGame(5)).toEqual(newGame(5))
  expect(newGame(5)).not.toEqual(newGame(6))
  const g = { ...newGame(5), status: 'running' as const, pause: undefined }
  const next = tick(g, first)
  expect(next.status).toBe('running') // there is room to the right of the head
})

test('newGame: a small board still fits the snake, and the game is JSON (a stored game comes back the same)', () => {
  const g = newGame(1, 0, 5, 3)
  expect(g.body).toEqual([{ x: 2, y: 1 }, { x: 1, y: 1 }, { x: 0, y: 1 }])
  expect(JSON.parse(JSON.stringify(g))).toEqual(g)
})

// ---- steering ----

test('steer: a turn waits for the next tick', () => {
  const g = steer(game(), 'up')
  expect(g.queue).toEqual(['up'])
  expect(g.dir).toBe('right') // the snake has not turned yet
})

test('steer: a 180 degree turn is dropped, and so is the direction it already has', () => {
  expect(steer(game(), 'left').queue).toEqual([])
  expect(steer(game(), 'right').queue).toEqual([])
  expect(steer(game({ dir: 'up' }), 'down').queue).toEqual([])
  expect(steer(game({ dir: 'down' }), 'up').queue).toEqual([])
  expect(steer(game({ dir: 'left' }), 'right').queue).toEqual([])
})

test('steer: the check is made against the last waiting turn, so right then up then left is allowed and right then up then down is not', () => {
  const up = steer(game(), 'up')
  expect(steer(up, 'left').queue).toEqual(['up', 'left'])
  expect(steer(up, 'down').queue).toEqual(['up']) // down is the opposite of the waiting up
  expect(steer(up, 'up').queue).toEqual(['up']) // the same twice is one turn
})

test('steer: at most 2 turns wait; a third key before the next tick is dropped', () => {
  expect(MAX_QUEUED_TURNS).toBe(2)
  const two = steer(steer(game(), 'up'), 'left')
  expect(two.queue).toEqual(['up', 'left'])
  expect(steer(two, 'down').queue).toEqual(['up', 'left'])
})

test('steer: a game that is paused or over takes no key', () => {
  expect(steer(game({ status: 'paused', pause: 'claude' }), 'up').queue).toEqual([])
  expect(steer(game({ status: 'paused', pause: 'person' }), 'up').queue).toEqual([])
  expect(steer(game({ status: 'over' }), 'up').queue).toEqual([])
})

test('a quick right, up, left, down in order never reverses on itself: each tick turns 90 degrees at most', () => {
  let g = game({ cols: 10, rows: 10, body: [{ x: 5, y: 5 }, { x: 4, y: 5 }, { x: 3, y: 5 }], food: null })
  g = steer(steer(g, 'up'), 'left')
  g = tick(g, first)
  expect(g.dir).toBe('up')
  g = steer(g, 'down') // the next waiting turn is left, so down is allowed (it is not opposite to left)
  g = tick(g, first)
  expect(g.dir).toBe('left')
  g = tick(g, first)
  expect(g.dir).toBe('down')
  expect(g.status).toBe('running')
})

// ---- a move ----

test('tick: the snake moves one cell, the tail follows, the length stays', () => {
  const g = tick(game(), first)
  expect(g.body).toEqual([{ x: 3, y: 1 }, { x: 2, y: 1 }, { x: 1, y: 1 }])
  expect(g.status).toBe('running')
  expect(g.score).toBe(0)
})

test('tick: a waiting turn is taken, one at a time', () => {
  let g = steer(steer(game(), 'up'), 'left')
  g = tick(g, first)
  expect(heads(g)).toEqual({ x: 2, y: 0 })
  expect(g.dir).toBe('up')
  expect(g.queue).toEqual(['left'])
  g = tick(g, first)
  expect(heads(g)).toEqual({ x: 1, y: 0 })
  expect(g.dir).toBe('left')
  expect(g.queue).toEqual([])
})

test('tick: a game that is not running does not move', () => {
  const paused = game({ status: 'paused', pause: 'claude' })
  expect(tick(paused, first)).toBe(paused)
  const over = game({ status: 'over' })
  expect(tick(over, first)).toBe(over)
})

test('tick: each wall ends the game, and the body stays where it was', () => {
  const cases: [Partial<SnakeGame>, string][] = [
    [{ body: [{ x: 5, y: 1 }, { x: 4, y: 1 }, { x: 3, y: 1 }], dir: 'right' }, 'right wall'],
    [{ body: [{ x: 0, y: 1 }, { x: 1, y: 1 }, { x: 2, y: 1 }], dir: 'left' }, 'left wall'],
    [{ body: [{ x: 2, y: 0 }, { x: 2, y: 1 }, { x: 2, y: 2 }], dir: 'up' }, 'top wall'],
    [{ body: [{ x: 2, y: 3 }, { x: 2, y: 2 }, { x: 2, y: 1 }], dir: 'down' }, 'bottom wall'],
  ]
  for (const [over, name] of cases) {
    const before = game(over)
    const after = tick(before, first)
    expect([name, after.status]).toEqual([name, 'over'])
    expect([name, after.body]).toEqual([name, before.body])
    expect(after.isWon).toBeUndefined()
  }
})

test('tick: the snake running into itself ends the game', () => {
  // A hook shape: the head at (2,1) turns left into (1,1), which is body, not the tail.
  const g = game({ body: [{ x: 2, y: 1 }, { x: 2, y: 2 }, { x: 1, y: 2 }, { x: 1, y: 1 }, { x: 1, y: 0 }], dir: 'left' })
  const after = tick(g, first)
  expect(after.status).toBe('over')
  expect(after.body).toEqual(g.body)
})

test('tick: the tail cell is free in the same tick, so a snake may follow its own tail', () => {
  // A 2 by 2 board, the snake fills it, the head turns into the cell the tail leaves.
  const g = game({ cols: 2, rows: 2, body: [{ x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }, { x: 0, y: 0 }], dir: 'left', food: null })
  const after = tick(g, first)
  expect(after.status).toBe('running')
  expect(after.body).toEqual([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }])
})

test('tick: eating grows the snake by one, scores 1, raises the best, and puts new food on a free cell', () => {
  const g = game({ food: { x: 3, y: 1 }, best: 0 })
  const after = tick(g, first)
  expect(after.body).toEqual([{ x: 3, y: 1 }, { x: 2, y: 1 }, { x: 1, y: 1 }, { x: 0, y: 1 }]) // the tail stayed
  expect(after.score).toBe(1)
  expect(after.best).toBe(1)
  expect(after.food).toEqual({ x: 0, y: 0 }) // the first free cell, for the generator that gives 0
  expect(after.status).toBe('running')
  expect(tick(g, last).food).toEqual({ x: 5, y: 3 }) // and the last one, for the other
})

test('tick: the best is never lowered by a lower score', () => {
  const after = tick(game({ food: { x: 3, y: 1 }, best: 40 }), first)
  expect(after.score).toBe(1)
  expect(after.best).toBe(40)
})

test('tick: food is placed only on a cell the new body does not hold', () => {
  for (let seed = 0; seed < 100; seed++) {
    const g = game({ food: { x: 3, y: 1 } })
    const after = tick(g, makeRng(seed).next)
    expect(after.body.some(c => c.x === after.food!.x && c.y === after.food!.y)).toBe(false)
  }
})

test('tick: filling the board wins: over, with isWon, the score counted, and no food', () => {
  // A 2 by 2 board. The snake of 3 eats the last cell.
  const g = game({ cols: 2, rows: 2, body: [{ x: 1, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 1 }], dir: 'down', food: { x: 1, y: 1 } })
  const after = tick(g, first)
  expect(after.body).toHaveLength(4)
  expect(after.status).toBe('over')
  expect(after.isWon).toBe(true)
  expect(after.food).toBeNull()
  expect(after.score).toBe(1)
})

// ---- step: the tick with the game's own seed ----

test('step: the same game gives the same next game; a game that eats gets its food from its seed, and the seed moves on', () => {
  const g = game({ food: { x: 3, y: 1 }, seed: 99 })
  expect(step(g)).toEqual(step(g))
  const rng = makeRng(99)
  expect(step(g).food).toEqual(tick(g, rng.next).food)
  expect(step(g).seed).toBe(rng.state())
  expect(step(g).seed).not.toBe(99)
  // A move that eats nothing draws no number: the seed stays.
  expect(step(game({ seed: 99 })).seed).toBe(99)
})

test('step: a whole game from a seed is reproducible', () => {
  const play = () => {
    let g: SnakeGame = { ...newGame(2024), status: 'running', pause: undefined }
    const keys = ['up', 'left', 'down', 'right', 'up'] as const
    for (let i = 0; i < 12; i++) {
      if (i % 2 === 0) g = steer(g, keys[(i / 2) % keys.length]!)
      g = step(g)
    }
    return g
  }
  expect(play()).toEqual(play())
})

// ---- pause, resume, restart ----

test('pauseFor: a running game pauses for the reason; a game already paused keeps its reason; a game that is over stays over', () => {
  expect(pauseFor(game(), 'claude')).toMatchObject({ status: 'paused', pause: 'claude' })
  const byPerson = game({ status: 'paused', pause: 'person' })
  expect(pauseFor(byPerson, 'claude')).toBe(byPerson)
  const over = game({ status: 'over' })
  expect(pauseFor(over, 'claude')).toBe(over)
})

test('pauseFor: Claude finishing takes over from an open question, and nothing else takes over', () => {
  const asking = game({ status: 'paused', pause: 'question' })
  expect(pauseFor(asking, 'claude').pause).toBe('claude')
  expect(pauseFor(asking, 'person')).toBe(asking)
  expect(pauseFor(asking, 'question')).toBe(asking)
})

test('resumeFrom: only the reason that paused the game resumes it', () => {
  const byClaude = pauseFor(game(), 'claude')
  expect(resumeFrom(byClaude, 'claude')).toEqual(game()) // back to a running game, with no pause field
  expect(resumeFrom(byClaude, 'question')).toBe(byClaude)
  expect(resumeFrom(byClaude, 'person')).toBe(byClaude)
  const byPerson = game({ status: 'paused', pause: 'person' })
  expect(resumeFrom(byPerson, 'claude')).toBe(byPerson) // the person paused it: a new turn leaves it
  const running = game()
  expect(resumeFrom(running, 'claude')).toBe(running)
  const over = game({ status: 'over' })
  expect(resumeFrom(over, 'claude')).toBe(over)
})

test('toggle: running pauses by the person, paused plays (whatever paused it), over does nothing', () => {
  expect(toggle(game())).toMatchObject({ status: 'paused', pause: 'person' })
  expect(toggle(game({ status: 'paused', pause: 'person' }))).toEqual(game())
  expect(toggle(game({ status: 'paused', pause: 'claude' }))).toEqual(game())
  expect(toggle(game({ status: 'paused', pause: 'question' }))).toEqual(game())
  const over = game({ status: 'over' })
  expect(toggle(over)).toBe(over)
})

test('halt: a running or waiting game is paused by the person, so that no later turn starts it; over stays over', () => {
  expect(halt(game())).toMatchObject({ status: 'paused', pause: 'person' })
  expect(halt(game({ status: 'paused', pause: 'claude' }))).toMatchObject({ status: 'paused', pause: 'person' })
  expect(resumeFrom(halt(game({ status: 'paused', pause: 'claude' })), 'claude').status).toBe('paused')
  const over = game({ status: 'over' })
  expect(halt(over)).toBe(over)
})

test('restart: a new game that runs at once, the board size kept, the best kept and raised by the last score, a new food', () => {
  const over = game({ status: 'over', score: 7, best: 5, seed: 11 })
  const again = restart(over)
  expect(again.status).toBe('running')
  expect(again.pause).toBeUndefined()
  expect(again.score).toBe(0)
  expect(again.best).toBe(7)
  expect([again.cols, again.rows]).toEqual([6, 4])
  expect(again.body).toHaveLength(START_LENGTH)
  expect(again.queue).toEqual([])
  expect(again.isWon).toBeUndefined()
  expect(restart(game({ best: 30, score: 2 })).best).toBe(30)
  expect(again.seed).not.toBe(11)
})

// ---- the high score as stored ----

test('parseBest: a whole number from 0 up; anything else is 0', () => {
  expect(parseBest(12)).toBe(12)
  expect(parseBest(0)).toBe(0)
  for (const bad of [-1, 1.5, NaN, Infinity, '12', null, undefined, {}, [], true]) expect([bad, parseBest(bad)]).toEqual([bad, 0])
})

// ---- text and the board ----

test('statusText: each state says what the game is doing', () => {
  expect(statusText(game())).toBe('playing')
  expect(statusText(game({ status: 'paused', pause: 'claude' }))).toBe('PAUSED – Claude finished')
  expect(statusText(game({ status: 'paused', pause: 'person' }))).toBe('PAUSED – press p to play')
  expect(statusText(game({ status: 'paused', pause: 'question' }))).toBe('PAUSED – a question is open')
  expect(statusText(game({ status: 'paused' }))).toBe('PAUSED – press p to play')
  expect(statusText(game({ status: 'over' }))).toBe('GAME OVER – press r for a new game.')
  expect(statusText(game({ status: 'over', isWon: true }))).toBe('YOU WIN – the board is full. Press r for a new game.')
})

test('boardRows: every row is the width of the board, head, body, food and empty cells are told apart, neighbours of one kind are one run', () => {
  const rows = boardRows(game())
  expect(rows).toHaveLength(4)
  for (const row of rows) expect(row.map(r => r.text).join('')).toHaveLength(6 * CELL_WIDTH)

  // Row 1: body, body, head, then 3 empty cells: three runs.
  expect(rows[1]).toEqual([{ kind: 'body', text: '████' }, { kind: 'head', text: '██' }, { kind: 'empty', text: '· · · ' }])
  expect(rows[0]).toEqual([{ kind: 'empty', text: '· · · · · · ' }])
  expect(rows[3]).toEqual([{ kind: 'empty', text: '· · · · · ' }, { kind: 'food', text: '● ' }])
})

test('boardRows: a game with no food draws none', () => {
  const kinds = boardRows(game({ food: null })).flat().map(r => r.kind)
  expect(kinds).not.toContain('food')
})
