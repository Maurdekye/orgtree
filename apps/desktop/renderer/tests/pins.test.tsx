// pins.test.tsx — FR-3, a desk PINNED TO SCREENSPACE (canvas/pins.tsx).
//
// The user's spec: a pin button detaches a desk from the canvas into a window
// that does not move when the canvas pans or zooms, can be dragged and
// resized like an OS window, and unpins back to its agent's card. The user's
// ruling on top of it — "PINNED MEANS PINNED" — is that zooming onto a pinned
// agent's card must NOT open a second desk: two mounted desks for one node
// share one `orgtree-draft-<slug>-<nid>` composer key and fight over it
// silently, so this suite exists mostly to make that failure LOUD.
//
// What this proves and what it cannot. jsdom does no layout: every
// getBoundingClientRect is 0×0, so the viewport is UNMEASURED here and the
// clamp / on-vs-off-screen classification are exercised as pure functions
// with explicit numbers (§A) rather than through the DOM. The component tests
// (§B) assert on what the code itself writes — the window's inline left/top/
// width/height in viewport px, its place in the DOM tree (a SIBLING of
// `.space`, never inside it — the structural fact that makes it immune to
// the camera), the camera transform on `.space`, and localStorage. Two things
// only a browser can show are NOT covered here and are said so in the code:
// the invisible-selection pan-killer (styles.css `.viewport` comment; jsdom
// models no selection) and real pixel placement.
//
// Each check was watched fail: with the `focusId` exclusion removed, §B3
// counts two `cto` desks; with the wheel carve-out removed, §B6 sees the
// camera zoom under the window; with the store's localStorage write removed,
// §B7 finds nothing after the reload.
//
// Run:  cd frontend && node tests/run.mjs pins

import { advance, flush, inAct, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { useState } from 'react'
import { NODE_H, NODE_W, Z_DESK, Z_MINI } from '../src/canvas/shared'
import {
  addPin, clampRect, forgetPins, PIN_MAX, PIN_MIN_H, PIN_MIN_W,
  PIN_Z_BASE, PIN_Z_TOP, pinsKey, planUnpin, prunePins, raisePin,
  renamePin,
  readPins, removePin, zIndexOf, commitRect,
} from '../src/canvas/pins'
import type { PinRect } from '../src/canvas/pins'
import type { TreePayload } from '../src/types'
import { setModalOverlap } from '../src/canvas/pinoverlap'

const noop = () => {}

uiTest('pinned desks share the optional overlap fading treatment', async ({mount}) => {
  const rig = await mountCanvas(mount,['worker'])
  await inAct(()=>addPin('mine','worker',{x:10,y:10,w:400,h:400}))
  const panel=pinWin(rig.el,'worker')!
  assert.ok(panel)
  const desk=document.createElement('div'); desk.className='sq desk'; desk.innerHTML='<div class="desk-over"></div>'
  document.body.appendChild(desk)
  let visible=true
  const rect=(left:number)=>({x:left,y:0,left,top:0,right:left+400,bottom:400,width:400,height:400,toJSON(){}})
  panel.getBoundingClientRect=()=>rect(10)
  desk.getBoundingClientRect=()=>rect(visible?0:1000)
  try {
    await inAct(()=>setModalOverlap({enabled:false,opacity:0.7}))
    await settle(150)
    assert.equal(panel.style.opacity,'')
    await inAct(()=>setModalOverlap({enabled:true,opacity:0.7}))
    await settle(150)
    assert.equal(panel.style.opacity,'0.7','enabled overlap fades the actual pinned desk')
    visible=false; await settle(150)
    assert.equal(panel.style.opacity,'','moving apart restores opacity')
    visible=true; desk.innerHTML=''; await settle(150)
    assert.equal(panel.style.opacity,'','an unexpanded placeholder cannot trigger fading')
  } finally {desk.remove(); await inAct(()=>setModalOverlap({enabled:false,opacity:0.7}))}
})

// ------------------------------------------------------------------ fixture
const asTree = (v: unknown) => v as TreePayload

function tree(nodeIds: string[], states: Record<string, string> = {},
  sessions: Record<string, string> = {}): TreePayload {
  const mk = (id: string) => ({
    id, title: id, session_id: sessions[id], tier: 'haiku', model_id: 'haiku', state: states[id] ?? 'live',
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
/** the camera, read back out of the transform the canvas rendered on
 *  `.space` — the single source of truth for where the WORLD sits on screen */
const cam = (el: HTMLElement): Cam => {
  const space = el.querySelector('.space') as HTMLElement | null
  assert.ok(space, 'the canvas world element (.space) did not render')
  return parseXf(space!.style.transform, 'the camera')
}
function posByName(el: HTMLElement, id: string): Pos {
  for (const sq of [...el.querySelectorAll('.sq')] as HTMLElement[]) {
    const hook = sq.querySelector('.sq-head span.name, .mini-name')
    if (hook && (hook.textContent ?? '').trim() === id) {
      return parseXf(sq.style.transform, `the "${id}" card position`)
    }
  }
  return assert.fail(`no unfocused card rendered for "${id}"`)
}
/** any card's world position by its data — the desk/placeholder card has
 *  no name hook, so this walks every `.sq` and matches the desk/placeholder
 *  chrome's name instead */
function posAny(el: HTMLElement, id: string): Pos {
  for (const sq of [...el.querySelectorAll('.sq')] as HTMLElement[]) {
    const hook = sq.querySelector('.sq-head span.name, .mini-name, .cc-name, .pin-placeholder')
    const txt = (hook?.textContent ?? '').trim()
    const title = (hook as HTMLElement | null)?.title ?? ''
    if (hook && (txt === id || title.startsWith(`${id}'s desk`))) {
      return parseXf(sq.style.transform, `the "${id}" card position`)
    }
  }
  return assert.fail(`no card rendered for "${id}"`)
}
const centreOf = (el: HTMLElement, p: Pos): Pos => {
  const v = cam(el)
  return { x: (p.x + NODE_W / 2) * v.z + v.x, y: (p.y + NODE_H / 2) * v.z + v.y }
}
/** world → viewport px, the same expression OrgCanvas uses (pins.tsx header) */
const screenRectOf = (el: HTMLElement, p: Pos): PinRect => {
  const v = cam(el)
  return { x: p.x * v.z + v.x, y: p.y * v.z + v.y, w: NODE_W * v.z, h: NODE_H * v.z }
}
const settle = (ms: number) => advance(ms, 16)

// ------------------------------------------------------------------ events
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
/** a full press-drag-release on one element, as the browser delivers it once
 *  that element has pointer capture (stubbed above: capture is a no-op, so
 *  every event is dispatched at the element itself) */
async function drag(target: Element, from: Pos, to: Pos) {
  await inAct(() => { target.dispatchEvent(pointer('pointerdown', from.x, from.y)) })
  await inAct(() => { target.dispatchEvent(pointer('pointermove', to.x, to.y)) })
  await inAct(() => { target.dispatchEvent(pointer('pointerup', to.x, to.y)) })
  await flush()
}

// -------------------------------------------------------------------- rig
let canvasMod: typeof import('../src/canvas/OrgCanvas') | null = null

function makeHost(toast: (lines: string[] | null | undefined) => void) {
  const box: { set?: (t: TreePayload) => void } = {}
  const Host = ({ initial }: { initial: TreePayload }) => {
    const [t, setT] = useState(initial)
    box.set = setT
    const { OrgCanvas } = canvasMod!
    return <OrgCanvas tree={t} op={() => Promise.resolve({} as never)}
      slug="mine" toast={toast} mailEvt={null} />
  }
  return { Host, box }
}

type Mount = (el: React.ReactElement) => Promise<{ el: HTMLElement; unmount: () => Promise<void> }>

function uiTest(name: string, body: (k: { mount: Mount }) => Promise<void>): void {
  test(name, async (t: TestContext) => {
    useFakeClock()
    const unstub = stubPointerCapture()
    // every test starts with NO pins — in storage and in the module cache
    localStorage.clear()
    forgetPins()
    const open: { unmount: () => Promise<void> }[] = []
    t.after(async () => {
      for (const m of open) { try { await m.unmount() } catch { /* gone */ } }
      unstub()
      realClock()
      localStorage.clear()
      forgetPins()
    })
    await body({
      mount: async (el) => {
        const v = await mountView(el, (host) => host)
        open.push(v)
        return { el: v.el, unmount: v.unmount }
      },
    })
  })
}

async function mountCanvas(mount: Mount, ids: string[],
  toasts: string[][] = [], sessions: Record<string, string> = {}) {
  canvasMod = await import('../src/canvas/OrgCanvas')
  const { Host, box } = makeHost((lines) => { if (lines?.length) toasts.push(lines) })
  const { el, unmount } = await mount(<Host initial={tree(ids, {}, sessions)} />)
  await flush()
  const viewport = el.querySelector('.viewport') as HTMLElement | null
  assert.ok(viewport, 'the canvas viewport rendered')
  return { el, viewport: viewport!, setTree: (t: TreePayload) => box.set!(t), unmount, toasts }
}

/** put `id` under a desk-zoom camera, through the public gesture surface:
 *  a pan to centre the card, then wheel notches at the centre. Returns
 *  whatever now sits in the desk's place on the card, if anything. */
async function zoomOnto(el: HTMLElement, viewport: HTMLElement, id: string) {
  const s = centreOf(el, posAny(el, id))
  await inAct(() => { viewport.dispatchEvent(pointer('pointerdown', 600, 600)) })
  await inAct(() => { viewport.dispatchEvent(pointer('pointermove', 600 - s.x, 600 - s.y)) })
  await inAct(() => { viewport.dispatchEvent(pointer('pointerup', 600 - s.x, 600 - s.y)) })
  await flush()
  const after = centreOf(el, posAny(el, id))
  assert.ok(Math.hypot(after.x, after.y) < 1,
    `panning did not put "${id}" at the viewport centre (off by ${Math.hypot(after.x, after.y)})`)
  for (let i = 0; i < 40 && cam(el).z < Z_DESK * 1.1; i++) {
    await inAct(() => { viewport.dispatchEvent(wheel(0, 0, -300)) })
  }
  await flush()
  assert.ok(cam(el).z >= Z_DESK, `could not reach desk zoom (got z=${cam(el).z})`)
  await settle(600)
}

/** mount, settle the opening drift, focus `id`'s desk on the canvas */
async function focusDesk(el: HTMLElement, viewport: HTMLElement, id: string) {
  await zoomOnto(el, viewport, id)
  const desk = el.querySelector('.desk-over') as HTMLElement | null
  assert.ok(desk, `"${id}" did not become the focused desk at z=${cam(el).z}`)
  return desk!
}

const pinWin = (el: HTMLElement, id: string) =>
  el.querySelector(`.pinwin[data-id="${id}"]`) as HTMLElement | null
const winRect = (w: HTMLElement): PinRect => ({
  x: parseFloat(w.style.left), y: parseFloat(w.style.top),
  w: parseFloat(w.style.width), h: parseFloat(w.style.height),
})

// Mosaic controls use the real PinLayer under OrgCanvas. jsdom supplies a
// measured viewport explicitly; real pointer capture/geometry is also probed
// in Edge separately. No new model or fake snap implementation in this fixture.
async function mosaicRig(mount: Mount) {
  const rig = await mountCanvas(mount, ['ceo', 'cto', 'qa'])
  const size = { w: 1300, h: 850 }
  Object.defineProperty(rig.viewport, 'getBoundingClientRect', { configurable: true,
    value: () => ({ x: 0, y: 0, top: 0, left: 0, right: size.w, bottom: size.h,
      width: size.w, height: size.h, toJSON: () => ({}) }) })
  await inAct(() => {
    addPin('mine', 'ceo', { x: 100, y: 100, w: 320, h: 240 })
    addPin('mine', 'cto', { x: 680, y: 400, w: 320, h: 240 })
  })
  await flush()
  const title = pinWin(rig.el, 'cto')!.querySelector('.pinwin-title')!
  return { ...rig, title, size }
}

uiTest('mosaic preview and commit: two windows align, neighbours stay still, reload preserves it', async ({ mount }) => {
  const { el, title } = await mosaicRig(mount)
  const before = readPins('mine').find((p) => p.id === 'ceo')!.rect
  await inAct(() => { title.dispatchEvent(pointer('pointerdown', 700, 412)) })
  await inAct(() => { title.dispatchEvent(pointer('pointermove', 451, 117)) })
  const preview = el.querySelector('.pin-snap-preview') as HTMLElement
  assert.ok(preview, 'snap preview is visible before release')
  assert.equal(preview.style.left, '420px')
  assert.equal(preview.style.top, '100px', 'nearby corners align')
  assert.equal(readPins('mine').find((p) => p.id === 'cto')!.rect.x, 680, 'preview never persists')
  await inAct(() => { title.dispatchEvent(pointer('pointerup', 451, 117)) })
  assert.deepEqual(readPins('mine').find((p) => p.id === 'cto')!.rect, { x: 420, y: 100, w: 320, h: 240 })
  assert.deepEqual(readPins('mine').find((p) => p.id === 'ceo')!.rect, before)
  assert.equal(el.querySelector('.pin-snap-preview'), null)
  const saved = JSON.parse(localStorage.getItem(pinsKey('mine'))!)
  await inAct(() => { forgetPins('mine') })
  assert.deepEqual(readPins('mine'), saved, 'durable rect and snap survive cache reset')
})

uiTest('mosaic release uses latest coordinates and target, including removal', async ({ mount }) => {
  const { el, title } = await mosaicRig(mount)
  await inAct(() => { title.dispatchEvent(pointer('pointerdown', 700, 412)) })
  await inAct(() => { title.dispatchEvent(pointer('pointermove', 451, 117)) })
  await inAct(() => { removePin('mine', 'ceo') })
  await inAct(() => { title.dispatchEvent(pointer('pointerup', 460, 150)) })
  assert.deepEqual(readPins('mine').find((p) => p.id === 'cto')!.rect, { x: 440, y: 138, w: 320, h: 240 })
  assert.equal(readPins('mine')[0]!.snap, null)
  assert.equal(el.querySelector('.pin-snap-preview'), null)
})

uiTest('mosaic cancel and Escape revert; foreign pointer cannot steal a gesture', async ({ mount }) => {
  const { el, title } = await mosaicRig(mount)
  const before = { ...readPins('mine').find((p) => p.id === 'cto')!.rect }
  for (const how of ['pointercancel', 'Escape']) {
    await inAct(() => { title.dispatchEvent(pointer('pointerdown', 700, 412)) })
    await inAct(() => { title.dispatchEvent(pointer('pointermove', 451, 117)) })
    await inAct(() => {
      if (how === 'Escape') window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      else title.dispatchEvent(pointer('pointercancel', 451, 117))
    })
    assert.deepEqual(winRect(pinWin(el, 'cto')!), before, 'cancel restores rendered rectangle immediately')
    assert.equal(el.querySelector('.pin-snap-preview'), null)
    await inAct(() => { title.dispatchEvent(pointer('pointerup', 451, 117)) })
    assert.deepEqual(readPins('mine').find((p) => p.id === 'cto')!.rect, before)
  }
  await inAct(() => { title.dispatchEvent(pointer('pointerdown', 700, 412)) })
  await inAct(() => { title.dispatchEvent(new window.PointerEvent('pointerup', { bubbles: true, pointerId: 99, clientX: 451, clientY: 117 })) })
  assert.deepEqual(readPins('mine').find((p) => p.id === 'cto')!.rect, before)
  await inAct(() => { title.dispatchEvent(pointer('pointerup', 451, 117)) })
  assert.equal(readPins('mine').find((p) => p.id === 'cto')!.rect.x, 420, 'positive control: owning pointer commits')
})

uiTest('mosaic Shift bypass, moving away, clicking and resizing keep free placement usable', async ({ mount }) => {
  const { el, title } = await mosaicRig(mount)
  await inAct(() => { title.dispatchEvent(pointer('pointerdown', 700, 412)) })
  await inAct(() => { title.dispatchEvent(new window.PointerEvent('pointerup', { bubbles: true, pointerId: 1,
    clientX: 451, clientY: 117, shiftKey: true })) })
  assert.deepEqual(readPins('mine').find((p) => p.id === 'cto')!.rect, { x: 431, y: 105, w: 320, h: 240 })
  await drag(title, { x: 451, y: 117 }, { x: 450, y: 118 }) // below movement threshold
  assert.equal(readPins('mine').find((p) => p.id === 'cto')!.rect.x, 431)
  await drag(title, { x: 451, y: 117 }, { x: 444, y: 117 })
  const snap = readPins('mine').find((p) => p.id === 'cto')!.snap
  assert.ok(snap, 'positive control: normal drag snaps')
  await drag(title, { x: 440, y: 112 }, { x: 440, y: 112 })
  assert.deepEqual(readPins('mine').find((p) => p.id === 'cto')!.snap, snap)
  await drag(el.querySelector('.pinwin-resize-frame[data-id="cto"] .pinwin-rs.se')!, { x: 740, y: 340 }, { x: 770, y: 360 })
  assert.equal(readPins('mine').find((p) => p.id === 'cto')!.snap, null, 'resize detaches metadata')
  await drag(title, { x: 440, y: 112 }, { x: 620, y: 350 })
  assert.equal(readPins('mine').find((p) => p.id === 'cto')!.snap, null, 'drag away releases')
})

uiTest('mosaic current target movement and viewport shrink are resolved on release', async ({ mount }) => {
  const { title, size } = await mosaicRig(mount)
  await inAct(() => { title.dispatchEvent(pointer('pointerdown', 700, 412)) })
  await inAct(() => { title.dispatchEvent(pointer('pointermove', 451, 117)) })
  await inAct(() => { commitRect('mine', 'ceo', { x: 110, y: 100, w: 320, h: 240 }, size) })
  await inAct(() => { title.dispatchEvent(pointer('pointerup', 451, 117)) })
  assert.equal(readPins('mine').find((p) => p.id === 'cto')!.rect.x, 430, 'uses new target edge')
  await inAct(() => { title.dispatchEvent(pointer('pointerdown', 450, 112)) })
  await inAct(() => { title.dispatchEvent(pointer('pointermove', 900, 700)) })
  size.w = 600; size.h = 420
  await inAct(() => { window.dispatchEvent(new window.Event('resize')) })
  await inAct(() => { title.dispatchEvent(pointer('pointerup', 900, 700)) })
  const r = readPins('mine').find((p) => p.id === 'cto')!.rect
  assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.w <= 600 && r.y + r.h <= 420)
})
/** how many live desks exist for `id` anywhere in the host — the number the
 *  user's ruling says must never exceed one */
const desksFor = (el: HTMLElement, id: string) =>
  [...el.querySelectorAll('.desk-body .cc-name')]
    .filter((n) => (n.textContent ?? '').trim() === id).length
const storedFor = (slug: string) => {
  const raw = localStorage.getItem(pinsKey(slug))
  return raw ? JSON.parse(raw) as { id: string; rect: PinRect; z: number; snap: null }[] : []
}
const stored = () => storedFor('mine')

/** pin `id` from its focused desk's header button and return its window */
async function pinFromDesk(el: HTMLElement, viewport: HTMLElement, id: string) {
  await focusDesk(el, viewport, id)
  const btn = el.querySelector('.desk-over .cc-pin') as HTMLElement | null
  assert.ok(btn, 'the desk header renders a pin button')
  await inAct(() => { btn!.click() })
  await flush()
  const w = pinWin(el, id)
  assert.ok(w, `pinning "${id}" rendered no .pinwin`)
  return w!
}

// =================================================================== §A pure
test('§A1 clampRect keeps the whole window inside a measured viewport', () => {
  const vp = { w: 1200, h: 800 }
  const r = { x: 100, y: 100, w: 400, h: 300 }
  assert.deepEqual(clampRect(r, vp), r, 'an in-view rect passes through')
  // Every edge stays inside the viewport, not just the title-bar grab area.
  const right = clampRect({ ...r, x: 5000 }, vp)
  assert.equal(right.x, 1200 - r.w); assert.equal(right.x + right.w, 1200)
  const left = clampRect({ ...r, x: -5000 }, vp)
  assert.equal(left.x, 0); assert.equal(left.x + left.w, r.w)
  assert.equal(clampRect({ ...r, y: -50 }, vp).y, 0)
  const bottom = clampRect({ ...r, y: 5000 }, vp)
  assert.equal(bottom.y, 800 - r.h); assert.equal(bottom.y + bottom.h, 800)
  // the size floor is part of the clamp
  const small = clampRect({ x: 0, y: 0, w: 10, h: 10 }, vp)
  assert.equal(small.w, PIN_MIN_W); assert.equal(small.h, PIN_MIN_H)
  // A small viewport is still a positive control: dimensions are reduced so
  // the full window, including its resize edges, remains inside it.
  const tiny = clampRect({ x: -50, y: -50, w: 500, h: 500 }, { w: 200, h: 100 })
  assert.deepEqual(tiny, { x: 0, y: 0, w: 200, h: 100 })
  // an UNMEASURED viewport (jsdom, pre-layout) must not pile windows at the
  // origin: the rect passes through untouched (floor aside)
  assert.deepEqual(clampRect({ ...r, x: 5000 }, null), { ...r, x: 5000 })
  assert.deepEqual(clampRect({ ...r, x: 5000 }, { w: 0, h: 0 }), { ...r, x: 5000 })
})

test('§A2 planUnpin: on-screen flies home, off-screen flies out, gone fades', () => {
  const vp = { w: 1000, h: 700 }
  const on = planUnpin({ x: 100, y: 100, w: 300, h: 300 }, vp)
  assert.equal(on.kind, 'onscreen')
  // partially visible still counts as on-screen — the user can see where it went
  assert.equal(planUnpin({ x: -200, y: 100, w: 300, h: 300 }, vp).kind, 'onscreen')
  const off = planUnpin({ x: 3000, y: -4000, w: 300, h: 300 }, vp)
  assert.equal(off.kind, 'offscreen')
  // the target is STILL the real card rect: the ghost flies toward it and is
  // clipped, it is never clamped to the edge (that would say "the agent is here")
  assert.deepEqual((off as { to: PinRect }).to, { x: 3000, y: -4000, w: 300, h: 300 })
  assert.equal(planUnpin(null, vp).kind, 'gone')
  // unmeasured viewport: no false "off-screen" toast
  assert.equal(planUnpin({ x: 3000, y: -4000, w: 300, h: 300 }, null).kind, 'onscreen')
})

test('§A3 the store: cap, z band, raise renormalises, prune drops the gone', () => {
  localStorage.clear(); forgetPins()
  const r = { x: 0, y: 0, w: 400, h: 300 }
  for (let i = 0; i < PIN_MAX; i++) assert.ok(addPin('t', `a${i}`, r).ok, `pin #${i + 1} accepted`)
  const over = addPin('t', 'one-too-many', r)
  assert.ok(!over.ok, 'the cap refuses')
  assert.match((over as { reason: string }).reason, /unpin one first/)
  assert.ok(!addPin('t', 'a0', r).ok, 'a duplicate is refused')
  assert.equal(readPins('t').length, PIN_MAX)
  // z ordinals are 0..n-1 and the CSS band is clamped whatever n is
  const zs = readPins('t').map((p) => p.z).sort((a, b) => a - b)
  assert.deepEqual(zs, [...Array(PIN_MAX).keys()])
  for (const p of readPins('t')) {
    assert.ok(zIndexOf(p.z) >= PIN_Z_BASE && zIndexOf(p.z) <= PIN_Z_TOP,
      `z-index ${zIndexOf(p.z)} escaped the band`)
  }
  assert.equal(zIndexOf(500), PIN_Z_TOP, 'a runaway ordinal is clamped under the modals')
  // raise: a0 was bottom (raised last at creation order); raising it makes it top
  raisePin('t', 'a0')
  const top = readPins('t').reduce((m, p) => (p.z > m.z ? p : m))
  assert.equal(top.id, 'a0')
  assert.deepEqual(readPins('t').map((p) => p.z).sort((a, b) => a - b), [...Array(PIN_MAX).keys()],
    'raising renormalises to 0..n-1 rather than growing forever')
  // array ORDER is stable across raises (stage 2 mosaics in array order)
  assert.deepEqual(readPins('t').map((p) => p.id), [...Array(PIN_MAX).keys()].map((i) => `a${i}`))
  // prune: only the gone ids leave, and they are named
  const gone = prunePins('t', (id) => id !== 'a3' && id !== 'a5')
  assert.deepEqual(gone.sort(), ['a3', 'a5'])
  assert.equal(readPins('t').length, PIN_MAX - 2)
  assert.deepEqual(prunePins('t', () => true), [], 'nothing gone → nothing dropped')
  removePin('t', 'a0')
  assert.ok(!readPins('t').some((p) => p.id === 'a0'))
  // the persisted shape carries the stage-2 seam from day one
  for (const p of storedFor('t')) assert.ok('snap' in p && p.snap === null)
  // garbage in storage reads as no pins, never a throw
  localStorage.setItem(pinsKey('g'), '{not json')
  forgetPins('g')
  assert.deepEqual(readPins('g'), [])
  localStorage.setItem(pinsKey('g'), JSON.stringify([{ id: 'x' }, { id: 'y', rect: r, z: 0 }]))
  forgetPins('g')
  assert.deepEqual(readPins('g').map((p) => p.id), ['y'], 'a malformed entry is skipped, a good one kept')
  localStorage.clear(); forgetPins()
})

// ============================================================ §B the canvas
uiTest('§B1 pin: the desk becomes a screen-space window over the card it left', async ({ mount }) => {
  const { el, viewport } = await mountCanvas(mount, ['ceo', 'cto'])
  await settle(2500)
  await focusDesk(el, viewport, 'cto')
  const before = screenRectOf(el, posAny(el, 'cto'))
  const btn = el.querySelector('.desk-over .cc-pin') as HTMLElement
  await inAct(() => { btn.click() })
  await flush()
  const w = pinWin(el, 'cto')
  assert.ok(w, 'a .pinwin rendered for cto')
  // THE coordinate-space fact: the window is a sibling of the world, not in it
  assert.ok(!w!.closest('.space'), 'the pinned window is NOT inside the .space transform')
  assert.ok(w!.parentElement?.classList.contains('pin-layer'), 'the pinned window belongs to the shared pin layer')
  assert.ok(w!.closest('.viewport') === viewport, 'the pin layer stays inside the viewport')
  // placed exactly over the desk it detached from (viewport px), floored to
  // the minimum usable size
  const r = winRect(w!)
  assert.ok(Math.abs(r.x - before.x) < 0.5 && Math.abs(r.y - before.y) < 0.5,
    `window at (${r.x},${r.y}) but the card was at (${before.x},${before.y})`)
  assert.equal(r.w, Math.max(PIN_MIN_W, before.w))
  assert.equal(r.h, Math.max(PIN_MIN_H, before.h))
  // the canvas desk is gone; the card shows the placeholder; ONE desk exists
  assert.equal(el.querySelector('.desk-over'), null, 'no canvas desk remains after pinning')
  assert.ok(el.querySelector('.sq .pin-holder .pin-placeholder'), 'the card shows the pinned placeholder')
  assert.equal(desksFor(el, 'cto'), 1)
  assert.ok(w!.querySelector('.desk-body .cc-name'), 'the window hosts the desk')
  assert.ok(!w!.querySelector('.cc-pin'), 'a pinned window offers no pin button of its own')
  // persisted, with the stage-2 seam
  const s = stored()
  assert.equal(s.length, 1); assert.equal(s[0]!.id, 'cto'); assert.equal(s[0]!.snap, null)
  assert.deepEqual(s[0]!.rect, r)
})

uiTest('§B2 the canvas moves underneath: pan and zoom leave the window where it is', async ({ mount }) => {
  const { el, viewport } = await mountCanvas(mount, ['ceo', 'cto'])
  await settle(2500)
  const w = await pinFromDesk(el, viewport, 'cto')
  const r0 = winRect(w)
  const c0 = cam(el)
  // pan the canvas by a lot
  await inAct(() => { viewport.dispatchEvent(pointer('pointerdown', 300, 300)) })
  await inAct(() => { viewport.dispatchEvent(pointer('pointermove', 900, 750)) })
  await inAct(() => { viewport.dispatchEvent(pointer('pointerup', 900, 750)) })
  await flush()
  const c1 = cam(el)
  assert.ok(Math.abs(c1.x - c0.x) > 500 && Math.abs(c1.y - c0.y) > 400,
    `positive control: the pan moved the camera (${c0.x},${c0.y}) → (${c1.x},${c1.y})`)
  assert.deepEqual(winRect(pinWin(el, 'cto')!), r0, 'the window did not move with the pan')
  // zoom out — to the normal card tier, not mini (the badges only render at
  // norm LOD; §B7 covers the marker on a fresh mount)
  for (let i = 0; i < 3; i++) await inAct(() => { viewport.dispatchEvent(wheel(200, 200, 300)) })
  await flush()
  const c2 = cam(el)
  assert.ok(c2.z < c1.z * 0.5, `positive control: the wheel zoomed out (${c1.z} → ${c2.z})`)
  assert.ok(c2.z >= Z_MINI && c2.z < Z_DESK, `at the norm card tier (z=${c2.z})`)
  assert.deepEqual(winRect(pinWin(el, 'cto')!), r0, 'the window did not scale or move with the zoom')
  // the card, meanwhile, DID move on screen — it is in the other space
  const card = screenRectOf(el, posAny(el, 'cto'))
  assert.ok(Math.abs(card.x - r0.x) > 50 || Math.abs(card.y - r0.y) > 50,
    'positive control: the card moved on screen while the window stayed')
  // and the placeholder is gone below desk zoom: the card is a plain card again
  assert.equal(el.querySelector('.pin-placeholder'), null)
  assert.ok(el.querySelector('.sq.pinned .pinbadge'), 'the card wears the pinned marker at any zoom')
  assert.equal(desksFor(el, 'cto'), 1)
})

uiTest('§B3 PINNED MEANS PINNED: zooming onto a pinned card never opens a second desk', async ({ mount }) => {
  const { el, viewport } = await mountCanvas(mount, ['ceo', 'cto'])
  await settle(2500)
  await pinFromDesk(el, viewport, 'cto')
  // walk away and come back, exactly as a user would
  for (let i = 0; i < 6; i++) await inAct(() => { viewport.dispatchEvent(wheel(200, 200, 300)) })
  await flush()
  assert.ok(cam(el).z < Z_DESK, 'positive control: zoomed out below desk zoom')
  await zoomOnto(el, viewport, 'cto')
  assert.ok(cam(el).z >= Z_DESK, 'positive control: back at desk zoom, centred on cto')
  // the ruling
  assert.equal(el.querySelector('.desk-over'), null, 'no canvas desk opened for the pinned agent')
  assert.equal(desksFor(el, 'cto'), 1,
    'exactly ONE live desk for cto — a second one would share its composer draft key')
  assert.equal(el.querySelectorAll('textarea').length, 1, 'exactly one composer in the whole canvas')
  const ph = el.querySelector('.sq .pin-placeholder') as HTMLElement | null
  assert.ok(ph, 'the card shows the placeholder in the desk\'s place')
  assert.match(ph!.textContent ?? '', /pinned/)
  assert.match(ph!.textContent ?? '', /show window/)
  // the placeholder's card wears the desk layout (no world-scaled head)
  assert.ok(ph!.closest('.sq.desk'), 'the placeholder card takes the desk layout')
  // a SECOND agent is unaffected: its desk opens normally
  for (let i = 0; i < 6; i++) await inAct(() => { viewport.dispatchEvent(wheel(200, 200, 300)) })
  await flush()
  await focusDesk(el, viewport, 'ceo')
  assert.equal(desksFor(el, 'ceo'), 1)
  assert.equal(desksFor(el, 'cto'), 1, 'cto still has exactly its window')
})

uiTest('§B4 the placeholder click raises and flashes the window, never unpins', async ({ mount }) => {
  const { el, viewport } = await mountCanvas(mount, ['ceo', 'cto'])
  await settle(2500)
  await pinFromDesk(el, viewport, 'cto')
  for (let i = 0; i < 6; i++) await inAct(() => { viewport.dispatchEvent(wheel(200, 200, 300)) })
  await flush()
  await pinFromDesk(el, viewport, 'ceo')   // pinned last → on top
  assert.equal(pinWin(el, 'ceo')!.dataset.z, '1'); assert.equal(pinWin(el, 'cto')!.dataset.z, '0')
  for (let i = 0; i < 6; i++) await inAct(() => { viewport.dispatchEvent(wheel(200, 200, 300)) })
  await flush()
  await zoomOnto(el, viewport, 'cto')
  const ph = el.querySelector('.pin-placeholder') as HTMLElement
  assert.ok(ph, 'cto shows its placeholder')
  const c0 = cam(el)
  await inAct(() => { ph.click() })
  await flush()
  assert.ok(pinWin(el, 'cto'), 'cto is STILL pinned after the click')
  assert.equal(stored().length, 2, 'nothing was unpinned')
  assert.equal(pinWin(el, 'cto')!.dataset.z, '1', 'cto was raised to the top')
  assert.equal(pinWin(el, 'ceo')!.dataset.z, '0')
  assert.ok(pinWin(el, 'cto')!.classList.contains('flash'), 'the window flashes')
  assert.deepEqual(cam(el), c0, 'the click did not pan the canvas')
  await advance(800)
  assert.ok(!pinWin(el, 'cto')!.classList.contains('flash'), 'the flash is a pulse, not a state')
})

uiTest('§B5 drag and resize are 1:1 with the pointer in viewport px, and commit once', async ({ mount }) => {
  const { el, viewport } = await mountCanvas(mount, ['ceo', 'cto'])
  await settle(2500)
  const w = await pinFromDesk(el, viewport, 'cto')
  const r0 = winRect(w)
  const c0 = cam(el)
  const title = w.querySelector('.pinwin-title') as HTMLElement
  const writes0 = stored().length
  // drag the title bar by (+40, +25) — screen px, no /zoom (the camera is at
  // z≈2.3 here; a world-space drag would have moved by 40/2.3)
  await inAct(() => { title.dispatchEvent(pointer('pointerdown', 500, 500)) })
  await inAct(() => { title.dispatchEvent(pointer('pointermove', 520, 510)) })
  let mid = winRect(pinWin(el, 'cto')!)
  assert.equal(mid.x, r0.x + 20); assert.equal(mid.y, r0.y + 10)
  assert.deepEqual(stored()[0]!.rect, r0, 'mid-gesture: nothing written yet')
  await inAct(() => { title.dispatchEvent(pointer('pointermove', 540, 525)) })
  await inAct(() => { title.dispatchEvent(pointer('pointerup', 540, 525)) })
  await flush()
  const r1 = winRect(pinWin(el, 'cto')!)
  assert.equal(r1.x, r0.x + 40); assert.equal(r1.y, r0.y + 25)
  assert.equal(r1.w, r0.w); assert.equal(r1.h, r0.h)
  assert.deepEqual(stored()[0]!.rect, r1, 'the drag committed to storage at pointer-up')
  assert.deepEqual(cam(el), c0, 'dragging the window did not pan the canvas')
  assert.equal(stored().length, writes0)
  // resize from the south-east corner
  const se = w.nextElementSibling!.querySelector('.pinwin-rs.se') as HTMLElement
  await drag(se, { x: 800, y: 800 }, { x: 900, y: 860 })
  const r2 = winRect(pinWin(el, 'cto')!)
  assert.equal(r2.w, r1.w + 100); assert.equal(r2.h, r1.h + 60)
  assert.equal(r2.x, r1.x); assert.equal(r2.y, r1.y)
  // from the north-west corner: x/y move, w/h shrink
  const nw = w.nextElementSibling!.querySelector('.pinwin-rs.nw') as HTMLElement
  await drag(nw, { x: 100, y: 100 }, { x: 110, y: 115 })
  const r3 = winRect(pinWin(el, 'cto')!)
  assert.equal(r3.x, r2.x + 10); assert.equal(r3.y, r2.y + 15)
  assert.equal(r3.w, r2.w - 10); assert.equal(r3.h, r2.h - 15)
  // the size floor pins the OPPOSITE edge: shrinking far past the minimum
  // from the west must not walk the window across the screen
  const west = w.nextElementSibling!.querySelector('.pinwin-rs.w') as HTMLElement
  await drag(west, { x: 100, y: 100 }, { x: 100 + 5000, y: 100 })
  const r4 = winRect(pinWin(el, 'cto')!)
  assert.equal(r4.w, PIN_MIN_W)
  assert.equal(r4.x, r3.x + r3.w - PIN_MIN_W, 'the east edge stayed put')
  assert.deepEqual(stored()[0]!.rect, r4)
  assert.deepEqual(cam(el), c0, 'none of it panned the canvas')
})

uiTest('§B5b drag and resize clamp every edge to the measured viewport', async ({ mount }) => {
  const { el, viewport } = await mountCanvas(mount, ['ceo', 'cto'])
  await settle(2500)
  await focusDesk(el, viewport, 'cto')
  // jsdom has no layout, so provide a positive measured viewport control. The
  // same dimensions are what PinLayer reads in a real browser.
  Object.defineProperty(viewport, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ x: 0, y: 0, top: 0, left: 0, right: 700, bottom: 500,
      width: 700, height: 500, toJSON: () => ({}) }),
  })
  await inAct(() => {
    const btn = el.querySelector('.desk-over .cc-pin') as HTMLElement
    assert.ok(btn, 'the focused desk still exposes pin')
    btn.click()
  })
  await flush()
  const w = pinWin(el, 'cto')!
  const title = w.querySelector('.pinwin-title') as HTMLElement
  await drag(title, { x: 100, y: 100 }, { x: 5000, y: 5000 })
  let r = winRect(pinWin(el, 'cto')!)
  assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.w <= 700 && r.y + r.h <= 500,
    `drag stayed inside viewport: ${JSON.stringify(r)}`)

  const se = w.nextElementSibling!.querySelector('.pinwin-rs.se') as HTMLElement
  await drag(se, { x: 100, y: 100 }, { x: 5000, y: 5000 })
  r = winRect(pinWin(el, 'cto')!)
  assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.w <= 700 && r.y + r.h <= 500,
    `resize stayed inside viewport: ${JSON.stringify(r)}`)
})

uiTest('§B6 the wheel over a pinned window scrolls it — it must not zoom the canvas', async ({ mount }) => {
  const { el, viewport } = await mountCanvas(mount, ['ceo', 'cto'])
  await settle(2500)
  const w = await pinFromDesk(el, viewport, 'cto')
  const c0 = cam(el)
  const body = w.querySelector('.pinwin-body') as HTMLElement
  for (let i = 0; i < 4; i++) await inAct(() => { body.dispatchEvent(wheel(400, 400, 300)) })
  await flush()
  assert.deepEqual(cam(el), c0, 'wheel inside the window left the camera alone')
  // positive control: the same wheel on the canvas beside it zooms
  for (let i = 0; i < 4; i++) await inAct(() => { viewport.dispatchEvent(wheel(400, 400, 300)) })
  await flush()
  assert.ok(cam(el).z < c0.z, 'the same wheel on bare canvas zooms')
})

uiTest('§B7 reload: pins come back from storage, where they were, without any zoom', async ({ mount }) => {
  const first = await mountCanvas(mount, ['ceo', 'cto'])
  await settle(2500)
  const w = await pinFromDesk(first.el, first.viewport, 'cto')
  const title = w.querySelector('.pinwin-title') as HTMLElement
  await drag(title, { x: 500, y: 500 }, { x: 577, y: 533 })
  const r = winRect(pinWin(first.el, 'cto')!)
  await first.unmount()
  // a reload is a fresh module graph over the SAME localStorage: drop the
  // in-memory copy so the only way back is the persisted one
  forgetPins()
  const second = await mountCanvas(mount, ['ceo', 'cto'])
  await settle(2500)
  assert.ok(cam(second.el).z < Z_DESK, 'positive control: the fresh canvas is nowhere near desk zoom')
  const back = pinWin(second.el, 'cto')
  assert.ok(back, 'the pinned window is back after the reload')
  assert.deepEqual(winRect(back!), r, 'at the rect it was dragged to')
  assert.equal(desksFor(second.el, 'cto'), 1)
  assert.ok(second.el.querySelector('.sq.pinned'), 'the card wears the marker')
})

uiTest('§B8 unpin minimises to the card, and the card can take focus again', async ({ mount }) => {
  const { el, viewport, toasts } = await mountCanvas(mount, ['ceo', 'cto'])
  await settle(2500)
  const w = await pinFromDesk(el, viewport, 'cto')
  const title = w.querySelector('.pinwin-title') as HTMLElement
  await drag(title, { x: 500, y: 500 }, { x: 700, y: 650 })
  const from = winRect(pinWin(el, 'cto')!)
  const home = screenRectOf(el, posAny(el, 'cto'))
  const btn = w.querySelector('.pinwin-unpin') as HTMLElement
  await inAct(() => { btn.click() })
  await flush()
  assert.equal(pinWin(el, 'cto'), null, 'the window is gone')
  assert.deepEqual(stored(), [], 'and so is its storage')
  assert.equal(localStorage.getItem(pinsKey('mine')), null, 'the key itself is removed when empty')
  // the minimise ghost: chrome only, from the window's rect, aimed at the card
  const ghost = el.querySelector('.pinwin-ghost') as HTMLElement | null
  assert.ok(ghost, 'a minimise ghost is flying')
  assert.equal(ghost!.dataset.to, 'card')
  assert.ok(!ghost!.querySelector('.desk-body'), 'the ghost carries no live desk')
  assert.deepEqual(winRect(ghost!), from, 'it starts where the window was')
  await advance(32, 16)
  const flying = el.querySelector('.pinwin-ghost') as HTMLElement | null
  assert.ok(flying, 'the ghost is still in flight one frame later')
  const ghostRect = winRect(flying!)
  assert.deepEqual(ghostRect, home,
    'it flies to the card\'s CURRENT screen rect (read at unpin time, never stored)')
  await advance(600)
  assert.equal(el.querySelector('.pinwin-ghost'), null, 'the ghost is gone after the flight')
  assert.deepEqual(toasts, [], 'on-screen unpin says nothing')
  // the card is a card again: focus rules resume and the desk opens on it
  assert.equal(el.querySelector('.sq.pinned'), null)
  assert.ok(el.querySelector('.desk-over'), 'the camera was still on cto, so its desk re-opened on the canvas')
  assert.equal(desksFor(el, 'cto'), 1)
})

uiTest('§B9 retired while pinned: the window stays, readable, and says so', async ({ mount }) => {
  const { el, viewport, setTree } = await mountCanvas(mount, ['ceo', 'cto'])
  await settle(2500)
  await pinFromDesk(el, viewport, 'cto')
  await inAct(() => { setTree(tree(['ceo', 'cto'], { cto: 'archived' })) })
  await flush()
  const w = pinWin(el, 'cto')
  assert.ok(w, 'the window survived the retirement')
  assert.ok(w!.classList.contains('pin-archived'))
  assert.equal(w!.querySelector('.pinwin-state')?.textContent, 'archived')
  assert.ok(w!.querySelector('.desk-body'), 'the desk is still mounted inside it')
  assert.equal(stored().length, 1, 'still persisted')
})

uiTest('§B10 dissolved while pinned: the window closes with a word, and storage is swept', async ({ mount }) => {
  const { el, viewport, setTree, toasts } = await mountCanvas(mount, ['ceo', 'cto'])
  await settle(2500)
  await pinFromDesk(el, viewport, 'cto')
  await inAct(() => { setTree(tree(['ceo'])) })
  await flush()
  assert.equal(pinWin(el, 'cto'), null, 'no window for a node that left the tree')
  assert.deepEqual(stored(), [], 'the sweep removed the pin from storage')
  assert.ok(toasts.some((t) => /cto is gone/.test(t.join(' '))), `the user was told: ${JSON.stringify(toasts)}`)
})

uiTest('rename keeps the pinned window, geometry and draft; deletion still closes it', async ({ mount }) => {
  const { el, viewport, setTree, toasts } = await mountCanvas(
    mount, ['ceo', 'cto'], [], { cto: 'stable-cto' })
  await settle(2500)
  await pinFromDesk(el, viewport, 'cto')
  const before = winRect(pinWin(el, 'cto')!)
  const beforePin = readPins('mine')[0]!
  const ta = el.querySelector('textarea') as HTMLTextAreaElement | null
  assert.ok(ta, 'the pinned desk has a real composer')
  const setValue = Object.getOwnPropertyDescriptor(
    ta!.constructor.prototype, 'value')!.set!
  setValue.call(ta, 'keep this unsent draft')
  await inAct(() => { ta!.dispatchEvent(new Event('input', { bubbles: true })) })
  await flush()
  assert.equal((el.querySelector('textarea') as HTMLTextAreaElement).value,
    'keep this unsent draft', 'the real composer accepted the draft')
  const realFetch = globalThis.fetch
  const calls: { url: string; init?: RequestInit }[] = []
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = ((url: string, init?: RequestInit) => {
    calls.push({ url, init })
    const body = /\/chat(?:\?|$)/.test(url)
      ? { busy: false, queued: 0, responding: false, last_error: null,
          occupancy: null, occupancy_estimated: false, messages: [], live: [],
          draft_epoch: null, mail_pending: 0, pending_mail: [] }
      : { ok: true }
    return Promise.resolve({ ok: true, status: 200,
      headers: new Headers(), json: () => Promise.resolve(body) })
  }) as typeof fetch
  // The explicit event is the supported path when a rename also changes the
  // session id; the tree update then verifies the incoming rename boundary.
  await inAct(() => { window.dispatchEvent(new window.CustomEvent('orgtree:rename', {
    detail: { slug: 'mine', renames: { cto: 'renamed' } },
  })) })
  await inAct(() => { setTree(tree(['ceo', 'renamed'], {}, { renamed: 'stable-cto' })) })
  await flush()
  const renamed = pinWin(el, 'renamed')
  assert.ok(renamed, 'the renamed agent still has a rendered pinned window')
  assert.equal(pinWin(el, 'cto'), null, 'the old identity no longer renders')
  assert.deepEqual(winRect(renamed!), before, 'position and size are preserved')
  assert.equal(readPins('mine')[0]!.z, beforePin.z, 'stacking order is preserved')
  assert.equal(renamed!.querySelector('.pinwin-name')?.textContent, 'renamed')
  assert.equal(localStorage.getItem('orgtree-draft-v2-["mine","renamed",0]'), 'keep this unsent draft')
  assert.equal(localStorage.getItem('orgtree-draft-v2-["mine","cto",0]'), null)
  const renamedTa = renamed!.querySelector('textarea') as HTMLTextAreaElement | null
  assert.ok(renamedTa, 'the renamed desk still has its real composer')
  assert.equal(renamedTa!.value, 'keep this unsent draft',
    'the visible composer text survived the identity change')
  assert.ok(calls.some(({ url }) => /\/nodes\/renamed\/chat/.test(url)),
    'conversation refresh targets the new identity')
  await inAct(() => { (renamed!.querySelector('.cc-send') as HTMLElement).click() })
  await flush()
  const send = calls.find(({ url }) => /\/nodes\/renamed\/message/.test(url))
  assert.ok(send, 'the real composer send targets the new identity')
  assert.match(String(send!.init?.body), /keep this unsent draft/)
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = realFetch
  assert.deepEqual(toasts, [], `a rename is not reported as a closed window: ${JSON.stringify(toasts)}`)

  const renameTree = async (from: string, to: string, sid: string) => {
    await inAct(() => { window.dispatchEvent(new window.CustomEvent('orgtree:rename', {
      detail: { slug: 'mine', renames: { [from]: to } },
    })) })
    await inAct(() => { setTree(tree(['ceo', to], {}, { [to]: sid })) })
    await flush()
  }
  // Reverse and repeat the mapping: a name-based alias would either cycle or
  // attach the second rename to the wrong Entry.
  await renameTree('renamed', 'cto', 'stable-cto')
  assert.ok(pinWin(el, 'cto'), 'the reverse rename preserves the pinned window')
  await renameTree('cto', 'renamed', 'stable-cto')
  assert.ok(pinWin(el, 'renamed'), 'the chained rename preserves the pinned window')
  // Reusing A for a distinct generation must not resolve through the old
  // A→B mapping or inherit B's pin/conversation.
  await inAct(() => { setTree(tree(['ceo', 'renamed', 'cto'], {}, {
    renamed: 'stable-cto', cto: 'fresh-cto',
  })) })
  await flush()
  assert.ok(pinWin(el, 'renamed'), 'the original B remains pinned')
  assert.equal(pinWin(el, 'cto'), null, 'a newly hired A gets no old pin')
  assert.equal(localStorage.getItem('orgtree-draft-v2-["mine","cto",0]'), null,
    'a newly hired A gets no old conversation draft')
  await inAct(() => { setTree(tree(['ceo', 'cto'], {}, { cto: 'fresh-cto' })) })
  await flush()
  assert.equal(pinWin(el, 'renamed'), null, 'a genuine removal still closes the window')
  assert.deepEqual(readPins('mine'), [], 'a genuine removal still prunes storage')
  assert.ok(toasts.some((t) => /renamed is gone/.test(t.join(' '))),
    `the chained rename removal is reported: ${JSON.stringify(toasts)}`)
})

uiTest('§B11 the sweep never fires in the org-switch window (tree.slug ≠ slug)', async ({ mount }) => {
  // The fetch-gap case (backend down) needs no guard HERE: App only swaps
  // `tree` when a fetch RESOLVES (App.tsx, `setTree(t)` under `wantSlug`),
  // so a failed poll leaves the last good tree — and `map` — in place. The
  // window that does need a guard is an ORG SWITCH: `slug` is the new org
  // while `tree` is still the old payload, and a sweep there would prune the
  // new org's pins against the old org's node set.
  const { el, viewport, setTree, toasts } = await mountCanvas(mount, ['ceo', 'cto'])
  await settle(2500)
  await pinFromDesk(el, viewport, 'cto')
  await inAct(() => { setTree({ ...tree(['zed']), slug: 'other' }) })
  await flush()
  assert.equal(stored().length, 1, 'a mismatched-slug tree did not sweep the pin')
  assert.equal(pinWin(el, 'cto'), null, 'and nothing renders for it in that window')
  assert.equal(toasts.length, 0, 'and nobody was told a window closed')
  await inAct(() => { setTree(tree(['ceo', 'cto'])) })
  await flush()
  assert.ok(pinWin(el, 'cto'), 'the window is back once tree and slug agree')
  // positive control — the guard is the slug, not a general reluctance: an
  // empty tree for the SAME slug (everyone dissolved) does sweep
  await inAct(() => { setTree(tree([])) })
  await flush()
  assert.equal(stored().length, 0, 'a genuinely empty org sweeps the pin')
  assert.ok(toasts.some((t) => /cto is gone/.test(t.join(' '))))
})

// ------------------------------------------------------------- 2026-09-05
// Two defects seen by LOOKING at the deployed build (8a9a4ad) in a real Edge,
// not by any suite: the clamp measured the viewport's BORDER box while windows
// live in its PADDING box, and the snap preview drew in the root accent.

uiTest('clamp measures the padding box: a bordered viewport keeps the flush window inside the border', async ({ mount }) => {
  const rig = await mountCanvas(mount, ['ceo', 'cto'])
  const size = { w: 1300, h: 850 }
  Object.defineProperty(rig.viewport, 'getBoundingClientRect', { configurable: true,
    value: () => ({ x: 0, y: 0, top: 0, left: 0, right: size.w, bottom: size.h,
      width: size.w, height: size.h, toJSON: () => ({}) }) })
  // POSITIVE CONTROL first: with no border the padding box IS the border box,
  // so an overhanging window lands exactly at the measured edge
  rig.viewport.style.border = '0px solid red'
  await inAct(() => { addPin('mine', 'cto', { x: 1200, y: 800, w: 320, h: 240 }) })
  await flush()
  let r = winRect(pinWin(rig.el, 'cto')!)
  assert.deepEqual([r.x + r.w, r.y + r.h], [1300, 850], 'control: borderless viewport clamps to its full size')
  // the real viewport has a 1px border (styles.css .viewport): the window must
  // stop 1px short on each side or overflow:hidden eats its own border line
  rig.viewport.style.border = '1px solid red'
  await inAct(() => { window.dispatchEvent(new window.Event('resize')) })
  await flush()
  r = winRect(pinWin(rig.el, 'cto')!)
  assert.deepEqual([r.x + r.w, r.y + r.h], [1298, 848],
    `bordered viewport: right/bottom must be 1298/848, got ${r.x + r.w}/${r.y + r.h}`)
  // and a resize gesture commits the same bound
  const se = rig.el.querySelector('.pinwin-resize-frame[data-id="cto"] .pinwin-rs.se') as HTMLElement
  await inAct(() => { se.dispatchEvent(pointer('pointerdown', 1290, 840)) })
  await inAct(() => { se.dispatchEvent(pointer('pointermove', 2000, 2000)) })
  await inAct(() => { se.dispatchEvent(pointer('pointerup', 2000, 2000)) })
  const stored = readPins('mine').find((p) => p.id === 'cto')!.rect
  assert.deepEqual([stored.x + stored.w, stored.y + stored.h], [1298, 848], 'persisted resize respects the padding box')
})

uiTest('snap preview wears the dragged window\'s provider class, not the root accent', async ({ mount }) => {
  const { el, title } = await mosaicRig(mount)
  await inAct(() => { title.dispatchEvent(pointer('pointerdown', 700, 412)) })
  await inAct(() => { title.dispatchEvent(pointer('pointermove', 451, 117)) })
  const preview = el.querySelector('.pin-snap-preview') as HTMLElement
  assert.ok(preview, 'snap preview is visible before release')
  const win = pinWin(el, 'cto')!
  const prov = [...win.classList].find((c) => c.startsWith('prov-'))
  assert.ok(prov, 'the window itself carries a prov-* class')
  assert.ok(preview.classList.contains(prov!),
    `preview classes "${preview.className}" lack the window's ${prov}`)
  await inAct(() => { title.dispatchEvent(pointer('pointerup', 451, 117)) })
})

// ---------------------------------------------------------------------------
// §B12 THE TITLE-BAR NAME: a click navigates, a drag does not (user rule
// 2026-09-05 — agent names are clickable everywhere except inside that agent's
// own focused desk; the coordinator refused a blanket "pinned titles are
// inert" exemption).
//
// ⚠ WHY THIS IS NOT JUST "does the button fire". The name sits ON the drag
// handle. A press that becomes a drag and releases back over the name still
// produces a `click` in a real browser, so a naive button would reposition the
// window AND navigate away from it in one gesture. The discrimination reuses
// the title bar's own `moved` verdict at its existing 3px threshold rather
// than inventing a second one.
uiTest('§B12 title-bar name: the mouse path is the gesture, the keyboard path is the button',
  async ({ mount }) => {
    const { el, viewport } = await mountCanvas(mount, ['ceo', 'cto'])
    await settle(2500)
    await pinFromDesk(el, viewport, 'cto')
    await settle(1200)   // let the pin-creation flash clear before measuring
    const win = () => pinWin(el, 'cto')!
    const title = () => win().querySelector('.pinwin-title')!
    const name = () => title().querySelector('button.cc-name.pinwin-name') as HTMLElement
    assert.ok(name(), 'the title-bar name is a navigation control')
    assert.ok(title().querySelector('.tier'), 'and it carries the model chip')

    // ⚠ THE INSTRUMENT IS THE PIN'S OWN PULSE, NOT THE CAMERA. Navigating to a
    // PINNED agent raises its window instead of gliding to the placeholder its
    // card shows, so the camera does not move and measuring it would call
    // every success a failure. `showPin` is the only thing that pulses —
    // `raisePin`, which every title pointerdown does, does not — so the flash
    // is exactly "a navigation happened" and nothing else.
    const navigated = async () => {
      await advance(64, 16)
      const on = Boolean(pinWin(el, 'cto')?.classList.contains('flash'))
      await settle(1200)
      return on
    }
    // a keyboard activation carries detail 0; a real mouse click carries >= 1.
    // That is the discrimination, and it is the EVENT's own property — not a
    // flag waiting for a click that pointer capture may never deliver.
    const press = (detail: number) => inAct(() => {
      name().dispatchEvent(new window.MouseEvent('click', { bubbles: true, detail }))
    })
    // ⚠ `deliverClick` IS THE POINT OF THIS PARAMETER. Under pointer capture
    // the browser MAY retarget or suppress the click that would normally
    // follow a pointer pair — which is why the mouse path is driven by the
    // gesture at all. A test that always delivers the click models only the
    // easy half, and a flag-based implementation passes it while eating the
    // next keypress in the real browser.
    const drag = async (dx: number, dy: number, deliverClick = true) => {
      await inAct(() => { name().dispatchEvent(pointer('pointerdown', 200, 60)) })
      if (dx || dy) await inAct(() => { name().dispatchEvent(pointer('pointermove', 200 + dx, 60 + dy)) })
      await inAct(() => { name().dispatchEvent(pointer('pointerup', 200 + dx, 60 + dy)) })
      if (deliverClick) await press(1)
    }

    // (1) a DRAG: the window moves, and nothing navigates
    const r0 = winRect(win())
    await drag(180, 180)
    assert.equal(await navigated(), false, 'a DRAG on the title name navigated')
    assert.notDeepEqual(winRect(win()), r0,
      'positive control: the drag must actually have moved the window, or the '
      + 'assertion above is about a gesture that never happened')

    // (2) ENTER after that drag must navigate
    await press(0)
    assert.equal(await navigated(), true,
      'Enter after a drag did not navigate — a pointer gesture must not '
      + 'consume the next keyboard activation')

    // (2b) THE CASE THAT MATTERS: a drag whose click was NEVER DELIVERED,
    // then ENTER. That is what pointer capture actually does, and it is where
    // a "set a flag, let the click consume it" implementation strands the flag
    // and swallows the keypress.
    await drag(160, 160, false)
    assert.equal(await navigated(), false, 'that drag must not have navigated')
    await press(0)
    assert.equal(await navigated(), true,
      'Enter after a drag whose click was never delivered did not navigate — '
      + 'a gesture must not leave something behind that eats the next '
      + 'keyboard activation')

    // (3) an ESC-CANCELLED gesture, then ENTER: same requirement
    await inAct(() => { name().dispatchEvent(pointer('pointerdown', 200, 60)) })
    await inAct(() => { name().dispatchEvent(pointer('pointermove', 320, 200)) })
    await inAct(() => {
      window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    await inAct(() => { name().dispatchEvent(pointer('pointerup', 320, 200)) })
    assert.equal(await navigated(), false, 'a cancelled gesture navigated')
    await press(0)
    assert.equal(await navigated(), true,
      'Enter after an Escape-cancelled gesture did not navigate')

    // (4) a CLICK — press and release in the same place, under the threshold
    const r1 = winRect(win())
    await drag(1, 0)
    assert.equal(await navigated(), true,
      'a CLICK on the title name did not navigate — the name is not a route '
      + 'to its agent, which is the rule')
    assert.deepEqual(winRect(win()), r1, 'and a click must not reposition it')
  })
