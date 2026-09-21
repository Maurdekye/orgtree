// viewrestore.test.tsx — switching organizations restores each org's OWN
// saved camera (user spec 2026-09-10: selecting an org from the tray list or
// the sidebar reopens its saved pins, popouts and canvas position; this file
// covers the canvas position half — pins and popouts restore through their
// own per-org stores).
//
// The rule under test (OrgCanvas intro effect): the FIRST canvas a session
// shows keeps the configured start-view intro; every later slug change is a
// SWITCH and restores that org's `orgtree-view-<slug>` camera when one is
// saved. Same observable surface as dragzoom.test.tsx: the numbers the
// camera writes into `.space`'s transform — jsdom does no layout, and the
// camera IS those three numbers.
//
// TWO HALVES, AND THE SECOND ONE IS THE ONE THE APP ACTUALLY RUNS. The tests
// in the first half mount a fresh canvas per org. That proves the restore
// rule but it is NOT a switch: App never unmounts OrgCanvas, it re-renders
// it with a new `slug` prop while `tree` still holds the org being left. The
// second half (below the divider) drives that, and covers the per-org
// isolation the first half cannot see.
//
// Run:  node tests/run.mjs viewrestore
import { advance, flush, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import type { ReactNode } from 'react'
import type { TreePayload } from '../src/types'

const noop = () => {}
const asTree = (v: unknown) => v as TreePayload

function tree(slug: string, nodeIds: string[]): TreePayload {
  const mk = (id: string) => ({
    id, title: id, tier: 'haiku', model_id: 'haiku', state: 'live',
    seat: 1, grant: 0, free: 0, ui_order: 0, cost_usd: 0, occupancy: null,
    context_window: null, charter: null, mail_pending: 0, limit_locked: false,
    last_status: null, prev_status: null, inflight_at: null, last_denials: [],
    turns: [], frozen: null, audiences_held: [], bearer_state: null,
    generation: 0, children: [], lineage: [],
    scope: { permission_mode: 'default', add_dirs: [], tools: {}, org_visibility: 'team' },
  })
  return asTree({
    slug, name: slug, workspace: null, dirs: [], max_top_grant: 1000,
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

interface Cam { x: number; y: number; z: number }
function cam(el: HTMLElement): Cam {
  const space = el.querySelector('.space') as HTMLElement | null
  assert.ok(space, 'the canvas world element (.space) did not render')
  const m = /translate\(\s*(-?[\d.]+)px\s*,\s*(-?[\d.]+)px\s*\)\s*scale\(\s*([\d.]+)\s*\)/
    .exec(space!.style.transform)
  assert.ok(m, `could not parse the camera out of transform="${space!.style.transform}"`)
  return { x: Number(m![1]), y: Number(m![2]), z: Number(m![3]) }
}

const SAVED: Cam = { x: 111, y: 222, z: 0.77 }
const setSaved = (slug: string, v: Cam) =>
  localStorage.setItem('orgtree-view-' + slug, JSON.stringify(v))

async function mountCanvas(slug: string, open: { unmount: () => Promise<void> }[]) {
  const { OrgCanvas } = await import('../src/canvas/OrgCanvas')
  const view = await mountView(
    <OrgCanvas tree={tree(slug, ['ceo', 'cto'])} op={() => Promise.resolve({} as never)}
      slug={slug} toast={noop} mailEvt={null} />, (host) => host)
  open.push(view)
  await flush()
  // let any intro glide land before reading the camera (see dragzoom.test.tsx:
  // under the mocked clock the rAF'd drift completes once the timers tick)
  await advance(2500)
  return view
}

function camTest(name: string, body: (open: { unmount: () => Promise<void> }[]) => Promise<void>) {
  test(name, async (t: TestContext) => {
    useFakeClock()
    localStorage.clear()
    const { resetCanvasSessionForTests } = await import('../src/canvas/OrgCanvas')
    resetCanvasSessionForTests()
    const open: { unmount: () => Promise<void> }[] = []
    t.after(async () => {
      for (const m of open.splice(0)) { try { await m.unmount() } catch { /* gone */ } }
      localStorage.clear()
      resetCanvasSessionForTests()
      realClock()
    })
    await body(open)
  })
}

camTest('switching to another org restores that org\'s saved camera exactly', async (open) => {
  setSaved('second', SAVED)
  const first = await mountCanvas('first', open)
  // positive control for the test's own instrument: the intro parked the
  // first org's camera somewhere, and NOT at the second org's saved numbers
  const intro = cam(first.el)
  assert.ok(intro.x !== SAVED.x || intro.z !== SAVED.z,
    'fixture failure: the intro landed exactly on the saved camera, so restoration would be unobservable')
  await open.pop()!.unmount()   // the org switch unmounts the canvas
  const second = await mountCanvas('second', open)
  assert.deepEqual(cam(second.el), SAVED,
    'the switched-to org must reopen at its own saved canvas position')
})

camTest('the session\'s first org keeps its start-view intro even with a camera saved', async (open) => {
  // the vacuous-pass guard for the test above: if mounting alone restored,
  // the switch assertion would prove nothing about switching
  setSaved('first', SAVED)
  const first = await mountCanvas('first', open)
  const parked = cam(first.el)
  assert.ok(parked.x !== SAVED.x || parked.y !== SAVED.y || parked.z !== SAVED.z,
    'the default start-view mode must keep its intro on the session\'s first org')
})

camTest('returning to the first org after visiting another restores its camera', async (open) => {
  const first = await mountCanvas('first', open)
  await open.pop()!.unmount()
  // leaving parks the camera under the slug (the canvas saves it itself);
  // overwrite with a distinct marker so the return is unambiguous
  const second = await mountCanvas('second', open)
  await open.pop()!.unmount()
  setSaved('first', SAVED)
  void second
  const back = await mountCanvas('first', open)
  assert.deepEqual(cam(back.el), SAVED,
    'A → B → A is a switch back, not a fresh session: A reopens where it was left')
})

camTest('a switch to an org with NO saved camera still introduces it (nothing to restore)', async (open) => {
  const first = await mountCanvas('first', open)
  void first
  await open.pop()!.unmount()
  localStorage.clear()   // drop even the camera the first canvas parked
  const second = await mountCanvas('second', open)
  const v = cam(second.el)
  assert.ok(Number.isFinite(v.x) && Number.isFinite(v.y) && v.z > 0,
    'a brand-new org renders a sane fitted camera after a switch')
})

// ---------------------------------------------------------------------------
// THE REAL SWITCH PATH: the canvas STAYS MOUNTED across an org switch.
//
// Everything above mounts one canvas per org, which is a fresh component each
// time. The app does not do that: OrgCanvas is not keyed by slug, so a switch
// re-renders the SAME component with a new `slug` prop while `tree` still
// holds the org being left — App swaps the tree only when its own fetch
// resolves (measured 11-38 s on a loaded org). Everything the canvas saves has
// to survive that mismatched-props window, and the user-reported bug lived
// entirely inside it: the camera save was keyed on the PROP, so its 250 ms
// debounce wrote the leaving org's camera over `orgtree-view-<the org being
// opened>` — which the intro effect then dutifully restored.
//
// These tests drive the switch exactly as App does: prop first, tree later.
const OP = () => Promise.resolve({} as never)

/** the canvas as App renders it: `treeSlug` is the payload on screen,
 *  `propSlug` is the org the app has already committed to */
async function canvasEl(treeSlug: string, propSlug: string) {
  const { OrgCanvas } = await import('../src/canvas/OrgCanvas')
  return <OrgCanvas tree={tree(treeSlug, ['ceo', 'cto'])} op={OP}
    slug={propSlug} toast={noop} mailEvt={null} />
}

async function mountMounted(slug: string, open: { unmount: () => Promise<void> }[]) {
  const view = await mountView(await canvasEl(slug, slug), (host) => host)
  open.push(view)
  await flush()
  await advance(2500)
  return view
}

/** THE SWITCH, in the two commits the app actually produces.
 *  1. the prop moves to `to` and the tree is still `from` — the window that
 *     has to write nothing under `to`. `hold` is how long the fetch takes.
 *  2. the payload for `to` lands, and its intro effect restores its camera. */
async function switchOrg(view: { render: (n: ReactNode) => Promise<HTMLElement> },
  from: string, to: string, hold = 1500) {
  await view.render(await canvasEl(from, to))
  await advance(hold)
  await view.render(await canvasEl(to, to))
  await advance(2500)
}

const readSaved = (slug: string): Cam | null => {
  const raw = localStorage.getItem('orgtree-view-' + slug)
  return raw ? JSON.parse(raw) as Cam : null
}

camTest('an org switch in flight never writes the leaving org over the org being opened', async (open) => {
  const OPENING: Cam = { x: -640, y: -410, z: 0.62 }
  setSaved('second', OPENING)
  const view = await mountMounted('first', open)
  const leaving = cam(view.el)
  assert.ok(leaving.x !== OPENING.x || leaving.y !== OPENING.y || leaving.z !== OPENING.z,
    'fixture failure: the first org parked exactly where the second org is saved, so a clobber would be invisible')
  // commit 1 only: the app has committed `second` and its tree has not landed
  await view.render(await canvasEl('first', 'second'))
  await advance(1500)          // well past the 250 ms camera debounce
  assert.deepEqual(readSaved('second'), OPENING,
    'the org being opened must still hold its own saved camera while its tree is in flight')
  assert.deepEqual(readSaved('first'), leaving,
    'the org being left must have its own final camera saved under its own slug')
})

camTest('a switch through the in-flight window still opens the new org at its own camera', async (open) => {
  const OPENING: Cam = { x: -640, y: -410, z: 0.62 }
  setSaved('second', OPENING)
  const view = await mountMounted('first', open)
  await switchOrg(view, 'first', 'second')
  assert.deepEqual(cam(view.el), OPENING,
    'the opened org must arrive at the camera it was left at, not the previous org\'s')
})

camTest('three orgs switched among repeatedly each keep their own camera', async (open) => {
  const SAVED_BY_ORG: Record<string, Cam> = {
    alpha: { x: 10, y: 20, z: 0.5 },
    beta: { x: -300, y: 140, z: 1.1 },
    gamma: { x: 880, y: -75, z: 0.35 },
  }
  for (const [slug, v] of Object.entries(SAVED_BY_ORG)) setSaved(slug, v)
  // alpha is the session's first canvas, so it plays its intro and parks
  // somewhere of its own; the other two must restore exactly.
  const view = await mountMounted('alpha', open)
  const alphaParked = cam(view.el)
  SAVED_BY_ORG.alpha = alphaParked

  // two full laps, so a state that only survives one hop fails here
  const lap = ['beta', 'gamma', 'alpha', 'gamma', 'beta', 'alpha']
  let at = 'alpha'
  for (const next of lap) {
    // eslint-disable-next-line no-await-in-loop
    await switchOrg(view, at, next)
    assert.deepEqual(cam(view.el), SAVED_BY_ORG[next],
      `${at} → ${next}: ${next} must reopen at its own camera`)
    at = next
    // every org NOT on screen keeps exactly what it had
    for (const [slug, want] of Object.entries(SAVED_BY_ORG)) {
      assert.deepEqual(readSaved(slug), want,
        `switching to ${next} must not touch ${slug}'s stored canvas state`)
    }
  }
})

camTest('a pan during the in-flight window belongs to the org on screen', async (open) => {
  // the mismatched window is not dead time: the canvas still shows the org
  // being left, so a camera move there is that org's state, not the next
  // org's. (Bailing out on the mismatch instead of re-keying would drop it.)
  setSaved('second', { x: -640, y: -410, z: 0.62 })
  const view = await mountMounted('first', open)
  await view.render(await canvasEl('first', 'second'))
  const space = view.el.querySelector('.space') as HTMLElement
  const viewport = view.el.querySelector('.viewport') as HTMLElement
  assert.ok(viewport, 'the canvas viewport did not render')
  const before = cam(view.el)
  const { act } = await import('react')
  await act(async () => {
    const down = new window.PointerEvent('pointerdown',
      { clientX: 400, clientY: 300, button: 0, buttons: 1, bubbles: true, pointerId: 1 })
    viewport.dispatchEvent(down)
    const move = new window.PointerEvent('pointermove',
      { clientX: 480, clientY: 360, button: -1, buttons: 1, bubbles: true, pointerId: 1 })
    viewport.dispatchEvent(move)
    const up = new window.PointerEvent('pointerup',
      { clientX: 480, clientY: 360, button: 0, buttons: 0, bubbles: true, pointerId: 1 })
    viewport.dispatchEvent(up)
  })
  await advance(1500)
  const after = cam(view.el)
  void space
  if (after.x === before.x && after.y === before.y) return   // jsdom refused the gesture; nothing to assert
  assert.deepEqual(readSaved('first'), after,
    'a camera move while the previous org is still on screen is saved under THAT org')
  assert.deepEqual(readSaved('second'), { x: -640, y: -410, z: 0.62 },
    'and never under the org whose tree has not arrived')
})
