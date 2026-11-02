// subtreefold.test.tsx — expand/collapse an agent's or project's subtree on
// the canvas (user 2026-10-28 backlog; liaison spec 2026-11-01). A chevron
// on every agent or project that has members folds its whole subtree away;
// the collapsed node shows the hidden count, summarises hidden members'
// working state and never hides their attention. The state is per-org
// display state — the prune touches the LAYOUT tree only, never the data
// (the pruneRetiredView precedent).
//
// This is the pure layer: what hides, what the collapsed node reports, that
// the layout reflows over the pruned tree in both chart layouts, and the
// per-org persisted set's parsing and toggling.
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs subtreefold
import './testguard.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { agent, project, bunchTree } from './projectbunch-fixture'
import { layout, withDraftTree } from '../src/canvas/shared'
import type { CanvasNode } from '../src/canvas/shared'
import {
  pruneCollapsedView, parseCollapsedSubtrees, collapsedSubtreesKey,
  getCollapsedSubtrees, toggleCollapsedSubtree, expandCollapsedSubtrees,
} from '../src/canvas/subtreefold'
import type { FoldInfo } from '../src/canvas/subtreefold'
import { readFileSync } from 'node:fs'
import { join as joinPath } from 'node:path'
import { mountView } from './harness'
import { ProjectSquare } from '../src/canvas/projectcard'
import type { OpResult } from '../src/canvas/shared'

declare const __SRC_DIR__: string

const patch = (n: CanvasNode, p: Partial<CanvasNode>): CanvasNode =>
  Object.assign(n as unknown as Record<string, unknown>, p) as unknown as CanvasNode
const rootOf = (nodes: Parameters<typeof bunchTree>[0]) =>
  withDraftTree(bunchTree(nodes), null) as CanvasNode
const kidNames = (n?: CanvasNode) => (n?.children ?? []).map((c) => c.id)
const find = (root: CanvasNode, id: string): CanvasNode | undefined => {
  if (root.id === id) return root
  for (const c of root.children ?? []) { const hit = find(c, id); if (hit) return hit }
  return undefined
}

const tree = () => rootOf([
  agent('boss', [
    agent('lead', [agent('worker-a'), agent('worker-b')]),
    project('proj', [agent('inside')]),
  ]),
  agent('other', [agent('other-kid')]),
])

test('collapsing a node hides its whole subtree and reports every hidden member', () => {
  const v = pruneCollapsedView(tree(), new Set(['boss']))
  assert.deepEqual(kidNames(find(v.root, 'boss')), [],
    'the collapsed node keeps no visible children')
  assert.deepEqual(kidNames(find(v.root, 'other')), ['other-kid'],
    'a sibling subtree is untouched')
  assert.deepEqual([...v.prunedIds].sort(),
    ['inside', 'lead', 'proj', 'worker-a', 'worker-b'],
    'every descendant is pruned, projects included')
  const s = v.summaries.get('boss')
  assert.equal(s?.count, 5, 'the count is every hidden member, not just children')
  assert.equal(s?.working, false)
  assert.equal(s?.attention, false)
  for (const id of v.prunedIds) assert.equal(v.hiddenBy.get(id), 'boss',
    'each hidden member maps to the collapsed node that stands for it')
})

test('a project folds exactly like an agent', () => {
  const v = pruneCollapsedView(tree(), new Set(['proj']))
  assert.deepEqual(kidNames(find(v.root, 'proj')), [])
  assert.deepEqual([...v.prunedIds], ['inside'])
  assert.equal(v.summaries.get('proj')?.count, 1)
  assert.deepEqual(kidNames(find(v.root, 'boss')), ['lead', 'proj'])
})

test('nothing collapsed passes the tree through untouched; a leaf in the set changes nothing', () => {
  const full = tree()
  const none = pruneCollapsedView(full, new Set())
  assert.equal(none.root, full)
  assert.equal(none.prunedIds.size, 0)
  assert.equal(none.summaries.size, 0)
  const leaf = pruneCollapsedView(full, new Set(['worker-a', 'inside']))
  assert.equal(leaf.prunedIds.size, 0, 'a memberless node hides nothing')
  assert.equal(leaf.summaries.size, 0)
})

test('a collapsed node inside a collapsed subtree stays folded under the outer one', () => {
  const both = pruneCollapsedView(tree(), new Set(['boss', 'lead']))
  assert.equal(both.summaries.get('boss')?.count, 5,
    'the outer node counts the whole hidden subtree once')
  assert.equal(both.summaries.has('lead'), false,
    'the inner node is hidden itself, so it reports nothing')
  for (const id of both.prunedIds) assert.equal(both.hiddenBy.get(id), 'boss')
  const innerOnly = pruneCollapsedView(tree(), new Set(['lead']))
  assert.equal(innerOnly.summaries.get('lead')?.count, 2,
    'expanding the outer node leaves the inner fold in place')
  assert.deepEqual(kidNames(find(innerOnly.root, 'lead')), [])
})

test('the summary summarises hidden members: mid-turn is working, an open question is attention', () => {
  const full = tree()
  patch(find(full, 'worker-a')!, { busy: true })
  patch(find(full, 'inside')!, { ask: { id: 'q1', status: 'open' } as CanvasNode['ask'] })
  const v = pruneCollapsedView(full, new Set(['boss']))
  assert.equal(v.summaries.get('boss')?.working, true,
    'a hidden member mid-turn makes the collapsed node working')
  assert.equal(v.summaries.get('boss')?.attention, true,
    'collapsing never hides attention: a hidden open question surfaces')

  const compacting = tree()
  patch(find(compacting, 'worker-b')!, { phase: 'compacting' })
  assert.equal(pruneCollapsedView(compacting, new Set(['boss']))
    .summaries.get('boss')?.working, true, 'compacting is mid-turn work too')

  const answered = tree()
  patch(find(answered, 'worker-a')!, { ask: { id: 'q2', status: 'answered' } as CanvasNode['ask'] })
  patch(find(answered, 'worker-b')!, { waiting: true })
  const av = pruneCollapsedView(answered, new Set(['boss']))
  assert.equal(av.summaries.get('boss')?.attention, false,
    'an answered question needs no attention')
  assert.equal(av.summaries.get('boss')?.working, false,
    'queued behind a turn slot is not mid-turn yet')
})

test('a knowledge bearer is never folded away (the hide-retired rule)', () => {
  const full = tree()
  patch(find(full, 'worker-a')!, { isBearerOf: 'other-kid' })
  const v = pruneCollapsedView(full, new Set(['boss']))
  assert.equal(v.prunedIds.has('worker-a'), false,
    'its floating card is an active consultation surface beside its successor')
  assert.equal(v.hiddenBy.has('worker-a'), false)
  assert.equal(v.summaries.get('boss')?.count, 4,
    'and the hidden count does not claim it')
  assert.deepEqual(kidNames(find(v.root, 'boss')), [],
    'it still takes no layout slot: bearers float, they never did')
})

test('the attention predicate is the caller\'s (unseen mentions ride the same rollup)', () => {
  const v = pruneCollapsedView(tree(), new Set(['boss']),
    (n) => n.id === 'worker-b')
  assert.equal(v.summaries.get('boss')?.attention, true)
})

for (const mode of ['row', 'circular'] as const) {
  test(`${mode}: the layout reflows to close the gap a folded subtree leaves`, () => {
    const full = tree()
    const open = layout(full, new Map(), mode, false)
    const folded = pruneCollapsedView(full, new Set(['boss']))
    const shut = layout(folded.root, new Map(), mode, false)
    for (const id of folded.prunedIds) assert.equal(shut.has(id), false,
      `${id} takes no canvas space while folded`)
    const bare = rootOf([agent('boss'), agent('other', [agent('other-kid')])])
    assert.deepEqual(shut.get('other'), layout(bare, new Map(), mode, false).get('other'),
      'the sibling subtree closes up exactly as if the folded members were not there')
    assert.notDeepEqual(shut.get('other'), open.get('other'),
      'and that is a real move from the unfolded layout')
  })
}

test('the per-org set parses defensively and keys by org', () => {
  assert.equal(collapsedSubtreesKey('my-org'), 'orgtree-collapsed-my-org')
  assert.deepEqual([...parseCollapsedSubtrees('["a","b"]')], ['a', 'b'])
  assert.deepEqual([...parseCollapsedSubtrees('["a",3,null,"a"]')], ['a'],
    'non-strings drop, duplicates collapse')
  for (const raw of [null, '', 'nope', '{}', '42'])
    assert.equal(parseCollapsedSubtrees(raw).size, 0, `bad saved state is empty, not fatal: ${raw}`)
})

test('toggling and expanding update the org\'s set; other orgs are independent', () => {
  const slug = 'fold-test-org'
  assert.equal(getCollapsedSubtrees(slug).size, 0)
  toggleCollapsedSubtree(slug, 'boss')
  toggleCollapsedSubtree(slug, 'lead')
  assert.deepEqual([...getCollapsedSubtrees(slug)].sort(), ['boss', 'lead'])
  assert.equal(getCollapsedSubtrees('fold-test-other-org').size, 0,
    'the set is per org')
  toggleCollapsedSubtree(slug, 'boss')
  assert.deepEqual([...getCollapsedSubtrees(slug)], ['lead'],
    'toggling a folded node expands it; a nested fold survives')
  expandCollapsedSubtrees(slug, ['lead', 'never-folded'])
  assert.equal(getCollapsedSubtrees(slug).size, 0,
    'expanding removes exactly the named folds')
})

// ------------------------------------------------- the project card's rollup
// The 2026-11-02 Session 0 capture bounce: a folded PROJECT with a hidden
// member mid-turn was invisible in both forms — .sq.project.norm outranks
// .sq.busy in the cascade, and the mini node drew its folder regardless.
// The DOM half is asserted here; the cascade half can only be read off the
// stylesheet (jsdom applies no real cascade), as orginboxplace reads it.
const noopFn = () => {}
const hireOffer = { enabled: true, installed: true, reason: null }
const FOLDED_WORKING: FoldInfo = { collapsed: true, count: 4, working: true, attention: false }
const FOLDED_IDLE: FoldInfo = { collapsed: true, count: 4, working: false, attention: false }
const projectSquare = (lod: 'norm' | 'mini', fold: FoldInfo) => {
  const node = patch(project('proj-x', [agent('kid')]) as unknown as CanvasNode,
    { busy: false, occupancy: 0, context_window: 1000 })
  return mountView(<ProjectSquare node={node} pos={{ x: 0, y: 0 }} lod={lod}
    dragging={false} isDrop={false} op={() => Promise.resolve({} as OpResult)}
    slug="fold-test" toast={noopFn} zoom={2} tree={bunchTree([project('proj-x')])}
    hire={{ claudeHire: hireOffer }} seats={{ sol: 1 }} fold={fold} onToggleFold={noopFn}
    onHire={noopFn} onInbox={noopFn} onNewProject={noopFn}
    onDragStart={noopFn} onDragMove={noopFn} onDragEnd={noopFn} onDragCancel={noopFn} />, (el) => el)
}
const hasActiveSpinner = (el: HTMLElement): boolean => {
  const icon = el.querySelector('.sq-far-icon.active')
  return !!icon && icon.querySelector('title')?.textContent === 'Active'
}

test('a folded project at far zoom shows Active while a hidden member works, its folder while none does', async (t) => {
  const working = await projectSquare('mini', FOLDED_WORKING)
  t.after(() => working.unmount())
  assert.equal(hasActiveSpinner(working.el), true,
    'the mini project wears the agent mini node\'s Active spinner, not only its folder')
  assert.equal(working.el.querySelector('.sq.project')?.classList.contains('busy'), true)
  const idle = await projectSquare('mini', FOLDED_IDLE)
  t.after(() => idle.unmount())
  assert.equal(hasActiveSpinner(idle.el), false)
  assert.ok(idle.el.querySelector('.project-mini svg'), 'idle keeps the folder')
})

test('the busy border outranks the project norm border in the stylesheet', () => {
  const css = readFileSync(joinPath(__SRC_DIR__, 'styles.css'), 'utf8')
  const norm = css.indexOf('.sq.project.norm {')
  const busy = css.indexOf('.sq.project.busy {')
  assert.ok(norm >= 0 && busy > norm,
    'a .sq.project.busy rule follows .sq.project.norm, so equal specificity resolves to busy')
  assert.match(css.slice(busy, busy + 120), /border-color:\s*color-mix\(in srgb, var\(--accent\) 55%/,
    'and it is the same busy border an agent card wears')
})
