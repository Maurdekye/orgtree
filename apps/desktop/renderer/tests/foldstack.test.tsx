// foldstack.test.tsx — the subtree fold has no button any more: a collapsed
// node (mini AND norm) shows its hidden subtree as up to three tucked shapes
// under its bottom edge, in each direct child's own colour; clicking the stack
// expands; collapsing is the node menu's "Collapse subtree"
// (@item:orgtree/subtree-fold-on-mini-nodes-replace-the-collapse-e, USER
// 2026-11-03 10:41:13Z mb215418dd87d + 10:41:26Z m580523a2f5d6).
// Run:  cd apps/desktop/renderer && node tests/run.mjs foldstack
import './testguard.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { agent, project, bunchTree } from './projectbunch-fixture'
import { withDraftTree } from '../src/canvas/shared'
import type { CanvasNode, OpResult } from '../src/canvas/shared'
import { pruneCollapsedView, subtreeFoldInfo } from '../src/canvas/subtreefold'
import type { FoldInfo } from '../src/canvas/subtreefold'
import { agentMenuEntries, projectMenuEntries } from '../src/canvas/agentmenu'
import { readFileSync } from 'node:fs'
import { join as joinPath } from 'node:path'
import { mountView } from './harness'
import { ProjectSquare } from '../src/canvas/projectcard'

declare const __SRC_DIR__: string
const rootOf = (nodes: Parameters<typeof bunchTree>[0]) =>
  withDraftTree(bunchTree(nodes), null) as CanvasNode
const noopFn = () => {}
const hireOffer = { enabled: true, installed: true, reason: null }

test('a collapsed node reports its first three direct children for the tucked stack', () => {
  const root = rootOf([agent('boss', [agent('a'), agent('b'), project('p', [agent('deep')]), agent('d')])])
  const v = pruneCollapsedView(root, new Set(['boss']))
  const info = subtreeFoldInfo(root, new Set(['boss']), v.summaries).get('boss')
  assert.deepEqual(info?.tucks?.map((t) => t.id), ['a', 'b', 'p'], 'three tucks at most, in child order')
  assert.equal(info?.tucks?.[2]?.project, true, 'a project child is marked so its theme colour is used')
  assert.equal(info?.count, 5, 'the hidden count still counts every hidden member')
})

test('a collapsed node with one child reports one tuck; an expanded node reports none', () => {
  const root = rootOf([agent('boss', [agent('only')]), agent('x', [agent('y')])])
  const v = pruneCollapsedView(root, new Set(['boss']))
  const m = subtreeFoldInfo(root, new Set(['boss']), v.summaries)
  assert.equal(m.get('boss')?.tucks?.length, 1)
  assert.deepEqual(m.get('x')?.tucks ?? [], [])
})

const fold = (over: Partial<FoldInfo> = {}): FoldInfo => ({
  collapsed: true, count: 4, working: false, attention: false,
  tucks: [{ id: 'a', project: false, tier: 'sonnet' }, { id: 'b', project: false, tier: 'sol' },
    { id: 'c', project: true }], ...over })
const mount = (lod: 'mini' | 'norm', f: FoldInfo, onToggle: () => void) =>
  mountView(<ProjectSquare node={project('proj-x', [agent('kid')]) as unknown as CanvasNode} pos={{ x: 0, y: 0 }} lod={lod}
    dragging={false} isDrop={false} op={() => Promise.resolve({} as OpResult)}
    slug="fold-stack" toast={noopFn} zoom={2} tree={bunchTree([project('proj-x')])}
    hire={{ claudeHire: hireOffer }} seats={{ sol: 1 }} fold={f} onToggleFold={onToggle}
    onHire={noopFn} onInbox={noopFn} onNewProject={noopFn}
    onDragStart={noopFn} onDragMove={noopFn} onDragEnd={noopFn} onDragCancel={noopFn} />, (el) => el)

for (const lod of ['mini', 'norm'] as const) {
  test(`${lod}: no fold button; a collapsed node shows the tucked stack, click expands`, async (t) => {
    let n = 0
    const v = await mount(lod, fold(), () => { n++ })
    t.after(() => v.unmount())
    assert.equal(v.el.querySelector('.sq-fold-mini, .badge.subtree-fold'), null, 'the chevron button is gone')
    const stack = v.el.querySelector<HTMLElement>('.fold-stack')
    assert.ok(stack, 'the stack is drawn')
    assert.equal(stack!.querySelectorAll('.fold-tuck').length, 3)
    assert.match(stack!.textContent ?? '', /4/, 'the hidden count rides with the stack')
    stack!.click()
    assert.equal(n, 1, 'one click runs the fold action')
  })
  test(`${lod}: an expanded node and a leaf show no stack and no button`, async (t) => {
    const v = await mount(lod, fold({ collapsed: false, count: 0, tucks: [] }), noopFn)
    t.after(() => v.unmount())
    assert.equal(v.el.querySelector('.fold-stack, .sq-fold-mini, .badge.subtree-fold'), null)
  })
  test(`${lod}: the stack wears the hidden rollup`, async (t) => {
    const v = await mount(lod, fold({ working: true, attention: true }), noopFn)
    t.after(() => v.unmount())
    const stack = v.el.querySelector('.fold-stack')!
    assert.ok(stack.classList.contains('working') && stack.classList.contains('attention'))
  })
}

test('the node menus carry Collapse / Expand subtree', () => {
  const labels = (entries: ReturnType<typeof agentMenuEntries>) =>
    JSON.stringify(entries)
  for (const [mk, node] of [[agentMenuEntries, agent('a', [agent('k')])], [projectMenuEntries, project('p', [agent('k')])]] as const) {
    const n = node as unknown as CanvasNode
    const open = labels(mk(n, { onInbox: noopFn, onToggleFold: noopFn, foldCollapsed: false }))
    assert.match(open, /Collapse subtree/)
    const shut = labels(mk(n, { onInbox: noopFn, onToggleFold: noopFn, foldCollapsed: true }))
    assert.match(shut, /Expand subtree/)
    assert.doesNotMatch(labels(mk(n, { onInbox: noopFn })), /subtree/, 'no fold handler, no entry')
  }
})

test('the peek fits the 8px clearance under a node (projectbunch card + 8)', () => {
  const css = readFileSync(joinPath(__SRC_DIR__, 'styles.css'), 'utf8')
  const stack = css.slice(css.indexOf('.fold-stack {'), css.indexOf('}', css.indexOf('.fold-stack {')))
  assert.match(stack, /top:\s*100%/)
  assert.match(stack, /height:\s*8px/, 'the stack ends within the 8px gap')
  assert.doesNotMatch(stack, /margin-top:\s*-/, 'it never starts above the node edge')
  const tuck = css.slice(css.indexOf('.fold-tuck {'), css.indexOf('}', css.indexOf('.fold-tuck {')))
  assert.match(tuck, /height:\s*calc\(8px/, 'no tuck is taller than the gap')
  assert.doesNotMatch(tuck, /translateY/, 'and none is pushed below it')
})
