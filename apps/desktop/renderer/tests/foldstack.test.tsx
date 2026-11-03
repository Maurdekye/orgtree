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

const sheet = () => readFileSync(joinPath(__SRC_DIR__, 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
const rule = (css: string, sel: string) => { const at = css.indexOf(sel + ' {'); assert.ok(at >= 0, sel + ' exists'); return css.slice(at, css.indexOf('}', at)) }

test('the tucked stack is drawn like the retired pile, offset straight DOWN (USER m05ca05916042)', () => {
  const css = sheet()
  const pile = rule(css, '.pile-layer')
  const pileRadius = /border-radius:\s*(\d+)px/.exec(pile)![1]
  const pileStep = Number(/translate\((\d+)px, -px\)/.exec(rule(css, '.pile-layer.l1'))![1])
  const tuck = rule(css, '.fold-tuck')
  assert.match(tuck, new RegExp(`border-radius:\s*0 0 ${pileRadius}px ${pileRadius}px`), 'the pile corner radius, bottom corners (the part below the card)')
  assert.match(tuck, /border:\s*1px solid var\(--line-soft\)/, 'the pile border')
  assert.match(tuck, /width:\s*100%/, 'the node own silhouette: same width, not a narrower strip')
  assert.doesNotMatch(tuck, /translateX|left:\s*50%/, 'no sideways offset: straight down')
  const h = /height:\s*calc\(var\(--fold-step\) \* \(var\(--tuck-i, 0\) \+ 1\)\)/.exec(tuck)
  assert.ok(h, 'each layer reaches one more step lower')
  assert.equal(Number(/--fold-step:\s*(\d+)px/.exec(rule(css, '.fold-stack'))![1]), pileStep, 'the pile own spacing')
  for (const [i, n] of [[0, 1], [1, 2], [2, 3]] as const)
    assert.match(rule(css, `.fold-tuck.t${i}`), new RegExp(`background:\s*var\(--pile-${n}\)`), `layer ${n} wears the pile fill ${n}`)
  const z = /z-index:\s*calc\((\d+) - var\(--tuck-i, 0\)\)/.exec(tuck)
  assert.ok(z, 'the shallow layer draws in front of the deeper ones')
  assert.match(rule(css, '.fold-stack .fold-count'), /font-family:\s*var\(--mono\)[^}]*font-weight:\s*700|font-weight:\s*700[^}]*font-family:\s*var\(--mono\)/, 'the pile count style')
})

test('the stack never has more than the pile three layers', async () => {
  const v = await mount('norm', fold({ count: 9, tucks: Array.from({ length: 5 }, (_, i) => ({ id: 'k' + i, project: false, tier: 'sonnet' })) }), noopFn)
  assert.ok(v.el.querySelectorAll('.fold-tuck').length <= 3)
  assert.ok(v.el.querySelector('.fold-tuck.t0'), 'layers carry t0..t2 for the pile fills')
})

test('the bottom hire strip clears the stack so a click on the stack reaches it', () => {
  const css = readFileSync(joinPath(__SRC_DIR__, 'styles.css'), 'utf8')
  const rule = /\.sq:has\(> \.fold-stack\) > \.hsof:not\(\.side\) \{ top: calc\(100% \+ (\d+)px\); \}/.exec(css)
  assert.ok(rule, 'a folded node pushes its bottom hire strip down')
  assert.ok(Number(rule![1]) >= 14, 'at least past the 15px stack minus the strip own 1px overlap')
  assert.match(css, /\.hsof \{\s*position: absolute; left: 50%;/, 'and the base strip rule it overrides still exists')
  // specificity (.sq + :has(.fold-stack) + .hsof + :not) beats the base .hsof rule wherever it sits
})
