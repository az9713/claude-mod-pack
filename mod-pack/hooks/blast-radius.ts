// Blast Radius: hold a risky shell command until the person presses Proceed or Cancel.
//
// Pure: no `$` here. This file holds the rule table that says whether a command is
// risky, the planning of the read-only preview, and the text of the dialog. The
// engine calls (`$.ui.ask`, `$.process.run`, `$.fs.*`) are all in register.tsx,
// which hands this file plain data and gets plain data back.
//
// ponytail: a safety net, not a permission system. This is a regex table over the
// command text. It does NOT catch: an alias, a script that calls rm, a command
// built from variables (`rm -rf "$DIR"`, `eval "$cmd"`), or other quoting tricks.
// It splits on `&&`, `||`, `;`, `|`, `&` and newlines and also inside quotes, so
// `echo "a; rm -rf x"` is a false positive. That is acceptable. `echo "rm -rf x"`
// and `grep rm -rf README` are NOT held: a rule matches only at the start of a segment.

import { defineFeature } from './feature'

// The Feature entry. It has no callbacks: the dispatcher reads only its id, text and
// default, for `/mods` and for the on/off check. The guard itself is the `tool.call`
// hook in register.tsx. It makes no model call, so it costs no tokens.
export const blastRadius = defineFeature<never>({
  id: 'blast-radius',
  title: 'Blast Radius',
  about: 'asks Proceed or Cancel before a risky shell command (rm -rf, git reset --hard, git push --force, ...); costs no model tokens',
  usesModel: false,
  defaultOn: true,
})

// ---- The rule table -------------------------------------------------------------

export type PreviewKind = 'status-all' | 'status-worktree' | 'clean' | 'push' | 'branch' | 'stash' | 'paths'

export type Rule = {
  kind: string
  title: string
  // Tested on one segment, after the prefix (sudo, env vars, ...) is removed.
  regex: RegExp
  // When this also matches, the segment is NOT held (a dry run, a staged-only restore).
  unless?: RegExp
  // How the person is shown what would change.
  preview: PreviewKind
}

// Pieces of the patterns.
const ARGS = String.raw`(?:\s+\S+)*?` // any words between the command and the flag
const END = String.raw`(?=\s|$)` // the end of a word
// `git`, then global options (`-C dir`, `-c k=v`, `--no-pager`), then a space.
const GIT = String.raw`^git(?:\.exe)?(?:\s+(?:-[Cc]\s+\S+|--?[\w-]+(?:=\S+)?))*\s+`

const re = (source: string, flags = '') => new RegExp(source, flags)

export const RULES: readonly Rule[] = [
  // Delete. `rm -f file` and `rm file` (no recursion) are NOT held: one named file at a time.
  { kind: 'rm-recursive', title: 'recursive delete (rm -r)', preview: 'paths',
    regex: re(String.raw`^(?:\S*[\\/])?rm(?:\.exe)?${ARGS}\s+(?:-[fiIrRdv]*[rR][fiIrRdv]*|--recursive)${END}`) },
  { kind: 'rmdir-windows', title: 'recursive delete (rmdir /s)', preview: 'paths',
    regex: re(String.raw`^(?:rmdir|rd)${ARGS}\s+/s(?=[\s/]|$)`, 'i') },
  { kind: 'del-windows', title: 'recursive delete (del /s)', preview: 'paths',
    regex: re(String.raw`^(?:del|erase)${ARGS}\s+/s(?=[\s/]|$)`, 'i') },
  { kind: 'remove-item', title: 'recursive delete (Remove-Item -Recurse)', preview: 'paths',
    regex: re(String.raw`^(?:remove-item|ri|rm|del|erase|rd|rmdir)${ARGS}\s+-r[a-z]*(?=[\s:]|$)`, 'i') },

  // Git: discards work that has no copy.
  { kind: 'git-reset-hard', title: 'git reset --hard', preview: 'status-all',
    regex: re(String.raw`${GIT}reset${ARGS}\s+--hard${END}`) },
  { kind: 'git-clean', title: 'git clean (deletes untracked files)', preview: 'clean',
    regex: re(String.raw`${GIT}clean${ARGS}\s+(?:-[a-zA-Z]*[fdxX][a-zA-Z]*|--force)${END}`),
    unless: re(String.raw`\s(?:-[a-zA-Z]*n[a-zA-Z]*|--dry-run)${END}`) },
  // `--force-with-lease` is held too: it is safer, but it still overwrites remote history.
  { kind: 'git-push-force', title: 'git push --force (rewrites remote history)', preview: 'push',
    regex: re(String.raw`${GIT}push${ARGS}\s+(?:-[a-zA-Z]*f[a-zA-Z]*|--force(?:-with-lease|-if-includes)?(?:=\S+)?|\+[^\s+]\S*)${END}`) },
  { kind: 'git-discard-checkout', title: 'git checkout -- . (discards working changes)', preview: 'status-worktree',
    regex: re(String.raw`${GIT}checkout${ARGS}\s+(?:--\s+)?(?:\.|:/)${END}`) },
  { kind: 'git-discard-restore', title: 'git restore . (discards working changes)', preview: 'status-worktree',
    regex: re(String.raw`${GIT}restore${ARGS}\s+(?:--\s+)?(?:\.|:/)${END}`),
    // `--staged` alone only unstages. With `--worktree` it also discards.
    unless: re(String.raw`^(?=.*\s(?:--staged|-S)${END})(?!.*\s(?:--worktree|-W)${END})`) },
  { kind: 'git-branch-delete', title: 'git branch -D (force-deletes a branch)', preview: 'branch',
    regex: re(String.raw`${GIT}branch${ARGS}\s+-[a-zA-Z]*D[a-zA-Z]*${END}`) },
  { kind: 'git-stash-drop', title: 'git stash drop / clear', preview: 'stash',
    regex: re(String.raw`${GIT}stash\s+(?:drop|clear)${END}`) },
]

// ---- Classifier -------------------------------------------------------------------

// Where one command ends and the next begins. `$(` and a backtick start a nested command.
const SEPARATORS = /&&|\|\||[;|\n\r`]|\$\(|(?<![0-9>&])&(?![&>])/

// What may stand before the real command word: grouping, `!`, VAR=value, sudo, env,
// xargs, time, a backslash that skips an alias, and the shell wrappers `sh -c '...'`,
// `eval '...'`, `cmd /c ...`, `powershell -Command '...'`.
const PREFIX = new RegExp(
  String.raw`^\s*(?:` +
    String.raw`[({!]\s*|\\|[A-Za-z_]\w*=\S*\s+|` +
    String.raw`(?:sudo|doas)(?:\s+(?:-[ughCpUrtT]\s+\S+|-\S+))*\s+|` +
    String.raw`(?:command|builtin|exec|nohup|time|nice|xargs|env)(?:\s+(?:-[IdEeLnPsaui]\s+\S+|-\S+))*\s+|` +
    String.raw`(?:(?:ba|z|da)?sh|eval)(?:\s+-c)?\s+["']?|` +
    String.raw`cmd(?:\.exe)?\s+/[ck]\s+["']?|` +
    String.raw`(?:powershell|pwsh)(?:\.exe)?(?:\s+-\S+)*?\s+-c(?:ommand)?\s+["']?` +
    String.raw`)`,
  'i',
)

export const stripPrefix = (segment: string) => {
  let rest = segment
  while (PREFIX.test(rest)) rest = rest.replace(PREFIX, '')
  return rest.trim()
}

export type Risk = {
  kind: string
  title: string
  preview: PreviewKind
  // The segment as the rule saw it (prefix removed).
  segment: string
  // True when an earlier segment of the command changed directory (`cd x && rm -rf y`).
  // A relative path is then not resolved against the session folder.
  hasCd: boolean
}

const CHANGES_DIRECTORY = /^(?:cd|pushd|chdir|set-location|sl)(?:\s|$)/i

// Every risky segment of `command`, in order. An empty list means: not held.
export const classify = (command: string): Risk[] => {
  const risks: Risk[] = []
  let hasCd = false
  for (const raw of command.split(SEPARATORS)) {
    const segment = stripPrefix(raw)
    if (!segment) continue
    const rule = RULES.find(r => r.regex.test(segment) && !r.unless?.test(segment))
    if (rule) risks.push({ kind: rule.kind, title: rule.title, preview: rule.preview, segment, hasCd })
    if (CHANGES_DIRECTORY.test(segment)) hasCd = true
  }
  return risks
}

// ---- Preview plans: what to read, from the segment's own words --------------------

export const MAX_SHOWN = 10 // paths shown in a list
export const ENTRY_CAP = 1000 // entries counted in a directory, in total
export const MAX_PATHS = 8 // plain paths looked at for one rm
export const MAX_RISKS_PREVIEWED = 3
export const STEP_TIMEOUT_MS = 3000 // for each `git` call
export const OUTPUT_CAP = 200_000 // characters of git output read
export const NO_PREVIEW = 'no preview available'

// The `git` the previews run. Read only, argv (no shell). The command's own global
// options (`-C`, `-c`) are NOT passed on: a `-c core.fsmonitor=...` would run code
// before the person said yes.
export const GIT_READ = ['git', '--no-optional-locks', '-c', 'core.fsmonitor=false'] as const

const unquote = (token: string) => token.replace(/^["']|["')]+$/g, '')
const words = (segment: string) => (segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map(unquote)

// `git <sub> <args...>`. Undefined when global options stand before the subcommand:
// the previews do not follow `-C` or `--git-dir`.
export const gitArgs = (segment: string, sub: string): string[] | undefined => {
  const all = words(segment)
  return /^git(?:\.exe)?$/.test(all[0] ?? '') && all[1] === sub ? all.slice(2) : undefined
}

// True when global options (`-C dir`, `-c k=v`) stand between `git` and the subcommand.
export const hasGitOptions = (segment: string) => !/^git(?:\.exe)?\s+[a-z]/.test(segment)

const SAFE_NAME = /^[\w.\/-]+$/

// `git clean -fd` -> ['clean', '-n', '-d']: the same flags, and `-n` for a dry run.
export const cleanDryRun = (segment: string): string[] | undefined => {
  const args = gitArgs(segment, 'clean')
  if (!args || args.some(a => /[$%]/.test(a))) return undefined
  const kept = args.flatMap(a => {
    if (a === '--force' || a === '--interactive' || a === '--dry-run') return []
    if (/^-[a-zA-Z]+$/.test(a)) {
      const letters = a.slice(1).replace(/[fniq]/g, '')
      return letters ? [`-${letters}`] : []
    }
    return [a]
  })
  return ['clean', '-n', ...kept]
}

export type PushPlan = { range?: string; note?: string }

// Which commits does the force push drop? The ones the remote branch has and the
// local branch has not: `local..remote`.
export const pushPlan = (segment: string): PushPlan => {
  const args = gitArgs(segment, 'push')
  if (!args) return { note: 'the git options of the command are not followed' }
  const places = args.filter(a => !a.startsWith('-')).map(a => a.replace(/^\+/, ''))
  if (places.length <= 1) return { range: 'HEAD..@{u}' }
  const [remote = '', branch = ''] = places
  if (places.length === 2 && /^[\w.-]+$/.test(remote) && SAFE_NAME.test(branch) && !branch.startsWith('-')) {
    return { range: `${branch}..${remote}/${branch}` }
  }
  return { note: `the target "${places.join(' ')}" is not a plain remote and branch, so commits are not counted` }
}

// Names after `git branch -D`: at most 3, plain names only.
export const branchTargets = (segment: string): string[] =>
  (gitArgs(segment, 'branch') ?? []).filter(a => !a.startsWith('-') && SAFE_NAME.test(a)).slice(0, 3)

export type PathArgs = { paths: string[]; skipped: string[] }

// Flags of Remove-Item that take a value which is not a path.
const VALUE_FLAGS = /^-(?:include|exclude|filter|credential|stream)$/i

// The plain path arguments of a delete command. A glob, a variable or `~` cannot be
// resolved here and is listed as skipped.
export const pathArgs = (segment: string): PathArgs => {
  const tokens = words(segment).slice(1)
  const paths: string[] = []
  const skipped: string[] = []
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] ?? ''
    if (VALUE_FLAGS.test(token)) i++
    else if (token === '' || token.startsWith('-') || /^\/[a-zA-Z]$/.test(token) || /^\d*[<>]/.test(token)) continue
    else if (/[*?[\]$%`{}]|^~/.test(token)) skipped.push(token)
    else paths.push(token)
  }
  return { paths, skipped }
}

const isAbsolute = (path: string) => /^(?:[A-Za-z]:)?[\\/]/.test(path)

// A relative path belongs to the session folder. `cwd` joins with `/`, which Windows accepts too.
export const resolvePath = (cwd: string, path: string) => (isAbsolute(path) ? path : `${cwd.replace(/[\\/]+$/, '')}/${path}`)

// ---- Preview text -----------------------------------------------------------------

// What a git read returned. `undefined` (not this type): the step could not run or ran out of time.
export type GitOut = { ok: boolean; text: string; isCut: boolean }
type Out = GitOut | undefined

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const lines = (out: Out) => (out?.ok ? out.text.split(/\r?\n/).filter(Boolean) : undefined)
const more = (n: number) => (n > 0 ? [`  ...and ${n} more`] : [])
const countText = (n: number, isCut: boolean) => (isCut ? `${n}+` : String(n))
const list = (items: readonly string[]) => [...items.slice(0, MAX_SHOWN).map(i => `  ${i}`), ...more(items.length - MAX_SHOWN)]

export const NO_GIT_PREVIEW = `${NO_PREVIEW} (not a git repository, git is missing, or the git read failed)`

// `git status --porcelain` lines are `XY path`: X the index, Y the work tree.
// `scope` 'worktree' counts only what `checkout -- .` / `restore .` would discard.
export const previewStatus = (status: Out, shortstat: Out, scope: 'all' | 'worktree'): string[] => {
  const all = lines(status)
  if (!all || !status) return [NO_GIT_PREVIEW]
  const untracked = all.filter(l => l.startsWith('??')).length
  const tracked = all.filter(l => !l.startsWith('??') && !l.startsWith('!!') && (scope === 'all' || (l[1] ?? ' ') !== ' '))
  const out: string[] = []
  if (tracked.length === 0) {
    out.push(scope === 'all' ? 'no uncommitted changes to tracked files to lose.' : 'no unstaged changes to tracked files to lose.')
  } else {
    out.push(`${countText(tracked.length, status.isCut)} tracked ${tracked.length === 1 ? 'file' : 'files'} with ${scope === 'all' ? 'uncommitted' : 'unstaged'} changes would be overwritten (status, path):`)
    out.push(...list(tracked))
    const stat = lines(shortstat)?.[0]
    if (stat) out.push(`  ${stat.trim()}`)
  }
  if (untracked > 0) out.push(`${plural(untracked, 'untracked file')} not touched.`)
  if (scope === 'all') out.push('A reset to another commit also moves the branch; those commits are not counted here.')
  return out
}

export const previewClean = (dryRun: Out): string[] => {
  const all = lines(dryRun)
  if (!all || !dryRun) return [NO_GIT_PREVIEW]
  const paths = all.filter(l => l.startsWith('Would remove ')).map(l => l.slice('Would remove '.length))
  if (paths.length === 0) return ['git clean -n lists nothing to delete.']
  return [`${countText(paths.length, dryRun.isCut)} untracked ${paths.length === 1 ? 'path' : 'paths'} would be deleted (git clean -n):`, ...list(paths)]
}

export type PushInfo = { branch: Out; upstream: Out; count: Out; log: Out; plan: PushPlan }

export const previewPush = ({ branch, upstream, count, log, plan }: PushInfo): string[] => {
  const name = lines(branch)?.[0]
  const target = lines(upstream)?.[0]
  const out: string[] = []
  if (name) out.push(`current branch: ${name}, upstream: ${target ?? 'none set'}`)
  const n = Number(lines(count)?.[0])
  if (plan.range && Number.isInteger(n)) {
    out.push(
      n === 0
        ? 'the remote branch has no commits that your branch lacks (per the last fetch).'
        : `${plural(n, 'commit')} on the remote would be lost (per the last fetch, ${plan.range}):`,
    )
    const commits = lines(log) ?? []
    if (n > 0) out.push(...list(commits))
  } else {
    out.push('remote history may be overwritten; the lost commits could not be counted.')
  }
  if (plan.note) out.push(plan.note)
  return out.length ? out : [NO_GIT_PREVIEW]
}

export const previewBranch = (items: readonly { name: string; count: Out }[]): string[] => {
  if (items.length === 0) return [NO_PREVIEW]
  return items.map(({ name, count }) => {
    const n = Number(lines(count)?.[0])
    return Number.isInteger(n)
      ? `branch ${name}: ${plural(n, 'commit')} not in the current branch${n > 0 ? ' (only the reflog keeps them after the delete)' : ''}`
      : `branch ${name}: ${NO_PREVIEW}`
  })
}

export const previewStash = (stashes: Out): string[] => {
  const all = lines(stashes)
  if (!all) return [NO_GIT_PREVIEW]
  return [`${plural(all.length, 'stash', 'stashes')} exist. "drop" removes the one named (default stash@{0}); "clear" removes all.`, ...list(all)]
}

// What the engine found for one path.
export type PathFact =
  | { path: string; kind: 'missing' | 'file' | 'other' }
  | { path: string; kind: 'link' }
  | { path: string; kind: 'dir'; entries: number; isCapped: boolean }

export const previewPaths = (facts: readonly PathFact[], args: PathArgs, hasCd: boolean): string[] => {
  const out: string[] = []
  if (hasCd) out.push('an earlier part of the command changes directory, so relative paths are not resolved:')
  for (const f of facts) {
    if (f.kind === 'dir') out.push(`${f.path}: directory, ${f.isCapped ? `${ENTRY_CAP}+` : f.entries} ${f.entries === 1 && !f.isCapped ? 'entry' : 'entries'} inside`)
    else if (f.kind === 'file') out.push(`${f.path}: file`)
    else if (f.kind === 'link') out.push(`${f.path}: symbolic link (the link is removed, its target is not followed)`)
    else if (f.kind === 'other') out.push(`${f.path}: exists, not a plain file or directory`)
    else out.push(`${f.path}: not found`)
  }
  if (args.paths.length > facts.length) out.push(`...and ${args.paths.length - facts.length} more paths not looked at`)
  if (args.skipped.length) out.push(`not previewed (glob or variable): ${args.skipped.slice(0, MAX_SHOWN).join(' ')}`)
  return out.length ? out : [`${NO_PREVIEW} (no plain path in the command)`]
}

// ---- The dialog -------------------------------------------------------------------

export const PROCEED = 'Proceed'
export const CANCEL = 'Cancel'
export const DIALOG_HEADER = 'Blast Radius' // 12 characters: the most the chip takes

const shorten = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}...` : text)

export const buildQuestion = (command: string, risks: readonly Pick<Risk, 'title'>[], preview: readonly string[]): string =>
  [
    `Blast Radius holds this command: ${risks.length ? risks.map(r => r.title).join('; ') : 'it could not be checked'}.`,
    '',
    `  ${shorten(command, 400)}`,
    '',
    'What would change (a best-effort, read-only check):',
    ...preview.map(l => `  ${l}`),
    '',
    'Run it now?',
  ].join('\n')

// Only the exact label Proceed lets the command run. Free text typed under "Other",
// an empty answer and every other label count as Cancel. `answer` is undefined when
// `$.ui.ask` rejected: the dialog was dismissed, or nobody could be asked (`claude -p`).
export const isProceed = (answer: string | undefined) => answer === PROCEED

// What Claude reads when the command is refused.
export const denyReason = (answer: string | undefined, kinds: readonly string[]): string => {
  const what = kinds.join(', ') || 'unchecked'
  const tail = 'It did not run. Do not retry the same command unprompted; ask the person what they want instead.'
  return answer === undefined
    ? `Blast Radius: no confirmation was given for this command (${what}): the dialog was dismissed, or nobody could be asked (a non-interactive run). ${tail}`
    : `Blast Radius: the person cancelled this command (${what}). ${tail}`
}
