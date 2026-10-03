// The decision flow of Blast Radius through the plugin. The engine is stubbed beneath
// the plugin: `tool.call` for AskUserQuestion (the dialog `$.ui.ask` opens), `process.run`,
// `fs.stat`, `fs.list`, `session.cwd`, and a `tool.call` for Bash and PowerShell that
// records whether a command was let through. No dialog is drawn here: the stub plays the person.

import { test, expect, mock } from 'claude-code/testing'

// What the stub person does when the dialog opens.
type Reply = { say: string } | 'dismiss' | 'throw'

type Fs = { stat?: (path: string) => unknown; list?: (path: string) => unknown[] }

type Config = {
  reply: Reply
  git: (args: string[]) => string | Error
  fs: Fs
  storeDown: boolean // $.store.get throws: the guard itself crashes
  bashThrows: boolean // the command stub throws: the command itself fails
}

const FILE = { kind: 'file', size: 1, mtimeMs: 0, isLink: false }
const DIR = { kind: 'dir', size: 0, mtimeMs: 0, isLink: false }

// `w.cfg` can be changed in the middle of a test: the stubs read it at each call.
// (A second `on('process.run', ...)` in one test would be a repeat, so a test calls `world` once.)
const world = (on: any, init: Partial<Config> = {}) => {
  const w = {
    cfg: { reply: { say: 'Proceed' }, git: () => '', fs: {}, storeDown: false, bashThrows: false, ...init } as Config,
    reached: [] as string[], // commands that got past Blast Radius to the stub below it
    questions: [] as { question: string; header: string; labels: string[] }[],
    runs: [] as { argv: string[]; cwd?: string }[],
    stats: [] as string[],
    lists: [] as string[],
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
    w.runs.push({ argv: e.argv, cwd: e.init?.cwd })
    const result = w.cfg.git(e.argv)
    if (result instanceof Error) throw result
    return { value: { exitCode: 0, stdout: result, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.stat', (_$: any, e: any) => {
    const path = slashStyle(e.path)
    w.stats.push(path)
    const stat = w.cfg.fs.stat?.(path)
    if (!stat) throw new Error('ENOENT')
    return { value: stat }
  })
  on('fs.list', (_$: any, e: any) => {
    const path = slashStyle(e.path)
    w.lists.push(path)
    return { value: w.cfg.fs.list?.(path) ?? [] }
  })
  on('tool.call', { tool: 'AskUserQuestion' }, (_$: any, e: any) => {
    const q = e.questions[0]
    w.questions.push({ question: q.question, header: q.header, labels: q.options.map((o: any) => o.label) })
    const r = w.cfg.reply
    if (r === 'throw') throw new Error('no UI')
    if (r === 'dismiss') return { deny: 'dismissed' }
    return { result: { questions: e.questions, answers: { [q.question]: r.say } } } as any
  })
  on('tool.call', { tool: 'Read' }, () => ({ result: { type: 'text', file: { filePath: 'x', content: '', numLines: 0, startLine: 1, totalLines: 0 } } }) as any)
  for (const tool of ['Bash', 'PowerShell'] as const) {
    on('tool.call', { tool }, (_$: any, e: any) => {
      if (w.cfg.bashThrows) throw new Error('the shell died')
      w.reached.push(e.command)
      return { result: { stdout: 'ran', stderr: '', interrupted: false } } as any
    })
  }
  return w
}

const bash = (command: string) => ({ tool: 'Bash' as const, command })
const slash = (args: string) => ({ command: 'mods', args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 100 } })
const say = (text: string): Reply => ({ say: text })

// The engine hands the stubs a native path (C:\work\build on Windows). Compare slash-style, without a drive.
const slashStyle = (path: string) => path.replace(/^[A-Za-z]:/, '').replace(/\\/g, '/')

const entry = (name: string, kind: 'file' | 'dir' | 'other' = 'file', isLink = false) => ({ name, kind, size: 1, mtimeMs: 0, isLink })

// ---- the decision ----

test('risky command + Proceed: the dialog is shown, then the command runs untouched', async ($, on) => {
  const w = world(on)
  const result: any = await $.tool.call(bash('rm -rf build'))
  expect(w.questions).toHaveLength(1)
  expect(w.reached).toEqual(['rm -rf build'])
  expect(result.deny).toBeUndefined()
  expect(result.result).toEqual({ stdout: 'ran', stderr: '', interrupted: false })
})

test('the dialog: header, exactly two options Proceed and Cancel, the kind and the exact command', async ($, on) => {
  const w = world(on)
  await $.tool.call(bash('cd x && git push --force origin main'))
  const [asked] = w.questions
  expect(asked?.header).toBe('Blast Radius')
  expect(asked?.labels).toEqual(['Proceed', 'Cancel'])
  expect(asked?.question).toContain('git push --force (rewrites remote history)')
  expect(asked?.question).toContain('cd x && git push --force origin main')
  expect(asked?.question).toContain('What would change')
  expect(asked?.question.endsWith('Run it now?')).toBe(true)
})

test('risky command + Cancel: denied with a reason for Claude, and the command is never reached', async ($, on) => {
  const w = world(on, { reply: say('Cancel') })
  const result: any = await $.tool.call(bash('rm -rf build'))
  expect(w.reached).toEqual([])
  expect(w.questions).toHaveLength(1)
  expect(result.deny).toContain('the person cancelled this command (rm-recursive)')
  expect(result.deny).toContain('Do not retry the same command unprompted')
})

test('risky command + dialog dismissed: denied, never reached', async ($, on) => {
  const w = world(on, { reply: 'dismiss' })
  const result: any = await $.tool.call(bash('git reset --hard'))
  expect(w.reached).toEqual([])
  expect(result.deny).toContain('no confirmation was given')
})

test('risky command + nothing can ask (the ask rejects, as in a -p run): denied, never reached', async ($, on) => {
  const w = world(on, { reply: 'throw' })
  const result: any = await $.tool.call(bash('git clean -fd'))
  expect(w.reached).toEqual([])
  expect(result.deny).toContain('no confirmation was given')
  expect(result.deny).toContain('non-interactive')
})

test('risky command + any answer other than the label Proceed: denied', async ($, on) => {
  const w = world(on)
  for (const text of ['sure, go ahead', 'proceed', '', 'Proceed, Cancel', ' Proceed']) {
    w.cfg.reply = say(text)
    const result: any = await $.tool.call(bash('rm -rf build'))
    expect([text, w.reached]).toEqual([text, []])
    expect(result.deny).toBeDefined()
  }
})

test('safe command: no dialog, no git, no file system look, the command reaches the stub', async ($, on) => {
  const w = world(on, { reply: say('Cancel') })
  const result: any = await $.tool.call(bash('git status && rm file.txt && ls -la'))
  expect(w.questions).toEqual([])
  expect(w.runs).toEqual([])
  expect(w.stats).toEqual([])
  expect(w.reached).toEqual(['git status && rm file.txt && ls -la'])
  expect(result.deny).toBeUndefined()
})

test('a tool that is not a shell tool is not looked at', async ($, on) => {
  const w = world(on, { reply: say('Cancel') })
  const result: any = await $.tool.call({ tool: 'Read', file_path: 'rm -rf x' })
  expect(w.questions).toEqual([])
  expect(result.deny).toBeUndefined()
})

test('the PowerShell tool is guarded the same way', async ($, on) => {
  const w = world(on, { reply: say('Cancel') })
  const denied: any = await $.tool.call({ tool: 'PowerShell', command: 'Remove-Item -Recurse -Force build' })
  expect(denied.deny).toContain('(remove-item)')
  expect(w.reached).toEqual([])

  w.cfg.reply = say('Proceed')
  await $.tool.call({ tool: 'PowerShell', command: 'Remove-Item -Recurse -Force build' })
  expect(w.reached).toEqual(['Remove-Item -Recurse -Force build'])
})

// ---- the switch ----

test('/mods off blast-radius: a risky command passes at once with no dialog; /mods on asks again', async ($, on) => {
  const w = world(on, { reply: say('Cancel') })

  const off = await $.command.run(slash('off blast-radius'))
  expect(off.text).toBe('mod-pack: blast-radius is OFF.')
  await $.tool.call(bash('rm -rf build'))
  expect(w.questions).toEqual([])
  expect(w.reached).toEqual(['rm -rf build'])

  await $.command.run(slash('on blast-radius'))
  const denied: any = await $.tool.call(bash('rm -rf dist'))
  expect(w.questions).toHaveLength(1)
  expect(denied.deny).toContain('cancelled')
  expect(w.reached).toEqual(['rm -rf build'])
})

test('the blastRadius setting off: no dialog. A /mods on choice beats the setting.', { options: { blastRadius: false } }, async ($, on) => {
  const w = world(on, { reply: say('Cancel') })
  await $.tool.call(bash('git reset --hard'))
  expect(w.questions).toEqual([])
  expect(w.reached).toEqual(['git reset --hard'])

  await $.command.run(slash('on blast-radius'))
  const denied: any = await $.tool.call(bash('git reset --hard'))
  expect(denied.deny).toBeDefined()
  expect(w.questions).toHaveLength(1)
})

test('/mods lists Blast Radius ON by default, with its text, and no token or sound flag', async ($, on) => {
  world(on)
  const list = await $.command.run(slash(''))
  expect(list.text).toMatch(/ON\s+blast-radius\s+Blast Radius: asks Proceed or Cancel before a risky shell command/)
  const line = (list.text ?? '').split('\n').find(l => l.includes('blast-radius')) ?? ''
  expect(line).not.toContain('[')
  expect(line).toContain('costs no model tokens')
})

// ---- the preview inside the dialog ----

test('rm -rf: each plain path is looked at; a glob is listed as skipped; entries counted at every level', async ($, on) => {
  const w = world(on, {
    reply: say('Cancel'),
    fs: {
      stat: path => (path === '/work/build' ? DIR : path === '/work/a.txt' ? FILE : undefined),
      list: path => (path === '/work/build' ? [entry('x.o'), entry('y.o'), entry('sub', 'dir'), entry('lnk', 'other', true)] : path === '/work/build/sub' ? [entry('z.o')] : []),
    },
  })
  await $.tool.call(bash('rm -rf build a.txt gone *.log'))
  const { question } = w.questions[0]!
  expect(question).toContain('build: directory, 5 entries inside')
  expect(question).toContain('a.txt: file')
  expect(question).toContain('gone: not found')
  expect(question).toContain('not previewed (glob or variable): *.log')
  // the symbolic link is an entry, and it is not entered
  expect(w.lists).toEqual(['/work/build', '/work/build/sub'])
  expect(w.stats).toEqual(['/work/build', '/work/a.txt', '/work/gone'])
})

test('rm -rf on a directory with more than 1000 entries: the count is capped and the walk stops', async ($, on) => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => entry(`f${i}`))
  const w = world(on, {
    reply: say('Cancel'),
    fs: { stat: () => DIR, list: path => (path === '/work/big' ? [...many(600), entry('d1', 'dir'), entry('d2', 'dir')] : many(600)) },
  })
  await $.tool.call(bash('rm -rf big'))
  expect(w.questions[0]?.question).toContain('big: directory, 1000+ entries inside')
  expect(w.lists.length).toBeLessThanOrEqual(3)
})

test('rm -rf on a symbolic link: reported as a link, its target is not listed', async ($, on) => {
  const w = world(on, { reply: say('Cancel'), fs: { stat: () => ({ ...DIR, isLink: true }) } })
  await $.tool.call(bash('rm -rf shortcut'))
  expect(w.questions[0]?.question).toContain('shortcut: symbolic link')
  expect(w.lists).toEqual([])
})

test('an earlier cd: relative paths are not resolved against the session folder', async ($, on) => {
  const w = world(on, { reply: say('Cancel'), fs: { stat: () => DIR } })
  await $.tool.call(bash('cd elsewhere && rm -rf build'))
  expect(w.questions[0]?.question).toContain('an earlier part of the command changes directory')
  expect(w.stats).toEqual([])
})

test('an absolute path is looked at as it is', async ($, on) => {
  const w = world(on, { reply: say('Cancel'), fs: { stat: () => FILE } })
  await $.tool.call(bash('rm -rf /tmp/x'))
  expect(w.stats).toEqual(['/tmp/x'])
})

test('git reset --hard: runs git status and diff in the session folder, shows count and paths', async ($, on) => {
  const w = world(on, {
    reply: say('Cancel'),
    git: args => (args.includes('status') ? ' M a.ts\nM  b.ts\n?? new.txt\n' : ' 2 files changed, 3 insertions(+)\n'),
  })
  await $.tool.call(bash('git reset --hard'))
  const { question } = w.questions[0]!
  expect(question).toContain('2 tracked files with uncommitted changes would be overwritten')
  expect(question).toContain('   M a.ts')
  expect(question).toContain('2 files changed, 3 insertions(+)')
  expect(question).toContain('1 untracked file not touched.')
  expect(w.runs.every(r => r.argv[0] === 'git' && r.cwd === '/work')).toBe(true)
})

test('git clean -fd: previews with git clean -n and the same flags, never with force', async ($, on) => {
  const w = world(on, { reply: say('Cancel'), git: () => 'Would remove build/\nWould remove tmp.log\n' })
  await $.tool.call(bash('git clean -fd'))
  expect(w.questions[0]?.question).toContain('2 untracked paths would be deleted (git clean -n)')
  const clean = w.runs.find(r => r.argv.includes('clean'))!
  expect(clean.argv.slice(clean.argv.indexOf('clean'))).toEqual(['clean', '-n', '-d'])
})

test('git push --force: branch, upstream, and the commits the remote would lose', async ($, on) => {
  const w = world(on, {
    reply: say('Cancel'),
    git: args => {
      if (args.includes('--count')) return '2\n'
      if (args.includes('log')) return 'abc1234 fix\ndef5678 add\n'
      return args.includes('@{u}') ? 'origin/main\n' : 'main\n'
    },
  })
  await $.tool.call(bash('git push --force'))
  const { question } = w.questions[0]!
  expect(question).toContain('current branch: main, upstream: origin/main')
  expect(question).toContain('2 commits on the remote would be lost')
  expect(question).toContain('abc1234 fix')
  expect(w.runs.some(r => r.argv.includes('HEAD..@{u}'))).toBe(true)
})

test('git branch -D and git stash drop get their previews', async ($, on) => {
  const w = world(on, { reply: say('Cancel'), git: args => (args.includes('stash') ? 'stash@{0}: WIP on main: abc fix\n' : '3\n') })
  await $.tool.call(bash('git branch -D feature'))
  expect(w.questions[0]?.question).toContain('branch feature: 3 commits not in the current branch')
  await $.tool.call(bash('git stash drop'))
  expect(w.questions[1]?.question).toContain('1 stash exist')
})

test('git options in the command are not passed to the preview: no preview, still asks', async ($, on) => {
  const w = world(on, { reply: say('Cancel') })
  await $.tool.call(bash('git -c core.fsmonitor=evil -C repo reset --hard'))
  expect(w.runs).toEqual([])
  expect(w.questions[0]?.question).toContain('no preview available')
})

test('not a git repository or git missing: "no preview available", the dialog is still shown', async ($, on) => {
  const w = world(on, { reply: say('Cancel'), git: () => new Error('spawn git ENOENT') })
  const result: any = await $.tool.call(bash('git reset --hard'))
  expect(w.questions).toHaveLength(1)
  expect(w.questions[0]?.question).toContain('no preview available')
  expect(result.deny).toBeDefined()
})

test('preview step throws: the dialog is still shown and the command still waits for the answer', async ($, on) => {
  const w = world(on, {
    reply: say('Cancel'),
    git: () => new Error('git exploded'),
    fs: {
      stat: () => {
        throw new Error('stat exploded')
      },
    },
  })
  const denied: any = await $.tool.call(bash('git reset --hard && rm -rf build'))
  expect(w.questions).toHaveLength(1)
  expect(w.questions[0]?.question).toContain('no preview available')
  expect(w.reached).toEqual([])
  expect(denied.deny).toBeDefined()

  w.cfg.reply = say('Proceed')
  await $.tool.call(bash('git reset --hard'))
  expect(w.questions).toHaveLength(2)
  expect(w.reached).toEqual(['git reset --hard'])
})

test('the previews run only read-only git: status, diff, clean -n, rev-parse, rev-list, log, stash list', async ($, on) => {
  const w = world(on, { reply: say('Cancel') })
  for (const command of ['git reset --hard', 'git clean -xdf', 'git push -f origin main', 'git checkout -- .', 'git restore .', 'git branch -D a', 'git stash clear']) {
    await $.tool.call(bash(command))
  }
  expect(w.runs.length).toBeGreaterThan(8)
  for (const { argv } of w.runs) {
    expect(argv.slice(0, 4)).toEqual(['git', '--no-optional-locks', '-c', 'core.fsmonitor=false'])
    const [sub = '', ...rest] = argv.slice(4)
    expect(['status', 'diff', 'clean', 'rev-parse', 'rev-list', 'log', 'stash']).toContain(sub)
    if (sub === 'clean') expect(rest).toContain('-n')
    if (sub === 'stash') expect(rest).toEqual(['list'])
    if (sub === 'diff') expect(rest).toContain('--shortstat')
    expect(argv.join(' ')).not.toMatch(/--hard|--force|push|-D\b|\bdrop\b|\bclear\b|-fd|-xdf/)
  }
})

test('several risks in one command: one dialog, every kind named', async ($, on) => {
  const w = world(on, { reply: say('Cancel') })
  await $.tool.call(bash('rm -rf a && git push -f && git stash clear'))
  expect(w.questions).toHaveLength(1)
  const { question } = w.questions[0]!
  for (const part of ['recursive delete (rm -r)', 'git push --force', 'git stash drop / clear']) expect(question).toContain(part)
})

// ---- a crash in the guard ----

test('the guard crashes: the .catch handler still asks, so a risky command is not silently allowed', async ($, on) => {
  // $.store.get throws, and the guard reads it first.
  const w = world(on, { reply: say('Cancel'), storeDown: true })
  const denied: any = await $.tool.call(bash('rm -rf build'))
  expect(w.questions).toHaveLength(1)
  expect(w.questions[0]?.question).toContain('the Blast Radius check itself failed')
  expect(w.reached).toEqual([])
  expect(denied.deny).toContain('cancelled')

  w.cfg.reply = say('Proceed')
  await $.tool.call(bash('rm -rf dist'))
  expect(w.questions).toHaveLength(2)
  expect(w.reached).toEqual(['rm -rf dist'])
})

test('the guard crashes on a safe command: the handler lets it through without asking', async ($, on) => {
  const w = world(on, { reply: say('Cancel'), storeDown: true })
  await $.tool.call(bash('ls -la'))
  expect(w.questions).toEqual([])
  expect(w.reached).toEqual(['ls -la'])
})

test('the command itself fails after Proceed: the handler does not ask a second time', async ($, on) => {
  const w = world(on, { reply: say('Proceed'), bashThrows: true })
  await $.tool.call(bash('rm -rf build')).catch(() => undefined)
  expect(w.questions).toHaveLength(1)
})
