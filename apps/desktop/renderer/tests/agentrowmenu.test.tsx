// agentrowmenu.test.tsx — THE AGENTS LIST ROW'S CONTEXT MENU (user request
// 2026-09-12: "rows in the Agents List do not expose the same right-click
// operations as the corresponding agent card, forcing operators to locate the
// card before using contextual actions and allowing the two action sets to
// drift").
//
// THE CENTRAL ASSERTION IS AN EQUALITY, not a list. Every parity case below
// right-clicks the ROW and the agent's own CARD in the same mounted canvas and
// compares the two menus label for label, in order. That is the test that
// keeps failing if someone adds an action to one surface and not the other —
// an expected-labels list would only fail for the surface it was written
// against. §1 spells the order out ONCE as well, so a change made to both at
// the same time (which the equality would happily accept) still has to be
// deliberate.
//
// The mechanism itself — opening, dismissing, keyboard walking, clamping — is
// tests/contextmenu.test.tsx §A, and the CARD's own menu is its §B1. This file
// is about the row: that it has the same menu, that the menu's entries run the
// list's own handlers, and the two places the list is not the card (the
// confirm dialog lives in the list's surface, and the hire chips live on the
// card, so the row walks there and opens them).
//
// Under jsdom every box is 0×0 (see contextmenu.test.tsx's note) — nothing
// here reads a size.
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs agentrowmenu

import {
  advance, FakeServer, flush, inAct, installFetch, mountView, realClock,
  useFakeClock,
} from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { OrgCanvas } from '../src/canvas/OrgCanvas'
import { resetConvos } from '../src/convo'
import { addPin, forgetPins } from '../src/canvas/pins'
import { setCrowdPilesOn } from '../src/canvas/shared'
import type { OpRequest } from '../src/canvas/shared'
import type { TreePayload } from '../src/types'

const noop = () => {}
const W = window as unknown as Window & typeof globalThis

// ------------------------------------------------------------------ fixture
// (the node/tree shape is contextmenu.test.tsx's, verbatim — one fixture idiom
// for the canvas, so a payload field added there is added in one place)
const asTree = (v: unknown) => v as TreePayload
function mkNode(id: string, extra: Record<string, unknown> = {}): unknown {
  return {
    id, title: id, tier: 'haiku', model_id: 'haiku', state: 'live',
    seat: 1, grant: 0, free: 0, ui_order: 0, cost_usd: 0, occupancy: null,
    context_window: null, charter: null, mail_pending: 0, limit_locked: false,
    last_status: null, prev_status: null, inflight_at: null, last_denials: [],
    turns: [], frozen: null, audiences_held: [], bearer_state: null,
    generation: 0, children: [], lineage: [],
    scope: { permission_mode: 'default', add_dirs: [], tools: {}, org_visibility: 'team' },
    ...extra,
  }
}
function tree(roots: unknown[]): TreePayload {
  return asTree({
    slug: 'mine', name: 'mine', workspace: null, dirs: [], max_top_grant: 1000,
    default_top_grant: 50, compact_at: 0, default_tools: null,
    default_visibility: 'team', default_effort: '', credit_requests: [],
    tiers: { haiku: 1, sonnet: 3, opus: 5, fable: 10 }, audiences: [],
    roots, cost_usd_total: 0,
    audit: { live_nodes: roots.length, top_level_holds: 0, no_overdraft: true, problems: [] },
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
  proto.setPointerCapture = () => {}; proto.releasePointerCapture = () => {}; proto.hasPointerCapture = () => false
  return () => { proto.setPointerCapture = had.s; proto.releasePointerCapture = had.r; proto.hasPointerCapture = had.h }
}

interface Canvas {
  el: HTMLElement
  ops: OpRequest[]
  galleries: string[]
}
async function mountCanvas(t: TestContext, roots: unknown[],
  patch: Record<string, unknown> = {}): Promise<Canvas> {
  t.after(stubPointerCapture())
  resetConvos()
  const had = (globalThis as { fetch?: typeof fetch }).fetch
  installFetch(new FakeServer())
  t.after(() => { (globalThis as { fetch?: typeof fetch }).fetch = had })
  const ops: OpRequest[] = []
  const galleries: string[] = []
  const v = await mountView(
    <OrgCanvas tree={asTree({ ...tree(roots), ...patch })} slug="mine"
      op={(b) => { ops.push(b); return Promise.resolve({} as never) }} toast={noop}
      mailEvt={null} onOpenAgentGallery={(id) => { galleries.push(id) }} />,
    (h) => h)
  t.after(() => v.unmount())
  await flush(); await advance(400, 50); await flush()
  return { el: v.el, ops, galleries }
}

// -------------------------------------------------------------- the gestures
/** a right-click as the browser dispatches it. Returns whether the app took
 *  it (preventDefault) — contextmenu.test.tsx's helper. */
async function rightClick(el: Element, at: { x: number; y: number } = { x: 40, y: 30 }): Promise<boolean> {
  const ev = new W.MouseEvent('contextmenu', {
    bubbles: true, cancelable: true, button: 2, clientX: at.x, clientY: at.y,
  })
  await inAct(() => { el.dispatchEvent(ev) })
  await flush(2)
  return ev.defaultPrevented
}
const menuEl = () => document.querySelector('.ctxmenu') as HTMLElement | null
const labels = () => [...document.querySelectorAll('.ctxmenu [role="menuitem"]')]
  .map((b) => (b as HTMLButtonElement).textContent ?? '')
const itemNamed = (label: string) => [...document.querySelectorAll('.ctxmenu [role="menuitem"]')]
  .find((b) => b.textContent === label) as HTMLButtonElement | undefined
/** choosing an entry, as the browser delivers it: the press lands FIRST (this
 *  is what the Agents List's click-away rule sees), then the click. */
async function pick(label: string) {
  const b = itemNamed(label)
  assert.ok(b, `menu item "${label}" present — have ${JSON.stringify(labels())}`)
  await inAct(() => {
    b!.dispatchEvent(new W.PointerEvent('pointerdown', { bubbles: true, button: 0 }))
    b!.click()
  })
  await flush(2)
}
async function esc(target: Element = document.body) {
  await inAct(() => {
    target.dispatchEvent(new W.KeyboardEvent('keydown',
      { key: 'Escape', bubbles: true, cancelable: true }))
  })
  await flush(2)
}

// ---------------------------------------------------------------- the places
async function openTray(el: HTMLElement): Promise<HTMLElement> {
  if (!el.querySelector('.tray')) {
    const toggle = el.querySelector('.tray-toggle') as HTMLElement
    assert.ok(toggle, 'the agents list toggle rendered')
    await inAct(() => { toggle.click() })
    await flush(2)
  }
  const tray = el.querySelector('.tray') as HTMLElement | null
  assert.ok(tray, 'the Agents List opened')
  return tray!
}
const rowFor = (el: HTMLElement, id: string) =>
  [...el.querySelectorAll('.tray-row')].find((r) =>
    r.querySelector('.tray-name')?.textContent === id) as HTMLElement | undefined
const cardFor = (el: HTMLElement, id: string) =>
  [...el.querySelectorAll('.sq')].find((c) =>
    c.querySelector('.sq-title .name')?.textContent === id) as HTMLElement | undefined
/** the menu an object offers, read and then dismissed */
async function menuOf(target: Element, what: string): Promise<string[]> {
  assert.equal(await rightClick(target), true, `${what}: the right-click was taken`)
  assert.ok(menuEl(), `${what}: a menu opened`)
  const have = labels()
  await esc()
  assert.equal(menuEl(), null, `${what}: Escape dismissed the menu`)
  return have
}
/** the whole point: the row and the card offer the SAME menu */
async function assertParity(c: Canvas, id: string, what: string): Promise<string[]> {
  const row = rowFor(c.el, id)
  assert.ok(row, `${what}: the agent has a row in the Agents List`)
  const card = cardFor(c.el, id)
  assert.ok(card, `${what}: the agent has a card on the canvas`)
  const fromRow = await menuOf(row!, `${what} (row)`)
  const fromCard = await menuOf(card!, `${what} (card)`)
  assert.deepEqual(fromRow, fromCard,
    `${what}: the Agents List row and the agent's card must offer the SAME menu`)
  return fromRow
}

function uiTest(name: string, body: (t: TestContext) => Promise<void>) {
  test(name, async (t: TestContext) => {
    useFakeClock()
    forgetPins()
    setCrowdPilesOn(false)
    try { localStorage.removeItem('orgtree-pile-mine') } catch { /* private mode */ }
    try { await body(t) } finally {
      forgetPins(); setCrowdPilesOn(false); realClock()
    }
  })
}

// ------------------------------------------------------------------ §1 order
uiTest('§1 a row offers the agent\'s own menu — the same entries, in the same order, as its card',
  async (t) => {
    const c = await mountCanvas(t, [mkNode('worker')])
    await openTray(c.el)
    const have = await assertParity(c, 'worker', 'a plain live agent')
    // ...and the order itself, written down once. The equality above cannot
    // catch a change made to both surfaces at once; this can.
    assert.deepEqual(have, [
      'Open desk', 'Open inbox', 'Open docket', 'Settings',
      'Pin desk as a window', 'Hire a subordinate…', 'Retire…',
    ], 'the agent menu, in order')
  })

uiTest('§1b the menu opens from the row\'s main line too — the whole row is the object',
  async (t) => {
    const c = await mountCanvas(t, [mkNode('worker')])
    await openTray(c.el)
    const main = rowFor(c.el, 'worker')!.querySelector('.tray-main') as HTMLElement
    assert.ok(main, 'the row\'s main line rendered')
    const have = await menuOf(main, 'the main line')
    assert.ok(have.includes('Open desk') && have.includes('Retire…'),
      `a press on the name/status line raises the row's menu — have ${JSON.stringify(have)}`)
  })

// -------------------------------------------------------------- §2 variants
uiTest('§2 an agent with live reports offers Dissolve on BOTH surfaces, and never Retire',
  async (t) => {
    const c = await mountCanvas(t, [mkNode('boss', { children: [mkNode('kid', { parent: 'boss' })] })])
    await openTray(c.el)
    const have = await assertParity(c, 'boss', 'a superior with live reports')
    assert.ok(have.includes('Dissolve suborganization…'), JSON.stringify(have))
    assert.ok(!have.includes('Retire…'), 'one lifecycle entry, not two')
    // and the report itself is an ordinary row, one level in
    const kid = await assertParity(c, 'kid', 'the report')
    assert.ok(kid.includes('Retire…') && !kid.includes('Dissolve suborganization…'))
  })

uiTest('§2b an ARCHIVED row keeps the menu and loses exactly what the archived card loses',
  async (t) => {
    const c = await mountCanvas(t, [mkNode('worker'), mkNode('gone', { state: 'archived' })])
    const tray = await openTray(c.el)
    // archived rows are hidden until the count row folds them in (user spec)
    const arch = tray.querySelector('.tray-arch') as HTMLElement | null
    assert.ok(arch, 'the archived-count row rendered')
    await inAct(() => { arch!.click() })
    await flush(2)
    const have = await assertParity(c, 'gone', 'a retired agent')
    assert.ok(have.includes('Open inbox') && have.includes('Settings'),
      `a retired seat is still readable — have ${JSON.stringify(have)}`)
    for (const gone of ['Retire…', 'Dissolve suborganization…', 'Hire a subordinate…']) {
      assert.ok(!have.includes(gone), `a retired seat cannot ${gone}`)
    }
  })

uiTest('§2c documents and lineage add their entries to the row exactly as they do to the card',
  async (t) => {
    const c = await mountCanvas(t, [
      mkNode('rich', {
        documents: [{ id: 'd1', title: 'Plan', at: '2026-09-07T10:00:00Z' }],
        lineage: ['rich@1'],
      }),
      mkNode('plain'),
    ])
    await openTray(c.el)
    const rich = await assertParity(c, 'rich', 'an agent with documents and a lineage')
    assert.ok(rich.includes('Open presentations') && rich.includes('Show lineage'),
      JSON.stringify(rich))
    const plain = await assertParity(c, 'plain', 'an agent with neither')
    assert.ok(!plain.includes('Open presentations') && !plain.includes('Show lineage'),
      'the entries are gated on the node, not on the surface')
  })

uiTest('§2d a PINNED desk swaps the pin entry for "Show pinned window" on both surfaces',
  async (t) => {
    addPin('mine', 'worker', { x: 10, y: 10, w: 300, h: 200 })
    const c = await mountCanvas(t, [mkNode('worker')])
    await openTray(c.el)
    const have = await assertParity(c, 'worker', 'a pinned desk')
    assert.ok(have.includes('Show pinned window'), JSON.stringify(have))
    assert.ok(!have.includes('Pin desk as a window'), 'it is already pinned')
  })

uiTest('§2e a CROWD-piled agent offers no hire on either surface, and a piled-away row still has its menu',
  async (t) => {
    // the crowd pile is opt-in (D-198) and needs a wide team: >8 active
    // reports, of which the leaves stack behind one front card
    setCrowdPilesOn(true)
    const kids = Array.from({ length: 9 }, (_, i) => mkNode('kid' + i, { parent: 'boss' }))
    const c = await mountCanvas(t, [mkNode('boss', { children: kids })])
    await openTray(c.el)
    assert.ok(c.el.querySelector('.pile-stack'), 'the fixture actually piled')
    const ids = kids.map((_, i) => 'kid' + i)
    const shown = ids.filter((id) => cardFor(c.el, id))
    const buried = ids.filter((id) => !cardFor(c.el, id))
    assert.equal(shown.length, 1, `exactly one leaf is the pile FRONT — ${JSON.stringify(shown)}`)
    assert.equal(buried.length, ids.length - 1, 'and the rest have no card at all')
    // the front still has a card, so it is a true parity case
    const have = await assertParity(c, shown[0]!, 'a pile front')
    assert.ok(!have.includes('Hire a subordinate…'),
      'a pile front hires nowhere — its edges are the stack')
    // a piled-AWAY agent has no card at all; the row is the only door it has,
    // and it offers what the card would offer once the row brought it forward
    const away = await menuOf(rowFor(c.el, buried[0]!)!, 'a piled-away agent')
    assert.ok(away.includes('Open desk') && away.includes('Retire…'),
      `the row is the buried agent's only door — have ${JSON.stringify(away)}`)
    assert.ok(!away.includes('Hire a subordinate…'),
      'it comes to the front of its pile when picked, and a front hires nowhere')
  })

uiTest('§2f busy, halted, frozen and read-only seats keep the card\'s rules on both surfaces',
  async (t) => {
    // none of these states gates an entry on the CARD, and that is the point:
    // the row must not invent a rule the card does not have, and if a future
    // change adds one to either surface this case fails until both agree
    const c = await mountCanvas(t, [
      mkNode('busy-one', { busy: true, proc_warm: true }),
      mkNode('halted-one', { limit_locked: true, frozen: { limit: true, error: 'rate limit' } }),
      mkNode('frozen-one', { frozen: { connection: true, error: 'offline' } }),
      mkNode('ro-one', {
        scope: { permission_mode: 'default', add_dirs: [], tools: { edit: false }, org_visibility: 'team' },
      }),
    ])
    await openTray(c.el)
    for (const id of ['busy-one', 'halted-one', 'frozen-one', 'ro-one']) {
      const have = await assertParity(c, id, `a ${id.replace('-one', '')} seat`)
      assert.ok(have.includes('Retire…') && have.includes('Settings'),
        `${id}: a live seat keeps its lifecycle entries — have ${JSON.stringify(have)}`)
    }
  })

uiTest('§2g a PUBLIC (kiosk) org gets the same menu on the row as on the card',
  async (t) => {
    // the ceiling spec's rule is that a visitor retools within the ceiling —
    // the card's menu is not gated on `public`, so the row's must not be
    const c = await mountCanvas(t, [mkNode('worker')],
      { public: true, kiosk: { max_tier: 'sonnet', credits: 10 } })
    await openTray(c.el)
    const have = await assertParity(c, 'worker', 'a seat in a public org')
    assert.ok(have.includes('Settings') && have.includes('Retire…'), JSON.stringify(have))
  })

// ----------------------------------------------------- §3 it is not a click
uiTest('§3 a right-click on a row does not navigate, and the list survives its own menu',
  async (t) => {
    const c = await mountCanvas(t, [mkNode('worker'), mkNode('other')])
    await openTray(c.el)
    const camera = () => (c.el.querySelector('.space') as HTMLElement).style.transform
    const before = camera()
    const row = rowFor(c.el, 'other')!
    assert.equal(await rightClick(row), true)
    await advance(400, 50)
    assert.equal(camera(), before,
      'a right-click is not a click: the camera did not glide to the row\'s agent')
    assert.ok(c.el.querySelector('.tray'), 'and the Agents List is still open')
    // the menu portals to the document body — OUTSIDE the list's click-away
    // boundary. Choosing an entry must not dismiss the list out from under the
    // press, or the entry's own click would never arrive.
    await pick('Open inbox')
    assert.ok(c.el.querySelector('.tray'),
      'the Agents List closed when its own menu was used')
    assert.ok([...document.querySelectorAll('h3')].some((h) => /· inbox/.test(h.textContent ?? '')),
      'and the entry ran: the node inbox opened')
  })

uiTest('§3c the exemption is scoped: a press OUTSIDE both still closes the list',
  async (t) => {
    const c = await mountCanvas(t, [mkNode('worker')])
    await openTray(c.el)
    await rightClick(rowFor(c.el, 'worker')!)
    assert.ok(menuEl(), 'the row menu is open')
    const viewport = c.el.querySelector('.viewport') as HTMLElement
    await inAct(() => {
      viewport.dispatchEvent(new W.PointerEvent('pointerdown',
        { bubbles: true, cancelable: true, button: 0 }))
    })
    await flush(2)
    assert.equal(menuEl(), null, 'the menu closed on an outside press')
    assert.equal(c.el.querySelector('.tray'), null,
      'and so did the list — only its own menu is exempt')
  })

uiTest('§3b Escape closes the menu and leaves the list open; a second Escape closes the list',
  async (t) => {
    const c = await mountCanvas(t, [mkNode('worker')])
    await openTray(c.el)
    await rightClick(rowFor(c.el, 'worker')!)
    assert.ok(menuEl(), 'the menu opened')
    await esc()
    assert.equal(menuEl(), null, 'Escape closed the menu')
    assert.ok(c.el.querySelector('.tray'), 'one Escape closes one thing')
    await esc()
    assert.equal(c.el.querySelector('.tray'), null, 'the next Escape closes the list')
  })

// ------------------------------------------------- §4 the entries do the job
uiTest('§4 each entry runs the Agents List\'s own handler — the same surfaces its buttons open',
  async (t) => {
    const c = await mountCanvas(t, [mkNode('worker', {
      documents: [{ id: 'd1', title: 'Plan', at: '2026-09-07T10:00:00Z' }],
      lineage: ['worker@1'],
    })])
    await openTray(c.el)
    const row = () => rowFor(c.el, 'worker')!

    await rightClick(row()); await pick('Settings')
    assert.ok(document.querySelector('.cfg'), 'Settings opened the node config panel')
    await esc()

    await rightClick(row()); await pick('Show lineage')
    assert.ok(document.querySelector('.lineage-panel'), 'Show lineage opened the lineage panel')
    await esc()

    await rightClick(row()); await pick('Open docket')
    assert.ok([...document.querySelectorAll('h3')].some((h) => /· Docket/.test(h.textContent ?? '')),
      'Open docket opened the agent docket')
    await esc()

    await rightClick(row()); await pick('Open presentations')
    assert.deepEqual(c.galleries, ['worker'],
      'Open presentations asked the shell for THIS agent\'s gallery')
  })

uiTest('§4b Open desk glides the camera to the agent, exactly as clicking the row does',
  async (t) => {
    const c = await mountCanvas(t, [mkNode('worker'), mkNode('other')])
    await openTray(c.el)
    const camera = () => (c.el.querySelector('.space') as HTMLElement).style.transform
    const before = camera()
    await rightClick(rowFor(c.el, 'other')!)
    await pick('Open desk')
    await advance(600, 30)
    assert.notEqual(camera(), before, 'the camera moved to the agent')
  })

uiTest('§5 Retire… opens the card\'s own confirm — same wording, same op, from the list',
  async (t) => {
    const c = await mountCanvas(t, [mkNode('worker', { seat: 1, grant: 2 })])
    await openTray(c.el)
    await rightClick(rowFor(c.el, 'worker')!)
    await pick('Retire…')
    const box = document.querySelector('.confirm-box') as HTMLElement | null
    assert.ok(box, 'the confirm opened')
    assert.match(box!.querySelector('h3')?.textContent ?? '', /retire worker\?/)
    assert.match(box!.textContent ?? '', /context is KEPT/i,
      'the card\'s wording, not a second one written for the list')
    const go = box!.querySelector('button.danger.solid') as HTMLButtonElement
    await inAct(() => { go.click() })
    await flush(2)
    assert.deepEqual(c.ops, [{ op: 'retire', node: 'worker' }],
      'and it runs the very op the card runs')
  })

uiTest('§5b a superior\'s Dissolve confirm is the same one the card raises',
  async (t) => {
    const c = await mountCanvas(t, [mkNode('boss', { children: [mkNode('kid', { parent: 'boss' })] })])
    await openTray(c.el)
    await rightClick(rowFor(c.el, 'boss')!)
    await pick('Dissolve suborganization…')
    const box = document.querySelector('.confirm-box') as HTMLElement
    assert.ok(box, 'the confirm opened')
    assert.match(box.querySelector('h3')?.textContent ?? '', /dissolve boss\?/)
    await inAct(() => { (box.querySelector('button.danger.solid') as HTMLButtonElement).click() })
    await flush(2)
    assert.deepEqual(c.ops, [{ op: 'dissolve', node: 'boss' }])
  })

uiTest('§6 Hire a subordinate… from a row walks to the agent and opens ITS card\'s hire chips',
  async (t) => {
    const c = await mountCanvas(t, [mkNode('worker'), mkNode('other')])
    await openTray(c.el)
    const camera = () => (c.el.querySelector('.space') as HTMLElement).style.transform
    const before = camera()
    // held from BEFORE the walk: the card the camera lands on renders as a
    // desk (no zoomed-out name to find it by again), but it is the same
    // element — React keys cards by agent id
    const card = cardFor(c.el, 'other')
    assert.ok(card, 'positive control: the agent\'s card is on the canvas')
    await rightClick(rowFor(c.el, 'other')!)
    await pick('Hire a subordinate…')
    await advance(600, 30)
    assert.ok(card!.classList.contains('hire-reveal'),
      'the chips the card\'s own menu entry reveals are revealed from the row too')
    assert.notEqual(camera(), before, 'and the camera walked there, since the chips are there')
    // the same rule as the card's: the chips close when the pointer leaves
    await inAct(() => {
      card!.dispatchEvent(new W.PointerEvent('pointerout',
        { bubbles: true, relatedTarget: document.body }))
    })
    await flush(2)
    assert.ok(!card!.classList.contains('hire-reveal'))
  })
