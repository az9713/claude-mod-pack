# mod-pack

A pack of small Claude Code mods in one plugin. The mods draw in the band above the prompt. They share that band without overwriting each other, or other plugins. `/mods` turns each one on or off.

Status: version 0.1.0. One mod exists. The tests and `claude plugin validate` pass. No person has yet watched mod-pack draw in a real terminal. See "What is verified".

Requires Claude Code 2.1.287 or later. Mods are plugins of "function hooks", an early-access API that can change between releases.

## Mods

| Mod | Status | What it does |
| --- | --- | --- |
| Token Weather (`token-weather`) | available | One row above the prompt: a weather word for how full the context window is, the percent, tokens against the window, a 12-turn chart, and the change since the last turn. Plays thunder when the window fills into Storm or Compact soon (sound is off by default). |
| Blast Radius | planned, not built | |
| Cache Keeper | planned, not built | |
| Wait What | planned, not built | |
| Prompt Queue | planned, not built | |
| Snake | planned, not built | |

Token Weather bands:

| Percent of window | Icon and word | Colour |
| --- | --- | --- |
| under 25 | ☀ Clear | yellow |
| 25 to 49 | ☁ Cloudy | cyan |
| 50 to 74 | ☂ Showers | blue |
| 75 to 89 | ☇ Storm | magenta |
| 90 and over | ↯ Compact soon | red |

The window size is read from Claude Code (`context.window`). It is not fixed in the code.

## Install

From GitHub (the repo has a `.claude-plugin/marketplace.json`):

```
claude plugin marketplace add az9713/mod-pack
claude plugin install mod-pack@mod-pack
```

This route is untested until the repo is pushed. `az9713/mod-pack` is a placeholder for the real GitHub path.

From a local folder, for one session:

```
claude --plugin-dir /path/to/mod-pack
```

The first time Claude Code loads the plugin from a folder, it writes the type files in `.claude-plugin/types/`. They are git-ignored.

## The `/mods` command

| Command | Effect |
| --- | --- |
| `/mods` or `/mods list` | List every mod: ON or OFF, one line about it, and flags (`uses model tokens`, `plays sound`). Shows the sound switch. |
| `/mods on <id>` | Turn a mod on. |
| `/mods off <id>` | Turn a mod off. |
| `/mods toggle <id>` | Flip a mod. |
| `/mods sound on` or `/mods sound off` | The global sound switch. |
| `/mods reset` | Drop every choice made with `/mods`. The settings apply again. |
| `/mods help` | Show the usage. |

An unknown id gives an error that lists the known ids. A change applies at once, with no reload.

## Settings: on and off

Each mod has one setting, and there is one global `sound` setting. They are the plugin's `userConfig` options in `.claude-plugin/plugin.json`.

| Option | Default | Meaning |
| --- | --- | --- |
| `tokenWeather` | `true` | Show Token Weather. |
| `sound` | `false` | Let mods that can play a sound play it. |

Sound is off by default. This is a polite default for a public pack.

The state of a mod is the first of these that is set:

1. A choice made with `/mods` (kept in the plugin store, key `mod-pack/overrides`, across sessions).
2. The setting.
3. The default of the mod.

So a `/mods` choice beats the setting, and stays until `/mods reset`. A sound plays only if the global `sound` is ON, the mod is ON, and the mod can play sound.

Claude Code plays plugin sound only where it has a player. In the 2.1.287 type declarations this is `afplay` on macOS. On Linux and Windows terminals the call plays nothing. Token Weather's thunder is therefore silent there.

## How mods share the band

All mods in the pack draw through one compositor. It is the only `ui.render` hook for `AbovePrompt`. These rules keep the pack, and the plugins beside it, from overwriting each other.

1. **Always call `next`.** The compositor does `const below = await next(e)` and returns a column with `{below}` on top. A hook that does not call `next` hides every other plugin's band. This was the cause of the Token Weather and next-steps clash.
2. **The pack goes below the others.** The pack adds its rows under `{below}`. It never reorders or removes what is below.
3. **Rows, not trees.** A mod returns one row. The compositor clips it to one terminal row (`height={1}`, `overflow="hidden"`) and counts it as one row.
4. **A row budget.** `maxRows` is what the whole band may take, for all plugins together. The pack cannot measure what other plugins drew. So it takes at most one third of `maxRows`, never more than 4 rows, and none when `maxRows` is under 3. Mods fill the budget in the order of the `FEATURES` list. The first mod has the priority.
5. **Terminal only.** On a surface that is not `terminal`, or while a survey holds the band (`hasSurvey`), the compositor returns `below` unchanged.
6. **No digit hotkeys.** Never put `hotkey="1"` (or any digit) on a Button in a mod. A digit hotkey also fires when the person types that digit into an empty prompt. next-steps already owns 0, 1, 2 and 3. Use a letter hotkey, or a click, or no hotkey.

The same rule of one hook applies to events. The engine refuses a plugin that registers the same event twice without a matcher. So `register.tsx` registers `ui.render`, `turn.start`, `turn.complete` and `session.start` once each, and calls the mods. A matched hook (`command.run` for `mods`) can be registered several times.

## Cost, sound and safety

- A mod is code. It runs with your permissions. Read a mod before you enable it. Token Weather reads the context-window size and your token count, keeps them in session state, and draws. It makes no network call and spends no model tokens.
- Spend rule for mods that call a model (none yet). A mod must set `usesModel: true`, so `/mods` shows it. It must use the cheapest model by default (for example the `haiku` alias). It must make at most 30 model calls an hour. There is no helper for this yet. The first mod that calls a model adds one.
- Sound is off by default. See "Settings".
- Mod errors are caught one by one and written to the UI log. One failing mod does not stop the others.

## Add a mod

A mod is a `Feature` object (`hooks/feature.ts`). It is made of pure functions. It receives plain data and returns plain data. It never receives `$`.

The reason: `claude plugin validate` refuses code that passes `$` to an imported function or to a method of an object ("$ itself is passed as an argument"). So every `$` call is written in `hooks/register.tsx`. The dispatcher reads the engine, gives the mod the data, and applies what the mod returns.

```ts
type Feature<S> = {
  id: string            // kebab-case, used by /mods. The setting key is its camelCase.
  title: string
  about: string         // one line for /mods
  usesModel?: boolean   // shown in /mods
  hasSound?: boolean    // shown in /mods
  defaultOn: boolean
  turnComplete?: (state, { e, context }, ctx) => { state?, sound? } | undefined
  turnStart?:    (state, { e }, ctx)          => { state?, sound? } | undefined
  sessionStart?: (state, { e }, ctx)          => { state?, sound? } | undefined
  band?: (state, e, el) => RenderElement | null   // one row; `el` is { Box, Text, Button, ... }
}
```

Steps:

1. Write `hooks/<name>.tsx` with `defineFeature<State>({ ... })`.
2. In `hooks/register.tsx`, import it and add it to `FEATURES`. The order is the row order and the priority.
3. In `.claude-plugin/plugin.json`, add a boolean to `userConfig`. The key is the camelCase of the id.
4. In `types/index.d.ts`, add the state type to `ModPackFeatureStates`.
5. Add tests. Run `claude plugin test` and `claude plugin validate`.

`state` is kept in `$.state` under the id of the mod, so it survives a hot reload. `sound` is a file of the plugin (`assets/x.wav`). The dispatcher plays it only when `ctx.isSoundAllowed` is true.

## Development

```
tsc -p .                              # type check (strict, noUncheckedIndexedAccess)
claude plugin test .                  # all *.test.ts and *.test.tsx
claude plugin validate .              # with a marketplace.json present, this checks the marketplace manifest
claude plugin validate .claude-plugin/plugin.json   # the plugin manifest and the hooks module
node scripts/make-sounds.js           # regenerate assets/thunder.wav
```

`tsc -p .` needs `.claude-plugin/types/`, which Claude Code writes when it loads the plugin from a folder.

Files:

| Path | Purpose |
| --- | --- |
| `hooks/register.tsx` | The dispatcher and the compositor. The only file with `$` calls. |
| `hooks/feature.ts` | The `Feature` contract. |
| `hooks/settings.ts` | Pure: on/off resolution, sound gate, row budget. |
| `hooks/mods-command.ts` | Pure: the `/mods` parser. |
| `hooks/token-weather.tsx`, `hooks/forecast.ts` | The Token Weather mod and its pure logic. |
| `types/index.d.ts` | The `$.state` contract. |
| `assets/thunder.wav`, `scripts/make-sounds.js` | The sound and the script that makes it. |

## What is verified

- Type check, unit tests and the plugin test kit pass. The kit mounts the band through the plugin on the terminal surface. It checks that another plugin's band (a stub) and the Token Weather row are both present, in that order.
- `claude plugin validate` passes for the plugin manifest, the hooks module and the marketplace manifest.
- Not verified: how it looks in a real terminal, the real sound output, the install from GitHub, and a run beside the real next-steps plugin.

## License

MIT. See `LICENSE`.
