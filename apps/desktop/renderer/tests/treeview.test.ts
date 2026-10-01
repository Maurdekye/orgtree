import test from 'node:test'
import assert from 'node:assert/strict'
import { TreeViewReader } from '../src/treeview'
import { FOREGROUND_TREE_FORMAT, ForegroundControl, projectForeground } from '../src/foregroundtree'
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
    async get(_org: string, include: readonly string[] = [], fronts?: Readonly<Record<string, string>>) {
      calls.push(`get:${include.join(',')}${fronts ? `|piles:${JSON.stringify(fronts)}` : ''}`)
      if (fail) throw new Error('503 unavailable')
      // The server's pile resolution: the first retired root anchors the
      // pile, and the last is its front unless the saved front is a retiree.
      const edges = fronts ? [ids[0]!, ...(ids.includes(fronts[''] ?? '') ? [] : [ids[count - 1]!])] : []
      const chosen = ids.filter(id => include.includes(id) || edges.includes(id))
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
    assert.deepEqual(f.calls, ['get:|piles:{}'], 'one read; the server resolves every pile edge')
    assert.equal(f.legacy, 0)
    f.calls.length = 0
    await f.view.get('org', selection())
    assert.equal(f.calls.length, 1, 'unchanged catalog reuses current selection without rereading edges')
  }
  assert.deepEqual(sizes, [3, 3])
})

test('shown piles never fall back to the complete tree, however many piles there are (N1000 attempt 7b)', async () => {
  const f = fixture(1000)
  const got = await f.view.get('org', selection({ include: Array.from({ length: 100 }, (_, i) => `retired-${i + 1}`) }))
  assert.ok(got.snapshot, 'answered by the selected tree')
  assert.equal(f.legacy, 0)
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls.filter(c => c.startsWith('page:')).length, 0)
})

test('saved front is exact, missing saved front falls back, hide-retired excludes implicit edges', async () => {
  const f = fixture(20)
  const saved = await f.view.get('org', selection({ fronts: { '': 'retired-7' } }))
  assert.deepEqual(saved.snapshot!.roots, ['retired-0', 'live', 'retired-7'])
  assert.deepEqual(f.calls, ['get:retired-7|piles:{"":"retired-7"}'], 'the saved front travels with the read')
  const missing = await f.view.get('org', selection({ fronts: { '': 'gone' } }))
  assert.ok(missing.snapshot!.roots.includes('retired-19'))
  assert.deepEqual(missing.snapshot!.missing_requested, ['gone'])
  f.calls.length = 0
  const hidden = await f.view.get('org', selection({ hideRetired: true, include: ['retired-4'], fronts: { '': 'retired-7' } }))
  assert.deepEqual(hidden.snapshot!.roots, ['live', 'retired-4'])
  assert.deepEqual(f.calls, ['get:retired-4'], 'hidden retirees ask for no piles')
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

test('catalog churn during a browse retries coherently then uses whole compatibility answer; ordinary errors propagate', async () => {
  const f = fixture(20)
  f.reset()
  assert.equal((await f.view.get('org', selection({ browse: { kind: 'children', parent: '' } }))).snapshot, null)
  assert.equal(f.legacy, 1)
  assert.equal(f.calls.filter(c => c.startsWith('page:')).length, 2)
  const bad = fixture(20)
  bad.fail()
  await assert.rejects(bad.view.get('org', selection()), /503/)
  assert.equal(bad.legacy, 0)
})

test('changed catalog re-resolves piles on the server and keeps no old implicit fronts', async () => {
  const f = fixture(20)
  await f.view.get('org', selection({ include: ['retired-5'] }))
  const plan = await f.view.get('org', selection({ include: ['retired-0'] }))   // covered: keeps the plan
  assert.ok(plan.snapshot!.nodes['retired-5'])
  f.calls.length = 0
  f.setCatalog('c2')
  const fresh = await f.view.get('org', selection({ include: ['retired-0'] }))
  assert.deepEqual(f.calls, ['get:retired-5|piles:{}', 'get:retired-0|piles:{}'],
    'the old plan is re-read only to see the catalog moved, then only explicit targets are asked for')
  assert.equal(fresh.snapshot!.nodes['retired-5'], undefined, 'an old plan is not a source of retained rows')
  assert.equal(f.calls.filter(c => c.startsWith('page:')).length, 0)
})

test('a focus on an id the current plan already carries keeps the plan: one read, no edge re-plan (review f5)', async () => {
  const count = 20
  const ids = Array.from({ length: count }, (_, i) => `retired-${i}`)
  const calls: string[] = []
  const flat = (id: string) => ({ id, state: id === 'live' ? 'live' : 'archived', parent: null, axis: 'org',
    children: [], hidden_retired_children: 0, lineage_loaded: false, lineage_count: 0 })
  const reader = {
    async get(_org: string, include: readonly string[] = [], fronts?: Readonly<Record<string, string>>) {
      calls.push(`get:${[...include].sort().join(',')}`)
      const edges = fronts ? [ids[0]!, ids[count - 1]!] : []
      const chosen = ids.filter(id => include.includes(id) || edges.includes(id))
      const roots = [...chosen.filter(id => id === ids[0]), 'live', ...chosen.filter(id => id !== ids[0])]
      const snapshot = { format: FOREGROUND_TREE_FORMAT, kind: 'snapshot', revision: 'c1', catalog_revision: 'c1',
        org_rev: 1, sync_rev: 1, nodes: Object.fromEntries(roots.map(id => [id, flat(id)])), roots,
        missing_requested: include.filter(id => id !== 'live' && !ids.includes(id)),
        header: { slug: 'org', hidden_retired_roots: count - chosen.length, retired_total: count } } as unknown as ForegroundSnapshot
      return { snapshot, tree: projectForeground(snapshot) }
    },
    async page(_org: string, kind: 'children' | 'search', query: string, _c = '', _s?: string, limit = 100, edge?: 'last') {
      calls.push(`page:${kind}:${query}:${edge ?? 'first'}`)
      const matches = edge ? ids.slice(-1) : ids.slice(0, limit)
      return { format: FOREGROUND_TREE_FORMAT, kind: 'page', revision: 'c1', catalog_revision: 'c1', org_rev: 1,
        sync_rev: 1, nodes: Object.fromEntries(matches.map(id => [id, flat(id)])), matches, next_cursor: null } as unknown as ForegroundPage
    },
  }
  const view = new TreeViewReader(reader, async () => { throw new Error('no legacy') })
  const sel = (include: string[]): TreeSelection => ({ include, hideRetired: false, fronts: {} })
  await view.get('org', sel([]))
  for (const focus of [['live'], ['retired-19'], ['live', 'retired-0']]) {
    calls.length = 0
    const got = await view.get('org', sel(focus))
    assert.equal(calls.length, 1, `focus ${focus} re-planned: ${calls.join(' ')}`)
    assert.ok(focus.every(id => got.snapshot!.nodes[id]), 'and the focused cards are in the answer')
  }
  calls.length = 0
  await view.get('org', sel(['retired-7']))   // a genuinely omitted retiree still re-plans
  assert.ok(calls.some(c => c.includes('retired-7')), 'an uncovered id is still requested')
})
