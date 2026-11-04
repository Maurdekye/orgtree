// There is no "jump to message" label anywhere: the whole quoted block is the jump (USER 2026-11-04 14:37Z m9decb4fe3b0d,
// replacing the 2026-11-03 m3db1ac4251e4 inline link; @item:orgtree/restyle-reply-blocks-and-the-inline-quoted-reply).
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

const press = async (el: Element, key: string) => { await inAct(async () => { el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })); await flush(1) }) }

test('a quote of a CARD (a thought) has no jump label; the whole block jumps by click, Enter and Space', async t => {
  let located = 0
  const view = await mountView(withCard(<ReplyPreview reply={cardReply} available onLocate={() => { located++ }} />), el => el)
  t.after(() => view.unmount())
  await inAct(async () => { await flush(2) })
  assert.equal(view.el.querySelector('.reply-preview-jump'), null, 'no jump control')
  assert.equal(view.el.querySelector('.reply-jump-slot'), null, 'no slot appended to the quoted header')
  assert.doesNotMatch(view.el.textContent ?? '', /jump to message/)
  const block = view.el.querySelector('.reply-preview') as HTMLElement
  assert.equal(block.getAttribute('role'), 'link'); assert.equal(block.tabIndex, 0)
  await inAct(async () => { block.click(); await flush(1) })
  assert.equal(located, 1, 'a click on the block jumps')
  await press(block, 'Enter'); assert.equal(located, 2)
  await press(block, ' '); assert.equal(located, 3)
})

test('a text-only quote has no jump label either; a draft keeps its x in the head row', async t => {
  let located = 0, removed = 0
  const plain = await mountView(<ReplyPreview reply={reply} available onLocate={() => { located++ }} />, el => el)
  t.after(() => plain.unmount())
  await inAct(async () => { await flush(2) })
  assert.equal(plain.el.querySelector('.reply-preview-jump'), null)
  await inAct(async () => { (plain.el.querySelector('.reply-preview') as HTMLElement).click(); await flush(1) })
  assert.equal(located, 1)
  const draft = await mountView(<ReplyPreview reply={reply} available onLocate={() => {}} onRemove={() => { removed++ }} />, el => el)
  t.after(() => draft.unmount())
  await inAct(async () => { await flush(2) })
  const head = draft.el.querySelector('.reply-preview-head')
  assert.ok(head, 'a text-only composer draft keeps its control strip')
  assert.equal(head!.querySelector('.reply-preview-jump'), null)
  await inAct(async () => { (head!.querySelector('button[aria-label="Remove reply"]') as HTMLButtonElement).click(); await flush(1) })
  assert.equal(removed, 1)
  assert.equal(located, 1, 'the x does not jump')
})

test('a composer draft of a CARD quote: no jump label, x alone at the block corner, block still jumps', async t => {
  let removed = 0, located = 0
  const draft = await mountView(withCard(<ReplyPreview reply={cardReply} available
    onLocate={() => { located++ }} onRemove={() => { removed++ }} />), el => el)
  t.after(() => draft.unmount())
  await inAct(async () => { await flush(2) })
  assert.equal(draft.el.querySelector('.reply-preview-jump'), null)
  assert.equal(draft.el.querySelector('.reply-preview-head'), null, 'no separate row above the quoted header')
  const remove = draft.el.querySelector('button[aria-label="Remove reply"]') as HTMLButtonElement
  assert.ok(remove, 'the x remains')
  assert.equal(remove.closest('.reply-preview-content'), null, 'the x is not inside the quote')
  assert.equal(remove.parentElement, draft.el.querySelector('.reply-preview'), 'the x belongs to the block frame itself (its top right corner)')
  await inAct(async () => { remove.click(); await flush(1) })
  assert.equal(removed, 1); assert.equal(located, 0, 'remove does not navigate')
  await inAct(async () => { (draft.el.querySelector('.reply-preview') as HTMLElement).click(); await flush(1) })
  assert.equal(located, 1)
})

test('an unreachable quote is inert: no link role, no tab stop, nothing happens on Enter', async t => {
  let located = 0
  const view = await mountView(withCard(<ReplyPreview reply={cardReply} available={false} onLocate={() => { located++ }} />), el => el)
  t.after(() => view.unmount())
  await inAct(async () => { await flush(2) })
  const block = view.el.querySelector('.reply-preview') as HTMLElement
  assert.equal(block.getAttribute('role'), null); assert.equal(block.getAttribute('tabindex'), null)
  await press(block, 'Enter'); assert.equal(located, 0)
})
