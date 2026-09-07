// dragzoom.test.tsx — zooming with the mouse wheel WHILE a canvas drag is in
// flight (user bug 2026-08-26: "the drag location is updated to a dramatically
// far away location, making all panels invisible").
//
// The mechanism. The background pan writes the camera ABSOLUTELY, not
// incrementally: `onPointerDown` snapshots `panRef = {sx, sy, ox: view.x,
// oy: view.y}` and every `onPointerMove` then sets `x = ox + (clientX - sx)`.
// The wheel handler zooms about the cursor, which necessarily rewrites x and y
// (`x = mx - wx*z`) — but it used to leave `panRef.ox/oy` holding the camera
// from pointerdown. So the very next pointermove threw the zoom's re-anchoring
// away and re-applied a PRE-zoom origin at the POST-zoom scale. That is not a
// small jitter: wx is a world coordinate and the eye sits at world x=6000, so
// one wheel notch mid-drag displaced the camera by thousands of px and every
// card left the window. Hence "all panels invisible".
//
// What this proves and what it cannot. jsdom does no layout — every rect is
// 0×0 and nothing has a real position (see the notes in render.test.tsx and
// agentstray.test.tsx). So this asserts on the NUMBERS THE CAMERA CODE ITSELF
// WRITES: the `translate(...) scale(...)` string on `.space`, which is the
// single source of truth for where the world sits on screen. The invariant is
// stated in world coordinates — "the point under the cursor stays under the
// cursor" — which is exactly the property the bug destroyed, and it is
// checkable from the transform alone without any measured geometry.
//
// Run:  cd frontend && node tests/run.mjs dragzoom

import { advance, flush, inAct, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import type { TreePayload } from '../src/types'

const noop = () => {}

// ------------------------------------------------------------------ fixture
// same idiom as agentstray/audpile/mailwire: shaped like the payload, trimmed
// to what OrgCanvas actually dereferences, cast rather than type-checked in
const asTree = (v: unknown) => v as TreePayload

function tree(nodeIds: string[]): TreePayload {
  const mk = (id: string) => ({
    id, title: id, tier: 'haiku', model_id: 'haiku', state: 'live',
    seat: 1, grant: 0, free: 0, ui_order: 0, cost_usd: 0, occupancy: null,
    context_window: null, charter: null, mail_pending: 0, limit_locked: false,
    last_status: null, prev_status: null, inflight_at: null, last_denials: [],
    turns: [], frozen: null, audiences_held: [], bearer_state: null,
    generation: 0, children: [], lineage: [],
    scope: { permission_mode: 'default', add_dirs: [], tools: {}, org_visibility: 'team' },
  })
  return asTree({
    slug: 'mine', name: 'mine', workspace: null, dirs: [], max_top_grant: 1000,
    default_top_grant: 50, compact_at: 0, default_tools: null,
    default_visibility: 'team', default_effort: '', credit_requests: [],
    tiers: { haiku: 1, sonnet: 3, opus: 5, fable: 10 }, audiences: [],
    roots: nodeIds.map(mk), cost_usd_total: 0,
    audit: { live_nodes: nodeIds.length, top_level_holds: 0, no_overdraft: true, problems: [] },
    user_inbox_count: 0, user_inbox_newest: null, fable_lock: null,
    spend_frozen: false, storage_blocked: false, auto_resume: false,
    fable_limit_policy: 'freeze', fable_filter_policy: 'halt',
    cascade_hire: false, cascade_alloc: true, sandboxed: false,
    audience_requests: [], org_inbox: null, net: null,
  })
}

// --------------------------------------------------------------- the camera
interface Cam { x: number; y: number; z: number }

/** the camera, read back out of the transform the canvas actually rendered.
 *  This is the whole observable surface under jsdom, and it is enough: the
 *  world's on-screen placement is nothing but these three numbers. */
function cam(el: HTMLElement): Cam {
  const space = el.querySelector('.space') as HTMLElement | null
  assert.ok(space, 'the canvas world element (.space) did not render')
  const t = space!.style.transform
  const m = /translate\(\s*(-?[\d.]+)px\s*,\s*(-?[\d.]+)px\s*\)\s*scale\(\s*([\d.]+)\s*\)/.exec(t)
  assert.ok(m, `could not parse the camera out of transform="${t}"`)
  return { x: Number(m![1]), y: Number(m![2]), z: Number(m![3]) }
}

/** screen point -> world point, the inverse of the rendered transform.
 *  jsdom's getBoundingClientRect is all zeros, which is also what the
 *  component's own `r.left`/`r.top` read, so client coords and viewport
 *  coords coincide here — the arithmetic under test is untouched by that. */
const world = (v: Cam, sx: number, sy: number) => (
  { x: (sx - v.x) / v.z, y: (sy - v.y) / v.z })

// ------------------------------------------------------------------ events
// jsdom ships PointerEvent but NOT pointer capture, and the canvas captures on
// every pointerdown. Stubbed on the prototype (scoped to this file — the
// shared harness is deliberately left alone) rather than faked per element,
// because React retargets through whatever element the capture landed on.
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

const PE = () => (globalThis as unknown as {
  window: { PointerEvent: typeof PointerEvent } }).window.PointerEvent

/** a real pointer gesture event, as the browser dispatches it: bubbling (React
 *  delegates from the root container), primary, left button. */
function pointer(type: string, x: number, y: number): Event {
  const Ctor = PE()
  return new Ctor(type, {
    bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse',
    isPrimary: true, button: type === 'pointermove' ? -1 : 0, buttons: 1,
    clientX: x, clientY: y,
  })
}

function wheel(x: number, y: number, deltaY: number): WheelEvent {
  const Ctor = (globalThis as unknown as { WheelEvent: typeof WheelEvent }).WheelEvent
  return new Ctor('wheel', {
    bubbles: true, cancelable: true, deltaY, clientX: x, clientY: y,
  })
}

// -------------------------------------------------------------------- rig
//
// ⚠ WHY AN EASED GLIDE NORMALLY FINISHES IN ONE FRAME HERE, AND HOW §6 GETS
// AROUND IT. `animateTo` stamps its start as `performance.now()` but receives
// each frame's `t` from the rAF shim, which hands out the MOCKED `Date.now()`.
// Those two have no common origin under the rig — mocked Date sits at epoch
// 1.7e12 while `performance.now()` is a few seconds since process start — so
// `k = (t - t0) / ms` is astronomically large on the very first frame and
// clamps straight to 1. Every glide completes instantly, and a test can only
// ever see where the camera ARRIVED, never how it travelled.
//
// That is fine for §5, which is about the endpoint. It is not fine for a fix
// that re-bases the pan on EVERY frame of a glide: a version that re-based
// only on the last frame would satisfy §5 exactly, while fighting the user's
// drag for the whole animation in a real browser.
//
// `syncClock` puts `performance.now()` on the same mocked clock the rAF shim
// uses, which is what a browser actually does (there both are real and share
// an origin). The glide then eases across genuine frames and the journey is
// observable. Scoped to the tests that ask for it and restored afterwards —
// the shared harness is deliberately untouched, since every other suite in
// this folder runs under it.
function stubPerfNow(): () => void {
  const perf = (globalThis as unknown as { performance: { now: () => number } }).performance
  const had = perf.now
  Object.defineProperty(perf, 'now', {
    value: () => Date.now(), configurable: true, writable: true,
  })
  return () => { Object.defineProperty(perf, 'now', { value: had, configurable: true, writable: true }) }
}

function uiTest(name: string,
  body: (k: { mount: (el: React.ReactElement)
    => Promise<{ el: HTMLElement }> }) => Promise<void>,
  opts: { syncClock?: boolean } = {}): void {
  test(name, async (t: TestContext) => {
    useFakeClock()
    const unstub = stubPointerCapture()
    // ⚠ after useFakeClock(), so `Date.now()` is already the mocked one
    const unperf = opts.syncClock ? stubPerfNow() : () => {}
    const open: { unmount: () => Promise<void> }[] = []
    t.after(async () => {
      for (const m of open) { try { await m.unmount() } catch { /* gone */ } }
      unperf()
      unstub()
      realClock()
    })
    await body({
      mount: async (el) => {
        const v = await mountView(el, (host) => host)
        open.push(v)
        return { el: v.el }
      },
    })
  })
}

async function mountCanvas(mount: (el: React.ReactElement)
  => Promise<{ el: HTMLElement }>) {
  const { OrgCanvas } = await import('../src/canvas/OrgCanvas')
  const { el } = await mount(
    <OrgCanvas tree={tree(['ceo', 'cto'])} op={() => Promise.resolve({} as never)}
      slug="mine" toast={noop} mailEvt={null} />)
  await flush()
  const viewport = el.querySelector('.viewport') as HTMLElement | null
  assert.ok(viewport, 'the canvas viewport rendered')
  // ⚠ let the OPENING DRIFT finish before any gesture. Mounting schedules an
  // intro glide (eye → whole tree) on a rAF, and under the mocked clock that
  // rAF just sits pending until something ticks the timers. A test that ticks
  // for its own reasons mid-gesture would then have the intro fire INTO its
  // gesture and cancel whatever it was measuring — which is a property of the
  // test rig, not of the bug, and it cost a confusing red before this line
  // existed. Settling here means every §ction below starts from a still camera.
  await advance(2500)
  return { el, viewport: viewport! }
}

// ===================================================================== §1
// The reported bug, as a gesture: press, drag, wheel, keep dragging.

uiTest('§1 a wheel mid-drag does not teleport the camera on the next drag move',
  async ({ mount }) => {
    const { el, viewport } = await mountCanvas(mount)

    const start = cam(el)
    await inAct(() => { viewport.dispatchEvent(pointer('pointerdown', 400, 300)) })
    await flush()

    // drag a little: the camera follows the pointer 1:1, unscaled
    await inAct(() => { viewport.dispatchEvent(pointer('pointermove', 450, 330)) })
    await flush()
    const dragged = cam(el)
    assert.equal(dragged.x, start.x + 50, 'the drag pans x by the raw pointer delta')
    assert.equal(dragged.y, start.y + 30, 'and y likewise')
    assert.equal(dragged.z, start.z, 'a drag must not change the zoom')

    // now zoom in, hard, without lifting the button — cursor still at 450,330.
    // The world point under the cursor is the one the user is looking at.
    const pinned = world(dragged, 450, 330)
    await inAct(() => { viewport.dispatchEvent(wheel(450, 330, -400)) })
    await flush()
    const zoomed = cam(el)
    assert.ok(zoomed.z > dragged.z, 'the wheel actually zoomed in')

    const atWheel = world(zoomed, 450, 330)
    assert.ok(Math.abs(atWheel.x - pinned.x) < 0.01
      && Math.abs(atWheel.y - pinned.y) < 0.01,
    'the wheel must zoom ABOUT THE CURSOR — the world point under it moved '
      + `from (${pinned.x}, ${pinned.y}) to (${atWheel.x}, ${atWheel.y})`)

    // ...and keep dragging. THIS is where the bug fired: the pan re-applied
    // the origin captured at pointerdown, at the new scale.
    await inAct(() => { viewport.dispatchEvent(pointer('pointermove', 460, 340)) })
    await flush()
    const after = cam(el)

    assert.equal(after.z, zoomed.z, 'continuing the drag must not undo the zoom')
    assert.equal(after.x, zoomed.x + 10,
      'after a mid-drag zoom the pan must continue from the ZOOMED camera — '
      + `expected x=${zoomed.x + 10}, got ${after.x} (a jump of `
      + `${Math.round(after.x - (zoomed.x + 10))}px the user never asked for)`)
    assert.equal(after.y, zoomed.y + 10, 'and y likewise')

    // stated the way the user experiences it: the thing under your cursor
    // stays under your cursor, give or take the 10px you actually moved
    const held = world(after, 460, 340)
    const slip = Math.hypot(held.x - pinned.x, held.y - pinned.y)
    assert.ok(slip < 10 / after.z + 0.01,
      `the world slid ${Math.round(slip)} world-px out from under a 10px drag `
      + '— this is the "dramatically far away location" from the bug report')
  })

// ===================================================================== §2
// The same gesture with SEVERAL notches, which is what a real scroll wheel or
// a trackpad emits. Two extra things break here if the fix is half-applied:
// the rebase has to survive repetition, and `viewRef` has to be written
// synchronously or the second notch zooms off a camera the first one replaced.

uiTest('§2 repeated notches mid-drag each compound, and the drag survives all of them',
  async ({ mount }) => {
    const { el, viewport } = await mountCanvas(mount)

    await inAct(() => { viewport.dispatchEvent(pointer('pointerdown', 400, 300)) })
    await inAct(() => { viewport.dispatchEvent(pointer('pointermove', 420, 320)) })
    await flush()

    const before = cam(el)
    const pinned = world(before, 420, 320)
    // four notches delivered back-to-back inside one commit window — no flush
    // between them, exactly as a trackpad burst arrives
    await inAct(() => {
      for (let i = 0; i < 4; i++) viewport.dispatchEvent(wheel(420, 320, -120))
    })
    await flush()
    const zoomed = cam(el)

    // each notch is exp(120 * 0.0012); four of them compound. If the handler
    // read a stale camera per notch they would collapse to roughly one.
    const one = Math.exp(120 * 0.0012)
    const want = Math.min(before.z * one ** 4, 8)   // Z_MAX guard
    assert.ok(Math.abs(zoomed.z - want) < 1e-6,
      `four notches must compound to z=${want}, got ${zoomed.z} — a stale `
      + 'camera read per notch collapses them toward a single notch '
      + `(z=${before.z * one})`)

    const atWheel = world(zoomed, 420, 320)
    assert.ok(Math.abs(atWheel.x - pinned.x) < 0.01
      && Math.abs(atWheel.y - pinned.y) < 0.01,
    'the cursor stays pinned across the whole burst')

    // the drag is still live and still coherent
    await inAct(() => { viewport.dispatchEvent(pointer('pointermove', 470, 380)) })
    await flush()
    const after = cam(el)
    assert.equal(after.x, zoomed.x + 50, 'the drag resumes from the zoomed camera')
    assert.equal(after.y, zoomed.y + 60, 'and y likewise')
    assert.equal(after.z, zoomed.z, 'and leaves the zoom alone')
  })

// ===================================================================== §3
// Zoom OUT mid-drag, and release. The rebase must not depend on the direction
// of the zoom, and lifting the pointer must not resurrect the stale origin.

uiTest('§3 zooming out mid-drag, then releasing, leaves the camera where it was left',
  async ({ mount }) => {
    const { el, viewport } = await mountCanvas(mount)

    await inAct(() => { viewport.dispatchEvent(pointer('pointerdown', 500, 400)) })
    await inAct(() => { viewport.dispatchEvent(pointer('pointermove', 600, 500)) })
    await flush()

    await inAct(() => { viewport.dispatchEvent(wheel(600, 500, 600)) })
    await flush()
    const zoomed = cam(el)
    assert.ok(zoomed.z < 1.6, 'the wheel zoomed out')

    await inAct(() => { viewport.dispatchEvent(pointer('pointermove', 580, 470)) })
    await flush()
    const after = cam(el)
    assert.equal(after.x, zoomed.x - 20, 'the pan continues from the zoomed camera')
    assert.equal(after.y, zoomed.y - 30, 'and y likewise')

    await inAct(() => { viewport.dispatchEvent(pointer('pointerup', 580, 470)) })
    await flush()
    assert.deepEqual(cam(el), after,
      'releasing the pointer must not move the camera at all')
  })

// ===================================================================== §4
// The plain wheel — no drag in flight — must be completely unaffected. The fix
// only rebases a pan that exists; nothing about ordinary zooming may change.

uiTest('§4 a wheel with no drag in flight still zooms about the cursor',
  async ({ mount }) => {
    const { el, viewport } = await mountCanvas(mount)
    const before = cam(el)
    const pinned = world(before, 300, 200)

    const evt = wheel(300, 200, -240)
    await inAct(() => { viewport.dispatchEvent(evt) })
    await flush()
    const after = cam(el)

    assert.equal(evt.defaultPrevented, true,
      'a wheel on the bare canvas is still captured for zoom')
    assert.ok(Math.abs(after.z - before.z * Math.exp(240 * 0.0012)) < 1e-6,
      'and zooms by exactly one wheel step')
    const at = world(after, 300, 200)
    assert.ok(Math.abs(at.x - pinned.x) < 0.01 && Math.abs(at.y - pinned.y) < 0.01,
      'about the cursor, as before')

    // and a drag STARTED AFTER the zoom picks up the zoomed camera, which is
    // the same invariant from the other side: pointerdown snapshots live state
    await inAct(() => { viewport.dispatchEvent(pointer('pointerdown', 300, 200)) })
    await inAct(() => { viewport.dispatchEvent(pointer('pointermove', 340, 250)) })
    await flush()
    const dragged = cam(el)
    assert.equal(dragged.x, after.x + 40, 'a fresh drag pans from the zoomed camera')
    assert.equal(dragged.y, after.y + 50, 'and y likewise')
  })

// ===================================================================== §5
// The SECOND doorway into the same bug. The wheel is not the only thing that
// moves the camera under a live drag: `animateTo` (the HUD ± buttons, centerOn,
// fitAll) drives x/y/z frame by frame, and it had the identical hole.
//
// pointerdown cancels a RUNNING animation, so this is only reachable when a
// glide STARTS during a drag — which centerOn's buried pile-member path does
// by deferring itself two frames, and which an auto-zoom-on-hire would do far
// more often. Asserting it here so the invariant is covered at both doorways
// rather than only at the one the user happened to find.

uiTest('§5 a glide that starts mid-drag also leaves the drag coherent',
  async ({ mount }) => {
    const { el, viewport } = await mountCanvas(mount)

    await inAct(() => { viewport.dispatchEvent(pointer('pointerdown', 400, 300)) })
    await inAct(() => { viewport.dispatchEvent(pointer('pointermove', 450, 330)) })
    await flush()
    const dragged = cam(el)

    // the HUD zoom button, pressed without releasing the drag — it stops
    // pointerdown propagation, so a click is exactly what reaches it
    const zin = [...el.querySelectorAll('.zoomhud button')]
      .find((b) => (b as HTMLElement).getAttribute('title') === 'zoom in') as HTMLElement
    assert.ok(zin, 'the zoom-in button rendered')
    await inAct(() => { zin.click() })
    await advance(200)          // let the glide run to its end
    const glided = cam(el)
    assert.ok(glided.z > dragged.z, 'the glide actually zoomed in')

    // ...and the drag continues. Without the rebase this snapped back to the
    // origin captured at pointerdown, at the glide's new scale.
    await inAct(() => { viewport.dispatchEvent(pointer('pointermove', 470, 360)) })
    await flush()
    const after = cam(el)
    assert.equal(after.z, glided.z, 'continuing the drag must not undo the glide')
    assert.equal(after.x, glided.x + 20,
      'after a mid-drag glide the pan must continue from the GLIDED camera — '
      + `expected x=${glided.x + 20}, got ${after.x}`)
    assert.equal(after.y, glided.y + 30, 'and y likewise')
  })

// ===================================================================== §6
// §5 WATCHES THE GLIDE LAND. THIS ONE WATCHES IT TRAVEL.
//
// The distinction is not academic, and I shipped the fix without it. The
// re-base runs on every frame of `animateTo`; §5 can only ever observe the
// last one, because an eased glide completes in a single frame under the rig
// (see the note on `stubPerfNow`). So a fix that re-based ONLY on the final
// frame passes §5 while, in a real browser, every intermediate frame throws
// the user's drag back to a stale origin — the camera fighting the pointer for
// the whole 220ms and snapping straight only at the end.
//
// With the clock stubbed onto the mocked one the glide eases over real frames,
// so this samples MID-flight: it interrupts a glide that is provably still
// running and requires the drag to be coherent right there, not eventually.

uiTest('§6 the pan stays coherent DURING a glide, not just once it lands',
  async ({ mount }) => {
    const { el, viewport } = await mountCanvas(mount)

    await inAct(() => { viewport.dispatchEvent(pointer('pointerdown', 400, 300)) })
    await inAct(() => { viewport.dispatchEvent(pointer('pointermove', 450, 330)) })
    await flush()
    const dragged = cam(el)

    const zin = [...el.querySelectorAll('.zoomhud button')]
      .find((b) => (b as HTMLElement).getAttribute('title') === 'zoom in') as HTMLElement
    assert.ok(zin, 'the zoom-in button rendered')
    await inAct(() => { zin.click() })

    // step into the MIDDLE of the 220ms glide, one frame at a time
    await advance(48, 16)
    const mid = cam(el)
    assert.ok(mid.z > dragged.z,
      'the glide should have started zooming by now')

    // prove it is genuinely still in flight — otherwise this section has
    // silently degenerated into §5 and proves nothing extra
    await advance(16, 16)
    const nxt = cam(el)
    assert.ok(nxt.z > mid.z,
      'the glide already finished, so §6 never observed the journey — the '
      + 'clock stub is not doing its job and this check has become a '
      + `duplicate of §5 (z went ${dragged.z} -> ${mid.z} -> ${nxt.z})`)

    // now interrupt it: keep dragging while the camera is still gliding. The
    // pan must continue from the camera as it stands THIS frame.
    await inAct(() => { viewport.dispatchEvent(pointer('pointermove', 460, 350)) })
    await flush()
    const after = cam(el)
    assert.equal(after.x, nxt.x + 10,
      'mid-glide, the pan must continue from the camera the glide has reached '
      + `on THIS frame — expected x=${nxt.x + 10}, got ${after.x}. A re-base `
      + 'that only runs on the final frame lands here.')
    assert.equal(after.y, nxt.y + 20, 'and y likewise')
  }, { syncClock: true })
