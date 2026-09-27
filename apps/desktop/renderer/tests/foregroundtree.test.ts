import test from 'node:test'
import assert from 'node:assert/strict'
import { FOREGROUND_TREE_FORMAT as format, decodeForeground, projectForeground,
  ForegroundTreeReader, ForegroundControl } from '../src/foregroundtree'
import type { ForegroundSnapshot, ForegroundDelta, FlatTreeNode } from '../src/foregroundtree'
import type { TreePayload } from '../src/types'

const node = (id: string, patch = {}): FlatTreeNode => ({
  id, parent: null, children: [], axis: 'org', state: 'live',
  hidden_retired_children: 0, lineage_loaded: false, lineage_count: 0,
  predecessor: null, successor: null, ...patch,
} as FlatTreeNode)
const snapshot = (patch = {}): ForegroundSnapshot => ({
  format, kind: 'snapshot', revision: 'r1', catalog_revision: 'org:1', org_rev: 1, sync_rev: 1,
  nodes: { active: node('active') }, roots: ['active'], missing_requested: [],
  header: { slug: 'org', hidden_retired_roots: 0, retired_total: 100,
    archived_defaults: { busy: false } }, ...patch,
} as ForegroundSnapshot)
const response = (body: unknown, status = 200, headers: Record<string, string> = {}): Response => ({
  status, ok: status >= 200 && status < 300, headers: new Headers(headers), json: async () => body,
} as Response)
const legacy = async () => ({ slug: 'org', roots: [] }) as unknown as TreePayload

test('selected graph hydration stays constant across tenfold hidden history; lineage stays separate', () => {
  for (const count of [100, 1000]) {
    const raw = snapshot({ nodes: { active: node('active', { hidden_retired_children: count }),
      bearer: node('bearer', { axis: 'lineage', successor: 'active', state: 'archived' }) },
      header: { ...snapshot().header, retired_total: count } })
    const before = JSON.stringify(raw)
    const result = projectForeground(decodeForeground(raw))
    assert.equal(result.roots.length, 1)
    assert.equal(result.roots[0].children.length, 0)
    assert.equal(result.roots[0].id, 'active')
    assert.equal((result.roots[0] as unknown as FlatTreeNode).hidden_retired_children, count)
    assert.equal(JSON.stringify(raw), before)
    assert.equal(raw.missing_requested.length, 0, 'omitted history is not declared absent')
  }
})

test('exact delta preserves fields, reparents and removes without mutating the base', () => {
  const base = snapshot({ nodes: { active: node('active', { charter: 'preserved' }), old: node('old') }, roots: ['active', 'old'] })
  const before = JSON.stringify(base)
  const delta: ForegroundDelta = { format, kind: 'delta', base: 'r1', revision: 'r2',
    catalog_revision: 'org:2', org_rev: 2, sync_rev: 3, roots: ['parent'], missing_requested: ['old'],
    removed: ['old'], header: { set: { retired_total: 99 }, unset: ['archived_defaults'] },
    nodes: { parent: { set: node('parent', { children: ['active'] }), unset: [] },
      active: { set: { parent: 'parent' }, unset: ['lineage_count'] } } }
  const result = decodeForeground(delta, base)
  const tree = projectForeground(result)
  assert.equal(tree.roots[0].children[0].charter, 'preserved')
  assert.equal(tree.roots[0].children[0].lineage_count, undefined)
  assert.equal(tree.sync_rev, 3)
  assert.equal(result.header.retired_total, 99)
  assert.equal(JSON.stringify(base), before)
  assert.throws(() => decodeForeground(delta, snapshot({ revision: 'wrong' })), /exact base/)
})

test('malformed topology and contradictory absence never become partial success', () => {
  assert.throws(() => projectForeground(snapshot({ roots: [] })), /unreachable/)
  assert.throws(() => projectForeground(snapshot({ roots: ['active', 'active'] })), /duplicate/)
  assert.throws(() => projectForeground(snapshot({ nodes: { active: node('active', { parent: 'missing' }) } })), /missing ancestor/)
  assert.throws(() => projectForeground(snapshot({ nodes: { active: node('active', { parent: 'active' }) } })), /cycle/)
  assert.throws(() => projectForeground(snapshot({ missing_requested: ['active'] })), /contradicts/)
})

test('304 preserves identity and advances replay watermarks immutably', async () => {
  const replies = [response(snapshot(), 200, { ETag: 'one' }), response(null, 304),
    response(null, 304, { 'X-Orgtree-Sync-Rev': '7', 'X-Orgtree-Org-Rev': '8' })]
  const etags: (string | undefined)[] = []
  const reader = new ForegroundTreeReader(async (_path, etag) => { etags.push(etag); return replies.shift()! }, legacy)
  const first = await reader.get('org')
  assert.strictEqual(await reader.get('org'), first)
  const advanced = await reader.get('org')
  assert.notStrictEqual(advanced, first)
  assert.equal(advanced.tree.sync_rev, 7)
  assert.equal(first.tree.sync_rev, 1)
  assert.deepEqual(etags, [undefined, 'one', 'one'])
})

test('wrong-base delta retries unconditional; compatibility and selection overflow preserve full view', async () => {
  const replies = [response({ ...snapshot(), kind: 'delta', base: 'wrong' }), response(snapshot(), 200, { ETag: 'fresh' }),
    response({ kind: 'compatibility' }, 409)]
  const paths: string[] = []
  let fallbacks = 0
  const reader = new ForegroundTreeReader(async path => { paths.push(path); return replies.shift()! },
    async () => { ++fallbacks; return legacy() })
  assert.ok((await reader.get('o /', ['old/one', 'old/one'])).snapshot)
  assert.equal(paths.length, 2)
  assert.match(paths[0], /o%20%2F\/foreground-tree\?include=old%2Fone$/)
  assert.equal((await reader.get('org')).snapshot, null)
  assert.equal((await reader.get('org', Array.from({ length: 129 }, (_, n) => String(n)))).snapshot, null)
  assert.equal(fallbacks, 2)
  assert.equal(paths.length, 3)
})

test('503 is an error and catalog churn falls back as a whole read', async () => {
  let fallback = 0
  const reader = new ForegroundTreeReader(async () => response({ detail: 'inconsistent' }, 503),
    async () => { ++fallback; return legacy() })
  await assert.rejects(reader.get('org'), /inconsistent/)
  assert.equal(fallback, 0)
  const churn = new ForegroundTreeReader(async () => response({ kind: 'reset' }, 409),
    async () => { ++fallback; return legacy() })
  assert.equal((await churn.get('org')).snapshot, null)
  assert.equal(fallback, 1)
})

test('late old selection and invalidated requests cannot replace the current selected cache', async () => {
  const pending: ((r: Response) => void)[] = []
  const tags: (string | undefined)[] = []
  const reader = new ForegroundTreeReader((_p, tag) => { tags.push(tag); return new Promise(r => pending.push(r)) }, legacy)
  const old = reader.get('org', ['old'])
  const current = reader.get('org', ['new'])
  assert.strictEqual(reader.get('org', ['new']), current)
  pending[1](response(snapshot({ revision: 'new' }), 200, { ETag: 'new' })); await current
  pending[0](response(snapshot({ revision: 'old' }), 200, { ETag: 'old' })); await old
  const again = reader.get('org', ['new'])
  assert.equal(tags[2], 'new')
  reader.invalidate()
  pending[2](response(snapshot({ revision: 'stale' }), 200, { ETag: 'stale' })); await again
  const after = reader.get('org', ['new'])
  assert.equal(tags[3], undefined)
  pending[3](response(snapshot(), 200, { ETag: 'clean' })); await after
})

test('retained cache is one selection per org and eight orgs, independent of visits', async () => {
  const tags: (string | undefined)[] = []
  const reader = new ForegroundTreeReader(async (_p, tag) => { tags.push(tag); return response(snapshot(), 200, { ETag: 'x' }) }, legacy)
  for (let n = 0; n < 1000; ++n) await reader.get('org', ['old-' + n])
  await reader.get('org', ['old-0'])
  assert.equal(tags.at(-1), undefined, 'old selections were not retained')
  for (let n = 0; n < 9; ++n) await reader.get('org-' + n)
  await reader.get('org-0')
  assert.equal(tags.at(-1), undefined, 'old org was evicted')
})

test('lookup and page use exact landed routes and keep explicit absence/reset distinct', async () => {
  const paths: string[] = []
  const replies = [response({ ...snapshot(), kind: 'lookup', requested: 'old/x', found: false, nodes: {}, path: [] }),
    response({ ...snapshot(), kind: 'page', matches: ['active'], next_cursor: null }),
    response({ kind: 'reset' }, 409)]
  const reader = new ForegroundTreeReader(async path => { paths.push(path); return replies.shift()! }, legacy)
  assert.equal((await reader.lookup('org', 'old/x')).found, false)
  assert.deepEqual((await reader.page('org', 'children', 'p/x')).matches, ['active'])
  await assert.rejects(reader.page('org', 'search', 'a', 'cursor', 'archived'),
    e => e instanceof ForegroundControl && e.kind === 'reset')
  assert.equal(paths[0], '/api/orgs/org/foreground-tree/lookup/old%2Fx')
  assert.equal(paths[1], '/api/orgs/org/foreground-tree/children?parent=p%2Fx&limit=100')
  assert.equal(paths[2], '/api/orgs/org/foreground-tree/search?q=a&limit=100&cursor=cursor&state=archived')
})
