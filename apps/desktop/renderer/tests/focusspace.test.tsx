// focusspace.test.tsx — w14aace89: camera commands aim at the free space the
// pinned windows leave, and the switchboard is LAID OUT into that space.
//
// The geometry rule (user ruling 2026-09-05): the single largest pin-free
// rectangle BY AREA, chosen independently of what is being focused. The pure
// function is covered by clearrect.test.ts; THIS suite is the other half —
// the real production <OrgCanvas>, rendering real cards, measured through the
// DOM it actually writes.
//
// ⚠ WHY THE VIEWPORT IS STUBBED. jsdom does no layout: every
// getBoundingClientRect is 0x0, so an unstubbed canvas has no viewport to
// divide up and every rectangle here would be degenerate. Each rig therefore
// installs a MEASURED 1000x800 viewport, exactly as pins.test.tsx does for the
// same reason. That stub is the positive control for the whole file: §0 proves
// the rig can see the camera move at all before any assertion about WHERE.
//
// ⚠ WHAT IS MEASURED, AND WHAT IS NOT. The camera is read from the transform
// this code writes onto `.space`, and the switchboard's width from the inline
// width `cards.tsx` writes onto `.sq.user` — both are real rendered output of
// the production component, not a re-implementation. Real PIXEL placement and
// compositing still belong to a browser and are not claimed here.
//
// HOW THE CARD'S POSITION IS OBTAINED WITHOUT REACHING INTO THE COMPONENT.
// focusView puts the focused card's centre at the centre of the region, so
// screenCentre = cam.x + worldCx * z. Each test recovers worldCx from its OWN
// unpinned focus of the card it is about to test ((500 - cam.x) / z, 500 being
// the viewport centre), then pins and RE-CENTRES the same card. The assertions
// are therefore arithmetic on measured output, not numbers the suite invented.
// ⚠ The first cut cached worldCx from §0's card and reused it for a DIFFERENT
// card in later sections, which silently measured the wrong node. Derive it
// per test, per card.
//
// §0 negative control — no pins reproduces the old camera, and the rig moves
// §1 one pin — the card lands at the free region's centre, clear of the pin
// §2 several pins — still one region, still centred in it
// §3 overlapping pins are one union, not two obstacles
// §4 a fully offscreen pin changes nothing
// §5 the SWITCHBOARD's rendered width is constrained to the region
// §6 a fully covered canvas leaves the camera where it is
//
// Run:  cd frontend && node tests/run.mjs focusspace

import {
  advance, FakeServer, flush, inAct, installFetch, mountView, realClock,
  useFakeClock,
} from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { OrgCanvas } from '../src/canvas/OrgCanvas'
import { addPin, forgetPins } from '../src/canvas/pins'
import { USER_W } from '../src/canvas/shared'
import { resetConvos } from '../src/convo'
import type { TreePayload } from '../src/types'

const noop = () => {}
const asTree = (v: unknown) => v as TreePayload

const VP_W = 1000, VP_H = 800
const GAP = 12                       // clearRect.PIN_GAP, restated so a silent
                                     // change to it fails here too
// ⚠ EVERY FIXTURE PIN IS AT OR ABOVE THE PIN SIZE FLOOR. pins.tsx `sizeFloor`
// grows any window to at least PIN_MIN_W x PIN_MIN_H (320x240), so a fixture
// asking for a 300x200 pin silently becomes 320x240 and every edge derived
// from it is 20px out. The first cut of this file did exactly that and the
// off-by-20 read as a bug in the region maths rather than in the fixture.

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
  window: { PointerEvent: typeof PointerEvent; MouseEvent: typeof MouseEvent } }

const clickEv = (): Event =>
  new (W().window.MouseEvent)('click', { bubbles: true, cancelable: true })

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
  const m = /translate\(([-\d.e+]+)px, ?([-\d.e+]+)px\) scale\(([-\d.e+]+)\)/
    .exec(space.style.transform)
  assert.ok(m, `unparsable world transform: ${space.style.transform}`)
  return { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) }
}

/** measure the viewport, the way a browser would and jsdom will not */
function measure(el: HTMLElement, w = VP_W, h = VP_H): void {
  Object.defineProperty(el, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ x: 0, y: 0, top: 0, left: 0, right: w, bottom: h,
      width: w, height: h, toJSON: () => ({}) }),
  })
}

/** the open switchboard itself. Presence is the FOCUS WITNESS: the eye's
 *  width alone cannot serve, because `cards.tsx` clamps a focused eye to
 *  USER_W in a narrow region — the identical number an UNFOCUSED eye shows.
 *  §5b passed on that ambiguity before this was added. */
const switchboard = (host: HTMLElement) => host.querySelector('.eye-desk')

const eyeCard = (host: HTMLElement): HTMLElement => {
  const el = host.querySelector('.sq.user') as HTMLElement | null
  assert.ok(el, 'no eye card')
  return el
}

const agentCard = (host: HTMLElement, name: string): Element => {
  const el = [...host.querySelectorAll('.sq')].find((c) =>
    c.querySelector('.name')?.textContent === name)
  assert.ok(el, `no card for ${name}`)
  return el
}

async function clickCard(el: Element): Promise<void> {
  await inAct(() => { el.dispatchEvent(pointer('pointerdown', 200, 200)) })
  await flush()
  await inAct(() => { el.dispatchEvent(pointer('pointerup', 200, 200)) })
  await flush()
  await advance(1200)
}

/** Re-centre the ALREADY-FOCUSED node. Once a card is focused its desk opens
 *  and the `.name` element is gone, so the card cannot be clicked a second
 *  time; `.desk-over` is the desk's own re-centre handler (the behaviour
 *  swbrecenter.test.tsx establishes) and it re-runs focusView for the same
 *  node. That is what lets each test measure ONE card under two pin
 *  configurations without the layout or the target changing underneath it. */
async function recentre(host: HTMLElement, eye = false): Promise<void> {
  // ⚠ TWO THINGS THIS GOT WRONG FIRST, both of which read as "the feature does
  // nothing" rather than as a broken test:
  //   1. SELECTOR. A PINNED window is a sibling of `.space`, never inside it
  //      (pins.tsx — that structure is what makes a pin immune to the camera),
  //      and it renders a desk wearing `.desk-over` too. A bare
  //      `.desk-over` query matched a PINNED agent's desk and re-centred
  //      nothing. The focused agent's desk is `.sq.desk:not(.user)`.
  //   2. EVENT. `.desk-over` carries an onClick, so it needs a real `click`.
  //      Firing pointerdown/up at it (as opening a card does) does nothing at
  //      all — the camera simply stayed where the first focus left it, which
  //      looked exactly like "pins are being ignored".
  // Both are established by swbrecenter.test.tsx §1/§2, which is the suite
  // that defines this re-centre gesture; this only reuses it.
  const sel = eye ? '.eye-panels' : '.sq.desk:not(.user) .desk-over'
  const over = host.querySelector(sel)
  assert.ok(over, `no ${sel} — nothing focused to re-centre`)
  await inAct(() => { over.dispatchEvent(clickEv()) })
  await flush()
  await advance(1200)
}

/** drag the empty canvas so the camera is demonstrably somewhere else */
async function panAway(viewport: HTMLElement): Promise<void> {
  await inAct(() => { viewport.dispatchEvent(pointer('pointerdown', 400, 300)) })
  await flush()
  await inAct(() => { viewport.dispatchEvent(pointer('pointermove', 470, 350)) })
  await flush()
  await inAct(() => { viewport.dispatchEvent(pointer('pointerup', 470, 350)) })
  await flush()
}

interface Kit { host: HTMLElement; viewport: HTMLElement }

/** Mount the real canvas with a MEASURED viewport and the given pins already
 *  placed, then focus `focus` and report the camera and the eye's width. */
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
    // let the opening glide finish before anything is measured
    await advance(2500)
    await body({ host: v.el, viewport })
  })
}

/** place pins and let the canvas re-render around them */
async function pin(rects: { id: string; x: number; y: number; w: number; h: number }[]) {
  await inAct(() => {
    for (const r of rects) addPin('mine', r.id, { x: r.x, y: r.y, w: r.w, h: r.h })
  })
  await flush()
}

/** The world-space x of ceo's card centre, recovered from an UNPINNED focus:
 *  focusView puts that centre at the viewport centre, so worldCx follows from
 *  the measured camera. Cached across tests — it is a property of the layout,
 *  not of any one scenario. */
const near = (got: number, want: number, what: string, tol = 0.75) =>
  assert.ok(Math.abs(got - want) <= tol,
    `${what}: got ${got.toFixed(2)}, wanted ~${want.toFixed(2)}`)

// ==========================================================================
// Every test derives the focused card's world centre from its OWN unpinned
// focus, then pins and re-focuses THE SAME card. That is what makes each
// scenario self-contained: an earlier test's card sits somewhere else in the
// layout, so a cached constant would silently measure the wrong node (it did,
// on the first cut of this file).

/** focus `name` with no pins and return its world-space centre */
async function baseline(host: HTMLElement, name: string):
Promise<{ cx: number; cy: number; cam: Cam }> {
  const before = cam(host)
  await clickCard(agentCard(host, name))
  const c = cam(host)
  assert.ok(before.x !== c.x || before.z !== c.z,
    'the camera did not move — the rig cannot see focus, so this test would '
    + 'be vacuous whatever it asserted next')
  return { cx: (VP_W / 2 - c.x) / c.z, cy: (VP_H / 2 - c.y) / c.z, cam: c }
}

uiTest('§0 negative control: with no pins the card centres on the viewport',
  async ({ host }) => {
    const b = await baseline(host, 'ceo')
    near(b.cam.x + b.cx * b.cam.z, VP_W / 2, 'unpinned screen centre x')
    near(b.cam.y + b.cy * b.cam.z, VP_H / 2, 'unpinned screen centre y')
  })

uiTest('§1 one pin on the left: the card lands at the centre of the free '
  + 'region, and clear of the pin', async ({ host }) => {
  const b = await baseline(host, 'cto')
  await pin([{ id: 'qa', x: 0, y: 0, w: 400, h: VP_H }])
  await recentre(host)
  const c = cam(host)
  const sx = c.x + b.cx * c.z
  const regionX = 400 + GAP                       // 412
  near(sx, regionX + (VP_W - regionX) / 2, 'card centre sits at region centre')
  near(c.y + b.cy * c.z, VP_H / 2, 'full-height region leaves y centred')
  // HIT EVIDENCE: the whole point of the item. The old viewport-centred camera
  // put this at 500 — underneath the pin.
  assert.ok(sx > 400 + GAP, `card centre ${sx.toFixed(1)} is clear of the pin`)
  assert.ok(Math.abs(sx - VP_W / 2) > 100, 'and it is NOT the old viewport centre')
})

uiTest('§2 several pins: still one region, still centred in it',
  async ({ host }) => {
    const b = await baseline(host, 'cto')
    await pin([
      { id: 'qa', x: 0, y: 0, w: VP_W, h: 240 },
      { id: 'ops', x: 0, y: 0, w: 320, h: VP_H },
    ])
    await recentre(host)
    const c = cam(host)
    // a full-width band across the top (0..240 -> 0..252 with the gap) and a
    // full-height column down the left (0..320 -> 0..332). The only hole left
    // is the bottom-right block, and it is ONE rectangle, not the two strips
    // added together.
    const x0 = 320 + GAP, y0 = 240 + GAP
    near(c.x + b.cx * c.z, x0 + (VP_W - x0) / 2, 'x centred in the hole')
    near(c.y + b.cy * c.z, y0 + (VP_H - y0) / 2, 'y centred in the hole')
  })

uiTest('§3 overlapping pins are ONE union, not two obstacles',
  async ({ host }) => {
    const b = await baseline(host, 'cto')
    await pin([
      { id: 'qa', x: 0, y: 0, w: 320, h: VP_H },
      { id: 'ops', x: 200, y: 0, w: 320, h: VP_H },
    ])
    await recentre(host)
    const c = cam(host)
    // 0..320 and 200..520 overlap; their UNION spans 0..520, so the obstacle
    // ends at 532 and the region is 532..1000. Counting the two pins
    // separately would put the edge somewhere else entirely.
    const x0 = 520 + GAP
    near(c.x + b.cx * c.z, x0 + (VP_W - x0) / 2, 'union counted once')
  })

uiTest('§4 a fully offscreen pin changes nothing — and this is also the '
  + 'control proving that pinning an agent does not move the layout',
async ({ host }) => {
  const b = await baseline(host, 'cto')
  await pin([{ id: 'qa', x: 4000, y: 4000, w: 320, h: 240 }])
  await recentre(host)
  const c = cam(host)
  near(c.x + b.cx * c.z, VP_W / 2, 'offscreen pin must not shift the camera')
  near(c.y + b.cy * c.z, VP_H / 2, 'offscreen pin must not shift the camera')
})

uiTest('§5 the switchboard is LAID OUT into the region, not merely centred',
  async ({ host }) => {
    await clickCard(eyeCard(host))
    assert.ok(switchboard(host), 'the eye click did not open the switchboard')
    const bare = Number(eyeCard(host).style.width.replace('px', ''))
    assert.ok(bare > USER_W,
      `the focused switchboard expands past the plain square (got ${bare})`)
    assert.equal(bare, Math.round(USER_W * (VP_W - 48) / (VP_H - 48)),
      'unpinned width follows the viewport aspect')

    // a BOTTOM pin leaves a wide, short region: the switchboard must widen to
    // THAT aspect. This is rendered layout, not camera framing.
    await pin([{ id: 'qa', x: 0, y: 400, w: VP_W, h: 400 }])
    await recentre(host, true)
    assert.ok(switchboard(host),
      'the switchboard closed once a pin appeared — the eye-focus gate must '
      + 'measure "screen-filling" against the FREE REGION, not the viewport')
    const wide = Number(eyeCard(host).style.width.replace('px', ''))
    const regionH = 400 - GAP                       // 388
    assert.equal(wide, Math.round(USER_W * (VP_W - 48) / (regionH - 48)),
      'the switchboard width follows the FREE REGION aspect')
    assert.ok(wide > bare,
      `a wide/short region widens the switchboard (${wide} > ${bare})`)
  })

uiTest('§5b a narrow region shrinks the switchboard, and it STAYS OPEN',
  async ({ host }) => {
    await clickCard(eyeCard(host))
    const bare = Number(eyeCard(host).style.width.replace('px', ''))
    await pin([{ id: 'qa', x: 600, y: 0, w: 400, h: VP_H }])
    await recentre(host, true)
    // ⚠ THE WIDTH ALONE CANNOT CARRY THIS SECTION. A right-hand pin leaves a
    // region narrower than it is tall, so the focused eye clamps to USER_W —
    // the very number an UNFOCUSED eye renders. Without the switchboard
    // presence check below, this test passed while the switchboard was in
    // fact closed, which is how the eye-focus gate bug hid.
    assert.ok(switchboard(host),
      'the switchboard must stay open in a reduced region, not collapse')
    const narrow = Number(eyeCard(host).style.width.replace('px', ''))
    assert.ok(narrow < bare,
      `a narrow region must not keep the full-screen width (${narrow} < ${bare})`)
    assert.ok(narrow >= USER_W,
      'but never narrower than the plain square the eye already is')
  })

uiTest('§6 a fully covered canvas leaves the camera exactly where it is',
  async ({ host, viewport }) => {
    await clickCard(agentCard(host, 'ceo'))
    const focused = cam(host)
    // ⚠ PAN FIRST, or this section is vacuous: re-centring a node that is
    // ALREADY centred reproduces the same camera anyway, so "it did not move"
    // would pass against a build that ignored the pins entirely. After a pan
    // the honest answer (stay put) and the wrong answer (snap back to the
    // card) are different numbers.
    await panAway(viewport)
    const panned = cam(host)
    assert.notDeepEqual(panned, focused, 'the pan moved the camera')
    await pin([{ id: 'qa', x: 0, y: 0, w: VP_W, h: VP_H }])
    await recentre(host)
    assert.deepEqual(cam(host), panned,
      'with no free space at all the camera must stay where the user left it')
  })
