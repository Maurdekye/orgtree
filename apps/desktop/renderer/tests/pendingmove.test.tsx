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
import { NODE_H, NODE_W, USER, setChartLayout, treeParents, withPendingMoves } from '../src/canvas/shared'
import { withPendingOrder } from '../src/canvas/pendingorder'
import type { OpRequest } from '../src/canvas/shared'
import type { TreeNode, TreePayload } from '../src/types'
import { projectTree } from '../src/recordprojection'
import { addPin, forgetPins, readPins } from '../src/canvas/pins'

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

// Real feed projection: a move changes the parent link and assigns a fresh order key (engine move_node).
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
  // the engine's move_node gives every real move a fresh order after the destination's live siblings
  // (withPendingMoves mirrors it), so the confirmed row carries that new key
  const siblingsOrder = Math.max(...[...rows.entries()].filter(([k, r]) => k !== '1' && (r as { parent_id: string | null }).parent_id === (top ? null : 'target'))
    .map(([, r]) => (r as { ui_order: number }).ui_order))
  const confirmedRows = new Map(rows).set('1', {
    ...(rows.get('1') as object), parent_id: top ? null : 'target', ui_order: siblingsOrder + 1,
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
    const landed = [...ids.filter(i => i !== moved), moved]  // a moved agent lands LAST (fresh order)
    const want = top ? ['old', 'target', ...landed] : landed
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
  const c = id === USER ? el.querySelector<HTMLElement>('.sq.user') : card(el, id)
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
// jsdom's viewport is 0x0, so every pointer is "near an edge" and the drag's edge-pan (№23) shifts the camera under
// it, and the camera centres on a zero-size screen. Give `.viewport` a real 1600x900 size before it mounts.
function sizeViewport(): () => void {
  const proto = (globalThis as unknown as { HTMLElement: { prototype: HTMLElement } }).HTMLElement.prototype
  const saved = { rect: proto.getBoundingClientRect, w: Object.getOwnPropertyDescriptor(proto, 'clientWidth'), h: Object.getOwnPropertyDescriptor(proto, 'clientHeight') }
  const isVp = (el: Element) => el.classList?.contains('viewport')
  proto.getBoundingClientRect = function (this: HTMLElement) { return (isVp(this) ? VP : saved.rect.call(this)) as DOMRect }
  Object.defineProperty(proto, 'clientWidth', { configurable: true, get(this: HTMLElement) { return isVp(this) ? VP.width : 0 } })
  Object.defineProperty(proto, 'clientHeight', { configurable: true, get(this: HTMLElement) { return isVp(this) ? VP.height : 0 } })
  return () => { proto.getBoundingClientRect = saved.rect; if (saved.w) Object.defineProperty(proto, 'clientWidth', saved.w); else delete (proto as unknown as Record<string, unknown>).clientWidth; if (saved.h) Object.defineProperty(proto, 'clientHeight', saved.h); else delete (proto as unknown as Record<string, unknown>).clientHeight }
}
const VP = { left: 0, top: 0, right: 1600, bottom: 900, width: 1600, height: 900, x: 0, y: 0, toJSON() {} }
function client(el: HTMLElement, w: { x: number; y: number }) {
  const space = el.querySelector('.space') as HTMLElement
  const [vx, vy, z] = nums(space.style.transform)
  return { clientX: VP.left + vx! + w.x * z!, clientY: VP.top + vy! + w.y * z! }
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
  const view = (tree: TreePayload, focusAgent?: string) => (
    <OrgCanvas tree={tree} slug="mine" focusAgent={focusAgent}
      op={(b) => { ops.push(b); return run(b) as never }}
      toast={(lines, undo) => {
        if (lines) notices.push({ lines, undo: typeof undo === 'function' ? undo : undefined })
      }}
      mailEvt={null} />)
  t.after(sizeViewport())
  const v = await mountView(view(payload), (h) => h)
  t.after(() => v.unmount())
  await flush(); await advance(3000, 50); await flush()
  /** a tree read landing: the same canvas, re-rendered with `tree` */
  const show = async (tree: TreePayload) => { await v.render(view(tree)); await flush(2) }
  const focus = async (id: string) => {
    // Use the public named-jump route after startup has settled; a synthetic
    // press on a card can already be inside its focused desk in a ring.
    await v.render(view(payload, id)); await flush()
    await advance(3000, 50); await flush()
  }
  return { el: v.el, ops, notices, v, show, focus }
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

// forgetPins invalidates only the cache: clear persisted state FIRST or the
// next read rehydrates the previous case's pin and named focus targets it.
function resetDeskFixture() {
  for (const key of ['orgtree-pins-mine', 'orgtree-view-mine', 'orgtree-pile-mine']) localStorage.removeItem(key)
  forgetPins('mine')
}

for (const mode of ['row', 'circular'] as const) {
  for (const surface of ['desk-header', 'desk-transcript', 'desk-composer', 'pinned-transcript', 'pinned-header'] as const) {
    test(`${mode}: middle drag on real ${surface} crosses its portal and pans the canvas`, async t => {
      useFakeClock(); t.after(realClock)
      setChartLayout(mode); t.after(() => inAct(() => setChartLayout('row')))
      resetDeskFixture()
      const m = await mountCanvas(t, tree([mkNode('x')]), () => Promise.resolve({}))
      t.after(resetDeskFixture) // mountCanvas registered unmount before this reset
      assert.deepEqual(readPins('mine'), [], 'case starts with no saved or cached pins')
      const viewport = m.el.querySelector<HTMLElement>('.viewport')!
      const space = m.el.querySelector<HTMLElement>('.space')!
      if (surface.startsWith('pinned-')) {
        await inAct(() => { assert.equal(addPin('mine', 'x', { x: 100, y: 100, w: 600, h: 500 }).ok, true) })
        await flush()
      } else {
        await m.focus('x')
        assert.equal(card(m.el, 'x')!.classList.contains('pinned'), false, 'named focus targets the canvas desk')
      }
      const host = surface.startsWith('pinned-')
        ? m.el.querySelector<HTMLElement>('.pinwin')! : card(m.el, 'x')!
      const selector = surface === 'pinned-header' ? '.pinwin-title' : surface === 'desk-header' ? '.cc-head'
        : surface === 'desk-composer' ? 'textarea' : '.msgs'
      const target = host?.querySelector<HTMLElement>(selector)
      assert.ok(target, `real ${surface} is mounted: card=${card(m.el, 'x')?.className}; camera=${space.style.transform}; desks=${m.el.querySelectorAll('.desk-over,.desk-bare').length}`)
      if (surface !== 'pinned-header') assert.ok(target.closest('.movable-events'), 'use the registry-owned portal, not a stand-in')
      const scroll = host.querySelector<HTMLElement>('.msgs')!
      // jsdom has no layout. Model scrollable geometry, then let the desk's
      // follow-tail settle and record that position BEFORE the pan. A scroll
      // event alone is not user scroll intent and can legitimately follow.
      Object.defineProperty(scroll, 'scrollHeight', { configurable: true, value: 500 })
      Object.defineProperty(scroll, 'clientHeight', { configurable: true, value: 100 })
      scroll.scrollTop = 17
      await inAct(() => scroll.dispatchEvent(new W.Event('scroll', { bubbles: false })))
      await flush()
      const scrollBefore = scroll.scrollTop
      const initial = nums(space.style.transform), position = at(m.el, 'x')
      const pins = JSON.stringify(readPins('mine'))
      const captures: number[] = []
      viewport.setPointerCapture = id => { captures.push(id) }
      const fire = async (type: string, x: number, y: number) => {
        const event = new W.PointerEvent(type, { bubbles: true, cancelable: true,
          button: 1, buttons: type === 'pointerup' ? 0 : 4, pointerId: 77, clientX: x, clientY: y })
        await inAct(() => target.dispatchEvent(event)); return event
      }
      const down = await fire('pointerdown', 800, 400)
      for (const type of ['pointermove', 'pointerup']) await inAct(() => {
        viewport.dispatchEvent(new W.PointerEvent(type, { bubbles: true, pointerId: 999,
          clientX: 950, clientY: 550, button: 0 }))
      })
      assert.deepEqual(nums(space.style.transform), initial, 'another pointer cannot move or finish middle pan')
      await fire('pointermove', 855, 430)
      await fire('pointerup', 855, 430)
      assert.deepEqual(nums(space.style.transform), [initial[0]! + 55, initial[1]! + 30, initial[2]!])
      assert.equal(down.defaultPrevented, true)
      assert.deepEqual(captures, [77], 'the actual viewport owns pointer capture')
      for (const type of ['mousedown', 'auxclick']) {
        const event = new W.MouseEvent(type, { bubbles: true, cancelable: true, button: 1 })
        await inAct(() => target.dispatchEvent(event)); assert.equal(event.defaultPrevented, true, type)
      }
      assert.equal(scroll.scrollTop, scrollBefore, 'desk transcript did not scroll')
      assertAt(at(m.el, 'x'), position, 'agent did not move')
      assert.equal(JSON.stringify(readPins('mine')), pins, 'pin did not move or resize')
      assert.deepEqual(m.ops, [], 'no node/desk operation')
      for (const finish of ['pointercancel', 'lostpointercapture']) {
        await fire('pointerdown', 800, 400)
        await inAct(() => viewport.dispatchEvent(new W.PointerEvent(finish, { bubbles: true, pointerId: 77, button: 1 })))
        await fire('pointermove', 900, 500)
        assert.deepEqual(nums(space.style.transform), [initial[0]! + 55, initial[1]! + 30, initial[2]!], finish)
      }
      await advance(400, 50)
      const saved = JSON.parse(localStorage.getItem('orgtree-view-mine')!)
      assert.deepEqual([saved.x, saved.y, saved.z], nums(space.style.transform))
    })
  }
  test(`${mode}: real desk left/right selection, composer and wheel retain their events/defaults`, async t => {
    useFakeClock(); t.after(realClock)
    setChartLayout(mode); t.after(() => inAct(() => setChartLayout('row')))
    resetDeskFixture()
    const m = await mountCanvas(t, tree([mkNode('x')]), () => Promise.resolve({}))
    t.after(resetDeskFixture)
    assert.deepEqual(readPins('mine'), [], 'preservation case starts without pins')
    await m.focus('x')
    assert.equal(card(m.el, 'x')!.classList.contains('pinned'), false, 'selection runs inside the canvas desk')
    const desk = card(m.el, 'x')!, msgs = desk.querySelector<HTMLElement>('.msgs')!
    const composer = desk.querySelector<HTMLTextAreaElement>('textarea')!
    assert.ok(msgs && composer, `real desk content is mounted: card=${desk.className}; camera=${m.el.querySelector<HTMLElement>('.space')!.style.transform}`)
    const text = document.createTextNode('selectable transcript'); msgs.appendChild(text)
    const range = document.createRange(); range.selectNodeContents(text)
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range)
    t.after(() => selection.removeAllRanges())
    const initial = m.el.querySelector<HTMLElement>('.space')!.style.transform
    let delivered = 0
    for (const target of [msgs, composer]) {
      target.addEventListener('pointerdown', () => { delivered++ })
      for (const button of [0, 2]) for (const type of ['pointerdown', 'pointermove', 'pointerup', 'mousedown', 'auxclick']) {
        const event = new W.PointerEvent(type, { bubbles: true, cancelable: true,
          button, pointerId: 80, clientX: type === 'pointerdown' ? 800 : 855, clientY: 400 })
        await inAct(() => target.dispatchEvent(event)); assert.equal(event.defaultPrevented, false, `${type}/${button}`)
      }
    }
    const wheel = new W.WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 100 })
    await inAct(() => msgs.dispatchEvent(wheel))
    assert.equal(wheel.defaultPrevented, false, 'wheel remains native desk scroll')
    assert.equal(delivered, 4, 'left/right pointer presses reached both desk controls')
    assert.equal(selection.toString(), 'selectable transcript')
    assert.equal(m.el.querySelector<HTMLElement>('.space')!.style.transform, initial)
    assert.deepEqual(m.ops, [])
  })
  for (const surface of ['node', 'switchboard', 'background', 'card-link', 'org-inbox', 'presentation'] as const) {
    test(`${mode}: middle drag on ${surface} pans only and persists the same viewport`, async t => {
      useFakeClock(); t.after(realClock)
      setChartLayout(mode); t.after(() => inAct(() => setChartLayout('row')))
      localStorage.removeItem('orgtree-view-mine')
      const payload = before()
      if (surface === 'org-inbox') payload.org_inbox = { enabled: true, visible: true, entries: [] } as unknown as TreePayload['org_inbox']
      if (surface === 'presentation') payload.roots[0]!.children[0]!.children[0]!.documents = [
        { id: 'fixture-document', title: 'Canvas document', format: 'markdown' } as never,
      ]
      const m = await mountCanvas(t, payload, () => Promise.resolve({}))
      const viewport = m.el.querySelector<HTMLElement>('.viewport')!
      const space = m.el.querySelector<HTMLElement>('.space')!
      const from = at(m.el, 'x')
      const viewBefore = nums(space.style.transform)
      let target: HTMLElement = surface === 'background' ? viewport
        : surface === 'switchboard' ? m.el.querySelector<HTMLElement>('.sq.user')!
        : surface === 'org-inbox' ? m.el.querySelector<HTMLElement>('.sq.orginbox')!
        : surface === 'presentation' ? card(m.el, 'x')!.querySelector<HTMLElement>('.doc-chip')! : card(m.el, 'x')!
      assert.ok(target, `${surface} rendered`)
      if (surface === 'card-link') {
        const link = m.el.ownerDocument.createElement('a')
        link.href = 'https://example.invalid/fixture'; target.appendChild(link); target = link
        // A descendant that stops bubbling cannot steal a captured pan.
        link.addEventListener('pointerdown', event => event.stopPropagation())
        link.addEventListener('pointermove', event => event.stopPropagation())
        link.addEventListener('pointerup', event => event.stopPropagation())
      }
      const fire = (type: string, x: number, y: number) => inAct(() => {
        target.dispatchEvent(new W.PointerEvent(type, { bubbles: true, cancelable: true,
          button: 1, buttons: type === 'pointerup' ? 0 : 4, pointerId: 77, clientX: x, clientY: y }))
      })
      await fire('pointerdown', 800, 400)
      const down = new W.MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 1 })
      await inAct(() => target.dispatchEvent(down)); assert.equal(down.defaultPrevented, true)
      await fire('pointermove', 870, 445)
      await fire('pointerup', 870, 445)
      const aux = new W.MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 })
      await inAct(() => target.dispatchEvent(aux)); assert.equal(aux.defaultPrevented, true)
      const after = nums(space.style.transform)
      assert.deepEqual(after, [viewBefore[0]! + 70, viewBefore[1]! + 45, viewBefore[2]!])
      assertAt(at(m.el, 'x'), from, 'node position did not change')
      assert.deepEqual(m.ops, [], 'no move, reorder or action')
      assert.equal(m.el.querySelector('[data-move-ghost]'), null)
      await advance(400, 50)
      const saved = JSON.parse(localStorage.getItem('orgtree-view-mine')!)
      assert.deepEqual([saved.x, saved.y, saved.z], after)
      // A later move after release cannot continue the middle pan.
      await fire('pointermove', 940, 490)
      assert.deepEqual(nums(space.style.transform), after)
    })
  }
  test(`${mode}: stationary middle click and right press do not open a node or switchboard`, async t => {
    useFakeClock(); t.after(realClock)
    setChartLayout(mode); t.after(() => inAct(() => setChartLayout('row')))
    const m = await mountCanvas(t, before(), () => Promise.resolve({}))
    const space = m.el.querySelector<HTMLElement>('.space')!
    const initial = space.style.transform
    for (const target of [card(m.el, 'x')!, m.el.querySelector<HTMLElement>('.sq.user')!])
      for (const button of [1, 2]) for (const type of ['pointerdown', 'pointerup'])
        await inAct(() => target.dispatchEvent(new W.PointerEvent(type, {
          bubbles: true, cancelable: true, button, pointerId: 78, clientX: 800, clientY: 400,
        })))
    await advance(3000, 50)
    assert.equal(space.style.transform, initial)
    assert.deepEqual(m.ops, [])
  })
  test(`${mode}: left background pan keeps its original movement`, async t => {
    useFakeClock(); t.after(realClock)
    setChartLayout(mode); t.after(() => inAct(() => setChartLayout('row')))
    const m = await mountCanvas(t, before(), () => Promise.resolve({}))
    const viewport = m.el.querySelector<HTMLElement>('.viewport')!, space = m.el.querySelector<HTMLElement>('.space')!
    const beforeView = nums(space.style.transform)
    for (const [type, x, y] of [['pointerdown', 800, 400], ['pointermove', 850, 425], ['pointerup', 850, 425]] as const)
      await inAct(() => viewport.dispatchEvent(new W.PointerEvent(type, { bubbles: true, button: 0, pointerId: 79, clientX: x, clientY: y })))
    assert.deepEqual(nums(space.style.transform), [beforeView[0]! + 50, beforeView[1]! + 25, beforeView[2]!])
    assert.deepEqual(m.ops, [])
  })
}

for (const mode of ['row', 'circular'] as const) for (const onto of ['b', USER]) {
  test(`${mode}: reparent hover ghost matches final landing on ${onto}`, async t => {
    useFakeClock(); t.after(realClock)
    setChartLayout(mode); t.after(() => inAct(() => setChartLayout('row')))
    const initial = before()
    const destination = onto === USER ? null : onto
    const confirmed = withPendingMoves(initial, new Map([['x', destination]]))
    const want = await settledAt(t, confirmed, 'x')
    const m = await mountCanvas(t, initial, () => new Promise(() => {}))
    const from = at(m.el, 'x'), to = at(m.el, onto)
    const start = client(m.el, { x: from.x + NODE_W / 2, y: from.y + NODE_H / 2 })
    const end = client(m.el, { x: to.x + NODE_W / 2, y: to.y + NODE_H / 2 })
    const c = card(m.el, 'x')!
    const fire = (type: string, point: typeof start) => inAct(() => {
      c.dispatchEvent(new W.PointerEvent(type, { bubbles: true, button: 0, pointerId: 1, ...point }))
    })
    await fire('pointerdown', start)
    await fire('pointermove', end)
    await flush(2)
    const ghost = m.el.querySelector('[data-move-ghost]')!
    assert.ok(ghost, 'valid new-parent hover shows an outline')
    assert.equal(ghost.getAttribute('fill'), 'none')
    assert.equal(ghost.getAttribute('width'), String(NODE_W))
    assert.equal(ghost.getAttribute('height'), String(NODE_H))
    assert.equal(ghost.getAttribute('pointer-events'), 'none')
    const preview = { x: Number(ghost.getAttribute('x')), y: Number(ghost.getAttribute('y')) }
    assertAt(preview, want, 'hover predicts the confirmed tree, before any request')
    assert.equal(m.ops.length, 0)
    await fire('pointerup', end)
    await flush(2)
    assert.equal(m.el.querySelector('[data-move-ghost]'), null, 'drop removes outline')
    await advance(3000, 50)
    assertAt(at(m.el, 'x'), preview, 'animation ends at the ghost')
  })
}

for (const mode of ['row', 'circular'] as const) test(`${mode}: invalid hover, leave and Escape clear the ghost without a move`, async t => {
  useFakeClock(); t.after(realClock)
  setChartLayout(mode); t.after(() => inAct(() => setChartLayout('row')))
  const m = await mountCanvas(t, before(), () => Promise.resolve({}))
  const from = at(m.el, 'x'), child = at(m.el, 'xk'), target = at(m.el, 'b')
  const point = (p: typeof from) => client(m.el, { x: p.x + NODE_W / 2, y: p.y + NODE_H / 2 })
  const c = card(m.el, 'x')!
  const fire = (type: string, p: ReturnType<typeof point>) => inAct(() => {
    c.dispatchEvent(new W.PointerEvent(type, { bubbles: true, button: 0, pointerId: 1, ...p }))
  })
  await fire('pointerdown', point(from))
  await fire('pointermove', point(child)); await flush(2)
  assert.equal(m.el.querySelector('[data-move-ghost]'), null, 'descendant is invalid')
  await fire('pointermove', point(target)); await flush(2)
  assert.ok(m.el.querySelector('[data-move-ghost]'))
  await fire('pointermove', { clientX: 800, clientY: 850 }); await flush(2)
  assert.equal(m.el.querySelector('[data-move-ghost]'), null, 'leaving the target clears it')
  await fire('pointermove', point(target)); await flush(2)
  assert.ok(m.el.querySelector('[data-move-ghost]'))
  await inAct(() => m.el.ownerDocument.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
  assert.equal(m.el.querySelector('[data-move-ghost]'), null, 'Escape clears it')
  await fire('pointerup', point(target)); await flush(2)
  assert.deepEqual(m.ops, [], 'cancelled capture cannot commit on release')
  assertAt(at(m.el, 'x'), from, 'cancel restores the drag group')
})

for (const mode of ['row', 'circular'] as const) {
  for (const success of [true, false]) test(`${mode}: move ${success ? 'keeps its confirmed position (last, fresh order)' : 'rolls back on refusal'}`, async (t) => {
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
    assertAt(at(m.el, 'x'), want, 'pending move already sits where the engine will put it (last among its new siblings)')
    await inAct(() => (m.el.querySelector('.tray-toggle') as HTMLElement).click())
    await flush()
    const listOrder = () => [...m.el.querySelectorAll('.tray-row')]
      .map(row => row.getAttribute('data-copy-agent-name'))
    const movedOrder = ['old', 'target', 'left', 'right', 'x', 'child']
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

test('sibling reorder previews its slot while the reorder request is unresolved', async t => {
  useFakeClock(); t.after(realClock)
  setChartLayout('row'); t.after(() => inAct(() => setChartLayout('row')))
  const initial = tree([mkNode('boss', [mkNode('x'), mkNode('b'), mkNode('c')])])
  const confirmed = tree([mkNode('boss', [mkNode('b'), mkNode('c'), mkNode('x')])])
  const want = await settledAt(t, confirmed, 'x')
  const was = await settledAt(t, initial, 'x')
  const m = await mountCanvas(t, initial, async () => ({}))
  const fallback = globalThis.fetch
  const requests: unknown[] = []
  globalThis.fetch = (url, init) => {
    if (String(url).endsWith('/nodes/x/reorder')) {
      requests.push(JSON.parse(String(init?.body)))
      return new Promise(() => {})
    }
    return fallback(url, init)
  }
  const from = at(m.el, 'x'), last = at(m.el, 'c')
  const start = client(m.el, { x: from.x + NODE_W / 2, y: from.y + NODE_H / 2 })
  // Empty canvas beyond the final sibling: a reorder, not a reparent drop.
  const end = client(m.el, { x: last.x + NODE_W + 20, y: last.y + NODE_H / 2 })
  const source = card(m.el, 'x')!
  for (const [type, point] of [['pointerdown', start], ['pointermove', end], ['pointerup', end]] as const)
    await inAct(() => source.dispatchEvent(new W.PointerEvent(type, {
      bubbles: true, button: 0, pointerId: 1, ...point,
    })))
  assert.deepEqual(requests, [{ after: 'c' }], 'the real reorder route is held pending')
  assert.ok(!near(was, want), 'fixture changes the slot')
  await advance(3000, 50)
  assertAt(at(m.el, 'x'), want, 'pending reorder must animate into the new slot')
})

// Independent authoritative fixtures carry the midpoint key returned by Rust;
// the child subtree and the sibling with an unrelated change must survive.
const reorderTree = (last = false, root = false) => {
  const nodes = [
    { ...mkNode('x', [mkNode('child')]) as TreeNode, ui_order: last ? 3 : 0 },
    { ...mkNode('b') as TreeNode, ui_order: 1 },
    { ...mkNode('c') as TreeNode, ui_order: 2 },
  ]
  if (last) nodes.push(nodes.shift()!)
  return tree(root ? nodes : [mkNode('boss', nodes)])
}

function holdReorders() {
  const fallback = globalThis.fetch
  const calls: { body: unknown; yes: () => void; no: () => void }[] = []
  globalThis.fetch = (url, init) => {
    if (String(url).endsWith('/reorder')) return new Promise((resolve, reject) => {
      calls.push({ body: JSON.parse(String(init?.body)),
        yes: () => resolve(new Response('{}', { status: 200 })),
        no: () => reject(new Error('reorder refused')) })
    })
    return fallback(url, init)
  }
  return calls
}

async function dragSibling(el: HTMLElement, id: string, anchor: string,
  mode: 'row' | 'circular', side: 'before' | 'after' = 'after') {
  const from = at(el, id), dest = at(el, anchor)
  let endWorld = { x: dest.x + (side === 'after' ? NODE_W + 30 : -30), y: dest.y + NODE_H / 2 }
  if (mode === 'circular') {
    const eye = at(el, USER)
    const angle = Math.atan2(dest.y - eye.y, eye.x - dest.x) + (side === 'after' ? 0.1 : -0.1)
    const radius = Math.hypot(dest.x - eye.x, dest.y - eye.y) * 1.6
    endWorld = { x: eye.x - radius * Math.cos(angle) + NODE_W / 2,
      y: eye.y + radius * Math.sin(angle) + NODE_H / 2 }
  }
  const start = client(el, { x: from.x + NODE_W / 2, y: from.y + NODE_H / 2 })
  const end = client(el, endWorld), source = card(el, id)!
  for (const [type, point] of [['pointerdown', start], ['pointermove', end], ['pointerup', end]] as const)
    await inAct(() => { source.dispatchEvent(new W.PointerEvent(type, {
      bubbles: true, button: 0, pointerId: 1, ...point,
    })) })
  await flush(2)
}

for (const mode of ['row', 'circular'] as const) for (const success of [true, false])
  test(`${mode}: pending sibling reorder ${success ? 'confirms without jumping' : 'rolls back on refusal'}`, async t => {
    useFakeClock(); t.after(realClock)
    setChartLayout(mode); t.after(() => inAct(() => setChartLayout('row')))
    const initial = reorderTree(), confirmed = reorderTree(true)
    const want = await settledAt(t, confirmed, 'x'), was = await settledAt(t, initial, 'x')
    const child = await settledAt(t, confirmed, 'child')
    const m = await mountCanvas(t, initial, async () => ({})), calls = holdReorders()
    await dragSibling(m.el, 'x', 'c', mode)
    assert.deepEqual(calls.map(c => c.body), [{ after: 'c' }])
    await advance(3000, 50)
    assertAt(at(m.el, 'x'), want, 'unanswered request already has the final placement')
    assertAt(at(m.el, 'child'), child, 'subtree follows')
    await inAct(() => (m.el.querySelector('.tray-toggle') as HTMLElement).click())
    const list = () => [...m.el.querySelectorAll('.tray-row')].map(r => r.getAttribute('data-copy-agent-name'))
    assert.deepEqual(list(), ['boss', 'b', 'c', 'x', 'child'])
    // An agreeing pre-ack read must not drop the pending overlay: a subsequent
    // older snapshot can still arrive while the route is unresolved.
    await m.show(confirmed)
    await m.show(initial)
    await advance(1000, 50)
    assertAt(at(m.el, 'x'), want, 'stale read cannot cancel an unanswered operation')
    await inAct(() => { success ? calls[0]!.yes() : calls[0]!.no() })
    if (success) {
      await m.show(confirmed)
      assertAt(at(m.el, 'x'), want, 'confirmation keeps the current spring position')
      await advance(50, 10)
      assertAt(at(m.el, 'x'), want, 'confirmation never starts a return spring')
    }
    await advance(1000, 50)
    assertAt(at(m.el, 'x'), success ? want : was, 'route and authoritative tree reconcile')
    assert.deepEqual(list(), success ? ['boss', 'b', 'c', 'x', 'child'] : ['boss', 'x', 'child', 'b', 'c'])
    if (success) {
      await m.show(initial)
      await advance(1000, 50)
      assertAt(at(m.el, 'x'), was, 'a later authoritative reorder wins after confirmation')
    } else assert.ok(m.notices.some(n => n.lines[0]?.includes('reorder refused')))
  })

test('root reorder Undo previews at once and survives stale reads and the old fallback timer', async t => {
  useFakeClock(); t.after(realClock)
  const initial = reorderTree(false, true), confirmed = reorderTree(true, true)
  const was = await settledAt(t, initial, 'x')
  const m = await mountCanvas(t, initial, async () => ({})), calls = holdReorders()
  await dragSibling(m.el, 'x', 'c', 'row')
  await inAct(() => calls[0]!.yes())
  await advance(100, 50)
  const undo = m.notices.find(n => n.lines[0] === 'x reordered')?.undo
  assert.ok(undo)
  await inAct(() => { void undo() })
  assert.deepEqual(calls[1]!.body, { before: 'b' })
  await m.show(initial)
  await m.show(confirmed)
  await advance(6000, 50)
  assertAt(at(m.el, 'x'), was, 'old success timer and stale reads cannot end pending Undo')
  await inAct(() => calls[1]!.yes())
  await m.show(initial)
  await advance(1000, 50)
  assertAt(at(m.el, 'x'), was, 'Undo confirmation does not jump')
})

test('older refusal cannot cancel a later sibling drag; latest refusal follows the actual tree', async t => {
  useFakeClock(); t.after(realClock)
  const initial = reorderTree(), confirmed = reorderTree(true)
  const was = await settledAt(t, initial, 'x'), want = await settledAt(t, confirmed, 'x')
  const m = await mountCanvas(t, initial, async () => ({})), calls = holdReorders()
  await dragSibling(m.el, 'x', 'c', 'row')
  await advance(2000, 50)
  await dragSibling(m.el, 'x', 'b', 'row', 'before')
  assert.deepEqual(calls.map(c => c.body), [{ after: 'c' }, { before: 'b' }])
  await m.show(confirmed)
  await inAct(() => calls[0]!.no())
  await advance(2000, 50)
  assertAt(at(m.el, 'x'), was, 'older failure leaves newer preview intact')
  await inAct(() => calls[1]!.no())
  await advance(2000, 50)
  assertAt(at(m.el, 'x'), want, 'rollback uses current authoritative state')
})

test('reorder transform preserves unrelated branches and refuses vanished/moved anchors', () => {
  const initial = reorderTree()
  const entry = { parent: 'boss', block: ['x'], slot: { after: 'c' }, settled: false }
  const snapshot = JSON.stringify(initial)
  const preview = withPendingOrder(initial, entry)
  assert.deepEqual(preview.roots[0]!.children.map(n => n.id), ['b', 'c', 'x'])
  assert.equal(preview.roots[0]!.children[0], initial.roots[0]!.children[1])
  assert.equal(preview.roots[0]!.children[2]!.children, initial.roots[0]!.children[0]!.children)
  assert.equal(JSON.stringify(initial), snapshot)
  assert.equal(withPendingOrder(initial, { ...entry, slot: { after: 'missing' } }), initial)
  assert.equal(withPendingOrder(initial, { ...entry, parent: null }), initial)
  assert.equal(withPendingOrder(initial, { ...entry, block: ['missing'] }), initial)
  assert.equal(withPendingOrder(preview, entry), preview)
})

test('reorder midpoint retains archived interleaving and sequential block order', () => {
  const node = (id: string, order: number, state = 'live') => ({
    ...mkNode(id) as TreeNode, ui_order: order, state,
  })
  const initial = tree([node('x', -1), node('b', 0), node('retired', 0.5, 'archived'), node('c', 2)])
  const entry = { parent: null, block: ['x'], slot: { after: 'b' }, settled: false }
  const preview = withPendingOrder(initial, entry)
  assert.deepEqual(preview.roots.map(n => n.id), ['b', 'retired', 'x', 'c'])
  assert.equal(preview.roots[2]!.ui_order, 1, 'midpoint ignores archived neighbours, as Rust does')
  const block = withPendingOrder(initial, { ...entry, block: ['x', 'b'], slot: { after: 'c' } })
  assert.deepEqual(block.roots.map(n => n.id), ['retired', 'c', 'x', 'b'])
  assert.deepEqual(block.roots.slice(2).map(n => n.ui_order), [3, 4])
})

test('successful reorder with no matching refresh expires; pending reorders do not', async t => {
  useFakeClock(); t.after(realClock)
  const initial = reorderTree(), confirmed = reorderTree(true)
  const was = await settledAt(t, initial, 'x'), want = await settledAt(t, confirmed, 'x')
  const m = await mountCanvas(t, initial, async () => ({})), calls = holdReorders()
  await dragSibling(m.el, 'x', 'c', 'row')
  await advance(6000, 50)
  assertAt(at(m.el, 'x'), want, 'network latency cannot expire the preview')
  await inAct(() => calls[0]!.yes())
  await advance(1000, 50)
  assertAt(at(m.el, 'x'), want, 'success retains preview until matching refresh or fallback')
  await advance(6000, 50)
  assertAt(at(m.el, 'x'), was, 'bounded fallback yields to the current authoritative tree')
})
