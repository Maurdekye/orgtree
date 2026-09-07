// swbrecenter.test.tsx — the switchboard re-centres on click, like a desk.
//
// User bug 2026-08-26: "clicking on an agent already in desk view re-centers
// the canvas on that agent. the same doesn't work for the switchboard;
// clicking it only focuses the switchboard if it's not already in desk view."
//
// The mechanism, established rather than inferred: a focused AGENT's desk is
// wrapped in `.desk-over` (desk.tsx), whose `onClick` calls `onRecenter`. The
// switchboard is the eye's desk and already wore the same `.desk-over` class —
// but it is built separately in cards.tsx (`EyeDesk`) and never got the
// handler. The eye's own card-level click is gated on `!focused`, so once the
// switchboard was open, nothing on it moved the camera at all.
//
// ⚠ WHAT THIS SUITE ASSERTS. jsdom does no layout — every rect is zeros — so
// the camera is read as the numbers this code WROTE into `.space`'s transform,
// never as measured geometry. That is enough here because the claim is about
// WHICH camera the click produces, and the reference camera is not a constant
// the test invents: §1 captures the camera the *unfocused* eye click produces,
// pans away, and requires the switchboard click to reproduce it exactly. So a
// click that did something drastic-but-plausible instead — `fitAll`, a zoom
// reset, a centre on the wrong node — fails, because those land elsewhere.
//
// ANTI-VACUITY, three ways:
//   §1 pans the camera FIRST and asserts it moved, so the re-centre cannot
//      pass by nothing having happened.
//   §2 is the reference behaviour it is mimicking — an AGENT desk, same
//      gesture, same reader. If §2 ever goes red, §1 is measuring the wrong
//      thing and the "parity" claim is empty.
//   §3 is the guard: a click on a CONTROL inside the switchboard must NOT
//      re-centre. Without it, "clicking the switchboard re-centres" would also
//      be satisfied by a handler that hijacks every click on it.
// Verified by mutation, not by inspection: with `onRecenter` unwired, §1 fails
// and §2/§3 stay green. §2 and §3 are SUPPOSED to survive that — they describe
// behaviour this change must not disturb, and a control that broke when the
// fix was removed would be measuring the fix rather than the surroundings.
//
// Run:  cd frontend && node tests/run.mjs swbrecenter

import {
  advance, FakeServer, flush, inAct, installFetch, mountView, realClock,
  useFakeClock,
} from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { OrgCanvas } from '../src/canvas/OrgCanvas'
import { Z_DESK } from '../src/canvas/shared'
import { resetConvos } from '../src/convo'
import type { TreePayload } from '../src/types'

const noop = () => {}

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

// ------------------------------------------------------------------ events
// jsdom ships PointerEvent but not pointer capture, and the canvas captures on
// every pointerdown. Stubbed on the prototype and scoped to this file — the
// shared harness is deliberately left alone, since every other suite in this
// folder runs under it. (Pattern lifted from dragzoom.test.tsx.)
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

function pointer(type: string, x: number, y: number): Event {
  const Ctor = W().window.PointerEvent
  return new Ctor(type, {
    bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse',
    isPrimary: true, button: type === 'pointermove' ? -1 : 0, buttons: 1,
    clientX: x, clientY: y,
  })
}

const clickEv = (): Event =>
  new (W().window.MouseEvent)('click', { bubbles: true, cancelable: true })

// ------------------------------------------------------------- the readers
function cam(host: HTMLElement): { x: number; y: number; z: number } {
  const space = host.querySelector('.space') as HTMLElement | null
  assert.ok(space, 'no .space element — the canvas did not render')
  const m = /translate\(([-\d.e+]+)px, ?([-\d.e+]+)px\) scale\(([-\d.e+]+)\)/
    .exec(space.style.transform)
  assert.ok(m, `unparsable world transform: ${space.style.transform}`)
  return { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) }
}

const same = (a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number }): boolean =>
  Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01
  && Math.abs(a.z - b.z) < 0.01

const show = (c: { x: number; y: number; z: number }) =>
  `(${c.x.toFixed(2)}, ${c.y.toFixed(2)}) @${c.z.toFixed(3)}`

/** the switchboard, open only while the eye holds focus */
const switchboard = (host: HTMLElement) => host.querySelector('.eye-desk')

// -------------------------------------------------------------- the driver
function uiTest(name: string,
  body: (k: { host: HTMLElement; viewport: HTMLElement }) => Promise<void>): void {
  test(name, async (t: TestContext) => {
    useFakeClock()
    installFetch(new FakeServer())
    const unstub = stubPointerCapture()
    const open: { unmount: () => Promise<void> }[] = []
    t.after(async () => {
      for (const m of open) { try { await m.unmount() } catch { /* gone */ } }
      unstub()
      resetConvos()
      realClock()
    })
    const v = await mountView(
      <OrgCanvas tree={tree(['ceo'])} op={() => Promise.resolve({} as never)}
        slug="mine" toast={noop} mailEvt={null} />, (el) => el)
    open.push(v)
    await flush()
    const viewport = v.el.querySelector('.viewport') as HTMLElement | null
    assert.ok(viewport, 'the canvas viewport rendered')
    // ⚠ let the OPENING DRIFT finish before any gesture. Mounting schedules an
    // intro glide on a rAF which, under the mocked clock, sits pending until
    // something ticks the timers — so it would otherwise fire INTO the first
    // gesture that advances time and cancel whatever was being measured.
    await advance(2500)
    await body({ host: v.el, viewport })
  })
}

// ------------------------------------------------------------- the gestures
/** click a card the way a mouse does: press and release without moving */
async function clickCard(el: Element): Promise<void> {
  await inAct(() => { el.dispatchEvent(pointer('pointerdown', 200, 200)) })
  await flush()
  await inAct(() => { el.dispatchEvent(pointer('pointerup', 200, 200)) })
  await flush()
  await advance(1200)          // the glide, and the desk it opens
}

/** drag the empty canvas so the camera is demonstrably somewhere else */
async function panAway(viewport: HTMLElement): Promise<void> {
  await inAct(() => { viewport.dispatchEvent(pointer('pointerdown', 400, 300)) })
  await flush()
  await inAct(() => { viewport.dispatchEvent(pointer('pointermove', 460, 340)) })
  await flush()
  await inAct(() => { viewport.dispatchEvent(pointer('pointerup', 460, 340)) })
  await flush()
}

const eyeCard = (host: HTMLElement) => {
  const el = host.querySelector('.sq.user')
  assert.ok(el, 'no eye card')
  return el
}

const agentCard = (host: HTMLElement) => {
  const el = [...host.querySelectorAll('.sq')].find((c) =>
    c.querySelector('.name')?.textContent === 'ceo')
  assert.ok(el, 'no card for ceo')
  return el
}

// ==========================================================================
uiTest('§1 clicking the switchboard while it is ALREADY open re-centres it',
  async ({ host, viewport }) => {
    await clickCard(eyeCard(host))
    assert.ok(switchboard(host),
      'the eye click did not open the switchboard — nothing below is testable')
    const focused = cam(host)
    assert.ok(focused.z >= Z_DESK,
      `the eye focused at z=${focused.z}, under Z_DESK ${Z_DESK}`)

    // move the camera off it, by a real drag on the empty canvas
    await panAway(viewport)
    const panned = cam(host)
    assert.ok(!same(panned, focused),
      `the pan did not move the camera — it is still ${show(focused)}, so a `
      + 're-centre would pass by having nothing to undo')
    assert.ok(switchboard(host),
      'the pan closed the switchboard — this must test the ALREADY-OPEN case, '
      + 'which is the whole bug')

    // …and click the switchboard's own empty space
    const panels = host.querySelector('.eye-panels')
    assert.ok(panels, 'no .eye-panels inside the switchboard')
    await inAct(() => { panels.dispatchEvent(clickEv()) })
    await flush()
    await advance(1200)

    const after = cam(host)
    assert.ok(same(after, focused),
      `clicking the open switchboard left the camera at ${show(after)}; it `
      + `should have returned to ${show(focused)} — the same camera the eye `
      + 'click produces when the switchboard is NOT already open')
    // …and it is still a re-CENTRE, not a retreat: a camera that lands in the
    // right place with the desk shut is not what was asked for
    assert.ok(switchboard(host),
      'the camera re-centred but the switchboard closed')
    assert.ok(after.z >= Z_DESK,
      `and it finished at z=${after.z}, under the desk threshold ${Z_DESK}`)
  })

// ==========================================================================
uiTest('§2 REFERENCE: an agent desk already open re-centres the same way',
  async ({ host, viewport }) => {
    // the behaviour §1 is mimicking. If this goes red, §1 proves no parity.
    await clickCard(agentCard(host))
    const desk = host.querySelector('.sq.desk:not(.user)')
    assert.ok(desk, 'the agent click did not open its desk')
    const focused = cam(host)

    await panAway(viewport)
    assert.ok(!same(cam(host), focused), 'the pan did not move the camera')

    const over = host.querySelector('.sq.desk:not(.user) .desk-over')
    assert.ok(over, 'no .desk-over on the focused agent card')
    await inAct(() => { over.dispatchEvent(clickEv()) })
    await flush()
    await advance(1200)

    assert.ok(same(cam(host), focused),
      `the agent desk did not re-centre: ${show(cam(host))} vs ${show(focused)}`)
  })

// ==========================================================================
uiTest('§3 GUARD: a click on a CONTROL in the switchboard does not re-centre',
  async ({ host, viewport }) => {
    // without this, "clicking the switchboard re-centres" is equally satisfied
    // by a handler that swallows every click on it — including the ones that
    // belong to the inbox button, the gear, the tab strip and the composer
    await clickCard(eyeCard(host))
    assert.ok(switchboard(host), 'the switchboard did not open')

    await panAway(viewport)
    const panned = cam(host)

    // ⚠ NOT `.eye-desk button` ANY MORE, and the reason matters. The first
    // button in the switchboard is now the tab's NAME, which navigates by
    // design (user rule 2026-09-05) — so it moves the camera on purpose and
    // is the one control this guard must not be tested with. The panel toggle
    // beside it is a genuine non-navigating control and is what the guard is
    // actually about.
    const btn = host.querySelector('.eye-tab-main')
    assert.ok(btn, 'no panel-toggle control inside the switchboard')
    const openBefore = host.querySelectorAll('.eye-panel').length
    await inAct(() => { btn.dispatchEvent(clickEv()) })
    await flush()
    await advance(1200)

    assert.ok(same(cam(host), panned),
      `a click on a switchboard CONTROL moved the camera from ${show(panned)} `
      + `to ${show(cam(host))} — the handler is stealing clicks meant for it`)
    // POSITIVE CONTROL: without it "the camera did not move" is equally
    // satisfied by a click that reached nothing at all.
    assert.notEqual(host.querySelectorAll('.eye-panel').length, openBefore,
      'CONTROL BROKEN: the panel toggle did nothing, so the assertion above '
      + 'proves only that a dead click moves no camera')
  })

// (There was a §4 here — "the re-centre leaves the switchboard open" — and it
// is gone rather than kept, because the mutation run caught it PASSING with
// the fix reverted. Of course it did: with no handler nothing happens at all,
// so the switchboard is trivially still open and the zoom trivially still at
// desk level. It read like a fourth guarantee and was an assertion about the
// starting state. Its one real claim — that the landing is a re-centre and
// not a retreat — now sits inside §1, after the assertion that the camera
// actually moved, where the fix has to work for it to be reached at all.)
