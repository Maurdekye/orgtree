// mailnav.test.tsx — CLICKING A SENDER'S NAME ACTUALLY NAVIGATES, measured on
// the real camera rather than on a spy.
//
// ⚠ WHY THIS FILE EXISTS, AND WHAT IT IS A CORRECTION TO. mailsender.test.tsx
// proved the desk's inbox "navigates" by handing it a spy that recorded the
// FIRST ARGUMENT of each call. The shipped callback is `centerOn(id, z = null)`
// and `AgentName` invokes `onFocus(id, event)` — so the real navigator was
// receiving the click event AS ITS ZOOM, and a spy that only ever looked at
// argument one could not see it. The suite was green, the deployed UI was
// broken, and coordinator-astra measured it in a hydrated browser on
// 2026-09-05 at 392767b: clicking a sender in the desk inbox lost the focused
// desk and showed the root card.
//
// A SPY IS NOT A NAVIGATOR. This file therefore drives the REAL <OrgCanvas>,
// clicks what a reader clicks, and asks the canvas WHERE THE CAMERA WENT — the
// same instrument focusspace.test.tsx uses, and for the same reason: the
// transform on `.space` is the production component's own output, so an
// argument arriving in the wrong position shows up as a camera that went
// nowhere, went somewhere unreadable, or went to NaN.
//
// THE POSITIVE CONTROL IS A SECOND SURFACE IN THE SAME RIG. §2 clicks the
// sender on the TRANSCRIPT's mail card, which reaches the same `centerOn`
// through a one-argument wrapper and has always been correct. If §1 is red
// while §2 is green, the fault is at the boundary §1 clicks — not in the rig,
// the fixture or the camera. If BOTH go green after a change that removed the
// navigation entirely, §0's witnesses would have caught it first.
//
// ⚠ WHAT THIS FILE DOES NOT OBSERVE. jsdom does no layout, so the viewport is
// stubbed (the focusspace idiom) and no claim is made about pixels, hit
// testing or compositing — mailsender_probe.py owns those. And this is not the
// deployed build: it is the worktree's source, mounted. Deployment is
// coordinator-astra's, and inclusion in a running build is not observation.
//
// Run:  cd frontend && node tests/run.mjs mailnav

import {
  advance, FakeServer, flush, inAct, installFetch, mountView, realClock,
  useFakeClock,
} from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { OrgCanvas } from '../src/canvas/OrgCanvas'
import { forgetPins } from '../src/canvas/pins'
import { resetConvos } from '../src/convo'
import type { MailRow } from '../src/canvas/shared'
import type { TreePayload } from '../src/types'

const noop = () => {}
const asTree = (v: unknown) => v as TreePayload
const txt = (el: Element) => el.textContent ?? ''
const q = (el: HTMLElement, sel: string) => [...el.querySelectorAll(sel)] as HTMLElement[]

const VP_W = 1000, VP_H = 800
const SLUG = 'mine'
const HOME = 'ceo'          // the desk whose mailbox is read
const PEER = 'cto'          // the sender, and the place a click must land

/** the tree fixture idiom shared with focusspace/agentstray/audpile: trimmed to
 *  what OrgCanvas actually dereferences */
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

/** one delivered mail from PEER, in the shape the node-inbox endpoint returns */
const MAIL: MailRow[] = [{
  id: 'nav1', from: PEER, to: HOME, kind: 'message',
  at: '2026-09-05T18:20:00.000Z',
  body: 'a body long enough to give the row its own preview line',
} as MailRow]

/** …and the same sender arriving as a real ENVELOPE in the transcript, which
 *  is what gives §2 its mail card */
const ENVELOPE = `[MAIL — 1 message(s)]\nFROM ${PEER} (your peer) · message · `
  + '2026-09-05T18:20:00Z\na word about the build.\n[END MAIL]\n\n'
  + '(orgtree) You have new mail above.'

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

/** ⚠ A REAL CLICK EVENT, not a synthetic call. `detail: 1` because that is
 *  what a mouse activation carries and some name handlers read it (pins.tsx
 *  distinguishes keyboard from pointer that way) — a click this rig fires must
 *  look like the reader's, or the rig is testing a path nobody takes. */
const clickEv = (): Event =>
  new (W().window.MouseEvent)('click', { bubbles: true, cancelable: true, detail: 1 })

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
  const m = /translate\(([-\d.e+NaN]+)px, ?([-\d.e+NaN]+)px\) scale\(([-\d.e+NaN]+)\)/
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

/** WHICH DESK IS OPEN — the same witness coordinator-astra's hydrated script
 *  used against the deployed build. The focused agent's desk draws its own
 *  name in the header; nothing else on the canvas does. */
function focusedDesk(host: HTMLElement): string | null {
  const name = host.querySelector('.sq.desk:not(.user) .cc-head-left .cc-name')
  return name ? txt(name).trim() : null
}

interface Kit { host: HTMLElement; viewport: HTMLElement }

/** Mount the real canvas over a fake server whose node-inbox and chat answers
 *  are fixtures, focus HOME's desk, and hand the test the live DOM. */
function uiTest(name: string, body: (k: Kit) => Promise<void>): void {
  test(name, async (t: TestContext) => {
    useFakeClock()
    const s = new FakeServer()
    s.userMsg(ENVELOPE).segments = [{kind:'mail',rows:[{id:'camera-control',from:PEER,kind:'message',at:'2026-09-05T10:00:00Z',body:'camera control',
      ev:{v:1,variant:'ordinary.message',actor:{kind:'agent',id:PEER},object:null,engine_authored:false,body:'camera control'},
    }]}]
    installFetch(s)
    const inner = (globalThis as { fetch: typeof fetch }).fetch
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch = ((
      url: string, init?: unknown,
    ) => (String(url).includes('/inbox')
      ? Promise.resolve({
        ok: true, status: 200, headers: new Headers(),
        json: () => Promise.resolve({ pending: [], sent: [], delivered: MAIL }),
      })
      : (inner as (u: string, i?: unknown) => Promise<unknown>)(url, init))
    ) as unknown as typeof fetch
    const unstub = stubPointerCapture()
    localStorage.clear()
    forgetPins()
    const open: { unmount: () => Promise<void> }[] = []
    t.after(async () => {
      for (const m of open) { try { await m.unmount() } catch { /* gone */ } }
      ;(globalThis as { fetch?: typeof fetch }).fetch = inner
      unstub(); resetConvos(); realClock(); localStorage.clear(); forgetPins()
    })
    const v = await mountView(
      <OrgCanvas tree={tree([HOME, PEER])} op={() => Promise.resolve({} as never)}
        slug={SLUG} toast={noop} mailEvt={null} />, (el) => el)
    open.push(v)
    await flush()
    const viewport = v.el.querySelector('.viewport') as HTMLElement | null
    assert.ok(viewport, 'the canvas viewport rendered')
    measure(viewport)
    await advance(2500)              // let the opening glide finish
    await body({ host: v.el, viewport })
  })
}

/** open HOME's desk and return the camera that put it there */
async function openHome(host: HTMLElement): Promise<Cam> {
  const before = cam(host)
  await clickCard(agentCard(host, HOME))
  const after = cam(host)
  assert.equal(focusedDesk(host), HOME,
    'positive control: clicking a card opens THAT agent\'s desk — without this '
    + 'every navigation assertion below would be about a canvas that never '
    + 'focused anything')
  assert.ok(before.x !== after.x || before.z !== after.z,
    'positive control: the camera moved, so this rig can see navigation at all')
  return after
}

async function realClick(el: Element): Promise<void> {
  await inAct(() => { el.dispatchEvent(clickEv()) })
  await flush()
  await advance(1200)
}

/** the sender identity inside a row/head, demanded rather than assumed */
function jumpIn(el: HTMLElement, why: string): HTMLElement {
  const b = q(el, 'button.cc-name-jump')
  assert.equal(b.length, 1, `${why} — got ${b.length} jump buttons in: ${txt(el).slice(0, 120)}`)
  return b[0]!
}

// ══════════════════════════════════════════════════════════════════════ §1
uiTest('§1 the DESK INBOX: clicking a sender takes you to that agent\'s desk, '
  + 'with a camera that is still a camera', async ({ host }) => {
  await openHome(host)
  const tab = q(host, '.sq.desk .cc-tabs button')
    .find((b) => txt(b).trim().startsWith('inbox'))
  assert.ok(tab, 'positive control: the focused desk has an inbox tab')
  await realClick(tab!)
  await flush()
  const row = q(host, '.sq.desk .mailrow').find((r) => txt(r).includes(PEER))
  assert.ok(row, 'positive control: the mailbox rendered the row to click')
  const jump = jumpIn(row!, 'the sender is drawn as a route')

  await realClick(jump)

  // ⚠ THE ASSERTION THAT WAS MISSING. Not "the callback fired" — WHERE THE
  // READER ENDED UP. At 392767b this left HOME's desk behind and showed the
  // root card, because the click event arrived as the zoom.
  assert.equal(focusedDesk(host), PEER,
    'clicking the sender did not open that agent\'s desk')
  const c = cam(host)
  assert.ok(Number.isFinite(c.x) && Number.isFinite(c.y) && Number.isFinite(c.z),
    `the camera is not a number after the click: ${JSON.stringify(c)}`)
  assert.ok(c.z > 0, `the camera zoomed to ${c.z}, which shows nothing`)
})

// ══════════════════════════════════════════════════════════════════════ §2
uiTest('§2 CONTROL — the TRANSCRIPT\'s mail card reaches the same camera '
  + 'through a wrapper, and always did', async ({ host }) => {
  // This is the rig's own witness. It clicks a DIFFERENT sender surface whose
  // hand-off has always been one-argument, so a red §1 beside a green §2 is a
  // fact about the boundary §1 clicks and not about this fixture, this canvas
  // or this way of clicking.
  await openHome(host)
  const head = host.querySelector('.sq.desk .event-head') as HTMLElement | null
  assert.ok(head, 'positive control: the transcript rendered a mail card')
  await realClick(jumpIn(head!, 'the card names its sender as a route'))
  assert.equal(focusedDesk(host), PEER,
    'the transcript\'s sender did not navigate — the rig itself is broken, so '
    + 'nothing else in this file can be believed')
  const c = cam(host)
  assert.ok(Number.isFinite(c.z) && c.z > 0,
    `the camera is not a camera: ${JSON.stringify(c)}`)
})

// ══════════════════════════════════════════════════════════════════════ §3
uiTest('§3 the READING PANE\'s sender navigates too, and selecting a row does '
  + 'not navigate by itself', async ({ host }) => {
  await openHome(host)
  const tab = q(host, '.sq.desk .cc-tabs button')
    .find((b) => txt(b).trim().startsWith('inbox'))
  assert.ok(tab, 'positive control: the focused desk has an inbox tab')
  await realClick(tab!)
  await flush()
  const row = q(host, '.sq.desk .mailrow').find((r) => txt(r).includes(PEER))
  assert.ok(row, 'positive control: the mailbox rendered its row')
  // the row BODY: reading a mail is not travelling to its sender
  const body = row!.querySelector('.l2') ?? row!
  await realClick(body)
  assert.equal(focusedDesk(host), HOME,
    'selecting a mail navigated away from the desk you are reading it on')
  const pane = host.querySelector('.sq.desk .mailer-read') as HTMLElement | null
  assert.ok(pane, 'positive control: selecting opened the reading pane')
  await realClick(jumpIn(pane!, 'the reading pane names its sender as a route'))
  assert.equal(focusedDesk(host), PEER,
    'the reading pane\'s sender did not navigate')
})
