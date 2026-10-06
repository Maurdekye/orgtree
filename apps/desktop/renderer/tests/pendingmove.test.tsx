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
//   §5 once the op succeeded, a tree that agrees ends the override, so a
//      later tree that moves the card elsewhere wins at once
//   §6 the first move's fallback timer cannot end the Undo's override
//   §7 an old tree read that happens to agree with a pending Undo does not
//      end it early (the card would flash back to the undone parent)
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
import { NODE_H, NODE_W, setChartLayout, treeParents, withPendingMoves } from '../src/canvas/shared'
import type { OpRequest } from '../src/canvas/shared'
import type { TreeNode, TreePayload } from '../src/types'
import { projectTree } from '../src/recordprojection'

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
    auto_resume: false,
    fable_limit_policy: 'freeze', fable_filter_policy: 'halt',
    cascade_hire: false, cascade_alloc: true,
    audience_requests: [], org_inbox: null, net: null,
  })
}
// boss ─┬─ a ── x ── xk      (x is dropped on b; xk must travel with it)
//       └─ b
const before = () => tree([mkNode('boss', [mkNode('a', [mkNode('x', [mkNode('xk')])]), mkNode('b')])])
const after = () => tree([mkNode('boss', [mkNode('a'), mkNode('b', [mkNode('x', [mkNode('xk')])])])])
const elsewhere = () => tree([mkNode('boss', [mkNode('a'), mkNode('b'), mkNode('x', [mkNode('xk')])])])

// Real feed projection: the move changes the parent link, never the order key.
function orderedFixture(kind: 'order' | 'created' | 'ordinal' | 'name' = 'order', top = false) {
  const ids = kind === 'name' ? ['a', '\ue000', '\u{10000}'] : ['left', 'x', 'right']
  const rows = new Map<string, unknown>([
    ['old', { ...mkNode('old') as TreeNode, parent_id: null, ui_order: -10 }],
    ['target', { ...mkNode('target') as TreeNode, parent_id: null, ui_order: -5 }],
    ...ids.map((id, i): [string, unknown] => [String(i), {
      ...mkNode(id) as TreeNode, parent_id: i === 1 ? 'old' : top ? null : 'target',
      ui_order: kind === 'order' ? i : 0,
      created: kind === 'created' ? String(i) : 'same',
      // Names deliberately disagree with ordinal (right before x by name).
      ord: kind === 'ordinal' ? i : 0,
    }]),
    ['child', { ...mkNode('child') as TreeNode, parent_id: '1' }],
  ])
  const records = new Map([['org', new Map<string, unknown>([['org', tree([])]])], ['agent', rows]])
  const initial = projectTree(records)
  const confirmedRows = new Map(rows).set('1', {
    ...(rows.get('1') as object), parent_id: top ? null : 'target',
  })
  const confirmed = projectTree(new Map(records).set('agent', confirmedRows))
  return { initial, confirmed, moved: ids[1]!, ids, parent: top ? null : 'target' }
}

for (const kind of ['order', 'created', 'ordinal', 'name'] as const) {
  for (const top of [false, true]) test(`preview matches confirmed ${kind} ordering at ${top ? 'root' : 'child'} level`, () => {
    const { initial, confirmed, moved, ids, parent } = orderedFixture(kind, top)
    const snapshot = JSON.stringify(initial)
    const preview = withPendingMoves(initial, new Map([[moved, parent]]))
    const siblings = (t: TreePayload) => top ? t.roots : t.roots.find(n => n.id === parent)!.children
    const want = top ? ['old', 'target', ...ids] : ids
    assert.deepEqual(siblings(confirmed).map(n => n.id), want, 'independent expected order qualifies fixture')
    assert.deepEqual(siblings(preview).map(n => n.id), want)
    assert.deepEqual([...treeParents(preview)], [...treeParents(confirmed)])
    assert.equal(JSON.stringify(initial), snapshot, 'preview does not mutate the server tree')
    assert.equal(withPendingMoves(initial, new Map()), initial, 'cleared override restores original order')
    assert.deepEqual(siblings(withPendingMoves(confirmed, new Map([[moved, parent]]))).map(n => n.id), want,
      'an agreeing feed received while the operation is pending does not reorder again')
  })
}

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
/** positions equal to within the springs' last sub-pixel of travel */
const near = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.abs(a.x - b.x) < 2 && Math.abs(a.y - b.y) < 2
function assertAt(actual: { x: number; y: number }, want: { x: number; y: number }, msg: string) {
  assert.ok(near(actual, want), `${msg}: at ${JSON.stringify(actual)}, want ${JSON.stringify(want)}`)
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
  const view = (tree: TreePayload) => (
    <OrgCanvas tree={tree} slug="mine"
      op={(b) => { ops.push(b); return run(b) as never }}
      toast={(lines, undo) => {
        if (lines) notices.push({ lines, undo: typeof undo === 'function' ? undo : undefined })
      }}
      mailEvt={null} />)
  const v = await mountView(view(payload), (h) => h)
  t.after(() => v.unmount())
  await flush(); await advance(3000, 50); await flush()
  /** a tree read landing: the same canvas, re-rendered with `tree` */
  const show = async (tree: TreePayload) => { await v.render(view(tree)); await flush(2) }
  return { el: v.el, ops, notices, v, show }
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

for (const mode of ['row', 'circular'] as const) {
  for (const success of [true, false]) test(`${mode}: middle move ${success ? 'keeps its confirmed position' : 'rolls back on refusal'}`, async (t) => {
    useFakeClock(); t.after(realClock)
    setChartLayout(mode); t.after(() => inAct(() => setChartLayout('row')))
    const { initial, confirmed } = orderedFixture()
    const want = await settledAt(t, confirmed, 'x')
    const was = await settledAt(t, initial, 'x')
    assert.ok(!near(want, was), 'fixture changes position')
    let resolve!: (v: unknown) => void, reject!: (e: Error) => void
    const m = await mountCanvas(t, initial, () => new Promise((yes, no) => { resolve = yes; reject = no }))
    await drag(m.el, 'x', 'target')
    assert.deepEqual(m.ops, [{ op: 'demote', node: 'x', new_parent: 'target' }])
    await advance(3000, 50)
    assertAt(at(m.el, 'x'), want, 'pending move is already in the middle, not appended')
    await inAct(() => (m.el.querySelector('.tray-toggle') as HTMLElement).click())
    await flush()
    const listOrder = () => [...m.el.querySelectorAll('.tray-row')]
      .map(row => row.getAttribute('data-copy-agent-name'))
    const movedOrder = ['old', 'target', 'left', 'x', 'child', 'right']
    assert.deepEqual(listOrder(), movedOrder, 'agents list follows the same preview')
    if (success) {
      await inAct(() => resolve({}))
      await m.show(confirmed)
      await advance(3000, 50)
      assertAt(at(m.el, 'x'), want, 'confirmation does not move the card')
      assert.deepEqual(listOrder(), movedOrder, 'confirmation does not reorder the list')
    } else {
      await inAct(() => reject(new Error('move refused')))
      await advance(3000, 50)
      assertAt(at(m.el, 'x'), was, 'failure restores the original parent and position')
      assert.deepEqual(listOrder(), ['old', 'x', 'child', 'target', 'left', 'right'])
    }
  })
}

test('§2 a dropped card sits under its new parent before the op answers', async (t) => {
  useFakeClock(); t.after(realClock)
  const want = await settledAt(t, after(), 'x')
  const was = await settledAt(t, before(), 'x')
  assert.ok(!near(want, was), 'fixture: the move changes where x sits')
  const m = await mountCanvas(t, before(), () => new Promise(() => {}))  // never answers
  await drag(m.el, 'x', 'b')
  assert.deepEqual(m.ops, [{ op: 'demote', node: 'x', new_parent: 'b' }])
  await advance(3000, 50)
  assertAt(at(m.el, 'x'), want, 'x is already where the moved tree puts it')
})

test('§3 a refused move sends the card back', async (t) => {
  useFakeClock(); t.after(realClock)
  const was = await settledAt(t, before(), 'x')
  let refuse: (e: Error) => void = () => {}
  const m = await mountCanvas(t, before(), () => new Promise((_, no) => { refuse = no }))
  await drag(m.el, 'x', 'b')
  await advance(3000, 50)
  assert.ok(!near(at(m.el, 'x'), was), 'shown moved while in flight')
  await inAct(() => { refuse(new Error('scope')) })
  await advance(3000, 50)
  assertAt(at(m.el, 'x'), was, 'back in its old place after the refusal')
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
  assertAt(at(m.el, 'x'), was, 'undo shows x back under a before the op answers')
})

/** drop x on b with the demote answering at once and every Undo left hanging */
async function movedThenAnswered(t: TestContext) {
  const m = await mountCanvas(t, before(),
    (b) => b.op === 'move' ? new Promise(() => {}) : Promise.resolve({}))
  await drag(m.el, 'x', 'b')
  await advance(200, 50)
  return m
}
const undo = async (m: Awaited<ReturnType<typeof movedThenAnswered>>) => {
  const n = m.notices.find((x) => x.lines[0] === 'x now reports to b')
  assert.ok(n?.undo, `the move toast carries an undo: ${JSON.stringify(m.notices)}`)
  await inAct(() => { void n!.undo!() })
}

test('§5 after success, the agreeing tree ends the override; a later tree wins', async (t) => {
  useFakeClock(); t.after(realClock)
  const there = await settledAt(t, elsewhere(), 'x')
  const m = await movedThenAnswered(t)
  await m.show(after())              // the read after the move: agrees
  await m.show(elsewhere())          // somebody moved x again, well inside 5 s
  await advance(1000, 50)
  assertAt(at(m.el, 'x'), there, 'x follows the newer tree, not the finished move')
})

test("§6 the first move's timer cannot end the Undo's override", async (t) => {
  useFakeClock(); t.after(realClock)
  const was = await settledAt(t, before(), 'x')
  const m = await movedThenAnswered(t)
  await undo(m)                      // the Undo's op never answers
  await m.show(after())              // the first move has landed
  await advance(6000, 50)            // past the first move's 5 s fallback
  assertAt(at(m.el, 'x'), was, 'x stays under a while the Undo is in flight')
})

test('§7 an old read agreeing with a pending Undo does not end it', async (t) => {
  useFakeClock(); t.after(realClock)
  const was = await settledAt(t, before(), 'x')
  const m = await movedThenAnswered(t)
  await undo(m)
  await m.show(before())             // a read taken before the move landed
  await m.show(after())              // then the read showing the move itself
  await advance(1000, 50)
  assertAt(at(m.el, 'x'), was, 'no flash back to b before the Undo lands')
})
