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
// Run:  node tests/run.mjs viewrestore
import { advance, flush, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
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
