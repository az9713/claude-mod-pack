# mod-pack

A pack of small Claude Code mods in one plugin. Token Weather, Cache Keeper, Prompt Queue and Wait What draw in the band above the prompt. The mods that draw there share that band without overwriting each other, or other plugins. Blast Radius draws nothing: it asks a question. Snake draws a pane of its own, not a band row. `/mods` turns each one on or off. Wait What is the one mod that spends model tokens, and it is off by default. Prompt Queue is the one mod that sends prompts by itself: read its security note.

Status: version 0.1.0. Six mods exist. The tests and `claude plugin validate` pass. No person has yet watched mod-pack draw in a real terminal, seen the Blast Radius dialog, pressed the Cache Keeper button, read a Wait What retell, typed `/q` while a turn ran, or played Snake. See "What is verified".

Requires Claude Code 2.1.287 or later. Mods are plugins of "function hooks", an early-access API that can change between releases.

## Mods

| Mod | Status | What it does |
| --- | --- | --- |
| Token Weather (`token-weather`) | available | One row above the prompt: a weather word for how full the context window is, the percent, tokens against the window, a 12-turn chart, and the change since the last turn. Plays thunder when the window fills into Storm or Compact soon (sound is off by default). |
| Blast Radius (`blast-radius`) | available | Before Claude runs a risky shell command (`rm -rf`, `git reset --hard`, `git push --force`, ...), it holds the command and asks Proceed or Cancel in the question dialog, with a read-only preview of what would change. No band row. No model tokens. See "Blast Radius". |
| Cache Keeper (`cache-keeper`) | available | One row above the prompt: a countdown of how long the prompt cache stays warm after the last response, the context size, and a `compact` button. A toast in the last 5 minutes. No model tokens. See "Cache Keeper" and "Compatibility". |
| Prompt Queue (`prompt-queue`) | available | Type `/q <text>` while Claude works to stack follow-up prompts. They are sent one at a time, each when the turn before it ends. One row above the prompt shows what waits. **Sends prompts by itself, with your permissions**: see "Prompt Queue". No model tokens of its own. See also "Compatibility". |
| Wait What (`wait-what`) | available, OFF by default | After a long answer, a retell in plain words (at most 2 short lines) in the band above the prompt. **Spends model tokens**: each retold answer is one call to the cheapest model, on your own plan. At most 30 calls an hour. See "Wait What" and "Compatibility". |
| Snake (`snake`) | available | Type `/snake` to play a small Snake game in a pane. It pauses when Claude finishes (`PAUSED – Claude finished`) and goes on when you send the next prompt. Keys `w` `a` `s` `d` `p` `r`, which work only while the pane has the keyboard. Terminal only. No band row. No model tokens. See "Snake" and "Compatibility". |

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

## Wait What

**Wait What spends model tokens, and it is OFF by default.** After a long answer it sends the answer's text to a model and shows the reply, a retell in plain words, in the band above the prompt. The retell is not in the transcript and not in the model's context.

What it costs and what it sends:

- Each retold answer is one call to the model alias `haiku` (the cheapest: no dated model id is written in the code), made through your own Claude Code session on your own plan.
- What goes out: a fixed instruction of about 50 words, and the answer's text. Longer than 4,000 characters, the answer is cut to its start and its end (about 40% and 60%) with a marker between them. At four characters to a token, 4,000 characters are about 1,000 tokens. This is an estimate: no call was measured.
- What comes back: a reply capped at 120 tokens (`maxTokens`). That is about one short reply for each answer. The call is cut after 15 seconds and then shows nothing.
- No history is sent, so the call does not touch your conversation or its prompt cache.
- The text of your answers leaves your machine for the model provider, as your own prompts do. Another plugin that hooks the `model.complete` call can read the request. Do not turn it on for work whose text must not go to the model a second time.
- The cap is `maxModelCallsPerHour` (default 30), counted in a rolling hour, per session. See "The hourly cap".

Turn it on: `/mods on wait-what` (at once, kept across sessions), or set `waitWhat` to `true` (see "Settings"). Turn it off: `/mods off wait-what`.

When an answer is retold. All of these must hold:

| Rule | Detail |
| --- | --- |
| The mod is on | `/mods`, then the setting, then the default (off). |
| The main conversation | A subagent's turn is never retold, and it does not clear the retell of the main answer. |
| A real answer | The turn ended with the reason `answer`. An interrupt, an error and a refusal are not retold. |
| Long enough | 200 characters or more, after trimming. A shorter answer is not retold: it is already short. The number is `MIN_ANSWER_CHARS` in `hooks/retell.ts`. |
| A terminal is in use | `$.session.surfaces()` includes `terminal`. If it does not, or it cannot be read, there is no call. The row is drawn only on the terminal, so a call without a terminal would spend tokens for nothing. |
| The budget allows it | See "The hourly cap". |
| No compaction runs, no other model call runs | The shared lock is free. See "Compatibility". |
| The clock can be read | A clock that cannot be read cannot count the hour, so there is no call. |

What the row says (text only: nobody has seen it drawn):

```
wait what: The build failed because a test reads a setting that was renamed.
           Rename the setting in the test file, then run the build again.
```

- The reply is the model's, cleaned: terminal escape sequences, control characters and invisible characters are removed, list, heading and bold marks are removed, and spaces are folded. At most 2 lines are kept. A line longer than the band is cut with `…`. One long line is split at a space into two. Characters are counted, not terminal cells, so a wide character can make a line longer than its count: the band's own clip then cuts it.
- A one-line retell takes one row of the band, a two-line retell takes two (see "How mods share the band").
- While the call runs, nothing is drawn. The row is drawn while no turn runs, and it goes at the next prompt (`turn.start`), at `/clear`, and when a newer answer ends.
- A reply that comes after any of those is dropped. A call in flight is cancelled at the next prompt and at the end of the session. `/mods off wait-what` during a call lets that call end (15 seconds at most) and drops its reply.
- A failed call (an API error, an empty reply, a timeout, or a model that is blocked) shows nothing, shows no toast, and writes one line to the UI log. It still counts toward the hourly cap, so a failing model cannot be called without limit.
- No sound. No hotkey: the row has no Button.
- A retell is a model's summary of the answer and can be wrong. Read the answer itself for anything that matters.

### The hourly cap

- The cap is the setting `maxModelCallsPerHour`, default 30. A call counts from the moment it starts, success or failure. The window is a rolling hour: a call stops counting exactly one hour after it started.
- `0` is valid and means no call at all. A value that is not a number from 0 to 1000 (negative, text, or above 1000) counts as 30.
- When the cap refuses a call, nothing is sent and the band shows one muted line, `wait-what: hourly limit reached`, until the next prompt. The next answer is retold as soon as the oldest call has left the hour.
- The count is kept in session state. It is meant to survive a hot reload and `/clear` (shown in the tests only, not in a real session). A new session starts at zero, so the cap is per session, not per account. If you run many sessions at once, each has its own cap.
- If the clock is set back, a call that is then in the future counts as made now, and leaves one hour after the next finished turn.
- An answer that is skipped (too short, a subagent, interrupted) spends nothing.

Limits:

- The kit cannot show the real model. Every reply in the tests is a stub. Whether `haiku` is allowed in your setup, what it answers, what one retell costs on your plan, and how long it takes were not measured. If the model is blocked, each answer logs one line and shows nothing.
- It was not checked that the call stays out of the transcript on a real session. The type declarations say `$.model.complete` runs "with no history" and the plugin calls no append, no prompt and no tool: so the transcript and the model context are only read from, per those declarations.
- Whether the retell is readable at your terminal width was not seen.

## Prompt Queue

**Prompt Queue sends prompts by itself, and they run with your permissions.** You type `/q <text>` while Claude works. When the turn ends, the first queued prompt is sent to Claude as if you had typed it at that moment, with the same tools and the same permission rules as any prompt of yours. Whatever it asks Claude to do, Claude does it, including edits and shell commands that your permission mode allows without asking, and nobody is watching at that moment. Queue only what you would be willing to send unattended, and read the queue (`/q`) before you leave it. The mod spends no model tokens of its own: each sent prompt is a normal turn of your session, on your plan.

The commands (`/q` runs while a turn is in flight: it is registered as an `immediate` command):

| You type | Effect |
| --- | --- |
| `/q <text>` | Add a prompt to the end of the queue. The text is trimmed. At most 20 prompts, at most 2000 characters each: a longer prompt is refused, not cut. An empty text is refused. |
| `/q` or `/q list` | List the prompts, numbered from 1, and say whether the queue is paused. |
| `/q rm <n>` | Remove prompt number n. The others keep their order. |
| `/q clear` | Remove every prompt, and lift a pause. |
| `/q pause` | Send nothing until `/q resume`. |
| `/q resume` | Lift a pause. If no turn is running, send the first prompt now. |
| `/q add <text>` | Queue the text even if it starts with a command word (`/q add pause`). |

Only the exact forms are commands: the whole argument is `list`, `clear`, `pause` or `resume`, or it is `rm` and a number. Anything else is a prompt, so `/q rm the old files` and `/q clear the cache, then rerun the tests` queue those sentences. A typo such as `/q pasue` queues the word. `/q now` (put a text into a running tool call) is not built: the declared API has no safe way to do it, and a prompt sent into a running turn is never folded into it (`$.prompt.submit` always waits for an idle session).

When a prompt is sent:

| Rule | Detail |
| --- | --- |
| The mod is on | `/mods`, then the setting `promptQueue`, then the default (on). `/mods off prompt-queue` also empties the queue, so that prompts you forgot cannot send after a later `/mods on`. Off: `/q` answers that the mod is off, queues nothing, and sends nothing. |
| A turn of the main conversation ended with an answer | A subagent's turn never sends. A turn that you interrupted (Esc), or that ended with an error or a refusal, does not send: it **pauses** the queue. The row says why, and a toast says it once. Only `/q resume` or `/q clear` lifts the pause. A later answer does not. The pause happens only when prompts are waiting: with an empty queue, nothing is paused. |
| The queue is not paused | By `/q pause`, by a turn that did not answer, or because Claude Code refused the last prompt. |
| No compaction is running, and no queued prompt is still on its way | The shared lock. See "Compatibility". A prompt that cannot be sent for this reason stays in the queue. |
| It is the first send for this turn | One `turn.complete` sends at most one prompt, and the same turn never sends twice. |

What the person types with no turn running: `/q <text>` sends the first prompt at once (nothing else would ever send it), and `/q resume` does the same. This also is how you restart a queue that waited for a compaction. The mod knows "a turn runs" from `turn.start` and `turn.complete`: after a hot reload it keeps the value in session state.

The prompt is sent with `$.prompt.submit({ text, asUser: true })`. The model reads the text bare, as your own words, with no "The mod-pack plugin sent a message" frame before it. The transcript still names the plugin, and every hook sees `e.origin` `{ kind: 'plugin', name: 'mod-pack', asUser: true }`: both are what the declared API says, and neither was seen on a real screen. The declared API says `@file` mentions and pasted images are not expanded in a plugin's prompt. The send is made after `turn.complete` answered, never inside it: the declared API says a hook that waits for its own `$.prompt.submit` inside a turn waits for ever. For a `/q` that sends at once, the send is made from a 0 ms timer, because the engine refuses `$.prompt.submit` from inside a `command.run` hook ("it would wait on the turn this hook is holding; submit from a later event"). This was found with the test kit's host check, not guessed. If Claude Code refuses a prompt (a hook drops it, or the call fails), the prompt goes back to the top of the queue, the queue pauses, a toast says so, and one line goes to the UI log.

What the row says (text only: nobody has seen it drawn):

```
queue (3): 1 fix tests · 2 update docs · …
queue paused (3): you interrupted the turn · /q resume sends · /q clear drops
```

- One row of the band, 1 line, drawn while a turn runs and after it. It shows nothing when the queue is empty or the mod is off.
- Each prompt is cut to 24 characters, with a `…`. Prompts are added to the row while they fit the band's width; `· …` says that more follow. Control characters (an escape sequence in pasted text) become spaces in the row and in `/q list`. The prompt itself is sent as you typed it.
- The row has no Button and no hotkey. It is drawn on the terminal only. The command and the sending work on every surface, but you can see the queue only by `/q list` outside the terminal.
- It stands before Wait What in the band, so that a 2-line retell never takes its row. See "How mods share the band".

State and limits:

- The queue is kept in session state (`$.state`), so a hot reload keeps it. `/clear` and the end of the session empty it. A new session starts empty. The queue is not saved to disk.
- `/q` changes and the end of a turn are applied one at a time, in the order they came, so a prompt typed in the same moment as a turn ends is neither lost nor sent twice. The test kit cannot interleave the two: this ordering is built in, and a test shows the result of one concurrent pair, but no test fails when the ordering is removed. See "What is verified".
- A dialog that is open (`$.ui.ask`) cannot be seen: the declared API has no way to read it. A Blast Radius dialog belongs to a tool call inside a turn, so no turn ends while it is open and nothing is sent then. A dialog of another plugin that opens between two turns could be open when the queue sends. This was not checked.
- Text that you typed in the prompt box and did not send, when the queue sends a prompt: not checked.
- If you also type a normal prompt while Claude works, Claude Code holds it itself. The order between that prompt and the queue's was not checked.
- A queued text that starts with `/` is sent as text. Whether Claude Code then runs it as a command was not checked.
- `/q` runs while a turn runs only if `immediate` does what the declaration says. This was not seen: the kit can show that the command is registered with `immediate: true`, and that the plugin works when the command arrives in the middle of a turn, but not that Claude Code runs it at that moment.

Switch it off: `/mods off prompt-queue` (at once, and the queue is emptied), or set `promptQueue` to `false`.

## Snake

Snake is a small Snake game in a pane. It pauses when Claude finishes a turn and goes on when you send the next prompt, so it fills the time that you wait. It draws a `Pane`, not a row of the band: it does not use the compositor, and it takes no row from the band's budget. It costs no model tokens and makes no network call. It keeps one number in the plugin store, the high score.

The commands and keys:

| You do | Effect |
| --- | --- |
| `/snake` | Open the pane with a new game, paused. When the pane is open, close it instead. The game is kept for the next `/snake`. `/snake` is registered as an `immediate` command, so it runs while a turn is in flight: that is when you want it. |
| `p` | Play, or pause. The first `p` starts a new game. |
| `w` `a` `s` `d` | Turn up, left, down, right. The turn happens at the next tick. |
| `r` | New game, running at once. The high score is kept. |
| Esc | Close the pane. The pane is opened with `closeOnEscape`: the declared API says Esc closes it while the pane holds the keyboard, and also at an idle, empty prompt once the prompt has the keys again. |

The keys are the `hotkey` of Buttons in the pane. The declared API says a Button's hotkey works only while the pane holds the keyboard: after ctrl+x then Tab, after a click on the pane, or when the pane was opened with `focus`. `/snake` asks for `focus`. That is a request: the engine grants it only while the prompt has the keys over an empty composer. The last line of the pane says `Esc closes the pane.` while the pane has the keyboard, and `Keys need the pane focused: click it, or ctrl+x then Tab.` when it does not. A click on a Button works in both cases. While the pane holds the keyboard, a letter you type goes to the pane and not to the prompt. No key is a digit: a digit hotkey also fires when you type that digit into an empty prompt, and next-steps owns 0 to 3. Arrow keys and Tab belong to Claude Code and are not used. A `Client` module can read the arrow keys after a click, but it runs in a separate drawing thread with no `$`: the game and its pause on `turn.complete` would then live in two places. The Buttons keep the whole game in one place.

What the pane shows (text only: nobody has seen it drawn):

```
Snake  score 3  best 12
PAUSED – Claude finished
· · · · · · · · · · · · · · · · 
· · · · · ● · · · · · · · · · · 
· · · · · · · · · · · · · · · · 
· · · · ██████████· · · · · · · 
· · · · · · · · · · · · · · · · 
...
w: up a: left s: down d: right
p: play r: restart
Esc closes the pane.
```

The rules:

| Rule | Detail |
| --- | --- |
| The board | 16 cells across and 8 down. One cell is 2 terminal columns wide, so the board is 32 columns by 8 rows. The pane body is 13 rows: a title line, a status line, the 8 board rows, 2 rows of keys and 1 hint row. `/snake` asks for 13 rows (`rows`). That is a request: a size that you dragged wins, and a docked pane ignores it. |
| The snake | 3 cells long at the start, heading right. Food is one cell, placed at random on a free cell. Eating it scores 1 and makes the snake 1 cell longer. |
| The end | A wall or the snake's own body ends the game (`GAME OVER – press r for a new game.`). The cell that the tail leaves counts as free in the same tick. When the snake fills the board, the game ends with `YOU WIN`. |
| Turns | A turn of 180 degrees is dropped, and so is the direction the snake already has. At most 2 turns wait for a tick: a third key before the next tick is dropped. |
| The tick | 150 ms, about 6.7 moves a second. Claude Code folds redraws above 10 a second (30 for the pane that is shown), so every tick is drawn. A shorter tick would speed the game up. |
| The random numbers | A 32-bit generator (mulberry32). Its state is kept in the game (`seed`, JSON). The first seed is the clock at `/snake`. The rules take the generator as a parameter, so the tests choose where the food lands. |

When the game pauses and resumes:

| Event | Effect |
| --- | --- |
| A turn of the main conversation ends (`turn.complete`), with an answer or interrupted | A running game pauses: `PAUSED – Claude finished`. A subagent's turn does not pause it. |
| A turn starts (`turn.start`) | A game that Claude's end paused goes on, from where it stopped. |
| You press `p` | The game is paused by you: `PAUSED – press p to play`. A turn that starts does not resume it. A game that you never started (a new one) stays paused in the same way. |
| You press `p` after Claude finished | The game plays. The next turn then leaves it running, and the end of that turn pauses it again. |
| A Blast Radius question is open | A running game pauses: `PAUSED – a question is open`. The dialog takes the keyboard, so you cannot steer. The game goes on when the last open question is answered, only if the question paused it. A game that you or Claude's end paused stays paused. |
| You close the pane (`/snake`, Esc, the close mark, `/mods off snake`), `/clear`, or the session ends | The timer stops and the game is held, paused by you. The next `/snake` shows it where it was. |
| Prompt Queue sends the next prompt | The game pauses at the end of the turn and goes on when the queued prompt starts its turn, within moments. |

State and limits:

- The game is kept in session state (`$.state`) under its own key, `mod-pack.snake`, and not in `features` with the other mods. The game is written about 7 times a second while it runs. Every reader of `features` is drawn again at each write, and the band compositor reads `features`. Only the pane reads the game, so only the pane is drawn again. A test shows that 10 ticks do not run the band hook again. A new session starts with no game.
- The high score is the store key `mod-pack/snake-best`. It is read when you open the pane, and written when a game ends with a score above 0. It is best effort: a store that cannot be read gives 0, a store that cannot be written loses the score, and neither stops the game. `/mods reset` does not clear it. A stored value that is not a whole number from 0 up counts as 0.
- Terminal only. The `Pane` component is raised on every surface. Snake draws on the terminal and returns what is beneath on any other. `/snake` in a session that has no terminal (or when `$.session.surfaces()` cannot be read) answers `Snake draws in a terminal pane only, and this session has no terminal. Nothing was opened.`
- The board needs a pane 32 columns wide. `/snake` on a terminal under 32 columns answers with text and opens nothing. A pane that is docked narrower than 32 columns shows `Snake needs a pane 32 columns wide. This one is N. Widen the terminal.` instead of the board, and the game goes on underneath: the pane cannot pause a game from inside its drawing. The declared API says a pane that the person's command opens is seated at any width. The width of a docked pane was not seen.
- The timer is `$.clock.every(150, ...)`, plain module state. It is cancelled when the pane closes, when the game stops running (pause, end), at `session.end` and when the mod is turned off. A hot reload drops it with the old environment and keeps the game: the game then waits in the state `running`, with no timer, until the next `session.start`, `turn.start` or key press arms it again. The kit cannot reload a plugin: this was not run.
- The pane is opened without `holdToasts`. The declared API says that option holds the toasts until the pane closes. Cache Keeper's cools-in toast and Prompt Queue's pause toast would then not show while Snake is open.
- `/snake` runs while a turn runs only if `immediate` does what the declaration says. The kit shows the registration with `immediate: true`. It cannot show that Claude Code runs it at that moment, or that `$.ui.open` works from inside a running turn.
- The kit cannot raise the person's own close of a pane (Esc, the close mark, ctrl+x x). `/snake` and `/mods off snake` raise the same `ui.close` hook through the plugin's own `$.ui.close`, so the hook is tested, with the origin `plugin` and not `person`.
- Glyphs: `██`, `●` and `·` are drawn as 2 columns per cell. A terminal font that draws `●` or `·` wider than 1 column (some East Asian fonts) breaks the alignment of the food and the empty cells. Not checked.

Switch it off: `/mods off snake` (at once: the pane closes and the timer stops), or set `snake` to `false`.

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

Each mod has one on/off setting, Cache Keeper has one more (`cacheTtlMinutes`), Wait What has one more (`maxModelCallsPerHour`), and there is one global `sound` setting. They are the plugin's `userConfig` options in `.claude-plugin/plugin.json`.

| Option | Default | Meaning |
| --- | --- | --- |
| `tokenWeather` | `true` | Show Token Weather. |
| `cacheKeeper` | `true` | Show the Cache Keeper countdown row. |
| `cacheTtlMinutes` | `60` | The prompt cache lifetime, in minutes, for Cache Keeper. 60 is the documented lifetime on a subscription. Set 5 on an API key, a cloud provider, or usage credits. A value that is not above 0 and up to 1440 counts as 60. |
| `promptQueue` | `true` | Enable `/q` and the queue row. Queued prompts are sent by themselves and run with your permissions. No model tokens of its own. |
| `waitWhat` | `false` | Retell each long answer in plain words in the band. **Spends model tokens** (one short call per answer, to the cheapest model). Off by default. |
| `maxModelCallsPerHour` | `30` | The most model calls Wait What makes in a rolling hour, per session. `0` means none. A value that is not a number from 0 to 1000 counts as 30. |
| `blastRadius` | `true` | Ask Proceed or Cancel before a risky shell command. |
| `snake` | `true` | Enable `/snake` and the Snake pane. No model tokens. |
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
3. **Rows, not trees.** A mod returns one row. The compositor clips it to one terminal row (`height={1}`, `overflow="hidden"`) and counts it as one row. A mod may draw 2 lines: its `bandLines` function says how many (1 or 2) for the state it has now. The compositor then gives the row `height={2}` and counts it as 2 rows. It never gives a row more lines than are left in the budget: the first lines show and the rest are clipped. Only Wait What uses `bandLines`. The giving out of lines is the pure function `layoutRows` in `hooks/settings.ts`, so that its rules can be tested with any rows, in any order. Inside a 2-line row, each line is its own clipped one-row Box, so a long first line cannot push the second out of view.
4. **A row budget.** `maxRows` is what the whole band may take, for all plugins together. The pack cannot measure what other plugins drew. So it takes at most one third of `maxRows`, never more than 4 rows, and none when `maxRows` is under 3. Mods fill the budget in the order of the `FEATURES` list. The first mod has the priority. The budget is counted in rows of the terminal, not in mods. The order is Token Weather, Cache Keeper, Prompt Queue, Wait What. With all four drawing, `maxRows` 3 to 5 gives the budget 1 (Token Weather only), 6 to 8 gives 2 (Token Weather and Cache Keeper), 9 to 11 gives 3 (Token Weather, Cache Keeper and the queue; Wait What none), and 12 or more gives 4 (the three, and the first line of Wait What). A retell needs the budget 5 to show both lines beside the queue row, and the budget is at most 4 (`MAX_OWN_ROWS`): so while the queue has prompts waiting, Wait What shows one line, whatever the terminal height. With the queue empty (no row), it is as before: 9 to 11 gives Wait What its first line only, and 12 or more gives both lines. The queue stands before Wait What on purpose: a 1-line row that is the person's own list must not be starved by a 2-line retell.
5. **Terminal only.** On a surface that is not `terminal`, or while a survey holds the band (`hasSurvey`), the compositor returns `below` unchanged.
6. **No digit hotkeys.** Never put `hotkey="1"` (or any digit) on a Button in a mod. A digit hotkey also fires when the person types that digit into an empty prompt. next-steps already owns 0, 1, 2 and 3. Use a letter hotkey, or a click, or no hotkey.

The same rule of one hook applies to events. The engine refuses a plugin that registers the same event twice without a matcher. So `register.tsx` registers `ui.render`, `turn.start`, `turn.complete`, `session.start`, `session.end` and `session.compact` once each, and calls the mods. A matched hook can be registered several times: `command.run` for `mods`, for `q` (Prompt Queue) and for `snake`, `tool.call` for `Bash` and for `PowerShell` (Blast Radius), and, for Snake, `ui.close` for the pane `snake` and `ui.render` for the `Pane` `snake`.

A new mod adds to these same hooks. It does not register the event again.

Snake is not in this list of rules. It draws a `Pane`, a site of its own that Claude Code seats beside the transcript or above the prompt, so it does not use the compositor and takes no row of the budget. Rule 1 (always call `next`) still holds for its `ui.render` hook, and rule 6 (no digit hotkeys) for its Buttons. See "Compatibility" for how the pane, the band and next-steps sit together.

## Compatibility

What each mod uses, so that you can see which ones can run together. All mods listed can run together: see "Pairs of mods" below for what was tested. Three rows to read first: Wait What is the only one that spends model tokens, Prompt Queue is the only one that sends prompts by itself, and Snake is the only one that draws a pane and not a band row.

| Mod | Display slot | Hotkeys | Shared lock | Spend |
| --- | --- | --- | --- | --- |
| Token Weather | Band row 1 (first in `FEATURES`: the first to get a row when the budget is short) | none | not used | none |
| Cache Keeper | Band row 2 (the row budget is 1 when `maxRows` is 3 to 5, so then only Token Weather shows) | none. One Button, `compact`, by click or by focusing the band. No digit hotkey, so it never takes the digits that next-steps owns | takes it while it compacts, and ignores a press while it is held | none. No model call, no network call |
| Prompt Queue | Band row 3: after Cache Keeper, before Wait What (1 line; it shows while a turn runs, which the Cache Keeper row does not). With Token Weather and Cache Keeper both drawing, it shows when `maxRows` is 9 or more, and not under 9. The slash command `/q`, registered as `immediate` | none. The row has no Button. No digit hotkey. `/q` is a typed command | takes it for a prompt on its way, from the decision to send until that prompt's turn starts (30 seconds at most). Does not send while a compaction runs or another queued prompt is on its way. Ignores a Wait What call in flight: it cancels it and takes the lock | none of its own. No model call, no network call. Each prompt it sends is a normal turn, on your plan |
| Wait What | Band rows 3 to 5, after the queue: last in `FEATURES`, so the last to get rows. It draws 1 or 2 lines, whichever the retell needs. With Token Weather and Cache Keeper both drawing and the queue empty, it gets 2 lines when `maxRows` is 12 or more, 1 line when `maxRows` is 9 to 11, and none under 9. While the queue has prompts waiting, it gets 1 line at 12 or more and none under 12 (the budget is at most 4 rows). With any of the others off or not drawing, it moves up | none. The row has no Button | reads it: no call while it is held, by a compaction or by a queued prompt on its way. Takes it for the length of its call (15 seconds at most), and frees it when the call ends or is cancelled | **spends model tokens**: one call to the `haiku` alias per retold answer, at most `maxModelCallsPerHour` (default 30) in a rolling hour, per session. Off by default |
| Blast Radius | no row. The question dialog, on `tool.call` for Bash and PowerShell | none | not used | none. No model call |
| Snake | A `Pane` with the id `snake`, not a band row. It does not use the compositor and takes no row of the budget. Claude Code seats the pane: docked beside the transcript in the fullscreen terminal from 110 columns, else inline above the prompt. `/snake` seats it at any width. The slash command `/snake`, registered as `immediate` | Letters `w` `a` `s` `d` `p` `r` on Buttons in the pane, and Esc (`closeOnEscape`). They work only while the pane holds the keyboard. No digit hotkey, so it never takes the digits that next-steps owns. No band Button is touched | not used: it takes no lock and reads none. It is not a compaction, a model call or a prompt submission. It reacts to `turn.start`, `turn.complete` and to an open Blast Radius question | none. No model call, no network call |

The shared automation lock. Only one automatic action runs at a time: a compaction, a model call of a mod (Wait What), and an automatic prompt submission (Prompt Queue). The lock is the variable `busyWith` in `hooks/register.tsx`. Its value says who holds it: `'compaction'`, `'model-call'`, `'prompt-submit'`, or nothing. A mod reads it as `ctx.isBusy` (held by anyone) and `ctx.lock` (held by whom), and must not start its own automatic action while it is true, unless it knows that the holder does not matter. The rules:

- A compaction holds it from its start to its end. That covers the Cache Keeper button, the person's `/compact`, and the engine's auto-compaction (all seen by the `session.compact` hook). A compaction triggered with `precompute`, and a subagent's own compaction, do not take it.
- Wait What takes it only when it is free, in the same moment as it decides to call, and holds it until its call ends. It frees it when the call ends, fails, times out (15 seconds), or is cancelled by the next prompt (`turn.start`) or the end of the session. Only the call that took the lock may free it.
- A compaction always takes the lock, even from a model call. The engine's own compaction cannot be refused, and a Wait What call is a short side request with no history, so it does not disturb a compaction. The call then no longer holds the lock, and when it ends it does not free the compaction's lock.
- The Cache Keeper `compact` button does nothing while a compaction runs (as before). While a Wait What call runs, it shows a toast, `a Wait What retell is running. Press compact again in a few seconds.`, and does not compact. The wait is 15 seconds at most, usually about a model reply.
- An answer that ends while the lock is held is not retold, not even later, and spends nothing from the hourly cap. When a second answer ends while the call for the first is still running (with no prompt between them), the second is not retold, and the reply of the first is dropped as stale. The row then shows nothing, until the next answer that ends with the lock free.
- **Which holders block the Prompt Queue.** A compaction blocks it, and so does another queued prompt that is still on its way. A Wait What model call does not block it: the prompt starts a turn, a new turn cancels the call and drops its reply anyway, so the queue cancels the call at once and takes the lock. The queue therefore reads `ctx.lock`, not only `ctx.isBusy`. Each of the three is covered by a test.
- Prompt Queue takes the lock only when it sends, in the same moment as its decision, and holds it until the prompt's turn starts (`turn.start`), the send call settles (a refusal included), the session ends, or 30 seconds have passed, whichever comes first. A compaction that starts meanwhile takes the lock over, and the send settling then does not free it. Only the send that took the lock may free it.
- A prompt that is blocked by a compaction stays in the queue. It is not sent when the compaction ends: the next turn that ends sends it, or `/q resume` does at once. This is a decision: the end of a compaction is not an event that the queue sees after the lock is free.
- While a queued prompt is on its way, a Wait What retell does not start for the answer that just ended (the lock is held), and spends nothing from its hourly cap. The retell would be cancelled by the next prompt within moments. When the queue is empty, the answer is retold as before.
- While a queued prompt is on its way, the Cache Keeper `compact` button shows a toast, `Prompt Queue is sending a prompt. Press compact again in a moment.`, and does not compact.
- The lock is plain module state: a hot reload resets it, together with the work it guards, so it cannot stay set.

Events that mod-pack hooks without a matcher, once each: `session.start`, `session.end`, `session.compact`, `turn.start`, `turn.complete` and `ui.render` for `AbovePrompt`. Matched hooks: `command.run` for `mods`, for `q` and for `snake`, `tool.call` for `Bash` and `PowerShell`, `ui.close` for the pane `snake`, and `ui.render` for the `Pane` `snake`. Snake adds the matched hooks, the `/snake` registration in `session.start`, and the engine calls `$.ui.open`, `$.ui.close`, `$.ui.panes` and `$.clock.every` (Cache Keeper uses it too); its other work is in `session.start`, `session.end`, `turn.start` and `turn.complete`, which already exist. Prompt Queue adds the matched `command.run` hook, the `/q` registration in `session.start`, and the engine calls `$.prompt.submit` and `$.clock.after`; the other work is in the events that already exist. Another plugin that hooks the same event with no matcher is not affected: each plugin may do it once. The next-steps plugin (the stub in the tests) draws in the same band. mod-pack always calls `next` and keeps what is below, so both show. Wait What adds no hook: it works in `turn.start`, `turn.complete` and `session.end`, which already exist, and its new engine calls are `$.model.complete` and `$.session.surfaces`.

Wait What and the other plugins:

- Beside next-steps: next-steps asks its own question with `$.model.fork` after an answer of 80 characters or more, and Wait What asks with `$.model.complete` after one of 200 characters or more. Both can fire on the same answer: two separate calls, each spending tokens, on different models and with different input. next-steps' fork reads the whole conversation (it shares the prompt cache); Wait What sends only the answer. Neither reads the other's result. This was not run against the real next-steps plugin.
- Beside Token Weather and Cache Keeper: all three rows show, in that order, in the tests. Wait What never overwrites a row: when the budget is short it is the one that waits. Its call does not touch the main conversation's prompt cache, so it does not restart Cache Keeper's clock.
- Beside Blast Radius: no overlap. A Blast Radius dialog is a question on a tool call. Wait What's call is a side request. The Wait What call does not wait for a dialog, and a dialog does not wait for it. What a retell does while a dialog is open was not checked.
- Beside the Prompt Queue: see the lock rules above. The queue sends the next prompt and Wait What does not retell the answer before it (tested). A retell that is already in flight when a `/q` sends is cancelled (tested). The retell shows 1 line, not 2, while the queue has prompts waiting.

Prompt Queue and the other plugins:

- Beside next-steps: next-steps draws its suggestions in the same band, from its own hook, and mod-pack keeps what is below (tested with a stub). next-steps may also fill the prompt box with a suggestion. What happens to text in the prompt box when the queue sends was not checked.
- Beside Blast Radius: no overlap. A Blast Radius dialog is a question inside a tool call, inside a turn. A turn that is waiting for the dialog has not ended, so the queue sends nothing then. It was not run: the kit's dialog stub answers at once and never holds a turn open.
- Beside Cache Keeper: the `compact` button and a queued prompt on its way never run together (tested, both directions). A queued prompt is a turn of the main conversation, so its answer restarts Cache Keeper's clock like any prompt of yours.

Snake and the other plugins:

- The pane and the band are two sites. Snake's `ui.render` hook is matched on `{ component: 'Pane', requestId: 'snake' }` and the compositor's on `{ component: 'AbovePrompt' }`. Neither hook is raised for the other's site, so neither can overwrite the other, and next-steps, which draws in the band, does not see the pane. A test mounts the band with Token Weather, Cache Keeper and a next-steps stub, and the pane beside it: the band tree is the same with Snake open and running as with Snake off, apart from the number of each Button's press handle, and 10 ticks of the game do not run the band hook again (the game has its own state key, so only the pane is drawn again).
- The row budget. The compositor's budget is a third of the band's `maxRows`, 4 rows at most. The pane takes none of it, at any `maxRows` (tested at 5, 6, 9 and 12). What the declared API says about the layout: `maxRows` is, in the fullscreen terminal, what the bottom slot has left above the prompt, and otherwise the terminal's height. An inline pane sits above the prompt and asks for 13 rows, so it may leave the band fewer rows. Whether `maxRows` goes down while a pane is open was not measured. If it does, the compositor already follows it: the budget is computed from `maxRows` at each draw.
- A docked pane. While a pane is docked beside the transcript, the declared API says the band's `bodyColumns` is the transcript column's width, not the terminal's. The Prompt Queue row is cut to `bodyColumns`, so it follows. Not seen.
- Rule 1 (always call `next`). The Snake hook calls `await next(e)` and puts what is beneath above the board. A test shows another plugin's hook on the same pane drawing above the board. With nothing beneath, the kit's chain bottom throws (`no implementation for ui.render`), so a `next` that fails counts as nothing below and the board is still drawn. What the real engine answers beneath a pane that only this plugin draws was not seen. The bundled example for a pane does not call `next`.
- The keyboard. One site holds the keyboard at a time, and a Button's hotkey fires only while its own site holds it. The band's Buttons (Cache Keeper's `compact`, no hotkey) and next-steps' digits are on the band. Snake's letters are on the pane. They cannot meet.
- Toasts. The pane is opened without `holdToasts`, so Cache Keeper's cools-in toast and Prompt Queue's pause toast show while Snake is open.
- Beside Blast Radius. A Blast Radius question pauses a running game while it is open, and resumes it when the last open question is answered, if the question paused it. This is the dispatcher's `askPerson` (one count of open questions). It is tested with a held question: one question, two at once, a game that you paused (not resumed), a turn that ends while the question is open (Claude's pause takes over), Blast Radius off (no question, no pause), and no game open. The real dialog was not seen.
- Beside Prompt Queue. At the end of a turn the game pauses, the queue sends the next prompt, and the game goes on when that prompt starts its turn (tested).
- Beside Cache Keeper, Token Weather and Wait What. No shared state, no shared hook, no lock. A compaction does not pause the game: it is not a turn.

### Pairs of mods

Which pairs were run together in the test kit (the flow tests mount the real plugin, stub the engine beneath it, and read the tree):

| Pair | Tested | What was checked |
| --- | --- | --- |
| Prompt Queue and Token Weather | yes | Both rows show, in order, at every row budget (`maxRows` 5, 6, 8, 9, 12). |
| Prompt Queue and Cache Keeper | yes | Both rows show, in order. The queue row stays while a turn runs, the cache row hides. The `compact` button and a queued prompt on its way, in both orders. A compaction taking the lock from a prompt on its way. |
| Prompt Queue and Wait What | yes | The retell skipped, with no budget spent, when the queue sends. A retell in flight cancelled when `/q` sends. The queue row before a retell clipped to 1 line at `maxRows` 12. |
| Prompt Queue and Blast Radius | loaded together only | Blast Radius is on in every flow test, so both are in the same plugin instance, but no test makes a dialog open while the queue acts: the kit cannot hold a turn open on a dialog. By the design they do not overlap: see above. |
| Prompt Queue, Token Weather, Cache Keeper, Wait What and the next-steps stub, all at once | yes | All five drawn, in order, none overwritten. |
| Token Weather and Cache Keeper, Token Weather and Wait What, Cache Keeper and Wait What | yes | By the earlier tests, now with the queue present. |
| Blast Radius and Token Weather, Cache Keeper, Wait What | loaded together only | Blast Radius is on in their flow tests, but no test makes a dialog open while they act. They share no state and no matched event. |
| Snake and Token Weather, Cache Keeper, the next-steps stub | yes | Band tree the same with Snake open and running as with Snake off. The pane draws above its own board what another plugin draws beneath it. No band row from Snake, at four values of `maxRows`. 10 ticks do not run the band hook. |
| Snake and Prompt Queue | yes | The game pauses at the end of the turn, the queue sends, the game goes on when the queued prompt starts its turn. |
| Snake and Blast Radius | yes, with a held question | Pause while a question is open, resume at the answer, in the cases listed above. A real dialog was not seen. |
| Snake and Wait What | loaded together only | Wait What is off by default. They share no state, hook or lock. No test turns Wait What on beside Snake. |

No pair of mods in the pack is known to conflict, and no pair is known to be unable to run together. Mods that are planned and not built are not listed. Two conditions are not "can run together as they are". First, the row budget: with the queue, Token Weather, Cache Keeper and Wait What all drawing, Wait What shows 1 line and not 2. Second, screen rows: an inline Snake pane asks for 13 rows of the layout, and what that leaves the band was not measured.

## Cost, sound and safety

- A mod is code. It runs with your permissions. Read a mod before you enable it. Token Weather reads the context-window size and your token count, keeps them in session state, and draws. It makes no network call and spends no model tokens. Cache Keeper reads the clock and your token count, keeps them in session state, and draws. Its `compact` button runs the same compaction as `/compact`, and that compaction does spend model tokens, when you press it. It makes no network call of its own. Blast Radius runs read-only `git` commands and reads folder listings to build its preview. It makes no network call and spends no model tokens. Wait What, when you turn it on, sends the text of your answers to the cheapest model and spends tokens on your plan: see "Wait What". Prompt Queue keeps the prompts you queue in session state, sends each one to Claude when a turn ends, and runs it with your permissions: see "Prompt Queue". It makes no model call of its own and no network call. Snake keeps the game in session state and one number, the high score, in the plugin store. It draws a pane, makes no model call and no network call, and spends no tokens.
- Spend rule for mods that call a model (one so far: Wait What). A mod must set `usesModel: true`, so `/mods` shows it. It must be off by default, with its cost written in its `about` text and in the README. It must use the cheapest model (the `haiku` alias). It must make at most 30 model calls an hour by default, with a setting for the number. The helper is in `hooks/retell.ts` (`callLimit`, `canCall`, `addCall`, `recentCalls`): a pure rolling-hour counter. The model call itself is made by the dispatcher (`runAsk` in `hooks/register.tsx`), which takes the shared lock, cancels the call at the next prompt, and gives the reply back to the mod.
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
  isSerial?: true       // a command also changes the state: the dispatcher runs the callbacks one at a time with it
  turnComplete?: (state, { e, context, hasTerminal }, ctx) => { state?, sound?, toast?, ask?, submit? } | undefined
  turnStart?:    (state, { e }, ctx)          => { state?, sound?, toast? } | undefined
  sessionStart?: (state, { e }, ctx)          => { state?, sound?, toast? } | undefined
  sessionEnd?:   (state, { e }, ctx)          => { state?, sound?, toast? } | undefined   // exit or /clear
  compacted?:    (state, ctx)                 => { state?, sound?, toast? } | undefined   // the main conversation was compacted
  tick?:         (state, ctx)                 => { state?, sound?, toast? } | undefined   // once a minute
  submitFailed?: (state, { text, why }, ctx)  => { state?, sound?, toast? } | undefined   // the prompt that `submit` sent was refused
  modelDone?:    (state, { turnId, reply }, ctx) => { state?, sound?, toast? } | undefined   // the model call that `ask` started has ended
  band?: (state, { props, now, options, isCompacting }, el, { compact }) => RenderElement | null
                                                // one row; `el` is { Box, Text, Button, ... }; `compact` is a click handler
  bandLines?: (state, { props, now, options, isCompacting }) => number   // 1 (default) or 2: how many lines `band` draws now
}
// ctx = { isSoundAllowed, now, options, isBusy, lock }   now: ms from the engine clock (NaN if unreadable); options: the plugin settings
//   isBusy: the shared lock is held (a compaction, a model call or a queued prompt on its way): do not start an automatic action
//   lock: who holds it: 'compaction' | 'model-call' | 'prompt-submit' | undefined
// ask = { turnId, model, system, prompt, maxTokens, timeoutMs, effort? }: a model call for the dispatcher to make, detached, only when ctx.isBusy was false.
//   Its reply comes to `modelDone` as { turnId, reply: { isAnswered: true, text } | { isAnswered: false } }.
// submit = a prompt (text) for the dispatcher to send as the person's own words, detached, only when ctx.lock allowed it.
//   The dispatcher takes the lock in the same moment. A refusal comes to `submitFailed`.
```

Steps:

1. Write `hooks/<name>.tsx` with `defineFeature<State>({ ... })`.
2. In `hooks/register.tsx`, import it and add it to `FEATURES`. The order is the row order and the priority.
3. In `.claude-plugin/plugin.json`, add a boolean to `userConfig`. The key is the camelCase of the id.
4. In `types/index.d.ts`, add the state type to `ModPackFeatureStates`.
5. Add tests. Run `claude plugin test` and `claude plugin validate`.

`state` is kept in `$.state` under the id of the mod, so it survives a hot reload. `sound` is a file of the plugin (`assets/x.wav`). The dispatcher plays it only when `ctx.isSoundAllowed` is true.

A mod that draws a pane and not a band row (Snake) follows the same rule for `$`: its Feature entry has no callbacks, as Blast Radius's has, and the pane hook, the timer, the commands and the state are written in `hooks/register.tsx`. It keeps its state under a key of its own in `types/index.d.ts` (`PluginState['mod-pack']`), not in `features`, when it writes often: every reader of a state value is drawn again at each write, and the band compositor reads `features`. Its `ui.close` hook calls `next`, because a hook that answers without it keeps the pane open.

A mod that spends model tokens also: sets `usesModel: true` and `defaultOn: false`, states the cost in `about` and in the README, checks `ctx.isBusy` and the hourly cap before it returns `ask`, drops a reply in `modelDone` whose `turnId` is no longer the one it is waiting for (read from the state, which the dispatcher reads again), and cleans the model's text before it draws it.

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
| `hooks/settings.ts` | Pure: on/off resolution, sound gate, row budget, the giving out of band lines (`layoutRows`). |
| `hooks/mods-command.ts` | Pure: the `/mods` parser. |
| `hooks/token-weather.tsx`, `hooks/forecast.ts` | The Token Weather mod and its pure logic. |
| `hooks/cache-keeper.tsx`, `hooks/cache-clock.ts` | The Cache Keeper mod and its pure logic: the lifetime setting, the countdown, the words. The lock, the timer and the compaction call are in `register.tsx`. |
| `hooks/wait-what.tsx`, `hooks/retell.ts` | The Wait What mod and its pure logic: the hourly cap, what is sent and how it is cut, the reply cleaning, the fitting of lines to the band. The lock, the model call and its cancelling are in `register.tsx`. |
| `hooks/prompt-queue.tsx`, `hooks/queue.ts` | The Prompt Queue mod and its pure logic: the `/q` parser and replies, the caps, the pause rules, the row text. The lock, the state, the `/q` command and the sending are in `register.tsx`. |
| `hooks/snake.tsx`, `hooks/snake-game.ts` | The Snake mod and its pure logic: the board, the move, the turns, the pauses, the text. `snake.tsx` also draws the pane. The pane hook, the timer, `/snake`, the high score and the pause on a Blast Radius question are in `register.tsx`. |
| `hooks/blast-radius.ts` | The Blast Radius mod: the rule table, the preview plans and text, the dialog text. Pure. |
| `types/index.d.ts` | The `$.state` contract. |
| `assets/thunder.wav`, `scripts/make-sounds.js` | The sound and the script that makes it. |

## What is verified

- Type check, unit tests and the plugin test kit pass. The kit mounts the band through the plugin on the terminal surface. It checks that another plugin's band (a stub) and the Token Weather row are both present, in that order.
- `claude plugin validate` passes for the plugin manifest, the hooks module and the marketplace manifest.
- Blast Radius: the kit runs `tool.call` through the plugin with the dialog, `process.run`, `fs.stat` and `fs.list` stubbed beneath it. It checks Proceed, Cancel, a dismissed dialog, no one to ask, another answer, a safe command, the off switch, a failing preview, and a crash in the check. The stub plays the person: no dialog was drawn.
- Cache Keeper: the kit mounts the band through the plugin on a clock that only the test moves. It checks the row text at each stage, the one toast, the restart at a new response, a subagent turn, a running turn, an interrupted turn, `/clear`, the lifetime setting (valid and invalid), the compact button (done, vetoed, rejected, two presses at once, a compaction started by someone else), the timer (one per session, stopped at `session.end`), the off switches, and the band beside Token Weather and a stub standing for next-steps. A mutation check was run: removing the clock restart, the subagent guard, or the lock guard each made the right tests fail. The kit cannot show the real cache: whether a cache is warm, the real lifetime of an account, or what the engine's `session.compact` does with a real conversation. The stub plays those.
- Wait What: the kit runs the plugin with the model stubbed beneath it (`model.complete` answers, fails, throws, or is held on a clock that only the test moves). It checks that the default makes zero calls (the stub is never reached), the request (the `haiku` alias, 120 tokens, 15 seconds, no history, the answer cut to 4,000 characters with its start and end kept), every skip rule, the terminal-only rule, that `turn.complete` resolves while the model is still working (the call is detached), the drop of a late reply (a new prompt, a newer answer, `/clear`, `/mods off`), a failed, empty or throwing call (no row, no toast, no crash, the lock free, still counted), the cleaning of a reply with escape sequences, the hourly cap (window, limit, 0, invalid, the default of 30, `/clear`), the lock (no call during a compaction, the compact button during a call, a compaction that starts during a call), and a 2-line row beside Token Weather, Cache Keeper and a stub standing for next-steps, at each row budget. A mutation check was run: removing the cap, the late-reply check, the lock check, the compaction takeover, the lock ownership check, the detached call, the cancel at `turn.start`, the 2-line compositor, the terminal check, the length minimum and the truncation each made the right tests fail and no others. Two mutations did not make a test fail: dropping the abort check after a call (the late-reply check catches the same cases, so that line is a second layer that no test isolates), and charging a 2-line row as one row in the compositor's budget (not observable through the plugin: Wait What is the last mod that draws, so no row follows it; killed later by a unit test of `layoutRows`, see Prompt Queue below). The kit cannot show: what the real model answers, whether `haiku` is allowed, the real cost and delay, that the real engine keeps the call out of the transcript, and whether the cancel at the next prompt stops the real request.
- Prompt Queue: the kit runs the plugin with the engine stubbed beneath it: `prompt.submit` (it records every prompt, and can be held, drop the prompt, or throw), `session.compact` (held), `model.complete` (for Wait What), `command.register`, the clock, the store and a stub standing for next-steps. It checks: `/q` registered as an `immediate` command; a prompt queued in a turn that is sent when the turn ends, once, trimmed, as the person's words; the order of several prompts; a `/q` with no turn running; list, remove and clear; the caps (20 and 2000); that `turn.complete` resolves while the engine is still taking the prompt; the same `turn.complete` twice; a second `turn.complete` while a prompt is on its way; the 30 second lock limit; a subagent turn; an interrupted turn, an error and a refusal (pause, toast, row, resume); an empty queue; a compaction in progress (no send, the prompt stays, the next turn sends); a Wait What call in flight (cancelled, the prompt sent, the late reply dropped); Wait What skipping its retell and keeping its budget when the queue sends; a compaction that takes the lock from a prompt on its way; the compact button during a send; a refused prompt (dropped by a hook, or thrown: back on top, paused, toast); `/mods off` (the row goes, `/q` says the mod is off, the queue is emptied), the setting off, `/clear`; the row beside Token Weather, Cache Keeper and the next-steps stub at five row budgets, while a turn runs, on a narrow band, off the terminal, with a survey, with escape sequences in the text; and all four rows at once with Wait What clipped to 1 line. The pure rules (parser, caps, order, pause, the lock rule, the row) have their own unit tests. A mutation check was run on 20 changes. Eighteen made the right tests fail and no others: removing the subagent guard, the compaction check, the pause after an interrupt, the per-turn double-send guard, `immediate`, the `turn.start` release of the lock, the cancel of a model call, the empty-on-`/mods off`, the model-call rule (blocking on it), the `/clear` empty, the 0 ms timer for `/q`, the detached send, the 30 second limit, the row hiding while a turn runs, the put-back of a refused prompt, the queue-before-Wait-What order, the lock reaching Wait What, and charging a 2-line row as 1 line. Two did not make a test fail: (1) the second check in `beginSubmit` against another prompt on its way (the first check, in the pure rule `canSend`, stops the same cases, so that line is a second layer that no test isolates); (2) removing the one-at-a-time order of `/q` and `turn.complete` (the kit runs stubs in one thread with no delay, so it cannot interleave them: the order is untested, and the one concurrent pair in the tests passes without it). The earlier survivor of the Wait What check, charging a 2-line row as 1 row, is now killed, but not by a plugin-level test: it is observable only when a row stands after the 2-line row, and the real order has none (Wait What is still the last mod that draws, and Blast Radius draws no row). So the giving out of lines was moved into the pure function `layoutRows` (`hooks/settings.ts`), and its unit test, with rows in any order, fails when the mutation is applied. No test through the plugin fails for that mutation. The kit cannot show: that Claude Code runs `/q` at once in a running turn, what a sent prompt looks like in the transcript, what the engine does with a prompt queued behind the person's own, whether the turn of a sent prompt starts promptly, or any real screen.
- Snake: the pure rules have 35 tests with an injected generator: where the food lands, the 4 walls, the body, the tail cell, growth, the win, the turn queue and the 180 degree rule, the pauses and the resumes by reason, restart, the parsing of the stored high score, the status text and the rows of the board. The kit runs the plugin with the engine stubbed beneath it (41 flow tests): `ui.open`, `ui.close` and `ui.panes` (a list of panes; an open that waits undrawn or is refused), the clock (moved by the test), a store whose every read is counted, `session.surfaces`, `command.register`, the Blast Radius dialog (held on the clock), `prompt.submit`, a stub standing for next-steps in the band, and another plugin's hook on the same pane. It mounts the Pane through the plugin and reads the tree. It checks: `/snake` registered as `immediate`; the options of `ui.open` (no `holdToasts`); open, close and reopen with the game kept; the board, the keys (letters, plain, none a digit) and the hint; the tick (at 149 ms nothing moves, at 150 ms one cell); steering, the 180 degree rule and a key on a paused game; a key and a tick together; one timer; the pause at `turn.complete` and the resume at `turn.start`, a subagent turn, an interrupted turn, a game that you paused, a game never started, and a cycle of three turns; `/clear`; eating, the wall, the high score (kept, read, invalid, a store that is down), restart, and a finished game that no turn revives; `/mods off snake`, the setting, `/mods on` over the setting, and the `/mods` list; a session with no terminal; a narrow terminal and a narrow pane; an open that waits undrawn or is refused; the Blast Radius question (one, two at once, a game that you paused, Claude's end taking over, Blast Radius off, no game); the band beside Token Weather, Cache Keeper and the next-steps stub (the same tree with Snake off, not drawn again by 10 ticks, and the same rows at four values of `maxRows`); and Prompt Queue beside Snake. "The timer is gone" is shown by a count: a running tick reads the store once, and the count stays flat after a pause, a close, `/clear`, `/mods off` and the end of a game. A mutation check was run on 17 changes. Sixteen made the right tests fail and no others: removing the pause at `turn.complete` (6 tests), the resume at `turn.start` (4), the subagent guard (1), the timer cancel after a pause (1, by the store count), every timer cancel (6), the pause on a question (3), the off check (1), the hold of the game at a close (2), the 180 degree rule (3), `next` in the pane hook (2), `holdToasts` (1), a tick of 300 ms instead of 150 (14, all timing), the wall (3), the body check (1), growth (3), and a resume of a pause that you made (7). One did not make a test fail: removing `next` from the `ui.close` hook. In the kit, a hook for that event that returns `undefined` lets the chain go on, so no test sees the difference. Whether the real engine then keeps the pane open (the declared API says a hook that answers without `next` does) is not shown. The kit cannot show: that Claude Code runs `/snake` in a running turn and that `$.ui.open` works there; whether `focus` is granted and whether Esc closes the pane; that the letters reach the Buttons; the person's own close of a pane (origin `person`); whether the pane is seated docked or inline, and the width and height it gets; what `next(e)` answers beneath a pane in a real session; the redraw rate of a real pane; a hot reload (the timer is dropped and armed again); a real Blast Radius dialog; or any real screen. Nobody has seen the game drawn.
- Not verified: how it looks in a real terminal, how the Blast Radius question looks on screen, what the real `claude -p` does with a risky command (the code fails closed, from the type declarations), the real sound output, the install from GitHub, a run beside the real next-steps plugin, any Wait What retell on a real screen or from a real model, and any Snake game on a real screen.

## License

MIT. See `LICENSE`.
