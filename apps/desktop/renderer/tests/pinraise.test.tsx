// pinraise.test.tsx — CLICKING A PINNED DESK BRINGS IT FORWARD, including when
// the click lands on the desk's own content.
//
// The user's report, on the installed 2.0.5 build (2026-09-11): the pinned
// "usage limits" window stayed in front of a pinned desk however often the desk
// was clicked, while DRAGGING or RESIZING the desk did bring it forward. The
// cause was a phase, not a z-index: `.pinwin` raised on a BUBBLE-phase
// `onPointerDown`, and the desk body (desk.tsx) stops that pointerdown's React
// propagation for every target inside
//     button, input, textarea, select, a, label, .msgs, .mailrow, .eff-pop
// — its canvas-pan rule, and very nearly everything a reader actually clicks.
// The raise never ran. modalpin.tsx already raised from CAPTURE, which is
// exactly why pinned modals always came forward and pinned desks did not.
//
// WHAT MAKES THIS SUITE DIFFERENT FROM THE PIN SUITES NEXT DOOR. The stacking
// checks in `pinspace.test.tsx` and `tests/pinspace-native.probe.ts` model a
// pinned desk as a plain `<div className="pinwin">` carrying its own
// `onPointerDown`. That stand-in has no desk body, so it has no wall to stop
// the event, and it passes whichever phase the production handler uses. This
// file mounts the REAL PinLayer -> PinWindow -> DeskChat, and presses on the
// real `.msgs` transcript, which is the element the wall actually matches.
//
// Watched fail — eight mutations of pins.tsx, and which checks caught each:
//   raise back on the bubble phase (the shipped defect)  §1 §2 §3 §5
//   the capture-phase raise deleted outright             §1 §2 §3 §5
//   the keyboard-only click leg deleted                  §4 alone
//   that leg ungated, so a mouse press raises twice      §2 §5
//   the redundant second registry bump restored          §2 §5 §6
//   `raise()` put back inside `begin()`                  §5 §6
//   the sibling resize frame's own capture raise gone    §6 alone
//   raise made a no-op                                   all six
// §4 and §6 are each the only catcher of one mutation, and no check here is
// idle. The harness that drives this lives in the author's scratch, not here.
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs pinraise
import { flush, inAct, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { useLayoutEffect, useRef, useState } from 'react'
import { addPin, forgetPins, PinLayer } from '../src/canvas/pins'
import { forgetModalOpenCache, forgetModalPins, PinFrame, pinModal } from '../src/canvas/modalpin'
import { adoptPinLayer, readPinSurfaces } from '../src/canvas/pinspace'
import { CurrentOrg } from '../src/popout'
import type { CanvasNode } from '../src/canvas/shared'

const ORG = 'mine'
const DESK = 'cto'
const noop = () => {}

/** jsdom measures every box as 0x0, and an unmeasured canvas leaves a pinned
 *  modal with no inline z-index at all — there would be nothing to compare.
 *  One fixed viewport for every element, restored afterwards. */
function stubLayout(): () => void {
  const proto = (globalThis as unknown as { HTMLElement: { prototype: Record<string, unknown> } }).HTMLElement.prototype
  const had = proto.getBoundingClientRect
  proto.getBoundingClientRect = function () {
    return { x: 0, y: 0, left: 0, top: 0, width: 1200, height: 800, right: 1200, bottom: 800, toJSON: () => ({}) } as DOMRect
  }
  return () => { proto.getBoundingClientRect = had }
}
function stubPointerCapture(): () => void {
  const proto = (globalThis as unknown as { HTMLElement: { prototype: Record<string, unknown> } }).HTMLElement.prototype
  const had = { s: proto.setPointerCapture, r: proto.releasePointerCapture }
  proto.setPointerCapture = noop; proto.releasePointerCapture = noop
  return () => { proto.setPointerCapture = had.s; proto.releasePointerCapture = had.r }
}

const node = (id: string): CanvasNode => ({ id, state: 'live', tier: 'opus', children: [], title: id, parent: null })

/** the real pinned desk and the real pinned usage window, in one org, sharing
 *  the real pin layer — the shape the user was looking at. */
function Rig() {
  const viewportRef = useRef<HTMLDivElement>(null)
  const [map] = useState(() => new Map([[DESK, node(DESK)]]))
  useLayoutEffect(() => {
    const host = viewportRef.current
    return host ? adoptPinLayer(ORG, host) : undefined
  }, [])
  return (
    <CurrentOrg.Provider value={ORG}>
      <div className="viewport" data-pin-org={ORG} ref={viewportRef}>
        <div className="space" />
        <PinLayer slug={ORG} map={map} viewportRef={viewportRef}
          targetOf={() => ({ x: 20, y: 20, w: 120, h: 120 })}
          op={() => Promise.resolve({} as never)} toast={noop} pub={false}
          maxTop={1000} pxc={1} onMailLink={noop} onWorkLink={noop} onOpenDoc={noop}
          onLineage={noop} onConfig={noop} onJump={noop} onShowOnCanvas={noop} />
      </div>
      <PinFrame kind="usage" title="usage limits" panel="settings usage-modal" close={noop}>
        <h3>usage limits</h3>
      </PinFrame>
    </CurrentOrg.Provider>
  )
}

interface Rigged {
  el: HTMLElement
  /** the desk window and the pinned modal's overlay, with the ordinals the
   *  browser would actually stack them by */
  z: () => { desk: number; modal: number }
  /** the shared registry's raise counter, which is what "advanced once" means */
  orders: () => { desk: number; modal: number; max: number }
  msgs: () => HTMLElement
}

function pointer(type: string, detail = 1): Event {
  const Ctor = (globalThis as unknown as { window: { PointerEvent: typeof PointerEvent } }).window.PointerEvent
  return new Ctor(type, { bubbles: true, cancelable: true, detail, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1, clientX: 60, clientY: 300 })
}
function mouse(type: string, detail: number): Event {
  const Ctor = (globalThis as unknown as { window: { MouseEvent: typeof MouseEvent } }).window.MouseEvent
  return new Ctor(type, { bubbles: true, cancelable: true, detail, clientX: 60, clientY: 300 })
}
/** one physical press, as the browser delivers it: pointerdown, pointerup, and
 *  a click that carries detail 1 because a mouse produced it */
async function press(target: Element) {
  await inAct(() => { target.dispatchEvent(pointer('pointerdown')) })
  await inAct(() => { target.dispatchEvent(pointer('pointerup')) })
  await inAct(() => { target.dispatchEvent(mouse('click', 1)) })
  await flush()
}

function uiTest(name: string, body: (rig: Rigged) => Promise<void>): void {
  test(name, async (t: TestContext) => {
    useFakeClock()
    const undoLayout = stubLayout(), undoCapture = stubPointerCapture()
    localStorage.clear(); forgetPins(); forgetModalPins(); forgetModalOpenCache()
    // pinned BEFORE the mount, so the desk is registered first and the usage
    // window lands on top of it — the state the user was looking at
    addPin(ORG, DESK, { x: 20, y: 40, w: 600, h: 420 })
    pinModal('usage', { x: 400, y: 150, w: 420, h: 330 }, ORG)
    const view = await mountView(<Rig />, (host) => host)
    await flush()
    t.after(async () => {
      await view.unmount()
      undoCapture(); undoLayout(); realClock()
      localStorage.clear(); forgetPins(); forgetModalPins(); forgetModalOpenCache()
    })
    const el = view.el
    const pinwin = () => {
      const w = el.querySelector(`.pinwin[data-id="${DESK}"]`) as HTMLElement | null
      return assert.ok(w, 'the pinned desk window rendered') ?? w!
    }
    const overlay = () => {
      const o = el.querySelector('.overlay.overlay-pinned') as HTMLElement | null
      return assert.ok(o, 'the pinned usage window rendered') ?? o!
    }
    await body({
      el,
      z: () => ({ desk: Number(pinwin().style.zIndex), modal: Number(overlay().style.zIndex) }),
      orders: () => {
        const all = readPinSurfaces().filter((s) => s.org === ORG)
        const desk = all.find((s) => !s.modal), modal = all.find((s) => s.modal)
        assert.ok(desk && modal, 'both surfaces registered in the shared band')
        return { desk: desk!.order, modal: modal!.order, max: Math.max(...all.map((s) => s.order)) }
      },
      msgs: () => {
        // NOT a synthetic hook: this is the real transcript the real DeskChat
        // renders, and the element the desk's wall matches with `.msgs`.
        const m = pinwin().querySelector('.msgs') as HTMLElement | null
        return assert.ok(m, 'the pinned desk rendered its real .msgs transcript') ?? m!
      },
    })
  })
}

uiTest('§1 pressing the desk\'s transcript brings the desk in front of the pinned usage window', async ({ z, msgs }) => {
  const before = z()
  // vacuity guard: if the desk were already on top, raising it would be free
  assert.ok(before.modal > before.desk,
    `the usage window must start in front for this to ask anything (${JSON.stringify(before)})`)
  await press(msgs())
  const after = z()
  assert.ok(after.desk > after.modal,
    `pressing the desk's own transcript must bring it forward (${JSON.stringify(after)})`)
})

uiTest('§2 one physical press advances the desk exactly one place', async ({ orders, msgs }) => {
  const before = orders()
  assert.ok(before.desk < before.max, 'the desk must start behind, or "it advanced" is free')
  await press(msgs())
  const after = orders()
  // a press delivers BOTH a pointerdown and a click; if the click leg were not
  // keyboard-only they would each raise, and the counter would jump twice
  assert.equal(after.desk, before.max + 1,
    `one press is one raise (was ${JSON.stringify(before)}, now ${JSON.stringify(after)})`)
})

uiTest('§3 the pinned usage window still comes forward when it is pressed', async ({ el, z, msgs }) => {
  await press(msgs())
  const raised = z()
  assert.ok(raised.desk > raised.modal, 'the desk is in front to start with')
  const panel = el.querySelector('.usage-modal.modalpin-win') as HTMLElement | null
  assert.ok(panel, 'the usage window rendered its panel')
  await press(panel!)
  const after = z()
  assert.ok(after.modal > after.desk,
    `the modal family must keep working (${JSON.stringify(after)})`)
})

uiTest('§5 a title-bar press advances the desk exactly one place', async ({ el, orders, z }) => {
  const before = orders()
  assert.ok(before.desk < before.max, 'the desk must start behind, or "it advanced" is free')
  const title = el.querySelector(`.pinwin[data-id="${DESK}"] .pinwin-title`) as HTMLElement | null
  assert.ok(title, 'the window rendered its title bar')
  await press(title!)
  // the title bar is INSIDE .pinwin, so the capture handler covers it; the
  // drag gesture it starts must not raise a second time
  assert.equal(orders().desk, before.max + 1, 'one press is one raise')
  assert.ok(z().desk > z().modal, 'and it really is in front')
})

uiTest('§6 a resize-handle press advances the desk exactly one place', async ({ el, orders, z }) => {
  const before = orders()
  assert.ok(before.desk < before.max, 'the desk must start behind, or "it advanced" is free')
  // ⚠ the handles are OUTSIDE .pinwin (a sibling frame), so they are NOT
  // covered by the window's capture handler and carry their own. This is the
  // case the user could already do: resizing brought the desk forward when
  // clicking it would not.
  const handle = el.querySelector(`.pinwin-resize-frame[data-id="${DESK}"] .pinwin-rs.se`) as HTMLElement | null
  assert.ok(handle, 'the window rendered its resize handles')
  assert.ok(!handle!.closest('.pinwin'), 'the handles really are outside the window element')
  await press(handle!)
  assert.equal(orders().desk, before.max + 1, 'one press is one raise')
  assert.ok(z().desk > z().modal, 'and it really is in front')
})

uiTest('§4 a keyboard activation inside the desk raises it too', async ({ z, el }) => {
  const before = z()
  assert.ok(before.modal > before.desk, 'the usage window starts in front')
  const button = el.querySelector(`.pinwin[data-id="${DESK}"] .pinwin-body button`) as HTMLElement | null
  assert.ok(button, 'the desk renders a control to activate')
  // Enter/Space on a focused control produces a click with detail 0 and NO
  // pointerdown — the one path the pointer handler cannot see
  await inAct(() => { button!.dispatchEvent(mouse('click', 0)) })
  await flush()
  const after = z()
  assert.ok(after.desk > after.modal,
    `a keyboard activation must raise the window it happened in (${JSON.stringify(after)})`)
})
