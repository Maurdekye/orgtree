// followconv.test.tsx — the №25 camera-follow must let a focused card ARRIVE.
//
// The follow keeps the focused node at a fixed screen offset by subtracting its
// per-frame spring motion from the camera. That is exactly right while the
// layout re-anchors under a node that has already settled — a hire anywhere
// moves every target, and without the follow the desk you are typing into
// slides out of the window.
//
// It is a trap on a node that is still travelling. The distance the spring has
// left to go IS the distance the node is off-centre, so cancelling that motion
// pins the node off-centre permanently. It never arrives.
//
// The way in is a camera animation, because it suppresses the follow while it
// runs and hands it back the moment it lands. `centerOn` aims at the node's
// layout TARGET; if the spring is still short of that target when the glide
// ends, the follow engages on precisely the gap and freezes it.
//
// ---- on observing the JOURNEY rather than the destination -------------------
// A caution from `desk-view-on-init` says the rig cannot see how the camera
// travels, only where it arrives: the harness's rAF hands a MOCKED clock while
// `animateTo` stamps `t0` from the REAL one, so `k` is astronomically large on
// the first frame and every eased glide completes instantly. True — and it is
// why §3 below can drive a glide to completion in a single tick.
//
// It does NOT hold for the spring engine, which is where this defect lives.
// That loop computes `dt = Math.min(0.033, (t - last) / 1000)` and then sets
// `last = t`. The clamp swallows the one bogus first frame, and every frame
// after it is derived from the mocked clock alone — so the springs really do
// advance ~16ms per tick and the journey IS observable. §2 and §4 depend on
// that: they sample the card's screen position on the way, and would pass
// vacuously if the springs teleported. Both assert the sampling actually saw
// motion, so a rig change that reintroduced teleporting fails the test rather
// than quietly hollowing it out.
//
// jsdom does no layout, so everything here is read from the numbers the code
// writes into `transform` — the camera off `.space`, each card off its own
// `.sq` — never from measured geometry. In jsdom every rect is 0x0, which
// means the viewport's centre is (0, 0); that is what "centred" means below.
//
// Run:  cd frontend && node tests/run.mjs followconv

import { advance, flush, inAct, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { useState } from 'react'
import { NODE_H, NODE_W, Z_DESK } from '../src/canvas/shared'
import type { TreePayload } from '../src/types'

const noop = () => {}

// ------------------------------------------------------------------ fixture
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

// --------------------------------------------------------------- transforms
interface Cam { x: number; y: number; z: number }
type Pos = { x: number; y: number }
const XF = /translate\(\s*(-?[\d.]+)px\s*,\s*(-?[\d.]+)px\s*\)(?:\s*scale\(\s*([\d.]+)\s*\))?/

function parseXf(t: string, what: string): Cam {
  const m = XF.exec(t)
  assert.ok(m, `could not parse ${what} out of transform="${t}"`)
  return { x: Number(m![1]), y: Number(m![2]), z: m![3] ? Number(m![3]) : 1 }
}

const cam = (el: HTMLElement): Cam => {
  const space = el.querySelector('.space') as HTMLElement | null
  assert.ok(space, 'the canvas world element (.space) did not render')
  return parseXf(space!.style.transform, 'the camera')
}

/** an UNFOCUSED card's world position, found by the id it renders.
 *
 *  Two hooks, because the chrome depends on zoom: `.sq-head span.name` at norm
 *  zoom, `.mini-name` at mini zoom. A focused card renders NEITHER — its
 *  world-scaled head is removed entirely and the desk draws its own chrome —
 *  which is what `posFocused` is for. */
function posByName(el: HTMLElement, id: string): Pos {
  for (const sq of [...el.querySelectorAll('.sq')] as HTMLElement[]) {
    const hook = sq.querySelector('.sq-head span.name, .mini-name')
    if (hook && (hook.textContent ?? '').trim() === id) {
      return parseXf(sq.style.transform, `the "${id}" card position`)
    }
  }
  return assert.fail(`no unfocused card rendered for "${id}"`)
}

/** the FOCUSED card's world position. Reading it this way also asserts, on
 *  every single sample, that a focused card still exists — so a "fix" that
 *  quietly dropped focus fails here instead of measuring some other card.
 *  `:not(.user)` keeps the eye out, which also wears `desk` at switchboard. */
function posFocused(el: HTMLElement): Pos {
  const sq = el.querySelector('.sq.desk:not(.user)') as HTMLElement | null
  assert.ok(sq, 'no focused (desk) card is rendered')
  return parseXf(sq!.style.transform, 'the focused card position')
}

const centreOf = (el: HTMLElement, p: Pos): Pos => {
  const v = cam(el)
  return { x: (p.x + NODE_W / 2) * v.z + v.x, y: (p.y + NODE_H / 2) * v.z + v.y }
}
const focusedCentre = (el: HTMLElement) => centreOf(el, posFocused(el))
/** how far the focused card sits from the viewport centre, which under jsdom's
 *  0x0 rects is the origin */
const offCentre = (el: HTMLElement) => {
  const s = focusedCentre(el)
  return Math.hypot(s.x, s.y)
}
const dist = (a: Pos, b: Pos) => Math.hypot(a.x - b.x, a.y - b.y)

/** "close enough to centre to count as arrived" — comfortably under the
 *  hundreds of px the freeze produces, comfortably over spring rounding. */
const RESIDUAL = 2

/** Let the springs run for `ms` of SIMULATED time.
 *
 *  ⚠ The step size is load-bearing, and getting it wrong quietly under-runs
 *  the physics. `advance(ms)` defaults to 250ms chunks; each chunk fires every
 *  rAF callback due inside it, but they all read the same mocked `Date.now()`,
 *  so the spring loop sees `dt = (t - last)/1000` as a real number ONCE and
 *  then 0 for every callback after it in that chunk. A `advance(3000)` there-
 *  fore delivers about twelve 33ms integrations — 0.4s of spring time, not 3s
 *  — and the springs are still visibly travelling when the test believes they
 *  have settled. That reads exactly like a spring that never converges.
 *  Stepping at 16ms gives one integration per frame, which is the real thing. */
const settle = (ms: number) => advance(ms, 16)

// ------------------------------------------------------------------ events
// jsdom ships PointerEvent but not pointer capture, and the canvas captures on
// every pointerdown. Stubbed on the prototype, scoped to this file — the
// shared harness is deliberately left untouched, since every other suite in
// this folder runs under it.
function stubPointerCapture(): () => void {
  const proto = (globalThis as unknown as {
    HTMLElement: { prototype: Record<string, unknown> } }).HTMLElement.prototype
  const had = { s: proto.setPointerCapture, r: proto.releasePointerCapture }
  proto.setPointerCapture = noop
  proto.releasePointerCapture = noop
  return () => { proto.setPointerCapture = had.s; proto.releasePointerCapture = had.r }
}

function pointer(type: string, x: number, y: number): Event {
  const Ctor = (globalThis as unknown as {
    window: { PointerEvent: typeof PointerEvent } }).window.PointerEvent
  return new Ctor(type, {
    bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse',
    isPrimary: true, button: type === 'pointermove' ? -1 : 0, buttons: 1,
    clientX: x, clientY: y,
  })
}

function wheel(x: number, y: number, deltaY: number): WheelEvent {
  const Ctor = (globalThis as unknown as { WheelEvent: typeof WheelEvent }).WheelEvent
  return new Ctor('wheel', { bubbles: true, cancelable: true, deltaY, clientX: x, clientY: y })
}

// -------------------------------------------------------------------- rig
let canvasMod: typeof import('../src/canvas/OrgCanvas') | null = null

/** OrgCanvas with a settable tree, so a test can re-anchor the layout the way
 *  a hire does — the disturbance №25 exists to absorb. */
function makeHost() {
  const box: { set?: (t: TreePayload) => void } = {}
  const Host = ({ initial }: { initial: TreePayload }) => {
    const [t, setT] = useState(initial)
    box.set = setT
    const { OrgCanvas } = canvasMod!
    return <OrgCanvas tree={t} op={() => Promise.resolve({} as never)}
      slug="mine" toast={noop} mailEvt={null} />
  }
  return { Host, box }
}

function uiTest(name: string,
  body: (k: { mount: (el: React.ReactElement)
    => Promise<{ el: HTMLElement }> }) => Promise<void>): void {
  test(name, async (t: TestContext) => {
    useFakeClock()
    const unstub = stubPointerCapture()
    const open: { unmount: () => Promise<void> }[] = []
    t.after(async () => {
      for (const m of open) { try { await m.unmount() } catch { /* gone */ } }
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
  => Promise<{ el: HTMLElement }>, ids: string[]) {
  canvasMod = await import('../src/canvas/OrgCanvas')
  const { Host, box } = makeHost()
  const { el } = await mount(<Host initial={tree(ids)} />)
  await flush()
  const viewport = el.querySelector('.viewport') as HTMLElement | null
  assert.ok(viewport, 'the canvas viewport rendered')
  return { el, viewport: viewport!, setTree: (t: TreePayload) => box.set!(t) }
}

/** Mount, settle the opening drift, then put `id` under a desk-zoom camera
 *  centred on it — which is what makes it the focused node.
 *
 *  Driven entirely through the public gesture surface: a drag to bring the card
 *  to the viewport centre, then wheel notches AT that centre, which zoom about
 *  the cursor and so leave the card centred while the zoom climbs past Z_DESK.
 *
 *  ⚠ `advance(2500)` first: mounting schedules the opening drift on a rAF that
 *  sits pending under the mocked clock until something ticks it. Any later
 *  `advance()` would otherwise fire that intro INTO the gesture being measured. */
async function focusOn(el: HTMLElement, viewport: HTMLElement, id: string) {
  await settle(2500)
  const s = centreOf(el, posByName(el, id))
  await inAct(() => { viewport.dispatchEvent(pointer('pointerdown', 600, 600)) })
  await inAct(() => { viewport.dispatchEvent(pointer('pointermove', 600 - s.x, 600 - s.y)) })
  await inAct(() => { viewport.dispatchEvent(pointer('pointerup', 600 - s.x, 600 - s.y)) })
  await flush()
  const after = centreOf(el, posByName(el, id))
  assert.ok(Math.hypot(after.x, after.y) < 1,
    `panning did not put "${id}" at the viewport centre `
    + `(off by ${Math.hypot(after.x, after.y)})`)

  for (let i = 0; i < 40 && cam(el).z < Z_DESK * 1.1; i++) {
    await inAct(() => { viewport.dispatchEvent(wheel(0, 0, -300)) })
  }
  await flush()
  assert.ok(cam(el).z >= Z_DESK,
    `could not reach desk zoom (got z=${cam(el).z}, need ${Z_DESK})`)
  await settle(600)
  const desk = el.querySelector('.desk-over') as HTMLElement | null
  assert.ok(desk, `"${id}" did not become the focused desk at z=${cam(el).z}`)
  assert.ok(offCentre(el) < 1,
    `"${id}" focused but is not centred (off by ${offCentre(el)}px)`)
  return desk!
}

/** run the springs forward in real frames, sampling as they travel.
 *  Returns the worst screen deviation from `anchor`, and whether the card was
 *  ever actually seen to move (the guard against a vacuous pass). */
async function sampleGlide(el: HTMLElement, anchor: Pos, from: Pos) {
  let worst = 0, sawMotion = false
  for (let i = 0; i < 40; i++) {
    await advance(32, 16)
    if (dist(posFocused(el), from) > 1) sawMotion = true
    worst = Math.max(worst, dist(focusedCentre(el), anchor))
  }
  return { worst, sawMotion }
}

// ===================================================================== §1
// A settled focused node is unaffected — the baseline the other sections move
// away from, and a guard that focusing itself does not set the camera drifting.

uiTest('§1 a focused node that has already settled sits still',
  async ({ mount }) => {
    const { el, viewport } = await mountCanvas(mount, ['ceo', 'cto'])
    await focusOn(el, viewport, 'ceo')
    await settle(1500)
    assert.ok(offCentre(el) < 1,
      `a settled focused card drifted ${offCentre(el)}px off centre with `
      + 'nothing disturbing it')
  })

// ===================================================================== §2
// №25 ITSELF — the behaviour the fix must NOT cost. A hire re-anchors the
// layout under a settled focused node; the camera has to ride it so the desk
// does not slide out of the window.
//
// This is the leg that fails if someone "fixes" the freeze by weakening or
// disabling the follow — which a test that only checked the freeze was gone
// would happily accept.

uiTest('§2 the camera still rides a layout re-anchor under a settled node',
  async ({ mount }) => {
    const { el, viewport, setTree } = await mountCanvas(mount, ['ceo', 'cto'])
    await focusOn(el, viewport, 'ceo')
    const anchor = focusedCentre(el)
    const from = posFocused(el)

    await inAct(() => { setTree(tree(['ceo', 'cto', 'cfo', 'coo'])) })
    await flush()
    const { worst, sawMotion } = await sampleGlide(el, anchor, from)

    assert.ok(sawMotion,
      'the re-anchor never moved the card, so this section observed nothing — '
      + 'the fixture change must actually shift the layout')
    assert.ok(worst < 2,
      `the focused desk slid ${Math.round(worst)}px on screen while the layout `
      + 're-anchored under it. №25 is what stops that, so the follow has been '
      + 'weakened or disabled rather than fixed')
  })

// ===================================================================== §3
// THE DEFECT. A glide lands the camera on the node's TARGET while the node is
// still travelling toward it, then hands the follow back — which pins the
// remaining gap instead of letting the card arrive.

uiTest('§3 a card still in flight when a glide lands still arrives at centre',
  async ({ mount }) => {
    const { el, viewport, setTree } = await mountCanvas(mount, ['ceo', 'cto'])
    const desk = await focusOn(el, viewport, 'ceo')

    // re-anchor the layout, so 'ceo' has somewhere to travel...
    await inAct(() => { setTree(tree(['ceo', 'cto', 'cfo', 'coo'])) })
    await flush()
    // ...and recenter immediately, before the spring has got anywhere. The
    // glide aims at the TARGET; the card is still back where it started.
    await inAct(() => { desk.click() })
    await advance(32, 16)

    const midFlight = offCentre(el)
    assert.ok(midFlight > 50,
      'the card was supposed to still be well short of its target when the '
      + `glide landed — it is only ${midFlight}px off centre, so §3 is not `
      + 'reproducing the situation it exists to test')

    await settle(3000)
    const settled = offCentre(el)
    assert.ok(settled < RESIDUAL,
      `the focused card came to rest ${Math.round(settled)}px off centre and `
      + `stayed there (it was ${Math.round(midFlight)}px off when the glide `
      + 'landed). The follow engaged on a card that was still travelling and '
      + 'cancelled the rest of its motion out of the camera, freezing the gap.')
  })

// ===================================================================== §4
// Once it HAS arrived, the follow must engage — not stay permanently shy.
// Gating engagement on arrival could otherwise be "fixed" by never engaging at
// all, which §1-§3 alone would not catch.

uiTest('§4 after arriving, the follow engages and rides the next re-anchor',
  async ({ mount }) => {
    const { el, viewport, setTree } = await mountCanvas(mount, ['ceo', 'cto'])
    const desk = await focusOn(el, viewport, 'ceo')

    await inAct(() => { setTree(tree(['ceo', 'cto', 'cfo', 'coo'])) })
    await flush()
    await inAct(() => { desk.click() })
    await settle(3000)                       // arrive — this is §3's end state
    assert.ok(offCentre(el) < RESIDUAL,
      `precondition: the card arrived at centre (off by ${offCentre(el)}px)`)

    // now disturb it again. The follow should have engaged on arrival, and
    // must hold the desk still through this one.
    const anchor = focusedCentre(el)
    const from = posFocused(el)
    await inAct(() => { setTree(tree(['ceo', 'cto', 'cfo', 'coo', 'cro', 'cso'])) })
    await flush()
    const { worst, sawMotion } = await sampleGlide(el, anchor, from)

    assert.ok(sawMotion, 'the second re-anchor never moved the card')
    assert.ok(worst < 2,
      'once arrived, the follow must ride the next re-anchor — the desk slid '
      + `${Math.round(worst)}px, so engagement never happened`)
  })
