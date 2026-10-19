import { FakeServer, flush, inAct, installFetch, mountView } from './harness'
import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { DeskChat } from '../src/canvas/desk'
import type { CanvasNode } from '../src/canvas/shared'
import { refreshConvo, resetConvos } from '../src/convo'
import { requestMentionHighlight, resetSeenMentions } from '../src/canvas/agentmentions'
import { draftKey } from '../src/draftstore'
import { storeReply } from '../src/eventReply'

// jsdom has no scrolling layout. Model the browser's all-ancestor centering
// and focus scrolling explicitly; merely spying on a method cannot catch this.
async function fixture(t: TestContext, kind = 'pinned', scale = 1, docReply = false) {
  localStorage.clear(); resetConvos(); resetSeenMentions()
  const node: CanvasNode = { id: 'writer', generation: 2, state: 'live', tier: 'haiku',
    children: [], seat: 1, grant: 0, free: 0, scope: { tools: {}, add_dirs: [] },
    documents: [{ id: 'doc1', title: 'Design note', format: 'markdown', at: '2026-10-18T10:00:00Z' }] }
  const server = new FakeServer()
  server.messages = [{ role: 'assistant', text: 'Review this result, @user.', seq: 0, event_id: 'source' }]
  installFetch(server)
  storeReply(draftKey('org', 'writer', 2), { org: 'org', agent: 'writer', generation: 2,
    eventId: docReply ? 'doc:doc1' : 'source', quote: 'Review this result', ...(docReply ? { docId: 'doc1' } : {}) })
  const opened: string[] = []
  const view = await mountView(<div data-frame={kind} className={kind === 'pinned' ? 'pinwin-body' : kind === 'temporary' ? 'tempdesk-body' : 'popout-mount'}>
    <DeskChat node={node} map={new Map([[node.id, node]])} slug="org" bare
      op={async () => ({})} toast={() => {}} onOpenDoc={id => opened.push(id)} />
  </div>, el => el)
  t.after(async () => { await view.unmount(); resetConvos(); resetSeenMentions() })
  await inAct(async () => { await refreshConvo('org', 'writer'); await flush(5) })
  const frame = view.el.querySelector<HTMLElement>('[data-frame]')!
  const list = frame.querySelector<HTMLElement>('.msgs-wrap .msgs')!
  const row = list.querySelector<HTMLElement>('[data-reply-event="source"]')!
  const head = frame.querySelector<HTMLElement>('.cc-head')!
  assert.equal(!!row && !!head && !!list, true, 'real desk header and transcript loaded')
  Object.defineProperties(list, {
    clientHeight: { configurable: true, value: 300 },
    offsetHeight: { configurable: true, value: 300 },
    scrollHeight: { configurable: true, value: 1800 },
  })
  list.scrollTop = 400
  const rectangle = (top: number, height: number) => new window.DOMRect(0, top, 600 * scale, height)
  t.mock.method(list, 'getBoundingClientRect', () => rectangle(160 - frame.scrollTop, 300 * scale))
  t.mock.method(head, 'getBoundingClientRect', () => rectangle(30 - frame.scrollTop, 110))
  for (const el of [row, ...row.querySelectorAll<HTMLElement>('*')]) {
    t.mock.method(el, 'getBoundingClientRect', () => rectangle(160 - frame.scrollTop + (900 - list.scrollTop) * scale, 80 * scale))
  }
  const proto = window.HTMLElement.prototype
  const scrollDescriptor = Object.getOwnPropertyDescriptor(proto, 'scrollIntoView')
  Object.defineProperty(proto, 'scrollIntoView', { configurable: true, value: function(this: HTMLElement) {
    if (frame.contains(this)) {
      if (list.contains(this)) list.scrollTop = 790
      frame.scrollTop = 120 // overflow:hidden still accepts programmatic scroll
    }
  } })
  t.after(() => {
    if (scrollDescriptor) Object.defineProperty(proto, 'scrollIntoView', scrollDescriptor)
    else delete (proto as unknown as { scrollIntoView?: unknown }).scrollIntoView
  })
  const focus = proto.focus
  t.mock.method(proto, 'focus', function(this: HTMLElement, options?: FocusOptions) {
    if (frame.contains(this) && !options?.preventScroll) frame.scrollTop = 80
    focus.call(this, options)
  })
  const stable = () => {
    assert.equal(frame.scrollTop, 0, 'the desk host must never scroll')
    assert.equal(head.getBoundingClientRect().top, 30, 'the header stays at the top of its frame')
  }
  return { frame, list, row, head, opened, stable }
}

for (const [kind, scale] of [['pinned', 1], ['temporary', .5], ['popped-out', 1.25]] as const) {
  test(`a mention jump scrolls only the transcript in a ${kind} host`, async t => {
    const f = await fixture(t, kind, scale)
    await inAct(async () => { requestMentionHighlight('org', 'writer', 'mention1', 'source'); await flush(4) })
    f.stable()
    assert.equal(Math.abs(f.list.scrollTop - 790) < .01, true, 'the mentioned line is actually centered, accounting for scale')
  })
}

test('reply navigation reveals its source without shifting the frame', async t => {
  const f = await fixture(t)
  const jump = f.frame.querySelector<HTMLButtonElement>('.reply-preview-jump')!
  assert.equal(jump.disabled, false)
  await inAct(async () => { jump.click(); await flush(3) })
  f.stable()
  assert.equal(f.list.scrollTop, 790, 'the reply source is centered in its transcript')
})

test('a document reply opens the reader without centering the desk-header document chip', async t => {
  const f = await fixture(t, 'pinned', 1, true)
  assert.equal(!!f.frame.querySelector('.desk-docs [data-doc-id="doc1"]'), true)
  await inAct(async () => { f.frame.querySelector<HTMLButtonElement>('.reply-preview-jump')!.click(); await flush(3) })
  assert.deepEqual(f.opened, ['doc1'])
  f.stable()
})

test('starting a transcript reply focuses the composer without scrolling its host', async t => {
  const f = await fixture(t)
  await inAct(() => { f.row.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true })) })
  const reply = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(el => el.textContent === 'Reply')!
  assert.equal(!!reply, true, 'reply menu opened on the transcript event')
  await inAct(async () => { reply.click(); await new Promise(r => setTimeout(r, 35)); await flush(3) })
  f.stable()
  assert.equal(document.activeElement === f.frame.querySelector('textarea[data-first-use-chat]'), true)
})

test('starting a presentation reply focuses the composer without scrolling its host', async t => {
  const f = await fixture(t)
  const doc = f.frame.querySelector<HTMLElement>('.desk-docs [data-doc-id="doc1"]')!
  await inAct(() => { doc.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true })) })
  const reply = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(el => el.textContent === 'Reply')!
  assert.equal(!!reply, true, 'presentation reply action is available')
  await inAct(async () => { reply.click(); await new Promise(r => setTimeout(r, 35)); await flush(3) })
  f.stable()
  assert.equal(document.activeElement === f.frame.querySelector('textarea[data-first-use-chat]'), true)
})
