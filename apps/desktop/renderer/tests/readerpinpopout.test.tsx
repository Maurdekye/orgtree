// readerpinpopout.test.tsx — a reader opened FROM A POPPED-OUT WINDOW stays in that window when it is pinned.
//
// User 2026-11-12 md15fcb3a298e: "when the presentations reader is opened for a presentation by clicking its card in
// the header of a popped-out agent desk, it works, but trying to pin it makes it invisible and unable to be
// interacted with". The reader's open state lives at the canvas, so it is not a React child of the popped-out desk;
// `MovableSurface` puts it in the window the click came from. Pinning then handed it the MAIN window's pin layer as
// its anchor, and the reader left the window the user was looking at.
//
//   §1  control: in the main window a pinned reader sits in the org's pin layer, as before
//   §2  opened from a popped-out window and then pinned: it stays in that window, pinned, inside that window's
//       own area; unpinning leaves it there too
//   §3  a reader whose kind is ALREADY pinned opens, from a popped-out window, in that window
//
// ⚠ WHAT jsdom CANNOT SHOW: paint. That the pinned reader is drawn above the desk in the real popped-out window is
// a capture's question. What is asserted here is which DOCUMENT holds it, that it is dressed as a pinned window,
// and that its box lies inside the window it is in.
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs readerpinpopout

import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { noteActionDocument, resetActionDocument } from '../src/windowlife'
import { CurrentOrg } from '../src/popout'
import { PinFrame, forgetModalPins, pinModal, unpinModal } from '../src/canvas/modalpin'
import { pinLayerFor } from '../src/canvas/pinspace'

const ORG = 'alpha', KIND = 'doc'

/** A second Document of this realm with a hand-built Window, the pair a popped-out window is to the opener
 *  (presentfocus.test.tsx §7 explains why it cannot be a second JSDOM). 800 x 600 inside. */
function popoutWindow(): Window {
  const doc = document.implementation.createHTMLDocument('popout')
  const w = {
    document: doc, closed: false, innerWidth: 800, innerHeight: 600, devicePixelRatio: 1,
    focus() {}, close() { w.closed = true },
    addEventListener: () => {}, removeEventListener: () => {},
    MutationObserver: window.MutationObserver,
    getComputedStyle: (el: Element) => window.getComputedStyle(el),
    requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(0), 0) as unknown as number,
    cancelAnimationFrame: (id: number) => clearTimeout(id),
  }
  Object.defineProperty(doc, 'defaultView', { value: w, configurable: true })
  return w as unknown as Window
}

const reader = (close = () => {}) => (
  <CurrentOrg.Provider value={ORG}>
    <PinFrame kind={KIND} title="Presented documents" panel="settings rp-panel" close={close}>
      <p className="rp-body">the document</p>
    </PinFrame>
  </CurrentOrg.Provider>
)
const panelIn = (doc: Document) => doc.querySelector<HTMLElement>('.rp-panel')
const px = (v: string) => Number.parseFloat(v)

function clean(t: { after(fn: () => void | Promise<void>): void }, view: { unmount(): Promise<void> }) {
  t.after(async () => {
    await view.unmount()
    localStorage.clear(); forgetModalPins(); resetActionDocument()
  })
}

test('§1 control: pinned in the main window, the reader sits in the org\'s pin layer', async (t) => {
  localStorage.clear(); forgetModalPins(); resetActionDocument()
  const view = await mountView(reader(), () => null)
  clean(t, view)
  await flush()
  assert.ok(panelIn(document), 'the reader is open in the main window')
  assert.ok(!panelIn(document)!.parentElement!.classList.contains('overlay-pinned'))

  await inAct(() => pinModal(KIND, { x: 100, y: 80, w: 660, h: 520 }, ORG))
  await flush()
  const panel = panelIn(document)!
  assert.ok(panel.parentElement!.classList.contains('overlay-pinned'), 'dressed as a pinned window')
  assert.ok(pinLayerFor(ORG).contains(panel), 'and held by the org\'s pin layer, with the desks')
})

test('§2 opened from a popped-out window and pinned there, the reader stays in that window', async (t) => {
  localStorage.clear(); forgetModalPins()
  const child = popoutWindow()
  // the click on the presentation card happened in the popped-out desk's window
  noteActionDocument(child.document)
  const view = await mountView(reader(), () => null)
  clean(t, view)
  await flush()
  assert.ok(panelIn(child.document), 'control: the reader opens in the window the click came from')
  assert.equal(panelIn(document), null, 'control: and not in the main window')

  // a place that fits the main window (1024 x 768) and NOT the 800 x 600 popped-out one
  await inAct(() => pinModal(KIND, { x: 360, y: 240, w: 660, h: 520 }, ORG))
  await flush()
  const panel = panelIn(child.document)
  assert.ok(panel, 'the pinned reader is still in the popped-out window')
  assert.equal(panelIn(document), null, 'it did not move to the main window')
  assert.ok(!pinLayerFor(ORG).contains(panel), 'nor into the main window\'s pin layer')
  assert.ok(panel.parentElement!.classList.contains('overlay-pinned'), 'and it is dressed as a pinned window')
  assert.equal(child.document.querySelector('.rp-body')?.textContent, 'the document', 'with its content')

  // its box lies inside the window it is in
  const left = px(panel.style.left), top = px(panel.style.top), w = px(panel.style.width), h = px(panel.style.height)
  assert.ok(left >= 0 && top >= 0 && left + w <= 800 && top + h <= 600,
    `the pinned box is inside the 800 x 600 window: ${left},${top} ${w}x${h}`)
  // and the box it is positioned in is that window's own area, not the main window's canvas
  const overlay = panel.parentElement!
  assert.deepEqual([overlay.style.left, overlay.style.top, overlay.style.width, overlay.style.height],
    ['0px', '0px', '800px', '600px'])

  await inAct(() => unpinModal(KIND, ORG))
  await flush()
  assert.ok(panelIn(child.document), 'unpinned, it is still in the popped-out window')
  assert.ok(!panelIn(child.document)!.parentElement!.classList.contains('overlay-pinned'))
  assert.equal(panelIn(document), null)
})

test('§3 a reader that is already pinned opens, from a popped-out window, in that window', async (t) => {
  localStorage.clear(); forgetModalPins(); resetActionDocument()
  pinModal(KIND, { x: 100, y: 80, w: 660, h: 520 }, ORG)
  const child = popoutWindow()
  noteActionDocument(child.document)
  const view = await mountView(reader(), () => null)
  clean(t, view)
  await flush()
  const panel = panelIn(child.document)
  assert.ok(panel, 'it opens where the click was')
  assert.equal(panelIn(document), null)
  assert.ok(panel.parentElement!.classList.contains('overlay-pinned'))
})
