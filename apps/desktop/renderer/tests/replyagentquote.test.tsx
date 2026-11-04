// An agent message quoted in a reply wears the MAIL reply's frame (USER 2026-11-03 18:24:33Z m64286c099254): the muted head
// "In reply to <agent> · <time>" (no jump label: the whole block is the jump), then the clamped text; no title, no right-aligned time, no
// far-right link. The mail and docket replies are the reference and do not change.
import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { ReplyPreview, ReplySourceProvider } from '../src/canvas/replypreview'
import { indexReplySources, ReplySourceContent } from '../src/canvas/replysource'
import type { ReplyContext } from '../src/eventReply'
import { readFileSync } from 'node:fs'
import path from 'node:path'

declare const __SRC_DIR__: string

const reply: ReplyContext = { org: 'org', agent: 'coordinator-opus', generation: 1, eventId: 'source', quote: 'Saved excerpt' }
const sources = indexReplySources({ messages: [{ role: 'assistant', event_id: 'source', text: 'Got it, **bold** answer.',
  ts: '2026-11-03T18:23:09Z' }] })
const withSource = (node: React.ReactNode) =>
  <ReplySourceProvider value={r => <ReplySourceContent source={sources.get(r.eventId)!} slug="org" nid="coordinator-opus" profile="operator" />}>
    {node}
  </ReplySourceProvider>

test('the agent-message quote has the mail reply\'s structure: head with the jump link, then a blockquote', async t => {
  let located = 0
  const view = await mountView(withSource(<ReplyPreview reply={reply} available onLocate={() => { located++ }} />), el => el)
  t.after(() => view.unmount())
  await inAct(async () => { await flush(2) })
  const frame = view.el.querySelector('aside.reply-preview')!
  const head = frame.querySelector(':scope > .reply-preview-head')
  assert.ok(head, 'the mail reply\'s head row')
  assert.match(head!.querySelector('span')?.textContent ?? '', /^In reply to coordinator-opus · 2026-11-03/)
  assert.ok(head!.querySelector('svg'), 'its reply arrow')
  assert.equal(head!.querySelector('.reply-preview-jump'), null, 'no jump label in the head: the whole block is the jump')
  assert.doesNotMatch(head!.textContent ?? '', /jump to message/)
  const quote = frame.querySelector(':scope > blockquote')
  assert.ok(quote, 'the text sits in the same blockquote the mail reply clamps')
  assert.ok(quote!.querySelector('strong'), 'its Markdown still renders')
  assert.match(quote!.textContent ?? '', /Got it, bold answer\./)
  await inAct(async () => { (frame as HTMLElement).click(); await flush(1) })
  assert.equal(located, 1, 'a click on the block jumps to the original')
})

test('the block is the jump: link role, tab stop, pointer and hover cue, Enter and Space', async t => {
  let located = 0
  const view = await mountView(withSource(<ReplyPreview reply={reply} available onLocate={() => { located++ }} />), el => el)
  t.after(() => view.unmount())
  await inAct(async () => { await flush(2) })
  const frame = view.el.querySelector('aside.reply-preview') as HTMLElement
  assert.equal(frame.getAttribute('role'), 'link'); assert.equal(frame.tabIndex, 0)
  frame.focus(); assert.equal(document.activeElement, frame)
  for (const key of ['Enter', ' ']) await inAct(async () => { frame.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })); await flush(1) })
  assert.equal(located, 2, 'Enter and Space both activate')
  const css = readFileSync(path.join(__SRC_DIR__, 'styles.css'), 'utf8')
  assert.match(css, /\.reply-preview\[role="link"\]\s*\{\s*cursor:\s*pointer;/, 'pointer')
  assert.match(css, /\.reply-preview\[role="link"\]:hover\s*\{\s*background:/, 'hover cue')
  assert.match(css, /\.reply-preview\[role="link"\]:focus-visible/, 'focus ring')
})

test('no title, no right-aligned timestamp and no far-right link element remain', async t => {
  const view = await mountView(withSource(<ReplyPreview reply={reply} available onLocate={() => {}} />), el => el)
  t.after(() => view.unmount())
  await inAct(async () => { await flush(2) })
  assert.equal(view.el.querySelector('.reply-source-meta'), null, 'the card header (title + right-aligned time) is gone')
  assert.equal(view.el.querySelector('.reply-jump-slot'), null, 'no portalled far-right link slot')
  assert.equal(view.el.querySelector('.reply-preview-content'), null, 'not the scrolling card region')
  assert.doesNotMatch(view.el.textContent ?? '', /Assistant message/)
  assert.equal(view.el.querySelector('time'), null, 'the timestamp is in the head text, not a time element at the far right')
})

test('a composer draft of an agent quote keeps the x in the head row, as the mail reply draft does', async t => {
  let removed = 0
  const view = await mountView(withSource(<ReplyPreview reply={reply} available onLocate={() => {}} onRemove={() => { removed++ }} />), el => el)
  t.after(() => view.unmount())
  await inAct(async () => { await flush(2) })
  const head = view.el.querySelector('.reply-preview-head')!
  const x = head.querySelector('button[aria-label="Remove reply"]') as HTMLButtonElement
  assert.ok(x, 'the x joins the head row')
  assert.equal(head.querySelector('.reply-preview-jump'), null)
  await inAct(async () => { x.click(); await flush(1) })
  assert.equal(removed, 1)
})

test('a quote of anything else (a thought) keeps its own card header, unchanged', async t => {
  const other = indexReplySources({ messages: [{ role: 'assistant', event_id: 'th', text: 'x', thinking: 'pondering', thinking_event_id: 'th2', ts: '2026-11-03T18:23:09Z' } as never] })
  const view = await mountView(
    <ReplySourceProvider value={r => <ReplySourceContent source={other.get(r.eventId)!} slug="org" nid="a" profile="operator" />}>
      <ReplyPreview reply={{ ...reply, eventId: 'th2' }} available onLocate={() => {}} />
    </ReplySourceProvider>, el => el)
  t.after(() => view.unmount())
  await inAct(async () => { await flush(2) })
  assert.ok(view.el.querySelector('.reply-source-meta'), 'a thought keeps its header')
})
