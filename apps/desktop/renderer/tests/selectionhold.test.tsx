// selectionhold.test.tsx — A TRANSCRIPT SELECTION SURVIVES ARRIVING EVENTS
// (user 2026-11-03 17:38:15Z md2483ac2412a: "when i have a transcript element
// selected to reply to it deselects when a new event arrives").
//
// The highlighted passage is native DOM selection. The transcript re-keys and
// rewrites rows as events arrive (a streaming row becomes its final row), and
// the browser drops a selection whose nodes were replaced. The desk therefore
// remembers the selection by EVENT ID + text offsets and restores it after a
// render, until the user deliberately changes it (press elsewhere, a key,
// a new selection). The composer's draft and focus are never touched.
//
// Run:  node apps/desktop/renderer/tests/run.mjs selectionhold
import test from 'node:test'
import assert from 'node:assert/strict'
import { FakeServer, flush, inAct, installFetch, mountView } from './harness'
import { DeskChat } from '../src/canvas/desk'
import type { CanvasNode } from '../src/canvas/shared'
import { refreshConvo, resetConvos } from '../src/convo'
import type { ChatMessage } from '../src/types'

const W = window as unknown as Window & typeof globalThis
const writer: CanvasNode = { id: 'writer', generation: 2, state: 'live', tier: 'haiku',
  children: [], seat: 1, grant: 0, free: 0, scope: { tools: {}, add_dirs: [] } }

async function desk(messages: ChatMessage[]) {
  localStorage.clear(); resetConvos()
  const server = new FakeServer(); server.messages = messages; installFetch(server)
  const view = await mountView(
    <DeskChat node={writer} map={new Map([[writer.id, writer]])} slug="org"
      op={async () => ({})} toast={() => {}} bare />, el => el)
  await inAct(async () => { await refreshConvo('org', 'writer'); await flush(5) })
  return { el: view.el, server, unmount: async () => { await view.unmount(); resetConvos() },
    poll: async () => { await inAct(async () => { await refreshConvo('org', 'writer'); await flush(5) }) } }
}
const rowOf = (el: HTMLElement, id: string) =>
  el.querySelector(`[data-transcript-row][data-reply-event="${id}"]`) as HTMLElement
function selectIn(row: HTMLElement, from: number, to: number) {
  const walker = document.createTreeWalker(row, 4)
  let n = 0; let start: [Node, number] | null = null; let end: [Node, number] | null = null
  for (let t = walker.nextNode(); t; t = walker.nextNode()) {
    const len = (t.nodeValue ?? '').length
    if (!start && from <= n + len) start = [t, from - n]
    if (!end && to <= n + len) end = [t, to - n]
    n += len
  }
  const r = document.createRange(); r.setStart(...start!); r.setEnd(...end!)
  const sel = document.getSelection()!; sel.removeAllRanges(); sel.addRange(r)
  document.dispatchEvent(new W.Event('selectionchange'))
}
const picked = () => document.getSelection()?.toString() ?? ''

test('a selected passage survives an arriving event and a re-keyed row', async () => {
  const m = await desk([{ role: 'user', text: 'go', seq: 0, event_id: 'ask-1' },
    { role: 'assistant', text: 'the quick brown fox', seq: 1, assistant_id: 'as-1',
      assistant_revision: 1, assistant_state: 'partial', assistant_pending: true, assistant_scope: 'turn' }])
  try {
    const row = m.el.querySelector('[data-transcript-row][data-assistant-id="as-1"]') as HTMLElement
    selectIn(row, 4, 9)
    assert.equal(picked(), 'quick')
    // the streaming row is re-keyed to its final row AND a new event arrives
    m.server.messages[1] = { role: 'assistant', text: 'the quick brown fox', seq: 1,
      native_event_id: 'nat-1', event_id: 'reply-1' }
    m.server.assistantMsg('a new event', { event_id: 'reply-2' })
    await m.poll()
    assert.equal(picked(), 'quick', 'the selection was lost when the event arrived')
    assert.ok(rowOf(m.el, 'reply-1')?.contains(document.getSelection()!.anchorNode),
      'and it is on the row that carries the event now')
  } finally { await m.unmount() }
})

test('the composer draft and focus are undisturbed; a press elsewhere releases it', async () => {
  const m = await desk([{ role: 'user', text: 'hello world', seq: 0, event_id: 'ask-1' }])
  try {
    selectIn(rowOf(m.el, 'ask-1'), 0, 5)
    const ta = m.el.querySelector('textarea') as HTMLTextAreaElement
    m.server.assistantMsg('another', { event_id: 'reply-2' })
    await m.poll()
    assert.equal(picked(), 'hello')
    assert.notEqual(document.activeElement, ta, 'restoring must not move focus')
    assert.equal(ta.value, '')
    await inAct(() => { m.el.dispatchEvent(new W.MouseEvent('pointerdown', { bubbles: true })) })
    document.getSelection()!.removeAllRanges()
    document.dispatchEvent(new W.Event('selectionchange'))
    m.server.assistantMsg('yet another', { event_id: 'reply-3' })
    await m.poll()
    assert.equal(picked(), '', 'a deliberate deselect must stay deselected')
  } finally { await m.unmount() }
})

test('a selection whose row is not loaded is kept and restored when the row returns', async () => {
  const m = await desk([{ role: 'user', text: 'hello world', seq: 0, event_id: 'ask-1' },
    { role: 'assistant', text: 'two', seq: 1, event_id: 'reply-1' }])
  try {
    selectIn(rowOf(m.el, 'ask-1'), 0, 5)
    const kept = m.server.messages[0]!
    m.server.messages = [m.server.messages[1]!]      // paged out of the window
    await m.poll()
    assert.equal(picked(), '')
    m.server.messages = [kept, ...m.server.messages]  // scrolled back in
    await m.poll()
    assert.equal(picked(), 'hello', 'the selection returns with its row')
  } finally { await m.unmount() }
})
