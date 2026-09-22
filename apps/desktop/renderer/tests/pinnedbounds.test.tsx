// pinnedbounds.test.tsx — the canvas's visible bounds follow the CURRENT
// window and display geometry when pinned windows share the canvas.
//
// The bug (docket recalculate-pinned-area-canvas-bounds-after-disp): after a
// window or screen-resolution change, the part of the canvas left free by the
// pinned windows was computed against stale geometry, so the camera aimed at
// canvas a pinned window now covered, or did not re-measure at all.
//
// Two causes, one section group each:
//   A. STORED vs DRAWN. PinWindow draws `clampRect(pin.rect, vp)` against the
//      current viewport and keeps the stored rect (so the placement comes back
//      when the window grows). The camera's free region (`regionOf`) read the
//      STORED rect. After a shrink it therefore saw the window where it used
//      to be. §1 is the regression; §2 pins that the stored placement is kept.
//   B. NO DISPLAY SIGNAL. Every geometry reader listened to `resize` and/or a
//      ResizeObserver only. A resolution or scale change can arrive as
//      `screen`'s `change` event or a devicePixelRatio flip without either.
//      §3/§4 deliver ONLY those signals; §0 is the shared helper's contract.
//
// ⚠ WHAT THIS SUITE CAN AND CANNOT SEE. jsdom does no layout and has neither
// `screen` events nor `matchMedia`; both are supplied here, and every size is
// what `stubViewportRect` says. The claims are about which camera and which
// drawn window rect the component produces for a stated geometry, not about
// pixels. Whether a real Windows display change emits `screen` `change`, a
// ratio flip, a `resize`, or several, is not decidable here — which is why the
// product listens to all of them.
//
// ANTI-VACUITY. §1's reference camera is produced by a FRESH focus after the
// stored rect has been committed to the place the shrink moved the window —
// a geometry with no stale/drawn disagreement left in it — and the section
// asserts the drawn rect really moved while the stored one did not. §3/§4
// assert the fresh camera differs from the pre-change camera, so a canvas
// that ignored the change cannot pass by standing still.
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs pinnedbounds

import {
  advance, FakeServer, fireResize, flush, inAct, installFetch, mountView,
  realClock, useFakeClock,
} from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { OrgCanvas, resetCanvasSessionForTests } from '../src/canvas/OrgCanvas'
import { onViewportGeometry } from '../src/canvas/pinspace'
import { addPin, clampRect, commitRect, forgetPins, readPins } from '../src/canvas/pins'
import type { PinRect } from '../src/canvas/pins'
import { resetConvos } from '../src/convo'
import type { TreePayload } from '../src/types'

const noop = () => {}
const SLUG = 'bounds'

// ---------------------------------------------------------------- fixtures
function mk(id: string): unknown {
  return {
    id, title: id, tier: 'haiku', model_id: 'haiku', state: 'live',
    seat: 1, grant: 0, free: 0, ui_order: 0, cost_usd: 0, occupancy: null,
    context_window: null, charter: null, mail_pending: 0, limit_locked: false,
    last_status: null, prev_status: null, inflight_at: null, last_denials: [],
    turns: [], frozen: null, audiences_held: [], bearer_state: null,
    generation: 0, children: [], lineage: [],
    scope: { permission_mode: 'default', add_dirs: [], tools: {}, org_visibility: 'team' },
  }
}
function tree(ids: string[]): TreePayload {
  return {
    slug: SLUG, name: SLUG, workspace: null, dirs: [], max_top_grant: 1000,
    default_top_grant: 50, compact_at: 0, default_tools: null,
    default_visibility: 'team', default_effort: '', credit_requests: [],
    tiers: { haiku: 1, sonnet: 3, opus: 5, fable: 10 }, audiences: [],
    roots: ids.map(mk), cost_usd_total: 0,
    audit: { live_nodes: ids.length, top_level_holds: 0, no_overdraft: true, problems: [] },
    user_inbox_count: 0, user_inbox_newest: null, fable_lock: null,
    spend_frozen: false, storage_blocked: false, auto_resume: false,
    fable_limit_policy: 'freeze', fable_filter_policy: 'halt',
    cascade_hire: false, cascade_alloc: true, sandboxed: false,
    audience_requests: [], org_inbox: null, net: null,
  } as unknown as TreePayload
}

// ------------------------------------------------------------- the geometry
let VP = { w: 1280, h: 800 }
const vpRect = () => ({
  x: 0, y: 0, left: 0, top: 0, width: VP.w, height: VP.h,
  right: VP.w, bottom: VP.h, toJSON() {},
})
function stubViewportRect(): () => void {
  const proto = window.HTMLElement.prototype
  const original = proto.getBoundingClientRect
  proto.getBoundingClientRect = function (this: HTMLElement) {
    return this.classList?.contains('viewport')
      ? vpRect() as unknown as DOMRect
      : original.call(this)
  }
  return () => { proto.getBoundingClientRect = original }
}

type Win = Window & typeof globalThis
const win = () => window as unknown as Win

/** jsdom's `screen` is not an EventTarget. Chromium's is (the `change` event
 *  Electron's renderer sees on a display change). Graft one on for the test. */
function stubScreenEvents(): { fire: () => void; listeners: () => number; restore: () => void } {
  const scr = win().screen as unknown as Record<string, unknown>
  const et = new (win().EventTarget)()
  let count = 0
  scr.addEventListener = (t: string, fn: EventListener) => {
    if (t === 'change') count++
    et.addEventListener(t, fn)
  }
  scr.removeEventListener = (t: string, fn: EventListener) => {
    if (t === 'change') count--
    et.removeEventListener(t, fn)
  }
  return {
    fire: () => { et.dispatchEvent(new (win().Event)('change')) },
    listeners: () => count,
    restore: () => { delete scr.addEventListener; delete scr.removeEventListener },
  }
}

/** a `matchMedia` that knows only `(resolution: Ndppx)`: each query matches
 *  while `devicePixelRatio` equals its N, and `flip` changes the ratio and
 *  fires `change` on every live list whose match state changed — which is
 *  what a browser does when the display's scale changes. */
function stubMatchMedia(): {
  flip: (dpr: number) => void; queries: () => string[]; listeners: () => number; restore: () => void
} {
  const w = win() as unknown as Record<string, unknown>
  const hadMM = w.matchMedia
  let dpr = 1
  Object.defineProperty(w, 'devicePixelRatio', { configurable: true, get: () => dpr })
  const lists: { q: string; et: EventTarget; n: number; was: boolean }[] = []
  const matches = (q: string) => {
    const m = /\(resolution: ([\d.]+)dppx\)/.exec(q)
    return !!m && Number(m[1]) === dpr
  }
  w.matchMedia = (q: string) => {
    const rec = { q, et: new (win().EventTarget)(), n: 0, was: matches(q) }
    lists.push(rec)
    return {
      media: q, get matches() { return matches(q) },
      addEventListener: (_t: string, fn: EventListener) => { rec.n++; rec.et.addEventListener('change', fn) },
      removeEventListener: (_t: string, fn: EventListener) => { rec.n--; rec.et.removeEventListener('change', fn) },
    }
  }
  return {
    flip: (next: number) => {
      dpr = next
      for (const rec of [...lists]) {
        const now = matches(rec.q)
        if (now !== rec.was) { rec.was = now; rec.et.dispatchEvent(new (win().Event)('change')) }
      }
    },
    queries: () => lists.filter((l) => l.n > 0).map((l) => l.q),
    listeners: () => lists.reduce((s, l) => s + l.n, 0),
    restore: () => {
      if (hadMM === undefined) delete w.matchMedia; else w.matchMedia = hadMM
      delete w.devicePixelRatio
    },
  }
}

type Cap = { setPointerCapture?: unknown; releasePointerCapture?: unknown
  hasPointerCapture?: unknown }
function stubPointerCapture(): () => void {
  const proto = (globalThis as unknown as { HTMLElement: { prototype: Cap } })
    .HTMLElement.prototype
  const had = { s: proto.setPointerCapture, r: proto.releasePointerCapture,
    h: proto.hasPointerCapture }
  proto.setPointerCapture = noop
  proto.releasePointerCapture = noop
  proto.hasPointerCapture = () => false
  return () => {
    proto.setPointerCapture = had.s
    proto.releasePointerCapture = had.r
    proto.hasPointerCapture = had.h
  }
}
function pointer(type: string, x: number, y: number): Event {
  return new (win().PointerEvent)(type, {
    bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse',
    isPrimary: true, button: type === 'pointermove' ? -1 : 0, buttons: 1,
    clientX: x, clientY: y,
  })
}
const clickEv = (): Event =>
  new (win().MouseEvent)('click', { bubbles: true, cancelable: true })

// ------------------------------------------------------------- the readers
interface Cam { x: number; y: number; z: number }
function cam(host: HTMLElement): Cam {
  const space = host.querySelector('.space') as HTMLElement | null
  assert.ok(space, 'no .space element — the canvas did not render')
  const m = /translate\(([-\d.e+]+)px, ?([-\d.e+]+)px\) scale\(([-\d.e+]+)\)/
    .exec(space.style.transform)
  assert.ok(m, `unparsable world transform: ${space.style.transform}`)
  return { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) }
}
const same = (a: Cam, b: Cam): boolean =>
  Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01
  && Math.abs(a.z - b.z) < 0.01
const show = (c: Cam) => `(${c.x.toFixed(2)}, ${c.y.toFixed(2)}) @${c.z.toFixed(3)}`
const cardOf = (host: HTMLElement, name: string) => {
  const el = [...host.querySelectorAll('.sq')]
    .find((c) => c.querySelector('.name')?.textContent === name)
  assert.ok(el, `no card for ${name}`)
  return el
}
const deskOf = (host: HTMLElement) => host.querySelector('.sq.desk:not(.user)')
const pinWin = (host: HTMLElement, id: string) => {
  const el = host.ownerDocument.querySelector(`.pinwin[data-id="${id}"]`) as HTMLElement | null
  assert.ok(el, `no pinned window for ${id}`)
  return el
}
const drawn = (w: HTMLElement): PinRect => ({
  x: parseFloat(w.style.left), y: parseFloat(w.style.top),
  w: parseFloat(w.style.width), h: parseFloat(w.style.height),
})
const stored = (id: string): PinRect => {
  const p = readPins(SLUG).find((q) => q.id === id)
  assert.ok(p, `no stored pin for ${id}`)
  return p.rect
}
const showRect = (r: PinRect) => `{x:${r.x}, y:${r.y}, w:${r.w}, h:${r.h}}`

// ------------------------------------------------------------- the gestures
async function clickCard(el: Element): Promise<void> {
  await inAct(() => { el.dispatchEvent(pointer('pointerdown', 200, 200)) })
  await flush()
  await inAct(() => { el.dispatchEvent(pointer('pointerup', 200, 200)) })
  await flush()
  await advance(1600)
}
/** the REFERENCE camera: what a fresh focus gesture produces right now */
async function reFocus(host: HTMLElement): Promise<Cam> {
  const over = host.querySelector('.sq.desk:not(.user) .desk-over')
  assert.ok(over, 'the desk is not open, nothing to re-focus')
  await inAct(() => { over.dispatchEvent(clickEv()) })
  await flush()
  await advance(1600)
  return cam(host)
}

// -------------------------------------------------------------- the driver
// cto is pinned FLUSH RIGHT, full height, 400 px wide, at the 1280x800
// canvas. Pinned windows live in the viewport's PADDING box (pins.tsx
// `vpSize`), so the rect is built from the measured borders, not assumed.
let BORDER = { x: 0, y: 0 }
const inner = (w: number, h: number) => ({ w: w - BORDER.x, h: h - BORDER.y })
const flushRight = (w: number, h: number): PinRect =>
  ({ x: inner(w, h).w - 400, y: 0, w: 400, h: inner(w, h).h })
let PIN: PinRect = { x: 0, y: 0, w: 0, h: 0 }

interface Kit {
  host: HTMLElement
  viewport: HTMLElement
  screen: ReturnType<typeof stubScreenEvents>
  media: ReturnType<typeof stubMatchMedia>
  unmount: () => Promise<void>
}
function uiTest(name: string, body: (k: Kit) => Promise<void>, pinned = true): void {
  test(name, async (t: TestContext) => {
    VP = { w: 1280, h: 800 }
    localStorage.clear()
    forgetPins()
    resetCanvasSessionForTests()
    useFakeClock()
    installFetch(new FakeServer())
    const unrect = stubViewportRect()
    const uncap = stubPointerCapture()
    const screen = stubScreenEvents()
    const media = stubMatchMedia()
    const open: { unmount: () => Promise<void> }[] = []
    t.after(async () => {
      for (const m of open) { try { await m.unmount() } catch { /* gone */ } }
      media.restore(); screen.restore()
      uncap(); unrect(); resetConvos(); realClock()
      localStorage.clear(); forgetPins()
    })
    const v = await mountView(
      <OrgCanvas tree={tree(['ceo', 'cto', 'qa'])} op={() => Promise.resolve({} as never)}
        slug={SLUG} toast={noop} mailEvt={null} />, (el) => el)
    let gone = false
    const unmount = async () => { if (!gone) { gone = true; await v.unmount() } }
    open.push({ unmount })
    await flush()
    const viewport = v.el.querySelector('.viewport') as HTMLElement | null
    assert.ok(viewport, 'the canvas viewport rendered')
    await advance(2500)          // the opening drift
    const cs = getComputedStyle(viewport)
    const px = (v: string) => parseFloat(v) || 0
    BORDER = { x: px(cs.borderLeftWidth) + px(cs.borderRightWidth),
      y: px(cs.borderTopWidth) + px(cs.borderBottomWidth) }
    PIN = flushRight(1280, 800)
    if (pinned) {
      await inAct(() => { assert.ok(addPin(SLUG, 'cto', PIN).ok, 'the pin was refused') })
      await flush()
    }
    await body({ host: v.el, viewport, screen, media, unmount })
  })
}

// ==========================================================================
test('§0 onViewportGeometry: resize, screen change and a ratio flip each notify, the ratio query re-arms, and unsubscribe removes all three', () => {
  const screen = stubScreenEvents()
  const media = stubMatchMedia()
  try {
    let n = 0
    const off = onViewportGeometry(win(), () => { n++ })
    assert.deepEqual(media.queries(), ['(resolution: 1dppx)'])
    assert.equal(screen.listeners(), 1)

    win().dispatchEvent(new (win().Event)('resize'))
    assert.equal(n, 1, 'a window resize did not notify')
    screen.fire()
    assert.equal(n, 2, 'a screen change did not notify')
    media.flip(1.5)
    assert.equal(n, 3, 'a devicePixelRatio flip did not notify')
    assert.deepEqual(media.queries(), ['(resolution: 1.5dppx)'],
      'the ratio query was not re-armed at the NEW ratio — a second flip would be missed')
    media.flip(1)
    assert.equal(n, 4, 'the SECOND ratio flip was missed')

    off()
    assert.equal(screen.listeners(), 0, 'the screen listener leaked')
    assert.equal(media.listeners(), 0, 'a ratio listener leaked')
    win().dispatchEvent(new (win().Event)('resize'))
    screen.fire(); media.flip(2)
    assert.equal(n, 4, 'a signal still notified after unsubscribe')
  } finally { media.restore(); screen.restore() }
})

// ==========================================================================
uiTest('§1 REGRESSION: after a window shrink the camera fits the canvas a pinned window LEAVES FREE, not where it used to be', async ({ host, viewport }) => {
  await clickCard(cardOf(host, 'ceo'))
  assert.ok(deskOf(host), 'the click did not open the ceo desk — nothing below is testable')
  assert.deepEqual(drawn(pinWin(host, 'cto')), PIN, 'at 1280 px the window is drawn where it is stored')

  VP = { w: 1000, h: 800 }
  await inAct(() => { fireResize(viewport) })
  await flush()
  await advance(1600)
  const after = cam(host)

  // premise: the window is DRAWN clamped into the smaller canvas while its
  // stored rect is unchanged — the disagreement the bug lived in
  const shown = drawn(pinWin(host, 'cto'))
  assert.deepEqual(shown, flushRight(1000, 800),
    `the shrink drew the window at ${showRect(shown)}, not clamped to the right edge`)
  assert.deepEqual(stored('cto'), PIN, 'the shrink rewrote the stored placement')

  // the reference: a fresh focus once the stored rect has been MOVED to the
  // place a shrink puts it, so stored and shown no longer disagree. It is
  // clamped into the canvas's measured box (the region's own frame) rather
  // than copied from `shown`, because jsdom reports a 16px border on every
  // element — the product's is 1px, inside PIN_GAP — and `shown` sits in the
  // padding box that phantom border shrinks.
  const moved = clampRect(PIN, { w: 1000, h: 800 })
  assert.ok(moved.x < PIN.x, 'POSITIVE CONTROL FAILED: the shrink does not move the window')
  await inAct(() => { commitRect(SLUG, 'cto', moved, { w: 1000, h: 800 }) })
  await flush()
  const fresh = await reFocus(host)
  assert.ok(same(after, fresh),
    `the refit after the shrink landed at ${show(after)}; the camera for the canvas `
    + `actually left free (window drawn at x=${shown.x}) is ${show(fresh)} — the free region `
    + `was computed against the window's STORED rect (x=${PIN.x}), off the new canvas`)
})

// ==========================================================================
uiTest('§2 the stored placement survives: a shrink draws the window clamped, growing back draws it where the user left it', async ({ host, viewport }) => {
  VP = { w: 1000, h: 800 }
  await inAct(() => { fireResize(viewport) })
  await flush()
  assert.deepEqual(drawn(pinWin(host, 'cto')), flushRight(1000, 800),
    'the shrink did not clamp the drawn window')
  VP = { w: 1280, h: 800 }
  await inAct(() => { fireResize(viewport) })
  await flush()
  assert.deepEqual(drawn(pinWin(host, 'cto')), PIN,
    'growing the window back did not restore the user\'s placement')
  assert.deepEqual(stored('cto'), PIN, 'the stored placement changed')
})

// ==========================================================================
uiTest('§3 a DISPLAY change delivered only as screen `change` (no resize, no ResizeObserver) re-measures the canvas and the pinned window', async ({ host, screen }) => {
  await clickCard(cardOf(host, 'ceo'))
  assert.ok(deskOf(host), 'the click did not open the ceo desk')
  const before = cam(host)

  VP = { w: 1000, h: 800 }
  await inAct(() => { screen.fire() })
  await flush()
  await advance(1600)
  const after = cam(host)
  const shown = drawn(pinWin(host, 'cto'))

  assert.deepEqual(shown, flushRight(1000, 800),
    `after the display change the pinned window is still drawn at ${showRect(shown)} — `
    + 'nothing re-measured the canvas it is clamped to')
  const fresh = await reFocus(host)
  assert.ok(!same(fresh, before),
    `POSITIVE CONTROL FAILED: the new geometry wants the same camera ${show(before)}`)
  assert.ok(same(after, fresh),
    `the display change left the focused desk at ${show(after)}; a focus at the new `
    + `geometry lands at ${show(fresh)}`)
})

// ==========================================================================
uiTest('§4 a DISPLAY scale change delivered only as a devicePixelRatio flip re-measures, twice', async ({ host, media }) => {
  await clickCard(cardOf(host, 'ceo'))
  assert.ok(deskOf(host), 'the click did not open the ceo desk')
  const before = cam(host)

  VP = { w: 1000, h: 800 }
  await inAct(() => { media.flip(1.25) })
  await flush()
  await advance(1600)
  assert.deepEqual(drawn(pinWin(host, 'cto')), flushRight(1000, 800),
    'the ratio flip did not re-measure the canvas the pinned window is clamped to')
  const after = cam(host)
  const fresh = await reFocus(host)
  assert.ok(!same(fresh, before), 'POSITIVE CONTROL FAILED: the flip asked nothing of the camera')
  assert.ok(same(after, fresh),
    `the ratio flip left the desk at ${show(after)}; a focus at the new geometry lands at ${show(fresh)}`)

  // …and the query was re-armed: flipping BACK is noticed too
  VP = { w: 1280, h: 800 }
  await inAct(() => { media.flip(1) })
  await flush()
  await advance(1600)
  assert.deepEqual(drawn(pinWin(host, 'cto')), PIN,
    'the second ratio flip was missed — the resolution query was not re-armed')
})

// ==========================================================================
uiTest('§5 unmounting the canvas leaves no display listener behind', async ({ screen, media, unmount }) => {
  assert.ok(screen.listeners() > 0, 'POSITIVE CONTROL FAILED: nothing listened to the screen')
  assert.ok(media.listeners() > 0, 'POSITIVE CONTROL FAILED: nothing listened to the pixel ratio')
  await unmount()
  await flush()
  assert.equal(screen.listeners(), 0, `${screen.listeners()} screen listener(s) leaked`)
  assert.equal(media.listeners(), 0, `${media.listeners()} ratio listener(s) leaked`)
})
