// popoutdrag.test.tsx — A POPPED-OUT MODAL IS A WINDOW, AND A WINDOW HAS A
// TITLE BAR TO MOVE IT BY.
//
// The user's report (2026-09-12): the popped-out Work Docket, Usage, Inbox and
// presented documents cannot be dragged at all, while a popped-out agent desk
// can. MEASURED in a real popped-out window (750×760, msedge, the real
// window.open path — tests/popoutdrag_probe.py): the modal's whole header was
// a 46×21 box in the top-right corner whose every pixel was an excluded
// control, because an UNPINNED `.modalpin-bar` is `margin-left: auto` — a
// button cluster tucked into the panel's padding — and the surface's name was
// rendered only while PINNED. A popped-out desk's header measured 884×24 and
// is a drag region, which is exactly why desks moved.
//
// WHAT THIS SUITE OWNS. The shared frame's CONTRACT in the detached state:
// which classes the panel and its bar take, that the bar carries the surface's
// name as the window's one heading, that the panel's own duplicate heading
// stands down, that the controls in the bar still take a real pointer press,
// and that the pinned mode is untouched. Every check is made against the real
// PinFrame driven through the real MovableSurface pop-out path — jsdom cannot
// open a native window, so `window.open` hands back a document in this same
// jsdom realm and everything after that (the adoption, the `.popout-mount`,
// the SurfaceContext) is the component's own code.
//
// WHAT IT CANNOT, AND WHO DOES. jsdom performs no layout and has no
// compositor, so neither the 46px-versus-full-width geometry nor
// `-webkit-app-region` means anything here. tests/popoutdrag_probe.py measures
// both in a real browser through the real pop-out, on the real Work Docket,
// Usage, Inbox and presented-document panels, with a popped-out desk as the
// passing control.
//
// Each check was watched fail (scratch/mutate-popoutdrag.py, run against this
// suite; the section each one reddens is in brackets):
//   no-bar-class          drop ' detached' from the bar's class      [§1]
//   no-detached-name      render `.modalpin-name` only when pinned   [§1 §2 §4]
//   no-panel-class        drop ' modalpin-detached' from the panel   [§2]
//   pinned-only-standdown put the stand-down rule back to `.modalpin-win`
//                         alone, so the panel says its name twice    [§2]
//   resize-when-detached  give a detached window the pinned window's in-page
//                         resize handles                             [§3]
//   glyph-when-detached   show the push-pin on a window that is not pinned [§4]
// ⚠ ONE HALF OF §3 IS NOT PROVABLE HERE. That the controls inside a drag
// region still take a click is a compositor property, not a DOM one; the
// mutation that proves it is in tests/popout-header-native.probe.ts, which
// deletes the no-drag exclusions in a real Electron window and watches every
// control get swallowed.
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs popoutdrag

import { flush, inAct, mountView as rawMountView } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { ReactNode } from 'react'
import { forgetModalOpenCache, forgetModalPins, pinModal, PinFrame } from '../src/canvas/modalpin'
import { CurrentOrg } from '../src/popout'

const noop = () => {}
const ORG = 'probe'
/** Every document this test's `window.open` has handed back. A popped-out
 *  surface is REALLY MOVED out of the main document — that is the whole point
 *  of MovableSurface — so a lookup that only ever asks `document` finds an
 *  empty tree and reads it as "nothing rendered". */
const popoutDocs: Document[] = []
const find = (q: string): HTMLElement | null => {
  for (const doc of [document, ...popoutDocs]) {
    const el = doc.querySelector<HTMLElement>(q)
    if (el) return el
  }
  return null
}
const all = (q: string): HTMLElement[] =>
  [document, ...popoutDocs].flatMap((doc) => [...doc.querySelectorAll<HTMLElement>(q)])
declare const __SRC_DIR__: string
const STYLES = readFileSync(path.join(__SRC_DIR__, 'styles.css'), 'utf8')

/** The window `window.open` hands back here.
 *
 *  ⚠ A SECOND jsdom INSTANCE WOULD NOT WORK: adopting a node between two
 *  realms is a type error, and the whole point of MovableSurface is that it
 *  moves the SAME element into the new document. So this is a document from
 *  THIS realm with the three methods a fresh `about:blank` needs stubbed —
 *  `document.write` has no browsing context to write to here, and what it
 *  writes (a standards-mode shell) is not what any assertion below reads. */
function fakeWindow() {
  const doc = document.implementation.createHTMLDocument('popout')
  Object.assign(doc, { open: () => doc, write: () => {}, close: () => {} })
  const listeners = new Map<string, Set<EventListener>>()
  const own: Record<string, unknown> = {
    document: doc, closed: false,
    screenX: 40, screenY: 60, outerWidth: 900, outerHeight: 760,
    innerWidth: 900, innerHeight: 760,
    addEventListener: (type: string, fn: EventListener) => {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type)!.add(fn)
    },
    removeEventListener: (type: string, fn: EventListener) => { listeners.get(type)?.delete(fn) },
    focus: noop,
    close() { own.closed = true },
    requestAnimationFrame: (fn: FrameRequestCallback) => { fn(0); return 1 },
    cancelAnimationFrame: noop,
  }
  // ⚠ EVERYTHING ELSE IS THE REAL WINDOW'S. A popped-out surface reaches for
  // its OWN window by name — `doc.defaultView.getComputedStyle`,
  // `new doc.defaultView.MutationObserver` (pinspace.ts) — so a stub that
  // lists only the members `popout.tsx` happens to touch fails as soon as a
  // surface measures itself, and it fails as a caught pop-out error, which
  // reads as "not detached" rather than as a broken rig.
  popoutDocs.push(doc)
  const w = new Proxy(own, {
    get(target, key) {
      if (key in target) return target[key as string]
      const value = (window as unknown as Record<string, unknown>)[key as string]
      return typeof value === 'function' ? value.bind(window) : value
    },
    has: () => true,
  })
  try { Object.defineProperty(doc, 'defaultView', { value: w, configurable: true }) } catch { /* read-only here is fine: PinFrame falls back to this window */ }
  return w as unknown as Window & { closed: boolean }
}

/** A real PinFrame over a panel shaped like the ones the user named: its own
 *  <h3> title, the way Usage, the Work Docket and the Inbox all open. */
async function mountSurface(panel: string, title: string, body?: ReactNode) {
  const canvas = document.createElement('div')
  canvas.dataset.pinOrg = ORG
  canvas.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0,
    width: window.innerWidth, height: window.innerHeight,
    right: window.innerWidth, bottom: window.innerHeight, toJSON() {} }) as DOMRect
  document.body.appendChild(canvas)
  const view = await rawMountView(
    <CurrentOrg.Provider value={ORG}>
      <PinFrame kind="usage" title={title} panel={panel} close={noop}>
        <h3>{title}</h3>
        {body}
      </PinFrame>
    </CurrentOrg.Provider>, (el) => el)
  await flush()
  return {
    view,
    async unmount() { await view.unmount(); canvas.remove() },
    /** the whole tree, wherever the surface has been adopted to */
    find, all,
  }
}

/** click the surface's own pop-out control and settle the adoption */
async function popOut() {
  const button = find('[aria-label="Open in new window"]')
  assert.ok(button, 'the surface must offer a pop-out control at all')
  await inAct(() => { button.click() })
  await flush()
  // A pop-out that FAILS is caught and returned home, so a broken rig reads
  // as "not detached" rather than as an error. Say so here instead.
  assert.equal(find('.popout-error'), null, 'the pop-out itself must have succeeded')
  assert.ok(all('.popout-mount').length, 'the surface must really be in a popped-out document')
}

function pointer(type: string, x: number, y: number): Event {
  const Ctor = (globalThis as unknown as { window: { PointerEvent: typeof PointerEvent } }).window.PointerEvent
  return new Ctor(type, { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse',
    isPrimary: true, button: type === 'pointermove' ? -1 : 0, buttons: 1, clientX: x, clientY: y })
}

function stubPointerCapture(): () => void {
  const proto = (globalThis as unknown as { HTMLElement: { prototype: Record<string, unknown> } }).HTMLElement.prototype
  const had = { s: proto.setPointerCapture, r: proto.releasePointerCapture }
  proto.setPointerCapture = noop
  proto.releasePointerCapture = noop
  return () => { proto.setPointerCapture = had.s; proto.releasePointerCapture = had.r }
}

/** press, move and release across an element, as a pointer really does */
async function drag(el: Element, from: [number, number], to: [number, number]) {
  await inAct(() => {
    el.dispatchEvent(pointer('pointerdown', from[0], from[1]))
    el.dispatchEvent(pointer('pointermove', to[0], to[1]))
    el.dispatchEvent(pointer('pointerup', to[0], to[1]))
  })
  await flush()
}

function withOpener(t: TestContext) {
  const real = window.open
  // MovableSurface keeps the child window's stylesheets in step with this
  // one's through a MutationObserver. The harness installs jsdom's DOM
  // globals by name and that is not one of them, so the pop-out would fail
  // with `MutationObserver is not defined` and return the surface home —
  // a green test measuring a surface that never left.
  const g = globalThis as unknown as Record<string, unknown>
  const hadObserver = g.MutationObserver
  g.MutationObserver = (window as unknown as Record<string, unknown>).MutationObserver
  const opened: ReturnType<typeof fakeWindow>[] = []
  window.open = ((_url?: unknown, _name?: unknown, _features?: unknown) => {
    const w = fakeWindow(); opened.push(w)
    return w as unknown as Window
  }) as typeof window.open
  const release = stubPointerCapture()
  popoutDocs.length = 0
  t.after(() => {
    window.open = real
    if (hadObserver === undefined) delete g.MutationObserver
    else g.MutationObserver = hadObserver
    release()
    popoutDocs.length = 0
    localStorage.clear(); forgetModalPins(); forgetModalOpenCache()
  })
  return opened
}

test('§1 a detached surface takes the title bar a pinned one has', async (t: TestContext) => {
  withOpener(t)
  const s = await mountSurface('settings usage-modal', 'Usage')
  t.after(() => s.unmount())

  // before: a centred modal's bar is chrome only, and carries no name
  assert.equal(s.find('.modalpin-bar.detached'), null, 'nothing is detached yet')
  assert.equal(s.find('.modalpin-name'), null, 'a centred modal names itself in its own heading')

  await popOut()

  const bar = s.find('.modalpin-bar')
  assert.ok(bar, 'the bar must survive the move into the new window')
  assert.ok(bar.classList.contains('detached'),
    `the bar must say it is a detached window's title bar (${bar.className})`)
  assert.ok(bar.closest('.popout-mount'),
    'and it must really be inside the popped-out document, which is what the drag-region rule is scoped to')
  const name = bar.querySelector('.modalpin-name')
  assert.ok(name, 'the window must name itself in its title bar')
  assert.equal(name.textContent, 'Usage')
  assert.equal(name.getAttribute('role'), 'heading', 'and it is the window\'s heading, not decoration')
  assert.equal(name.getAttribute('aria-level'), '3')
  // the whole point: something to grab that is not a control
  assert.ok(bar.querySelector('.spacer'), 'the bar keeps the flexible span between name and controls')

  // THE CSS THAT MAKES IT A DRAG REGION MUST REACH THIS ELEMENT. A rule that
  // matches nothing is the way this defect hid for a week (the height of the
  // agents window, 2026-09-12), so the selector is met against the element.
  assert.ok(STYLES.includes('.popout-mount :where(.cc-head-top, .modalpin-bar)'),
    'the popout drag-region rule must still exist')
  assert.ok(bar.matches('.popout-mount .modalpin-bar'),
    'and the real bar must be what it selects')
})

test('§2 one title, not two: the panel\'s own heading stands down', async (t: TestContext) => {
  withOpener(t)
  const s = await mountSurface('settings wide docket-modal', 'Work docket')
  t.after(() => s.unmount())

  const h3 = s.find('.docket-modal h3')
  assert.ok(h3, 'the panel opens with its own title heading')
  assert.ok(!h3.matches('.modalpin-win > h3:first-of-type, .modalpin-detached > h3:first-of-type'),
    'centred, that heading is the only title and stays')

  await popOut()

  const panel = s.find('.docket-modal')
  assert.ok(panel?.classList.contains('modalpin-detached'),
    `the panel must say it is in a window of its own (${panel?.className})`)
  const rule = ':is(.modalpin-win, .modalpin-detached) > h3:first-of-type'
  assert.ok(STYLES.includes(rule + ' { display: none; }'),
    'the stand-down rule must name both window modes')
  assert.ok(s.find('.docket-modal h3')!.matches(rule),
    'and it must match the real panel\'s own heading, or the window says its name twice')
  assert.equal(s.all('.modalpin-name').length, 1, 'exactly one title bar heading')
})

test('§3 the title bar is inert to the pointer; its controls are not', async (t: TestContext) => {
  withOpener(t)
  const s = await mountSurface('settings usage-modal', 'Usage')
  t.after(() => s.unmount())
  await popOut()

  const panel = s.find('.usage-modal')!
  const bar = s.find('.modalpin-bar')!
  const before = panel.getAttribute('style') ?? ''
  await drag(bar, [200, 12], [420, 260])
  assert.equal(panel.getAttribute('style') ?? '', before,
    'a detached window is moved by the native drag region, so no pointer gesture may resize or reposition the panel')
  assert.equal(s.all('.modalpin-resize-frame').length, 0,
    'and it grows no in-page resize handles: the window edges are the OS\'s')

  // the controls inside the drag region keep their ordinary behaviour
  const pin = bar.querySelector('[aria-label="pin this to the window"]') as HTMLButtonElement
  assert.ok(pin, 'the pin control is still in the bar')
  assert.equal(pin.disabled, true, 'pinning a window that is already its own window is not offered')
  const back = bar.querySelector('[aria-label="Return to main window"]') as HTMLElement
  assert.ok(back, 'and the return control, which must still take a press')
  await inAct(() => {
    back.dispatchEvent(pointer('pointerdown', 700, 12))
    back.click()
  })
  await flush()
  assert.equal(s.find('.modalpin-bar')!.classList.contains('detached'), false,
    'pressing Return to main window really returned it — the control was not swallowed')
})

test('§4 pinned is untouched: its glyph, its handles and its drag still answer', async (t: TestContext) => {
  withOpener(t)
  const s = await mountSurface('settings usage-modal', 'Usage')
  t.after(() => s.unmount())

  await inAct(() => { pinModal('usage', { x: 100, y: 80, w: 400, h: 300 }, ORG) })
  await flush()
  const panel = s.find('.usage-modal')!
  assert.ok(panel.classList.contains('modalpin-win'), 'pinned keeps its own class')
  assert.ok(!panel.classList.contains('modalpin-detached'), 'and is not detached')
  assert.ok(s.find('.modalpin-glyph'), 'a pinned window shows the push-pin')
  assert.equal(s.find('.modalpin-name')!.textContent, 'Usage')
  assert.ok(s.find('.modalpin-resize-frame'), 'and keeps its eight resize handles')

  const bar = s.find('.modalpin-bar')!
  assert.ok(bar.classList.contains('on'), 'the pinned bar is the pinned bar')
  const before = panel.getAttribute('style')
  await drag(bar, [150, 90], [250, 190])
  const after = panel.getAttribute('style')
  assert.notEqual(after, before,
    'POSITIVE CONTROL: the same pointer sequence that must do nothing detached must still move a PINNED window, or §3 proves nothing')
  assert.match(after ?? '', /left:\s*200px/, 'and it moves by the pointer delta')

  // ...and the push-pin belongs to that mode alone
  await popOut()
  assert.equal(s.find('.modalpin-glyph'), null,
    'a window of its own is not pinned to anything, so it shows no push-pin')
  assert.ok(s.find('.modalpin-name'), 'it still names itself')
})
