// Snake, the pure part: the board, the rules of a move, the pauses, and the text of the board.
// No engine calls here and no `$`. The dispatcher (register.tsx) keeps the game in `$.state`, runs
// `step` on a timer, and calls the pause and resume functions when a turn ends or starts.
//
// Every function takes a game and returns a new one. The random numbers come from a function that
// the caller passes in (`tick`, `newGame`), so a test can make the food land where it wants. The
// game itself keeps only a number, `seed`, which is the state of a small generator (`makeRng`). The
// seed is JSON, so a game that was stored and read back goes on with the same food.

import type { ModPackSnake, ModPackSnakeCell } from '../types'

export type SnakeGame = ModPackSnake
export type Cell = ModPackSnakeCell
export type Dir = SnakeGame['dir']
// Who paused the game: the person (`p`, closing the pane, a new game that was not started yet),
// Claude finishing a turn, or a Blast Radius question that is open.
export type PauseWhy = NonNullable<SnakeGame['pause']>

// The board is 16 cells across and 8 down. One cell is 2 terminal columns wide, so it looks square:
// the board is 32 columns by 8 rows. It is small on purpose: a pane has about a third of the screen.
export const COLS = 16
export const ROWS = 8
export const CELL_WIDTH = 2
export const START_LENGTH = 3
// Turns that may wait for a tick. A third key press before the next tick is dropped: three presses in
// 150 ms are a key held down or a mistake, and a long queue would steer the snake after the person let go.
export const MAX_QUEUED_TURNS = 2

const STEP: Record<Dir, Cell> = { up: { x: 0, y: -1 }, down: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } }
const OPPOSITE: Record<Dir, Dir> = { up: 'down', down: 'up', left: 'right', right: 'left' }

// ---- Random numbers -----------------------------------------------------------------

// mulberry32: 32 bits of state, one number in [0, 1) per call. `state()` is what to keep as the seed.
export const makeRng = (seed: number) => {
  let a = Number.isFinite(seed) ? seed >>> 0 : 1
  return {
    next: (): number => {
      a = (a + 0x6d2b79f5) >>> 0
      let t = a
      t = Math.imul(t ^ (t >>> 15), t | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    },
    state: () => a,
  }
}

// ---- The board ----------------------------------------------------------------------

const key = (c: Cell) => `${c.x},${c.y}`
const same = (a: Cell, b: Cell) => a.x === b.x && a.y === b.y

// A free cell chosen with `rng`, or null when the snake fills the board.
export const placeFood = (cols: number, rows: number, body: readonly Cell[], rng: () => number): Cell | null => {
  const taken = new Set(body.map(key))
  const free: Cell[] = []
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) if (!taken.has(`${x},${y}`)) free.push({ x, y })
  if (free.length === 0) return null
  return free[Math.min(free.length - 1, Math.floor(rng() * free.length))] ?? null
}

// A new game. It is paused by the person: nothing moves until `p` (or `r`, the restart key). `best` is
// the high score so far. The board must be at least START_LENGTH + 1 cells across.
export const newGame = (seed: number, best = 0, cols = COLS, rows = ROWS): SnakeGame => {
  const x = Math.max(START_LENGTH - 1, Math.floor(cols / 3))
  const y = Math.floor(rows / 2)
  const body: Cell[] = []
  for (let i = 0; i < START_LENGTH; i++) body.push({ x: x - i, y })
  const rng = makeRng(seed)
  const food = placeFood(cols, rows, body, rng.next)
  return { cols, rows, body, dir: 'right', queue: [], food, score: 0, best, status: 'paused', pause: 'person', seed: rng.state() }
}

// ---- Steering -----------------------------------------------------------------------

// A turn to wait for the next tick. A 180 degree turn is dropped, and so is the direction the snake
// already has (or will have, when a turn is waiting): the check is made against the LAST waiting
// direction, so right, up, left in quick order is allowed, and right then left is not. A key that comes
// while the game is not running is dropped.
export const steer = (game: SnakeGame, dir: Dir): SnakeGame => {
  if (game.status !== 'running') return game
  const last = game.queue[game.queue.length - 1] ?? game.dir
  if (dir === last || dir === OPPOSITE[last]) return game
  if (game.queue.length >= MAX_QUEUED_TURNS) return game
  return { ...game, queue: [...game.queue, dir] }
}

// ---- One move -----------------------------------------------------------------------

// One tick. The snake takes the first waiting turn, or goes straight on, and moves one cell. A wall or
// its own body ends the game (`status: 'over'`, the body stays where it was). Food is eaten when the
// head lands on it: the score goes up by 1, the tail stays (the snake grows), and new food is placed
// with `rng`. When no cell is free the person has won: `status: 'over'` with `isWon`. The tail cell
// counts as free when the snake does not grow, because the tail moves away in the same tick.
export const tick = (game: SnakeGame, rng: () => number): SnakeGame => {
  if (game.status !== 'running') return game
  const dir = game.queue[0] ?? game.dir
  const queue = game.queue.slice(1)
  const head = game.body[0]
  if (!head) return { ...game, status: 'over' }
  const step = STEP[dir]
  const next = { x: head.x + step.x, y: head.y + step.y }
  const over = { ...game, dir, queue, status: 'over' as const }

  if (next.x < 0 || next.y < 0 || next.x >= game.cols || next.y >= game.rows) return over

  const ate = game.food !== null && same(next, game.food)
  const kept = ate ? game.body : game.body.slice(0, -1)
  if (kept.some(c => same(c, next))) return over

  const body = [next, ...kept]
  const score = game.score + (ate ? 1 : 0)
  const moved = { ...game, body, dir, queue, score, best: Math.max(game.best, score) }
  if (!ate) return moved

  const food = placeFood(game.cols, game.rows, body, rng)
  return food === null ? { ...moved, food, status: 'over', isWon: true } : { ...moved, food }
}

// `tick` with the generator made from the game's own seed. The new game holds the generator's new state.
export const step = (game: SnakeGame): SnakeGame => {
  const rng = makeRng(game.seed)
  return { ...tick(game, rng.next), seed: rng.state() }
}

// ---- Pause, resume, restart ---------------------------------------------------------

const running = (game: SnakeGame): SnakeGame => {
  const { pause: _pause, ...rest } = game
  return { ...rest, status: 'running' }
}

// Pause a running game for `why`. A game that is paused already keeps its reason, with one exception:
// Claude finishing a turn takes over from an open Blast Radius question, because the question can no
// longer be the reason once the turn has ended. A game that is over stays over.
export const pauseFor = (game: SnakeGame, why: PauseWhy): SnakeGame => {
  if (game.status === 'running') return { ...game, status: 'paused', pause: why }
  if (game.status === 'paused' && game.pause === 'question' && why === 'claude') return { ...game, pause: why }
  return game
}

// Resume a game, but only one that `why` paused: a game that the person paused stays paused when Claude
// starts a turn, and a game that Claude's end paused stays paused when a question closes.
export const resumeFrom = (game: SnakeGame, why: PauseWhy): SnakeGame => (game.status === 'paused' && game.pause === why ? running(game) : game)

// The pane closes, or the session ends: a game that runs or waits for Claude is paused by the person, so
// that no turn starts it again while nothing draws it. A game that is over stays over.
export const halt = (game: SnakeGame): SnakeGame => (game.status === 'over' ? game : { ...game, status: 'paused', pause: 'person' })

// The person's play and pause key: running to paused by the person, paused (for any reason) to running.
// A game that is over does nothing: `r` starts a new one.
export const toggle = (game: SnakeGame): SnakeGame => {
  if (game.status === 'running') return pauseFor(game, 'person')
  if (game.status === 'paused') return running(game)
  return game
}

// A new game on the same board size, with the high score kept and the game running at once (the person
// pressed `r` on purpose). The seed goes on from where it was, so the food is not the same.
export const restart = (game: SnakeGame): SnakeGame => running(newGame(game.seed, Math.max(game.best, game.score), game.cols, game.rows))

// The high score as it was stored: a whole number from 0 up. Anything else counts as 0.
export const parseBest = (raw: unknown): number => (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 ? raw : 0)

// ---- Text ---------------------------------------------------------------------------

// The line that says what the game is doing.
export const statusText = (game: SnakeGame): string => {
  if (game.status === 'running') return 'playing'
  if (game.status === 'over') return game.isWon ? 'YOU WIN – the board is full. Press r for a new game.' : 'GAME OVER – press r for a new game.'
  if (game.pause === 'claude') return 'PAUSED – Claude finished'
  if (game.pause === 'question') return 'PAUSED – a question is open'
  return 'PAUSED – press p to play'
}

export type CellKind = 'empty' | 'body' | 'head' | 'food'
export type Run = { kind: CellKind; text: string }

const GLYPH: Record<CellKind, string> = { empty: '· ', body: '██', head: '██', food: '● ' }

// The board as rows of runs: neighbouring cells of one kind are one run, so a row is a few `Text`
// elements and not 16. Every row is exactly cols * CELL_WIDTH characters.
export const boardRows = (game: SnakeGame): Run[][] => {
  const kinds = new Map<string, CellKind>()
  game.body.forEach((c, i) => kinds.set(key(c), i === 0 ? 'head' : 'body'))
  if (game.food) kinds.set(key(game.food), 'food')
  const rows: Run[][] = []
  for (let y = 0; y < game.rows; y++) {
    const runs: Run[] = []
    for (let x = 0; x < game.cols; x++) {
      const kind = kinds.get(`${x},${y}`) ?? 'empty'
      const last = runs[runs.length - 1]
      if (last && last.kind === kind) last.text += GLYPH[kind]
      else runs.push({ kind, text: GLYPH[kind] })
    }
    rows.push(runs)
  }
  return rows
}
