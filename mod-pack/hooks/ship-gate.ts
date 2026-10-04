// Ship Gate: two checks on shell commands that leave the machine or the working tree.
//
//   1. Publish gate: before `git push`, `gh repo create`, `gh api .../pages` or `gh repo edit
//      --visibility`, show what would be published (the remote, the visibility, the author
//      e-mails of the unpushed commits, personal strings in the tree) and ask Proceed or Cancel.
//   2. Tested? gate: before `git commit` of code files, deny the commit when no test, type check
//      or validator has passed on the current tree.
//
// Pure: no `$` here. The engine calls (`git`, `gh`, the dialog, the state) are in register.tsx.
//
// ponytail: a safety net, not a policy engine. It reads the command text with the same splitter
// as Blast Radius, so it shares that ceiling: an alias, a script that calls git, or a command built
// from variables is not seen. A `cd` to a path with a variable or `~` is not followed: the commit
// check then lets the command through, and the publish check says it could not look.
// Test detection is a regex over known runners (npm test, tsc, pytest, cargo test, ...). A custom
// script such as ./check.sh is not known: commit with the marker `# ship-gate: skip-tests`.
// The tree fingerprint is the paths of `git status` plus `git diff HEAD`, cut at OUTPUT_CAP characters: an edit
// that changes only an untracked file's content, or only text beyond the cap, is not seen. Staging a tracked
// file is not an edit, but `git add` of a new file after the check adds it to `git diff HEAD` and holds the commit.

import { resolvePath, SAFE_NAME, SEPARATORS, stripPrefix, words } from './blast-radius'
import { defineFeature } from './feature'
import type { ModPackShipGate } from '../types'

export const shipGate = defineFeature<ModPackShipGate>({
  id: 'ship-gate',
  title: 'Ship Gate',
  about: 'asks Proceed or Cancel, with a check for personal info, before git push, gh repo create and Pages; denies git commit of code when no test passed since the last edit; costs no model tokens',
  usesModel: false,
  defaultOn: true,
  last: state => {
    const test = state?.test
    return [state?.gate, test ? `last passing check: ${test.command}` : undefined].filter(Boolean).join('; ') || undefined
  },
})

// ---- Reading a command ------------------------------------------------------------

// Where a git or gh command runs. `path` undefined: the session folder. `isKnown` false: an earlier
// `cd` or a `git -C` named a path that cannot be resolved (a variable, `~`, a glob).
export type Dir = { path: string | undefined; isKnown: boolean }

export type Commit = { dir: Dir; isCovered: boolean; isSkipped: boolean }
export type PublishKind = 'push' | 'create' | 'pages' | 'visibility'
export type Publish = { kind: PublishKind; segment: string; dir: Dir; remote?: string; flag?: string; hasSource: boolean }
export type TestRun = { dir: Dir; name: string }
export type Plan = { commits: Commit[]; publishes: Publish[]; tests: TestRun[] }

export const SKIP_MARKER = 'ship-gate: skip-tests'

// A segment that runs a test, a type check or a validator. A commit is `isCovered` when one stands before
// it in the same command and only `&&` stands between them.
const TEST = new RegExp(
  String.raw`^(?:\.[\/])?(?:` +
    String.raw`(?:(?:npm|pnpm|yarn|bun)(?:\s+run)?\s+(?:test|t|typecheck|check)(?::\S+)?)|` +
    String.raw`(?:(?:npx|bunx|pnpx)(?:\s+-\S+)*\s+|(?:pnpm|yarn)\s+(?:exec|dlx)\s+|(?:\S*node_modules[\\/]\.bin[\\/]))?(?:tsc|vitest|jest|mocha|ava|playwright\s+test)|` +
    String.raw`(?:node\s+(?:\S+\s+)*--test)|` +
    String.raw`(?:(?:py\.?test|pytest|tox|nox|rspec|phpunit|ctest))|` +
    String.raw`(?:python3?(?:\.exe)?\s+-m\s+(?:pytest|unittest))|` +
    String.raw`(?:bundle\s+exec\s+rspec)|` +
    String.raw`(?:cargo\s+(?:test|check|clippy|nextest))|` +
    String.raw`(?:go\s+(?:test|vet))|` +
    String.raw`(?:dotnet\s+test)|` +
    String.raw`(?:mvn(?:w)?\s+(?:\S+\s+)*(?:test|verify))|` +
    String.raw`(?:gradlew?(?:\.bat)?\s+(?:\S+\s+)*(?:test|check))|` +
    String.raw`(?:make\s+(?:test|check))|` +
    String.raw`(?:deno\s+(?:test|check))|` +
    String.raw`(?:claude\s+plugin\s+(?:test|validate))|` +
    String.raw`(?:invoke-pester)` +
    String.raw`)(?=\s|$)`,
  'i',
)

// A path that `cd` or `git -C` can be followed to.
const isPlain = (path: string | undefined): path is string => path !== undefined && path !== '' && path !== '-' && !/[*?[\]$%`{}]|^~/.test(path)

const CHANGES_DIRECTORY = /^(?:cd|pushd|chdir|set-location|sl)(?:\s|$)/i

const cdTarget = (dir: Dir, segment: string): Dir => {
  const target = words(segment).slice(1).find(w => !/^(?:-[A-Za-z]+|\/d)$/i.test(w))
  if (!dir.isKnown || !isPlain(target)) return { path: dir.path, isKnown: false }
  return { path: dir.path === undefined ? target : resolvePath(dir.path, target), isKnown: true }
}

type GitCall = { sub: string; args: string[]; dir: Dir }

// `git [-C path] [-c k=v] [--opt] <sub> <args...>`. Undefined when the segment is not git.
const gitCall = (segment: string, dir: Dir): GitCall | undefined => {
  const all = words(segment)
  if (!/^git(?:\.exe)?$/i.test(all[0] ?? '')) return undefined
  let here = dir
  let i = 1
  for (; i < all.length; i++) {
    const word = all[i] ?? ''
    if (word === '-C') {
      const path = all[++i]
      here = !here.isKnown || !isPlain(path) ? { path: here.path, isKnown: false } : { path: here.path === undefined ? path : resolvePath(here.path, path), isKnown: true }
    } else if (word === '-c') i++
    else if (/^--(?:git-dir|work-tree)/.test(word)) here = { path: here.path, isKnown: false }
    else if (!word.startsWith('-')) break
  }
  return { sub: all[i] ?? '', args: all.slice(i + 1), dir: here }
}

const hasFlag = (args: readonly string[], ...flags: string[]) => args.some(a => flags.includes(a) || flags.some(f => f.startsWith('--') && a.startsWith(`${f}=`)))

const publishOf = (segment: string, dir: Dir): Publish | undefined => {
  const git = gitCall(segment, dir)
  if (git) {
    if (git.sub !== 'push' || hasFlag(git.args, '--dry-run', '-n')) return undefined
    const remote = git.args.find(a => !a.startsWith('-'))
    return { kind: 'push', segment, dir: git.dir, ...(remote ? { remote } : {}), hasSource: false }
  }
  const all = words(segment)
  if (!/^gh(?:\.exe)?$/i.test(all[0] ?? '')) return undefined
  const args = all.slice(1)
  if (args[0] === 'repo' && args[1] === 'create') {
    const flag = args.find(a => a === '--public' || a === '--private' || a === '--internal')
    return { kind: 'create', segment, dir, ...(flag ? { flag } : {}), hasSource: args.some(a => a === '--push' || a.startsWith('--source')) }
  }
  if (args[0] === 'repo' && args[1] === 'edit') {
    const at = args.findIndex(a => a === '--visibility' || a.startsWith('--visibility='))
    const value = at < 0 ? undefined : (args[at] ?? '').includes('=') ? (args[at] ?? '').split('=')[1] : args[at + 1]
    return value === 'public' ? { kind: 'visibility', segment, dir, flag: '--visibility public', hasSource: false } : undefined
  }
  if (args[0] === 'api' && args.some(a => /(?:^|\/)pages(?:$|[/?])/.test(a))) {
    const at = args.findIndex(a => a === '-X' || a === '--method' || /^--method=|^-X./.test(a))
    const method = at < 0 ? undefined : (args[at] ?? '').replace(/^(?:-X|--method=?)/, '') || args[at + 1]
    const changes = method ? method.toUpperCase() !== 'GET' : args.some(a => ['-f', '-F', '--field', '--raw-field', '--input'].includes(a))
    return changes ? { kind: 'pages', segment, dir, hasSource: false } : undefined
  }
  return undefined
}

// Every commit, publish and test-like segment of `command`, in order. `cwd` is the session folder.
export const plan = (command: string, cwd: string | undefined): Plan => {
  const out: Plan = { commits: [], publishes: [], tests: [] }
  const parts = command.split(new RegExp(`(${SEPARATORS.source})`))
  const isSkipped = command.includes(SKIP_MARKER)
  let dir: Dir = { path: cwd, isKnown: true }
  let isTested = false
  for (let i = 0; i < parts.length; i += 2) {
    const segment = stripPrefix(parts[i] ?? '')
    if (segment) {
      if (CHANGES_DIRECTORY.test(segment)) dir = cdTarget(dir, segment)
      else if (TEST.test(segment)) {
        out.tests.push({ dir, name: segment.slice(0, 80) })
        isTested = true
      } else {
        const git = gitCall(segment, dir)
        if (git?.sub === 'commit' && !hasFlag(git.args, '--dry-run')) out.commits.push({ dir: git.dir, isCovered: isTested, isSkipped })
        const publish = publishOf(segment, dir)
        if (publish) out.publishes.push(publish)
      }
    }
    // Only `&&` keeps a passed test in force for the next segment.
    if (parts[i + 1] !== '&&') isTested = false
  }
  return out
}

// ---- The tree fingerprint and the code files --------------------------------------

// FNV-1a over the text, with its length: a stand-in for "the same tree" that needs no library.
export const fingerprintOf = (...texts: string[]): string => {
  const text = texts.join('\u0000')
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193) >>> 0
  return `${hash.toString(16)}:${text.length}`
}

const CODE = /\.(?:[cm]?[jt]sx?|py|rs|go|java|kt|cs|c|cc|cpp|h|hpp|rb|php|swift|sh|ps1|lua|dart|scala|vue|svelte)$/i

// The code files in `git status --porcelain` output (`XY path`, `XY old -> new`, quoted when odd).
export const codeFiles = (status: string): string[] =>
  status
    .split(/\r?\n/)
    .filter(line => line.length > 3 && !line.startsWith('!!'))
    .map(line => line.slice(3).replace(/^.* -> /, '').replace(/^"|"$/g, ''))
    .filter(path => CODE.test(path))

// ---- Tested? gate text ------------------------------------------------------------

const MAX_FILES = 5
const minutes = (ms: number) => Math.max(0, Math.round(ms / 60_000))

export const commitDeny = (files: readonly string[], test: ModPackShipGate['test'], now: number): string => {
  const shown = files.slice(0, MAX_FILES).join(', ') + (files.length > MAX_FILES ? `, and ${files.length - MAX_FILES} more` : '')
  const last = test
    ? `The last passing check was "${test.command}"${Number.isFinite(now) ? `, ${minutes(now - test.at)} min ago` : ''}, on a different tree: files changed since.`
    : 'No test, type check or validator has passed in this session.'
  return [
    `Ship Gate: git commit denied. It includes ${files.length} code ${files.length === 1 ? 'file' : 'files'} (${shown}), and no check passed on the current tree.`,
    last,
    `Run the project's tests (or tsc, or the validator) now, then commit again. If the person says to commit without a test, add the comment "# ${SKIP_MARKER}" to the commit command.`,
  ].join(' ')
}

// ---- Publish gate: terms, facts, dialog -------------------------------------------

const GENERIC_NAMES = new Set(['user', 'users', 'public', 'default', 'admin', 'administrator', 'runner', 'root', 'ubuntu', 'vagrant'])
const NOREPLY = /noreply/i

// The strings that must not be published: the user name in the folder path (`C:\Users\<name>`,
// `/home/<name>`), the git e-mail unless it is a noreply address, and the person's own list
// (the `shipGateTerms` setting, separated by commas or lines). The git user.name is not used: it is
// public in every commit, and in many repos it is the account name that every link contains.
export const personalTerms = (input: { path: string | undefined; email: string | undefined; extra: unknown }): string[] => {
  const found: string[] = []
  const home = /(?:^|[\\/])(?:Users|home)[\\/]([^\\/]+)/i.exec(input.path ?? '')?.[1]
  if (home && home.length >= 3 && !GENERIC_NAMES.has(home.toLowerCase())) found.push(home)
  const email = input.email?.trim()
  if (email && email.includes('@') && !NOREPLY.test(email)) found.push(email)
  if (typeof input.extra === 'string') found.push(...input.extra.split(/[,\n]/).map(t => t.trim()).filter(t => t.length >= 2))
  const seen = new Set<string>()
  return found
    .filter(t => {
      const key = t.toLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .slice(0, 10)
}

export const MAX_HITS = 8

// `git grep -n` output on a tree: `HEAD:path:line:text`. Cut to `path:line: text`.
export const parseHits = (text: string | undefined): { total: number; shown: string[] } => {
  const hits = (text ?? '').split(/\r?\n/).filter(Boolean)
  const shown = hits.slice(0, MAX_HITS).map(line => {
    const m = /^(?:HEAD:)?(.*?):(\d+):(.*)$/.exec(line)
    return m ? `${m[1]}:${m[2]}: ${(m[3] ?? '').trim().slice(0, 80)}` : line.slice(0, 120)
  })
  return { total: hits.length, shown }
}

export type LogFacts = { count: number; offAddresses: string[]; termCommits: number }

// `git log --format=%h<TAB>%ae<TAB>%ce<TAB>%s`: how many commits, which author or committer
// addresses are not noreply addresses, and how many commits carry a personal string in an address or subject.
export const parseLog = (text: string | undefined, terms: readonly string[]): LogFacts => {
  const rows = (text ?? '').split(/\r?\n/).filter(Boolean)
  const off = new Set<string>()
  let termCommits = 0
  for (const row of rows) {
    const [, ae = '', ce = ''] = row.split('\t')
    for (const address of [ae, ce]) if (address && !NOREPLY.test(address)) off.add(address)
    const lower = row.toLowerCase()
    if (terms.some(t => lower.includes(t.toLowerCase()))) termCommits++
  }
  return { count: rows.length, offAddresses: [...off].slice(0, 5), termCommits }
}

// `https://user:token@host/x` -> `https://***@host/x`: a credential never reaches the dialog.
export const redactUrl = (url: string) => url.replace(/\/\/[^/@\s]+@/, '//***@')

export const GITHUB_SLUG = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/

export const NO_LOOK = 'not looked at'

export type PublishFacts = {
  kind: PublishKind
  remote?: string
  url?: string
  // Text from `gh repo view --json visibility`: PUBLIC, PRIVATE or INTERNAL. Undefined when it could not be read.
  visibility?: string
  flag?: string
  hasSource: boolean
  isFolderKnown: boolean
  terms: readonly string[]
  // Raw `git log` text of the unpushed commits, when it could be read.
  log?: string
  // Raw `git grep` text. `grepRan`: the search ran (an empty text then means no hit).
  hits?: string
  grepRan: boolean
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

export const describePublish = (f: PublishFacts): string[] => {
  const out: string[] = []
  if (!f.isFolderKnown) return ['the folder of the command could not be resolved (a variable or ~ in a cd or git -C), so nothing was looked at.']

  if (f.kind === 'push') {
    out.push(`remote ${f.remote ?? 'unknown'}: ${f.url ? redactUrl(f.url) : 'url not readable'}${f.visibility ? ` (${f.visibility.toLowerCase()})` : ' (visibility not readable)'}`)
  } else if (f.kind === 'create') {
    out.push(`creates a repository: ${f.flag ?? 'no visibility flag (gh asks, or defaults to private)'}${f.hasSource ? '; pushes the local folder' : ''}`)
  } else if (f.kind === 'visibility') {
    out.push(`makes the repository public${f.visibility ? ` (now ${f.visibility.toLowerCase()})` : ''}`)
  } else {
    out.push(`changes GitHub Pages: serves the repository files as a web page${f.visibility ? ` (repository is ${f.visibility.toLowerCase()})` : ''}`)
  }

  if (f.kind === 'push') {
    if (f.log === undefined) out.push('unpushed commits: could not be listed.')
    else {
      const facts = parseLog(f.log, f.terms)
      out.push(`${plural(facts.count, 'unpushed commit')}.`)
      if (facts.offAddresses.length) out.push(`author or committer addresses that are not noreply addresses: ${facts.offAddresses.join(', ')}`)
      else if (facts.count > 0) out.push('every author and committer address is a noreply address.')
      if (facts.termCommits > 0) out.push(`${plural(facts.termCommits, 'commit')} with a personal string in an address or subject.`)
    }
  }

  if (f.terms.length === 0) {
    if (f.kind === 'push' || f.hasSource) out.push('personal strings: none to search for (no user name in the path, no non-noreply git e-mail, no shipGateTerms).')
  } else if (f.grepRan) {
    const { total, shown } = parseHits(f.hits)
    out.push(
      total === 0
        ? `personal strings (${f.terms.join(', ')}): no hit in the text files at HEAD.`
        : `personal strings (${f.terms.join(', ')}): ${plural(total, 'line')} in the text files at HEAD${total > shown.length ? `, first ${shown.length}` : ''}:`,
    )
    out.push(...shown.map(l => `  ${l}`))
    out.push('binary files (images) are not searched.')
  } else if (f.kind === 'push' || f.hasSource) out.push(`personal strings (${f.terms.join(', ')}): ${NO_LOOK} (git grep failed, or nothing is committed yet).`)
  return out
}

export const SHIP_HEADER = 'Ship Gate' // 9 characters: the chip takes 12

const shorten = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}...` : text)

export const publishTitle = (kind: PublishKind) =>
  ({ push: 'git push (publishes commits)', create: 'gh repo create (creates a repository)', pages: 'gh api pages (changes GitHub Pages)', visibility: 'gh repo edit --visibility public' })[kind]

export const buildPublishQuestion = (command: string, kinds: readonly PublishKind[], facts: readonly string[]): string =>
  [
    `Ship Gate holds this command: ${kinds.map(publishTitle).join('; ')}.`,
    '',
    `  ${shorten(command, 400)}`,
    '',
    'What it would publish (a best-effort, read-only check):',
    ...facts.map(l => `  ${l}`),
    '',
    'Run it now?',
  ].join('\n')

// What Claude reads when the command is refused.
export const publishDeny = (answer: string | undefined, kinds: readonly PublishKind[]): string => {
  const what = kinds.join(', ')
  const tail = 'It did not run. Do not retry the same command unprompted; ask the person what they want instead.'
  return answer === undefined
    ? `Ship Gate: no confirmation was given for this command (${what}): the dialog was dismissed, or nobody could be asked (a non-interactive run). ${tail}`
    : `Ship Gate: the person cancelled this command (${what}). ${tail}`
}

// The gate itself crashed before a publish command ran: the command is refused, never let through unchecked.
export const publishFailedDeny = 'Ship Gate: its own check failed before this publish command ran, so the command did not run. Tell the person, and run it again.'
