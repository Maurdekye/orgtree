import test from 'node:test'
import assert from 'node:assert/strict'
import { agent, project, chain, retired, bunchTree } from './projectbunch-fixture'
import { canonPiles, pruneRetiredView, viewHidden, viewPiles, canvasTargets } from '../src/canvas/canvaslayout'
import { flatten, layout, withDraftTree, withPendingMoves } from '../src/canvas/shared'
import { projectBunches } from '../src/canvas/projectbunch'
import { moveGhostOffset } from '../src/canvas/moveghost'
import type { CanvasNode } from '../src/canvas/shared'

const rootOf = (nodes: ReturnType<typeof project>[]) => withDraftTree(bunchTree(nodes), null)
const ids = (root: CanvasNode, source: Map<string, CanvasNode>, hide = true) =>
  projectBunches(root, new Map(), source, hide).get('project-1')?.members.map(n => n.id)

for (const mode of ['row', 'circular'] as const) for (const countOnly of [false, true]) {
  test(`${mode}: ${countOnly ? 'count-only' : 'loaded'} hidden retired children do not split a live project bunch`, () => {
    const full = rootOf([chain(3, [agent('worker')])]), head = full.children[0]!
    if (countOnly) head.hidden_retired_children = 1
    else head.children.push(retired(agent('retired-side')))
    const before = JSON.stringify(full), source = flatten(full, {})
    const pruned = pruneRetiredView(full, true, new Set())
    assert.deepEqual(ids(pruned.root, source), ['project-1', 'project-2', 'project-3'])
    assert.deepEqual(layout(pruned.root, new Map(), mode, true, source, true),
      layout(rootOf([chain(3, [agent('worker')])]), new Map(), mode, true),
      'same bunch geometry as the visible chain without hidden retirees')
    assert.deepEqual(layout(pruned.root, new Map(), mode, false, source, true),
      layout(pruned.root, new Map(), mode, false, source, false), 'Display opt-out unchanged')
    if (!countOnly) assert.equal(pruned.retiredByParent.get('project-1')?.[0]?.id, 'retired-side')
    assert.equal(JSON.stringify(full), before, 'no parent, retiree or count mutation')
  })
}

test('shown retirees, bearers and archived parents with live descendants remain real branch breaks', () => {
  for (const kind of ['revealed', 'bearer', 'live-descendant'] as const) {
    const full = rootOf([chain(3)]), side = retired(agent('retired-side')) as CanvasNode
    if (kind === 'bearer') side.isBearerOf = 'worker-a'
    if (kind === 'live-descendant') side.children.push(agent('still-live') as CanvasNode)
    full.children[0]!.children.push(side)
    const shown = new Set(kind === 'revealed' ? [side.id] : [])
    const pruned = pruneRetiredView(full, true, shown), source = flatten(full, {})
    assert.equal(ids(pruned.root, source), undefined, kind)
    assert.equal(projectBunches(pruned.root, new Map(), source, true).get('project-2')?.members.length, 2)
  }
})

test('retirees shown globally and branches buried in a pile still break a bunch', () => {
  const full = canonPiles(rootOf([project('project-1', [
    chain(2, [agent('worker')], 'lower'), retired(project('old-a')), retired(project('old-b')),
  ])]))
  full.children[0]!.hidden_retired_children = 20
  const source = flatten(full, {}), visible = pruneRetiredView(full, false, new Set()).root
  const hidden = viewHidden(visible, viewPiles(visible, {}, false, false, new Set()))
  assert.ok(hidden.has('old-a'))
  assert.equal(projectBunches(visible, hidden, source, false).has('project-1'), false)
  assert.equal(projectBunches(visible, hidden, source, false).get('lower-1')?.members.length, 2)
  const pruned = pruneRetiredView(full, true, new Set()).root
  assert.deepEqual(projectBunches(pruned, new Map(), source, true).get('project-1')?.members.map(n => n.id),
    ['project-1', 'lower-1', 'lower-2'])
})

test('ordinary reparent landing ghosts use the same hidden-retiree bunch projection', () => {
  const head = chain(3, [agent('worker')])
  head.children.push(retired(agent('retired-side')))
  const tree = bunchTree([head, agent('moving')])
  const next = withPendingMoves(tree, new Map([['moving', 'project-3']]))
  const full = canonPiles(withDraftTree(next, null)), source = flatten(full, {})
  const root = pruneRetiredView(full, true, new Set()).root
  const targets = canvasTargets(root, source, new Map(), 'row', tree, 1, undefined, true, true)
  const moved = targets.get('moving')!, superior = targets.get('project-3')!
  const expected = { x: moved.x - superior.x, y: moved.y - superior.y }
  const actual = moveGhostOffset(tree, new Map(), new Map(), 'moving', 'project-3', {
    draft: null, seats: {}, pileFront: {}, crowdPiles: false, hideRetired: true,
    shownRetired: new Set(), chartLayout: 'row', inboxPxc: 1, bunchProjects: true,
  })
  assert.deepEqual(actual, expected)
  assert.deepEqual(ids(root, source), ['project-1', 'project-2', 'project-3'])
})
