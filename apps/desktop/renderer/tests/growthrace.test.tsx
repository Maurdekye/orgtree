import { FakeServer, flush, inAct, installFetch, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { useEffect } from 'react'
import { loadOlder, refreshConvo, resetConvos, useConvo } from '../src/convo'
import type { Convo } from '../src/convo'

// docket v3-loading-earlier-agent-messages-fails-couldn-t: every desk showed
// "couldn't load earlier messages". The viewport path widens the window and
// rides a forced refresh, and the NEXT refresh to settle was taken as that
// growth's answer. An ordinary poll already in flight, asked with the OLD
// window, settles first, brings no older rows, and the stall guard reported a
// failed page. On the real machine a chat read takes seconds, so a poll is
// almost always in flight when the desk asks for more.
async function desk(t: import('node:test').TestContext) {
  resetConvos()
  const server = new FakeServer()
  server.cursorPages = true
  for (let i = 0; i < 40; i++) server.assistantMsg(`row ${i}`)
  const transport = installFetch(server)
  let latest: Convo
  function Desk() {
    const c = useConvo('race', 'agent')
    latest = c
    useEffect(() => { if (!c.loaded) void refreshConvo('race', 'agent') }, [c.loaded])
    return null
  }
  const warnings: unknown[][] = []
  const warn = console.warn
  console.warn = (...args) => warnings.push(args)
  const v = await mountView(<Desk />, () => null)
  t.after(async () => { await v.unmount(); resetConvos(); console.warn = warn })
  await inAct(() => flush(6))
  assert.equal(latest!.chat!.messages.length, 8)
  assert.equal(latest!.chat!.has_older, true)
  return { server, transport, warnings, get: () => latest! }
}

for (const order of ['poll first', 'growth first'] as const) {
  test(`viewport growth is judged by its own response, not a poll already in flight (${order})`, async t => {
    const { server, transport, warnings, get } = await desk(t)
    transport.holdAll = true
    // an ordinary poll, issued with the old window, is in the air…
    await inAct(async () => { void refreshConvo('race', 'agent'); await flush(2) })
    // …when the desk asks for more rows to fill its viewport
    await inAct(async () => { assert.equal(loadOlder('race', 'agent', 8, true), true); await flush(2) })
    assert.equal(transport.held.length, 2)
    assert.deepEqual(server.requests.slice(-2).map(r => r.last), [8, 16])
    transport.holdAll = false
    await inAct(async () => {
      if (order === 'poll first') transport.release(1)
      else transport.releaseLast()
      await flush(6)
    })
    if (order === 'poll first') {
      assert.equal(get().olderError, false, 'the old-window poll is not the growth\'s answer')
      assert.equal(get().loadingOlder, true, 'the growth is still in flight')
    }
    await inAct(async () => { transport.release(); await flush(8) })
    assert.equal(get().olderError, false, 'no "couldn\'t load earlier messages"')
    assert.equal(get().loadingOlder, false)
    assert.equal(get().chat!.messages.length, 16, 'the wider window is on screen')
    assert.equal(get().chat!.messages[0]!.text, 'row 24')
    assert.equal(warnings.length, 0, 'no pagination-stopped diagnostic')
  })
}

test('a growth whose own response brings no older rows still reports the failed page', async t => {
  const { server, get } = await desk(t)
  // the server stops honouring the wider window: its answer is the same 8 rows
  server.cursorPages = false
  const tail = get().chat!
  server.chat = () => ({ ...tail, has_older: true })
  await inAct(async () => { loadOlder('race', 'agent', 8, true); await flush(8) })
  assert.equal(get().olderError, true)
  assert.equal(get().loadingOlder, false)
})

test('a growth orphaned by the desk closing does not leave the next desk loading forever', async t => {
  resetConvos()
  const server = new FakeServer()
  server.cursorPages = true
  for (let i = 0; i < 40; i++) server.assistantMsg(`row ${i}`)
  const transport = installFetch(server)
  let latest: Convo
  function Desk() {
    const c = useConvo('orphan', 'agent')
    latest = c
    useEffect(() => { if (!c.loaded) void refreshConvo('orphan', 'agent') }, [c.loaded])
    return null
  }
  const warn = console.warn
  console.warn = () => {}
  t.after(() => { resetConvos(); console.warn = warn })
  let v = await mountView(<Desk />, () => null)
  await inAct(() => flush(6))
  transport.holdAll = true
  await inAct(async () => { assert.equal(loadOlder('orphan', 'agent', 8, true), true); await flush(2) })
  assert.equal(latest!.loadingOlder, true)
  // the desk closes while the growth is in the air: the last view leaving
  // resets the window to the tail, so no response can answer that growth now
  await v.unmount()
  transport.holdAll = false
  await inAct(async () => { transport.release(); await flush(8) })
  v = await mountView(<Desk />, () => null)
  t.after(async () => { await v.unmount() })
  await inAct(async () => { void refreshConvo('orphan', 'agent', { force: true }); await flush(8) })
  assert.equal(latest!.loadingOlder, false, 'not stuck on "loading earlier messages…"')
  assert.equal(latest!.olderError, false)
  await inAct(async () => { assert.equal(loadOlder('orphan', 'agent', 8, true), true); await flush(8) })
  assert.equal(latest!.loadingOlder, false)
  assert.equal(latest!.olderError, false)
  assert.equal(latest!.chat!.messages.length, 16)
})
