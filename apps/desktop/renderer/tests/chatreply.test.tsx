import { FakeServer, flush, inAct, installFetch, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { DeskChat } from '../src/canvas/desk'
import type { CanvasNode } from '../src/canvas/shared'
import { refreshConvo, resetConvos } from '../src/convo'
import { draftKey, preserveRemovedDrafts, recoverableDrafts, renameDrafts } from '../src/draftstore'
import { MAX_REPLY_QUOTE, readReply, replyFromRow, replyWire, storeReply } from '../src/eventReply'
import type { ReplyContext } from '../src/eventReply'

const source: ReplyContext = { org: 'org', agent: 'writer', generation: 2, eventId: 'event-second', quote: 'same text' }
const writer: CanvasNode = { id: 'writer', generation: 2, state: 'live', tier: 'haiku', children: [],
  seat: 1, grant: 0, free: 0, scope: { tools: {}, add_dirs: [] } }
const desk = () => <DeskChat node={writer} map={new Map([[writer.id, writer]])} slug="org"
  op={async () => ({})} toast={() => {}} pub={false} bare />

test('reply draft follows rename/removal recovery without rewriting its source identity', () => {
  localStorage.clear()
  const key = draftKey('org', 'writer', 2)
  storeReply(key, source)
  localStorage.setItem(key, 'My reply')
  renameDrafts('org', 'writer', 'renamed')
  const renamed = draftKey('org', 'renamed', 2)
  assert.deepEqual(readReply(renamed), source)
  assert.equal(readReply(key), null)
  preserveRemovedDrafts('org', new Map())
  const recovery = recoverableDrafts('org', 'renamed', 3)
  assert.equal(recovery.length, 1)
  assert.deepEqual(recovery[0]!.reply, source)
  assert.equal(recovery[0]!.text, 'My reply')
})

test('identity never falls back to ordinal/text and quotes are bounded', () => {
  assert.equal(replyFromRow('org', 'writer', 2, {}, 'same text'), null)
  const first = replyFromRow('org', 'writer', 2, { event_id: 'first' }, 'same text')!
  const second = replyFromRow('org', 'writer', 2, { event_id: 'second' }, 'same text')!
  assert.notDeepEqual(replyWire(first).source_event_ref, replyWire(second).source_event_ref)
  assert.equal(replyFromRow('org', 'writer', 2, { event_id: 'long' }, 'x'.repeat(5000))!.quote.length, MAX_REPLY_QUOTE)
  localStorage.setItem('invalid-reply', JSON.stringify({ ...source, generation: -1 }))
  assert.equal(readReply('invalid'), null)
})

test('right-click selects the exact repeated event, survives remount and sends its source', async () => {
  localStorage.clear(); resetConvos()
  const server = new FakeServer()
  server.messages = [
    { role: 'assistant', text: 'same text', seq: 10, event_id: 'event-first' },
    { role: 'assistant', text: 'same text', seq: 11, event_id: 'event-second' },
  ]
  installFetch(server)
  const originalFetch = globalThis.fetch
  let sent: any
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/message')) {
      sent = JSON.parse(String(init?.body))
      return { ok: true, headers: new Headers(), json: async () => ({ queued: 0 }) } as Response
    }
    return originalFetch(url, init)
  }
  let view = await mountView(desk(), el => el)
  try {
    await inAct(async () => { await refreshConvo('org', 'writer'); await flush(5) })
    const rows = view.el.querySelectorAll<HTMLElement>('[data-reply-event]')
    assert.equal(rows.length, 2)
    await inAct(async () => { rows[1]!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })) })
    const reply = document.querySelector<HTMLButtonElement>('[role="menuitem"]')!
    assert.equal(reply.textContent, 'Reply'); assert.equal(reply.disabled, false)
    await inAct(async () => { reply.click() })
    assert.equal(readReply(draftKey('org', 'writer', 2))?.eventId, 'event-second')
    assert.match(view.el.querySelector('.reply-preview')!.textContent!, /same text/)
    await view.unmount()
    localStorage.setItem(draftKey('org', 'writer', 2), 'Please explain')
    view = await mountView(desk(), el => el)
    assert.ok(view.el.querySelector('.reply-preview'))
    await inAct(async () => { view.el.querySelector<HTMLButtonElement>('.cc-send')!.click(); await flush(10) })
    assert.equal(sent.text, 'Please explain')
    assert.equal(sent.reply_to.source_event_ref.eventId, 'event-second')
    assert.equal(sent.reply_to.source_event_ref.generation, 2)
    assert.match(sent.reply_to.quoted_context, /same text/)
    assert.equal(readReply(draftKey('org', 'writer', 2)), null)
  } finally { await view.unmount(); resetConvos(); globalThis.fetch = originalFetch }
})

test('unavailable source keeps its quote, remove clears metadata, and failed send restores it', async () => {
  localStorage.clear(); resetConvos()
  const server = new FakeServer(); installFetch(server)
  const key = draftKey('org', 'writer', 2)
  storeReply(key, source); localStorage.setItem(key, 'Unsent reply')
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/message')) throw new Error('connection lost')
    return originalFetch(url, init)
  }
  const view = await mountView(desk(), el => el)
  try {
    assert.match(view.el.querySelector('.reply-preview')!.textContent!, /unavailable here; quoted context is retained/)
    await inAct(async () => { view.el.querySelector<HTMLButtonElement>('.cc-send')!.click(); await flush(10) })
    const ghost = view.el.querySelector('.pendghost')!
    assert.match(ghost.textContent!, /connection lost/)
    assert.match(ghost.textContent!, /same text/)
    await inAct(async () => { ghost.querySelector<HTMLButtonElement>('button[title="put this text back in the composer"]')!.click() })
    assert.deepEqual(readReply(key), source)
    await inAct(async () => { view.el.querySelector<HTMLButtonElement>('button[aria-label="Remove reply"]')!.click() })
    assert.equal(readReply(key), null)
    assert.equal(view.el.querySelector<HTMLTextAreaElement>('textarea')!.value, 'Unsent reply')
  } finally { await view.unmount(); resetConvos(); globalThis.fetch = originalFetch }
})
