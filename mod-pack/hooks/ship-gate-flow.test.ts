// The decision flow of Ship Gate through the plugin. The engine is stubbed beneath the plugin:
// `tool.call` for AskUserQuestion (the dialog `$.ui.ask` opens), `process.run` (git and gh), `session.cwd`,
// the clock, the store, and a `tool.call` for Bash and PowerShell that records whether a command was let
// through. No dialog is drawn here: the stub plays the person. Blast Radius is ON in every test, as in a
// real session, so the two guards run in the same hook.

import { test, expect, mock } from 'claude-code/testing'

type Reply = { say: string } | 'dismiss' | 'throw'
type Out = { code?: number; out?: string }

type Config = {
  reply: Reply
  status: string // `git status --porcelain -uall`
  diff: string // `git diff HEAD`
  statusCode: number // 128: git cannot read the folder
  email: string
  upstream: string // `git rev-parse --abbrev-ref @{u}`; '' means no upstream
  head: boolean
  url: string
  log: string
  grep: string // '' means no match (git grep ends with 1)
  visibility: string // `gh repo view`; '' means gh fails
  runThrows: boolean
  storeDown: boolean
  commandFails: boolean // the shell tool answers with isError
  commandInterrupted: boolean
}

const MIN = 60_000
const NOREPLY = '1+me@users.noreply.github.com'

const world = (on: any, init: Partial<Config> = {}) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = {
    clock,
    cfg: {
      reply: { say: 'Proceed' },
      status: ' M src/app.ts\n',
      diff: 'diff --git a/src/app.ts b/src/app.ts\n+one\n',
      statusCode: 0,
      email: NOREPLY,
      upstream: 'origin/main',
      head: true,
      url: 'https://github.com/me/repo.git',
      log: `a1\t${NOREPLY}\t${NOREPLY}\tfix one\nb2\t${NOREPLY}\t${NOREPLY}\tfix two\n`,
      grep: '',
      visibility: 'PUBLIC',
      runThrows: false,
      storeDown: false,
      commandFails: false,
      commandInterrupted: false,
      ...init,
    } as Config,
    reached: [] as string[],
    questions: [] as { question: string; header: string; labels: string[] }[],
    runs: [] as { argv: string[]; cwd?: string }[],
  }
  if (init.storeDown) {
    on('store.get', () => {
      throw new Error('store is down')
    })
  } else {
    mock.store(on)
  }
  on('session.cwd', () => ({ value: '/work' }))
  on('process.run', (_$: any, e: any) => {
    const argv: string[] = e.argv
    w.runs.push({ argv, cwd: e.init?.cwd })
    if (w.cfg.runThrows) throw new Error('process is down')
    const done = (r: Out) => ({ value: { exitCode: r.code ?? 0, stdout: r.out ?? '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (argv[0] === 'gh') return done(w.cfg.visibility ? { out: `${w.cfg.visibility}\n` } : { code: 1 })
    // argv is: git --no-optional-locks -c core.fsmonitor=false <args...>
    const [sub = '', first = ''] = argv.slice(4)
    const c = w.cfg
    if (sub === 'status') return done(c.statusCode ? { code: c.statusCode } : { out: c.status })
    if (sub === 'diff') return done({ out: c.diff })
    if (sub === 'config') return done(c.email ? { out: `${c.email}\n` } : { code: 1 })
    if (sub === 'rev-parse' && first === '--abbrev-ref') return done(c.upstream ? { out: `${c.upstream}\n` } : { code: 128 })
    if (sub === 'rev-parse') return done(c.head ? { out: 'abc\n' } : { code: 128 })
    if (sub === 'remote') return done(c.url ? { out: `${c.url}\n` } : { code: 128 })
    if (sub === 'log') return done({ out: c.log })
    if (sub === 'grep') return done(c.grep ? { out: c.grep } : { code: 1 })
    return done({})
  })
  on('tool.call', { tool: 'AskUserQuestion' }, (_$: any, e: any) => {
    const q = e.questions[0]
    w.questions.push({ question: q.question, header: q.header, labels: q.options.map((o: any) => o.label) })
    const r = w.cfg.reply
    if (r === 'throw') throw new Error('no UI')
    if (r === 'dismiss') return { deny: 'dismissed' }
    return { result: { questions: e.questions, answers: { [q.question]: r.say } } } as any
  })
  for (const tool of ['Bash', 'PowerShell'] as const) {
    on('tool.call', { tool }, (_$: any, e: any) => {
      w.reached.push(e.command)
      const result = { stdout: 'ran', stderr: '', interrupted: w.cfg.commandInterrupted }
      return (w.cfg.commandFails ? { result, isError: true } : { result }) as any
    })
  }
  return w
}

const bash = (command: string) => ({ tool: 'Bash' as const, command })
const slash = (args: string) => ({ command: 'mods', args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 100 } })
const say = (text: string): Reply => ({ say: text })
const gitRuns = (w: { runs: { argv: string[] }[] }) => w.runs.filter(r => r.argv[0] === 'git').map(r => r.argv.slice(4))

// ---- Tested? gate -----------------------------------------------------------------

test('commit of a code file with no passing check in the session: denied, with the files and the way out', async ($, on) => {
  const w = world(on)
  const result: any = await $.tool.call(bash('git commit -am "x"'))
  expect(result.deny).toContain('git commit denied')
  expect(result.deny).toContain('1 code file (src/app.ts)')
  expect(result.deny).toContain('No test, type check or validator has passed in this session.')
  expect(result.deny).toContain('# ship-gate: skip-tests')
  expect(w.reached).toEqual([])
  expect(w.questions).toEqual([])
})

test('a passing test, then a commit on the same tree: the commit goes through', async ($, on) => {
  const w = world(on)
  await $.tool.call(bash('npm test'))
  const result: any = await $.tool.call(bash('git commit -am "x"'))
  expect(result.deny).toBeUndefined()
  expect(w.reached).toEqual(['npm test', 'git commit -am "x"'])
})

test('a passing test, then an edit, then a commit: denied, and the reason names the last check and its age', async ($, on) => {
  const w = world(on)
  await $.tool.call(bash('npx --no-install tsc -p .'))
  await w.clock.advance(9 * MIN)
  w.cfg.diff += '+two\n'
  const result: any = await $.tool.call(bash('git commit -am "x"'))
  expect(result.deny).toContain('"npx --no-install tsc -p .", 9 min ago')
  expect(result.deny).toContain('files changed since')
  expect(w.reached).toEqual(['npx --no-install tsc -p .'])
})

test('a new file after the test (same diff, longer status) also makes the tree different', async ($, on) => {
  const w = world(on)
  await $.tool.call(bash('npm test'))
  w.cfg.status += '?? src/new.ts\n'
  expect(((await $.tool.call(bash('git commit -am "x"'))) as any).deny).toContain('2 code files (src/app.ts, src/new.ts)')
})

test('staging after the check is not an edit: the same paths and the same diff, the commit goes through', async ($, on) => {
  const w = world(on)
  await $.tool.call(bash('npm test'))
  w.cfg.status = 'M  src/app.ts\n' // the stub shows ` M` before and `M ` after `git add`; the diff is the same
  expect(((await $.tool.call(bash('git commit -m "x"'))) as any).deny).toBeUndefined()
  expect(w.reached).toEqual(['npm test', 'git commit -m "x"'])
})

test('a failing test does not count; neither does an interrupted one', async ($, on) => {
  const w = world(on)
  w.cfg.commandFails = true
  await $.tool.call(bash('npm test'))
  expect(((await $.tool.call(bash('git commit -am "x"'))) as any).deny).toContain('git commit denied')
  w.cfg.commandFails = false
  w.cfg.commandInterrupted = true
  await $.tool.call(bash('npm test'))
  expect(((await $.tool.call(bash('git commit -am "x"'))) as any).deny).toContain('git commit denied')
  w.cfg.commandInterrupted = false
  await $.tool.call(bash('npm test'))
  expect(((await $.tool.call(bash('git commit -am "x"'))) as any).deny).toBeUndefined()
})

test('npm test && git commit in one command: allowed. With ; between, denied', async ($, on) => {
  const w = world(on)
  expect(((await $.tool.call(bash('npm test && git commit -am "x"'))) as any).deny).toBeUndefined()
  expect(w.reached).toEqual(['npm test && git commit -am "x"'])
  // The tree changes. A test that comes before the commit with ; between is not a promise that it passes.
  w.cfg.diff += '+two\n'
  expect(((await $.tool.call(bash('npm test; git commit -am "y"'))) as any).deny).toContain('git commit denied')
  expect(w.reached).toHaveLength(1)
})

test('the skip marker lets the commit go, and git is not even asked', async ($, on) => {
  const w = world(on)
  const result: any = await $.tool.call(bash('git commit -am "docs" # ship-gate: skip-tests'))
  expect(result.deny).toBeUndefined()
  expect(w.reached).toHaveLength(1)
  expect(gitRuns(w)).toEqual([])
})

test('a commit of text files only (docs, html, json) is not held', async ($, on) => {
  const w = world(on, { status: ' M docs/index.html\n M README.md\n?? notes.txt\n' })
  expect(((await $.tool.call(bash('git commit -am "docs"'))) as any).deny).toBeUndefined()
  expect(w.reached).toHaveLength(1)
})

test('git cannot read the folder: the commit is not held (it cannot be judged)', async ($, on) => {
  const w = world(on, { statusCode: 128 })
  expect(((await $.tool.call(bash('git commit -am "x"'))) as any).deny).toBeUndefined()
  expect(w.reached).toHaveLength(1)
})

test('a cd to a path with a variable: not held, and git is not asked', async ($, on) => {
  const w = world(on)
  expect(((await $.tool.call(bash('cd "$REPO" && git commit -am "x"'))) as any).deny).toBeUndefined()
  expect(gitRuns(w)).toEqual([])
})

test('cd /repo && git commit: git runs in /repo, not in the session folder', async ($, on) => {
  const w = world(on)
  await $.tool.call(bash('cd /repo && git commit -am "x"'))
  const reads = w.runs.filter(r => r.argv[0] === 'git')
  expect(reads.length).toBeGreaterThan(0)
  expect(reads.every(r => r.cwd?.replace(/^[A-Za-z]:/, '').replace(/\\/g, '/') === '/repo')).toBe(true)
})

test('a test run in one folder and a commit with git -C of the same tree: allowed', async ($, on) => {
  world(on)
  await $.tool.call(bash('cd /repo && npm test'))
  expect(((await $.tool.call(bash('git -C /repo commit -am "x"'))) as any).deny).toBeUndefined()
})

test('a test whose folder cannot be followed is not recorded', async ($, on) => {
  world(on)
  await $.tool.call(bash('cd "$REPO" && npm test'))
  expect(((await $.tool.call(bash('git commit -am "x"'))) as any).deny).toContain('git commit denied')
})

test('the PowerShell tool is gated the same way', async ($, on) => {
  const w = world(on)
  const denied: any = await $.tool.call({ tool: 'PowerShell' as const, command: 'git commit -am "x"' })
  expect(denied.deny).toContain('git commit denied')
  await $.tool.call({ tool: 'PowerShell' as const, command: 'npm test' })
  expect(((await $.tool.call({ tool: 'PowerShell' as const, command: 'git commit -am "x"' })) as any).deny).toBeUndefined()
  expect(w.reached).toEqual(['npm test', 'git commit -am "x"'])
})

test('after a commit the tree is new again: the next code edit needs its own check', async ($, on) => {
  const w = world(on)
  await $.tool.call(bash('npm test && git commit -am "x"'))
  // The commit emptied the tree; a new edit follows. The stub shows a changed tree.
  w.cfg.status = ' M src/other.ts\n'
  w.cfg.diff = '+edit\n'
  expect(((await $.tool.call(bash('git commit -am "y"'))) as any).deny).toContain('git commit denied')
})

test('commands that are not a commit, a push or a test: no git, no state, straight through', async ($, on) => {
  const w = world(on)
  await $.tool.call(bash('ls -la && git status && git log --oneline'))
  expect(w.reached).toHaveLength(1)
  expect(gitRuns(w)).toEqual([])
  expect(w.questions).toEqual([])
})

test('/mods off ship-gate: the commit and the push pass; /mods on holds them again', async ($, on) => {
  const w = world(on, { reply: say('Cancel') })
  expect(((await $.command.run(slash('off ship-gate'))) as any).text).toBe('mod-pack: ship-gate is OFF.')
  expect(((await $.tool.call(bash('git commit -am "x"'))) as any).deny).toBeUndefined()
  await $.tool.call(bash('git push'))
  expect(w.questions).toEqual([])
  expect(w.reached).toHaveLength(2)

  await $.command.run(slash('on ship-gate'))
  expect(((await $.tool.call(bash('git commit -am "y"'))) as any).deny).toContain('git commit denied')
  expect(((await $.tool.call(bash('git push'))) as any).deny).toContain('cancelled')
})

test('the shipGate setting off: nothing is held. A /mods on choice beats the setting.', { options: { shipGate: false } }, async ($, on) => {
  const w = world(on, { reply: say('Cancel') })
  expect(((await $.tool.call(bash('git commit -am "x"'))) as any).deny).toBeUndefined()
  await $.tool.call(bash('git push'))
  expect(w.questions).toEqual([])
  await $.command.run(slash('on ship-gate'))
  expect(((await $.tool.call(bash('git commit -am "y"'))) as any).deny).toBeDefined()
})

test('/mods lists Ship Gate ON by default, with no token or sound flag, and says what it last did', async ($, on) => {
  world(on)
  let list = await $.command.run(slash(''))
  expect(list.text).toMatch(/ON\s+ship-gate\s+Ship Gate: asks Proceed or Cancel/)
  const line = (list.text ?? '').split('\n').find(l => l.includes('ship-gate')) ?? ''
  expect(line).not.toContain('[')
  expect(line).toContain('costs no model tokens')

  await $.tool.call(bash('git commit -am "x"'))
  list = await $.command.run(slash(''))
  expect(list.text).toContain('denied a commit of 1 code file: no passing check on this tree')
  await $.tool.call(bash('npm test'))
  list = await $.command.run(slash(''))
  expect(list.text).toContain('last passing check: npm test')
})

// ---- Publish gate -----------------------------------------------------------------

test('git push: the dialog shows the remote with the credential hidden, visibility, commits, addresses; Proceed runs it', async ($, on) => {
  const w = world(on, { url: 'https://user:ghp_secret@github.com/me/repo.git' })
  const result: any = await $.tool.call(bash('git push'))
  expect(w.questions).toHaveLength(1)
  const [asked] = w.questions
  expect(asked?.header).toBe('Ship Gate')
  expect(asked?.labels).toEqual(['Proceed', 'Cancel'])
  expect(asked?.question).toContain('Ship Gate holds this command: git push (publishes commits).')
  expect(asked?.question).toContain('remote origin: https://***@github.com/me/repo.git (public)')
  expect(asked?.question).not.toContain('ghp_secret')
  expect(asked?.question).toContain('2 unpushed commits.')
  expect(asked?.question).toContain('every author and committer address is a noreply address.')
  expect(asked?.question.endsWith('Run it now?')).toBe(true)
  expect(result.deny).toBeUndefined()
  expect(w.reached).toEqual(['git push'])
})

test('git push + Cancel: denied, never reached; dismissed and no one to ask: denied too', async ($, on) => {
  const w = world(on, { reply: say('Cancel') })
  expect(((await $.tool.call(bash('git push'))) as any).deny).toContain('the person cancelled this command (push)')
  w.cfg.reply = 'dismiss'
  expect(((await $.tool.call(bash('git push'))) as any).deny).toContain('no confirmation was given')
  w.cfg.reply = 'throw'
  expect(((await $.tool.call(bash('git push'))) as any).deny).toContain('non-interactive')
  w.cfg.reply = say('sure')
  expect(((await $.tool.call(bash('git push'))) as any).deny).toContain('cancelled')
  expect(w.reached).toEqual([])
  expect(w.questions).toHaveLength(4)
})

test('git push --dry-run and git push -n are not held', async ($, on) => {
  const w = world(on, { reply: say('Cancel') })
  await $.tool.call(bash('git push --dry-run'))
  await $.tool.call(bash('git push -n origin main'))
  expect(w.questions).toEqual([])
  expect(w.reached).toHaveLength(2)
})

test('an author e-mail that is not a noreply address is shown, and so is the e-mail as a search term', async ($, on) => {
  const w = world(on, {
    email: 'me@home.net',
    log: 'a1\tme@home.net\tme@home.net\tfix one\n',
    grep: 'HEAD:docs/a.md:7:contact me@home.net\n',
  })
  await $.tool.call(bash('git push'))
  const text = w.questions[0]?.question ?? ''
  expect(text).toContain('author or committer addresses that are not noreply addresses: me@home.net')
  expect(text).toContain('1 commit with a personal string in an address or subject.')
  expect(text).toContain('personal strings (me@home.net): 1 line in the text files at HEAD:')
  expect(text).toContain('docs/a.md:7: contact me@home.net')
  const grep = gitRuns(w).find(a => a[0] === 'grep')
  expect(grep).toEqual(['grep', '-n', '-I', '-i', '-F', '-e', 'me@home.net', 'HEAD'])
})

test('the user name in the folder path is searched; hits are listed as path:line: text', async ($, on) => {
  const w = world(on, { grep: 'HEAD:README.md:3:path C:\\Users\\alice\\x\nHEAD:docs/b.md:9:alice wrote this\n' })
  await $.tool.call(bash('cd /home/alice/repo && git push'))
  const text = w.questions[0]?.question ?? ''
  expect(text).toContain('personal strings (alice): 2 lines in the text files at HEAD:')
  expect(text).toContain('README.md:3: path C:\\Users\\alice\\x')
  expect(text).toContain('docs/b.md:9: alice wrote this')
  expect(text).toContain('binary files (images) are not searched.')
})

test('the shipGateTerms setting adds strings to the search', { options: { shipGateTerms: 'Jane Doe, acme-corp' } }, async ($, on) => {
  const w = world(on)
  await $.tool.call(bash('git push'))
  const grep = gitRuns(w).find(a => a[0] === 'grep') ?? []
  expect(grep).toContain('Jane Doe')
  expect(grep).toContain('acme-corp')
  expect(w.questions[0]?.question).toContain('personal strings (Jane Doe, acme-corp): no hit in the text files at HEAD.')
})

test('a push with nothing to search for says so and runs no grep', async ($, on) => {
  const w = world(on)
  await $.tool.call(bash('git push'))
  expect(w.questions[0]?.question).toContain('none to search for')
  expect(gitRuns(w).some(a => a[0] === 'grep')).toBe(false)
})

test('a push to a named remote lists the commits that the remote branches lack, and names its url', async ($, on) => {
  const w = world(on, { url: 'git@github.com:me/other.git' })
  await $.tool.call(bash('git push backup main'))
  expect(w.questions[0]?.question).toContain('remote backup: git@github.com:me/other.git (public)')
  const log = gitRuns(w).find(a => a[0] === 'log') ?? []
  expect(log).toEqual(['log', '-n', '200', '--format=%h%x09%ae%x09%ce%x09%s', 'HEAD', '--not', '--remotes=backup'])
  const view = w.runs.find(r => r.argv[0] === 'gh')
  expect(view?.argv).toEqual(['gh', 'repo', 'view', 'me/other', '--json', 'visibility', '--jq', '.visibility'])
})

test('no upstream and no remote named: the remote is origin, and the range is everything the remote lacks', async ($, on) => {
  const w = world(on, { upstream: '' })
  await $.tool.call(bash('git push'))
  expect(w.questions[0]?.question).toContain('remote origin:')
  const log = gitRuns(w).find(a => a[0] === 'log') ?? []
  expect(log.slice(-3)).toEqual(['HEAD', '--not', '--remotes=origin'])
})

test('gh and git cannot be read: the dialog still shows, saying what is missing', async ($, on) => {
  const w = world(on, { runThrows: true })
  await $.tool.call(bash('git push'))
  expect(w.questions).toHaveLength(1)
  expect(w.questions[0]?.question).toContain('url not readable (visibility not readable)')
  expect(w.questions[0]?.question).toContain('unpushed commits: could not be listed.')
  expect(w.reached).toEqual(['git push'])
})

test('gh repo create --public --source=. --push: one dialog with the flag, the tree searched', async ($, on) => {
  const w = world(on, { grep: 'HEAD:a.md:1:alice\n' })
  await $.tool.call(bash('cd /home/alice/p && gh repo create me/p --public --source=. --push'))
  const text = w.questions[0]?.question ?? ''
  expect(text).toContain('gh repo create (creates a repository)')
  expect(text).toContain('creates a repository: --public; pushes the local folder')
  expect(text).toContain('personal strings (alice): 1 line in the text files at HEAD:')
  expect(w.reached).toHaveLength(1)
})

test('gh repo create --private with no source: held, but the tree is not searched', async ($, on) => {
  const w = world(on)
  await $.tool.call(bash('cd /home/alice/p && gh repo create me/p --private'))
  expect(w.questions[0]?.question).toContain('--private')
  expect(gitRuns(w).some(a => a[0] === 'grep')).toBe(false)
})

test('gh api pages with a change is held; a read of the build status is not', async ($, on) => {
  const w = world(on)
  await $.tool.call(bash('gh api -X POST repos/me/repo/pages -f "source[branch]=main"'))
  expect(w.questions).toHaveLength(1)
  expect(w.questions[0]?.question).toContain('changes GitHub Pages')
  await $.tool.call(bash('gh api repos/me/repo/pages/builds/latest --jq .status'))
  expect(w.questions).toHaveLength(1)
  expect(w.reached).toHaveLength(2)
})

test('gh repo edit --visibility public is held', async ($, on) => {
  const w = world(on, { reply: say('Cancel') })
  const denied: any = await $.tool.call(bash('gh repo edit me/repo --visibility public --accept-visibility-change-consequences'))
  expect(denied.deny).toContain('(visibility)')
  expect(w.questions[0]?.question).toContain('makes the repository public (now public)')
})

test('two publish parts in one command: one dialog, both named', async ($, on) => {
  const w = world(on)
  await $.tool.call(bash('git push && gh api -X POST repos/me/repo/pages -f a=b'))
  expect(w.questions).toHaveLength(1)
  expect(w.questions[0]?.question).toContain('git push (publishes commits); gh api pages (changes GitHub Pages)')
})

test('an unknown folder: the dialog still asks, and says nothing was looked at', async ($, on) => {
  const w = world(on)
  await $.tool.call(bash('cd "$REPO" && git push'))
  expect(w.questions[0]?.question).toContain('could not be resolved')
  expect(gitRuns(w)).toEqual([])
})

test('the publish checks run only read-only git: config, rev-parse, remote get-url, log, grep', async ($, on) => {
  const w = world(on, { email: 'me@home.net' })
  await $.tool.call(bash('git push'))
  const subs = new Set(gitRuns(w).map(a => a[0]))
  expect([...subs].sort()).toEqual(['config', 'grep', 'log', 'remote', 'rev-parse'])
  for (const argv of w.runs.map(r => r.argv).filter(a => a[0] === 'git')) expect(argv.slice(0, 4)).toEqual(['git', '--no-optional-locks', '-c', 'core.fsmonitor=false'])
})

// ---- with Blast Radius ------------------------------------------------------------

test('git push --force: Blast Radius asks first, then Ship Gate; Cancel at the first stops the second', async ($, on) => {
  const w = world(on)
  await $.tool.call(bash('git push --force origin main'))
  expect(w.questions.map(q => q.header)).toEqual(['Blast Radius', 'Ship Gate'])
  expect(w.reached).toEqual(['git push --force origin main'])

  w.questions.length = 0
  w.reached.length = 0
  w.cfg.reply = say('Cancel')
  const denied: any = await $.tool.call(bash('git push --force origin main'))
  expect(w.questions.map(q => q.header)).toEqual(['Blast Radius'])
  expect(denied.deny).toContain('Blast Radius')
  expect(w.reached).toEqual([])
})

// ---- the guard crashes ------------------------------------------------------------

test('the guard crashes on a publish: it is refused, not let through', async ($, on) => {
  const w = world(on, { storeDown: true })
  const denied: any = await $.tool.call(bash('git push origin main'))
  expect(denied.deny).toContain('Ship Gate: its own check failed')
  expect(w.reached).toEqual([])
})

test('the guard crashes on a commit or a safe command: it goes through', async ($, on) => {
  const w = world(on, { storeDown: true })
  expect(((await $.tool.call(bash('git commit -am "x"'))) as any).deny).toBeUndefined()
  await $.tool.call(bash('ls'))
  expect(w.reached).toEqual(['git commit -am "x"', 'ls'])
})
