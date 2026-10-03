// The flow of Prompt Queue through the plugin. The engine is stubbed beneath it: `clock` (moves
// only when the test moves it), `store`, `session.usage`, `session.surfaces`, `command.register`,
// `prompt.submit` (the engine taking a prompt: it records every prompt, can be held, can drop the
// prompt or throw), `model.complete` (for Wait What), `session.compact` (a compaction that can be
// held), `ui.toast`, `turn.start`, `turn.complete`, `session.end`, and a stub standing for next-steps
// in the AbovePrompt band. Nothing is drawn on a real screen: `ui.mount` runs the plugin's
// `ui.render` hook and the kit reads the tree. The stub does NOT start a turn when it takes a prompt:
// a test that wants the engine's turn calls `$.turn.start` itself.

import { test, expect, mock } from 'claude-code/testing'

const MARKER = 'OTHER-PLUGIN-BAND'
const SECOND = 1000

const props = (over: Record<string, unknown> = {}) =>
  ({ hasSurvey: false, isWorking: false, maxRows: 12, bodyColumns: 100, scroll: { offset: 0, bodyRows: 12 }, view: {}, ...over }) as never

const slash = (args: string) => ({ command: 'mods', args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 100 } })
// What the person's Enter sends for `/q <args>`.
const q = (args: string) => ({ command: 'q', args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 100 } })

const ZERO = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const USAGE = { ...ZERO, input_tokens: 1, output_tokens: 1, model: 'm' }
const LONG = 'This is a long technical answer. '.repeat(10)

// A finished main-conversation turn. `over` can set `agentId`, `reason`, `isAborted`.
const turn = (id: string, over: Record<string, unknown> = {}) =>
  ({ answer: 'ok', durationMs: 1, isAborted: false, turnId: id, reason: 'answer' as const, usage: USAGE, ...over }) as never
const aborted = (id: string) => turn(id, { reason: 'aborted', isAborted: true })
const sessionEnd = () => ({ reason: 'clear' as const, sessionId: 's1', resume: {} }) as never
const compactInput = () => ({ trigger: 'manual', messages: [{ role: 'user', text: 'hi', toolUses: [] }] }) as never

type Submit = 'ok' | 'drop' | 'throw'

// `w.*` can be changed in the middle of a test: the stubs read it at each call.
const world = (on: any, init: { submitHold?: number; compactHold?: number; modelHold?: number } = {}) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  const w = {
    clock,
    submitHold: init.submitHold ?? 0, // how long the engine takes to take a prompt, in ms of the mocked clock
    submit: 'ok' as Submit,
    submits: [] as any[], // the prompt.submit events the engine stub received
    compactHold: init.compactHold ?? 0,
    compacts: [] as unknown[],
    modelHold: init.modelHold ?? 0,
    modelCalls: [] as any[],
    toasts: [] as string[],
    registered: [] as any[],
    order: [] as string[],
    logs: [] as string[], // the lines the plugin wrote with $.ui.log
  }
  on('ui.log', (_$: any, e: any) => {
    w.logs.push(typeof e.text === 'string' ? e.text : JSON.stringify(e))
    return { value: undefined }
  })
  on('ui.render', { component: 'AbovePrompt' }, ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return Text({ children: MARKER })
  })
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 160_000, window: 1_000_000 }, rateLimits: [] } }))
  on('session.surfaces', () => ({ value: ['terminal'] }))
  on('command.register', (_$: any, e: any) => {
    w.registered.push(e)
    return { value: { command: e.name } }
  })
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  on('turn.start', (_$: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: 'ok' }))
  on('session.end', (_$: any, e: any) => ({ sessionId: e.sessionId }))
  on('ui.toast', (_$: any, e: any) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('prompt.submit', async (_$: any, e: any) => {
    w.submits.push(e)
    w.order.push(`submit-asked-${w.submits.length}`)
    if (w.submitHold) await clock.sleep(w.submitHold)
    w.order.push(`submit-settled-${w.submits.length}`)
    if (w.submit === 'throw') throw new Error('the session is closing')
    if (w.submit === 'drop') return { drop: 'a hook said no' }
    return { text: e.text }
  })
  on('session.compact', async (_$: any, e: any) => {
    w.compacts.push(e)
    if (w.compactHold) await clock.sleep(w.compactHold)
    return { messages: [{ role: 'user', text: 'a summary', toolUses: [] }], tokensBefore: 160_000, tokensAfter: 4000 }
  })
  on('model.complete', async (_$: any, e: any) => {
    w.modelCalls.push(e)
    if (w.modelHold) await clock.sleep(w.modelHold)
    return { value: { isAnswered: true, text: 'A retold line.', usage: USAGE } }
  })
  return w
}

const mountBand = ($: any, over: Record<string, unknown> = {}, surface: 'terminal' | 'desktop' = 'terminal') =>
  $.ui.mount({ plugin: 'mod-pack', surface, component: 'AbovePrompt', props: props(over) })

const has = async (ui: any, text: string | RegExp) => (await ui.find({ type: 'Text', text })) !== undefined
const texts = (w: { submits: any[] }) => w.submits.map(s => s.text)
const run = async ($: any, args: string) => ((await $.command.run(q(args))).text ?? '') as string
const ON = { options: { waitWhat: true } }

// ---- registration ----

test('session.start registers /q as an immediate command (it must run while a turn runs) beside /mods', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  expect(w.registered.map(r => r.name)).toEqual(['mods', 'q'])
  const spec = w.registered.find(r => r.name === 'q')
  expect(spec.immediate).toBe(true)
  expect(spec.argumentHint).toContain('<text>')
})

// ---- the main flow ----

test('a prompt queued while a turn runs is sent when the turn ends, as the person\'s own words, once', async ($, on) => {
  const w = world(on)
  await $.turn.start({ text: 'first', turnId: 't1' })
  expect(await run($, '  fix the tests  ')).toContain('Queued 1 of 20: "fix the tests". It sends when the running turn ends.')
  expect(w.submits).toHaveLength(0) // nothing sent while the turn runs

  await $.turn.complete(turn('t1'))
  await w.clock.settle()
  expect(texts(w)).toEqual(['fix the tests']) // trimmed
  expect(w.submits[0].origin).toMatchObject({ kind: 'plugin', name: 'mod-pack', asUser: true })
  expect(await run($, 'list')).toBe('The prompt queue is empty. Type /q <text> to add a prompt.')
})

test('several prompts go out in order, one for each turn that ends', async ($, on) => {
  const w = world(on)
  await $.turn.start({ text: 'first', turnId: 't1' })
  await run($, 'one')
  await run($, 'two')
  await run($, 'three')

  await $.turn.complete(turn('t1'))
  await w.clock.settle()
  expect(texts(w)).toEqual(['one'])
  await $.turn.start({ text: 'one', turnId: 't2' }) // the engine runs the prompt it took
  expect(texts(w)).toEqual(['one']) // a turn that starts sends nothing more

  await $.turn.complete(turn('t2'))
  await w.clock.settle()
  expect(texts(w)).toEqual(['one', 'two'])
  await $.turn.start({ text: 'two', turnId: 't3' })
  await $.turn.complete(turn('t3'))
  await w.clock.settle()
  expect(texts(w)).toEqual(['one', 'two', 'three'])
  await $.turn.start({ text: 'three', turnId: 't4' })
  await $.turn.complete(turn('t4'))
  await w.clock.settle()
  expect(texts(w)).toEqual(['one', 'two', 'three']) // the queue is empty: nothing more
})

test('/q with no turn running sends the prompt at once; /q list and /q rm and /q clear work', async ($, on) => {
  const w = world(on)
  expect(await run($, 'now please')).toContain('sends now')
  await w.clock.settle()
  expect(texts(w)).toEqual(['now please'])

  await $.turn.start({ text: 'x', turnId: 't1' })
  await run($, 'a')
  await run($, 'b')
  await run($, 'c')
  expect(await run($, '')).toBe('Prompt queue (3 of 20, sends one at a time when a turn ends):\n  1. a\n  2. b\n  3. c')
  expect(await run($, 'rm 2')).toBe('Removed 2: "b".')
  expect(await run($, 'rm 5')).toBe('There is no prompt 5. The queue has 2.')
  expect(await run($, 'clear')).toBe('Cleared 2 queued prompts.')
  await $.turn.complete(turn('t1'))
  await w.clock.settle()
  expect(texts(w)).toEqual(['now please']) // the cleared prompts never sent
})

test('the caps: 20 prompts and 2000 characters', async ($, on) => {
  world(on)
  await $.turn.start({ text: 'x', turnId: 't1' })
  for (let i = 1; i <= 20; i++) await run($, `p${i}`)
  expect(await run($, 'p21')).toBe('The queue is full (20 prompts). Remove one with /q rm <n> first.')
  await run($, 'rm 1')
  expect(await run($, 'y'.repeat(2001))).toContain('The limit is 2000')
  expect(await run($, 'y'.repeat(2000))).toContain('Queued 20 of 20')
  expect(await run($, 'add')).toBe('Nothing to queue. Type /q <text>.')
})

// ---- detached, guarded ----

test('detached: turn.complete resolves while the engine is still taking the prompt', async ($, on) => {
  const w = world(on, { submitHold: 5 * SECOND })
  await $.turn.start({ text: 'x', turnId: 't1' })
  await run($, 'next')
  await $.turn.complete(turn('t1')).then(() => w.order.push('turn-complete-resolved'))
  expect(w.order).toEqual(['submit-asked-1', 'turn-complete-resolved']) // resolved first, the engine not yet done
  expect(w.clock.now()).toBe(1_000_000) // no time passed: the turn did not wait for it
  await w.clock.advance(5 * SECOND)
  expect(w.order).toEqual(['submit-asked-1', 'turn-complete-resolved', 'submit-settled-1'])
})

test('double submission: the same turn.complete twice sends once', async ($, on) => {
  const w = world(on)
  await $.turn.start({ text: 'x', turnId: 't1' })
  await run($, 'one')
  await run($, 'two')
  await $.turn.complete(turn('t1'))
  await $.turn.complete(turn('t1')) // the same turn, again
  await w.clock.settle()
  expect(texts(w)).toEqual(['one'])
  expect(await run($, 'list')).toContain('1. two')
})

test('re-entrancy: while a prompt is on its way, a second turn.complete sends nothing; after the turn starts, the next one does', async ($, on) => {
  const w = world(on, { submitHold: 60 * SECOND })
  await $.turn.start({ text: 'x', turnId: 't1' })
  await run($, 'one')
  await run($, 'two')
  await $.turn.complete(turn('t1'))
  await $.turn.complete(turn('t2')) // another turn ends, the first prompt is still on its way (the lock)
  await w.clock.settle()
  expect(texts(w)).toEqual(['one'])
  expect(await run($, 'list')).toContain('1. two') // kept, not lost

  await $.turn.start({ text: 'one', turnId: 't3' }) // the engine started the turn of the first prompt: the lock is free
  await $.turn.complete(turn('t3'))
  await w.clock.settle()
  expect(texts(w)).toEqual(['one', 'two'])
})

test('a prompt that never settles does not hold the lock for ever: it frees after 30 seconds', async ($, on) => {
  const w = world(on, { submitHold: 600 * SECOND })
  await $.turn.start({ text: 'x', turnId: 't1' })
  await run($, 'one')
  await run($, 'two')
  await $.turn.complete(turn('t1'))
  await w.clock.advance(29 * SECOND)
  await $.turn.complete(turn('t2'))
  expect(texts(w)).toEqual(['one']) // 29 seconds: still held
  await w.clock.advance(SECOND)
  await $.turn.complete(turn('t3'))
  await w.clock.settle()
  expect(texts(w)).toEqual(['one', 'two']) // 30 seconds: free
})

test('a prompt typed with /q during a pending send waits for the end of the next turn', async ($, on) => {
  const w = world(on, { submitHold: 60 * SECOND })
  await $.turn.start({ text: 'x', turnId: 't1' })
  await run($, 'one')
  await $.turn.complete(turn('t1')) // sends "one"
  const text = await run($, 'two') // no turn runs yet, but "one" is on its way
  expect(text).toContain('on its way')
  expect(texts(w)).toEqual(['one'])
})

test('a concurrent /q and turn.complete lose and double nothing', async ($, on) => {
  const w = world(on)
  await $.turn.start({ text: 'x', turnId: 't1' })
  await run($, 'a')
  await Promise.all([$.turn.complete(turn('t1')), $.command.run(q('b'))])
  await w.clock.settle()
  expect(texts(w)).toEqual(['a'])
  expect(await run($, 'list')).toContain('1. b')
})

// ---- subagents, abort, errors ----

test('a subagent turn sends nothing and keeps the queue', async ($, on) => {
  const w = world(on)
  await $.turn.start({ text: 'x', turnId: 't1' })
  await run($, 'one')
  await $.turn.complete(turn('sub1', { agentId: 'agent-1' }))
  await w.clock.settle()
  expect(w.submits).toHaveLength(0)
  expect(await run($, 'list')).toContain('1. one')
  const ui = await mountBand($, { isWorking: true })
  expect(await has(ui, 'queue (1): 1 one')).toBe(true)
  await ui.unmount()
})

test('an interrupted turn pauses the queue: nothing is sent, the row and a toast say so; /q resume sends', async ($, on) => {
  const w = world(on)
  await $.turn.start({ text: 'x', turnId: 't1' })
  await run($, 'one')
  await run($, 'two')
  await $.turn.complete(aborted('t1'))
  await w.clock.settle()
  expect(w.submits).toHaveLength(0)
  expect(w.toasts).toEqual(['Prompt Queue paused: you interrupted the turn. Type /q resume to send.'])

  const ui = await mountBand($)
  expect(await has(ui, 'queue paused (2): you interrupted the turn · /q resume sends · /q clear drops')).toBe(true)
  expect(JSON.stringify(await ui.drawn())).toContain('"color":"yellow"')

  // A later answer does not lift the pause, and a prompt added now only waits.
  await $.turn.start({ text: 'y', turnId: 't2' })
  await $.turn.complete(turn('t2'))
  await w.clock.settle()
  expect(w.submits).toHaveLength(0)
  expect(await run($, 'three')).toContain('paused (you interrupted the turn)')
  expect(w.submits).toHaveLength(0)

  expect(await run($, 'resume')).toContain('Resumed.')
  await w.clock.settle()
  expect(texts(w)).toEqual(['one']) // no turn runs: sent at once
  expect(await has(ui, /queue paused/)).toBe(false)
  expect(await has(ui, 'queue (2): 1 two · 2 three')).toBe(true)
  await ui.unmount()
})

test('/q pause stops the sending until /q resume; the end of a turn with an error or a refusal pauses', async ($, on) => {
  const w = world(on)
  await $.turn.start({ text: 'x', turnId: 't1' })
  await run($, 'one')
  expect(await run($, 'pause')).toBe('The queue is paused. Type /q resume to send again.')
  await $.turn.complete(turn('t1'))
  await w.clock.settle()
  expect(w.submits).toHaveLength(0)
  await run($, 'resume') // no turn runs: sends "one"
  await w.clock.settle()
  expect(texts(w)).toEqual(['one'])

  for (const [reason, text] of [['error', 'the last turn ended with an error'], ['refusal', 'the model refused the last turn']] as const) {
    await $.turn.start({ text: 'x', turnId: `e-${reason}` })
    await run($, `after ${reason}`)
    await $.turn.complete(turn(`e-${reason}`, { reason, ...(reason === 'refusal' ? { refusal: { category: null, explanation: null } } : {}) }))
    await w.clock.settle()
    expect(texts(w)).toEqual(['one']) // nothing more
    expect(await run($, 'list')).toContain(`paused: ${text}`)
    await run($, 'clear')
  }
})

test('after an interrupt with an empty queue nothing is paused: a later /q behaves as usual', async ($, on) => {
  const w = world(on)
  await $.turn.start({ text: 'x', turnId: 't1' })
  await $.turn.complete(aborted('t1'))
  expect(w.toasts).toEqual([])
  expect(await run($, 'go')).toContain('sends now')
})

// ---- empty queue ----

test('empty queue: turn.complete sends nothing, no row, no toast; list says it is empty', async ($, on) => {
  const w = world(on)
  await $.turn.start({ text: 'x', turnId: 't1' })
  await $.turn.complete(turn('t1'))
  await w.clock.settle()
  expect(w.submits).toHaveLength(0)
  expect(w.toasts).toEqual([])
  const ui = await mountBand($)
  expect(await has(ui, /queue/)).toBe(false)
  expect(await has(ui, MARKER)).toBe(true)
  await ui.unmount()
  expect(await run($, '')).toBe('The prompt queue is empty. Type /q <text> to add a prompt.')
})

// ---- the shared automation lock ----

test('a compaction in progress: nothing is sent; the prompts stay; the next turn that ends sends', async ($, on) => {
  const w = world(on, { compactHold: 3 * SECOND })
  await $.turn.start({ text: 'x', turnId: 't1' })
  await run($, 'one')
  const compacting = $.session.compact(compactInput())
  await w.clock.settle()

  await $.turn.complete(turn('t1')) // a turn ends while the compaction runs
  await w.clock.settle()
  expect(w.submits).toHaveLength(0)
  expect(await run($, 'list')).toContain('1. one')

  await w.clock.advance(3 * SECOND)
  await compacting
  await w.clock.settle()
  expect(w.submits).toHaveLength(0) // not sent by the end of the compaction: it waits for the next turn

  await $.turn.start({ text: 'y', turnId: 't2' })
  await $.turn.complete(turn('t2'))
  await w.clock.settle()
  expect(texts(w)).toEqual(['one'])
})

test('/q while a compaction runs and nothing else does: it is queued, not sent; /q resume sends it after', async ($, on) => {
  const w = world(on, { compactHold: 3 * SECOND })
  const compacting = $.session.compact(compactInput())
  await w.clock.settle()
  expect(await run($, 'one')).toContain('A compaction is running, so nothing is sent yet.')
  expect(w.submits).toHaveLength(0)

  await w.clock.advance(3 * SECOND)
  await compacting
  expect(await run($, 'resume')).toContain('The queue was not paused.')
  await w.clock.settle()
  expect(texts(w)).toEqual(['one'])
})

test('a Wait What model call in flight does NOT hold the queue back: it is cancelled and the prompt is sent', ON, async ($, on) => {
  const w = world(on, { modelHold: 5 * SECOND })
  await $.turn.start({ text: 'x', turnId: 't1' })
  await $.turn.complete(turn('t1', { answer: LONG })) // the queue is empty: Wait What starts its call
  await w.clock.settle()
  expect(w.modelCalls).toHaveLength(1)

  expect(await run($, 'go on')).toContain('sends now') // the lock is held by the model call
  await w.clock.settle()
  expect(texts(w)).toEqual(['go on'])

  await w.clock.advance(5 * SECOND) // the call's reply came late: dropped
  const ui = await mountBand($)
  expect(await has(ui, /retold line/)).toBe(false)
  await ui.unmount()
})

test('both on: when the queue sends the next prompt, Wait What makes no call and spends none of its hourly budget; with an empty queue it does', { options: { waitWhat: true, maxModelCallsPerHour: 1 } }, async ($, on) => {
  const w = world(on)
  await $.turn.start({ text: 'x', turnId: 't1' })
  await run($, 'next')
  await $.turn.complete(turn('t1', { answer: LONG }))
  await w.clock.settle()
  expect(texts(w)).toEqual(['next'])
  expect(w.modelCalls).toHaveLength(0) // no tokens spent on an answer that the next prompt replaces at once

  await $.turn.start({ text: 'next', turnId: 't2' })
  await $.turn.complete(turn('t2', { answer: LONG })) // the queue is empty now; the budget of 1 call an hour is still whole
  await w.clock.settle()
  expect(w.modelCalls).toHaveLength(1)
  const ui = await mountBand($)
  expect(await has(ui, 'A retold line.')).toBe(true)
  await ui.unmount()
})

test('a compaction that starts while a prompt is on its way takes the lock; the prompt settling does not free it', async ($, on) => {
  const w = world(on, { submitHold: 2 * SECOND, compactHold: 5 * SECOND })
  await $.turn.start({ text: 'x', turnId: 't1' })
  await run($, 'one')
  await run($, 'two')
  await $.turn.complete(turn('t1')) // sends "one", the engine is slow
  const compacting = $.session.compact(compactInput())
  await w.clock.settle()
  const ui = await mountBand($)
  expect(await has(ui, '⏱ compacting…')).toBe(true)

  await w.clock.advance(2 * SECOND) // the prompt settles
  expect(await has(ui, '⏱ compacting…')).toBe(true) // still the compaction's lock
  await $.turn.complete(turn('t2'))
  await w.clock.settle()
  expect(texts(w)).toEqual(['one']) // a compaction holds the queue

  await w.clock.advance(3 * SECOND)
  await compacting
  expect(await has(ui, '⏱ compacting…')).toBe(false)
  await ui.unmount()
})

test('the compact button while a prompt is on its way: not run, a toast says why; later it works', async ($, on) => {
  const w = world(on, { submitHold: 5 * SECOND })
  await $.turn.start({ text: 'x', turnId: 't1' })
  await run($, 'one')
  await $.turn.complete(turn('t1'))
  const ui = await mountBand($)
  await ui.press({ key: 'compact' })
  expect(w.compacts).toHaveLength(0)
  expect(w.toasts).toEqual(['Cache Keeper: Prompt Queue is sending a prompt. Press compact again in a moment.'])

  await w.clock.advance(5 * SECOND)
  await ui.press({ key: 'compact' })
  expect(w.compacts).toHaveLength(1)
  await ui.unmount()
})

// ---- the engine refuses the prompt ----

for (const mode of ['drop', 'throw'] as const) {
  test(`the engine refuses the prompt (${mode}): it is back on top, the queue is paused, a toast says so, the lock is free`, async ($, on) => {
    const w = world(on)
    w.submit = mode
    await $.turn.start({ text: 'x', turnId: 't1' })
    await run($, 'one')
    await run($, 'two')
    await $.turn.complete(turn('t1'))
    await w.clock.settle()
    expect(texts(w)).toEqual(['one'])
    expect(w.toasts).toHaveLength(1)
    expect(w.toasts[0]).toContain('could not send a queued prompt')
    expect(await run($, 'list')).toContain('paused: Claude Code did not accept the last prompt')
    expect(await run($, 'list')).toContain('1. one\n  2. two')

    // The lock is free again: a compaction by the button works, and resume sends "one" again.
    w.submit = 'ok'
    await $.turn.start({ text: 'y', turnId: 't2' })
    await $.turn.complete(turn('t2'))
    await w.clock.settle()
    expect(texts(w)).toEqual(['one']) // paused: nothing more
    await run($, 'resume')
    await w.clock.settle()
    expect(texts(w)).toEqual(['one', 'one'])
  })
}

// ---- off, /clear ----

test('/mods off prompt-queue: /q says the mod is off, nothing is queued, nothing is sent, the row goes; /mods on starts empty', async ($, on) => {
  const w = world(on)
  await $.turn.start({ text: 'x', turnId: 't1' })
  await run($, 'one')
  const ui = await mountBand($, { isWorking: true })
  expect(await has(ui, 'queue (1): 1 one')).toBe(true)

  expect((await $.command.run(slash('off prompt-queue'))).text).toBe('mod-pack: prompt-queue is OFF.')
  expect(await has(ui, /queue/)).toBe(false) // the row goes at once
  expect(await has(ui, MARKER)).toBe(true)
  expect(await run($, 'two')).toBe('mod-pack: prompt-queue is OFF. Nothing is queued and nothing is sent. Turn it on with /mods on prompt-queue.')

  await $.turn.complete(turn('t1'))
  await w.clock.settle()
  expect(w.submits).toHaveLength(0)

  await $.command.run(slash('on prompt-queue'))
  expect(await run($, 'list')).toBe('The prompt queue is empty. Type /q <text> to add a prompt.') // "one" did not come back
  await $.turn.start({ text: 'y', turnId: 't2' })
  await $.turn.complete(turn('t2'))
  await w.clock.settle()
  expect(w.submits).toHaveLength(0)
  await ui.unmount()
})

test('/mods lists Prompt Queue ON by default, and /mods off then on again works', async ($, on) => {
  world(on)
  const list = await $.command.run(slash(''))
  expect(list.text).toMatch(/ON\s+prompt-queue\s+Prompt Queue: type \/q <text>/)
  const line = (list.text ?? '').split('\n').find(l => l.includes('prompt-queue')) ?? ''
  expect(line).not.toContain('uses model tokens')
  expect(line).toContain('queued prompts run with your permissions')
})

test('the promptQueue setting off: /q says it is off and nothing sends; a /mods on choice beats the setting', { options: { promptQueue: false } }, async ($, on) => {
  const w = world(on)
  expect(await run($, 'one')).toContain('prompt-queue is OFF')
  await $.turn.start({ text: 'x', turnId: 't1' })
  await $.turn.complete(turn('t1'))
  await w.clock.settle()
  expect(w.submits).toHaveLength(0)

  await $.command.run(slash('on prompt-queue'))
  await $.turn.start({ text: 'x', turnId: 't2' })
  expect(await run($, 'one')).toContain('Queued 1 of 20')
  await $.turn.complete(turn('t2'))
  await w.clock.settle()
  expect(texts(w)).toEqual(['one'])
})

test('/clear (session.end) empties the queue and the row; nothing is sent after it', async ($, on) => {
  const w = world(on)
  await $.turn.start({ text: 'x', turnId: 't1' })
  await run($, 'one')
  const ui = await mountBand($)
  expect(await has(ui, /queue \(1\)/)).toBe(true)
  await $.session.end(sessionEnd())
  expect(await has(ui, /queue/)).toBe(false)
  await $.turn.complete(turn('t2'))
  await w.clock.settle()
  expect(w.submits).toHaveLength(0)
  await ui.unmount()
})

// ---- the band: beside the other rows ----

test('beside Token Weather, Cache Keeper and the next-steps stub: all four show, in order, none overwritten; the row stays while a turn runs', async ($, on) => {
  world(on)
  await $.turn.start({ text: 'x', turnId: 't1' })
  await $.turn.complete(turn('t0')) // a response, so the other rows exist
  await $.turn.start({ text: 'y', turnId: 't1b' })
  await run($, 'fix tests')
  await run($, 'update docs')

  const ui = await mountBand($) // maxRows 12: budget 4
  expect(await has(ui, MARKER)).toBe(true)
  expect(await has(ui, /16% 160k \/ 1M/)).toBe(true)
  expect(await has(ui, /cache warm 60m left/)).toBe(true)
  expect(await has(ui, 'queue (2): 1 fix tests · 2 update docs')).toBe(true)

  const tree = JSON.stringify(await ui.drawn())
  const [marker, weather, cache, queue] = [tree.indexOf(MARKER), tree.indexOf('Clear'), tree.indexOf('cache warm'), tree.indexOf('queue (2)')]
  expect(marker).toBeGreaterThan(-1)
  expect(weather).toBeGreaterThan(marker)
  expect(cache).toBeGreaterThan(weather)
  expect(queue).toBeGreaterThan(cache)
  await ui.unmount()

  // While a turn runs (isWorking) Cache Keeper hides, the queue stays: that is when it matters.
  const working = await mountBand($, { isWorking: true })
  expect(await has(working, /cache warm/)).toBe(false)
  expect(await has(working, 'queue (2): 1 fix tests · 2 update docs')).toBe(true)
  await working.unmount()
})

test('no digit hotkey: the queue row has no Button at all', async ($, on) => {
  world(on)
  await $.turn.start({ text: 'x', turnId: 't1' })
  await run($, 'fix tests')
  const ui = await mountBand($, { isWorking: true })
  expect(await has(ui, /queue \(1\)/)).toBe(true)
  expect(await ui.findAll({ type: 'Button' })).toHaveLength(0) // Cache Keeper hides while a turn runs, so none at all
  expect(JSON.stringify(await ui.drawn())).not.toContain('hotkey')
  await ui.unmount()
})

test('row budget with Token Weather, Cache Keeper and the queue: 1 row = Token Weather only; 2 = + Cache Keeper; 3 = + the queue', async ($, on) => {
  world(on)
  await $.turn.complete(turn('t0'))
  await $.turn.start({ text: 'x', turnId: 't1' })
  await run($, 'fix tests')
  for (const [maxRows, shown] of [[5, 1], [6, 2], [8, 2], [9, 3], [12, 3]] as const) {
    const ui = await mountBand($, { maxRows })
    const present = [await has(ui, /Clear/), await has(ui, /cache warm/), await has(ui, /queue \(1\)/)]
    expect([maxRows, present.filter(Boolean).length]).toEqual([maxRows, shown])
    await ui.unmount()
  }
})

test('all four rows (Wait What on, a paused queue): the queue row comes before the retell, and the retell is clipped to the 1 line that is left of the budget 4', ON, async ($, on) => {
  const w = world(on)
  await $.turn.start({ text: 'x', turnId: 't1' })
  await run($, 'pause')
  await run($, 'fix tests')
  await $.turn.complete(turn('t1', { answer: LONG })) // paused: nothing is sent; Wait What retells
  await w.clock.settle()
  expect(w.submits).toHaveLength(0)
  expect(w.modelCalls).toHaveLength(1)

  w.modelCalls.length = 0
  const ui = await mountBand($) // maxRows 12: budget 4 = Token Weather 1 + Cache Keeper 1 + queue 1 + 1 line of the retell
  expect(await has(ui, MARKER)).toBe(true)
  expect(await has(ui, /Clear/)).toBe(true)
  expect(await has(ui, /cache warm/)).toBe(true)
  expect(await has(ui, /queue paused \(1\)/)).toBe(true)
  expect(await has(ui, 'A retold line.')).toBe(true)

  const tree = JSON.stringify(await ui.drawn())
  const [weather, cache, queue, retell] = [tree.indexOf('Clear'), tree.indexOf('cache warm'), tree.indexOf('queue paused'), tree.indexOf('A retold line.')]
  expect(cache).toBeGreaterThan(weather)
  expect(queue).toBeGreaterThan(cache)
  expect(retell).toBeGreaterThan(queue) // the queue row is not starved by the retell: it stands before it
  expect(tree).not.toContain('"height":2') // the retell has 1 line of the budget, not 2
  await ui.unmount()
})

test('a narrow band: the row is cut to the width, with `· …` when prompts are left out', async ($, on) => {
  world(on)
  await $.turn.start({ text: 'x', turnId: 't1' })
  for (const text of ['fix the failing tests', 'update the docs', 'write the changelog', 'bump the version']) await run($, text)
  const ui = await mountBand($, { bodyColumns: 60, isWorking: true })
  const row = (await ui.findAll({ type: 'Text' })).map((t: any) => t.text as string).find((t: string) => t.startsWith('queue'))!
  expect(row.length).toBeLessThanOrEqual(60)
  expect(row.startsWith('queue (4): 1 fix the failing tests')).toBe(true)
  expect(row.endsWith('· …')).toBe(true)
  await ui.unmount()
})

test('off the terminal or with a survey: the row is not drawn, the command still answers', async ($, on) => {
  world(on)
  await $.turn.start({ text: 'x', turnId: 't1' })
  await run($, 'fix tests')
  const desktop = await mountBand($, {}, 'desktop')
  expect(await has(desktop, /queue/)).toBe(false)
  expect(await has(desktop, MARKER)).toBe(true)
  await desktop.unmount()
  const survey = await mountBand($, { hasSurvey: true })
  expect(await has(survey, /queue/)).toBe(false)
  await survey.unmount()
  expect(await run($, 'list')).toContain('1. fix tests')
})

test('a queued prompt with an escape sequence is cleaned in the row and in the list, and sent as typed', async ($, on) => {
  const w = world(on)
  await $.turn.start({ text: 'x', turnId: 't1' })
  const nasty = 'say \x1b]0;pwned\x07hi'
  await run($, nasty)
  const ui = await mountBand($, { isWorking: true })
  expect(JSON.stringify(await ui.drawn())).not.toMatch(/pwned\\u0007|\\u001b|\\u0007/)
  expect(JSON.stringify(await run($, 'list'))).not.toMatch(/\\u001b|\\u0007/)
  await ui.unmount()
  await $.turn.complete(turn('t1'))
  await w.clock.settle()
  expect(texts(w)).toEqual([nasty]) // what the person typed is what is sent
})
