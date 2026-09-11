// showoncanvas.test.tsx — a pinned window's "Show on canvas" NAVIGATES the
// canvas to the agent, and leaves the window open.
//
// User bug, 2026-09-11: "pinned desk rightclick Show on canvas only highlights
// the already open pinned desk". The mechanism, read rather than guessed:
// pins.tsx wired that entry to `onJump`, OrgCanvas passes `centerOn` for
// `onJump`, and `centerOn`'s first branch sends a PINNED id to `showPin` and
// returns — the "pinned means pinned" rule (FR-3, user ruling 2026-09-04).
// That rule is right for a GENERIC jump: a mail link or a tray row that says
// "take me to this agent" should raise the window the agent's desk is living
// in. It is wrong for the one entry that names the canvas, because the window
// is already the thing in front of the reader.
//
// ⚠ THE PIN IS OPEN IN EVERY SECTION, AND THAT IS THE WHOLE POINT. With no
// pin, `centerOn` navigates anyway and every assertion below would pass
// against the unfixed build — a vacuous green. §3 is the other half: the same
// canvas, the same open pin, the GENERIC route, which must still raise the
// window and leave the camera alone. If §3 ever goes red, this change has
// broken the rule it was supposed to carve one exception out of.
//
// jsdom does no layout, so the camera is read as the numbers the component
// wrote into `.space`'s transform. The reference is never invented: §1
// compares against the camera produced by focusing the SAME agent while it is
// NOT pinned, captured in the same test.
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs showoncanvas

import {
  advance, FakeServer, flush, inAct, installFetch, mountView, realClock,
  useFakeClock,
} from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { OrgCanvas, resetCanvasSessionForTests } from '../src/canvas/OrgCanvas'
import { addPin, forgetPins, readPins, removePin } from '../src/canvas/pins'
import { resetConvos } from '../src/convo'
import type { TreePayload } from '../src/types'

const noop = () => {}
const SLUG = 'showcanvas'
const W = window as unknown as Window & typeof globalThis

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

const VP = { w: 1280, h: 800 }
const PIN_RECT = { x: 40, y: 40, w: 420, h: 320 }
function stubViewportRect(): () => void {
  const proto = window.HTMLElement.prototype
  const original = proto.getBoundingClientRect
  proto.getBoundingClientRect = function (this: HTMLElement) {
    return (this.classList?.contains('viewport')
      ? { x: 0, y: 0, left: 0, top: 0, width: VP.w, height: VP.h,
        right: VP.w, bottom: VP.h, toJSON() {} }
      : original.call(this)) as DOMRect
  }
  return () => { proto.getBoundingClientRect = original }
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
  return new (W as unknown as { PointerEvent: typeof PointerEvent }).PointerEvent(
    type, { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse',
      isPrimary: true, button: type === 'pointermove' ? -1 : 0, buttons: 1,
      clientX: x, clientY: y })
}

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

const labels = () => [...document.querySelectorAll('.ctxmenu [role="menuitem"]')]
  .map((b) => (b as HTMLButtonElement).textContent ?? '')
const itemNamed = (label: string) =>
  [...document.querySelectorAll('.ctxmenu [role="menuitem"]')]
    .find((b) => b.textContent === label) as HTMLButtonElement | undefined

async function rightClick(el: Element): Promise<void> {
  await inAct(() => {
    el.dispatchEvent(new W.MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, button: 2, clientX: 40, clientY: 30 }))
  })
  await flush(2)
}
async function pick(label: string): Promise<void> {
  const b = itemNamed(label)
  assert.ok(b, `menu item "${label}" present — have ${JSON.stringify(labels())}`)
  await inAct(() => { b!.click() })
  await flush(2)
  await advance(1600)
}

const cardOf = (host: HTMLElement, name: string) => {
  const el = [...host.querySelectorAll('.sq')]
    .find((c) => c.querySelector('.name')?.textContent === name)
  assert.ok(el, `no card for ${name}`)
  return el
}
async function clickCard(el: Element): Promise<void> {
  await inAct(() => { el.dispatchEvent(pointer('pointerdown', 200, 200)) })
  await flush()
  await inAct(() => { el.dispatchEvent(pointer('pointerup', 200, 200)) })
  await flush()
  await advance(1600)
}
async function panAway(viewport: HTMLElement): Promise<void> {
  await inAct(() => { viewport.dispatchEvent(pointer('pointerdown', 400, 300)) })
  await flush()
  await inAct(() => { viewport.dispatchEvent(pointer('pointermove', 520, 380)) })
  await flush()
  await inAct(() => { viewport.dispatchEvent(pointer('pointerup', 520, 380)) })
  await flush()
  await advance(200)
}

// -------------------------------------------------------------- the driver
interface Kit {
  host: HTMLElement
  viewport: HTMLElement
  pin: (id: string) => Promise<void>
  focusAgent: (id: string | null) => Promise<void>
}
function uiTest(name: string, body: (k: Kit) => Promise<void>): void {
  test(name, async (t: TestContext) => {
    localStorage.clear()
    forgetPins(SLUG)
    resetCanvasSessionForTests()
    useFakeClock()
    installFetch(new FakeServer())
    const unrect = stubViewportRect()
    const uncap = stubPointerCapture()
    const open: { unmount: () => Promise<void> }[] = []
    t.after(async () => {
      for (const m of open) { try { await m.unmount() } catch { /* gone */ } }
      uncap(); unrect(); forgetPins(SLUG); resetConvos(); realClock()
      localStorage.clear()
    })
    const canvas = (focus: string | null) => (
      <OrgCanvas tree={tree(['ceo', 'worker'])} op={() => Promise.resolve({} as never)}
        slug={SLUG} toast={noop} mailEvt={null} focusAgent={focus} />
    )
    const v = await mountView(canvas(null), (el) => el)
    open.push(v)
    await flush()
    const viewport = v.el.querySelector('.viewport') as HTMLElement | null
    assert.ok(viewport, 'the canvas viewport rendered')
    await advance(2500)          // the opening drift
    await body({
      host: v.el,
      viewport,
      pin: async (id) => {
        // ⚠ ONE RECT FOR EVERY PIN IN THIS FILE. A pinned window takes canvas
        // space, so `focusView` centres in a REDUCED region - a reference
        // taken with a different pin up (or none) is a camera for a different
        // canvas, and comparing the two reports a navigation failure that did
        // not happen. Pinning a second agent replaces the first here, so the
        // free region is a constant across a section.
        // ⚠ `forgetPins` only drops the in-memory cache - localStorage keeps
        // the pin and `readPins` reads it straight back, so the second pin
        // JOINS the first instead of replacing it. `removePin` is the unpin.
        await inAct(() => {
          for (const p of readPins(SLUG)) removePin(SLUG, p.id)
          addPin(SLUG, id, PIN_RECT)
        })
        await flush(2)
        await advance(600)
      },
      focusAgent: async (id) => { await v.render(canvas(id)); await flush(2); await advance(1600) },
    })
  })
}

// ==========================================================================
uiTest('§1 Show on canvas lands the camera where focusing the agent would, with the pin open',
  async ({ host, viewport, pin }) => {
    // THE REFERENCE: where does focusing this agent put the camera — with a
    // pinned window of the same size up, so the free region is the one the
    // jump below will be measured in. `ceo` holds that space while `worker`
    // is still unpinned and therefore still reachable by a plain focus.
    await pin('ceo')
    await clickCard(cardOf(host, 'worker'))
    const focused = cam(host)
    assert.ok(host.querySelector('.sq.desk:not(.user) .desk-over'),
      'the plain focus mounted no desk — the reference is not a focus')

    // …now move the pin onto that agent and take the camera somewhere else,
    // so the jump has something to undo
    await pin('worker')
    assert.equal(readPins(SLUG).length, 1, 'the pin did not register')
    await panAway(viewport)
    const panned = cam(host)
    assert.ok(!same(panned, focused),
      `the pan did not move the camera off ${show(focused)}, so a jump back `
      + 'would pass by having nothing to do')

    const title = host.querySelector('.pinwin-title')
      ?? document.querySelector('.pinwin-title')
    assert.ok(title, 'the pinned window rendered no title bar to right-click')
    await rightClick(title)
    assert.ok(labels().includes('Show on canvas'),
      `no "Show on canvas" entry — have ${JSON.stringify(labels())}`)
    await pick('Show on canvas')

    const after = cam(host)
    assert.ok(same(after, focused),
      `Show on canvas left the camera at ${show(after)}; focusing this agent `
      + `puts it at ${show(focused)} — the canvas did not navigate`)
    assert.equal(readPins(SLUG).length, 1,
      'the window was closed or unpinned — it must stay open')
  })

// ==========================================================================
uiTest('§2 …and the card it lands on shows its pinned placeholder, not a second desk',
  async ({ host, viewport, pin }) => {
    await pin('worker')
    await panAway(viewport)
    const title = document.querySelector('.pinwin-title')
    assert.ok(title, 'no pinned window title bar')
    await rightClick(title)
    await pick('Show on canvas')

    assert.ok(host.querySelector('.pin-holder'),
      'the camera arrived but the card is not showing the pinned placeholder')
    // ⚠ `.sq.desk` is the card's LAYOUT class and the placeholder wears it
    // too (cards.tsx: `focused = deskOpen || !!pinnedFocus`). A mounted desk
    // is `.desk-over`, and THAT is what must not exist twice.
    assert.equal(host.querySelectorAll('.sq.desk:not(.user) .desk-over').length, 0,
      'a SECOND desk mounted for a pinned agent — "pinned means pinned" (two '
      + 'DeskChats for one node share a composer key and fight over it)')
    assert.equal(readPins(SLUG).length, 1, 'the pinned window must stay open')
  })

// ==========================================================================
uiTest('§3 CONTROL: a generic jump to the same pinned agent still raises the window',
  async ({ host, viewport, pin, focusAgent }) => {
    // the rule this change carves ONE exception out of. `focusAgent` is the
    // generic route every mail link, tray row and docket reference takes.
    await pin('worker')
    await panAway(viewport)
    const parked = cam(host)

    await focusAgent('worker')
    assert.ok(same(cam(host), parked),
      `a generic jump to a PINNED agent moved the camera from ${show(parked)} `
      + `to ${show(cam(host))} — it must raise the window instead`)
    assert.equal(readPins(SLUG).length, 1, 'the pin survived the generic jump')

    // …and the same rig DOES move the camera for an UNPINNED agent, so this
    // section cannot pass by the generic route being broken outright
    await focusAgent(null)
    await focusAgent('ceo')
    assert.ok(!same(cam(host), parked),
      'POSITIVE CONTROL FAILED: the generic jump moved nothing for an '
      + 'unpinned agent either — it is not reaching the canvas at all')
  })

// ==========================================================================
uiTest('§4 the camera it leaves behind keeps following the canvas as it resizes',
  async ({ host, viewport, pin }) => {
    // the revealed card is a focus like any other (see focusstick.test.tsx):
    // a pinned target is normally a STALE intent, and this one must not be
    await pin('worker')
    await panAway(viewport)
    const title = document.querySelector('.pinwin-title')
    assert.ok(title, 'no pinned window title bar')
    await rightClick(title)
    await pick('Show on canvas')
    const landed = cam(host)

    const { fireResize } = await import('./harness')
    VP.w = 900; VP.h = 620
    await inAct(() => { fireResize(viewport) })
    await flush()
    await advance(1600)
    VP.w = 1280; VP.h = 800      // leave the shared rect as the others expect

    assert.ok(!same(cam(host), landed),
      `the canvas shrank from 1280x800 to 900x620 and the revealed card stayed `
      + `at ${show(landed)} — the follow treated a pinned target as stale`)
  })
