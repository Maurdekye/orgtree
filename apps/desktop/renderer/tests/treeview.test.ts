import test from 'node:test'
import assert from 'node:assert/strict'
import { TreeViewReader } from '../src/treeview'
import { ForegroundControl, projectForeground } from '../src/foregroundtree'
import type { FlatTreeNode, ForegroundSnapshot, ForegroundPage } from '../src/foregroundtree'
import type { TreeSelection } from '../src/treeview'
import type { TreePayload } from '../src/types'

const selection = (patch: Partial<TreeSelection> = {}): TreeSelection => ({ include: [], hideRetired: false, fronts: {}, ...patch })
function fixture(count: number) {
  const ids = Array.from({ length: count }, (_, i) => `retired-${i}`)
  const calls: string[] = []
  let catalog = 'c1', resets = false, fail = false, legacy = 0
  const node = (id: string): FlatTreeNode => ({ id, state: id === 'live' ? 'live' : 'archived',
    parent: null, axis: 'org', children: [], hidden_retired_children: 0,
    lineage_loaded: false, lineage_count: 0 } as FlatTreeNode)
  const reader = {
    async get(_org: string, include: readonly string[] = []) {
      calls.push(`get:${include.join(',')}`)
      const chosen = ids.filter(id => include.includes(id))
      // First archived sibling precedes a live sibling; the default front is
      // later. The canvas needs both identities to preserve pile placement.
      const roots = [...chosen.filter(id => id === ids[0]), 'live', ...chosen.filter(id => id !== ids[0])]
      const snapshot = { format: 'orgtree.foreground-tree/v1', kind: 'snapshot', revision: catalog,
        catalog_revision: catalog, org_rev: 1, sync_rev: 1,
        nodes: Object.fromEntries(roots.map(id => [id, node(id)])), roots,
        missing_requested: include.filter(id => id !== 'live' && !ids.includes(id)),
        header: { slug: 'org', hidden_retired_roots: count - chosen.length, retired_total: count },
      } as ForegroundSnapshot
      return { snapshot, tree: projectForeground(snapshot) }
    },
    async page(_org: string, kind: 'children' | 'search', query: string, cursor = '', _state?: string, limit = 100, edge?: 'last') {
      calls.push(`page:${kind}:${query}:${cursor}:${limit}:${edge ?? 'first'}`)
      if (fail) throw new Error('503 unavailable')
      if (resets) throw new ForegroundControl('reset')
      const offset = cursor ? Number(cursor) : 0
      const matches = edge ? ids.slice(-1) : ids.slice(offset, offset + limit)
      return { format: 'orgtree.foreground-tree/v1', kind: 'page', revision: catalog,
        catalog_revision: catalog, org_rev: 1, sync_rev: 1,
        nodes: Object.fromEntries(matches.map(id => [id, node(id)])), matches,
        next_cursor: edge || offset + limit >= count ? null : String(offset + limit),
      } as ForegroundPage
    },
  }
  const view = new TreeViewReader(reader, async () => {
    legacy++
    return { slug: 'org', roots: ids.map(node) } as unknown as TreePayload
  })
  return { view, calls, get legacy() { return legacy }, setCatalog: (value: string) => { catalog = value },
    reset: () => { resets = true }, fail: () => { fail = true } }
}

test('collapsed view keeps first sibling position and last sibling front with flat tenfold history cost', async () => {
  const sizes: number[] = []
  for (const count of [20, 200]) {
    const f = fixture(count)
    const got = await f.view.get('org', selection())
    assert.deepEqual(got.snapshot!.roots, ['retired-0', 'live', `retired-${count - 1}`])
    assert.equal(got.snapshot!.header.hidden_retired_roots, count - 2)
    sizes.push(Object.keys(got.snapshot!.nodes).length)
    assert.equal(f.calls.filter(c => c.startsWith('page:')).length, 2)
    assert.equal(f.legacy, 0)
    f.calls.length = 0
    await f.view.get('org', selection())
    assert.equal(f.calls.length, 1, 'unchanged catalog reuses current selection without rereading edges')
  }
  assert.deepEqual(sizes, [3, 3])
})

test('saved front is exact, missing saved front falls back, hide-retired excludes implicit edges', async () => {
  const f = fixture(20)
  const saved = await f.view.get('org', selection({ fronts: { '': 'retired-7' } }))
  assert.deepEqual(saved.snapshot!.roots, ['retired-0', 'live', 'retired-7'])
  assert.ok(!f.calls.some(c => c.endsWith(':last')))
  const missing = await f.view.get('org', selection({ fronts: { '': 'gone' } }))
  assert.ok(missing.snapshot!.roots.includes('retired-19'))
  assert.deepEqual(missing.snapshot!.missing_requested, ['gone'])
  f.calls.length = 0
  const hidden = await f.view.get('org', selection({ hideRetired: true, include: ['retired-4'], fronts: { '': 'retired-7' } }))
  assert.deepEqual(hidden.snapshot!.roots, ['live', 'retired-4'])
  assert.equal(f.calls.filter(c => c.startsWith('page:')).length, 0)
})

test('explicit pile browser loads coherent identities then closing releases them', async () => {
  const f = fixture(120)
  const open = await f.view.get('org', selection({ browse: { kind: 'children', parent: '' } }))
  assert.equal(Object.keys(open.snapshot!.nodes).length, 121)
  assert.ok(f.calls.some(c => c.includes(':100:100:')))
  const closed = await f.view.get('org', selection())
  assert.equal(Object.keys(closed.snapshot!.nodes).length, 3)
  const larger = fixture(200)
  assert.equal((await larger.view.get('org', selection({ browse: { kind: 'children', parent: '' } }))).snapshot, null)
  assert.equal(larger.legacy, 1, 'explicit surface beyond128 keeps every identity via whole legacy read')
})

test('catalog churn retries coherently then uses whole compatibility answer; ordinary errors propagate', async () => {
  const f = fixture(20)
  f.reset()
  assert.equal((await f.view.get('org', selection())).snapshot, null)
  assert.equal(f.legacy, 1)
  assert.equal(f.calls.filter(c => c.startsWith('page:')).length, 2)
  const bad = fixture(20)
  bad.fail()
  await assert.rejects(bad.view.get('org', selection()), /503/)
  assert.equal(bad.legacy, 0)
})

test('changed catalog invalidates old implicit fronts before recomputing visible branches', async () => {
  const f = fixture(20)
  await f.view.get('org', selection())
  f.calls.length = 0
  f.setCatalog('c2')
  await f.view.get('org', selection())
  assert.ok(f.calls[0]!.startsWith('get:retired-0,retired-19'))
  assert.equal(f.calls[1], 'get:', 'old fronts are not a source of retained historical branches')
  assert.equal(f.calls.filter(c => c.startsWith('page:')).length, 2)
})
