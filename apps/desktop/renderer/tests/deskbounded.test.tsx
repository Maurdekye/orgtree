// deskbounded.test.tsx — A LIVE DESK MUST STAY BOUNDED (user report 2026-11-06 11:57Z:
// a pinned desk "grows without bounds as events arrive, eventually incurring
// heavy lag"). Stream commits (convo_rows) are merged into the retained chat
// but, unlike an HTTP delta, were never trimmed back to the window, so a desk
// that sits at the bottom of a busy stream keeps every row for ever.
//
// Run:  node apps/desktop/renderer/tests/run.mjs deskbounded

import test from 'node:test'
import assert from 'node:assert/strict'
import { FakeServer, flush, inAct, installFetch, mountView, realClock, useFakeClock } from './harness'
import { DeskChat } from '../src/canvas/desk'
import type { CanvasNode } from '../src/canvas/shared'
import * as store from '../src/convo'
import { CHAT_WINDOW, collapseWindow, ingestStream, loadOlder, refreshConvo, resetConvos, useConvo } from '../src/convo'
import type { Convo } from '../src/convo'
import type { ChatMessage } from '../src/types'

// the contract's numbers, written here so this file compiles (and fails for the
// right reason) at a base that has no such constants: slack 32 over the window;
// a scrolled-up desk holds at most ten of those
const STREAM_SLACK = 32
const PAGED_CAP = 10 * (CHAT_WINDOW + STREAM_SLACK)

const writer: CanvasNode = { id: 'writer', generation: 2, state: 'live', tier: 'haiku',
  children: [], seat: 1, grant: 0, free: 0, scope: { tools: {}, add_dirs: [] } }

const row = (i: number): ChatMessage => ({ role: 'assistant', text: `event ${i}`, seq: 100 + i,
  row_id: `r${i}`, convo_revision: i + 1, ts: '2026-11-06T10:00:00Z', assistant_id: `a${i}` })

async function feed(server: FakeServer, from: number, to: number) {
  for (let i = from; i < to; i++) {
    server.messages.push({ role: 'assistant', text: `event ${i}`, seq: 100 + i, event_id: `e${i}` })
    await inAct(() => ingestStream('org', { node: 'writer', kind: 'text', text: '', t: Date.now(),
      convo_rows: [row(i)], draft_clear: true, thinking_clear: true }))
  }
}

test('a desk at the bottom of a live stream keeps a bounded number of rows', { timeout: 120000 }, async t => {
  useFakeClock()
  localStorage.clear(); resetConvos()
  const server = new FakeServer(); server.cursorPages = true
  const base = server.chat.bind(server); server.chat = last => ({ ...base(last), conversation_id: 'a1' })
  for (let i = 0; i < 30; i++) server.messages.push({ role: 'assistant', text: `old ${i}`, seq: i, event_id: `old-${i}` })
  installFetch(server)
  let snapshot: Convo | null = null
  const Probe = () => { snapshot = useConvo('org', 'writer'); return null }
  const view = await mountView(<><Probe />
    <DeskChat node={writer} map={new Map([[writer.id, writer]])} slug="org" op={async () => ({})} toast={() => {}} bare /></>, el => el)
  t.after(async () => { await view.unmount(); resetConvos(); realClock() })
  await inAct(async () => { await refreshConvo('org', 'writer'); await flush(5) })
  const marks: string[] = []
  for (const stop of [50, 150, 400]) {
    const t0 = performance.now()
    await feed(server, marks.length ? [50, 150][marks.length - 1]! : 0, stop)
    const ms = performance.now() - t0
    const dom = view.el.querySelectorAll('[data-transcript-row]').length
    marks.push(`${stop}: retained=${snapshot!.chat!.messages.length} dom=${dom} feedMs=${ms.toFixed(0)}`)
  }
  console.log(marks.join(' | '))
  const bound = CHAT_WINDOW + STREAM_SLACK + 8
  assert.ok(snapshot!.chat!.messages.length <= bound, 'retained rows bounded: ' + marks.join(' | '))
  assert.ok(view.el.querySelectorAll('[data-transcript-row]').length <= bound, 'rendered rows bounded: ' + marks.join(' | '))
  // no history is lost: paging up still reaches the oldest row
  // (the reader scrolls up to do it, which releases bottom-follow)
  ;(store as unknown as { setFollowing?: (s: string, n: string, f: boolean) => void }).setFollowing?.('org', 'writer', false)
  for (let n = 0; n < 80 && snapshot!.chat!.has_older; n++) {
    await inAct(async () => { loadOlder('org', 'writer', 64); await flush(8) })
  }
  assert.equal(snapshot!.chat!.messages[0]?.seq, 0, 'the oldest row is reachable by paging up')
})

test('a desk scrolled up into history stays bounded under a flood, and returning to the bottom shows the newest rows', { timeout: 180000 }, async t => {
  useFakeClock()
  localStorage.clear(); resetConvos()
  const server = new FakeServer(); server.cursorPages = true
  const base = server.chat.bind(server); server.chat = last => ({ ...base(last), conversation_id: 'a1' })
  for (let i = 0; i < 30; i++) server.messages.push({ role: 'assistant', text: `old ${i}`, seq: i, event_id: `old-${i}` })
  installFetch(server)
  let snapshot: Convo | null = null
  const Probe = () => { snapshot = useConvo('org', 'writer'); return null }
  const view = await mountView(<><Probe />
    <DeskChat node={writer} map={new Map([[writer.id, writer]])} slug="org" op={async () => ({})} toast={() => {}} bare /></>, el => el)
  t.after(async () => { await view.unmount(); resetConvos(); realClock() })
  await inAct(async () => { await refreshConvo('org', 'writer'); await flush(5) })
  // the reader goes up into history: the desk is paged from now on
  await inAct(async () => { loadOlder('org', 'writer', 8); await flush(8) })
  // what the desk does when the reader scrolls up (looked up so the file compiles at a base without it)
  ;(store as unknown as { setFollowing?: (s: string, n: string, f: boolean) => void }).setFollowing?.('org', 'writer', false)
  const total = PAGED_CAP + 60
  await feed(server, 0, total)
  const held = snapshot!.chat!.messages.length
  assert.ok(held <= PAGED_CAP, `a scrolled-up desk holds at most PAGED_CAP rows (held ${held})`)
  assert.ok(view.el.querySelectorAll('[data-transcript-row]').length <= PAGED_CAP)
  assert.equal(snapshot!.chat!.messages.some(m => m.seq === 100 + total - 1), false, 'rows past the cap are not shown while up')
  // back to the bottom: the tail is fetched again and holds the newest row
  await inAct(async () => { collapseWindow('org', 'writer', CHAT_WINDOW); await flush(10) })
  await inAct(async () => { await refreshConvo('org', 'writer', { force: true }); await flush(10) })
  const rows = snapshot!.chat!.messages
  assert.equal(rows.at(-1)?.seq, 100 + total - 1, 'the newest row is shown after returning to the bottom')
  assert.ok(rows.length <= CHAT_WINDOW + STREAM_SLACK + 8, `the tail is a bounded window again (${rows.length})`)
})

test('a desk the viewport fill has paged, whose reader still follows the live end, keeps the NEWEST rows', { timeout: 180000 }, async t => {
  // Session 0 capture (int-credit-sol-2): the desk's own viewport fill pages
  // older rows in (paged) before any user scroll; cutting the newest rows then
  // left the bottom-following reader on a stale tail with no jump button.
  useFakeClock()
  localStorage.clear(); resetConvos()
  const server = new FakeServer(); server.cursorPages = true
  const base = server.chat.bind(server); server.chat = last => ({ ...base(last), conversation_id: 'a1' })
  for (let i = 0; i < 30; i++) server.messages.push({ role: 'assistant', text: `old ${i}`, seq: i, event_id: `old-${i}` })
  installFetch(server)
  let snapshot: Convo | null = null
  const Probe = () => { snapshot = useConvo('org', 'writer'); return null }
  const view = await mountView(<><Probe />
    <DeskChat node={writer} map={new Map([[writer.id, writer]])} slug="org" op={async () => ({})} toast={() => {}} bare /></>, el => el)
  t.after(async () => { await view.unmount(); resetConvos(); realClock() })
  await inAct(async () => { await refreshConvo('org', 'writer'); await flush(5) })
  await inAct(async () => { loadOlder('org', 'writer', 8, true); await flush(8) })   // viewport fill: paged, still following
  const total = PAGED_CAP + 60
  await feed(server, 0, total)
  const rows = snapshot!.chat!.messages
  assert.ok(rows.length <= PAGED_CAP, `bounded (${rows.length})`)
  assert.equal(rows.at(-1)?.seq, 100 + total - 1, 'the newest row is the last one shown')
})
