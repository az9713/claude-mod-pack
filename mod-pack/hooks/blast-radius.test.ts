import { test, expect } from 'claude-code/testing'

import {
  blastRadius, branchTargets, buildQuestion, cleanDryRun, classify, denyReason, ENTRY_CAP, hasGitOptions, isProceed, MAX_SHOWN, NO_GIT_PREVIEW, NO_PREVIEW,
  pathArgs, previewBranch, previewClean, previewPaths, previewPush, previewStash, previewStatus, pushPlan, resolvePath,
} from './blast-radius'
import type { GitOut } from './blast-radius'

const kinds = (command: string) => classify(command).map(r => r.kind)

// [command, the kinds it is held for, in order]
const HELD: [string, string[]][] = [
  // recursive delete: flag spellings and orders
  ['rm -rf build', ['rm-recursive']],
  ['rm -fr build', ['rm-recursive']],
  ['rm -r build', ['rm-recursive']],
  ['rm -r -f build', ['rm-recursive']],
  ['rm -f -r build', ['rm-recursive']],
  ['rm -Rf build', ['rm-recursive']],
  ['rm --recursive --force build', ['rm-recursive']],
  ['rm build -rf', ['rm-recursive']],
  // prefixes and chains
  ['sudo rm -rf /var/cache/x', ['rm-recursive']],
  ['sudo -u deploy rm -rf /srv/x', ['rm-recursive']],
  ['/bin/rm -rf x', ['rm-recursive']],
  ['\\rm -rf x', ['rm-recursive']],
  ['FOO=1 rm -rf x', ['rm-recursive']],
  ['cd build && rm -rf *', ['rm-recursive']],
  ['ls; rm -rf build', ['rm-recursive']],
  ['make || rm -rf build', ['rm-recursive']],
  ['find . -name x | xargs rm -rf', ['rm-recursive']],
  ['echo start\nrm -rf build\necho done', ['rm-recursive']],
  ['bash -c "rm -rf x"', ['rm-recursive']],
  ['echo $(rm -rf x)', ['rm-recursive']],
  ['time rm -rf x', ['rm-recursive']],
  ['cmd /c rmdir /s /q build', ['rmdir-windows']],
  ['powershell -NoProfile -Command "Remove-Item -Recurse build"', ['remove-item']],
  ['sudo git push --force', ['git-push-force']],
  // git
  ['git reset --hard', ['git-reset-hard']],
  ['git reset --hard origin/main', ['git-reset-hard']],
  ['git reset HEAD~1 --hard', ['git-reset-hard']],
  ['git -C repo reset --hard HEAD~1', ['git-reset-hard']],
  ['git status && git reset --hard', ['git-reset-hard']],
  ['git clean -fd', ['git-clean']],
  ['git clean -f', ['git-clean']],
  ['git clean -xdf', ['git-clean']],
  ['git clean --force -d', ['git-clean']],
  ['git push --force', ['git-push-force']],
  ['git push -f origin main', ['git-push-force']],
  ['git push origin main --force', ['git-push-force']],
  ['git push --force-with-lease', ['git-push-force']],
  ['git push --force-with-lease=main:abc123 origin main', ['git-push-force']],
  ['git push origin +main', ['git-push-force']],
  ['git checkout -- .', ['git-discard-checkout']],
  ['git checkout .', ['git-discard-checkout']],
  ['git checkout main -- .', ['git-discard-checkout']],
  ['git restore .', ['git-discard-restore']],
  ['git restore --worktree --staged .', ['git-discard-restore']],
  ['git branch -D feature', ['git-branch-delete']],
  ['git stash drop', ['git-stash-drop']],
  ['git stash clear', ['git-stash-drop']],
  // Windows
  ['rmdir /s /q build', ['rmdir-windows']],
  ['RD /S /Q build', ['rmdir-windows']],
  ['del /s /q *.tmp', ['del-windows']],
  ['Remove-Item -Recurse -Force build', ['remove-item']],
  ['remove-item build -recurse', ['remove-item']],
  ['ri -r build', ['remove-item']],
  ['Remove-Item build -Recurse:$true', ['remove-item']],
  // several risks in one command, in order
  ['rm -rf a && git push -f', ['rm-recursive', 'git-push-force']],
]

const NOT_HELD: string[] = [
  // delete without recursion: one named file at a time. Decision: not held.
  'rm file.txt',
  'rm -f file.txt',
  'rm -i file.txt',
  'rmdir build',
  'del file.txt',
  'Remove-Item file.txt',
  'Get-ChildItem -Recurse',
  // git: safe forms
  'git reset --soft HEAD~1',
  'git reset --mixed HEAD~1',
  'git reset HEAD file.txt',
  'git reset',
  'git clean -n',
  'git clean -nd',
  'git clean -fdn',
  'git clean --dry-run -fd',
  'git push',
  'git push origin main',
  'git push -u origin feature',
  'git push --follow-tags',
  'git status',
  'git diff --stat',
  'git log --oneline',
  'git checkout main',
  'git checkout -b feature',
  'git checkout .gitignore',
  'git restore file.txt',
  'git restore --staged .',
  'git branch',
  'git branch -d feature',
  'git stash',
  'git stash pop',
  'git stash list',
  // text that only mentions a risky command. Decision: a rule matches only at the
  // start of a segment, so these are not held.
  'grep rm -rf README',
  'echo "rm -rf x"',
  "echo 'git reset --hard'",
  'cat rm-rf.txt',
  'npm run build',
  'ls -la',
]

test('the Blast Radius feature entry: id, default on, no model tokens, no sound', () => {
  expect(blastRadius.id).toBe('blast-radius')
  expect(blastRadius.defaultOn).toBe(true)
  expect(blastRadius.usesModel).toBe(false)
  expect(blastRadius.hasSound).toBeUndefined()
  expect(blastRadius.about).toContain('no model tokens')
})

test('the classifier holds each risky command, with the right kinds', () => {
  for (const [command, expected] of HELD) expect([command, kinds(command)]).toEqual([command, expected])
})

test('the classifier lets safe commands through', () => {
  for (const command of NOT_HELD) expect([command, kinds(command)]).toEqual([command, []])
})

test('the tables are big enough: 25 or more cases each way', () => {
  expect(HELD.length).toBeGreaterThanOrEqual(25)
  expect(NOT_HELD.length).toBeGreaterThanOrEqual(25)
})

test('a risky word inside quotes after a separator is a false positive (accepted)', () => {
  expect(kinds('echo "a; rm -rf x"')).toEqual(['rm-recursive'])
})

test('known ceiling: an alias, a script and a command built from variables are not caught', () => {
  expect(kinds('nuke build')).toEqual([])
  expect(kinds('./cleanup.sh')).toEqual([])
  expect(kinds('rm $FLAGS build')).toEqual([])
  expect(kinds('eval "$cmd"')).toEqual([])
})

test('hasCd records an earlier cd in the same command', () => {
  expect(classify('cd build && rm -rf x')[0]?.hasCd).toBe(true)
  expect(classify('rm -rf x && cd build')[0]?.hasCd).toBe(false)
  expect(classify('rm -rf x')[0]?.hasCd).toBe(false)
  expect(classify('Set-Location build; Remove-Item -Recurse x')[0]?.hasCd).toBe(true)
})

test('a risk keeps the segment the rule saw, prefix removed', () => {
  const [risk] = classify('cd x && sudo rm -rf  build/ dist')
  expect(risk?.segment).toBe('rm -rf  build/ dist')
  expect(risk?.preview).toBe('paths')
})

test('pathArgs: plain paths, and what is skipped', () => {
  expect(pathArgs('rm -rf build dist/')).toEqual({ paths: ['build', 'dist/'], skipped: [] })
  expect(pathArgs('rm -rf "my dir" other')).toEqual({ paths: ['my dir', 'other'], skipped: [] })
  expect(pathArgs('rm -rf *.log $HOME/x ~/y build')).toEqual({ paths: ['build'], skipped: ['*.log', '$HOME/x', '~/y'] })
  expect(pathArgs('rd /s /q C:\\work\\out')).toEqual({ paths: ['C:\\work\\out'], skipped: [] })
  expect(pathArgs('Remove-Item -Recurse -Force -Include *.tmp build')).toEqual({ paths: ['build'], skipped: [] })
  expect(pathArgs('rm -rf build 2>/dev/null')).toEqual({ paths: ['build'], skipped: [] })
  expect(pathArgs('rm -rf')).toEqual({ paths: [], skipped: [] })
})

test('resolvePath joins a relative path to the session folder and leaves an absolute one', () => {
  expect(resolvePath('/work', 'build')).toBe('/work/build')
  expect(resolvePath('/work/', 'a/b')).toBe('/work/a/b')
  expect(resolvePath('C:\\work', 'build')).toBe('C:\\work/build')
  expect(resolvePath('/work', '/tmp/x')).toBe('/tmp/x')
  expect(resolvePath('/work', 'C:\\x')).toBe('C:\\x')
})

test('cleanDryRun: same flags, force removed, dry run added', () => {
  expect(cleanDryRun('git clean -fd')).toEqual(['clean', '-n', '-d'])
  expect(cleanDryRun('git clean -xdf')).toEqual(['clean', '-n', '-xd'])
  expect(cleanDryRun('git clean --force -d src')).toEqual(['clean', '-n', '-d', 'src'])
  expect(cleanDryRun('git clean -f')).toEqual(['clean', '-n'])
  expect(cleanDryRun('git clean -f $DIR')).toBeUndefined()
  expect(cleanDryRun('git -C x clean -f')).toBeUndefined()
})

test('pushPlan: which commits would the remote lose', () => {
  expect(pushPlan('git push --force')).toEqual({ range: 'HEAD..@{u}' })
  expect(pushPlan('git push -f origin')).toEqual({ range: 'HEAD..@{u}' })
  expect(pushPlan('git push -f origin main')).toEqual({ range: 'main..origin/main' })
  expect(pushPlan('git push origin +main')).toEqual({ range: 'main..origin/main' })
  expect(pushPlan('git push -f origin HEAD:main').note).toContain('not a plain remote and branch')
  expect(pushPlan('git push -f origin a b').range).toBeUndefined()
})

test('branchTargets and hasGitOptions', () => {
  expect(branchTargets('git branch -D a b')).toEqual(['a', 'b'])
  expect(branchTargets('git branch -D a b c d')).toEqual(['a', 'b', 'c'])
  expect(branchTargets('git branch -D $X')).toEqual([])
  expect(hasGitOptions('git reset --hard')).toBe(false)
  expect(hasGitOptions('git -C repo reset --hard')).toBe(true)
  expect(hasGitOptions('git -c core.pager=x clean -f')).toBe(true)
})

// ---- preview text ----

const out = (text: string, over: Partial<GitOut> = {}): GitOut => ({ ok: true, text, isCut: false, ...over })
const FAILED: GitOut = { ok: false, text: '', isCut: false }

test('status preview: tracked count, first paths, untracked left alone', () => {
  const text = [' M a.ts', 'M  b.ts', 'A  c.ts', '?? new1.txt', '?? new2.txt'].join('\n')
  const lines = previewStatus(out(text), out(' 3 files changed, 10 insertions(+), 2 deletions(-)\n'), 'all')
  expect(lines[0]).toBe('3 tracked files with uncommitted changes would be overwritten (status, path):')
  expect(lines.slice(1, 4)).toEqual(['   M a.ts', '  M  b.ts', '  A  c.ts'])
  expect(lines).toContain('  3 files changed, 10 insertions(+), 2 deletions(-)')
  expect(lines).toContain('2 untracked files not touched.')
})

test('status preview: the work-tree scope counts only unstaged changes', () => {
  const text = [' M a.ts', 'M  b.ts', 'MM c.ts'].join('\n')
  const lines = previewStatus(out(text), undefined, 'worktree')
  expect(lines[0]).toBe('2 tracked files with unstaged changes would be overwritten (status, path):')
  expect(lines.join('\n')).not.toContain('b.ts')
})

test('status preview: truncation to 10 paths with "and N more", and an exact count line', () => {
  const text = Array.from({ length: 14 }, (_, i) => ` M file${i}.ts`).join('\n')
  const lines = previewStatus(out(text), undefined, 'all')
  expect(lines[0]).toContain('14 tracked files')
  expect(lines.filter(l => l.includes('file') && l.includes('.ts'))).toHaveLength(MAX_SHOWN)
  expect(lines).toContain('  ...and 4 more')
})

test('status preview: clean tree, cut output, and no preview', () => {
  expect(previewStatus(out(''), undefined, 'all')[0]).toBe('no uncommitted changes to tracked files to lose.')
  expect(previewStatus(out(' M a.ts\n', { isCut: true }), undefined, 'all')[0]).toContain('1+ tracked file')
  expect(previewStatus(FAILED, undefined, 'all')).toEqual([NO_GIT_PREVIEW])
  expect(previewStatus(undefined, undefined, 'worktree')).toEqual([NO_GIT_PREVIEW])
  expect(NO_GIT_PREVIEW).toContain('no preview available')
})

test('clean preview: count, 10 paths, and "and N more"', () => {
  const text = Array.from({ length: 12 }, (_, i) => `Would remove tmp/f${i}.log`).join('\n') + '\nWould skip repository sub/\n'
  const lines = previewClean(out(text))
  expect(lines[0]).toBe('12 untracked paths would be deleted (git clean -n):')
  expect(lines).toHaveLength(1 + MAX_SHOWN + 1)
  expect(lines.at(-1)).toBe('  ...and 2 more')
  expect(previewClean(out(''))).toEqual(['git clean -n lists nothing to delete.'])
  expect(previewClean(undefined)).toEqual([NO_GIT_PREVIEW])
})

test('push preview: branch, upstream, lost commits; and the fallback text', () => {
  const lines = previewPush({
    branch: out('main\n'),
    upstream: out('origin/main\n'),
    count: out('2\n'),
    log: out('abc1234 fix\ndef5678 add\n'),
    plan: { range: 'HEAD..@{u}' },
  })
  expect(lines[0]).toBe('current branch: main, upstream: origin/main')
  expect(lines[1]).toBe('2 commits on the remote would be lost (per the last fetch, HEAD..@{u}):')
  expect(lines.slice(2)).toEqual(['  abc1234 fix', '  def5678 add'])

  const none = previewPush({ branch: out('main'), upstream: FAILED, count: undefined, log: undefined, plan: { note: 'the target "x" is odd' } })
  expect(none).toEqual(['current branch: main, upstream: none set', 'remote history may be overwritten; the lost commits could not be counted.', 'the target "x" is odd'])
  expect(previewPush({ branch: undefined, upstream: undefined, count: undefined, log: undefined, plan: {} })).toEqual(['remote history may be overwritten; the lost commits could not be counted.'])
  expect(previewPush({ branch: out('m'), upstream: out('o/m'), count: out('0'), log: out(''), plan: { range: 'HEAD..@{u}' } })[1]).toContain('no commits that your branch lacks')
})

test('branch and stash previews', () => {
  expect(previewBranch([{ name: 'a', count: out('3\n') }, { name: 'b', count: out('0') }, { name: 'c', count: FAILED }])).toEqual([
    'branch a: 3 commits not in the current branch (only the reflog keeps them after the delete)',
    'branch b: 0 commits not in the current branch',
    `branch c: ${NO_PREVIEW}`,
  ])
  expect(previewBranch([])).toEqual([NO_PREVIEW])
  expect(previewStash(out('stash@{0}: WIP on main: abc fix\nstash@{1}: WIP on main: def add\n'))[0]).toContain('2 stashes exist')
  expect(previewStash(undefined)).toEqual([NO_GIT_PREVIEW])
})

test('path preview: each state, the cd note, skipped paths and the cap', () => {
  const lines = previewPaths(
    [
      { path: 'build', kind: 'dir', entries: 412, isCapped: false },
      { path: 'big', kind: 'dir', entries: ENTRY_CAP, isCapped: true },
      { path: 'one', kind: 'dir', entries: 1, isCapped: false },
      { path: 'a.txt', kind: 'file' },
      { path: 'lnk', kind: 'link' },
      { path: 'gone', kind: 'missing' },
    ],
    { paths: ['build', 'big', 'one', 'a.txt', 'lnk', 'gone', 'x', 'y'], skipped: ['*.log'] },
    false,
  )
  expect(lines).toEqual([
    'build: directory, 412 entries inside',
    'big: directory, 1000+ entries inside',
    'one: directory, 1 entry inside',
    'a.txt: file',
    'lnk: symbolic link (the link is removed, its target is not followed)',
    'gone: not found',
    '...and 2 more paths not looked at',
    'not previewed (glob or variable): *.log',
  ])
  expect(previewPaths([], { paths: ['x'], skipped: [] }, true)[0]).toContain('changes directory')
  expect(previewPaths([], { paths: [], skipped: [] }, false)).toEqual([`${NO_PREVIEW} (no plain path in the command)`])
})

test('the dialog text names the kinds and the exact command, then the preview', () => {
  const text = buildQuestion('rm -rf build', [{ title: 'recursive delete (rm -r)' }], ['build: directory, 3 entries inside'])
  expect(text).toBe(
    [
      'Blast Radius holds this command: recursive delete (rm -r).',
      '',
      '  rm -rf build',
      '',
      'What would change (a best-effort, read-only check):',
      '  build: directory, 3 entries inside',
      '',
      'Run it now?',
    ].join('\n'),
  )
  expect(buildQuestion('x'.repeat(500), [], [])).toContain('it could not be checked')
  expect(buildQuestion('x'.repeat(500), [], [])).toContain(`${'x'.repeat(400)}...`)
})

test('only the exact label Proceed lets a command run', () => {
  expect(isProceed('Proceed')).toBe(true)
  for (const other of ['Cancel', 'proceed', 'Proceed ', '', 'yes', 'Proceed, Cancel', undefined]) expect(isProceed(other)).toBe(false)
})

test('the denial tells Claude the command did not run and not to retry it unprompted', () => {
  const cancelled = denyReason('Cancel', ['rm-recursive'])
  expect(cancelled).toContain('the person cancelled this command (rm-recursive)')
  expect(cancelled).toContain('Do not retry the same command unprompted')
  const none = denyReason(undefined, ['git-reset-hard', 'git-clean'])
  expect(none).toContain('no confirmation was given')
  expect(none).toContain('non-interactive')
  expect(none).toContain('git-reset-hard, git-clean')
  expect(none).toContain('Do not retry the same command unprompted')
  expect(denyReason('x', [])).toContain('(unchecked)')
})
