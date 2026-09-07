// eyepressleak.test.tsx — clicking an AGENT focused the SWITCHBOARD (user bug
// 2026-09-07 11:23Z: "sometimes clicking any agent focuses the switchboard
// instead of the selected agent; dragging the canvas fixes it").
//
// The mechanism. The viewport's onPointerDown records where a gesture STARTED
// in `eyePressRef` (`closest('.sq.user')`), and its onPointerUp turns a still
// release with that flag set into `centerOn(USER)` — the desktop click-to-
// focus for the eye, which had to move up here because the viewport's pointer
// capture stops the eye's own onPointerUp from ever firing. The flag was
// written on every viewport pointerdown and CLEARED NOWHERE. An agent card's
// pointerdown (startNodeDrag) stops propagation, so a press on a card never
// reaches the viewport's onPointerDown and the flag keeps whatever the LAST
// viewport press left in it — while the card's pointerup DOES bubble to the
// viewport's onPointerUp (bubbling walks up from the capturing card). So:
// click the eye once (flag := true, switchboard opens), zoom back out (focus
// clears, so the `focusId !== USER` guard opens), click any agent: the card's
// endNodeDrag glides to the agent, then the viewport's onPointerUp sees the
// stale flag and glides to the eye instead. The last writer wins. Every agent
// click from then on lands on the switchboard, until a press on the empty
// canvas — a drag — re-evaluates the flag to false. That is the user's
// "dragging the canvas fixes it".
//
// Under jsdom no rect has a size (every getBoundingClientRect is zero), so a
// focus lands the camera at translate(-(p.x + NODE_W/2)·z, -(p.y + NODE_H/2)·z)
// with z = Z_DESK: the camera transform names the card it focused. The tests
// compare the camera after the suspect click against the camera the SAME click
// produces on a fresh canvas (§REF), so nothing here depends on layout numbers.
//
// Run:  cd frontend && node tests/run.mjs eyepressleak

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

// jsdom has PointerEvent but no pointer capture; the canvas captures on every
// pointerdown (viewport and card alike). Stubbed on the prototype, file-scoped.
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
  window: { PointerEvent: typeof PointerEvent; WheelEvent: typeof WheelEvent } }

function pointer(type: string, x: number, y: number): Event {
  return new (W().window.PointerEvent)(type, {
    bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse',
    isPrimary: true, button: type === 'pointermove' ? -1 : 0, buttons: 1,
    clientX: x, clientY: y,
  })
}

function wheel(x: number, y: number, deltaY: number): Event {
  return new (W().window.WheelEvent)('wheel', {
    bubbles: true, cancelable: true, deltaY, clientX: x, clientY: y,
  })
}

type Cam = { x: number; y: number; z: number }
function cam(host: HTMLElement): Cam {
  const space = host.querySelector('.space') as HTMLElement | null
  assert.ok(space, 'no .space element — the canvas did not render')
  const m = /translate\(([-\d.e+]+)px, ?([-\d.e+]+)px\) scale\(([-\d.e+]+)\)/
    .exec(space.style.transform)
  assert.ok(m, `unparsable world transform: ${space.style.transform}`)
  return { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) }
}
const same = (a: Cam, b: Cam): boolean =>
  Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01 && Math.abs(a.z - b.z) < 0.01
const show = (c: Cam) => `(${c.x.toFixed(2)}, ${c.y.toFixed(2)}) @${c.z.toFixed(3)}`

/** the switchboard, open only while the eye holds focus */
const switchboard = (host: HTMLElement) => host.querySelector('.eye-desk')
/** an agent's desk, open only while that agent holds focus */
const agentDesk = (host: HTMLElement) => host.querySelector('.sq.desk:not(.user)')

const eyeCard = (host: HTMLElement) => {
  const el = host.querySelector('.sq.user')
  assert.ok(el, 'no eye card')
  return el
}
const agentCard = (host: HTMLElement, id: string) => {
  const el = [...host.querySelectorAll('.sq')].find((c) =>
    c.querySelector('.name')?.textContent === id)
  assert.ok(el, `no card for ${id}`)
  return el
}

/** click a card the way a mouse does: press and release without moving */
async function clickCard(el: Element): Promise<void> {
  await inAct(() => { el.dispatchEvent(pointer('pointerdown', 200, 200)) })
  await flush()
  await inAct(() => { el.dispatchEvent(pointer('pointerup', 200, 200)) })
  await flush()
  await advance(1200)          // the glide, and the desk it opens
}

/** zoom back out on the empty canvas until no desk holds focus */
async function zoomOut(host: HTMLElement, viewport: HTMLElement): Promise<void> {
  for (let i = 0; i < 40 && cam(host).z >= Z_DESK; i++) {
    await inAct(() => { viewport.dispatchEvent(wheel(400, 300, 300)) })
    await flush()
  }
  await advance(600)
  assert.ok(cam(host).z < Z_DESK, `could not zoom below Z_DESK: ${show(cam(host))}`)
  assert.ok(!switchboard(host) && !agentDesk(host), 'a desk is still open after zooming out')
}

/** the user's workaround: drag the empty canvas a little */
async function dragCanvas(viewport: HTMLElement): Promise<void> {
  await inAct(() => { viewport.dispatchEvent(pointer('pointerdown', 400, 300)) })
  await flush()
  await inAct(() => { viewport.dispatchEvent(pointer('pointermove', 460, 340)) })
  await flush()
  await inAct(() => { viewport.dispatchEvent(pointer('pointerup', 460, 340)) })
  await flush()
}

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
      <OrgCanvas tree={tree(['ceo', 'cto'])} op={() => Promise.resolve({} as never)}
        slug="mine" toast={noop} mailEvt={null} />, (el) => el)
    open.push(v)
    await flush()
    const viewport = v.el.querySelector('.viewport') as HTMLElement | null
    assert.ok(viewport, 'the canvas viewport rendered')
    // let the opening drift finish before any gesture (see swbrecenter.test.tsx)
    await advance(2500)
    await body({ host: v.el, viewport })
  })
}

// ==========================================================================
// §REF — what an agent click produces on a canvas nobody has touched. §1 and
// §2 compare against this, so the reference itself must be a real focus.
let refCam: Cam | null = null
uiTest('§REF clicking an agent on a fresh canvas focuses THAT agent',
  async ({ host }) => {
    await clickCard(agentCard(host, 'ceo'))
    assert.ok(agentDesk(host), 'the agent click opened no desk')
    assert.ok(!switchboard(host), 'the agent click opened the switchboard')
    refCam = cam(host)
    assert.ok(refCam.z >= Z_DESK, `focused at ${show(refCam)}, under Z_DESK`)
  })

// ==========================================================================
// §1 — THE BUG, as the user does it: eye, zoom out, agent.
uiTest('§1 after an eye click and a zoom-out, clicking an agent focuses the AGENT, not the switchboard',
  async ({ host, viewport }) => {
    assert.ok(refCam, '§REF did not run')
    await clickCard(eyeCard(host))
    assert.ok(switchboard(host),
      'the eye click did not open the switchboard — the flag under test was never set')
    const eyeCam = cam(host)
    await zoomOut(host, viewport)

    await clickCard(agentCard(host, 'ceo'))
    const after = cam(host)
    assert.ok(!switchboard(host),
      `clicking the agent opened the SWITCHBOARD (camera ${show(after)}, the eye's `
      + `own camera is ${show(eyeCam)}) — the stale eye-press flag from the earlier `
      + 'eye click re-targeted the release')
    assert.ok(agentDesk(host), 'the agent click opened no desk at all')
    assert.ok(same(after, refCam!),
      `the agent click landed at ${show(after)}, but the same click on a fresh `
      + `canvas lands at ${show(refCam!)}`)
  })

// ==========================================================================
// §2 — the user's WORKAROUND, kept as the control that the rig can produce the
// right answer in this very sequence: a drag on the empty canvas between the
// eye click and the agent click re-evaluates the flag.
uiTest('§2 CONTROL: the same sequence with a canvas drag in between focuses the agent',
  async ({ host, viewport }) => {
    assert.ok(refCam, '§REF did not run')
    await clickCard(eyeCard(host))
    assert.ok(switchboard(host), 'the eye click did not open the switchboard')
    await zoomOut(host, viewport)
    await dragCanvas(viewport)
    await clickCard(agentCard(host, 'ceo'))
    assert.ok(agentDesk(host) && !switchboard(host),
      'even after a drag, the agent click did not focus the agent — the rig '
      + 'cannot show the correct outcome, so §1 proves nothing')
    assert.ok(same(cam(host), refCam!), `landed at ${show(cam(host))}, reference ${show(refCam!)}`)
  })

// ==========================================================================
// §1b — the ONE-GESTURE trigger (redteam-opus, review 2026-09-07 13:45Z): a
// press that starts on the eye and DRAGS. No switchboard opens and no zoom-out
// is needed — the release is `moved`, so the eye branch never consumes the
// flag, and the very next agent click goes to the switchboard. The eye sits
// centrally and is a natural place to grab to pan (allowed since 2026-09-03),
// so this is probably the common accident behind "sometimes ANY agent".
uiTest('§1b a pan that STARTS on the eye must not send the next agent click to the switchboard',
  async ({ host }) => {
    assert.ok(refCam, '§REF did not run')
    const eye = eyeCard(host)
    await inAct(() => { eye.dispatchEvent(pointer('pointerdown', 200, 200)) })
    await flush()
    await inAct(() => { eye.dispatchEvent(pointer('pointermove', 260, 240)) })
    await flush()
    await inAct(() => { eye.dispatchEvent(pointer('pointerup', 260, 240)) })
    await flush()
    await advance(600)
    assert.ok(!switchboard(host), 'a drag from the eye opened the switchboard — not the case under test')

    await clickCard(agentCard(host, 'ceo'))
    assert.ok(!switchboard(host),
      `after a pan that began on the eye, the agent click opened the SWITCHBOARD (${show(cam(host))})`)
    assert.ok(agentDesk(host), 'the agent click opened no desk')
    assert.ok(same(cam(host), refCam!), `landed at ${show(cam(host))}, reference ${show(refCam!)}`)
  })

// ==========================================================================
// §1c — the second trigger (redteam-opus): an eye click taken while the
// switchboard ALREADY holds focus. The `focusId !== USER` guard keeps that
// release from consuming the flag, so it was left set for the next agent click.
uiTest('§1c a second eye click on the open switchboard must not leak into the next agent click',
  async ({ host, viewport }) => {
    assert.ok(refCam, '§REF did not run')
    await clickCard(eyeCard(host))
    assert.ok(switchboard(host), 'the first eye click did not open the switchboard')
    await clickCard(eyeCard(host))              // switchboard already open: guard closes the branch
    assert.ok(switchboard(host), 'the second eye click closed the switchboard')
    await zoomOut(host, viewport)
    await clickCard(agentCard(host, 'ceo'))
    assert.ok(!switchboard(host) && agentDesk(host),
      `after two eye clicks, the agent click opened the SWITCHBOARD (${show(cam(host))})`)
    assert.ok(same(cam(host), refCam!), `landed at ${show(cam(host))}, reference ${show(refCam!)}`)
  })

// ==========================================================================
// §3 — the eye's own click-to-focus must keep working after the fix: a still
// press on the eye still opens the switchboard, twice in a row.
uiTest('§3 GUARD: the eye still focuses on a plain click, and again after zooming out',
  async ({ host, viewport }) => {
    await clickCard(eyeCard(host))
    assert.ok(switchboard(host), 'first eye click did not open the switchboard')
    await zoomOut(host, viewport)
    await clickCard(eyeCard(host))
    assert.ok(switchboard(host), 'second eye click did not open the switchboard')
  })
