// The flow of Wait What through the plugin. The engine is stubbed beneath it: `clock` (moves
// only when the test moves it), `store`, `session.usage`, `session.surfaces`, `model.complete`
// (the model: it can be held, fail, throw or answer, and records every request it gets),
// `session.compact` (a compaction that can be held), `ui.toast`, `ui.invalidate`, `turn.start`,
// `turn.complete`, `session.end`, and a stub standing for next-steps in the AbovePrompt band.
// Nothing is drawn on a real screen: `ui.mount` runs the plugin's `ui.render` hook and the kit
// reads the tree. The model is never reached: every reply here is the stub's.

import { test, expect, mock } from 'claude-code/testing'

const MARKER = 'OTHER-PLUGIN-BAND'
const MIN = 60_000

const props = (over: Record<string, unknown> = {}) =>
  ({ hasSurvey: false, isWorking: false, maxRows: 12, bodyColumns: 100, scroll: { offset: 0, bodyRows: 12 }, view: {}, ...over }) as never

const slash = (args: string) => ({ command: 'mods', args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 100 } })

const ZERO = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const USAGE = { ...ZERO, input_tokens: 1, output_tokens: 1, model: 'm' }

// An answer of 330 characters: long enough to be retold (200 or more).
const LONG = 'This is a long technical answer. '.repeat(10)

// A finished main-conversation turn. `over` can set `answer`, `agentId`, `reason`, `isAborted`.
const turn = (id: string, over: Record<string, unknown> = {}) =>
  ({ answer: LONG, durationMs: 1, isAborted: false, turnId: id, reason: 'answer' as const, usage: USAGE, ...over }) as never

const ON = { options: { waitWhat: true } }

type Mode = 'ok' | 'api-error' | 'empty' | 'throw'

// `w.*` can be changed in the middle of a test: the stubs read it at each call.
const world = (on: any, init: { modelHold?: number; compactHold?: number } = {}) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  const w = {
    clock,
    tokens: 160_000,
    surfaces: ['terminal'] as string[] | 'reject',
    modelHold: init.modelHold ?? 0, // how long the model stub sleeps, in ms of the mocked clock
    mode: 'ok' as Mode,
    reply: (n: number) => `Reply ${n}, line one.\nReply ${n}, line two.`,
    modelCalls: [] as any[], // the requests the model stub received
    compactHold: init.compactHold ?? 0,
    compacts: [] as unknown[],
    toasts: [] as string[],
    order: [] as string[], // what happened first, for the ordering tests
  }
  on('ui.render', { component: 'AbovePrompt' }, ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return Text({ children: MARKER })
  })
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: w.tokens, window: 1_000_000 }, rateLimits: [] } }))
  on('session.surfaces', () => {
    if (w.surfaces === 'reject') throw new Error('no surfaces')
    return { value: w.surfaces }
  })
  on('turn.start', (_$: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: 'ok' }))
  on('session.end', (_$: any, e: any) => ({ sessionId: e.sessionId }))
  on('ui.toast', (_$: any, e: any) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('session.compact', async () => {
    w.compacts.push(1)
    if (w.compactHold) await clock.sleep(w.compactHold)
    return { messages: [{ role: 'user', text: 'a summary', toolUses: [] }], tokensBefore: 160_000, tokensAfter: 4000 }
  })
  on('model.complete', async (_$: any, e: any) => {
    w.modelCalls.push(e)
    const n = w.modelCalls.length
    w.order.push(`model-asked-${n}`)
    if (w.modelHold) await clock.sleep(w.modelHold)
    w.order.push(`model-answered-${n}`)
    if (w.mode === 'throw') throw new Error('model blocked')
    if (w.mode === 'api-error') return { value: { isAnswered: false, reason: 'api-error', status: 500, error: 'server_error', usage: ZERO } }
    if (w.mode === 'empty') return { value: { isAnswered: false, reason: 'empty-reply', usage: ZERO } }
    return { value: { isAnswered: true, text: w.reply(n), usage: USAGE } }
  })
  return w
}

const mountBand = ($: any, over: Record<string, unknown> = {}, surface: 'terminal' | 'desktop' = 'terminal') =>
  $.ui.mount({ plugin: 'mod-pack', surface, component: 'AbovePrompt', props: props(over) })

const has = async (ui: any, text: string | RegExp) => (await ui.find({ type: 'Text', text })) !== undefined
const compactButton = (ui: any) => ui.find({ type: 'Button', key: 'compact' })
const compactInput = (over: Record<string, unknown> = {}) => ({ trigger: 'manual', messages: [{ role: 'user', text: 'hi', toolUses: [] }], ...over }) as never
const sessionEnd = () => ({ reason: 'clear' as const, sessionId: 's1', resume: {} }) as never

// ---- it is OFF by default, and the switches work ----

test('default: wait-what is OFF. A long answer makes no model call at all and draws no row', async ($, on) => {
  const w = world(on)
  await $.turn.complete(turn('t1'))
  await w.clock.settle()
  expect(w.modelCalls).toHaveLength(0) // the model stub was never reached
  const ui = await mountBand($)
  expect(await has(ui, MARKER)).toBe(true)
  expect(await has(ui, /Reply|wait what|wait-what/)).toBe(false)
  await ui.unmount()
})

test('/mods lists Wait What OFF by default, flagged as using model tokens', async ($, on) => {
  world(on)
  const list = await $.command.run(slash(''))
  expect(list.text).toMatch(/OFF\s+wait-what\s+Wait What: plain-words retell/)
  const line = (list.text ?? '').split('\n').find(l => l.includes('wait-what')) ?? ''
  expect(line).toContain('SPENDS model tokens')
  expect(line).toContain('[uses model tokens]')
})

test('/mods on wait-what starts the calls; /mods off wait-what stops them and removes the row at once', async ($, on) => {
  const w = world(on)
  expect((await $.command.run(slash('on wait-what'))).text).toBe('mod-pack: wait-what is ON.')
  await $.turn.complete(turn('t1'))
  await w.clock.settle()
  expect(w.modelCalls).toHaveLength(1)
  const ui = await mountBand($)
  expect(await has(ui, /Reply 1, line one/)).toBe(true)

  expect((await $.command.run(slash('off wait-what'))).text).toBe('mod-pack: wait-what is OFF.')
  expect(await has(ui, /Reply 1/)).toBe(false)
  expect(await has(ui, MARKER)).toBe(true)

  await $.turn.complete(turn('t2'))
  await w.clock.settle()
  expect(w.modelCalls).toHaveLength(1) // no second call while it is off
  await ui.unmount()
})

test('the waitWhat setting on: it works with no /mods choice; a /mods off choice beats the setting', ON, async ($, on) => {
  const w = world(on)
  await $.turn.complete(turn('t1'))
  await w.clock.settle()
  expect(w.modelCalls).toHaveLength(1)

  await $.command.run(slash('off wait-what'))
  await $.turn.complete(turn('t2'))
  await w.clock.settle()
  expect(w.modelCalls).toHaveLength(1)
})

test('the waitWhat setting off: no call; a /mods on choice beats the setting', { options: { waitWhat: false } }, async ($, on) => {
  const w = world(on)
  await $.turn.complete(turn('t1'))
  await w.clock.settle()
  expect(w.modelCalls).toHaveLength(0)
  await $.command.run(slash('on wait-what'))
  await $.turn.complete(turn('t2'))
  await w.clock.settle()
  expect(w.modelCalls).toHaveLength(1)
})

test('/mods off while a call is in flight: the reply is dropped and no row shows', ON, async ($, on) => {
  const w = world(on, { modelHold: 5000 })
  await $.turn.complete(turn('t1'))
  await w.clock.settle()
  expect(w.modelCalls).toHaveLength(1)
  await $.command.run(slash('off wait-what'))
  await w.clock.advance(5000)
  await $.command.run(slash('on wait-what'))
  const ui = await mountBand($)
  expect(await has(ui, /Reply/)).toBe(false)
  await ui.unmount()
})

// ---- the call ----

test('a long answer: one call to the haiku alias with a small cap and a time limit, and a 2-line retell below the other plugin', ON, async ($, on) => {
  const w = world(on)
  await $.turn.complete(turn('t1'))
  await w.clock.settle()

  expect(w.modelCalls).toHaveLength(1)
  const [call] = w.modelCalls
  expect(call.model).toBe('haiku')
  expect(call.maxTokens).toBe(120)
  expect(call.timeoutMs).toBe(15_000)
  expect(call.effort).toBe('low')
  expect(call.system).toContain('plain words')
  expect(call.system).toContain('at most 2 short lines')
  expect(call.prompt).toContain('This is a long technical answer.')
  expect(call).not.toHaveProperty('messages') // one prompt, no history

  const ui = await mountBand($)
  expect(await has(ui, 'wait what: ')).toBe(true)
  expect(await has(ui, 'Reply 1, line one.')).toBe(true)
  expect(await has(ui, 'Reply 1, line two.')).toBe(true)
  const tree = JSON.stringify(await ui.drawn())
  expect(tree.indexOf('Reply 1, line one.')).toBeGreaterThan(tree.indexOf(MARKER))
  expect(tree).toContain('"height":2')
  await ui.unmount()
})

test('the answer sent is cut to 4000 characters, keeping its start and its end', ON, async ($, on) => {
  const w = world(on)
  await $.turn.complete(turn('t1', { answer: `HEAD-${'m'.repeat(20_000)}-TAIL` }))
  await w.clock.settle()
  const sent: string = w.modelCalls[0].prompt
  expect(sent.length).toBeLessThanOrEqual(4000 + '<answer>\n\n</answer>'.length)
  expect(sent).toContain('<answer>\nHEAD-')
  expect(sent).toContain('-TAIL\n</answer>')
  expect(sent).toContain('left out')
})

test('skip rules: no model call for a short answer, a subagent, an interrupt, an error, a refusal', ON, async ($, on) => {
  const w = world(on)
  await $.turn.complete(turn('t1', { answer: 'x'.repeat(199) }))
  await $.turn.complete(turn('t2', { agentId: 'agent-1' }))
  await $.turn.complete(turn('t3', { reason: 'aborted', isAborted: true }))
  await $.turn.complete(turn('t4', { reason: 'error' }))
  await $.turn.complete(turn('t5', { reason: 'refusal', refusal: { category: null, explanation: null } }))
  await w.clock.settle()
  expect(w.modelCalls).toHaveLength(0)

  await $.turn.complete(turn('t6', { answer: 'x'.repeat(200) })) // exactly 200: retold
  await w.clock.settle()
  expect(w.modelCalls).toHaveLength(1)
})

test('a subagent turn neither starts a call nor clears the retell of the main answer', ON, async ($, on) => {
  const w = world(on)
  await $.turn.complete(turn('t1'))
  await w.clock.settle()
  await $.turn.complete(turn('sub1', { agentId: 'agent-1' }))
  await w.clock.settle()
  expect(w.modelCalls).toHaveLength(1)
  const ui = await mountBand($)
  expect(await has(ui, /Reply 1, line one/)).toBe(true)
  await ui.unmount()
})

test('terminal only: with no terminal surface, or when the surfaces cannot be read, there is no call', ON, async ($, on) => {
  const w = world(on)
  w.surfaces = ['desktop']
  await $.turn.complete(turn('t1'))
  w.surfaces = []
  await $.turn.complete(turn('t2'))
  w.surfaces = 'reject'
  await $.turn.complete(turn('t3'))
  await w.clock.settle()
  expect(w.modelCalls).toHaveLength(0)

  w.surfaces = ['mobile', 'terminal'] // a terminal beside a phone: the row is drawn there, one call
  await $.turn.complete(turn('t4'))
  await w.clock.settle()
  expect(w.modelCalls).toHaveLength(1)
})

test('off the terminal: a mounted desktop band shows no retell', ON, async ($, on) => {
  const w = world(on)
  await $.turn.complete(turn('t1'))
  await w.clock.settle()
  const ui = await mountBand($, {}, 'desktop')
  expect(await has(ui, /Reply|wait what/)).toBe(false)
  await ui.unmount()
})

// ---- detached, late, failed ----

test('detached: turn.complete resolves while the model is still working; the row comes when the model answers', ON, async ($, on) => {
  const w = world(on, { modelHold: 5000 })
  const done = $.turn.complete(turn('t1')).then(() => w.order.push('turn-complete-resolved'))
  await done
  expect(w.order).toEqual(['model-asked-1', 'turn-complete-resolved']) // resolved first, the model not yet answered
  expect(w.clock.now()).toBe(1_000_000) // no time passed: the turn did not wait for it

  const ui = await mountBand($)
  expect(await has(ui, /Reply/)).toBe(false) // nothing while the call runs
  await w.clock.advance(4999)
  expect(await has(ui, /Reply/)).toBe(false)
  await w.clock.advance(1)
  expect(w.order).toEqual(['model-asked-1', 'turn-complete-resolved', 'model-answered-1'])
  expect(await has(ui, 'Reply 1, line one.')).toBe(true)
  await ui.unmount()
})

test('late result: a new turn starts while the call runs, so the old reply is dropped; the next answer gets its own', ON, async ($, on) => {
  const w = world(on, { modelHold: 5000 })
  await $.turn.complete(turn('t1'))
  await $.turn.start({ text: 'next prompt', turnId: 't2' })
  await w.clock.advance(5000)
  const ui = await mountBand($)
  expect(await has(ui, /Reply/)).toBe(false)

  w.modelHold = 0
  await $.turn.complete(turn('t2'))
  await w.clock.settle()
  expect(w.modelCalls).toHaveLength(2)
  expect(await has(ui, 'Reply 2, line one.')).toBe(true)
  expect(await has(ui, /Reply 1/)).toBe(false)
  await ui.unmount()
})

test('late result: a newer answer ends while the older call runs. The lock is held, so there is no second call, and the older reply is dropped', ON, async ($, on) => {
  const w = world(on, { modelHold: 5000 })
  await $.turn.complete(turn('t1'))
  await $.turn.complete(turn('t2')) // no turn.start between: the model call of t1 still holds the lock
  await w.clock.advance(5000)
  expect(w.modelCalls).toHaveLength(1)
  const ui = await mountBand($)
  expect(await has(ui, /Reply/)).toBe(false) // t1's retell belongs to an answer that is no longer the last one

  w.modelHold = 0
  await $.turn.complete(turn('t3'))
  await w.clock.settle()
  expect(w.modelCalls).toHaveLength(2)
  expect(await has(ui, 'Reply 2, line one.')).toBe(true)
  await ui.unmount()
})

test('a turn start clears the retell at once', ON, async ($, on) => {
  const w = world(on)
  await $.turn.complete(turn('t1'))
  await w.clock.settle()
  const ui = await mountBand($)
  expect(await has(ui, /Reply 1/)).toBe(true)
  await $.turn.start({ text: 'go', turnId: 't2' })
  expect(await has(ui, /Reply 1|wait what/)).toBe(false)
  await ui.unmount()
})

test('while a turn runs (isWorking) the row is not drawn', ON, async ($, on) => {
  const w = world(on)
  await $.turn.complete(turn('t1'))
  await w.clock.settle()
  const ui = await mountBand($, { isWorking: true })
  expect(await has(ui, /Reply/)).toBe(false)
  expect(await has(ui, MARKER)).toBe(true)
  await ui.unmount()
})

for (const mode of ['api-error', 'empty', 'throw'] as const) {
  test(`the model call fails (${mode}): no row, no crash, the other plugin draws, the lock is free, and the next answer is retold`, ON, async ($, on) => {
    const w = world(on)
    w.mode = mode
    await $.turn.complete(turn('t1'))
    await w.clock.settle()
    expect(w.modelCalls).toHaveLength(1)
    const ui = await mountBand($)
    expect(await has(ui, /Reply|wait what/)).toBe(false)
    expect(await has(ui, MARKER)).toBe(true)
    expect(w.toasts).toEqual([])

    // The lock is free: the compact button works at once (a Cache Keeper row stands after the answer).
    expect(await compactButton(ui)).toBeDefined()
    await ui.press({ key: 'compact' })
    expect(w.compacts).toHaveLength(1)
    expect(w.toasts).toEqual([])

    w.mode = 'ok'
    await $.turn.complete(turn('t2'))
    await w.clock.settle()
    expect(w.modelCalls).toHaveLength(2)
    expect(await has(ui, 'Reply 2, line one.')).toBe(true)
    await ui.unmount()
  })
}

test('a failed call still counts toward the hourly cap (a failing model cannot be hit without limit)', { options: { waitWhat: true, maxModelCallsPerHour: 2 } }, async ($, on) => {
  const w = world(on)
  w.mode = 'api-error'
  for (const id of ['t1', 't2', 't3']) await $.turn.complete(turn(id))
  await w.clock.settle()
  expect(w.modelCalls).toHaveLength(2)
})

test('a reply with terminal escape sequences or control characters is cleaned before it is drawn', ON, async ($, on) => {
  const w = world(on)
  w.reply = () => 'Clean \x1b[2Jtext\x1b]0;pwned\x07 here.\n- **second** line'
  await $.turn.complete(turn('t1'))
  await w.clock.settle()
  const ui = await mountBand($)
  expect(await has(ui, 'Clean text here.')).toBe(true)
  expect(await has(ui, 'second line')).toBe(true)
  expect(JSON.stringify(await ui.drawn())).not.toMatch(/pwned|\\u001b|\\u0007/)
  await ui.unmount()
})

test('/clear (session.end) removes the retell; a late reply after it is dropped', ON, async ($, on) => {
  const w = world(on)
  await $.turn.complete(turn('t1'))
  await w.clock.settle()
  const ui = await mountBand($)
  expect(await has(ui, /Reply 1/)).toBe(true)
  await $.session.end(sessionEnd())
  expect(await has(ui, /Reply 1/)).toBe(false)
  await ui.unmount()

  w.modelHold = 5000
  await $.turn.complete(turn('t2'))
  await $.session.end(sessionEnd())
  await w.clock.advance(5000)
  const again = await mountBand($)
  expect(await has(again, /Reply 2/)).toBe(false)
  await again.unmount()
})

// ---- the hourly cap ----

test('hourly cap of 2: the third answer makes no call and shows the muted limit line; it is retold again an hour after the first call', { options: { waitWhat: true, maxModelCallsPerHour: 2 } }, async ($, on) => {
  const w = world(on)
  await $.turn.complete(turn('t1')) // minute 0: call 1
  await w.clock.advance(10 * MIN)
  await $.turn.start({ text: 'go', turnId: 't2' })
  await $.turn.complete(turn('t2')) // minute 10: call 2
  await w.clock.advance(10 * MIN)
  await $.turn.start({ text: 'go', turnId: 't3' })
  await $.turn.complete(turn('t3')) // minute 20: refused
  await w.clock.settle()
  expect(w.modelCalls).toHaveLength(2)

  let ui = await mountBand($)
  expect(await has(ui, 'wait-what: hourly limit reached')).toBe(true)
  expect(await has(ui, /Reply/)).toBe(false)
  expect(JSON.stringify(await ui.drawn())).toContain('"dimColor":true')
  await ui.unmount()

  await $.turn.start({ text: 'go', turnId: 't4' })
  ui = await mountBand($)
  expect(await has(ui, /hourly limit/)).toBe(false) // the next turn clears the line
  await ui.unmount()

  await w.clock.advance(39 * MIN) // minute 59: the first call is not yet an hour old
  await $.turn.complete(turn('t4'))
  expect(w.modelCalls).toHaveLength(2)
  await w.clock.advance(MIN) // minute 60: the first call left the window
  await $.turn.complete(turn('t5'))
  await w.clock.settle()
  expect(w.modelCalls).toHaveLength(3)
  ui = await mountBand($)
  expect(await has(ui, 'Reply 3, line one.')).toBe(true)
  await ui.unmount()
})

test('hourly cap of 0: never a call, always the limit line', { options: { waitWhat: true, maxModelCallsPerHour: 0 } }, async ($, on) => {
  const w = world(on)
  await $.turn.complete(turn('t1'))
  await w.clock.settle()
  expect(w.modelCalls).toHaveLength(0)
  const ui = await mountBand($)
  expect(await has(ui, 'wait-what: hourly limit reached')).toBe(true)
  await ui.unmount()
})

test('an invalid cap setting counts as 30: the 31st answer of the hour is refused', { options: { waitWhat: true, maxModelCallsPerHour: -5 } }, async ($, on) => {
  const w = world(on)
  for (let i = 1; i <= 31; i++) await $.turn.complete(turn(`t${i}`))
  await w.clock.settle()
  expect(w.modelCalls).toHaveLength(30)
})

test('the default cap is 30 (no setting given)', ON, async ($, on) => {
  const w = world(on)
  for (let i = 1; i <= 31; i++) await $.turn.complete(turn(`t${i}`))
  await w.clock.settle()
  expect(w.modelCalls).toHaveLength(30)
})

test('/clear does not reset the hourly count', { options: { waitWhat: true, maxModelCallsPerHour: 1 } }, async ($, on) => {
  const w = world(on)
  await $.turn.complete(turn('t1'))
  await $.session.end(sessionEnd())
  await $.turn.complete(turn('t2'))
  await w.clock.settle()
  expect(w.modelCalls).toHaveLength(1)
})

test('a skipped answer (too short, subagent, interrupted) does not spend the budget', { options: { waitWhat: true, maxModelCallsPerHour: 1 } }, async ($, on) => {
  const w = world(on)
  await $.turn.complete(turn('t1', { answer: 'short' }))
  await $.turn.complete(turn('t2', { agentId: 'a' }))
  await $.turn.complete(turn('t3', { reason: 'aborted', isAborted: true }))
  await $.turn.complete(turn('t4'))
  await w.clock.settle()
  expect(w.modelCalls).toHaveLength(1)
})

// ---- the shared automation lock ----

test('a compaction in progress: no model call, then none retroactively, and no budget spent', { options: { waitWhat: true, maxModelCallsPerHour: 1 } }, async ($, on) => {
  const w = world(on, { compactHold: 3000 })
  await $.turn.complete(turn('t0', { answer: 'short' })) // a first response, so the cache row exists
  const compacting = $.session.compact(compactInput())
  await w.clock.settle()

  await $.turn.complete(turn('t1')) // the answer ends while the compaction runs
  await w.clock.advance(3000)
  await compacting
  await w.clock.settle()
  expect(w.modelCalls).toHaveLength(0)
  const ui = await mountBand($)
  expect(await has(ui, /Reply|hourly limit/)).toBe(false)
  await ui.unmount()

  await $.turn.complete(turn('t2')) // the lock is free; the budget of 1 is still whole
  await w.clock.settle()
  expect(w.modelCalls).toHaveLength(1)
})

test('while a model call runs, the compact button is not run: a toast says why; later it works', ON, async ($, on) => {
  const w = world(on, { modelHold: 5000 })
  await $.turn.complete(turn('t1'))
  await w.clock.settle()
  const ui = await mountBand($)
  expect(await compactButton(ui)).toBeDefined()

  await ui.press({ key: 'compact' })
  expect(w.compacts).toHaveLength(0)
  expect(w.toasts).toEqual(['Cache Keeper: a Wait What retell is running. Press compact again in a few seconds.'])
  expect(await has(ui, 'compacting')).toBe(false)

  await w.clock.advance(5000)
  expect(await has(ui, 'Reply 1, line one.')).toBe(true)
  await ui.press({ key: 'compact' })
  expect(w.compacts).toHaveLength(1)
  expect(w.toasts).toHaveLength(1)
  await ui.unmount()
})

test('a compaction that starts during a model call takes the lock, and the model call ending does not free it', ON, async ($, on) => {
  const w = world(on, { modelHold: 1000, compactHold: 3000 })
  await $.turn.complete(turn('t1'))
  await w.clock.settle()
  expect(w.modelCalls).toHaveLength(1)

  const compacting = $.session.compact(compactInput()) // the person's /compact, during the call
  await w.clock.settle()
  const ui = await mountBand($)
  expect(await has(ui, '⏱ compacting…')).toBe(true)

  await w.clock.advance(1000) // the model call ends; the compaction still runs
  expect(await has(ui, '⏱ compacting…')).toBe(true) // the lock is still the compaction's
  await $.turn.complete(turn('t2')) // another answer ends meanwhile: the lock is held
  await w.clock.settle()
  expect(w.modelCalls).toHaveLength(1)

  await w.clock.advance(2000)
  await compacting
  expect(await has(ui, '⏱ compacting…')).toBe(false)
  await $.turn.complete(turn('t3'))
  await w.clock.settle()
  expect(w.modelCalls).toHaveLength(2)
  await ui.unmount()
})

test('the lock is free after a retell: a compaction by the button then works at once', ON, async ($, on) => {
  const w = world(on)
  await $.turn.complete(turn('t1'))
  await w.clock.settle()
  const ui = await mountBand($)
  await ui.press({ key: 'compact' })
  expect(w.compacts).toHaveLength(1)
  expect(w.toasts).toEqual([])
  await ui.unmount()
})

test('a turn start while a call runs cancels it and frees the lock', ON, async ($, on) => {
  const w = world(on, { modelHold: 5000 })
  await $.turn.complete(turn('t1'))
  await w.clock.settle()
  await $.turn.start({ text: 'go', turnId: 't2' })
  await $.turn.complete(turn('t2'))
  await w.clock.settle()
  expect(w.modelCalls).toHaveLength(2) // the cancelled call did not keep the lock
})

// ---- the band: a 2-line row beside the others ----

test('beside Token Weather, Cache Keeper and the next-steps stub: all four show, in order, none overwritten; Wait What takes 2 lines', ON, async ($, on) => {
  const w = world(on)
  await $.turn.complete(turn('t1'))
  await w.clock.settle()
  const ui = await mountBand($) // maxRows 12: budget 4 = 1 + 1 + 2

  expect(await has(ui, MARKER)).toBe(true)
  expect(await has(ui, /16% 160k \/ 1M/)).toBe(true)
  expect(await has(ui, /cache warm 60m left · 160k tokens/)).toBe(true)
  expect(await has(ui, 'Reply 1, line one.')).toBe(true)
  expect(await has(ui, 'Reply 1, line two.')).toBe(true)

  const tree = JSON.stringify(await ui.drawn())
  const [marker, weather, cache, retell] = [tree.indexOf(MARKER), tree.indexOf('Clear'), tree.indexOf('cache warm'), tree.indexOf('Reply 1, line one.')]
  expect(marker).toBeGreaterThan(-1)
  expect(weather).toBeGreaterThan(marker)
  expect(cache).toBeGreaterThan(weather)
  expect(retell).toBeGreaterThan(cache)
  expect(tree.match(/"height":2/g)).toHaveLength(1) // only the retell row is 2 high
  expect(tree.match(/"height":1/g)!.length).toBeGreaterThanOrEqual(4) // 2 rows of 1, and one for each line
  await ui.unmount()
})

test('a 1-line retell takes 1 row, not 2', ON, async ($, on) => {
  const w = world(on)
  w.reply = () => 'Only one short line.'
  await $.turn.complete(turn('t1'))
  await w.clock.settle()
  const ui = await mountBand($)
  expect(await has(ui, 'Only one short line.')).toBe(true)
  expect(JSON.stringify(await ui.drawn())).not.toContain('"height":2')
  await ui.unmount()
})

test('a budget of 3 rows (maxRows 9): Token Weather, Cache Keeper, and the retell clipped to its first line', ON, async ($, on) => {
  const w = world(on)
  await $.turn.complete(turn('t1'))
  await w.clock.settle()
  const ui = await mountBand($, { maxRows: 9 })
  expect(await has(ui, /16% 160k/)).toBe(true)
  expect(await has(ui, /cache warm/)).toBe(true)
  expect(await has(ui, 'Reply 1, line one.')).toBe(true) // the Box is 1 high and clips the rest
  expect(JSON.stringify(await ui.drawn())).not.toContain('"height":2')
  await ui.unmount()
})

test('a budget of 2 rows (maxRows 6): Token Weather and Cache Keeper have the priority; Wait What waits', ON, async ($, on) => {
  const w = world(on)
  await $.turn.complete(turn('t1'))
  await w.clock.settle()
  const ui = await mountBand($, { maxRows: 6 })
  expect(await has(ui, /16% 160k/)).toBe(true)
  expect(await has(ui, /cache warm/)).toBe(true)
  expect(await has(ui, /Reply/)).toBe(false)
  await ui.unmount()
})

test('a budget of 1 row (maxRows 5): only Token Weather shows', ON, async ($, on) => {
  const w = world(on)
  await $.turn.complete(turn('t1'))
  await w.clock.settle()
  const ui = await mountBand($, { maxRows: 5 })
  expect(await has(ui, /16% 160k/)).toBe(true)
  expect(await has(ui, /cache warm|Reply/)).toBe(false)
  await ui.unmount()
})

test('Token Weather and Cache Keeper off: the retell moves up and has both its lines in a budget of 2', ON, async ($, on) => {
  const w = world(on)
  await $.turn.complete(turn('t1'))
  await w.clock.settle()
  await $.command.run(slash('off token-weather'))
  await $.command.run(slash('off cache-keeper'))
  const ui = await mountBand($, { maxRows: 6 })
  expect(await has(ui, /Clear|cache warm/)).toBe(false)
  expect(await has(ui, 'Reply 1, line one.')).toBe(true)
  expect(await has(ui, 'Reply 1, line two.')).toBe(true)
  await ui.unmount()
})

test('a survey holds the band: the pack draws nothing', ON, async ($, on) => {
  const w = world(on)
  await $.turn.complete(turn('t1'))
  await w.clock.settle()
  const ui = await mountBand($, { hasSurvey: true })
  expect(await has(ui, /Reply/)).toBe(false)
  expect(await has(ui, MARKER)).toBe(true)
  await ui.unmount()
})

test('one long line is split into two lines to fit a narrow band; each line is its own clipped row', ON, async ($, on) => {
  const w = world(on)
  w.reply = () => 'The build broke because one test file reads a setting that no longer exists, so fix the name of that setting.'
  await $.turn.complete(turn('t1'))
  await w.clock.settle()
  const ui = await mountBand($, { bodyColumns: 60 })
  const lines = (await ui.findAll({ type: 'Text' })).map((t: any) => t.text as string).filter((t: string) => /build broke|setting/.test(t))
  expect(lines).toHaveLength(2)
  for (const line of lines) expect(line.length).toBeLessThanOrEqual(60 - 'wait what: '.length)
  expect(lines[1]!.endsWith('.') || lines[1]!.endsWith('…')).toBe(true)
  expect(JSON.stringify(await ui.drawn()).match(/"height":2/g)).toHaveLength(1)
  await ui.unmount()
})
