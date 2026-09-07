// deskinit.test.tsx — initializing an agent opens ITS desk (user feature
// 2026-08-26): confirming the hire on the dashed "uninitialized" draft box
// glides the camera to the new agent's desk, instead of leaving you at
// overview zoom with a fresh card among its siblings and no way in.
//
// The whole point of the feature is that the agent is IDLE until someone
// messages it, and the desk is where that message is typed — so the thing
// worth asserting is "the desk for the new agent is open", not "the camera
// moved somewhere".
//
// ⚠ WHAT THIS SUITE ASSERTS, AND WHY IT IS SHAPED THIS WAY. jsdom does no
// layout: every `getBoundingClientRect()` is zeros, so nothing here may be
// asserted from measured geometry — a check on a measured position passes for
// the same reason it would pass on a blank page. Two consequences:
//   • the camera is read as the NUMBERS THIS CODE WROTE — the `translate/scale`
//     in `.space`'s transform — never as a measured position;
//   • the desk is read as the DOM CONSEQUENCE — `.sq.desk`, the class
//     `NodeSquare` carries only while `focusId` names it. That is a real
//     behavioural check: `focusId` is DERIVED from the camera (nearest card to
//     the viewport centre, and only while z ≥ Z_DESK), so a glide that lands
//     at the wrong zoom or on the wrong card opens no desk, or the wrong one.
//
// ⚠ AND WHAT IT CANNOT: the harness's rAF hands the callback a MOCKED
// `Date.now()` while `animateTo` stamps its start from the real
// `performance.now()`, so the eased glide always completes in its first frame
// here. This suite therefore verifies WHERE the camera arrives and never HOW
// it travels — the 460ms ease, and whether it looks right, are for a human on
// a live canvas.
//
// ANTI-VACUITY. §1 is the feature; §2, §3 and §4 all use the SAME two readers
// and assert the opposite outcome, so §1 cannot be green because the readers
// find nothing. §2 is the positive control on the starting state (no desk is
// open before the hire — otherwise §1 asserts a condition that was already
// true). §3 is the mutation: the hire's node never arrives in the tree, and
// the desk must NOT open — it fails if the trigger centres on a phantom id.
// §4 pins the scope decision: a node appearing by BROADCAST (an agent hiring
// its own subordinate) must not move the user's camera.
//
// Run:  cd frontend && node tests/run.mjs deskinit

import {
  advance, FakeServer, flush, installFetch, mountView, realClock, useFakeClock,
} from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { useEffect, useState } from 'react'
import { OrgCanvas } from '../src/canvas/OrgCanvas'
import { Z_DESK } from '../src/canvas/shared'
import { resetConvos } from '../src/convo'
import type { OpResult, TreePayload } from '../src/types'

const noop = () => {}

// ---------------------------------------------------------------- fixtures
/** shaped like the payload, not type-checked into it — the fixture idiom of
 *  audpile/mailwire, trimmed to what OrgCanvas actually dereferences */
const asTree = (v: unknown) => v as TreePayload

interface FixNode { id: string; children?: FixNode[] }

function mk(n: FixNode): unknown {
  return {
    id: n.id, title: n.id, tier: 'haiku', model_id: 'haiku', state: 'live',
    seat: 1, grant: 0, free: 0, ui_order: 0, cost_usd: 0, occupancy: null,
    context_window: null, charter: null, mail_pending: 0, limit_locked: false,
    last_status: null, prev_status: null, inflight_at: null, last_denials: [],
    turns: [], frozen: null, audiences_held: [], bearer_state: null,
    generation: 0, children: (n.children ?? []).map(mk), lineage: [],
    scope: { permission_mode: 'default', add_dirs: [], tools: {}, org_visibility: 'team' },
  }
}

function tree(roots: FixNode[]): TreePayload {
  return asTree({
    slug: 'mine', name: 'mine', workspace: null, dirs: [], max_top_grant: 1000,
    default_top_grant: 50, compact_at: 0, default_tools: null,
    default_visibility: 'team', default_effort: '', credit_requests: [],
    tiers: { haiku: 1, sonnet: 3, opus: 5, fable: 10 }, audiences: [],
    roots: roots.map(mk), cost_usd_total: 0,
    audit: { live_nodes: roots.length, top_level_holds: 0, no_overdraft: true, problems: [] },
    user_inbox_count: 0, user_inbox_newest: null, fable_lock: null,
    spend_frozen: false, storage_blocked: false, auto_resume: false,
    fable_limit_policy: 'freeze', fable_filter_policy: 'halt',
    cascade_hire: false, cascade_alloc: true, sandboxed: false,
    audience_requests: [], org_inbox: null, net: null,
  })
}

// ------------------------------------------------------------- the readers
/** the camera, read as the numbers this code WROTE into the world transform */
function camera(host: HTMLElement): { x: number; y: number; z: number } {
  const space = host.querySelector('.space') as HTMLElement | null
  assert.ok(space, 'no .space element — the canvas did not render')
  const m = /translate\(([-\d.e+]+)px, ?([-\d.e+]+)px\) scale\(([-\d.e+]+)\)/
    .exec(space.style.transform)
  assert.ok(m, `unparsable world transform: ${space.style.transform}`)
  return { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) }
}

/** which AGENT's desk is open, by the card class `focusId` drives — or null.
 *  `:not(.user)` on purpose: the eye wears `.desk` too when its switchboard
 *  fills the screen, and that is a different surface (D-…: the switchboard is
 *  full-screen), not an agent's desk. */
function openDesk(host: HTMLElement): string | null {
  const card = host.querySelector('.sq.desk:not(.user)')
  if (!card) return null
  // the name is read off the DESK's own chrome (`.cc-name`), not the card's
  // `.sq-head .name` — the world-scaled head is unmounted at focus precisely
  // because it would blow up to poster size at desk zoom, so on the one card
  // this function cares about, `.name` never exists
  return card.querySelector('.cc-name')?.textContent ?? '(desk with no name)'
}

// -------------------------------------------------------------- the driver
/** A canvas whose tree the test can REPLACE, which is what a hire's broadcast
 *  refetch does in the real app — the hire response lands frames before the
 *  tree that gives the new node a position, and this feature lives exactly in
 *  that gap. */
function Rig({ boot, op, hold }: {
  boot: TreePayload
  op: (o: Record<string, unknown>) => Promise<OpResult>
  hold: { set?: (t: TreePayload) => void }
}) {
  const [t, setT] = useState(boot)
  useEffect(() => { hold.set = setT }, [hold])
  return <OrgCanvas tree={t} op={op as never} slug="mine" toast={noop}
    mailEvt={null} />
}

function uiTest(name: string,
  body: (k: {
    host: HTMLElement
    setTree: (t: TreePayload) => Promise<void>
    ops: Record<string, unknown>[]
    /** what the next `hire` op resolves with; `null` = a hire that returns no id */
    born: { id: string | null }
  }) => Promise<void>): void {
  test(name, async (t: TestContext) => {
    useFakeClock()
    installFetch(new FakeServer())
    const open: { unmount: () => Promise<void> }[] = []
    t.after(async () => {
      for (const m of open) { try { await m.unmount() } catch { /* gone */ } }
      resetConvos()
      realClock()
    })
    const ops: Record<string, unknown>[] = []
    const born = { id: 'newbie' as string | null }
    const hold: { set?: (x: TreePayload) => void } = {}
    const op = (o: Record<string, unknown>) => {
      ops.push(o)
      return Promise.resolve(
        (born.id ? { node: born.id } : {}) as unknown as OpResult)
    }
    const v = await mountView(
      <Rig boot={tree([{ id: 'boss' }])} op={op} hold={hold} />,
      (el) => el)
    open.push(v)
    await flush()
    const { act } = await import('react')
    await body({
      host: v.el, ops, born,
      // the broadcast refetch patches the tree from outside React's own event
      // handling — same reason `advance` wraps its ticks
      setTree: async (x) => { await act(async () => { hold.set?.(x) }) },
    })
  })
}

// ------------------------------------------------------------- the gesture
/** The real hiring path, through the real DOM: the bottom hire chip on
 *  `boss`'s card opens the draft, the name is typed into it, Enter confirms.
 *  Chips are hover-GATED IN CSS, not in React, so they are in the document
 *  here — jsdom applies no stylesheet, which for once is the convenient
 *  direction. */
async function hireFromChip(host: HTMLElement, name: string): Promise<void> {
  const { act } = await import('react')
  const card = [...host.querySelectorAll('.sq')].find((c) =>
    c.querySelector('.name')?.textContent === 'boss')
  assert.ok(card, 'no card for boss — the fixture did not render')
  // the bottom set (`.hsof` with no `.side`) hires a REPORT; the side/top sets
  // hire a coworker and splice a superior respectively
  const chip = card.querySelector('.hsof:not(.side) button.t-haiku')
  assert.ok(chip, 'no bottom hire chip on boss')
  await act(async () => {
    (chip as HTMLButtonElement).click()
    await flush()
  })
  await advance(200)          // spawn()'s 60ms glide-to-draft timer

  const input = host.querySelector('input.df-name') as HTMLInputElement | null
  assert.ok(input, 'no draft form — the hire chip opened nothing')
  // a React controlled input ignores a plain `.value =`; go through the
  // prototype setter and fire the event React actually listens for.
  // (off `window`, not `globalThis`: the harness hoists a hand-picked few of
  // jsdom's constructors onto the global and `HTMLInputElement` is not among
  // them — the window it built always has all of them.)
  const w = (globalThis as unknown as { window: Window }).window as unknown as {
    HTMLInputElement: typeof HTMLInputElement
    Event: typeof Event
    KeyboardEvent: typeof KeyboardEvent
  }
  const setter = Object.getOwnPropertyDescriptor(
    w.HTMLInputElement.prototype, 'value')?.set
  assert.ok(setter, 'no value setter on HTMLInputElement')
  await act(async () => {
    setter.call(input, name)
    input.dispatchEvent(new w.Event('input', { bubbles: true }))
    await flush()
  })
  await act(async () => {
    input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await flush()
  })
}

/** the broadcast refetch: the tree now carries the new agent under boss */
const withNewbie = (id: string) => tree([{ id: 'boss', children: [{ id }] }])

/** …and the same refetch when the layout has MOVED underneath the hire: the
 *  new agent is seeded at the draft's slot (centred under a childless boss)
 *  but lands as the rightmost of four, columns away. Realistic — anything
 *  that reshapes boss's row between the hire and the refetch does this — and
 *  it is the only way to make the birth spring genuinely travel, which §5
 *  needs and §1 (seed ≈ target, settled almost at once) cannot provide. */
const withCrowd = (id: string) => tree([{ id: 'boss', children:
  [{ id: 'o1' }, { id: 'o2' }, { id: 'o3' }, { id }] }])

// ==========================================================================
uiTest('§1 confirming the hire opens the NEW agent’s desk', async (k) => {
  await hireFromChip(k.host, 'newbie')
  assert.equal(k.ops.length, 1, 'the draft did not submit a hire op')
  assert.equal(k.ops[0]?.op, 'hire')
  assert.equal(k.ops[0]?.name, 'newbie')

  // the hire has resolved, but the tree has not caught up: nothing to open yet
  assert.equal(openDesk(k.host), null,
    'a desk opened before the new agent existed in the tree')

  await k.setTree(withNewbie('newbie'))
  await advance(3000)   // the card is born, its spring settles, then the glide

  assert.equal(openDesk(k.host), 'newbie',
    'the new agent’s desk did not open — initializing an agent should walk '
    + 'you to the desk where you give it its first instruction')
  const cam = camera(k.host)
  assert.ok(cam.z >= Z_DESK,
    `camera stopped at z=${cam.z}, under the Z_DESK threshold ${Z_DESK} — `
    + 'below it `focusId` names nobody and no desk can open at all')
})

// ==========================================================================
uiTest('§2 CONTROL: no desk is open before the hire (§1 is not already true)',
  async (k) => {
    assert.equal(openDesk(k.host), null,
      'a desk was already open at rest — §1 would assert nothing')
    const cam = camera(k.host)
    assert.ok(cam.z < Z_DESK,
      `the canvas opened at z=${cam.z}, already at or past Z_DESK ${Z_DESK} — `
      + '§1 would be reading a camera it did not move')
  })

// ==========================================================================
uiTest('§3 MUTATION: a hire whose node never arrives opens NO desk',
  async (k) => {
    await hireFromChip(k.host, 'ghost')
    assert.equal(k.ops.length, 1, 'the draft did not submit a hire op')
    // the tree is never replaced: `ghost` has an id and no position, forever
    await advance(3000)
    assert.equal(openDesk(k.host), null,
      'a desk opened for an agent with no card — the trigger centred on a '
      + 'phantom id instead of waiting for the layout to know it')
    const cam = camera(k.host)
    assert.ok(cam.z < Z_DESK,
      `the camera dove to z=${cam.z} for a node that does not exist`)
  })

// ==========================================================================
uiTest('§4 SCOPE: a node arriving by broadcast does not move the camera',
  async (k) => {
    // no draft, no local hire — exactly what an agent calling `orgtree_hire`
    // deep in its own subtree looks like from this browser. Deliberate: a
    // camera that jumps on events the user did not cause is a viewport the
    // user has to fight for.
    await k.setTree(withNewbie('theirs'))
    await advance(3000)
    assert.equal(k.ops.length, 0, 'the fixture submitted a hire it should not have')
    assert.equal(openDesk(k.host), null,
      'a background hire yanked the camera to a desk the user never asked for')
  })

// ==========================================================================
// ⚠ STEP AT 16ms, NOT THE DEFAULT. `advance(ms)` chunks at 250ms, and every
// rAF callback inside one chunk reads the SAME mocked `Date.now()` — so the
// spring loop integrates ONCE PER CHUNK, not once per frame. `advance(3000)`
// delivers ~12 steps of 33ms: 0.4s of spring time, not 3s. A spring still
// visibly travelling then looks exactly like one that never converges.
// (Found by drag-zoom-bug while fixing the follow; noted here because this
// is the one suite whose subject IS the spring's journey.)
//
// WHY THIS EXISTS. §1-§4 do not exercise the arrival wait at all — the draft
// sits at the slot the hire lands in, so the birth spring is settled almost
// immediately and the wait is satisfied on the first frame it is tested.
// Proven, not assumed: with the wait removed AND the follow's arrival gate
// disabled, all four still passed. This is the check that fails if the wait
// is removed, which the source comment now points at by name.
uiTest('§5 the camera waits for the new card to ARRIVE, not merely to exist',
  async (k) => {
    await hireFromChip(k.host, 'newbie')
    assert.equal(k.ops.length, 1, 'the draft did not submit a hire op')

    // the card now exists in the layout, and is a long way from where it was
    // seeded — it has to travel
    await k.setTree(withCrowd('newbie'))
    await advance(96, 16)          // ~6 frames: the spring is under way
    assert.equal(openDesk(k.host), null,
      'the camera dived while the new card was still in flight — it would '
      + 'centre on where the card is going to be, not where it is')
    const mid = camera(k.host)
    assert.ok(mid.z < Z_DESK,
      `camera already at z=${mid.z} (≥ Z_DESK ${Z_DESK}) while the card was `
      + 'still travelling — the arrival wait is not holding')

    await advance(3000, 16)        // …and now it has landed
    assert.equal(openDesk(k.host), 'newbie',
      'the desk never opened — the card arrived and the wait never released')
    const end = camera(k.host)
    assert.ok(end.z >= Z_DESK,
      `camera finished at z=${end.z}, under the desk threshold ${Z_DESK}`)
  })
