// "jump to message" sits inline in the quoted block's own header row, at its
// right end, not on a line above it (USER 2026-11-03 11:17:10Z
// m3db1ac4251e4; follow-up to @item:orgtree/restyle-reply-blocks-and-the-inline-quoted-reply).
import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { ReplyPreview, ReplySourceProvider } from '../src/canvas/replypreview'
import { indexReplySources, ReplySourceContent } from '../src/canvas/replysource'
import type { ReplyContext } from '../src/eventReply'

const reply: ReplyContext = { org: 'org', agent: 'writer', generation: 2, eventId: 'source', quote: 'Saved excerpt' }
const sources = indexReplySources({ messages: [{ role: 'assistant', event_id: 'source', text: 'The quoted answer.',
  ts: '2026-11-03T13:16:30Z' }] })
const withSource = (node: React.ReactNode) =>
  <ReplySourceProvider value={r => <ReplySourceContent source={sources.get(r.eventId)!} slug="org" nid="writer" profile="operator" />}>
    {node}
  </ReplySourceProvider>

test('with a loaded source the jump link is inside the quoted header row, after its time', async t => {
  let located = 0
  const view = await mountView(withSource(<ReplyPreview reply={reply} available onLocate={() => { located++ }} />), el => el)
  t.after(() => view.unmount())
  await inAct(async () => { await flush(2) })
  const jumps = view.el.querySelectorAll('.reply-preview-jump')
  assert.equal(jumps.length, 1, 'one jump link')
  const jump = jumps[0] as HTMLButtonElement
  const header = jump.closest('.reply-source-meta')
  assert.ok(header, 'the link lives inside the quoted block\'s header row')
  assert.ok(header!.closest('.reply-preview-content'), 'that header is the quote\'s own')
  assert.equal(header!.querySelector('time') !== null, true)
  assert.ok(header!.querySelector('time')!.compareDocumentPosition(jump) & Node.DOCUMENT_POSITION_FOLLOWING,
    'at the right end: after the time')
  assert.equal(jump.textContent?.trim(), 'jump to message', 'icon, text and style kept')
  assert.equal(view.el.querySelector('.reply-preview-head'), null, 'no separate head line above the quote')
  await inAct(async () => { jump.click(); await flush(1) })
  assert.equal(located, 1, 'the link still jumps to the original')
})

test('a quote with no header of its own keeps the link in the block head; a composer draft keeps its controls', async t => {
  const plain = await mountView(<ReplyPreview reply={reply} available onLocate={() => {}} />, el => el)
  t.after(() => plain.unmount())
  await inAct(async () => { await flush(2) })
  assert.ok(plain.el.querySelector('.reply-preview-head .reply-preview-jump'), 'text-only quote: the head row is the header')
  let removed = 0
  const draft = await mountView(withSource(<ReplyPreview reply={reply} available onLocate={() => {}} onRemove={() => { removed++ }} />), el => el)
  t.after(() => draft.unmount())
  await inAct(async () => { await flush(2) })
  const head = draft.el.querySelector('.reply-preview-head')
  assert.ok(head, 'the composer keeps its control strip')
  assert.ok(head!.querySelector('.reply-preview-jump'), 'jump stays with the remove control')
  assert.ok(head!.querySelector('button[aria-label="Remove reply"]'))
})

test('the link keeps one place across re-renders and the header it joins pushes it to the right end', async t => {
  const view = await mountView(withSource(<ReplyPreview reply={reply} available onLocate={() => {}} />), el => el)
  t.after(() => view.unmount())
  await inAct(async () => { await flush(2) })
  await view.render(withSource(<ReplyPreview reply={{ ...reply, quote: 'Changed' }} available onLocate={() => {}} />))
  await inAct(async () => { await flush(2) })
  assert.equal(view.el.querySelectorAll('.reply-preview-jump').length, 1, 'still exactly one link')
  assert.equal(view.el.querySelectorAll('.reply-jump-slot').length, 1, 'one slot in the header')
})
