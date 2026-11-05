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
import { addPending, loadOlder, refreshConvo, resetConvos, useConvo } from '../src/convo'
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
