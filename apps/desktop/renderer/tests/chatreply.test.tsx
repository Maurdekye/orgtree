import { FakeServer, flush, inAct, installFetch, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { DeskChat } from '../src/canvas/desk'
import type { CanvasNode } from '../src/canvas/shared'
import { ingestStream, refreshConvo, resetConvos } from '../src/convo'
import { discardAllRecoverableDrafts, discardRecoverableDraft, draftKey, preserveRemovedDrafts, recoverableDrafts, renameDrafts, storeAttachments } from '../src/draftstore'
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

test('discarding recovered drafts persists and leaves the current composer untouched', () => {
  localStorage.clear()
  const current = draftKey('org', 'writer', 3)
  const old = draftKey('org', 'writer', 2)
  localStorage.setItem(current, 'Current draft')
  localStorage.setItem(old, 'Older draft')
  storeAttachments(old, [{ name: 'note.txt', path: 'note.txt', bytes: 4 }])
  storeReply(old, source)
  assert.equal(recoverableDrafts('org', 'writer', 3).length, 1)
  discardRecoverableDraft('org', 'writer', 2)
  assert.equal(recoverableDrafts('org', 'writer', 3).length, 0)
  assert.equal(localStorage.getItem(current), 'Current draft')
  assert.equal(localStorage.getItem(`${old}-attachments`), null)
  assert.equal(localStorage.getItem(`${old}-reply`), null)
  assert.equal(localStorage.getItem('orgtree-draft-recovery-dismissed-["org","writer"]'), '[2]')
  // A later recovery scan cannot resurrect the dismissed generation.
  localStorage.setItem('orgtree-draft-recovery-["org","writer",2]', 'Older draft')
  assert.equal(recoverableDrafts('org', 'writer', 3).length, 0)
})

test('dismiss all records every visible recovered generation', () => {
  localStorage.clear()
  for (const generation of [1, 2]) localStorage.setItem(draftKey('org', 'writer', generation), `draft ${generation}`)
  preserveRemovedDrafts('org', new Map())
  assert.equal(recoverableDrafts('org', 'writer', 3).length, 2)
  discardAllRecoverableDrafts('org', 'writer', [1, 2])
  assert.equal(recoverableDrafts('org', 'writer', 3).length, 0)
})

test('identity never falls back to ordinal/text and quotes are bounded', () => {
  assert.equal(replyFromRow('org', 'writer', 2, {}, 'same text'), null)
  const first = replyFromRow('org', 'writer', 2, { event_id: 'first' }, 'same text')!
  const second = replyFromRow('org', 'writer', 2, { event_id: 'second' }, 'same text')!
  assert.notDeepEqual(replyWire(first).source_event_ref, replyWire(second).source_event_ref)
  assert.equal(replyFromRow('org', 'writer', 2, { event_id: 'long' }, 'x'.repeat(5000))!.quote.length, MAX_REPLY_QUOTE)
  assert.equal(replyFromRow('org', 'writer', 2, { event_id: 'literal' }, '  literal source\n')!.quote, '  literal source\n')
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


async function replyOn(element: Element) {
  await inAct(() => { element.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })) })
  const item = document.querySelector<HTMLButtonElement>('[role="menuitem"]')!
  assert.ok(item, 'Reply menu opens on this individual event')
  return item
}

test('tool call, result and thought select distinct nested sources instead of the containing assistant row', async () => {
  localStorage.clear(); resetConvos()
  const server = new FakeServer(); installFetch(server)
  server.messages = [{ role: 'assistant', text: 'Finished', seq: 1, event_id: 'assistant',
    thinking: 'Visible thought', thinking_event_id: 'thought', tools: [
      { name: 'Read', id: 'provider-tool', event_id: 'call', result_event_id: 'result', arg: 'a.txt', result: 'same text' },
      { name: 'Read', id: 'legacy-tool', arg: 'b.txt', result: 'same text' },
    ] }]
  const v = await mountView(desk(), el => el)
  try {
    await inAct(async () => { await refreshConvo('org', 'writer'); await flush(5) })
    const call = v.el.querySelector<HTMLElement>('[data-reply-event="call"]')!
    let item = await replyOn(call)
    await inAct(() => { item.click() })
    assert.equal(readReply(draftKey('org', 'writer', 2))?.eventId, 'call')
    assert.equal(readReply(draftKey('org', 'writer', 2))?.quote, 'Read a.txt')
    await inAct(() => { call.click() })
    const result = v.el.querySelector('[data-reply-event="result"]')!
    assert.equal(result.textContent, 'same text')
    item = await replyOn(result); await inAct(() => { item.click() })
    assert.equal(readReply(draftKey('org', 'writer', 2))?.eventId, 'result')
    assert.equal(readReply(draftKey('org', 'writer', 2))?.quote, 'same text')
    item = await replyOn(v.el.querySelector('[data-reply-event="thought"]')!)
    await inAct(() => { item.click() })
    assert.equal(readReply(draftKey('org', 'writer', 2))?.eventId, 'thought')
    assert.equal(readReply(draftKey('org', 'writer', 2))?.quote, 'Visible thought', 'collapsed label is not the source quote')
    assert.doesNotMatch(v.el.querySelector('.reply-preview')!.textContent!, /unavailable/)
    item = await replyOn(v.el.querySelector('[data-reply-event="assistant"]')!)
    await inAct(() => { item.click() })
    assert.equal(readReply(draftKey('org', 'writer', 2))?.quote, 'Finished', 'assistant quote excludes nested thought/tool/result content')
    item = await replyOn(v.el.querySelectorAll('.tline')[1]!)
    assert.equal(item.disabled, true, 'legacy nested tool never aliases its assistant parent')
  } finally { await v.unmount(); resetConvos() }
})

test('server transient events survive refresh and streamed draft IDs survive durable promotion', async () => {
  localStorage.clear(); resetConvos()
  const server = new FakeServer(); server.busy = true
  const chat = server.chat.bind(server)
  server.chat = n => ({ ...chat(n), transient: [{ event_id: 'transient-error', role: 'system', kind: 'error', text: 'Temporary problem' }] })
  installFetch(server)
  const v = await mountView(desk(), el => el)
  try {
    await inAct(async () => { await refreshConvo('org', 'writer'); await flush(5) })
    let item = await replyOn(v.el.querySelector('[data-reply-event="transient-error"]')!)
    await inAct(() => { item.click() })
    assert.equal(readReply(draftKey('org', 'writer', 2))?.eventId, 'transient-error')
    await inAct(() => { ingestStream('org', { node: 'writer', kind: 'delta', text: 'Hello', event_id: 'streamed', t: Date.now() }) })
    item = await replyOn(v.el.querySelector('[data-reply-event="streamed"]')!)
    await inAct(() => { item.click() })
    await inAct(() => { ingestStream('org', { node: 'writer', kind: 'delta', text: ' again', event_id: 'streamed', t: Date.now() }) })
    assert.equal(v.el.querySelector('[data-reply-event="streamed"]')!.textContent!.trim(), 'Hello again')
    assert.equal(readReply(draftKey('org', 'writer', 2))?.eventId, 'streamed')
    server.busy = false; server.messages = [{ role: 'assistant', seq: 1, text: 'Hello again', event_id: 'streamed' }]
    await inAct(async () => { await refreshConvo('org', 'writer'); await flush(5) })
    assert.equal(v.el.querySelectorAll('[data-reply-event="streamed"]').length, 1)
    assert.doesNotMatch(v.el.querySelector('.reply-preview')!.textContent!, /unavailable/)
    assert.equal(readReply(draftKey('org', 'writer', 2))?.quote, 'Hello', 'saved quote stays the selected context while identity survives growth')
  } finally { await v.unmount(); resetConvos() }
})


test('new immutable stream snapshot IDs do not discard preceding text or rewrite the selected reply', async () => {
  localStorage.clear(); resetConvos()
  const server = new FakeServer(); server.busy = true; installFetch(server)
  const v = await mountView(desk(), el => el)
  try {
    await inAct(async () => { await refreshConvo('org', 'writer'); await flush(5) })
    await inAct(() => { ingestStream('org', { node: 'writer', kind: 'delta', text: 'First ', event_id: 'revision-one', reply_quote: 'Exact first snapshot', t: Date.now() }) })
    const item = await replyOn(v.el.querySelector('[data-reply-event="revision-one"]')!)
    await inAct(() => { item.click() })
    await inAct(() => { ingestStream('org', { node: 'writer', kind: 'delta', text: 'second', event_id: 'revision-two', t: Date.now() }) })
    assert.equal(v.el.querySelector('[data-reply-event="revision-two"]')!.textContent!.trim(), 'First second')
    assert.equal(readReply(draftKey('org', 'writer', 2))?.eventId, 'revision-one')
    assert.equal(readReply(draftKey('org', 'writer', 2))?.quote, 'Exact first snapshot')
  } finally { await v.unmount(); resetConvos() }
})


test('opening mid-stream preserves the polled prefix and newer websocket source remains visible', async () => {
  localStorage.clear(); resetConvos()
  const server = new FakeServer(); server.busy = true
  const chat = server.chat.bind(server)
  server.chat = n => ({ ...chat(n), transient: [
    { event_id: 'polled', role: 'assistant', kind: 'draft', text: 'Existing ', reply_quote: 'Existing ' },
  ] })
  installFetch(server)
  const v = await mountView(desk(), el => el)
  try {
    await inAct(async () => { await refreshConvo('org', 'writer'); await flush(5) })
    assert.ok(v.el.querySelector('[data-reply-event="polled"]'), 'polled snapshot is initially visible')
    await inAct(() => { ingestStream('org', { node: 'writer', kind: 'delta', text: 'continued', event_id: 'newer', reply_quote: 'Existing continued', t: Date.now() }) })
    const current = v.el.querySelector('[data-reply-event="newer"]')!
    assert.ok(current, 'newer stream source replaces the stale polled revision')
    assert.equal(current.textContent!.trim(), 'Existing continued')
    assert.equal(v.el.querySelector('[data-reply-event="polled"]'), null)
    const item = await replyOn(current); await inAct(() => { item.click() })
    assert.equal(readReply(draftKey('org', 'writer', 2))?.quote, 'Existing continued')
    assert.equal(readReply(draftKey('org', 'writer', 2))?.eventId, 'newer')
  } finally { await v.unmount(); resetConvos() }
})
