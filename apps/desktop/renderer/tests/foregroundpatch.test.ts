// foreground-tree F1: a ws metadata patch (cache forecast, MCP counts) must
// not drop the SELECTED tree's ETag. The server moves its runtime stamp
// before it sends such a frame, so a kept ETag can only be answered 304 when
// the server's current body equals the kept one; otherwise the answer is a
// delta against the kept base. The full-tree (legacy) cache is still fenced.
import './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { getSelectedTree, patchedTreeCache } from '../src/api'
import { FOREGROUND_TREE_FORMAT as format } from '../src/foregroundtree'

const selection = { include: [], hideRetired: true, fronts: {} }
const node = (forecast: string) => ({
  id: 'active', parent: null, children: [], axis: 'org', state: 'live',
  hidden_retired_children: 0, lineage_loaded: false, lineage_count: 0,
  predecessor: null, successor: null, cache_forecast: forecast,
})
const forecast = (v: number) => `forecast-${v}`
const tag = (v: number) => `W/"foreground-r${v}"`

// One server per org, answering like the real one: 304 only for its CURRENT
// tag, a delta from a tag it still holds, a snapshot otherwise.
type Server = { current: number; sent: (string | undefined)[] }
const servers = new Map<string, Server>()
const snapshot = (org: string, v: number) => ({ format, kind: 'snapshot', revision: `r${v}`,
  catalog_revision: `${org}:1`, org_rev: v, sync_rev: v, nodes: { active: node(forecast(v)) },
  roots: ['active'], missing_requested: [],
  header: { slug: org, hidden_retired_roots: 0, retired_total: 0, archived_defaults: { busy: false } } })
const delta = (org: string, from: number, to: number) => ({ format, kind: 'delta', base: `r${from}`,
  revision: `r${to}`, catalog_revision: `${org}:1`, org_rev: to, sync_rev: to, roots: ['active'],
  missing_requested: [], header: { set: {}, unset: [] }, removed: [],
  nodes: { active: { set: { cache_forecast: forecast(to) }, unset: [] } } })
;(globalThis as unknown as { fetch: unknown }).fetch = async (url: string, init?: { headers?: Record<string, string> }) => {
  const org = /\/api\/orgs\/([^/]+)\/foreground-tree/.exec(String(url))?.[1]
  const server = org ? servers.get(decodeURIComponent(org)) : undefined
  assert.ok(org && server, `unexpected request ${url}`)
  const since = init?.headers?.['If-None-Match']
  server.sent.push(since)
  const reply = (status: number, body: unknown) => ({
    status, ok: status === 200, headers: new Headers({ ETag: tag(server.current) }), json: async () => body,
  })
  if (since === tag(server.current)) return reply(304, null)
  const base = since ? Number(/r(\d+)/.exec(since)?.[1]) : NaN
  return base > 0 && base < server.current
    ? reply(200, delta(org, base, server.current)) : reply(200, snapshot(org, server.current))
}
const serve = (org: string, current: number): Server => {
  const server = { current, sent: [] }
  servers.set(org, server)
  return server
}
const shown = (tree: unknown) => (tree as { roots: { cache_forecast?: unknown }[] }).roots[0].cache_forecast

test('a metadata patch keeps the selected ETag: the next read is a delta, never a revalidated pre-patch body', async () => {
  const server = serve('patched-org', 1)
  assert.equal(shown(await getSelectedTree('patched-org', selection)), forecast(1))
  server.current = 2                    // the frame's value is in the server's body now
  patchedTreeCache('patched-org')       // App.tsx on cache_forecast / mcp_* frames
  assert.equal(shown(await getSelectedTree('patched-org', selection)), forecast(2), 'a pre-patch body was served')
  // After the first (unconditional) read, every request carries a kept ETag:
  // the patch never forced a full snapshot. (The reader may confirm twice.)
  assert.equal(server.sent[0], undefined)
  assert.equal(server.sent[1], tag(1), 'the kept ETag was not sent: the patch forced a full snapshot')
  assert.ok(server.sent.slice(1).every(Boolean), `an unconditional read after the patch: ${server.sent}`)
  const before = server.sent.length
  assert.equal(shown(await getSelectedTree('patched-org', selection)), forecast(2))
  assert.ok(server.sent.slice(before).every(sent => sent === tag(2)), `${server.sent}`)
})

test('an unchanged server answers the kept ETag with 304 and the kept body is kept', async () => {
  const server = serve('quiet-org', 5)
  const first = await getSelectedTree('quiet-org', selection)
  patchedTreeCache('quiet-org')         // a frame whose value the body does not carry
  const second = await getSelectedTree('quiet-org', selection)
  assert.equal(shown(second), shown(first))
  assert.equal(server.sent[0], undefined)
  assert.ok(server.sent.length > 1 && server.sent.slice(1).every(sent => sent === tag(5)), `${server.sent}`)
})
