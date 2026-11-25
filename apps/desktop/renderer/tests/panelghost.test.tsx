// panelghost.test.tsx — a message the user sends from ANOTHER surface (the
// chats panel, an inbox reply) to an agent whose desk has not loaded never
// leaves a "queued / undelivered" ghost on that desk.
//
// THE DEFECT (4.7.0-alpha.4, measured 2026-11-25 on @coordinator-opus's desk,
// @ticket:orgtree/desk-transcript-user-mail-that-already-woke-and-w; USER
// m982f04867caf: "you have some apparently queued and unread mail from me,
// even though i know you definitely have read and responded to these
// particular messages already"). The live engine listed none of the three as
// pending (state delivered); their turn rows carried their mail ids and
// client_op. The rows were the desk's own optimistic ghosts: sendPanelMessage
// and sendLinkedReply call addPending on the agent's desk convo. On a desk
// that had not loaded, the ghost's sequence baseline is unknown, and the
// desk's first payload sets it to that payload's NEWEST row ("its eventual row
// must come after everything the payload shows"). That holds for the desk's
// own composer, never for a send from elsewhere: by the time the desk opened,
// the agent had taken the mail, answered and moved on, so its row was older
// than the desk's window. Proof paging only looks below a baseline the window
// has passed, so it never looked, and the ghost stood until the app closed.
//
// THE RULE: another surface's send adds the desk ghost only to a desk convo
// that has loaded (its baseline is then real). An unloaded desk shows the
// server's own copy on its first payload: the pending bubble while the mail
// waits, the turn row once taken.
//
// Run: cd apps/desktop/renderer && node tests/run.mjs panelghost

import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { useEffect } from 'react'
import { FakeServer, flush, inAct, installFetch, mountView } from './harness'
import { refreshConvo, resetConvos, useConvo } from '../src/convo'
import type { Convo } from '../src/convo'
import { sendLinkedReply, sendPanelMessage } from '../src/events/reply'

const SL = 'org', ND = 'boss'
const BODY = 'the megaphone should be on the right side of the chatbox'

/** the server, plus what a POST to the agent does there: the mail is stored
 *  under the submission's own client_op and its turn row carries it, as the
 *  live rows did (mail segment row with id and client_op) */
function world(t: TestContext) {
  resetConvos()
  const server = new FakeServer()
  server.cursorPages = true
  for (let i = 0; i < 12; i++) server.assistantMsg(`earlier ${i}`, { event_id: `earlier-${i}` })
  installFetch(server)
  const inner = globalThis.fetch
  const posts: { path: string; op: string }[] = []
  let id = 0
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input), 'http://x')
    if (init?.method === 'POST' && /\/(message|reply)$/.test(u.pathname)) {
      const body = JSON.parse(String(init.body ?? '{}')) as { client_op?: string }
      posts.push({ path: u.pathname, op: body.client_op ?? '' })
      const mid = `mpanel${++id}`
      // the agent takes it into a turn at once: one turn row with the mail segment ...
      server.messages.push({ role: 'user', seq: server.messages.length, ts: new Date(Date.now()).toISOString(),
        segments: [{ kind: 'mail', rows: [{ id: mid, from: '@user', kind: 'message', body: BODY, at: new Date(Date.now()).toISOString(),
          client_op: body.client_op, ev: { v: 1, variant: 'ordinary.message', actor: { kind: 'user', id: '@user' }, object: null,
            engine_authored: false, body: BODY } }] }] } as never)
      // ... answers, and works on: far more rows than one desk window
      for (let i = 0; i < 20; i++) server.assistantMsg(`after ${i}`, { event_id: `after-${id}-${i}` })
      return Promise.resolve(new Response(JSON.stringify({ id: mid, accepted: true }), { status: 200, headers: { 'content-type': 'application/json' } }))
    }
    return inner(input, init)
  }) as typeof fetch
  let latest: Convo | null = null
  function Desk() {
    const c = useConvo(SL, ND)
    latest = c
    useEffect(() => { if (!c.loaded) void refreshConvo(SL, ND) }, [c.loaded])
    return null
  }
  const open = async () => {
    const v = await mountView(<Desk />, () => null)
    t.after(async () => { try { await v.unmount() } catch { /* gone */ } })
    await inAct(() => flush(20))
    return () => latest!
  }
  t.after(() => resetConvos())
  return { server, posts, open }
}

test('a chats-panel message to an agent whose desk has not loaded leaves no ghost on that desk once the agent took it', async t => {
  const w = world(t)
  // the user writes from the chats panel; no desk of this agent is open
  await inAct(async () => { await sendPanelMessage(SL, ND, BODY); await flush(5) })
  assert.equal(w.posts.length, 1, 'POSITIVE CONTROL: the message was sent')
  assert.ok(w.posts[0]!.op, 'POSITIVE CONTROL: it carried its client_op')
  // later the user opens the agent's desk: its window is the newest rows, past the mail's row
  const desk = await w.open()
  assert.equal(desk().loaded, true, 'POSITIVE CONTROL: the desk loaded')
  assert.equal(desk().chat!.has_older, true, 'POSITIVE CONTROL: the mail’s row is older than the desk’s window')
  assert.equal(desk().chat!.pending_mail?.length ?? 0, 0, 'POSITIVE CONTROL: the server lists nothing as pending')
  assert.deepEqual(desk().pending.map(g => g.text), [],
    'no ghost of the delivered message: the desk would show it under "queued / undelivered" for good')
})

test('the same for a linked reply sent from another surface (an inbox or docket reply)', async t => {
  const w = world(t)
  await inAct(async () => { await sendLinkedReply(SL, ND, BODY, { kind: 'mail', org: SL, box: 'user', id: 'm-original' }); await flush(5) })
  assert.equal(w.posts.length, 1, 'POSITIVE CONTROL: the reply was sent')
  const desk = await w.open()
  assert.equal(desk().chat!.has_older, true, 'POSITIVE CONTROL: the reply’s row is older than the desk’s window')
  assert.deepEqual(desk().pending.map(g => g.text), [], 'no ghost of the delivered reply')
})

test('CONTROL: with the agent’s desk loaded, a chats-panel send still shows at once on it and retires on its own row', async t => {
  const w = world(t)
  const desk = await w.open()
  assert.equal(desk().loaded, true)
  let sending: Promise<unknown> | null = null
  await inAct(() => { sending = sendPanelMessage(SL, ND, BODY) })
  assert.deepEqual(desk().pending.map(g => g.text), [BODY], 'the optimistic copy is on the open desk before the answer')
  await inAct(async () => { await sending; await refreshConvo(SL, ND, { force: true }); await flush(20) })
  assert.deepEqual(desk().pending.map(g => g.text), [], 'the desk’s next payload shows the row: the ghost retires')
})
