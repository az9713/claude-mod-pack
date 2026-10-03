# mod-pack

A pack of small Claude Code mods in one plugin. Token Weather draws in the band above the prompt. The mods that draw share that band without overwriting each other, or other plugins. Blast Radius draws nothing: it asks a question. `/mods` turns each one on or off.

Status: version 0.1.0. Two mods exist. The tests and `claude plugin validate` pass. No person has yet watched mod-pack draw in a real terminal or seen the Blast Radius dialog. See "What is verified".

Requires Claude Code 2.1.287 or later. Mods are plugins of "function hooks", an early-access API that can change between releases.

## Mods

| Mod | Status | What it does |
| --- | --- | --- |
| Token Weather (`token-weather`) | available | One row above the prompt: a weather word for how full the context window is, the percent, tokens against the window, a 12-turn chart, and the change since the last turn. Plays thunder when the window fills into Storm or Compact soon (sound is off by default). |
| Blast Radius (`blast-radius`) | available | Before Claude runs a risky shell command (`rm -rf`, `git reset --hard`, `git push --force`, ...), it holds the command and asks Proceed or Cancel in the question dialog, with a read-only preview of what would change. No band row. No model tokens. See "Blast Radius". |
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

## Blast Radius

Blast Radius holds a risky shell command until the person answers. It is a safety net, not a permission system.

What it holds. A rule matches only at the start of one command of a chain, after `sudo`, `VAR=x`, `xargs`, `time` and `sh -c '...'` are removed.

| Kind | Held | Not held (decision) |
| --- | --- | --- |
| Recursive delete | `rm -r`, `-rf`, `-fr`, `-r -f`, `-R`, `--recursive`; `rmdir /s`, `rd /s`, `del /s`; `Remove-Item -Recurse` (and `ri`, `rm`, `del` with `-Recurse`) | `rm file`, `rm -f file`, `rmdir dir`, `del file`: one named file or an empty folder. `rm -f *` is also not held. |
| `git reset --hard` | any target | `--soft`, `--mixed`, `git reset HEAD file` |
| `git clean` | `-f`, `-d`, `-x`, `-X`, `--force` | any form with `-n` or `--dry-run` |
| `git push` | `--force`, `-f`, `--force-with-lease`, `+branch` | plain `git push`, `-u`. `--force-with-lease` is held because it still overwrites remote history. |
| Discard working changes | `git checkout -- .`, `git checkout .`, `git restore .` | `git restore --staged .` (only unstages), `git restore file` |
| `git branch -D` | yes | `git branch -d` |
| `git stash drop`, `git stash clear` | yes | `git stash`, `pop`, `list` |

A command is split on `&&`, `||`, `;`, `|`, `&`, newlines, `$(` and backticks. Each part is tested. The rules are a table in `hooks/blast-radius.ts`.

What the dialog says (text only: nobody has seen it drawn):

```
[Blast Radius]
Blast Radius holds this command: recursive delete (rm -r).

  rm -rf build dist

What would change (a best-effort, read-only check):
  build: directory, 412 entries inside
  dist: not found

Run it now?
  Proceed    Cancel    (or type a different answer)
```

Only the exact label Proceed lets the command run, unchanged. Cancel, a dismissed dialog, text typed under "Other", and no answer all deny the command. Claude then reads: the person cancelled, the command did not run, do not retry the same command unprompted.

The preview is best effort. Each git step has its own 3 second limit and an output cap, and a failed step becomes "no preview available". The dialog is shown in every case.

| Command | Preview |
| --- | --- |
| `rm`, `rmdir`, `del`, `Remove-Item` | For each plain path (up to 8): not found, file, symbolic link, or directory with an entry count over every level. The count stops at 1000 ("1000+"). A symbolic link is never entered. Globs, variables and `~` are listed as not previewed. After a `cd` in the same command, relative paths are not looked at. |
| `git reset --hard`, `git checkout -- .`, `git restore .` | `git status --porcelain` count and the first 10 paths, and `git diff --shortstat HEAD`. Untracked files are named as not touched. |
| `git clean` | `git clean -n` with the same flags: count and the first 10 paths. |
| `git push --force` | Current branch, upstream, and the commits on the remote that the branch lacks, from the last fetch. A count only for `git push -f [remote] [branch]`. |
| `git branch -D` | For up to 3 names: commits not in the current branch. |
| `git stash drop`, `clear` | The stash list. |

The previews only read. They run `git status`, `git diff`, `git clean -n`, `git rev-parse`, `git rev-list`, `git log` and `git stash list` as an argument list (no shell) in the session folder. The git options of the command itself (`-C`, `-c`) are not passed on: a `-c core.fsmonitor=...` would run code before the person said yes. Outside a git repository, or with git missing, the preview says "no preview available".

Non-interactive runs fail closed. `$.ui.ask` rejects when nobody can be asked (a `claude -p` run), and Blast Radius turns that into a denial. So a `claude -p` run denies every risky command. It never runs one unasked.

If the check itself crashes or runs out of its 10 seconds, the engine skips the hook and the command would run. Blast Radius sets a `.catch` handler for that case. The handler classifies the command again. It asks the person again, without a preview, for a risky command or when it cannot classify. It lets a command through unasked only when the command is clearly safe or the mod is off.

Switch it off: `/mods off blast-radius` (at once, no reload), or set `blastRadius` to `false` (see "Settings").

Limits:

- It is a safety net, not a permission system. It sees the text of the command. It does not catch an alias, a script that calls `rm`, a command built from variables (`rm -rf "$DIR"`, `eval "$cmd"`), other quoting tricks, or destructive commands outside the table (`find -delete`, `dd`, `mkfs`, a `>` redirect over a file, `git checkout -f`).
- Text that only mentions a command is not held (`echo "rm -rf x"`, `grep rm -rf README`). Text in quotes that holds a separator can be a false positive (`echo "a; rm -rf x"`). That is accepted.
- It is wired to the Bash and PowerShell tool calls only. It does not look at other tools (Edit, Write, MCP tools). Whether the person's own `!` shell commands pass through `tool.call` was not checked.
- The dialog comes before Claude Code's own permission prompt for the same command. In a mode that skips permission prompts, Blast Radius still asks.
- Global git options in the command give "no preview available" for the git kinds.

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
| `blastRadius` | `true` | Ask Proceed or Cancel before a risky shell command. |
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

The same rule of one hook applies to events. The engine refuses a plugin that registers the same event twice without a matcher. So `register.tsx` registers `ui.render`, `turn.start`, `turn.complete` and `session.start` once each, and calls the mods. A matched hook can be registered several times: `command.run` for `mods`, and `tool.call` for `Bash` and for `PowerShell` (Blast Radius).

## Cost, sound and safety

- A mod is code. It runs with your permissions. Read a mod before you enable it. Token Weather reads the context-window size and your token count, keeps them in session state, and draws. It makes no network call and spends no model tokens. Blast Radius runs read-only `git` commands and reads folder listings to build its preview. It makes no network call and spends no model tokens.
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
                                      # With many MCP servers connected, tsc stops on a tool.call matcher (TS2589); register.tsx has an @ts-ignore for it.
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
| `hooks/blast-radius.ts` | The Blast Radius mod: the rule table, the preview plans and text, the dialog text. Pure. |
| `types/index.d.ts` | The `$.state` contract. |
| `assets/thunder.wav`, `scripts/make-sounds.js` | The sound and the script that makes it. |

## What is verified

- Type check, unit tests and the plugin test kit pass. The kit mounts the band through the plugin on the terminal surface. It checks that another plugin's band (a stub) and the Token Weather row are both present, in that order.
- `claude plugin validate` passes for the plugin manifest, the hooks module and the marketplace manifest.
- Blast Radius: the kit runs `tool.call` through the plugin with the dialog, `process.run`, `fs.stat` and `fs.list` stubbed beneath it. It checks Proceed, Cancel, a dismissed dialog, no one to ask, another answer, a safe command, the off switch, a failing preview, and a crash in the check. The stub plays the person: no dialog was drawn.
- Not verified: how it looks in a real terminal, how the Blast Radius question looks on screen, what the real `claude -p` does with a risky command (the code fails closed, from the type declarations), the real sound output, the install from GitHub, and a run beside the real next-steps plugin.

## License

MIT. See `LICENSE`.
