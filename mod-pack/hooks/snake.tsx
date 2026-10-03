// Snake: a small Snake game in a pane. It pauses when Claude finishes a turn and goes on when the
// next turn starts, so it fills the time that you wait. `/snake` opens the pane, and `/snake` again
// (or Esc, while the pane has the keyboard) closes it. It costs no model tokens and makes no call.
//
// Pure: no `$` here. This file holds the Feature entry and the drawing of the pane. The rules are in
// hooks/snake-game.ts. The pane, the timer, the pause on `turn.complete` and the commands are in
// register.tsx. Snake draws a Pane, not a row of the band: it has no `band` function, so the
// compositor never sees it and it takes no row of the budget.
//
// Keys: w, a, s, d turn the snake, p plays and pauses, r starts a new game. They are the `hotkey` of
// Buttons in the pane, and a Button's hotkey works only while the pane holds the keyboard (the
// declared API: ctrl+x then Tab, or a click on the pane, or `focus` when it opens). The arrow keys
// and Tab belong to the engine. A `Client` module could read the arrows once a click has focused it,
// but it runs in a separate drawing thread with no `$`, so the game and its pause on `turn.complete`
// would be split across two places. The Buttons keep the whole game in one place. No key is a digit:
// a digit hotkey also fires when the person types that digit into an empty prompt, and next-steps owns 0 to 3.

import type { RenderElement } from 'claude-code'

import { defineFeature } from './feature'
import type { Terminal } from './feature'
import { boardRows, CELL_WIDTH, COLS, ROWS, statusText } from './snake-game'
import type { CellKind, Dir, SnakeGame } from './snake-game'

// The Feature entry. It has no callbacks: the dispatcher reads its id, text and default, for `/mods`
// and for the on/off check. It makes no model call, so it costs no tokens.
export const snake = defineFeature<never>({
  id: 'snake',
  title: 'Snake',
  about: 'type /snake to play Snake in a pane; it pauses when Claude finishes and goes on when you send the next prompt; keys w a s d p r work while the pane has the keyboard; costs no model tokens',
  usesModel: false,
  defaultOn: true,
})

// The narrowest pane that shows the whole board.
export const MIN_COLUMNS = COLS * CELL_WIDTH

// Rows of the body: the title line, the status line, the board, 2 lines of keys, 1 line of hint.
export const PANE_ROWS = ROWS + 5

export type SnakeActions = {
  steer: (dir: Dir) => void
  toggle: () => void
  restart: () => void
}

type Look = { color?: string; dimColor?: boolean; bold?: boolean }
const LOOK: Record<CellKind, Look> = {
  empty: { dimColor: true },
  body: { color: 'green' },
  head: { color: 'yellow', bold: true },
  food: { color: 'red' },
}

// What the pane shows for a game. `props` are the Pane's: how wide the body is, and whether the pane
// holds the keyboard now. Each function is pure: a Button's handler is one of `actions`, which the
// dispatcher made.
export function snakeView(game: SnakeGame, props: { bodyColumns: number; isFocused: boolean }, el: Terminal, actions: SnakeActions): RenderElement {
  const { Box, Button, Text } = el

  if (props.bodyColumns < MIN_COLUMNS) {
    return <Text color="yellow">{`Snake needs a pane ${MIN_COLUMNS} columns wide. This one is ${props.bodyColumns}. Widen the terminal.`}</Text>
  }

  const state = statusText(game)
  const stateColor = game.status === 'running' ? undefined : game.status === 'over' ? 'red' : 'yellow'

  return (
    <Box flexDirection="column">
      <Text bold>{`Snake  score ${game.score}  best ${game.best}`}</Text>
      {stateColor ? <Text color={stateColor} bold>{state}</Text> : <Text dimColor>{state}</Text>}
      {boardRows(game).map((runs, y) => (
        <Box key={`row-${y}`} height={1}>
          {runs.map((run, i) => (
            <Text key={`run-${i}`} {...LOOK[run.kind]}>{run.text}</Text>
          ))}
        </Box>
      ))}
      <Box gap={1}>
        <Button key="up" label="up" hotkey="w" plain onPress={() => actions.steer('up')} />
        <Button key="left" label="left" hotkey="a" plain onPress={() => actions.steer('left')} />
        <Button key="down" label="down" hotkey="s" plain onPress={() => actions.steer('down')} />
        <Button key="right" label="right" hotkey="d" plain onPress={() => actions.steer('right')} />
      </Box>
      <Box gap={1}>
        <Button key="toggle" label={game.status === 'running' ? 'pause' : 'play'} hotkey="p" plain onPress={actions.toggle} />
        <Button key="restart" label="restart" hotkey="r" plain onPress={actions.restart} />
      </Box>
      {props.isFocused ? <Text dimColor>Esc closes the pane.</Text> : <Text dimColor>Keys need the pane focused: click it, or ctrl+x then Tab.</Text>}
    </Box>
  )
}
