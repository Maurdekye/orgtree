// pendingmove.test.tsx — A HAND RE-PARENT SHOWS AT ONCE.
//
// Docket `v3-moving-an-agent-to-a-new-parent-by-hand-takes`. The user
// (2026-09-30): "manual by-hand org reassignments take about a second to
// visually appear; should be nearly instant". Dropping a card on a new parent
// used to change nothing until the op AND the tree read after it came back.
//
//   §1 the tree transform itself (`withPendingMoves`): moves the subtree,
//      keeps untouched branches, never loses a card on an impossible move
//   §2 the canvas: while the op is still in flight, the dropped card already
//      sits exactly where a tree with the move in it would put it
//   §3 a refused op sends the card back to its old place
//   §4 the toast's Undo is shown at once too
//
// Under jsdom every box is 0×0, so the viewport's rect sits at (0,0) and a
// client point is world·z + view offset — read off `.space`'s transform.
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs pendingmove

import { advance, FakeServer, flush, inAct, installFetch, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { OrgCanvas } from '../src/canvas/OrgCanvas'
import { resetConvos } from '../src/convo'
import { NODE_H, NODE_W, treeParents, withPendingMoves } from '../src/canvas/shared'
import type { OpRequest } from '../src/canvas/shared'
import type { TreeNode, TreePayload } from '../src/types'

const W = window as unknown as Window & typeof globalThis
const asTree = (v: unknown) => v as TreePayload

// (the node/tree fixture idiom of contextmenu.test.tsx / agentrowmenu.test.tsx)
function mkNode(id: string, children: unknown[] = []): unknown {
  return {
    id, title: id, tier: 'haiku', model_id: 'haiku', state: 'live',
    seat: 1, grant: 0, free: 0, ui_order: 0, cost_usd: 0, occupancy: null,
    context_window: null, charter: null, mail_pending: 0, limit_locked: false,
    last_status: null, prev_status: null, inflight_at: null, last_denials: [],
    turns: [], frozen: null, audiences_held: [], bearer_state: null,
    generation: 0, children, lineage: [],
    scope: { permission_mode: 'default', add_dirs: [], tools: {}, org_visibility: 'team' },
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
// boss ─┬─ a ── x ── xk      (x is dropped on b; xk must travel with it)
//       └─ b
const before = () => tree([mkNode('boss', [mkNode('a', [mkNode('x', [mkNode('xk')])]), mkNode('b')])])
const after = () => tree([mkNode('boss', [mkNode('a'), mkNode('b', [mkNode('x', [mkNode('xk')])])])])

// ------------------------------------------------------------ §1 transform
test('§1 withPendingMoves moves the whole subtree and leaves other branches alone', () => {
  const t = before()
  const out = withPendingMoves(t, new Map([['x', 'b']]))
  const p = treeParents(out)
  assert.equal(p.get('x'), 'b')
  assert.equal(p.get('xk'), 'x', 'the subtree travels with the node')
  assert.equal(p.get('a'), 'boss')
  assert.deepEqual([...treeParents(t)].sort(), [...treeParents(before())].sort(), 'input untouched')
  assert.equal(withPendingMoves(t, new Map()), t, 'no moves = the same object')
  const top = withPendingMoves(t, new Map([['x', null]]))
  assert.equal(treeParents(top).get('x'), null, 'null = a top-level root')
  assert.deepEqual(top.roots.map((r: TreeNode) => r.id), ['boss', 'x'])
})

test('§1 an impossible move is skipped, never loses a card', () => {
  const t = before()
  for (const bad of [new Map([['x', 'xk']]), new Map([['x', 'nobody']]),
    new Map([['ghost', 'b']]), new Map([['x', 'x']])]) {
    const out = withPendingMoves(t, bad)
    assert.deepEqual([...treeParents(out)].sort(), [...treeParents(t)].sort(),
      `skipped: ${JSON.stringify([...bad])}`)
  }
})

// ------------------------------------------------------------- the canvas
type Cap = { setPointerCapture?: unknown; releasePointerCapture?: unknown; hasPointerCapture?: unknown }
function stubPointerCapture(): () => void {
  const proto = (globalThis as unknown as { HTMLElement: { prototype: Cap } }).HTMLElement.prototype
  const had = { s: proto.setPointerCapture, r: proto.releasePointerCapture, h: proto.hasPointerCapture }
  proto.setPointerCapture = () => {}; proto.releasePointerCapture = () => {}; proto.hasPointerCapture = () => false
  return () => { proto.setPointerCapture = had.s; proto.releasePointerCapture = had.r; proto.hasPointerCapture = had.h }
}

const nums = (s: string) => (s.match(/-?\d+(\.\d+)?(e-?\d+)?/g) ?? []).map(Number)
const card = (el: HTMLElement, id: string) =>
  el.querySelector(`[data-first-use-agent="${id}"]`) as HTMLElement | null
/** the card's world position (its translate) */
function at(el: HTMLElement, id: string): { x: number; y: number } {
  const c = card(el, id)
  assert.ok(c, `card ${id} rendered`)
  const [x, y] = nums(c!.style.transform)
  return { x: x!, y: y! }
}
/** world point → client point through `.space`'s translate + scale */
function client(el: HTMLElement, w: { x: number; y: number }) {
  const space = el.querySelector('.space') as HTMLElement
  const [vx, vy, z] = nums(space.style.transform)
  return { clientX: vx! + w.x * z!, clientY: vy! + w.y * z! }
}

async function mountCanvas(t: TestContext, payload: TreePayload,
  run: (b: OpRequest) => Promise<unknown>) {
  t.after(stubPointerCapture())
  resetConvos()
  const had = (globalThis as { fetch?: typeof fetch }).fetch
  installFetch(new FakeServer())
  t.after(() => { (globalThis as { fetch?: typeof fetch }).fetch = had })
  const ops: OpRequest[] = []
  const notices: { lines: string[]; undo?: () => unknown }[] = []
  const v = await mountView(
    <OrgCanvas tree={payload} slug="mine"
      op={(b) => { ops.push(b); return run(b) as never }}
      toast={(lines, undo) => {
        if (lines) notices.push({ lines, undo: typeof undo === 'function' ? undo : undefined })
      }}
      mailEvt={null} />,
    (h) => h)
  t.after(() => v.unmount())
  await flush(); await advance(3000, 50); await flush()
  return { el: v.el, ops, notices, v }
}

/** a real card drag: press on `id`, move onto `onto`, release */
async function drag(el: HTMLElement, id: string, onto: string) {
  const from = at(el, id), to = at(el, onto)
  const p0 = client(el, { x: from.x + NODE_W / 2, y: from.y + NODE_H / 2 })
  const p1 = client(el, { x: to.x + NODE_W / 2, y: to.y + NODE_H / 2 })
  const c = card(el, id)!
  const fire = (type: string, p: { clientX: number; clientY: number }) => inAct(() => {
    c.dispatchEvent(new W.PointerEvent(type, { bubbles: true, button: 0, pointerId: 1, ...p }))
  })
  await fire('pointerdown', p0)
  await fire('pointermove', { clientX: (p0.clientX + p1.clientX) / 2, clientY: (p0.clientY + p1.clientY) / 2 })
  await fire('pointermove', p1)
  await fire('pointerup', p1)
  await flush(2)
}

/** where the canvas places `id` when the TREE itself says `payload` */
async function settledAt(t: TestContext, payload: TreePayload, id: string) {
  const m = await mountCanvas(t, payload, () => Promise.resolve({}))
  const p = at(m.el, id)
  await m.v.unmount()
  return p
}

test('§2 a dropped card sits under its new parent before the op answers', async (t) => {
  useFakeClock(); t.after(realClock)
  const want = await settledAt(t, after(), 'x')
  const was = await settledAt(t, before(), 'x')
  assert.notDeepEqual(want, was, 'fixture: the move changes where x sits')
  const m = await mountCanvas(t, before(), () => new Promise(() => {}))  // never answers
  await drag(m.el, 'x', 'b')
  assert.deepEqual(m.ops, [{ op: 'demote', node: 'x', new_parent: 'b' }])
  await advance(3000, 50)
  assert.deepEqual(at(m.el, 'x'), want, 'x is already where the moved tree puts it')
})

test('§3 a refused move sends the card back', async (t) => {
  useFakeClock(); t.after(realClock)
  const was = await settledAt(t, before(), 'x')
  let refuse: (e: Error) => void = () => {}
  const m = await mountCanvas(t, before(), () => new Promise((_, no) => { refuse = no }))
  await drag(m.el, 'x', 'b')
  await advance(3000, 50)
  assert.notDeepEqual(at(m.el, 'x'), was, 'shown moved while in flight')
  await inAct(() => { refuse(new Error('scope')) })
  await advance(3000, 50)
  assert.deepEqual(at(m.el, 'x'), was, 'back in its old place after the refusal')
})

test('§4 the toast Undo is shown at once as well', async (t) => {
  useFakeClock(); t.after(realClock)
  const was = await settledAt(t, before(), 'x')
  const m = await mountCanvas(t, before(),
    (b) => b.op === 'move' ? new Promise(() => {}) : Promise.resolve({}))
  await drag(m.el, 'x', 'b')
  await advance(200, 50)
  const n = m.notices.find((x) => x.lines[0] === 'x now reports to b')
  assert.ok(n?.undo, `the move toast carries an undo: ${JSON.stringify(m.notices)}`)
  await inAct(() => { void n!.undo!() })
  assert.deepEqual(m.ops.at(-1), { op: 'move', node: 'x', new_parent: 'a' })
  await advance(3000, 50)
  assert.deepEqual(at(m.el, 'x'), was, 'undo shows x back under a before the op answers')
})
