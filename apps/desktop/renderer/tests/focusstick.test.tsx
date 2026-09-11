// focusstick.test.tsx — a FOCUSED target stays fitted while the available
// canvas changes under it, exactly as "fit whole org" already did.
//
// User, 2026-09-11: they like that after clicking "fit the whole org" the
// canvas keeps re-fitting as the available space changes, until they drag or
// focus somewhere else — and asked for the switchboard and individual agent
// desks to behave the same way. The mechanism was a single boolean
// (`fitFollowing`) that only ever meant "the whole org"; it is now a camera
// INTENT (`CamIntent` in OrgCanvas.tsx) that also remembers a focused id.
// The release conditions are unchanged and shared: a manual pan, a wheel
// zoom, an unclaimed camera move, or another command taking the camera.
//
// ⚠ WHAT THIS SUITE CAN AND CANNOT SEE. jsdom does no layout: every rect is
// whatever the stub below says, and the camera is read as the numbers the
// component WROTE into `.space`'s transform. That is enough for every claim
// here, because none of them is "the desk visually fits" — they are all
// "which camera does this produce". The FITTING claim (a real painted desk
// inside the real free region after a real browser resize) is not answerable
// here and lives in `focusstick_probe.py`, which drives the same component in
// Edge.
//
// ANTI-VACUITY. No section invents a reference camera. Each one captures the
// camera a FRESH focus command produces at the new size — by clicking the
// desk, which re-centres it (swbrecenter.test.tsx owns that behaviour) — and
// requires the automatic refit to have landed on exactly that. Every section
// also asserts that this reference differs from the camera before the resize,
// so a canvas that ignored the resize entirely cannot pass by standing still.
// §3 and §6 are the other half: the cases where the camera must NOT move.
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs focusstick

import {
  advance, FakeServer, fireResize, flush, inAct, installFetch, mountView,
  realClock, useFakeClock,
} from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { OrgCanvas, resetCanvasSessionForTests } from '../src/canvas/OrgCanvas'
import { pinSurfaceKey, removePinSurface, updatePinSurface } from '../src/canvas/pinspace'
import { Z_DESK } from '../src/canvas/shared'
import { resetConvos } from '../src/convo'
import type { TreePayload } from '../src/types'

const noop = () => {}
const SLUG = 'stick'

// ---------------------------------------------------------------- fixtures
const asTree = (v: unknown) => v as TreePayload

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
  })
}

// ------------------------------------------------------------- the viewport
// The canvas measures its own element with getBoundingClientRect and watches
// it with a ResizeObserver. jsdom supplies neither a size nor an observer, so
// the size is stated here and the harness's fake observer delivers the change
// — which is precisely the production path: `viewportSize` ← ResizeObserver,
// and `regionOf`/`focusView`/`fitView` ← getBoundingClientRect.
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

// jsdom ships PointerEvent but no pointer capture, and the canvas captures on
// every pointerdown (pattern lifted from swbrecenter.test.tsx / dragzoom)
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

const W = () => globalThis as unknown as {
  window: { PointerEvent: typeof PointerEvent; MouseEvent: typeof MouseEvent
    WheelEvent: typeof WheelEvent } }

function pointer(type: string, x: number, y: number): Event {
  return new (W().window.PointerEvent)(type, {
    bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse',
    isPrimary: true, button: type === 'pointermove' ? -1 : 0, buttons: 1,
    clientX: x, clientY: y,
  })
}
const clickEv = (): Event =>
  new (W().window.MouseEvent)('click', { bubbles: true, cancelable: true })

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

const deskOf = (host: HTMLElement) => host.querySelector('.sq.desk:not(.user)')
const switchboard = (host: HTMLElement) => host.querySelector('.eye-desk')
const eyeCard = (host: HTMLElement) => {
  const el = host.querySelector('.sq.user')
  assert.ok(el, 'no eye card')
  return el
}
const cardOf = (host: HTMLElement, name: string) => {
  const el = [...host.querySelectorAll('.sq')]
    .find((c) => c.querySelector('.name')?.textContent === name)
  assert.ok(el, `no card for ${name}`)
  return el
}

// ------------------------------------------------------------- the gestures
async function clickCard(el: Element): Promise<void> {
  await inAct(() => { el.dispatchEvent(pointer('pointerdown', 200, 200)) })
  await flush()
  await inAct(() => { el.dispatchEvent(pointer('pointerup', 200, 200)) })
  await flush()
  await advance(1600)          // the glide, and the desk it opens
}

/** re-issue the focus command for whatever desk is open — the click-to-
 *  re-centre swbrecenter.test.tsx owns. This is the REFERENCE camera: what a
 *  fresh focus gesture produces at the CURRENT canvas size. */
async function reFocus(host: HTMLElement, sel: string): Promise<Cam> {
  const over = host.querySelector(sel)
  assert.ok(over, `nothing matching ${sel} to re-focus — the desk is not open`)
  await inAct(() => { over.dispatchEvent(clickEv()) })
  await flush()
  await advance(1600)
  return cam(host)
}

async function panAway(viewport: HTMLElement): Promise<void> {
  await inAct(() => { viewport.dispatchEvent(pointer('pointerdown', 400, 300)) })
  await flush()
  await inAct(() => { viewport.dispatchEvent(pointer('pointermove', 470, 350)) })
  await flush()
  await inAct(() => { viewport.dispatchEvent(pointer('pointerup', 470, 350)) })
  await flush()
  await advance(200)
}

/** state a new canvas size and deliver it the way a browser does */
async function resizeTo(viewport: HTMLElement, w: number, h: number): Promise<void> {
  VP = { w, h }
  await inAct(() => { fireResize(viewport) })
  await flush()
  await advance(1600)
}

// -------------------------------------------------------------- the driver
interface Kit {
  host: HTMLElement
  viewport: HTMLElement
  render: (ids: string[]) => Promise<void>
}
function uiTest(name: string, body: (k: Kit) => Promise<void>): void {
  test(name, async (t: TestContext) => {
    VP = { w: 1280, h: 800 }
    localStorage.clear()
    resetCanvasSessionForTests()
    useFakeClock()
    installFetch(new FakeServer())
    const unrect = stubViewportRect()
    const uncap = stubPointerCapture()
    const open: { unmount: () => Promise<void> }[] = []
    t.after(async () => {
      for (const m of open) { try { await m.unmount() } catch { /* gone */ } }
      uncap(); unrect(); resetConvos(); realClock(); localStorage.clear()
    })
    const canvas = (ids: string[]) => (
      <OrgCanvas tree={tree(ids)} op={() => Promise.resolve({} as never)}
        slug={SLUG} toast={noop} mailEvt={null} />
    )
    const v = await mountView(canvas(['ceo', 'cto']), (el) => el)
    open.push(v)
    await flush()
    const viewport = v.el.querySelector('.viewport') as HTMLElement | null
    assert.ok(viewport, 'the canvas viewport rendered')
    // let the OPENING DRIFT finish before any gesture: it is a rAF-scheduled
    // glide that would otherwise fire into the first advance() below
    await advance(2500)
    await body({
      host: v.el,
      viewport,
      render: async (ids) => { await v.render(canvas(ids)); await flush() },
    })
  })
}

// ==========================================================================
uiTest('§1 a focused agent desk re-fits when the canvas resizes', async ({ host, viewport }) => {
  await clickCard(cardOf(host, 'ceo'))
  assert.ok(deskOf(host), 'the click did not open the desk — nothing below is testable')
  const before = cam(host)
  assert.ok(before.z >= Z_DESK, `focused at z=${before.z}, under Z_DESK ${Z_DESK}`)

  await resizeTo(viewport, 860, 560)
  const after = cam(host)

  // the reference: what a FRESH focus command produces at the new size
  const fresh = await reFocus(host, '.sq.desk:not(.user) .desk-over')
  assert.ok(!same(fresh, before),
    'POSITIVE CONTROL FAILED: the correct camera for 860x560 is the same as '
    + `for 1280x800 (${show(before)}), so this resize asks nothing of the `
    + 'canvas and every assertion here is free')
  assert.ok(same(after, fresh),
    `the resize left the desk at ${show(after)}; a focus at this size lands at `
    + `${show(fresh)} — the desk did not re-fit into the new canvas`)
  assert.ok(deskOf(host), 'the desk closed across the resize')
})

// ==========================================================================
uiTest('§2 the focused SWITCHBOARD re-fits when the canvas resizes', async ({ host, viewport }) => {
  await clickCard(eyeCard(host))
  assert.ok(switchboard(host), 'the eye click did not open the switchboard')
  const before = cam(host)

  await resizeTo(viewport, 900, 700)
  const after = cam(host)
  assert.ok(switchboard(host),
    'the switchboard closed across the resize — a camera that lands right with '
    + 'the surface shut is not what was asked for')

  const fresh = await reFocus(host, '.eye-desk .eye-panels')
  assert.ok(!same(fresh, before),
    `POSITIVE CONTROL FAILED: 900x700 wants the same camera as 1280x800 (${show(before)})`)
  assert.ok(same(after, fresh),
    `the resize left the switchboard at ${show(after)}; a fresh focus at this `
    + `size lands at ${show(fresh)}`)
})

// ==========================================================================
uiTest('§3 RELEASE: a manual pan stops the follow, exactly as it does for the org fit',
  async ({ host, viewport }) => {
    await clickCard(cardOf(host, 'ceo'))
    assert.ok(deskOf(host), 'the desk did not open')
    await panAway(viewport)
    const panned = cam(host)

    await resizeTo(viewport, 880, 600)
    assert.ok(same(cam(host), panned),
      `the resize moved a hand-placed camera from ${show(panned)} to `
      + `${show(cam(host))} — a manual pan must relinquish the follow`)

    // …and the same rig DOES refit when the follow is live, so this section
    // cannot pass by the resize having gone undelivered
    const refitted = await reFocus(host, '.sq.desk:not(.user) .desk-over')
    await resizeTo(viewport, 1180, 760)
    assert.ok(!same(cam(host), refitted),
      'POSITIVE CONTROL FAILED: with the follow re-armed by a focus click, the '
      + 'second resize still moved nothing — the resize is not reaching the canvas')
  })

// ==========================================================================
uiTest('§4 RELEASE: a wheel zoom stops the follow', async ({ host, viewport }) => {
  await clickCard(cardOf(host, 'ceo'))
  await inAct(() => {
    viewport.dispatchEvent(new (W().window.WheelEvent)('wheel',
      { bubbles: true, cancelable: true, deltaY: -120, clientX: 400, clientY: 300 }))
  })
  await flush()
  await advance(400)
  const zoomed = cam(host)

  await resizeTo(viewport, 900, 640)
  assert.ok(same(cam(host), zoomed),
    `a wheel-chosen camera ${show(zoomed)} was replaced by an automatic fit `
    + `${show(cam(host))}`)
})

// ==========================================================================
uiTest('§5 focusing something else RETARGETS the follow', async ({ host, viewport }) => {
  await clickCard(cardOf(host, 'ceo'))
  assert.ok(deskOf(host), 'the ceo desk did not open')
  const onCeo = cam(host)

  // …now focus the EYE instead, and resize
  await clickCard(eyeCard(host))
  assert.ok(switchboard(host), 'the eye click did not open the switchboard')
  const onEye = cam(host)
  assert.ok(!same(onEye, onCeo), 'the second focus did not move the camera at all')

  await resizeTo(viewport, 980, 620)
  const after = cam(host)
  const fresh = await reFocus(host, '.eye-desk .eye-panels')
  assert.ok(same(after, fresh),
    `after retargeting to the switchboard the resize landed at ${show(after)}, `
    + `not at the switchboard's own camera ${show(fresh)}`)
  assert.ok(switchboard(host), 'the switchboard is not the surface that survived')
})

// ==========================================================================
uiTest('§6 a PINNED WINDOW opening re-fits the focused desk (not only a window resize)',
  async ({ host }) => {
    const key = pinSurfaceKey(SLUG, 'docket', true)
    try {
      await clickCard(cardOf(host, 'ceo'))
      assert.ok(deskOf(host), 'the desk did not open')
      const before = cam(host)

      // a pinned modal takes the right half of the canvas — the viewport never
      // changed size, only the space left inside it
      await inAct(() => updatePinSurface(key, SLUG, { x: 700, y: 0, w: 580, h: 800 }, true))
      await flush()
      await advance(1600)
      const after = cam(host)

      const fresh = await reFocus(host, '.sq.desk:not(.user) .desk-over')
      assert.ok(!same(fresh, before),
        'POSITIVE CONTROL FAILED: the pin left the correct camera unchanged, so '
        + 'this section asks nothing of the canvas')
      assert.ok(same(after, fresh),
        `the pin left the desk at ${show(after)}; focusing into the reduced `
        + `canvas lands at ${show(fresh)}`)
    } finally { removePinSurface(key) }
  })

// ==========================================================================
uiTest('§7 an unrelated org update does NOT re-aim the camera at the focused desk',
  async ({ host, render }) => {
    // the user's rule: the follow is for the AVAILABLE CANVAS. A hire landing
    // three branches away is not a resize, and must not move the camera while
    // they are reading. (The focused card MOVING is a different mechanism —
    // the per-frame spring follow in OrgCanvas's tick, which translates the
    // camera with the card instead of re-gliding to it.)
    await clickCard(cardOf(host, 'ceo'))
    assert.ok(deskOf(host), 'the desk did not open')
    const before = cam(host)

    // two more agents: the layout re-anchors and every card moves
    await render(['ceo', 'cto', 'qa', 'ops'])
    await advance(2500)
    const after = cam(host)

    const fresh = await reFocus(host, '.sq.desk:not(.user) .desk-over')
    assert.ok(!same(fresh, before),
      'POSITIVE CONTROL FAILED: the org update left the fitted camera exactly '
      + 'where it was, so "it did not re-aim" is not a claim this can test')
    assert.ok(!same(after, fresh),
      `the org update re-aimed the camera to the freshly-fitted ${show(fresh)} `
      + '— an update event moved the view with no resize behind it')
  })
