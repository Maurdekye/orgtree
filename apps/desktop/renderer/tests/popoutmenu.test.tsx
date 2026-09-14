// popoutmenu.test.tsx — WHICH WINDOW A CONTEXT MENU OPENS IN.
//
// The user reported (ticket position-context-menus-in-the-originating-popout):
// right-click a modal that has been popped out and dragged away from the main
// Orgtree window, and its menu appears on the MAIN CANVAS, at an offset nobody
// pointed at.
//
// THE SHAPE OF THE DEFECT. Orgtree is one renderer with many documents — a
// popout is a native window whose about:blank document is adopted by the main
// window, so its React handlers run in the main window's realm. `useContextMenu`
// used to pick its destination with `useSurfaceDocument()`, which answers from
// REACT CONTEXT at whichever component holds the menu state. That component is
// often OUTSIDE the `MovableSurface` that makes the window: `DocGalleryModal`
// calls `useContextMenu` and then renders the `PinFrame` that creates the
// surface. The menu portaled into the MAIN document while `clientX/clientY`
// were measured in the POPOUT's viewport — two windows' coordinate spaces
// crossed, which is exactly "on the main canvas, far from the pointer".
//
// The fix routes by the ELEMENT THAT WAS PRESSED (`anchor.ownerDocument`), so
// every test here is written against that question and not against a
// call-site's tree position:
//
//   §1  the reported surface, for real: the org gallery popped out, its row
//       menu in the CHILD document and nowhere else (this fails on the build
//       before the fix — the menu lands in the main document);
//   §2  the owner-above-the-surface shape on a fixture, with the negative
//       control that the main document stays empty;
//   §3  where the window SITS ON THE DESKTOP changes nothing: the same press
//       at the same client point lands at the same place with the popout on
//       another monitor, because no screen-space arithmetic happens at all;
//   §4  display scaling / mixed DPI: the viewport clamp reads the ORIGIN
//       window's own `innerWidth/innerHeight`, and a devicePixelRatio of 1.5
//       moves nothing — CSS pixels never leave the window they were measured
//       in, so there is no conversion to get wrong;
//   §5  TWO popouts at once, each routed to its own window, neither leaking
//       into the other or into the main one;
//   §6  the main window is unchanged — same document, same pointer placement,
//       same Escape;
//   §7  a closed origin fails safely: no menu is opened in a window that has
//       gone, and a popout that closes while its menu is up takes the menu
//       with it instead of stranding it on the main canvas.
//
// ⚠ THE NEGATIVES NEED THE POSITIVES. Most assertions here say a menu is NOT
// in the main document, and every one of them would pass against a build where
// no menu opened at all. Each section asserts the menu really opened, in the
// window it belongs to, first.
//
// Under jsdom every box is 0×0; §4 stubs a size on the CHILD window's own
// prototype for its own duration, because that is the realm the menu is in.
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs popoutmenu

import { advance, flush, inAct, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import type { ReactNode } from 'react'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { useContextMenu } from '../src/canvas/contextmenu'
import { PinFrame, forgetModalOpenCache, forgetModalPins } from '../src/canvas/modalpin'
import { DocGalleryModal } from '../src/canvas/gallery'
import { CurrentOrg } from '../src/popout'
import { WINDOW_LAYOUT_KEY } from '../src/windowlayout'
import { resetActionDocument } from '../src/windowlife'

const noop = () => {}
const MAIN = window as unknown as Window & typeof globalThis

/** Every test here drives a real surface into a real second window, and
 *  MovableSurface's adoption and teardown both run on timers — the same mocked
 *  clock every other popout suite uses.
 *
 *  ⚠ TEARDOWN RUNS INSIDE THE CLOCK, not in `t.after`. Sending a popout home
 *  needs that clock as much as opening it did, and node runs `after` hooks
 *  only once the test body has returned — by which time this `finally` has put
 *  the real timers back. So `tidy` queues here instead. */
const winding: (() => Promise<void>)[] = []
function uiTest(name: string, body: (t: TestContext) => Promise<void>) {
  test(name, async (t: TestContext) => {
    useFakeClock()
    winding.length = 0
    try {
      await body(t)
    } finally {
      for (const down of winding.splice(0).reverse()) {
        try { await down() } catch { /* the window is already gone */ }
      }
      realClock()
    }
  })
}

/** ⚠ jsdom gives every box 0×0, and `open` reads an UNMEASURED anchor as the
 *  keyboard case: it then anchors at the box (0,0) instead of at the pointer,
 *  and every placement assertion in this file would be testing that path
 *  rather than the one the ticket is about. So the object is given a box that
 *  contains the whole viewport and the press counts as inside it. */
function spanning(el: Element): () => void {
  const had = el.getBoundingClientRect
  el.getBoundingClientRect = () => ({ left: 0, top: 0, right: 4000, bottom: 4000,
    width: 4000, height: 4000, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
  return () => { el.getBoundingClientRect = had }
}

// --------------------------------------------------------------- the windows

interface Child {
  dom: JSDOM
  window: Window & typeof globalThis
  doc: Document
  /** how many times the app closed this window */
  closes: number
  /** really tear the jsdom down, once nothing can be looking at it again */
  hardClose: () => void
}

/** A real second document to be the popped-out window, exactly as
 *  closemenu.test.tsx and agentrowmenu.test.tsx stub one. `window.open` hands
 *  them out in order, so a test that pops out twice gets two distinct windows
 *  and can tell which menu went where. */
function stubPopoutWindows(t: TestContext, count = 1): Child[] {
  const children: Child[] = []
  for (let i = 0; i < count; i++) {
    const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>',
      { url: 'http://localhost/' })
    const w = dom.window as unknown as Window & typeof globalThis
    const realClose = w.close.bind(w)
    const child: Child = { dom, window: w, doc: dom.window.document, closes: 0,
      hardClose: () => { try { realClose() } catch { /* already gone */ } } }
    const mut = w as unknown as Record<string, unknown>
    mut.focus = noop
    mut.requestAnimationFrame = () => 1
    mut.cancelAnimationFrame = noop
    // ⚠ CLOSING MARKS THE WINDOW GONE; IT DOES NOT DEMOLISH THE DOCUMENT.
    // That is Electron's shape, and the shape this ticket is about: the popout
    // is a document the MAIN renderer holds a reference to, so when the native
    // window goes the window object reports `closed` while the document object
    // is still reachable from the opener's heap — MovableSurface relies on
    // exactly that to move a surface home after `pagehide`. jsdom's own
    // `close()` instead destroys the document outright, which no renderer does
    // and which would only be testing jsdom. The real teardown is `hardClose`,
    // at the end of the test when nothing can look at it again.
    mut.close = () => {
      child.closes += 1
      Object.defineProperty(w, 'closed', { configurable: true, get: () => true })
    }
    children.push(child)
  }
  const hadOpen = window.open
  const hadObserver = globalThis.MutationObserver
  let next = 0
  window.open = (() => children[Math.min(next++, children.length - 1)]!.window) as typeof window.open
  // the surface's style mirror observes the MAIN head with the child's
  // constructor, the way every other popout suite does
  globalThis.MutationObserver = children[0]!.dom.window.MutationObserver
  t.after(() => {
    window.open = hadOpen
    globalThis.MutationObserver = hadObserver
    for (const c of children) c.hardClose()
    localStorage.removeItem(WINDOW_LAYOUT_KEY)
    forgetModalPins(); forgetModalOpenCache()
    // a press inside a popout makes that document the "initiating" one for the
    // next surface to open in (windowlife.ts). Left set, the NEXT test's
    // surface mounts into a window this one already closed.
    resetActionDocument()
  })
  return children
}

/** A press outside the menu, in the window the menu is in — the app's own
 *  dismissal, used here as teardown.
 *
 *  ⚠ WHY TEARDOWN NEEDS IT. Unmounting React while a menu is still portaled
 *  into a popout is not what this file is about, and jsdom cannot express it:
 *  MovableSurface closes the native window in the same commit that removes the
 *  portal, and the removal then happens against a document jsdom has already
 *  torn down. The real close-while-open path is §7b's subject, driven through
 *  the signal the app actually gets (`pagehide`). */
async function dismissMenus(...docs: Document[]): Promise<void> {
  for (const doc of docs) {
    if (!doc.querySelector('.ctxmenu')) continue
    const view = doc.defaultView as unknown as { MouseEvent: typeof MouseEvent } | null
    if (!view) continue
    await inAct(() => {
      doc.body.dispatchEvent(new view.MouseEvent('pointerdown', { bubbles: true }))
    })
    await flush(2)
  }
}

/** Close a popout the way the user does, then let the app notice: the window
 *  reports `closed` and `pagehide` is the signal MovableSurface redocks on. */
async function closePopout(child: Child): Promise<void> {
  if (child.window.closed) return
  const view = child.doc.defaultView as unknown as { Event: typeof Event } | null
  child.window.close()
  if (view) await inAct(() => { child.window.dispatchEvent(new view.Event('pagehide')) })
  await advance(400, 50); await flush(8)
}

/** Mount teardown, in the order the app itself would reach it: menus away,
 *  windows closed, then React down.
 *
 *  ⚠ NONE OF THIS IS PAPERING OVER THE TICKET — the close-while-a-menu-is-open
 *  path is §7b's subject and is driven there through the signal the app really
 *  receives. This is only teardown, and the unmount is guarded the way
 *  agentstray.test.tsx guards its own: React coming down on top of a live
 *  second document is a jsdom property, not an app one. */
function tidy(_t: TestContext, v: { unmount: () => Promise<void> }, ...children: Child[]): void {
  winding.push(async () => {
    for (const c of children) { try { await closePopout(c) } catch { /* already gone */ } }
    await dismissMenus(document)
    try { await v.unmount() } catch { /* the popped-out document is already down */ }
  })
}

/** Right-click as the browser dispatches it, IN THE ELEMENT'S OWN REALM: the
 *  MouseEvent constructor has to come from the document the element lives in,
 *  or jsdom refuses it — which is the whole subject of this file in miniature. */
async function rightClick(el: Element, at: { x: number; y: number }): Promise<boolean> {
  const view = el.ownerDocument.defaultView as unknown as { MouseEvent: typeof MouseEvent }
  const ev = new view.MouseEvent('contextmenu',
    { bubbles: true, cancelable: true, button: 2, clientX: at.x, clientY: at.y })
  await inAct(() => { el.dispatchEvent(ev) })
  await flush(3)
  return ev.defaultPrevented
}

const menuIn = (doc: Document) => doc.querySelector('.ctxmenu') as HTMLElement | null
const labelsIn = (doc: Document) => [...doc.querySelectorAll('.ctxmenu [role="menuitem"]')]
  .map((b) => b.textContent ?? '')
const at = (m: HTMLElement | null) => m && [m.style.left, m.style.top]

/** Pop a mounted surface out, and hand back the panel as it now sits in the
 *  child window. Asserts the move happened: every negative below depends on it. */
async function popOut(el: HTMLElement, child: Child, panelSelector: string): Promise<HTMLElement> {
  const button = el.querySelector<HTMLButtonElement>('[aria-label="Open in new window"]')
  assert.ok(button, 'POSITIVE CONTROL: the surface offers its popout button')
  await inAct(() => { button!.click() })
  await advance(600, 30); await flush(10)
  const moved = child.doc.querySelector(panelSelector) as HTMLElement | null
  assert.ok(moved, `POSITIVE CONTROL: ${panelSelector} really moved into the opened window`)
  assert.equal(document.querySelector(panelSelector), null,
    'POSITIVE CONTROL: and it is no longer in the main document')
  return moved!
}

// ------------------------------------------------------------- the fixture
//
// THE SHAPE THE DEFECT LIVES IN, kept deliberately: the menu handle is created
// ABOVE the surface — `useContextMenu()` here, `PinFrame` (and therefore
// `MovableSurface`) below — which is what DocGalleryModal, and any future
// panel written the same obvious way, does. A fixture whose hook sat inside the
// surface would pass on the broken build and prove nothing.

function OwnerAboveSurface({ kind, name }: { kind: string; name: string }) {
  const menu = useContextMenu()
  return <>
    <PinFrame kind={kind} title={name} panel="settings" close={noop}>
      <div className={`probe ${kind}`} data-name={name}
        onContextMenu={(e) => menu.open(e, [{ label: `Act on ${name}`, onSelect: noop }])}>
        {name}
      </div>
    </PinFrame>
    {menu.node}
  </>
}

const inOrg = (children: ReactNode) =>
  <CurrentOrg.Provider value="org">{children}</CurrentOrg.Provider>

// --------------------------------------------- §1 the surface that was reported

uiTest('§1 the org gallery popped out: a row menu opens in THAT window, never on the main canvas', async (t) => {
  const child = stubPopoutWindows(t)[0]!
  const docs = [
    { id: 'd1', node: 'me', title: 'First plan', at: '2026-09-07T10:00:00Z', evicted: false, node_state: 'live', tier: 'haiku' },
    { id: 'd2', node: 'you', title: 'Second plan', at: '2026-09-07T09:00:00Z', evicted: false, node_state: 'live', tier: 'haiku' },
  ]
  const g = globalThis as unknown as { fetch?: typeof fetch }
  const had = g.fetch
  g.fetch = ((url: string, init?: RequestInit) => {
    const path = String(url), method = init?.method ?? 'GET'
    const one = path.match(/\/documents\/([^/?]+)$/)
    const body = method !== 'GET' ? {}
      : one ? { ...docs.find((d) => d.id === one[1]!), body: 'body' }
        : { documents: docs, total: docs.length }
    return Promise.resolve({ ok: true, status: 200, headers: new Headers(),
      json: () => Promise.resolve(body) })
  }) as unknown as typeof fetch
  t.after(() => { g.fetch = had })

  const v = await mountView(
    inOrg(<DocGalleryModal slug="org" toast={noop} close={noop} />), (h) => h)
  tidy(t, v, child)
  await flush(); await advance(200, 16); await flush()
  assert.equal(v.el.querySelectorAll('.doc-gallery-row').length, 2,
    'POSITIVE CONTROL: the gallery listed both cards in the main window first')

  await popOut(v.el, child, '.gallery-modal')
  const row = child.doc.querySelector('.doc-gallery-row') as HTMLElement
  assert.ok(row, 'POSITIVE CONTROL: the rows came with the panel')
  t.after(spanning(row))

  const took = await rightClick(row, { x: 260, y: 180 })
  assert.equal(took, true, 'the app took the event, as it does in the main window')

  const menu = menuIn(child.doc)
  assert.ok(menu, 'the menu opened IN THE POPPED-OUT WINDOW')
  assert.equal(menu!.parentElement, child.doc.body, "in that window's own body")
  assert.deepEqual(at(menu), ['260px', '180px'], 'at the pointer, in that window')
  assert.deepEqual(labelsIn(child.doc),
    ['Open', 'Copy title', 'Copy reference', 'Download as Markdown', 'Dismiss'],
    'and it is the row\'s real menu, not a stub')
  // the reported symptom, stated as an assertion
  assert.equal(menuIn(document), null,
    'NOTHING was drawn on the main canvas — this is the reported defect')
})

// ------------------------------------------------- §2 the owner-above shape

uiTest('§2 a menu whose handle lives above the surface still opens in the surface\'s window', async (t) => {
  const child = stubPopoutWindows(t)[0]!
  const v = await mountView(inOrg(<OwnerAboveSurface kind="probe-a" name="Alpha" />), (h) => h)
  tidy(t, v, child)
  assert.ok(v.el.querySelector('.probe'), 'POSITIVE CONTROL: the surface mounted centred first')

  await popOut(v.el, child, '.probe')
  const probe = child.doc.querySelector('.probe') as HTMLElement
  t.after(spanning(probe))
  await rightClick(probe, { x: 120, y: 90 })

  assert.deepEqual(labelsIn(child.doc), ['Act on Alpha'], 'the menu is in the child window')
  assert.deepEqual(at(menuIn(child.doc)), ['120px', '90px'], 'at the pointer it was raised from')
  assert.equal(menuIn(document), null, 'and the main window got nothing')
})

// -------------------------------------- §3 where the window sits on the desktop

uiTest('§3 moving the popout away — another corner of the desktop, another monitor — '
  + 'does not shift the menu: nothing reads screen space', async (t) => {
  const child = stubPopoutWindows(t)[0]!
  const v = await mountView(inOrg(<OwnerAboveSurface kind="probe-b" name="Beta" />), (h) => h)
  tidy(t, v, child)
  await popOut(v.el, child, '.probe')
  const probe = child.doc.querySelector('.probe') as HTMLElement
  t.after(spanning(probe))

  /** the popout parked somewhere on the desktop; the main window elsewhere */
  const place = (w: Window, x: number, y: number) => {
    for (const [k, val] of [['screenX', x], ['screenY', y], ['screenLeft', x], ['screenTop', y]] as const) {
      Object.defineProperty(w, k, { configurable: true, get: () => val })
    }
  }
  place(MAIN, 0, 0)

  // beside the main window
  place(child.window, 1100, 60)
  await rightClick(probe, { x: 200, y: 140 })
  const near = at(menuIn(child.doc))
  assert.deepEqual(near, ['200px', '140px'], 'POSITIVE CONTROL: placed at the pointer')
  await inAct(() => { child.doc.body.dispatchEvent(new (child.window as unknown as
    { MouseEvent: typeof MouseEvent }).MouseEvent('pointerdown', { bubbles: true })) })
  await flush(2)
  assert.equal(menuIn(child.doc), null, 'POSITIVE CONTROL: dismissed before the second press')

  // dragged far away, onto a second monitor left of and above the primary
  place(child.window, -1920, -320)
  await rightClick(probe, { x: 200, y: 140 })
  assert.deepEqual(at(menuIn(child.doc)), near,
    'the same client point is the same place — the desktop position is not in the sum')
  assert.equal(menuIn(document), null, 'and it never drifts toward the main canvas')
})

// ------------------------------------------------------- §4 scaling / mixed DPI

uiTest('§4 the viewport clamp reads the ORIGIN window, and a scaled display converts nothing', async (t) => {
  const child = stubPopoutWindows(t)[0]!
  // a popout that is NOT the shape of the main window, on a 150% display
  const size = (w: Window, width: number, height: number, dpr: number) => {
    Object.defineProperty(w, 'innerWidth', { configurable: true, get: () => width })
    Object.defineProperty(w, 'innerHeight', { configurable: true, get: () => height })
    Object.defineProperty(w, 'devicePixelRatio', { configurable: true, get: () => dpr })
  }
  size(child.window, 480, 320, 1.5)
  assert.equal(MAIN.innerWidth, 1024, 'POSITIVE CONTROL: the main window is a different size')
  assert.equal(MAIN.innerHeight, 768)

  // a 200×100 menu, measured in the CHILD's realm — the one it is rendered in
  const proto = child.window.HTMLElement.prototype
  const hadW = Object.getOwnPropertyDescriptor(proto, 'offsetWidth')
  const hadH = Object.getOwnPropertyDescriptor(proto, 'offsetHeight')
  Object.defineProperty(proto, 'offsetWidth', { configurable: true,
    get(this: HTMLElement) { return this.classList.contains('ctxmenu') ? 200 : 0 } })
  Object.defineProperty(proto, 'offsetHeight', { configurable: true,
    get(this: HTMLElement) { return this.classList.contains('ctxmenu') ? 100 : 0 } })
  t.after(() => {
    if (hadW) Object.defineProperty(proto, 'offsetWidth', hadW)
    if (hadH) Object.defineProperty(proto, 'offsetHeight', hadH)
  })

  const child2 = child
  const v = await mountView(inOrg(<OwnerAboveSurface kind="probe-c" name="Gamma" />), (h) => h)
  tidy(t, v, child)
  await popOut(v.el, child2, '.probe')
  const probe = child2.doc.querySelector('.probe') as HTMLElement
  t.after(spanning(probe))

  // a press that fits in the popout: untouched, and NOT multiplied by 1.5
  await rightClick(probe, { x: 100, y: 60 })
  assert.deepEqual(at(menuIn(child2.doc)), ['100px', '60px'],
    'CSS pixels are passed through — a 150% display is not a factor here')
  await inAct(() => { child2.doc.body.dispatchEvent(new (child2.window as unknown as
    { MouseEvent: typeof MouseEvent }).MouseEvent('pointerdown', { bubbles: true })) })
  await flush(2)

  // a press near the popout's own bottom-right: clamped to 480×320, and the
  // main window's 1024×768 — which the old code would have clamped against —
  // would have left both numbers exactly where they were pressed
  await rightClick(probe, { x: 470, y: 310 })
  assert.deepEqual(at(menuIn(child2.doc)), [`${480 - 200 - 4}px`, `${320 - 100 - 4}px`],
    "clamped into the POPOUT's viewport, not the main window's")
  assert.equal(menuIn(document), null, 'and still nothing on the main canvas')
})

// --------------------------------------------------------- §5 two popouts

uiTest('§5 two popouts at once: each right-click routes to its own window and no other', async (t) => {
  const [first, second] = stubPopoutWindows(t, 2) as [Child, Child]
  const a = await mountView(inOrg(<OwnerAboveSurface kind="probe-one" name="One" />), (h) => h)
  tidy(t, a, first, second)
  const b = await mountView(inOrg(<OwnerAboveSurface kind="probe-two" name="Two" />), (h) => h)
  tidy(t, b, first, second)

  await popOut(a.el, first, '.probe-one')
  await popOut(b.el, second, '.probe-two')
  const one = first.doc.querySelector('.probe-one') as HTMLElement
  const two = second.doc.querySelector('.probe-two') as HTMLElement
  assert.ok(one && two, 'POSITIVE CONTROL: two surfaces, two windows')
  t.after(spanning(one)); t.after(spanning(two))

  await rightClick(one, { x: 30, y: 40 })
  assert.deepEqual(labelsIn(first.doc), ['Act on One'], "the first window got its own surface's menu")
  assert.deepEqual(at(menuIn(first.doc)), ['30px', '40px'])
  assert.equal(menuIn(second.doc), null, 'the OTHER popout was not written into')
  assert.equal(menuIn(document), null, 'nor the main window')

  await rightClick(two, { x: 210, y: 15 })
  assert.deepEqual(labelsIn(second.doc), ['Act on Two'], 'the second window got its own')
  assert.deepEqual(at(menuIn(second.doc)), ['210px', '15px'])
  assert.equal(menuIn(document), null, 'and still nothing on the main canvas')
  // the first window's menu is its own business: a press in the second window
  // is not a press in the first, so it stays exactly where it was
  assert.deepEqual(labelsIn(first.doc), ['Act on One'],
    'the two menus do not share state or a destination')
})

// ------------------------------------------------------ §6 the main window

uiTest('§6 a main-window menu is unchanged: same document, same pointer, same Escape', async (t) => {
  stubPopoutWindows(t)   // available, deliberately never used
  const v = await mountView(inOrg(<OwnerAboveSurface kind="probe-main" name="Home" />), (h) => h)
  tidy(t, v)
  const probe = v.el.querySelector('.probe') as HTMLElement
  t.after(spanning(probe))
  assert.equal(probe.ownerDocument, document, 'POSITIVE CONTROL: still centred in the main window')

  const took = await rightClick(probe, { x: 55, y: 25 })
  assert.equal(took, true, 'the browser menu is suppressed, as before')
  const menu = menuIn(document)
  assert.ok(menu, 'the menu is in the main document')
  assert.equal(menu!.parentElement, document.body, 'in its body, outside the object subtree')
  assert.deepEqual(at(menu), ['55px', '25px'], 'at the pointer')
  assert.deepEqual(labelsIn(document), ['Act on Home'])

  await inAct(() => {
    document.body.dispatchEvent(new MAIN.KeyboardEvent('keydown',
      { key: 'Escape', bubbles: true, cancelable: true }))
  })
  await flush(2)
  assert.equal(menuIn(document), null, 'Escape still closes it')
  assert.ok(v.el.querySelector('.probe'), 'and closed the MENU only — the surface is still up')
})

// ------------------------------------------------------- §7 a closed origin

uiTest('§7a a right-click in a window that has already gone opens no menu, anywhere', async (t) => {
  const child = stubPopoutWindows(t)[0]!
  const v = await mountView(inOrg(<OwnerAboveSurface kind="probe-d" name="Delta" />), (h) => h)
  tidy(t, v, child)
  await popOut(v.el, child, '.probe')
  const probe = child.doc.querySelector('.probe') as HTMLElement
  t.after(spanning(probe))

  await rightClick(probe, { x: 70, y: 70 })
  assert.ok(menuIn(child.doc), 'POSITIVE CONTROL: it opens there while the window is alive')
  await inAct(() => { child.doc.body.dispatchEvent(new (child.window as unknown as
    { MouseEvent: typeof MouseEvent }).MouseEvent('pointerdown', { bubbles: true })) })
  await flush(2)

  // the window goes, and a stale request arrives against the element that was
  // in it — the in-flight case the ticket names
  child.window.close()
  await rightClick(probe, { x: 70, y: 70 })
  assert.equal(menuIn(child.doc), null, 'no menu in the window that is gone')
  assert.equal(menuIn(document), null,
    'and — the point — none on the main canvas instead: a dead origin opens NOTHING')
})

uiTest('§7b a popout that closes while its menu is up takes the menu with it', async (t) => {
  const child = stubPopoutWindows(t)[0]!
  const v = await mountView(inOrg(<OwnerAboveSurface kind="probe-e" name="Epsilon" />), (h) => h)
  tidy(t, v, child)
  await popOut(v.el, child, '.probe')
  const probe = child.doc.querySelector('.probe') as HTMLElement
  t.after(spanning(probe))

  await rightClick(probe, { x: 44, y: 33 })
  assert.ok(menuIn(child.doc), 'POSITIVE CONTROL: the menu is up in the popout')

  // the user closes the native window — `pagehide` is the same signal
  // MovableSurface itself redocks on
  await inAct(() => {
    child.window.dispatchEvent(new (child.window as unknown as
      { Event: typeof Event }).Event('pagehide'))
  })
  await advance(400, 50); await flush(10)

  assert.equal(menuIn(document), null,
    'the menu did not follow the surface home and reopen on the main canvas')
  assert.equal(menuIn(child.doc), null, 'and it is not left behind in the departed window')
  assert.ok(v.el.querySelector('.probe') ?? document.querySelector('.probe'),
    'POSITIVE CONTROL: the surface itself did come back — only the menu went')
})
