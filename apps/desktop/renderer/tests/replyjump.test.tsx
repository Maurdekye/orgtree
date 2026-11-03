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
const cardSources = indexReplySources({ messages: [{ role: 'assistant', event_id: 'src', text: 'x', thinking: 'A thought', thinking_event_id: 'card', ts: '2026-11-03T13:16:30Z' } as never] })
const cardReply: ReplyContext = { ...reply, eventId: 'card' }
const withCard = (node: React.ReactNode) =>
  <ReplySourceProvider value={r => <ReplySourceContent source={cardSources.get(r.eventId)!} slug="org" nid="writer" profile="operator" />}>
    {node}
  </ReplySourceProvider>
const withSource = (node: React.ReactNode) =>
  <ReplySourceProvider value={r => <ReplySourceContent source={sources.get(r.eventId)!} slug="org" nid="writer" profile="operator" />}>
    {node}
  </ReplySourceProvider>

test('a quote of a CARD (a thought) keeps the jump link inside the quoted header row, after its time', async t => {
  let located = 0
  const view = await mountView(withCard(<ReplyPreview reply={cardReply} available onLocate={() => { located++ }} />), el => el)
  t.after(() => view.unmount())
  await inAct(async () => { await flush(2) })
  const jumps = view.el.querySelectorAll('.reply-preview-jump')
  assert.equal(jumps.length, 1, 'one jump link')
  const jump = jumps[0] as HTMLButtonElement
  const header = jump.closest('.reply-source-meta')
  assert.ok(header, 'the link lives inside the quoted block header row')
  assert.ok(header!.closest('.reply-preview-content'), 'that header is the quote own')
  assert.ok(header!.querySelector('time')!.compareDocumentPosition(jump) & Node.DOCUMENT_POSITION_FOLLOWING, 'at the right end: after the time')
  assert.equal(jump.textContent?.trim(), 'jump to message', 'icon, text and style kept')
  assert.equal(view.el.querySelector('.reply-preview-head'), null, 'no separate head line above the quote')
  await inAct(async () => { jump.click(); await flush(1) })
  assert.equal(located, 1, 'the link still jumps to the original')
})

test('a quote with no header of its own keeps the link in the block head', async t => {
  const plain = await mountView(<ReplyPreview reply={reply} available onLocate={() => {}} />, el => el)
  t.after(() => plain.unmount())
  await inAct(async () => { await flush(2) })
  assert.ok(plain.el.querySelector('.reply-preview-head .reply-preview-jump'), 'text-only quote: the head row is the header')
  let removed = 0
  const draft = await mountView(<ReplyPreview reply={reply} available onLocate={() => {}} onRemove={() => { removed++ }} />, el => el)
  t.after(() => draft.unmount())
  await inAct(async () => { await flush(2) })
  const head = draft.el.querySelector('.reply-preview-head')
  assert.ok(head, 'a text-only composer draft keeps its control strip')
  assert.ok(head!.querySelector('.reply-preview-jump') && head!.querySelector('button[aria-label="Remove reply"]'))
})

test('a composer draft of a CARD quote: link in the quoted header row, x alone at the block corner', async t => {
  let removed = 0, located = 0
  const draft = await mountView(withCard(<ReplyPreview reply={cardReply} available
    onLocate={() => { located++ }} onRemove={() => { removed++ }} />), el => el)
  t.after(() => draft.unmount())
  await inAct(async () => { await flush(2) })
  const jump = draft.el.querySelector('.reply-preview-jump') as HTMLButtonElement
  assert.ok(jump.closest('.reply-source-meta'), 'the link joins the quoted header row, as on a sent reply')
  assert.equal(draft.el.querySelector('.reply-preview-head'), null, 'no separate row above the quoted header')
  const remove = draft.el.querySelector('button[aria-label="Remove reply"]') as HTMLButtonElement
  assert.ok(remove, 'the x remains')
  assert.equal(remove.closest('.reply-preview-content'), null, 'the x is not inside the quote')
  assert.equal(remove.parentElement, draft.el.querySelector('.reply-preview'), 'the x belongs to the block frame itself (its top right corner)')
  await inAct(async () => { remove.click(); jump.click(); await flush(1) })
  assert.equal(removed, 1, 'the x still removes the draft')
  assert.equal(located, 1, 'the link still jumps')
})

test('the link keeps one place across re-renders and the header it joins pushes it to the right end', async t => {
  const view = await mountView(withCard(<ReplyPreview reply={cardReply} available onLocate={() => {}} />), el => el)
  t.after(() => view.unmount())
  await inAct(async () => { await flush(2) })
  await view.render(withCard(<ReplyPreview reply={{ ...cardReply, quote: 'Changed' }} available onLocate={() => {}} />))
  await inAct(async () => { await flush(2) })
  assert.equal(view.el.querySelectorAll('.reply-preview-jump').length, 1, 'still exactly one link')
  assert.equal(view.el.querySelectorAll('.reply-jump-slot').length, 1, 'one slot in the header')
})
