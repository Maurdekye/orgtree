// escapereply.test.tsx — Escape cancels a prepared reply, exactly as its ×.
//
// User 2026-10-13: "hitting escape while a reply is prepared cancels the
// reply". Overlays take Escape first; with no reply Escape keeps its meaning;
// an IME composition never triggers it.
//
// Run:  node apps/desktop/renderer/tests/run.mjs escapereply
import { FakeServer, inAct, installFetch, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { DeskChat } from '../src/canvas/desk'
import type { CanvasNode } from '../src/canvas/shared'
import { resetConvos } from '../src/convo'
import { draftKey } from '../src/draftstore'
import { readReply, storeReply } from '../src/eventReply'
import type { ReplyContext } from '../src/eventReply'

const source: ReplyContext = { org: 'org', agent: 'writer', generation: 2, eventId: 'event-second', quote: 'same text' }
const writer: CanvasNode = { id: 'writer', generation: 2, state: 'live', tier: 'haiku', children: [],
  seat: 1, grant: 0, free: 0, scope: { tools: {}, add_dirs: [] } }
const desk = () => <DeskChat node={writer} map={new Map([[writer.id, writer]])} slug="org"
  op={async () => ({})} toast={() => {}} bare />
const key = draftKey('org', 'writer', 2)

async function mountWithReply(reply: boolean) {
  localStorage.clear(); resetConvos(); installFetch(new FakeServer())
  if (reply) storeReply(key, source)
  localStorage.setItem(key, 'Typed text')
  return mountView(desk(), el => el)
}
async function escape(target: Element, init: KeyboardEventInit = {}) {
  const e = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, ...init })
  await inAct(() => { target.dispatchEvent(e) })
  return e
}
const box = (el: HTMLElement) => el.querySelector<HTMLTextAreaElement>('textarea')!

test('reply set: Escape in the composer drops the reply like its ×, and keeps the typed text', async () => {
  const view = await mountWithReply(true)
  try {
    assert.ok(view.el.querySelector('.reply-preview-composing'), 'positive control: the reply bar is up')
    const e = await escape(box(view.el))
    assert.equal(e.defaultPrevented, true, 'the cancel claims the key, so nothing else also acts on it')
    assert.equal(view.el.querySelector('.reply-preview-composing'), null)
    assert.equal(readReply(key), null, 'the stored reply is gone, as with ×')
    assert.equal(box(view.el).value, 'Typed text', '× keeps the typed text, so Escape does too')
  } finally { await view.unmount(); resetConvos() }
})

test('reply set: Escape anywhere in the conversation view also cancels it', async () => {
  const view = await mountWithReply(true)
  try {
    await escape(view.el.querySelector('.reply-preview')!)
    assert.equal(readReply(key), null)
  } finally { await view.unmount(); resetConvos() }
})

test('an open overlay takes Escape first and the reply stays', async () => {
  const view = await mountWithReply(true)
  try {
    // the effort pop-out, a desk overlay that listens on the window
    await inAct(() => { view.el.querySelector<HTMLButtonElement>('.eff-wrap > button')!.click() })
    assert.ok(view.el.querySelector('.eff-pop'), 'positive control: the pop-out opened')
    await escape(box(view.el))
    assert.equal(view.el.querySelector('.eff-pop'), null, 'Escape closed the pop-out')
    assert.deepEqual(readReply(key), source, '...and only the pop-out')
    // the image viewer, which listens on the document after the desk
    const lb = document.createElement('div'); lb.className = 'lb-overlay'; document.body.appendChild(lb)
    try { await escape(box(view.el)) } finally { lb.remove() }
    assert.deepEqual(readReply(key), source, 'the open viewer, not the reply, owns that Escape')
    // a surface that already took the key (the useEsc stack's top, a menu)
    const claim = (e: KeyboardEvent) => e.preventDefault()
    window.addEventListener('keydown', claim, true)
    try { await escape(box(view.el)) } finally { window.removeEventListener('keydown', claim, true) }
    assert.deepEqual(readReply(key), source, 'an Escape already handled elsewhere does not cancel the reply')
    // with every overlay gone, the next Escape cancels it
    await escape(box(view.el))
    assert.equal(readReply(key), null)
  } finally { await view.unmount(); resetConvos() }
})

test('an IME composition never cancels the reply', async () => {
  const view = await mountWithReply(true)
  try {
    const e = await escape(box(view.el), { isComposing: true })
    assert.equal(e.defaultPrevented, false)
    assert.deepEqual(readReply(key), source)
  } finally { await view.unmount(); resetConvos() }
})

test('no reply: Escape is left alone for whatever owned it before', async () => {
  const view = await mountWithReply(false)
  try {
    assert.equal(view.el.querySelector('.reply-preview'), null, 'positive control: no reply bar')
    let reachedDocument = false
    const seen = () => { reachedDocument = true }
    document.addEventListener('keydown', seen)
    try {
      const e = await escape(box(view.el))
      assert.equal(e.defaultPrevented, false, 'not claimed')
    } finally { document.removeEventListener('keydown', seen) }
    assert.equal(reachedDocument, true, 'still propagates to document-level handlers')
    assert.equal(box(view.el).value, 'Typed text')
  } finally { await view.unmount(); resetConvos() }
})
