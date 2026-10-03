// Mounts the AbovePrompt band through mod-pack and checks it beside another
// plugin's band. The other plugin is a stub beneath mod-pack (it stands for
// next-steps, or any plugin that draws in this band).

import { test, expect, mock } from 'claude-code/testing'

const MARKER = 'OTHER-PLUGIN-BAND'

const props = (over: Record<string, unknown> = {}) =>
  ({ hasSurvey: false, isWorking: false, maxRows: 12, bodyColumns: 100, scroll: { offset: 0, bodyRows: 12 }, view: {}, ...over }) as never

// What the person's Enter sends for `/mods <args>`.
const slash = (args: string) => ({ command: 'mods', args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 100 } })

const turn = (id: string) => ({ answer: 'ok', durationMs: 1, isAborted: false, turnId: id, reason: 'answer' as const })

// The engine's side of the events the pack uses. `used` is the context fill the stub reports.
const engine = (on: any, used: { tokens: number }, played: string[]) => {
  mock.store(on)
  on('ui.render', { component: 'AbovePrompt' }, ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return Text({ children: MARKER })
  })
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: used.tokens, window: 200000 }, rateLimits: [] } }))
  on('turn.complete', () => ({ text: 'ok' }))
  on('audio.play', (_$: any, e: any) => {
    played.push(e.clip.asset)
    return { value: undefined }
  })
}

test('the band keeps the other plugin first and adds the Token Weather row below it', async ($, on) => {
  const used = { tokens: 150000 }
  engine(on, used, [])
  await $.turn.complete(turn('t1'))

  const ui = await $.ui.mount({ plugin: 'mod-pack', surface: 'terminal', component: 'AbovePrompt', props: props() })
  const other = await ui.find({ type: 'Text', text: MARKER })
  const weather = await ui.find({ type: 'Text', text: /Storm/ })
  expect(other).toBeDefined()
  expect(weather).toBeDefined()

  // Order in the drawn tree: the other plugin's row first, ours after it.
  const tree = JSON.stringify(await ui.drawn())
  expect(tree.indexOf(MARKER)).toBeGreaterThan(-1)
  expect(tree.indexOf('Storm')).toBeGreaterThan(tree.indexOf(MARKER))
  expect(await ui.find({ type: 'Text', text: /75% 150k \/ 200k/ })).toBeDefined()
  expect(tree).toContain('"height":1')
  await ui.unmount()
})

test('no sample yet: only the other plugin draws', async ($, on) => {
  engine(on, { tokens: 150000 }, [])
  const ui = await $.ui.mount({ plugin: 'mod-pack', surface: 'terminal', component: 'AbovePrompt', props: props() })
  expect(await ui.find({ type: 'Text', text: MARKER })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Storm|Clear|Cloudy|Showers/ })).toBeUndefined()
  await ui.unmount()
})

test('off the terminal, with a survey, or with no room: the pack returns the band below untouched', async ($, on) => {
  engine(on, { tokens: 150000 }, [])
  await $.turn.complete(turn('t1'))

  const cases = [
    { surface: 'desktop' as const, props: props() },
    { surface: 'terminal' as const, props: props({ hasSurvey: true }) },
    { surface: 'terminal' as const, props: props({ maxRows: 2 }) },
  ]
  for (const c of cases) {
    const ui = await $.ui.mount({ plugin: 'mod-pack', surface: c.surface, component: 'AbovePrompt', props: c.props })
    expect(await ui.find({ type: 'Text', text: MARKER })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Storm/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('/mods off removes the row at once, /mods on brings it back, the other plugin stays', async ($, on) => {
  engine(on, { tokens: 150000 }, [])
  await $.turn.complete(turn('t1'))
  const ui = await $.ui.mount({ plugin: 'mod-pack', surface: 'terminal', component: 'AbovePrompt', props: props() })
  expect(await ui.find({ type: 'Text', text: /Storm/ })).toBeDefined()

  const off = await $.command.run(slash('off token-weather'))
  expect(off.text).toBe('mod-pack: token-weather is OFF.')
  expect(await ui.find({ type: 'Text', text: /Storm/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: MARKER })).toBeDefined()

  const list = await $.command.run(slash(''))
  expect(list.text).toMatch(/OFF\s+token-weather/)

  await $.command.run(slash('on token-weather'))
  expect(await ui.find({ type: 'Text', text: /Storm/ })).toBeDefined()
  await ui.unmount()
})

test('thunder plays when the band moves up into Storm, and not again while it stays', { options: { sound: true } }, async ($, on) => {
  const used = { tokens: 100000 }
  const played: string[] = []
  engine(on, used, played)

  await $.turn.complete(turn('t1')) // 50%: Showers, no earlier sample
  expect(played).toEqual([])
  used.tokens = 150000
  await $.turn.complete(turn('t2')) // 75%: Showers -> Storm
  expect(played).toEqual(['assets/thunder.wav'])
  used.tokens = 170000
  await $.turn.complete(turn('t3')) // 85%: still Storm
  expect(played).toEqual(['assets/thunder.wav'])
  used.tokens = 185000
  await $.turn.complete(turn('t4')) // 92.5%: Storm -> Compact soon
  expect(played).toEqual(['assets/thunder.wav', 'assets/thunder.wav'])
})

test('no sound while the global sound setting is off, or while the feature is off', async ($, on) => {
  const used = { tokens: 100000 }
  const played: string[] = []
  engine(on, used, played)

  await $.turn.complete(turn('t1'))
  used.tokens = 150000
  await $.turn.complete(turn('t2')) // enters Storm, sound setting off (default)
  expect(played).toEqual([])

  await $.command.run(slash('sound on'))
  await $.command.run(slash('off token-weather'))
  used.tokens = 185000
  await $.turn.complete(turn('t3')) // enters Compact soon, sound on, feature off
  expect(played).toEqual([])
})

test('a /mods sound override plays thunder without the setting', async ($, on) => {
  const used = { tokens: 100000 }
  const played: string[] = []
  engine(on, used, played)
  await $.command.run(slash('sound on'))

  await $.turn.complete(turn('t1'))
  used.tokens = 150000
  await $.turn.complete(turn('t2'))
  expect(played).toEqual(['assets/thunder.wav'])
})

test('session.start registers the /mods command and passes the event on', async ($, on) => {
  mock.store(on)
  const registered: string[] = []
  on('command.register', (_$: any, e: any) => {
    registered.push(e.name)
    return { value: { command: e.name } }
  })
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))

  const result = await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  expect(registered).toEqual(['mods', 'q']) // /q (Prompt Queue) joined /mods
  expect(result).toEqual({ cwd: '/work' })
})
