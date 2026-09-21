// attentionview.test.tsx — the Attention view as a VIEW: mode switching, the
// divider, and the retention rule that survives it.
//
// The ticket's hardest requirement is not a widget, it is a lifetime: "if
// either panel is pinned or popped out, switching from Attention view back to
// the normal canvas retains that panel and its state", and "switching modes
// must not close, recreate, or silently unpin them". A pinned surface's DOM
// lives in the pin layer, but what FILLS it is a React subtree — so a view that
// unmounts its panels on the way back to the canvas destroys a window the user
// placed, and does it silently. That is what §3 and §4 below are for, and they
// assert on the panel still being in the document rather than on any flag.
//
// The stage is deliberately given an organization with NO agents in these
// tests. That is not an evasion: it isolates the view's own structure — the two
// slots, the divider, the mode switch — from the desk's very large dependency
// graph, which has its own suites. The desk's selection rules are pinned in
// attentionagents.test.tsx against the same functions the panel calls.
//
// Run:  node apps/desktop/renderer/tests/run.mjs attentionview

import './harness'
import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import type { CanvasNode } from '../src/canvas/shared'
import { USER } from '../src/canvas/shared'
import type { OpFn, TreePayload } from '../src/types'
import { forgetModalPins, isModalPinned, pinModal, readModalPins } from '../src/canvas/modalpin'
import { WINDOW_LAYOUT_KEY } from '../src/windowlayout'
import { CurrentOrg } from '../src/popout'
import { openSurfaces, registerWindow } from '../src/windowlife'
import {
  attentionLayout, forgetAttentionMode, setAttentionLayout, setOrgView, SPLIT_MAX, SPLIT_MIN,
} from '../src/attention/mode'
import { AttentionView, DESK_KIND, QUEUE_KIND } from '../src/attention/AttentionView'

const SLUG = 'org1'

const tree = (): TreePayload => ({
  slug: SLUG, name: 'Org 1', epoch: 1, rev: 1, roots: [],
  work_items_summary: { attention: 0, active: 0 },
  user_inbox_count: 0, user_inbox_urgent_count: 0, asks: [], asks_open: 0,
} as unknown as TreePayload)

/** an organization with the eye and nothing else — see the file header */
const emptyMap = (): Map<string, CanvasNode> => new Map([[USER, {
  id: USER, parent: null, tier: null, state: 'user', children: [],
} as unknown as CanvasNode]])

const op: OpFn = () => Promise.resolve({ ok: true } as never)
const toast = () => {}

/** the two feeds this view polls, answered with nothing waiting */
function installQuietServer() {
  ;(globalThis as unknown as { fetch: unknown }).fetch = (url: string) => {
    const path = new URL(String(url), 'http://localhost').pathname
    const body = /\/work-items$/.test(path)
      ? { items: [], archived: [], backlogged: [],
          counts: { attention: 0, active: 0, archived: 0, backlogged: 0 } }
      : /\/inbox$/.test(path)
        ? { pending: [], delivered: [], sent: [] }
        : { ok: true }
    return Promise.resolve({
      ok: true, status: 200, headers: new Headers(),
      json: () => Promise.resolve(body),
    })
  }
}

const reset = () => {
  localStorage.clear()
  forgetAttentionMode()
  forgetModalPins()
  installQuietServer()
}

/** ⚠ WRAPPED IN `CurrentOrg`, AND IT IS LOAD-BEARING. `PinFrame` reads that
 *  context (`useCurrentOrg`) and, when it is absent, renders
 *  `pinnable={false}` with no `MovableSurface` at all — no pin, no popout.
 *  Without this provider every "pinned" case below would exercise an ordinary
 *  inline panel while `isModalPinned` answered true from the store, which is a
 *  test that passes without touching the path it names. Found by the real
 *  renderer probe (tests/attention-probe.tsx), not by jsdom.
 *
 *  The application provides it above OrgCanvas (App.tsx), so this matches the
 *  host the view is mounted into rather than adding anything to it. */
const view = () => <CurrentOrg.Provider value={SLUG}>
  <AttentionView slug={SLUG} tree={tree()} op={op} toast={toast} map={emptyMap()} />
</CurrentOrg.Provider>

/** what is on screen ANYWHERE in the document — the pin layer is appended to
 *  document.body, outside the mount host, which is exactly the point */
const shape = () => ({
  stage: !!document.querySelector('.attn-stage'),
  stageOff: !!document.querySelector('.attn-stage.attn-stage-off'),
  queue: !!document.querySelector('.attn-panel-queue'),
  desk: !!document.querySelector('.attn-panel-desk'),
  divider: !!document.querySelector('.attn-divider'),
})

test('§1 the Attention view shows both panels and the divider between them', async () => {
  reset()
  setOrgView(SLUG, 'attention')
  const v = await mountView(view(), () => shape())
  await inAct(() => flush())
  const s = shape()
  assert.equal(s.stageOff, false, 'the stage is the organization view while it is active')
  assert.equal(s.queue, true, 'the Needs attention panel')
  assert.equal(s.desk, true, 'and the dynamic agent Desk panel')
  assert.equal(s.divider, true, 'with a draggable margin between them')
  await v.unmount()
})

test('§2 on the canvas, neither panel is on screen and the stage is hidden', async () => {
  reset()
  const v = await mountView(view(), () => shape())
  await inAct(() => flush())
  const s = shape()
  assert.equal(s.stage, true, 'the stage element exists — it holds the retained panels')
  assert.equal(s.stageOff, true, 'but it is hidden, so the canvas has the view to itself')
  assert.equal(s.queue, false)
  assert.equal(s.desk, false)
  assert.equal(s.divider, false, 'and there is no margin to drag')
  await v.unmount()
})

test('§3 a PINNED panel is retained across the switch back to the canvas', async () => {
  reset()
  setOrgView(SLUG, 'attention')
  const v = await mountView(view(), () => shape())
  await inAct(() => flush())

  await inAct(() => { pinModal(QUEUE_KIND, { x: 40, y: 40, w: 420, h: 480 }, SLUG) })
  await inAct(() => flush())
  assert.equal(isModalPinned(QUEUE_KIND, SLUG), true)
  assert.equal(shape().queue, true, 'the pinned panel is still on screen in its own window')
  assert.equal(shape().divider, false,
    'and the divider is gone — there is no margin between two embedded panels now')

  // the switch the ticket is about
  await inAct(() => { setOrgView(SLUG, 'canvas') })
  await inAct(() => flush())
  const s = shape()
  assert.equal(s.queue, true,
    'the pinned Needs attention panel survives the switch back to the canvas')
  assert.equal(s.desk, false,
    'while the embedded panel, which the user never placed anywhere, does not')
  assert.equal(isModalPinned(QUEUE_KIND, SLUG), true, 'and it was not silently unpinned')
  assert.deepEqual(readModalPins()[JSON.stringify([SLUG, QUEUE_KIND])]?.rect,
    { x: 40, y: 40, w: 420, h: 480 }, 'with the box the user dragged it to intact')

  await v.unmount()
})

test('§3.1 the two panels are pinned independently', async () => {
  reset()
  setOrgView(SLUG, 'attention')
  const v = await mountView(view(), () => shape())
  await inAct(() => flush())

  await inAct(() => { pinModal(DESK_KIND, { x: 10, y: 10, w: 500, h: 500 }, SLUG) })
  await inAct(() => flush())
  assert.equal(isModalPinned(DESK_KIND, SLUG), true)
  assert.equal(isModalPinned(QUEUE_KIND, SLUG), false,
    'pinning one says nothing about the other')

  await inAct(() => { setOrgView(SLUG, 'canvas') })
  await inAct(() => flush())
  assert.equal(shape().desk, true, 'the pinned Desk panel is retained')
  assert.equal(shape().queue, false, 'the embedded queue is not')
  await v.unmount()
})

test('§4 returning to the Attention view restores both panels and the split', async () => {
  reset()
  setOrgView(SLUG, 'attention')
  setAttentionLayout(SLUG, { split: 0.62, agent: 'scout' })
  const v = await mountView(view(), () => shape())
  await inAct(() => flush())
  await inAct(() => { pinModal(QUEUE_KIND, { x: 40, y: 40, w: 420, h: 480 }, SLUG) })
  await inAct(() => { setOrgView(SLUG, 'canvas') })
  await inAct(() => flush())
  await inAct(() => { setOrgView(SLUG, 'attention') })
  await inAct(() => flush())

  const s = shape()
  assert.equal(s.queue, true, 'the retained pinned panel is still the pinned one')
  assert.equal(s.desk, true, 'and the embedded panel comes back')
  assert.equal(isModalPinned(QUEUE_KIND, SLUG), true, 'nothing was unpinned on the way')
  assert.deepEqual(attentionLayout(SLUG), { split: 0.62, agent: 'scout', listOpen: false },
    'the split and the selected agent are exactly as they were left')
  await v.unmount()
})

test('§5 the divider resizes from the keyboard and the size is remembered', async () => {
  reset()
  setOrgView(SLUG, 'attention')
  const v = await mountView(view(), () => shape())
  await inAct(() => flush())
  const divider = document.querySelector('.attn-divider') as HTMLElement
  assert.ok(divider, 'the divider is a real element')
  assert.equal(divider.getAttribute('role'), 'separator')
  assert.equal(divider.getAttribute('aria-orientation'), 'vertical')
  assert.equal(divider.tabIndex, 0, 'and the keyboard can reach it')

  const before = attentionLayout(SLUG).split
  const press = (key: string, shiftKey = false) => inAct(() => {
    divider.dispatchEvent(new window.KeyboardEvent('keydown',
      { key, shiftKey, bubbles: true }))
  })
  await press('ArrowRight')
  const after = attentionLayout(SLUG).split
  assert.ok(after > before, 'ArrowRight widens the Needs attention panel')
  assert.equal(Number(divider.getAttribute('aria-valuenow')), Math.round(after * 100),
    'and the control reports the size it actually has')

  await press('ArrowLeft')
  assert.ok(Math.abs(attentionLayout(SLUG).split - before) < 1e-9,
    'ArrowLeft takes it back')

  await press('End')
  assert.equal(attentionLayout(SLUG).split, SPLIT_MAX,
    'End goes to the bound, and the bound is what stops a panel vanishing')
  await v.unmount()
})

test('§5.1 dragging the divider resizes the panels, and commits once at the end', async () => {
  reset()
  setOrgView(SLUG, 'attention')
  const v = await mountView(view(), () => shape())
  await inAct(() => flush())
  const stage = document.querySelector('.attn-stage') as HTMLElement
  const divider = document.querySelector('.attn-divider') as HTMLElement

  // jsdom does no layout, so the stage is told how wide it is. The drag maths
  // is a fraction of THIS box — that is the whole of what is being tested.
  stage.getBoundingClientRect = () => ({
    left: 0, top: 0, right: 1000, bottom: 800, width: 1000, height: 800, x: 0, y: 0,
    toJSON: () => ({}),
  }) as DOMRect
  divider.setPointerCapture = () => {}
  divider.releasePointerCapture = () => {}

  const before = attentionLayout(SLUG).split
  const point = (type: string, clientX: number) => inAct(() => {
    const e = new window.MouseEvent(type, { bubbles: true, clientX, button: 0 })
    Object.defineProperty(e, 'pointerId', { value: 1 })
    divider.dispatchEvent(e)
  })

  await point('pointerdown', 380)
  await point('pointermove', 600)
  assert.equal(attentionLayout(SLUG).split, before,
    'nothing is stored mid-drag — one write per gesture, not one per pointer move')
  assert.equal(Number(divider.getAttribute('aria-valuenow')), 60,
    'but the control follows the pointer while the gesture is live')

  await point('pointerup', 600)
  assert.ok(Math.abs(attentionLayout(SLUG).split - 0.6) < 1e-9,
    'and the size the drag ended at is what is remembered')
  await v.unmount()
})

test('§5.2 a drag cannot squeeze either panel out of existence', async () => {
  reset()
  setOrgView(SLUG, 'attention')
  const v = await mountView(view(), () => shape())
  await inAct(() => flush())
  const stage = document.querySelector('.attn-stage') as HTMLElement
  const divider = document.querySelector('.attn-divider') as HTMLElement
  stage.getBoundingClientRect = () => ({
    left: 0, top: 0, right: 1000, bottom: 800, width: 1000, height: 800, x: 0, y: 0,
    toJSON: () => ({}),
  }) as DOMRect
  divider.setPointerCapture = () => {}
  divider.releasePointerCapture = () => {}
  const point = (type: string, clientX: number) => inAct(() => {
    const e = new window.MouseEvent(type, { bubbles: true, clientX, button: 0 })
    Object.defineProperty(e, 'pointerId', { value: 1 })
    divider.dispatchEvent(e)
  })
  await point('pointerdown', 380)
  await point('pointermove', -400)
  await point('pointerup', -400)
  assert.equal(attentionLayout(SLUG).split, SPLIT_MIN,
    'dragged past the edge, the Needs attention panel stops at its floor')
  assert.equal(shape().queue, true, 'and is still on screen')
  assert.equal(shape().desk, true)
  await v.unmount()
})

// ------------------------------------------------------------------- §7
//
// THE RESTORE BRANCH OF THE MOUNT RULE, which was structurally unreachable
// until this block existed.
//
// `restoredWindows` is gated on `desktop()`, which reads `window.orgtreeDesktop`.
// jsdom has no bridge, so that branch returned [] in every test above and a
// third of the mount rule went untested — which is how f1 (the permanent
// restore latch, found by v3-ux-review-opus at ab0365b) survived a green suite.
// Stubbing the bridge is one line. `useRestoreWindows` reads `!!bridge &&
// !bridge.getWindowState`, so a bare object means "restore is on", synchronously.

const withDesktopBridge = () => {
  const g = globalThis as unknown as { window: Window & { orgtreeDesktop?: unknown } }
  g.window.orgtreeDesktop = {}
  // jsdom does not implement window.open; MovableSurface's restore calls it.
  // Returning null is what a blocked popup does, which is a case the surface
  // already handles — this test is about the MOUNT rule, not about the window.
  ;(g.window as unknown as { open: () => null }).open = () => null
  return () => { delete g.window.orgtreeDesktop }
}

/** a saved layout recording one popped-out window of `kind`, open or closed */
const savedWindow = (kind: string, open: boolean) => {
  localStorage.setItem(WINDOW_LAYOUT_KEY, JSON.stringify([{
    key: JSON.stringify([SLUG, kind]), kind, org: SLUG, open,
    rect: { x: 100, y: 100, width: 900, height: 760 },
  }]))
}

// ⚠ THE RESTORE CLAIM'S *MOUNT* IS NOT OBSERVABLE IN THIS HARNESS, and pretending
// otherwise is how the earlier version of this block went wrong. MEASURED, at
// 02bfc02+: jsdom does not implement `window.open`, so the real `MovableSurface`
// fails its restore inside the SAME `act` that mounted the panel — `open()`
// throws, its catch redocks, `closeSavedWindow` flips the row, and
// `usePersistedModalOpen`'s own store notification re-renders this view before
// the test regains control. So a saved-open row produces a panel that mounts and
// retires within one commit batch, and there is no instant at which a test here
// can see it held.
//
// That state IS measured, in a renderer that can open a window:
// tests/attention-probe.tsx §5 reports `afterAttempt.panelMounted` — true before
// the bounded recheck existed (held indefinitely, released only by an unrelated
// render) and false after it. What this suite keeps are the parts it can
// genuinely hold: the LANDED state through the registry (§7.1, §7.1b), the
// restore preference (§7.2), and the eligibility rule (§8).

test('§7.1 a panel held by a live window is released only when that window goes',
  async () => {
  reset()
  const drop = withDesktopBridge()
  const v = await mountView(view(), () => shape())
  await inAct(() => flush())
  assert.equal(shape().queue, false, 'nothing is holding it yet')

  // ⚠ THE LANDED STATE, REACHED THROUGH THE REGISTRY RATHER THAN A SAVED ROW.
  // An earlier version of this case used a saved-open row and a mode round
  // trip, which stopped being reachable once the tests provided `CurrentOrg`:
  // the real `MovableSurface` then runs, jsdom cannot open a window, and the
  // attempt fails before the case can do anything. A registered surface is the
  // state a SUCCESSFUL restore actually produces, so this tests the thing the
  // saved row was only ever standing in for.
  const stop = registerWindow({
    id: 'probe-q', kind: QUEUE_KIND, org: SLUG, editable: false,
    window: globalThis.window, redock: () => {},
  })
  await inAct(() => flush())
  assert.equal(shape().queue, true, 'a popped-out panel is held on the Canvas')

  await inAct(() => { setOrgView(SLUG, 'attention') })
  await inAct(() => { setOrgView(SLUG, 'canvas') })
  await inAct(() => flush())
  assert.equal(shape().queue, true, 'and survives a full mode round trip')

  // ⚠ ASSERTED WITH NO FLUSH AND NO OTHER RENDER. The registry's own
  // notification is what has to drive this: the view subscribes to
  // `windowlife`, so the unregister re-renders it and the mount rule is
  // re-read. Delete that subscription and this line fails — measured. A redock
  // in the running app does exactly this pair (`closeSavedWindow` plus the
  // unregister) in one go.
  await inAct(() => { stop() })
  assert.equal(shape().queue, false, 'the window going is what releases it')
  await v.unmount()
  drop()
})

test('§7.1a a blocked restore leaves nothing mounted, and needs no help to do it',
  async () => {
  reset()
  const drop = withDesktopBridge()
  savedWindow(QUEUE_KIND, true)
  const v = await mountView(view(), () => shape())
  await inAct(() => flush())

  // The surface — not this view — is what records the window closed when it
  // cannot open one. What this case pins is that NOTHING is left behind
  // afterwards: no mounted subtree, no pin, no registered surface. The real
  // renderer used to hold that subtree indefinitely (attention-probe.tsx §5)
  // because the saved layout published no event; it does now
  // (`subscribeWindowLayout`), and the probe reports the same result through it.
  // jsdom resolves the whole thing inside the mount commit, so here the
  // observable claim is the end state rather than the timing of it.
  assert.match(localStorage.getItem(WINDOW_LAYOUT_KEY) ?? '', /"open":false/,
    'the surface recorded the window closed')
  assert.equal(shape().queue, false, 'and no subtree was left holding for it')
  assert.equal(shape().desk, false)
  assert.equal(isModalPinned(QUEUE_KIND, SLUG), false)
  assert.equal(openSurfaces().some((s) => s.kind === QUEUE_KIND), false)
  await v.unmount()
  drop()
})

// ⚠ WHAT THIS SUITE CANNOT HOLD, STATED RATHER THAN FAKED. The PENDING state —
// the row still open, the window genuinely in flight, nothing registered yet —
// is the one multi-window-design's refinement is about, and jsdom cannot
// produce it: `window.open` fails instantly there, so a restore is never in
// flight for any observable interval. An earlier version of §7.1a claimed to
// test it and did not: before `CurrentOrg` was provided above, `PinFrame`
// rendered `pinnable={false}` with no `MovableSurface` at all, so nothing ever
// attempted a restore and the assertion passed over machinery that never ran.
// The real renderer probe (tests/attention-probe.tsx) is what caught that.
//
// The in-flight guarantee is carried instead by two things that ARE checkable:
// §7.1/§7.1b pin that the row flipping is the ONLY thing that releases the
// subtree, and attentionaudit.test.tsx pins that nothing can flip an
// attention-kind row except the surface that owns it. A restore in flight has
// not flipped it, so it is held — by construction rather than by a timing test
// that could only ever be a fake of one.

test('§7.2 with the restore preference off, nothing is held open for it', async () => {
  reset()
  const g = globalThis as unknown as { window: Window & { orgtreeDesktop?: unknown } }
  // a bridge that DOES answer getWindowState starts `useRestoreWindows` at
  // false — no window is coming, so there is nothing to keep a subtree for
  g.window.orgtreeDesktop = { getWindowState: () => new Promise(() => {}), onEvent: () => () => {} }
  savedWindow(QUEUE_KIND, true)
  const v = await mountView(view(), () => shape())
  await inAct(() => flush())
  assert.equal(shape().queue, false,
    'the same hook MovableSurface gates its restore on gates this, so they cannot disagree')
  await v.unmount()
  delete g.window.orgtreeDesktop
})

// ------------------------------------------------------------------- §8
test('§8 the Desk panel is eligible for the registry only when it is on screen', async () => {
  reset()
  const eligible = () =>
    document.querySelector('.attn-desk')?.getAttribute('data-attn-desk-eligible') ?? null

  setOrgView(SLUG, 'attention')
  const v = await mountView(view(), () => shape())
  await inAct(() => flush())
  assert.equal(eligible(), 'yes', 'the presented stage is a visible destination')

  // pinned, then back to the canvas: the panel is its own window and the user
  // put it there, so it stays eligible — the coordinator's rule that the flag
  // must never disable a pinned panel still visible on the Canvas
  await inAct(() => { pinModal(DESK_KIND, { x: 10, y: 10, w: 500, h: 500 }, SLUG) })
  await inAct(() => { setOrgView(SLUG, 'canvas') })
  await inAct(() => flush())
  assert.equal(shape().desk, true)
  assert.equal(eligible(), 'yes', 'a pinned panel on the Canvas is still on screen')
  await v.unmount()
})

test('§8.2 the desk claim is `automatic` only while this panel IS the presented '
  + 'stage — a pinned or popped-out panel claims as a human request', async () => {
  reset()
  const claim = () =>
    document.querySelector('.attn-desk')?.getAttribute('data-attn-desk-claim') ?? null

  setOrgView(SLUG, 'attention')
  const v = await mountView(view(), () => shape())
  await inAct(() => flush())
  assert.equal(claim(), 'automatic',
    'the stage mounted this slot; nobody asked for that desk to be here')

  // ⚠ THE DISTINCTION THE FIELD EXISTS FOR (v3-effort-opus host-slot rev 4).
  // An automatic claim DEFERS: it never takes the desk from another slot whose
  // destination is still visible, which is how a Canvas pin the user placed
  // keeps it while this view shows the canonical open-elsewhere controls. A
  // panel the user PINNED is a window they placed, so its registration is as
  // much a human request as that pin — it must not defer, and therefore must
  // OMIT the field rather than send `false`.
  await inAct(() => { pinModal(DESK_KIND, { x: 10, y: 10, w: 500, h: 500 }, SLUG) })
  await inAct(() => flush())
  assert.equal(claim(), 'none', 'a pinned panel claims as a human request')

  await inAct(() => { setOrgView(SLUG, 'canvas') })
  await inAct(() => flush())
  assert.equal(shape().desk, true, 'still retained on the canvas')
  assert.equal(claim(), 'none', 'and still not deferring, because it is still placed')
  await v.unmount()
})

test('§8.3 a popped-out desk panel also claims as a human request', async () => {
  reset()
  setOrgView(SLUG, 'attention')
  const v = await mountView(view(), () => shape())
  await inAct(() => flush())
  const stop = registerWindow({
    id: 'probe-d', kind: DESK_KIND, org: SLUG, editable: false,
    window: globalThis.window, redock: () => {},
  })
  await inAct(() => flush())
  assert.equal(
    document.querySelector('.attn-desk')?.getAttribute('data-attn-desk-claim'), 'none',
    'a window the user popped out is placed, so it does not defer either')
  await inAct(() => { stop() })
  await v.unmount()
})

// ⚠ AND THE PENDING-RESTORE HALF OF THE ELIGIBILITY RULE IS NOT COVERED HERE,
// for a reason that is now understood precisely rather than merely observed.
// `open()` in popout.tsx contains no await: it either reaches its commit point
// and calls `registerWindow` synchronously, or it throws and its catch redocks
// synchronously. So "mounted for a pending restore" is not an async interval at
// all — it is the single React commit between this view mounting the panel and
// `MovableSurface`'s restore effect running. A state that lasts less than one
// `act` cannot be sampled from a test in the same `act`.
//
// It is therefore a KNOWN COVERAGE LIMIT, stated rather than faked with a test
// that would pass over a panel that was never in that state. What bounds the
// risk is the shape of the rule rather than a test of it: `deskEligible` is one
// expression, `active || deskPinned || deskOut`, whose two true branches §8
// does cover, and whose false branch is false for everything else by
// construction — there is no third path to get it wrong in.

test('§6 the header toggle is what moves between the two views', async () => {
  reset()
  const { OrgViewToggle } = await import('../src/attention/AttentionView')
  const v = await mountView(<OrgViewToggle slug={SLUG} />,
    (el) => [...el.querySelectorAll('.orgview-tab')]
      .map((b) => `${b.textContent}:${b.getAttribute('aria-pressed')}`))
  assert.deepEqual(v.last(), ['Canvas:true', 'Attention:false'],
    'both views are named, and the one you are in says so')

  const attention = [...v.el.querySelectorAll('.orgview-tab')]
    .find((b) => b.textContent?.includes('Attention')) as HTMLElement
  await inAct(() => { attention.click() })
  assert.deepEqual(v.last(), ['Canvas:false', 'Attention:true'])
  await v.unmount()
})
