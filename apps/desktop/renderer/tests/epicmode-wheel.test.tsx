// EPIC Mode — a wheel's effect is what the wheel did (docket
// epic-mode-scrolling-a-pinned-window-on-the-canva; user reports 2026-10-15
// 14:27Z: scrolling a pinned window on the canvas showed the canvas's zoom
// effects instead of the scroll effects, and 14:28Z: "same issue for the
// agents list").
//
// The canvas's own wheel listener (OrgCanvas.tsx) never zooms over a pinned
// window, the agents list, a focused desk or a modal: it leaves those wheels
// to the browser, which scrolls them. Anywhere else on the canvas it takes
// the wheel (preventDefault) and zooms the camera, up to its limits. The
// director decided by WHERE a wheel landed (anything inside `.viewport` was a
// zoom), so everything scrollable on the canvas showed the zoom effect.
//
// These tests mount the REAL canvas with the real director on top. jsdom does
// no layout and never scrolls, so each scroller is given the geometry a
// browser would give it (`scrollable`), and after each wheel the test does
// what the browser does once the listeners have run: a wheel nobody prevented
// scrolls that element by its delta, as far as its range allows, and fires
// `scroll` if it moved. The camera is read back from `.space`, where the
// canvas draws it. Real wheels, real scrolling and real frames are checked in
// Electron by tools/rig/epic-mode-visual.mjs (the wheel scene).

import {
  advance, FakeServer, flush, inAct, installFetch, mountView, realClock,
  useFakeClock,
} from './harness'
import { MOVED, flatLabels, openBranchOf, pickIn, surveyMenu } from './menuhelp'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { OrgCanvas } from '../src/canvas/OrgCanvas'
import { resetConvos } from '../src/convo'
import { addPin, forgetPins } from '../src/canvas/pins'
import { setCrowdPilesOn, Z_MAX } from '../src/canvas/shared'
import { startEpic } from '../src/epic/director'
import type { EpicShow, Kind } from '../src/epic/director'
import type { TreePayload } from '../src/types'
// a quiet canvas, and the app feed answered as a legacy engine
import './epicmode-fakes'

const W = window as unknown as Window & typeof globalThis

// ------------------------------------------------------------------ fixture
// (the node/tree shape is contextmenu.test.tsx's, as agentrowmenu.test.tsx uses it)
const asTree = (v: unknown) => v as TreePayload
function mkNode(id: string): unknown {
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
    roots: ids.map(mkNode), cost_usd_total: 0,
    audit: { live_nodes: ids.length, top_level_holds: 0, no_overdraft: true, problems: [] },
    user_inbox_count: 0, user_inbox_newest: null, fable_lock: null,
    auto_resume: false,
    fable_limit_policy: 'freeze', fable_filter_policy: 'halt',
    cascade_hire: false, cascade_alloc: true,
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

// ---------------------------------------------------------------------- rig
type Effect = { kind: Kind; n?: number }
const WHEEL_KINDS: ReadonlySet<Kind> = new Set<Kind>(['zoomIn', 'zoomOut', 'scroll'])

interface Rig { el: HTMLElement; viewport: HTMLElement; seen: Effect[] }
const shows: EpicShow[] = []

/** the real canvas with `ids` on it, its requests answered by the harness's
 *  fake engine, and EPIC Mode on: every wheel effect the director asks for is
 *  recorded, whether or not its gap between two of a kind lets it play */
async function rig(t: TestContext, ids: string[]): Promise<Rig> {
  t.after(stubPointerCapture())
  resetConvos()
  const had = (globalThis as { fetch?: typeof fetch }).fetch
  installFetch(new FakeServer())
  t.after(() => { (globalThis as { fetch?: typeof fetch }).fetch = had })
  const v = await mountView(
    <OrgCanvas tree={tree(ids)} slug="mine" op={() => Promise.resolve({} as never)}
      toast={() => {}} mailEvt={null} />,
    (h) => h)
  t.after(() => v.unmount())
  await flush(); await advance(400, 50); await flush()
  const viewport = v.el.querySelector('.viewport') as HTMLElement | null
  assert.ok(viewport, 'the canvas viewport rendered')
  const show = startEpic({ audio: null, greet: 'none' })
  shows.push(show)
  const seen: Effect[] = []
  const cue = show.cue.bind(show)
  show.cue = (kind, ev = {}) => {
    if (WHEEL_KINDS.has(kind)) seen.push(ev.n === undefined ? { kind } : { kind, n: ev.n })
    cue(kind, ev)
  }
  return { el: v.el, viewport: viewport!, seen }
}

function uiTest(name: string, body: (t: TestContext) => Promise<void>) {
  test(name, async (t: TestContext) => {
    useFakeClock()
    forgetPins()
    setCrowdPilesOn(false)
    try { localStorage.clear() } catch { /* private mode */ }
    try { await body(t) } finally {
      for (const s of shows.splice(0)) s.stop()
      forgetPins(); setCrowdPilesOn(false); realClock()
    }
  })
}

/** the camera's zoom, read back out of the transform the canvas drew on `.space` */
function zoomOf(r: Rig): number {
  const space = r.el.querySelector('.space') as HTMLElement | null
  assert.ok(space, 'the canvas world element (.space) rendered')
  const m = /scale\(\s*([\d.e+-]+)\s*\)/.exec(space!.style.transform)
  assert.ok(m, `a scale() in the camera transform "${space!.style.transform}"`)
  return Number(m![1])
}

/** Give a scroller the geometry jsdom lacks: `content` px of content in a
 *  `box` px box, starting at `top`, its offset clamped to that range the way
 *  a browser clamps it. */
function scrollable(el: HTMLElement, content: number, box: number, top = content - box): void {
  let at = top
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => content })
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => box })
  Object.defineProperty(el, 'scrollTop', { configurable: true, get: () => at,
    set: (v: number) => { at = Math.max(0, Math.min(content - box, v)) } })
}

/** One wheel notch over `target`, as the browser dispatches it (cancelable,
 *  bubbling: the director's listener, then the canvas's), then what the
 *  browser does with it: a wheel nobody prevented scrolls `scroller` by its
 *  delta, as far as its range allows, and fires `scroll` if it moved. The
 *  frames after it pass. Returns the wheel effects the director asked for,
 *  and whether the wheel was taken. */
async function notch(r: Rig, target: Element, deltaY: number,
  scroller?: HTMLElement): Promise<{ effects: Effect[]; taken: boolean }> {
  const from = r.seen.length
  const e = new W.WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY, clientX: 300, clientY: 200 })
  await inAct(() => { target.dispatchEvent(e) })
  if (scroller && !e.defaultPrevented) {
    const was = scroller.scrollTop
    scroller.scrollTop = was + deltaY
    if (scroller.scrollTop !== was) await inAct(() => { scroller.dispatchEvent(new W.Event('scroll')) })
  }
  await advance(200, 16)
  return { effects: r.seen.slice(from), taken: e.defaultPrevented }
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
  assert.ok(tray, 'the agents list opened')
  return tray!
}
const rowFor = (el: HTMLElement, id: string) =>
  [...el.querySelectorAll('.tray-row')].find((row) =>
    row.querySelector('.tray-name')?.textContent === id) as HTMLElement | undefined

/** a right-click as the browser dispatches it (agentrowmenu.test.tsx's helper) */
async function rightClick(el: Element) {
  await inAct(() => {
    el.dispatchEvent(new W.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 40, clientY: 30 }))
  })
  await flush(2)
  if (document.querySelector('.ctxmenu')) await surveyMenu()
}
/** choosing a menu entry: the press first, then the click */
async function pick(label: string) {
  const moved = MOVED[label]
  if (moved) { await pickIn(moved[0], moved[1]); await flush(2); return }
  await openBranchOf(label)
  const item = [...document.querySelectorAll('.ctxmenu [role="menuitem"]')]
    .find((b) => b.textContent === label) as HTMLButtonElement | undefined
  assert.ok(item, `menu item "${label}" present — have ${JSON.stringify(flatLabels())}`)
  await inAct(() => {
    item!.dispatchEvent(new W.PointerEvent('pointerdown', { bubbles: true, button: 0 }))
    item!.click()
  })
  await flush(2)
}

/** cto's desk pinned to screen space, and the chat inside it: a long
 *  conversation read at its newest line (the desk follows the bottom) */
async function pinned(r: Rig): Promise<HTMLElement> {
  await inAct(() => { addPin('mine', 'cto', { x: 100, y: 100, w: 420, h: 320 }) })
  await advance(100, 16)
  const win = r.el.querySelector('.pinwin[data-id="cto"]') as HTMLElement | null
  assert.ok(win, 'cto\'s desk is pinned to screen space')
  assert.ok(win!.closest('.viewport'), 'the pinned window is drawn inside the canvas viewport (where the bug lived)')
  const chat = win!.querySelector('.msgs') as HTMLElement | null
  assert.ok(chat, 'the pinned desk has its chat scroller')
  scrollable(chat!, 2000, 300)
  return chat!
}

/** focus `id` from its row's menu: the camera glides onto its desk */
async function focus(r: Rig, id: string): Promise<void> {
  await openTray(r.el)
  await rightClick(rowFor(r.el, id)!)
  await pick('Focus')
}

// ------------------------------------------------------------------ the tests
uiTest('a pinned window on the canvas: scrolling it shows the scroll effect, never the zoom', async (t) => {
  const r = await rig(t, ['ceo', 'cto'])
  const chat = await pinned(r)
  const z = zoomOf(r)
  const up = await notch(r, chat, -120, chat)
  assert.equal(up.taken, false, 'the canvas left the wheel to the pinned window')
  assert.deepEqual(up.effects, [{ kind: 'scroll', n: -1 }], 'scrolling up: one scroll effect, pointing up')
  const down = await notch(r, chat, 120, chat)
  assert.deepEqual(down.effects, [{ kind: 'scroll', n: 1 }], 'scrolling back down: one scroll effect, pointing down')
  assert.equal(zoomOf(r), z, 'the camera never moved')
})

uiTest('a pinned window at the end of its chat: the wheel moves nothing, so nothing plays', async (t) => {
  const r = await rig(t, ['ceo', 'cto'])
  const chat = await pinned(r)
  const z = zoomOf(r)
  const end = await notch(r, chat, 120, chat)
  assert.equal(end.taken, false, 'the canvas still left the wheel to the pinned window: it never zooms there')
  assert.equal(chat.scrollTop, 1700, 'the chat stayed at its newest line')
  assert.deepEqual(end.effects, [], 'nothing scrolled and nothing zoomed: no effect')
  assert.equal(zoomOf(r), z, 'the camera never moved')
})

uiTest('a pinned window while the camera glides: the camera\'s own move is not the wheel\'s zoom', async (t) => {
  const r = await rig(t, ['ceo', 'cto', 'qa'])
  const chat = await pinned(r)
  const z = zoomOf(r)
  // focusing qa glides the camera onto qa's desk; the wheel lands on the
  // pinned window while the camera is still on its way
  await focus(r, 'qa')
  const during = await notch(r, chat, -120, chat)
  assert.notEqual(zoomOf(r), z, 'the camera did zoom, on its own glide')
  assert.deepEqual(during.effects, [{ kind: 'scroll', n: -1 }], 'the wheel scrolled the pinned window: a scroll effect, not a zoom')
})

uiTest('the agents list: scrolling it shows the scroll effect, never the zoom', async (t) => {
  const r = await rig(t, ['ceo', 'cto', 'qa', 'ops'])
  const tray = await openTray(r.el)
  const row = rowFor(r.el, 'qa')
  assert.ok(row, 'qa has a row in the agents list')
  assert.ok(tray.closest('.viewport'), 'the agents list is drawn inside the canvas viewport (where the bug lived)')
  scrollable(tray, 900, 300, 0)
  const z = zoomOf(r)
  const down = await notch(r, row!, 120, tray)
  assert.equal(down.taken, false, 'the canvas left the wheel to the agents list')
  assert.deepEqual(down.effects, [{ kind: 'scroll', n: 1 }], 'scrolling the list down: one scroll effect')
  const up = await notch(r, row!, -120, tray)
  assert.deepEqual(up.effects, [{ kind: 'scroll', n: -1 }], 'scrolling the list up: one scroll effect')
  const top = await notch(r, row!, -120, tray)
  assert.deepEqual(top.effects, [], 'at the top of the list the wheel moves nothing: no effect')
  assert.equal(zoomOf(r), z, 'the camera never moved')
})

uiTest('a desk on the canvas: scrolling its chat shows the scroll effect, never the zoom', async (t) => {
  const r = await rig(t, ['ceo', 'cto'])
  await focus(r, 'cto')
  await advance(1500, 30)
  const desk = r.el.querySelector('.sq.desk:not(.user) .desk-over') as HTMLElement | null
  assert.ok(desk, 'focusing cto opened its desk on the canvas')
  const chat = desk!.querySelector('.msgs') as HTMLElement | null
  assert.ok(chat, 'the desk has its chat scroller')
  scrollable(chat!, 2000, 300)
  const z = zoomOf(r)
  const up = await notch(r, chat!, -120, chat!)
  assert.equal(up.taken, false, 'the canvas left the wheel to the desk')
  assert.deepEqual(up.effects, [{ kind: 'scroll', n: -1 }], 'scrolling the desk\'s chat up: one scroll effect')
  assert.equal(zoomOf(r), z, 'the camera never moved')
})

uiTest('an agent\'s docket (an ordinary panel): a scroll shows the scroll effect, its top shows nothing', async (t) => {
  const r = await rig(t, ['ceo', 'cto'])
  await openTray(r.el)
  await rightClick(rowFor(r.el, 'cto')!)
  await pick('Open docket')
  const title = [...document.querySelectorAll('h3')].find((h) => /· Docket/.test(h.textContent ?? ''))
  assert.ok(title, 'Open docket opened cto\'s docket')
  const panel = title!.closest('.settings') as HTMLElement | null
  assert.ok(panel && panel.closest('.overlay'), 'the docket is a modal panel (.overlay > .settings, overflow-y: auto)')
  scrollable(panel!, 1500, 600, 0)
  const down = await notch(r, title!, 120, panel!)
  assert.deepEqual(down.effects, [{ kind: 'scroll', n: 1 }], 'scrolling the docket down: one scroll effect')
  const up = await notch(r, title!, -120, panel!)
  assert.deepEqual(up.effects, [{ kind: 'scroll', n: -1 }], 'scrolling it back up: one scroll effect')
  const top = await notch(r, title!, -120, panel!)
  assert.deepEqual(top.effects, [], 'at its top the wheel moves nothing: no effect')
})

uiTest('the canvas itself: a wheel that zooms the camera shows the zoom effect (the control)', async (t) => {
  const r = await rig(t, ['ceo', 'cto'])
  const z0 = zoomOf(r)
  const zin = await notch(r, r.viewport, -120)
  assert.equal(zin.taken, true, 'the canvas took the wheel to zoom')
  const z1 = zoomOf(r)
  assert.ok(z1 > z0, `the camera zoomed in (${z0} → ${z1})`)
  assert.deepEqual(zin.effects, [{ kind: 'zoomIn' }], 'zooming in: one zoom-in effect')
  const zout = await notch(r, r.viewport, 120)
  assert.ok(zoomOf(r) < z1, 'the camera zoomed out')
  assert.deepEqual(zout.effects, [{ kind: 'zoomOut' }], 'zooming out: one zoom-out effect')
})

uiTest('the canvas at its zoom limit: the wheel moves nothing, so nothing plays', async (t) => {
  const r = await rig(t, ['ceo', 'cto'])
  for (let i = 0; i < 60 && zoomOf(r) < Z_MAX; i++) await notch(r, r.viewport, -300)
  assert.equal(zoomOf(r), Z_MAX, 'the camera reached its closest zoom')
  const past = await notch(r, r.viewport, -120)
  assert.equal(past.taken, true, 'the canvas still took the wheel')
  assert.equal(zoomOf(r), Z_MAX, 'and the camera stayed at its limit')
  assert.deepEqual(past.effects, [], 'nothing zoomed: no effect')
  const back = await notch(r, r.viewport, 120)
  assert.deepEqual(back.effects, [{ kind: 'zoomOut' }], 'zooming back out from the limit plays')
})

uiTest('a panel outside the canvas: a scroll shows the scroll effect, its end shows nothing', async (t) => {
  const r = await rig(t, ['ceo'])
  // a side panel of the app, outside the canvas viewport
  const panel = document.createElement('div')
  panel.className = 'side-panel'
  panel.innerHTML = '<div class="row">one</div><div class="row">two</div>'
  document.body.append(panel)
  t.after(() => panel.remove())
  scrollable(panel, 600, 200, 0)
  const row = panel.querySelector('.row')!
  assert.equal(row.closest('.viewport') === null, true, 'the panel is outside the canvas')
  const down = await notch(r, row, 120, panel)
  assert.deepEqual(down.effects, [{ kind: 'scroll', n: 1 }], 'it scrolled: one scroll effect, as before')
  panel.scrollTop = 400
  const end = await notch(r, row, 120, panel)
  assert.deepEqual(end.effects, [], 'at its end the wheel moves nothing: no effect')
})
