// ctxtarget.test.tsx — A CONTEXT MENU ON A TRANSCRIPT EVENT (user spec
// 2026-09-12): it must stay open while the transcript keeps updating, and the
// event it was raised on must stay visibly marked for the menu's whole life,
// then be cleared when the menu closes.
//
// THE TWO MECHANISMS, read from the source:
//
//   1. THE MENU DISMISSED ITSELF. A menu is anchored to viewport coordinates
//      and closes when a scroll moves what it is anchored to — correctly, or
//      it would be left pointing at empty space (menupersist.test.tsx §2). But
//      every arriving event runs `pin()` on a desk whose reader is at the
//      bottom (`el.scrollTop = el.scrollHeight`), and that scroll moves the
//      very row the menu was raised from. So the menu closed on the next
//      event, every time. The desk now HOLDS its autoscroll while a menu of
//      its own is open, and releases it — catching the reader up — when the
//      menu closes.
//   2. NOTHING SAID WHICH EVENT. There was no mark at all. A mark written by
//      the row itself would die with the row (the transcript re-keys rows
//      mid-stream — see foldpersist.test.tsx), so the desk remembers the
//      EVENT ID and re-finds its element after every render, which also moves
//      the menu's anchor onto the element that exists now.
//
// ⚠ WHY THE SCROLLER IS SHIMMED. jsdom performs no layout: scrollHeight is 0,
// so `pin()` assigns 0 to 0 and jsdom fires nothing — a desk that autoscrolled
// and a desk that did not would look identical, and every assertion here would
// be vacuous. `scrollable()` gives the transcript the two numbers a browser
// would have and makes its scrollTop setter fire the `scroll` event a browser
// fires. Nothing else is faked: the real desk, the real `useContextMenu`, the
// real listeners.
//
// ANTI-VACUITY: §1b asserts the held autoscroll is released (a desk that
// simply stopped following the conversation would pass §1 and fail §1b), and
// §2 asserts a genuine user scroll of the transcript STILL closes the menu — a
// fix that just stopped closing on scroll fails there.
//
// Run:  node apps/desktop/renderer/tests/run.mjs ctxtarget

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

/** the scroll box a browser would have given this element, including the
 *  `scroll` event its scrollTop setter fires when the position really moves */
function scrollable(el: Element, scrollHeight = 1000, clientHeight = 200) {
  let top = 0
  const max = scrollHeight - clientHeight
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => scrollHeight })
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => clientHeight })
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (v: number) => {
      const next = Math.max(0, Math.min(Number(v) || 0, max))
      if (next === top) return
      top = next
      el.dispatchEvent(new W.Event('scroll', { bubbles: false, cancelable: false }))
    },
  })
  return { at: () => top, bottom: max, to: (v: number) => { (el as HTMLElement).scrollTop = v } }
}

interface Mounted {
  el: HTMLElement
  server: FakeServer
  scroller: HTMLElement
  poll: () => Promise<void>
  unmount: () => Promise<void>
}

async function desk(messages: ChatMessage[]): Promise<Mounted> {
  localStorage.clear(); resetConvos()
  const server = new FakeServer()
  server.messages = messages
  installFetch(server)
  const view = await mountView(
    <DeskChat node={writer} map={new Map([[writer.id, writer]])} slug="org"
      op={async () => ({})} toast={() => {}} pub={false} bare />, el => el)
  await inAct(async () => { await refreshConvo('org', 'writer'); await flush(5) })
  return {
    el: view.el, server,
    scroller: view.el.querySelector('.msgs') as HTMLElement,
    poll: async () => { await inAct(async () => { await refreshConvo('org', 'writer'); await flush(5) }) },
    unmount: async () => { await view.unmount(); resetConvos() },
  }
}

const menuEl = () => document.querySelector('.ctxmenu')
const labels = () => [...document.querySelectorAll('.ctxmenu [role="menuitem"]')]
  .map(b => b.textContent ?? '')
const marked = (m: Mounted) => [...m.el.querySelectorAll('.ctx-target')]
const rowOf = (m: Mounted, id: string) =>
  m.el.querySelector(`[data-transcript-row][data-reply-event="${id}"]`) as HTMLElement

async function rightClick(el: Element): Promise<void> {
  const ev = new W.MouseEvent('contextmenu',
    { bubbles: true, cancelable: true, button: 2, clientX: 40, clientY: 30 })
  await inAct(() => { el.dispatchEvent(ev) })
  await flush(2)
  assert.equal(ev.defaultPrevented, true, 'the desk did not take the press')
  assert.ok(menuEl(), 'no menu opened — nothing after this would mean anything')
}
async function pressAway(m: Mounted): Promise<void> {
  await inAct(() => {
    m.el.dispatchEvent(new W.MouseEvent('pointerdown', { bubbles: true, cancelable: true }))
  })
  await flush(2)
}

// ────────────────────────────────────── §1 the menu survives live updates

test('§1 THE BUG: an arriving event does not dismiss a menu on a transcript row',
  async () => {
    const m = await desk([{ role: 'user', text: 'go', seq: 0, event_id: 'ask-1' }])
    const box = scrollable(m.scroller)
    try {
      await rightClick(rowOf(m, 'ask-1'))
      m.server.assistantMsg('an event arrives', { event_id: 'reply-2' })
      await m.poll()
      assert.ok(menuEl(), 'the menu closed when the transcript updated')
      assert.deepEqual(labels(), ['Reply', 'Copy contents'],
        'the menu survived but lost its actions')
      assert.equal(box.at(), 0, 'the desk scrolled out from under its own menu')
    } finally { await m.unmount() }
  })

test('§1b …and the held autoscroll is RELEASED when the menu closes',
  async () => {
    const m = await desk([{ role: 'user', text: 'go', seq: 0, event_id: 'ask-1' }])
    const box = scrollable(m.scroller)
    try {
      await rightClick(rowOf(m, 'ask-1'))
      m.server.assistantMsg('an event arrives', { event_id: 'reply-2' })
      await m.poll()
      assert.equal(box.at(), 0, 'held while the menu is up')
      await pressAway(m)
      assert.equal(menuEl(), null, 'the press away must close the menu')
      assert.equal(box.at(), box.bottom,
        'the reader was left behind: the transcript never caught up')
    } finally { await m.unmount() }
  })

test('§1c a streaming row being re-keyed under the menu does not dismiss it',
  async () => {
    const m = await desk([
      { role: 'user', text: 'go', seq: 0, event_id: 'ask-1' },
      { role: 'assistant', text: 'streaming', seq: 1, assistant_id: 'as-1',
        assistant_revision: 1, assistant_state: 'partial', assistant_pending: true,
        assistant_scope: 'turn' },
    ])
    scrollable(m.scroller)
    try {
      await rightClick(rowOf(m, 'ask-1'))
      m.server.messages[1] = { role: 'assistant', text: 'streaming', seq: 1,
        native_event_id: 'nat-1', event_id: 'reply-1' }
      await m.poll()
      assert.ok(menuEl(), 'the re-key closed the menu')
    } finally { await m.unmount() }
  })

// ────────────────────────────────────── §2 …but a real scroll still closes

test('§2 a genuine scroll of the transcript still closes the menu', async () => {
  const m = await desk([{ role: 'user', text: 'go', seq: 0, event_id: 'ask-1' }])
  const box = scrollable(m.scroller)
  try {
    await rightClick(rowOf(m, 'ask-1'))
    await inAct(() => { box.to(300) })
    await flush(2)
    assert.equal(menuEl(), null,
      'a menu whose anchor scrolled away must not stay behind')
    assert.deepEqual(marked(m), [], 'and the mark goes with it')
  } finally { await m.unmount() }
})

test('§2b Escape still closes it, and clears the mark', async () => {
  const m = await desk([{ role: 'user', text: 'go', seq: 0, event_id: 'ask-1' }])
  try {
    await rightClick(rowOf(m, 'ask-1'))
    assert.equal(marked(m).length, 1)
    await inAct(() => {
      document.dispatchEvent(new W.KeyboardEvent('keydown',
        { key: 'Escape', bubbles: true, cancelable: true }))
    })
    await flush(2)
    assert.equal(menuEl(), null)
    assert.deepEqual(marked(m), [])
  } finally { await m.unmount() }
})

// ─────────────────────────────────────────────── §3 the mark itself

test('§3 the right-clicked event is marked, alone, for the life of the menu',
  async () => {
    const m = await desk([
      { role: 'user', text: 'go', seq: 0, event_id: 'ask-1' },
      { role: 'assistant', text: 'done', seq: 1, event_id: 'reply-1' },
    ])
    try {
      await rightClick(rowOf(m, 'ask-1'))
      assert.deepEqual(marked(m), [rowOf(m, 'ask-1')],
        'exactly the event that was pressed, and only it')
      await pressAway(m)
      assert.deepEqual(marked(m), [], 'the mark outlived its menu')
    } finally { await m.unmount() }
  })

test('§3b the mark FOLLOWS its event through a re-key', async () => {
  // the row the menu was raised on is replaced by its durable projection: a
  // new element for the same event. A mark held on the old element would be
  // on a node that is no longer in the document.
  const m = await desk([
    { role: 'assistant', text: 'streaming', seq: 0, event_id: 'reply-1',
      assistant_id: 'as-1', assistant_revision: 1, assistant_state: 'partial',
      assistant_pending: true, assistant_scope: 'turn' },
  ])
  scrollable(m.scroller)
  try {
    const before = rowOf(m, 'reply-1')
    await rightClick(before)
    assert.deepEqual(marked(m), [before])
    m.server.messages[0] = { role: 'assistant', text: 'streaming', seq: 0,
      event_id: 'reply-1', native_event_id: 'nat-1' }
    await m.poll()
    const after = rowOf(m, 'reply-1')
    assert.notEqual(after, before, 'fixture: the row really was replaced')
    assert.deepEqual(marked(m), [after], 'the mark did not follow its event')
    assert.ok(menuEl(), 'and the menu is still there to be marked for')
  } finally { await m.unmount() }
})

test('§3c a second right-click moves the mark rather than adding one', async () => {
  const m = await desk([
    { role: 'user', text: 'go', seq: 0, event_id: 'ask-1' },
    { role: 'assistant', text: 'done', seq: 1, event_id: 'reply-1' },
  ])
  try {
    await rightClick(rowOf(m, 'ask-1'))
    await rightClick(rowOf(m, 'reply-1'))
    assert.deepEqual(marked(m), [rowOf(m, 'reply-1')])
  } finally { await m.unmount() }
})

test('§3d the mark lands on the exact part pressed, not the whole row',
  async () => {
    // a thought is its own right-click target (Reply and Copy already treat it
    // as one), so the mark has to be that precise too
    const m = await desk([
      { role: 'assistant', text: 'done', seq: 0, event_id: 'reply-1',
        thinking: 'the reasoning', thinking_event_id: 'th-1', think_secs: 3 },
    ])
    try {
      const thought = m.el.querySelector('[data-reply-event="th-1"]')!
      await rightClick(thought)
      assert.deepEqual(marked(m), [thought],
        'the whole message lit up for a press on its thought')
    } finally { await m.unmount() }
  })

// ───────────────────────────────────── §4 what the menu already promised

test('§4 a live text selection still keeps the browser\'s own menu — and marks '
  + 'nothing', async () => {
  const m = await desk([{ role: 'assistant', text: 'select me', seq: 0, event_id: 'reply-1' }])
  try {
    const body = m.el.querySelector('.msgtext')!
    const sel = W.getSelection()!
    const range = document.createRange()
    range.selectNodeContents(body)
    sel.removeAllRanges(); sel.addRange(range)
    const ev = new W.MouseEvent('contextmenu',
      { bubbles: true, cancelable: true, button: 2, clientX: 40, clientY: 30 })
    await inAct(() => { body.dispatchEvent(ev) })
    await flush(2)
    assert.equal(ev.defaultPrevented, false, 'select-and-copy lost the browser menu')
    assert.equal(menuEl(), null)
    assert.deepEqual(marked(m), [], 'a menu that never opened must mark nothing')
    sel.removeAllRanges()
  } finally { await m.unmount() }
})
