import { FakeServer, flush, inAct, installFetch, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { agent, project, chain, retired, bunchTree } from './projectbunch-fixture'
import { canonPiles, pruneRetiredView, viewHidden, viewPiles } from '../src/canvas/canvaslayout'
import { flatten, layout, withDraftTree } from '../src/canvas/shared'
import { projectBunches } from '../src/canvas/projectbunch'
import { ProjectDesk } from '../src/canvas/projectdesk'
import { forgetDeskMemory } from '../src/canvas/desktabs'
import type { TreeNode } from '../src/types'

const rootOf = (nodes: TreeNode[]) => withDraftTree(bunchTree(nodes), null)
const memberIds = (nodes: TreeNode[], head: string) =>
  projectBunches(rootOf(nodes)).get(head)?.members.map(n => n.id)

for (const mode of ['row', 'circular'] as const) {
  test(`${mode}: retiring a project column preserves its bunch geometry and individual IDs`, () => {
    const live = rootOf([chain(5, [agent('worker')])])
    const archived = rootOf([retired(chain(5, [agent('worker')]))])
    const before = JSON.stringify(archived)
    assert.deepEqual(projectBunches(archived).get('project-1')?.members.map(n => n.id),
      ['project-1', 'project-2', 'project-3', 'project-4', 'project-5'])
    assert.deepEqual(layout(archived, new Map(), mode, true), layout(live, new Map(), mode, true),
      'archive state alone does not stretch a bunch back into a column')
    assert.equal(JSON.stringify(archived), before, 'archived structure and restore identities stay intact')
    const off = layout(archived, new Map(), mode, false)
    assert.notDeepEqual(layout(archived, new Map(), mode, true), off)
    assert.deepEqual(off, layout(live, new Map(), mode, false), 'Display opt-out keeps the old layout')
  })
}

test('only the selected retired pile front contributes a bunch; selecting another front changes the whole run', () => {
  const source = canonPiles(rootOf([agent('boss', [
    retired(chain(3, [agent('old-worker')], 'old')),
    retired(chain(5, [agent('new-worker')], 'new')),
  ])]))
  const map = flatten(source, {})
  for (const front of ['old', 'new']) {
    const piles = viewPiles(source, { 'boss|a': `${front}-1` }, false, false, new Set())
    const hidden = viewHidden(source, piles), groups = projectBunches(source, hidden, map)
    assert.equal(groups.size, front === 'old' ? 3 : 5)
    assert.equal(groups.get(`${front}-1`)?.members[0]?.id, `${front}-1`)
    assert.ok(!groups.has(`${front === 'old' ? 'new' : 'old'}-1`), 'buried chain never leaks out')
    assert.equal(piles.get('boss|a')?.total, 2, 'pile rows still name the two separate sibling roots')
  }
})

test('retired splits and intervening agents break runs, with independent bunches below', () => {
  const split = retired(chain(2, [
    chain(2, [agent('a')], 'left'), chain(2, [agent('b')], 'right'),
  ], 'upper'))
  assert.deepEqual(memberIds([split], 'upper-1'), ['upper-1', 'upper-2'])
  assert.deepEqual(memberIds([split], 'left-1'), ['left-1', 'left-2'])
  assert.deepEqual(memberIds([split], 'right-1'), ['right-1', 'right-2'])
  const middle = retired(chain(2, [agent('between', [chain(2, [agent('a')], 'lower')])], 'upper'))
  assert.deepEqual(memberIds([middle], 'upper-1'), ['upper-1', 'upper-2'])
  assert.deepEqual(memberIds([middle], 'lower-1'), ['lower-1', 'lower-2'])
  assert.equal(projectBunches(rootOf([retired(project('left')), retired(project('right'))])).size, 0)
})

test('partly restored columns retain the same physical bunch, without changing archived parent links', () => {
  const head = retired(chain(3, [agent('worker')]))
  head.state = 'live'
  head.children[0]!.children[0]!.state = 'live'
  assert.deepEqual(memberIds([head], 'project-1'), ['project-1', 'project-2', 'project-3'])
})

test('archive paging keeps branches unless the explicit hide-retired display projection excludes them', () => {
  const loaded = retired(chain(3, [agent('worker')]))
  const root = rootOf([loaded])
  const inner = root.children[0]!.children[0]!
  inner.hidden_retired_children = 900
  const groups = projectBunches(root)
  assert.deepEqual(groups.get('project-1')?.members.map(n => n.id), ['project-1', 'project-2'])
  assert.ok(!groups.has('project-3'), 'unloaded retired siblings break the column')

  const branching = rootOf([project('outer', [
    retired(project('old-side')), project('inner', [project('bottom')]),
  ])])
  const source = flatten(branching, {})
  const pruned = pruneRetiredView(branching, true, new Set()).root
  const visible = projectBunches(pruned, new Map(), source)
  assert.ok(!visible.has('outer'), 'hiding retired nodes does not join across their branch')
  assert.deepEqual(visible.get('inner')?.members.map(n => n.id), ['inner', 'bottom'])
  assert.deepEqual(projectBunches(pruned, new Map(), source, true).get('outer')?.members.map(n => n.id),
    ['outer', 'inner', 'bottom'], 'the hide-retired display setting excludes the archived side branch')
})

test('restoring the head or a member still names exactly that project, not the whole bunch', async t => {
  const previous = globalThis.fetch
  installFetch(new FakeServer())
  t.after(() => { globalThis.fetch = previous })
  const tree = bunchTree([retired(chain(3, [agent('worker')]))])
  const map = flatten(withDraftTree(tree, null), {})
  const requests: unknown[] = []
  for (const id of ['project-1', 'project-2']) {
    forgetDeskMemory()
    const view = await mountView(<ProjectDesk node={map.get(id)!} slug={tree.slug} tree={tree} map={map}
      op={async request => { requests.push(request); return {} as never }}
      toast={() => {}} refs={{ world: { org: tree.slug }, onOpen: () => {} } as never} />, el => el)
    t.after(() => view.unmount())
    await flush(2)
    const restore = view.el.querySelector<HTMLButtonElement>('button[data-action="restore"]')
    assert.ok(!!restore, `restore is available for ${id}`)
    await inAct(() => restore!.click())
    assert.deepEqual(requests.at(-1), { op: 'rehire', node: id })
    await view.unmount()
  }
})
