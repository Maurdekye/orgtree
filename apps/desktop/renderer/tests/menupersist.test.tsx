// menupersist.test.tsx — user 2026-09-11: an agent's context menu is open,
// the pointer is on the MENU (outside the agent's own bounds), a new event
// arrives in an open pinned chat — and the menu closes itself.
//
// THE MECHANISM, read from the source rather than guessed at:
//   · a new event in a chat the reader is sitting at the bottom of runs
//     `pin()` in canvas/desk.tsx — `el.scrollTop = el.scrollHeight`;
//   · that fires a `scroll` event on the transcript element;
//   · ContextMenu listens for `scroll` ON THE DOCUMENT IN CAPTURE MODE, so it
//     receives scrolls from every element in the page, not just the page;
//   · its handler closed on any scroll whose target was not inside the menu.
// The pinned chat is nowhere near the agent card. Nothing moved under the
// menu, and the menu went away.
//
// Closing on scroll is not wrong in itself — a menu is anchored to viewport
// coordinates, so a scroll that moves what it is anchored TO leaves it
// pointing at nothing. The bug is that it did not ask whether this scroll was
// that scroll. It does now.
//
// ⚠ WHY THE SCROLL IS DISPATCHED AND NOT PRODUCED. jsdom performs no layout:
// scrollHeight is 0, so desk.tsx's `el.scrollTop = el.scrollHeight` assigns 0
// to 0 and jsdom fires nothing. Mounting a real pinned chat and pushing a real
// event would therefore reproduce NOTHING and pass whatever the listener did —
// a vacuous test. What is dispatched here is the exact event a real autoscroll
// produces, on an element outside the menu's anchor, which is where the defect
// actually lives. §5 covers the other half — a live re-render of the card
// itself, which jsdom CAN do faithfully.
//
// ANTI-VACUITY: §1 is the only test here that asserts the menu SURVIVES.
// Every other section asserts it still closes when it should — an ancestor
// scroll (§2), a real outside press (§3), Escape (§4). A fix that simply
// stopped closing would pass §1 and fail §2-§4, which is the whole point of
// their being here.
//
// Run:  cd frontend && node tests/run.mjs menupersist

import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { NodeSquare } from '../src/canvas/cards'
import type { CanvasNode } from '../src/canvas/shared'
import type { OpResult } from '../src/types'

const noop = () => {}
const op = () => Promise.resolve({} as OpResult)
const seats = { haiku: 1, sonnet: 2, opus: 5 }
const W = () => window as unknown as Window & typeof globalThis

const menuEl = () => document.querySelector('.ctxmenu')
const labels = () => [...document.querySelectorAll('.ctxmenu [role="menuitem"]')]
  .map((b) => b.textContent ?? '')

function node(id = 'target', over: Partial<CanvasNode> = {}): CanvasNode {
  return {
    id, state: 'live', tier: 'haiku', model_id: 'haiku',
    children: [], seat: 1, grant: 0, free: 0,
    scope: { tools: {}, add_dirs: [] }, ...over,
  } as unknown as CanvasNode
}

/** the real agent card, with an UNRELATED scrollable pane beside it standing
 *  in for a pinned chat's transcript. Deliberately a sibling, not an
 *  ancestor: that is what "somewhere else on screen" means structurally. */
function Stage({ nd }: { nd: CanvasNode }) {
  return (
    <div id="surface">
      <div id="pinned-chat" className="chat-scroller">a pinned chat transcript</div>
      <NodeSquare node={nd} pos={{ x: 0, y: 0 }} lod="norm" focused={false}
        dragging={false} isDrop={false} seats={seats}
        map={new Map([[nd.id, nd]])} op={op} slug="org" toast={noop}
        pxc={1} zoom={1} compactAt={0.8} pub={false} maxTop={0}
        kioskRemaining={null} cascadeAlloc
        onSpawn={noop} onSpawnSide={noop} onSpawnTop={noop} onConfig={noop}
        onInbox={noop} onLineage={noop} onOpenDoc={noop} onRecenter={noop}
        onJump={noop} onMailLink={noop} onDragStart={noop} onDragMove={noop}
        onDragEnd={noop} onDragCancel={noop} />
    </div>
  )
}

async function stage(t: { after(fn: () => unknown): void }, nd = node()) {
  const view = await mountView(<Stage nd={nd} />, (el) => el)
  t.after(async () => { await view.unmount() })
  await flush()
  return view
}

async function openMenu(view: { el: HTMLElement }) {
  const card = view.el.querySelector('.sq')!
  const ev = new (W().MouseEvent)('contextmenu',
    { bubbles: true, cancelable: true, button: 2, clientX: 40, clientY: 30 })
  await inAct(async () => { card.dispatchEvent(ev); await flush(2) })
  assert.ok(menuEl(), 'the agent menu did not open — nothing below means anything')
  assert.ok(labels().length > 0, 'the menu opened empty')
  return card
}

/** exactly what desk.tsx's autoscroll emits: a non-bubbling `scroll` on the
 *  element that moved. It reaches the document listener only because that
 *  listener is registered in CAPTURE mode, which is the whole story. */
async function scrollOn(el: Element) {
  await inAct(async () => {
    el.dispatchEvent(new (W().Event)('scroll', { bubbles: false, cancelable: false }))
    await flush(2)
  })
}

test('§1 THE BUG: a scroll in an unrelated pinned chat leaves the agent menu '
  + 'open', async (t) => {
  const view = await stage(t)
  await openMenu(view)
  await scrollOn(view.el.querySelector('#pinned-chat')!)
  assert.ok(menuEl(),
    'the menu closed because something else on screen scrolled — nothing '
    + 'moved under it')
  // still usable, not merely present
  assert.ok(labels().includes('Open inbox'), 'the menu survived but lost its items')
})

test('§2 …but a scroll that DOES move what the menu is anchored to still '
  + 'closes it', async (t) => {
  const view = await stage(t)
  await openMenu(view)
  // an ancestor of the card: scrolling this really does carry the card, and
  // the menu would be left pointing at empty space
  await scrollOn(view.el.querySelector('#surface')!)
  assert.equal(menuEl(), null,
    'a menu whose anchor scrolled away must not stay behind')
})

test('§2b the document itself scrolling closes it too', async (t) => {
  const view = await stage(t)
  await openMenu(view)
  await scrollOn(document.documentElement)
  assert.equal(menuEl(), null)
})

test('§3 a real outside press still closes it', async (t) => {
  const view = await stage(t)
  await openMenu(view)
  await inAct(async () => {
    view.el.querySelector('#pinned-chat')!.dispatchEvent(
      new (W().MouseEvent)('pointerdown', { bubbles: true, cancelable: true }))
    await flush(2)
  })
  assert.equal(menuEl(), null, 'clicking away must still dismiss the menu')
})

test('§4 Escape still closes it', async (t) => {
  const view = await stage(t)
  await openMenu(view)
  await inAct(async () => {
    document.dispatchEvent(new (W().KeyboardEvent)('keydown',
      { key: 'Escape', bubbles: true, cancelable: true }))
    await flush(2)
  })
  assert.equal(menuEl(), null)
})

test('§5 a live re-render of the agent while the menu is open does not '
  + 'dismiss it either', async (t) => {
  // the other half of "a new event arrived": the card itself re-renders with
  // fresh props (busy flips, mail_pending ticks). jsdom reproduces this
  // faithfully, unlike the scroll, so it is driven for real.
  const view = await mountView(<Stage nd={node()} />, (el) => el)
  t.after(async () => { await view.unmount() })
  await flush()
  await openMenu(view)
  await inAct(async () => {
    await view.render(<Stage nd={node('target', { busy: true, mail_pending: 3 })} />)
    await flush(2)
  })
  assert.ok(menuEl(), 'a prop update closed the menu')
  assert.ok(labels().includes('Open inbox'))
})
