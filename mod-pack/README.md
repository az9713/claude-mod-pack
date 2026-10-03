# mod-pack

A pack of small Claude Code mods in one plugin. Token Weather and Cache Keeper draw in the band above the prompt. The mods that draw share that band without overwriting each other, or other plugins. Blast Radius draws nothing: it asks a question. `/mods` turns each one on or off.

Status: version 0.1.0. Three mods exist. The tests and `claude plugin validate` pass. No person has yet watched mod-pack draw in a real terminal, seen the Blast Radius dialog, or pressed the Cache Keeper button. See "What is verified".

Requires Claude Code 2.1.287 or later. Mods are plugins of "function hooks", an early-access API that can change between releases.

## Mods

| Mod | Status | What it does |
| --- | --- | --- |
| Token Weather (`token-weather`) | available | One row above the prompt: a weather word for how full the context window is, the percent, tokens against the window, a 12-turn chart, and the change since the last turn. Plays thunder when the window fills into Storm or Compact soon (sound is off by default). |
| Blast Radius (`blast-radius`) | available | Before Claude runs a risky shell command (`rm -rf`, `git reset --hard`, `git push --force`, ...), it holds the command and asks Proceed or Cancel in the question dialog, with a read-only preview of what would change. No band row. No model tokens. See "Blast Radius". |
| Cache Keeper (`cache-keeper`) | available | One row above the prompt: a countdown of how long the prompt cache stays warm after the last response, the context size, and a `compact` button. A toast in the last 5 minutes. No model tokens. See "Cache Keeper" and "Compatibility". |
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

## Cache Keeper

Claude Code keeps your conversation in the model's prompt cache. While the cache is warm, the next prompt re-reads the conversation at the cheap cached rate. After a pause longer than the cache lifetime, the cache is gone and the next prompt processes the whole conversation again. Cache Keeper counts down that lifetime, so you can compact, or send a prompt, before the cache goes cold. It costs no model tokens, and makes no network call.

What the row says (text only: nobody has seen it drawn):

| Time left | Row | Colour |
| --- | --- | --- |
| more than 5 minutes | `⏱ cache warm 43m left · 160k tokens [compact]` | default |
| 5 minutes or less | `⏱ cache cools in 4m · 160k tokens [compact]` | yellow |
| none | `⏱ cache cold: next prompt re-reads 160k tokens uncached [compact]` | red |
| a compaction runs | `⏱ compacting…` | yellow |

- The tokens are the context size that Claude Code reports after the response (`$.session.usage()`). When it cannot be read, the row has no tokens part, and the cold row says "the whole conversation". No price is shown: the rate depends on the model and the plan.
- "uncached" is exact. A cold cache is not billed at the "full" input price: Anthropic's API reference bills a cache write at 1.25 times (5 minute cache) or 2 times (1 hour cache) the base input price.
- The row shows after the first response, and not while a turn runs (each request of the turn refreshes the cache). It restarts at every response of the main conversation.
- The toast `Prompt cache cools in 5m. Send a prompt or compact first.` shows once per response, when the cache enters its last 5 minutes. It shows from the minute timer, so it can come up to 1 minute late. A lifetime of 5 minutes or less has no warm part, so it gets no toast.
- The `compact` button runs `/compact` (`$.session.compact()`, trigger `plugin`). It is a click. It has no hotkey. To press it with the keyboard, focus the band (ctrl+x then Tab) and press Enter on it. This keyboard path was not checked. While any compaction runs, the row says `compacting…` and the button is gone, and a second press is ignored (the shared lock, see "Compatibility"). If Claude Code refuses (it rejects while a turn runs, and a hook can veto), a toast says so and the row stays.
- After a compaction (yours, an auto-compaction, or the button) and after `/clear`, the row goes until the next response: the new, shorter history has no cache entry yet.

### The cache lifetime

Settled from the Claude Code documentation (code.claude.com/docs/en/prompt-caching, "Cache lifetime") and the API reference (platform.claude.com/docs/en/build-with-claude/prompt-caching), read on 2026-10-02:

| Where the main conversation runs | Lifetime |
| --- | --- |
| Claude subscription, within the plan's included usage | 1 hour |
| Claude subscription, after the plan usage ran out and usage credits are used | 5 minutes |
| API key, or a cloud provider (Bedrock, Google Cloud's Agent Platform, Foundry) | 5 minutes |

The person can choose it in Claude Code: the `promptCacheTtl` setting or the `CLAUDE_CODE_PROMPT_CACHE_TTL` variable (`5m` or `1h`, from Claude Code 2.1.242), and `ENABLE_PROMPT_CACHING_1H=1` or `FORCE_PROMPT_CACHING_5M=1`. Each request that reads the cache refreshes the timer. The API counts the lifetime from the start of the request that wrote or read the entry, not from the end of its response.

The declared plugin API does not say which case you are in. So the lifetime is the setting `cacheTtlMinutes`, and its default is 60, the documented lifetime on a subscription. On an API key, a cloud provider, or usage credits, set it to 5. Cache Keeper does not read `promptCacheTtl` or the variables. A value that is not a number above 0 and up to 1440 counts as 60.

Limits of the countdown:

- It starts at the end of the response. The API's lifetime starts at the start of the last request of the turn, so Cache Keeper can show more time than is left, by about the duration of that last request.
- It is a countdown of the timer, not a reading of the real cache. A model switch, a changed tool list and the other actions in Anthropic's "Actions that invalidate the cache" list make the cache cold at any time. Cache Keeper does not see them.
- A subagent has its own cache and leaves the main conversation's cache as it was. So a subagent's turn does not restart the clock. A fork that reads the main conversation's cache is not seen either.
- A turn that you interrupt, or that fails, restarts the clock only when Claude Code reported its token usage. If it did not, the earlier time stays: the safe side.
- No sound. Plugin sound plays only on macOS, and the one sound in the pack (thunder) means a full context window.

Switch it off: `/mods off cache-keeper` (at once), or set `cacheKeeper` to `false`.

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

Each mod has one on/off setting, Cache Keeper has one more (`cacheTtlMinutes`), and there is one global `sound` setting. They are the plugin's `userConfig` options in `.claude-plugin/plugin.json`.

| Option | Default | Meaning |
| --- | --- | --- |
| `tokenWeather` | `true` | Show Token Weather. |
| `cacheKeeper` | `true` | Show the Cache Keeper countdown row. |
| `cacheTtlMinutes` | `60` | The prompt cache lifetime, in minutes, for Cache Keeper. 60 is the documented lifetime on a subscription. Set 5 on an API key, a cloud provider, or usage credits. A value that is not above 0 and up to 1440 counts as 60. |
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

The same rule of one hook applies to events. The engine refuses a plugin that registers the same event twice without a matcher. So `register.tsx` registers `ui.render`, `turn.start`, `turn.complete`, `session.start`, `session.end` and `session.compact` once each, and calls the mods. A matched hook can be registered several times: `command.run` for `mods`, and `tool.call` for `Bash` and for `PowerShell` (Blast Radius).

The next mods add to these same hooks. They do not register the event again.

## Compatibility

What each mod uses, so that you can see which ones can run together. All mods listed can run together.

| Mod | Display slot | Hotkeys | Shared lock | Spend |
| --- | --- | --- | --- | --- |
| Token Weather | Band row 1 (first in `FEATURES`: the first to get a row when the budget is short) | none | not used | none |
| Cache Keeper | Band row 2 (the row budget is 1 when `maxRows` is 3 to 5, so then only Token Weather shows) | none. One Button, `compact`, by click or by focusing the band. No digit hotkey, so it never takes the digits that next-steps owns | takes it while it compacts, and ignores a press while it is held | none. No model call, no network call |
| Blast Radius | no row. The question dialog, on `tool.call` for Bash and PowerShell | none | not used | none. No model call |

The shared automation lock. Only one automatic action runs at a time: a compaction, and, in the mods that come next, an automatic model call or an automatic prompt submission. The lock is the variable `busyWith` in `hooks/register.tsx`. A compaction holds it from its start to its end. That covers the Cache Keeper button, the person's `/compact`, and the engine's auto-compaction (all seen by the `session.compact` hook). A mod that sends a prompt by itself must read the lock first and wait while it is held. The lock is plain module state: a hot reload resets it, together with the work it guards, so it cannot stay set. A compaction triggered with `precompute`, and a subagent's own compaction, do not take it.

Events that mod-pack hooks without a matcher, once each: `session.start`, `session.end`, `session.compact`, `turn.start`, `turn.complete` and `ui.render` for `AbovePrompt`. Another plugin that hooks the same event with no matcher is not affected: each plugin may do it once. The next-steps plugin (the stub in the tests) draws in the same band. mod-pack always calls `next` and keeps what is below, so both show.

No pair of mods in the pack is known to conflict. Mods that are planned and not built are not listed.

## Cost, sound and safety

- A mod is code. It runs with your permissions. Read a mod before you enable it. Token Weather reads the context-window size and your token count, keeps them in session state, and draws. It makes no network call and spends no model tokens. Cache Keeper reads the clock and your token count, keeps them in session state, and draws. Its `compact` button runs the same compaction as `/compact`, and that compaction does spend model tokens, when you press it. It makes no network call of its own. Blast Radius runs read-only `git` commands and reads folder listings to build its preview. It makes no network call and spends no model tokens.
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
  turnComplete?: (state, { e, context }, ctx) => { state?, sound?, toast? } | undefined
  turnStart?:    (state, { e }, ctx)          => { state?, sound?, toast? } | undefined
  sessionStart?: (state, { e }, ctx)          => { state?, sound?, toast? } | undefined
  sessionEnd?:   (state, { e }, ctx)          => { state?, sound?, toast? } | undefined   // exit or /clear
  compacted?:    (state, ctx)                 => { state?, sound?, toast? } | undefined   // the main conversation was compacted
  tick?:         (state, ctx)                 => { state?, sound?, toast? } | undefined   // once a minute
  band?: (state, { props, now, options, isCompacting }, el, { compact }) => RenderElement | null
                                                // one row; `el` is { Box, Text, Button, ... }; `compact` is a click handler
}
// ctx = { isSoundAllowed, now, options }   now: ms from the engine clock (NaN if unreadable); options: the plugin settings
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
| `hooks/cache-keeper.tsx`, `hooks/cache-clock.ts` | The Cache Keeper mod and its pure logic: the lifetime setting, the countdown, the words. The lock, the timer and the compaction call are in `register.tsx`. |
| `hooks/blast-radius.ts` | The Blast Radius mod: the rule table, the preview plans and text, the dialog text. Pure. |
| `types/index.d.ts` | The `$.state` contract. |
| `assets/thunder.wav`, `scripts/make-sounds.js` | The sound and the script that makes it. |

## What is verified

- Type check, unit tests and the plugin test kit pass. The kit mounts the band through the plugin on the terminal surface. It checks that another plugin's band (a stub) and the Token Weather row are both present, in that order.
- `claude plugin validate` passes for the plugin manifest, the hooks module and the marketplace manifest.
- Blast Radius: the kit runs `tool.call` through the plugin with the dialog, `process.run`, `fs.stat` and `fs.list` stubbed beneath it. It checks Proceed, Cancel, a dismissed dialog, no one to ask, another answer, a safe command, the off switch, a failing preview, and a crash in the check. The stub plays the person: no dialog was drawn.
- Cache Keeper: the kit mounts the band through the plugin on a clock that only the test moves. It checks the row text at each stage, the one toast, the restart at a new response, a subagent turn, a running turn, an interrupted turn, `/clear`, the lifetime setting (valid and invalid), the compact button (done, vetoed, rejected, two presses at once, a compaction started by someone else), the timer (one per session, stopped at `session.end`), the off switches, and the band beside Token Weather and a stub standing for next-steps. A mutation check was run: removing the clock restart, the subagent guard, or the lock guard each made the right tests fail. The kit cannot show the real cache: whether a cache is warm, the real lifetime of an account, or what the engine's `session.compact` does with a real conversation. The stub plays those.
- Not verified: how it looks in a real terminal, how the Blast Radius question looks on screen, what the real `claude -p` does with a risky command (the code fails closed, from the type declarations), the real sound output, the install from GitHub, and a run beside the real next-steps plugin.

## License

MIT. See `LICENSE`.
