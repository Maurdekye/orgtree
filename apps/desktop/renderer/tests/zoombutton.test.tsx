// zoombutton.test.tsx — Unit tests for zoom in/out button anchoring
// (docket: center-zoom-buttons-on-free-canvas-area).
//
// When pinned panels bound the usable canvas, the HUD ± zoom buttons anchor
// on the center of the available free-space rectangle (clearRegion), not
// the whole viewport center.
//
// §0 unpinned identity: with no pins, zoom in and zoom out anchor on the viewport center (500, 400)
// §1 asymmetric right pin: zoom in and zoom out anchor on the left free region center (294, 400)
//    with positive control exposing the old whole-canvas drift (>60px)
// §2 asymmetric left pin: zoom in and zoom out anchor on the right free region center (681, 400)
// §3 asymmetric top pin: zoom in and zoom out anchor on the lower free region center (500, 566)
// §4 fully blocked fallback: fully covered viewport gracefully anchors on (500, 400) without crashing
// §5 pointer wheel zoom and pan remain untouched
//
// Run:  cd frontend && node tests/run.mjs zoombutton

import {
  advance, FakeServer, flush, inAct, installFetch, mountView, realClock,
  useFakeClock,
} from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { OrgCanvas } from '../src/canvas/OrgCanvas'
import { addPin, forgetPins } from '../src/canvas/pins'
import { resetConvos } from '../src/convo'
import type { TreePayload } from '../src/types'

const noop = () => {}
const asTree = (v: unknown) => v as TreePayload

const VP_W = 1000, VP_H = 800
const GAP = 12

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
  return asTree({
    slug: 'mine', name: 'mine', workspace: null, dirs: [], max_top_grant: 1000,
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
  })
}

type Cap = { setPointerCapture?: unknown; releasePointerCapture?: unknown; hasPointerCapture?: unknown }
function stubPointerCapture(): () => void {
  const proto = (globalThis as unknown as { HTMLElement: { prototype: Cap } }).HTMLElement.prototype
  const had = { s: proto.setPointerCapture, r: proto.releasePointerCapture, h: proto.hasPointerCapture }
  proto.setPointerCapture = noop
  proto.releasePointerCapture = noop
  proto.hasPointerCapture = () => false
  return () => {
    proto.setPointerCapture = had.s
    proto.releasePointerCapture = had.r
    proto.hasPointerCapture = had.h
  }
}

const W = () => globalThis as unknown as {
  window: { PointerEvent: typeof PointerEvent; MouseEvent: typeof MouseEvent }
}

function pointer(type: string, x: number, y: number): Event {
  return new (W().window.PointerEvent)(type, {
    bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse',
    isPrimary: true, button: type === 'pointermove' ? -1 : 0, buttons: 1,
    clientX: x, clientY: y,
  })
}

interface Cam { x: number; y: number; z: number }

function cam(host: HTMLElement): Cam {
  const space = host.querySelector('.space') as HTMLElement | null
  assert.ok(space, 'no .space element — the canvas did not render')
  const m = /translate\(([-\d.e+]+)px, ?([-\d.e+]+)px\) scale\(([-\d.e+]+)\)/.exec(space.style.transform)
  assert.ok(m, `unparsable world transform: ${space.style.transform}`)
  return { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) }
}

function measure(el: HTMLElement, w = VP_W, h = VP_H): void {
  Object.defineProperty(el, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ x: 0, y: 0, top: 0, left: 0, right: w, bottom: h,
      width: w, height: h, toJSON: () => ({}) }),
  })
}

interface Kit { host: HTMLElement; viewport: HTMLElement }

function uiTest(name: string, body: (k: Kit) => Promise<void>): void {
  test(name, async (t: TestContext) => {
    useFakeClock()
    installFetch(new FakeServer())
    const unstub = stubPointerCapture()
    localStorage.clear()
    forgetPins()
    const open: { unmount: () => Promise<void> }[] = []
    t.after(async () => {
      for (const m of open) { try { await m.unmount() } catch { /* gone */ } }
      unstub(); resetConvos(); realClock(); localStorage.clear(); forgetPins()
    })
    const v = await mountView(
      <OrgCanvas tree={tree(['ceo', 'cto', 'qa', 'ops'])} op={() => Promise.resolve({} as never)}
        slug="mine" toast={noop} mailEvt={null} />, (el) => el)
    open.push(v)
    await flush()
    const viewport = v.el.querySelector('.viewport') as HTMLElement | null
    assert.ok(viewport, 'the canvas viewport rendered')
    measure(viewport)
    await advance(2500)
    await body({ host: v.el, viewport })
  })
}

async function pin(rects: { id: string; x: number; y: number; w: number; h: number }[]) {
  await inAct(() => {
    for (const r of rects) addPin('mine', r.id, { x: r.x, y: r.y, w: r.w, h: r.h })
  })
  await flush()
}

async function clickZoomIn(host: HTMLElement): Promise<void> {
  const btn = host.querySelector('button[title="zoom in"]') as HTMLButtonElement | null
  assert.ok(btn, 'no zoom in button found')
  await inAct(() => { btn.click() })
  await flush()
  await advance(350)
}

async function clickZoomOut(host: HTMLElement): Promise<void> {
  const btn = host.querySelector('button[title="zoom out"]') as HTMLButtonElement | null
  assert.ok(btn, 'no zoom out button found')
  await inAct(() => { btn.click() })
  await flush()
  await advance(350)
}

const near = (got: number, want: number, what: string, tol = 0.5) =>
  assert.ok(Math.abs(got - want) <= tol,
    `${what}: got ${got.toFixed(3)}, wanted ~${want.toFixed(3)} (diff ${Math.abs(got - want).toFixed(4)})`)

// §0 Unpinned identity
uiTest('§0 unpinned identity: zoom in and zoom out anchor on the viewport center (500, 400)',
  async ({ host }) => {
    const c0 = cam(host)
    const anchorX = VP_W / 2, anchorY = VP_H / 2
    const wx = (anchorX - c0.x) / c0.z
    const wy = (anchorY - c0.y) / c0.z

    // Zoom in
    await clickZoomIn(host)
    const c1 = cam(host)
    assert.ok(c1.z > c0.z, `zoom in increased scale (${c1.z} > ${c0.z})`)
    const sx1 = c1.x + wx * c1.z
    const sy1 = c1.y + wy * c1.z
    near(sx1, anchorX, 'unpinned zoom in anchor x')
    near(sy1, anchorY, 'unpinned zoom in anchor y')

    // Zoom out
    await clickZoomOut(host)
    const c2 = cam(host)
    assert.ok(c2.z < c1.z, `zoom out decreased scale (${c2.z} < ${c1.z})`)
    const sx2 = c2.x + wx * c2.z
    const sy2 = c2.y + wy * c2.z
    near(sx2, anchorX, 'unpinned zoom out anchor x')
    near(sy2, anchorY, 'unpinned zoom out anchor y')
  })

// §1 Asymmetric right pin
uiTest('§1 asymmetric right pin: zoom in and zoom out anchor on the left free region center',
  async ({ host }) => {
    // Pin right side: x=600..1000. With 12px gap, obstacle is x=588..1000.
    // Free region is x=0..588, y=0..800.
    // Free region center is cx = 588 / 2 = 294, cy = 400.
    await pin([{ id: 'qa', x: 600, y: 0, w: 400, h: VP_H }])

    const c0 = cam(host)
    const cx = (600 - GAP) / 2 // 294
    const cy = VP_H / 2         // 400
    const wx = (cx - c0.x) / c0.z
    const wy = (cy - c0.y) / c0.z

    // Zoom in
    await clickZoomIn(host)
    const c1 = cam(host)
    assert.ok(c1.z > c0.z, 'zoom in increased scale')

    const sx1 = c1.x + wx * c1.z
    const sy1 = c1.y + wy * c1.z
    near(sx1, cx, 'free region center x stays fixed on zoom in')
    near(sy1, cy, 'free region center y stays fixed on zoom in')

    // POSITIVE CONTROL: what would the old whole-viewport anchor have done?
    // If anchored on whole-screen center (500, 400), the world point at 294 would shift by:
    // (cx - 500) * (1 - c1.z / c0.z) = (294 - 500) * (1 - 1.3) = +61.8px.
    const oldDrift = Math.abs((cx - VP_W / 2) * (1 - c1.z / c0.z))
    assert.ok(oldDrift > 60, `positive control: old anchor would drift by ${oldDrift.toFixed(1)}px`)
    assert.ok(Math.abs(sx1 - cx) < 0.2, 'actual drift is < 0.2px, proving anchor is NOT the old canvas center')

    // Zoom out
    await clickZoomOut(host)
    const c2 = cam(host)
    assert.ok(c2.z < c1.z, 'zoom out decreased scale')

    const sx2 = c2.x + wx * c2.z
    const sy2 = c2.y + wy * c2.z
    near(sx2, cx, 'free region center x stays fixed on zoom out')
    near(sy2, cy, 'free region center y stays fixed on zoom out')
  })

// §2 Asymmetric left pin
uiTest('§2 asymmetric left pin: zoom in and zoom out anchor on the right free region center',
  async ({ host }) => {
    // Pin left side: x=0..350. With 12px gap, obstacle is x=0..362.
    // Free region is x=362..1000, width = 638.
    // Free region center is cx = 362 + 638 / 2 = 681, cy = 400.
    await pin([{ id: 'qa', x: 0, y: 0, w: 350, h: VP_H }])

    const c0 = cam(host)
    const regionLeft = 350 + GAP
    const cx = regionLeft + (VP_W - regionLeft) / 2 // 681
    const cy = VP_H / 2                            // 400
    const wx = (cx - c0.x) / c0.z
    const wy = (cy - c0.y) / c0.z

    await clickZoomIn(host)
    const c1 = cam(host)
    near(c1.x + wx * c1.z, cx, 'right-shifted free region center x stays fixed on zoom in')
    near(c1.y + wy * c1.z, cy, 'free region center y stays fixed on zoom in')

    await clickZoomOut(host)
    const c2 = cam(host)
    near(c2.x + wx * c2.z, cx, 'right-shifted free region center x stays fixed on zoom out')
    near(c2.y + wy * c2.z, cy, 'free region center y stays fixed on zoom out')
  })

// §3 Asymmetric top pin
uiTest('§3 asymmetric top pin: zoom in and zoom out anchor on the lower free region center',
  async ({ host }) => {
    // Pin top side: y=0..320, width=1000. With 12px gap, obstacle is y=0..332.
    // Free region is y=332..800, height = 468.
    // Free region center is cx = 500, cy = 332 + 468 / 2 = 566.
    await pin([{ id: 'qa', x: 0, y: 0, w: VP_W, h: 320 }])

    const c0 = cam(host)
    const regionTop = 320 + GAP
    const cx = VP_W / 2                          // 500
    const cy = regionTop + (VP_H - regionTop) / 2 // 566
    const wx = (cx - c0.x) / c0.z
    const wy = (cy - c0.y) / c0.z

    await clickZoomIn(host)
    const c1 = cam(host)
    near(c1.x + wx * c1.z, cx, 'lower free region center x stays fixed on zoom in')
    near(c1.y + wy * c1.z, cy, 'lower free region center y stays fixed on zoom in')

    await clickZoomOut(host)
    const c2 = cam(host)
    near(c2.x + wx * c2.z, cx, 'lower free region center x stays fixed on zoom out')
    near(c2.y + wy * c2.z, cy, 'lower free region center y stays fixed on zoom out')
  })

// §4 Fully blocked fallback
uiTest('§4 fully blocked fallback: fully covered viewport gracefully defaults to viewport center',
  async ({ host }) => {
    // Cover the entire viewport
    await pin([
      { id: 'qa', x: 0, y: 0, w: 600, h: VP_H },
      { id: 'ops', x: 500, y: 0, w: 500, h: VP_H },
    ])

    const c0 = cam(host)
    const cx = VP_W / 2, cy = VP_H / 2
    const wx = (cx - c0.x) / c0.z, wy = (cy - c0.y) / c0.z

    // Does not throw, does not generate NaN
    await clickZoomIn(host)
    const c1 = cam(host)
    assert.ok(!Number.isNaN(c1.x) && !Number.isNaN(c1.y) && !Number.isNaN(c1.z), 'camera remains valid numbers')
    assert.ok(c1.z > c0.z, 'zoom in still works in blocked state')
    near(c1.x + wx * c1.z, cx, 'blocked fallback anchors on viewport center x')
    near(c1.y + wy * c1.z, cy, 'blocked fallback anchors on viewport center y')
  })

// §5 Pointer wheel zoom and pan preservation
uiTest('§5 pointer wheel zoom and pan remain untouched',
  async ({ host, viewport }) => {
    // Place a pin on the right
    await pin([{ id: 'qa', x: 600, y: 0, w: 400, h: VP_H }])
    const c0 = cam(host)

    // Wheel at specific pointer position (200, 300)
    const px = 200, py = 300
    const wx = (px - c0.x) / c0.z, wy = (py - c0.y) / c0.z

    const WheelEv = (W().window as unknown as { WheelEvent: typeof WheelEvent }).WheelEvent ?? WheelEvent
    await inAct(() => {
      viewport.dispatchEvent(new WheelEv('wheel', {
        bubbles: true, cancelable: true, clientX: px, clientY: py, deltaY: -100,
      }))
    })
    await flush()

    const c1 = cam(host)
    assert.ok(c1.z > c0.z, 'wheel zoom in increased scale')
    near(c1.x + wx * c1.z, px, 'wheel zoom anchored on mouse pointer x (200)')
    near(c1.y + wy * c1.z, py, 'wheel zoom anchored on mouse pointer y (300)')

    // Pan drag
    const beforePan = cam(host)
    await inAct(() => { viewport.dispatchEvent(pointer('pointerdown', 200, 200)) })
    await flush()
    await inAct(() => { viewport.dispatchEvent(pointer('pointermove', 250, 230)) })
    await flush()
    await inAct(() => { viewport.dispatchEvent(pointer('pointerup', 250, 230)) })
    await flush()

    const afterPan = cam(host)
    near(afterPan.x - beforePan.x, 50, 'pan delta x matches pointer move')
    near(afterPan.y - beforePan.y, 30, 'pan delta y matches pointer move')
  })
