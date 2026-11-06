// historycursor.test.tsx — "COULDN'T LOAD EARLIER MESSAGES, RETRYING…" FOREVER
// (bug 4.5.5, 2026-11-05: a desk retried the same history cursor every 5 s
// while every page request returned 200 — before=108 nine times in a row).
//
// THE MECHANISM, read from convo.ts at 8a634fb: a refresh whose tail no longer
// shows a just-sent mail pages backwards to find it (the "proof" loop) and
// prepends those pages to the tail — but it keeps the TAIL's `before` cursor.
// The installed transcript then starts well below its own cursor. The next
// older page asks for rows below that stale cursor, gets rows the desk already
// holds, `olderPageProgress` correctly says nothing new is older than the
// oldest row, and the page is retried with the same cursor for ever.
//
// The contract: an installed transcript's `before` cursor is never above its
// own oldest row, so a good page always advances or ends history.
//
// Run:  node apps/desktop/renderer/tests/run.mjs historycursor

import test from 'node:test'
import assert from 'node:assert/strict'
import { useEffect } from 'react'
import { FakeServer, flush, inAct, installFetch, mountView } from './harness'
import { addPending, ingestStream, loadOlder, refreshConvo, resetConvos, useConvo } from '../src/convo'
import type { Convo } from '../src/convo'

const SL = 'hist', ND = 'agent'
const seqs = (c: Convo) => c.chat!.messages.map(r => r.seq)

test('a mail-proof refresh leaves a cursor that still pages older history', async t => {
  resetConvos()
  const server = new FakeServer()
  server.cursorPages = true
  for (let i = 0; i < 40; i++) server.assistantMsg(`row ${i}`, { event_id: `row-${i}` })
  installFetch(server)
  let latest: Convo
  function Desk() {
    const c = useConvo(SL, ND)
    latest = c
    useEffect(() => { if (!c.loaded) void refreshConvo(SL, ND) }, [c.loaded])
    return null
  }
  const warn = console.warn
  console.warn = () => {}
  const v = await mountView(<Desk />, () => null)
  t.after(async () => { await v.unmount(); resetConvos(); console.warn = warn })
  await inAct(() => flush(10))
  assert.deepEqual(seqs(latest!), [32, 33, 34, 35, 36, 37, 38, 39], 'fixture: one window of tail')
  assert.equal(latest!.chat!.before, '32', 'fixture: the cursor is the oldest row')

  // the user sends; before the server shows it, the agent bursts past one window
  await inAct(() => { addPending(SL, ND, 'a question the server has not shown yet') })
  for (let i = 40; i < 60; i++) server.assistantMsg(`row ${i}`, { event_id: `row-${i}` })
  await inAct(async () => { await refreshConvo(SL, ND, { force: true }); await flush(10) })
  const rows = seqs(latest!)
  assert.ok(rows.length > 8 && (rows[0] as number) < 52,
    `fixture: the proof loop paged back below the tail (${rows[0]}..${rows.at(-1)})`)
  assert.equal(latest!.chat!.before, String(rows[0]),
    `the cursor ${latest!.chat!.before} is above the oldest loaded row ${rows[0]}`)

  // and so the next older page really is older
  await inAct(async () => { loadOlder(SL, ND, 8); await flush(10) })
  assert.equal(latest!.olderError, false, 'a 200 page was rejected as "did not advance"')
  assert.ok((seqs(latest!)[0] as number) < (rows[0] as number), 'no older rows were added')
})

// THE SECOND WAY IN (bug 4.5.6-alpha.2, 2026-11-06 21:03Z, unity/ascii-outline:
// before=530/611/612/640 each retried every 5 s, every page 200). A stream
// commit (`convo_rows`) is retained until an HTTP page confirms it, and every
// merge splices it back in by seq. A commit for an OLD row (a late tool result,
// a revision of a row the tail no longer shows) therefore lands below the
// tail's cursor, and is never confirmed: only tail fetches confirm, and the
// tail never holds it. The transcript again starts below its own cursor, so
// every older page holds nothing "older than the oldest row" and retries.
//
// The ruling (@coordinator-opus 2026-11-06 21:38Z): a held commit below the
// oldest payload row while has_older is true is dropped; its durable copy
// comes back by paging. A commit at or above the oldest row merges as today.
test('a stream commit for a row older than the tail cannot strand the history cursor', async t => {
  resetConvos()
  const server = new FakeServer()
  server.cursorPages = true
  for (let i = 0; i < 40; i++) server.assistantMsg(`row ${i}`, { event_id: `row-${i}` })
  installFetch(server)
  let latest: Convo
  function Desk() {
    const c = useConvo(SL, ND)
    latest = c
    useEffect(() => { if (!c.loaded) void refreshConvo(SL, ND) }, [c.loaded])
    return null
  }
  const warn = console.warn
  console.warn = () => {}
  const v = await mountView(<Desk />, () => null)
  t.after(async () => { await v.unmount(); resetConvos(); console.warn = warn })
  await inAct(() => flush(10))
  assert.deepEqual(seqs(latest!), [32, 33, 34, 35, 36, 37, 38, 39], 'fixture: one window of tail')
  assert.equal(latest!.chat!.before, '32', 'fixture: the cursor is the oldest row')

  // a late revision of row 20 arrives on the stream, then the tail refreshes
  const old = server.messages.find(r => r.seq === 20)!
  await inAct(() => ingestStream(SL, { node: ND, kind: 'text', text: '', t: Date.now(),
    convo_rows: [{ ...old, row_id: 'mock-20', convo_revision: 2, text: 'row 20, revised' }] }))
  await inAct(async () => { await refreshConvo(SL, ND, { force: true }); await flush(10) })
  const rows = seqs(latest!)
  assert.ok(Number(latest!.chat!.before) <= (rows[0] as number),
    `the cursor ${latest!.chat!.before} is above the oldest loaded row ${rows[0]} (${rows.join(',')})`)

  // and the next older page is accepted
  await inAct(async () => { loadOlder(SL, ND, 8); await flush(10) })
  assert.equal(latest!.olderError, false, 'a 200 page was rejected as "did not advance"')
  assert.deepEqual(seqs(latest!).slice(0, 8), [24, 25, 26, 27, 28, 29, 30, 31], 'the older page was not merged')
})

// The other half of the ruling: a commit for a row the desk already shows is
// today's ordinary update and stays merged.
test('a stream commit for a held row still updates it in place', async t => {
  resetConvos()
  const server = new FakeServer()
  server.cursorPages = true
  for (let i = 0; i < 40; i++) server.assistantMsg(`row ${i}`, { event_id: `row-${i}` })
  installFetch(server)
  let latest: Convo
  function Desk() {
    const c = useConvo(SL, ND)
    latest = c
    useEffect(() => { if (!c.loaded) void refreshConvo(SL, ND) }, [c.loaded])
    return null
  }
  const v = await mountView(<Desk />, () => null)
  t.after(async () => { await v.unmount(); resetConvos() })
  await inAct(() => flush(10))
  const held = server.messages.find(r => r.seq === 34)!
  await inAct(() => ingestStream(SL, { node: ND, kind: 'text', text: '', t: Date.now(),
    convo_rows: [{ ...held, row_id: 'mock-34', convo_revision: 2, text: 'row 34, revised' }] }))
  await inAct(async () => { await refreshConvo(SL, ND, { force: true }); await flush(10) })
  assert.deepEqual(seqs(latest!), [32, 33, 34, 35, 36, 37, 38, 39])
  assert.equal(latest!.chat!.messages.find(r => r.seq === 34)!.text, 'row 34, revised')
})
