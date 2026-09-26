// The docket list is conditional and shared (mem-leak-probe, 2026-09-26).
// Five surfaces poll it with both groups included and each answer was ~38 MB
// on the operator's org, parsed on the renderer main thread. The client now
// sends If-None-Match, keeps the last body on a 304, shares one request between
// concurrent pollers of the same URL, and drops that shared request when a
// mutation is made so a refetch after a write never reuses an older request.
import './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { getWorkItems, req } from '../src/api'

const pending: Array<{ url: string; resolve: (r: unknown) => void
                       headers?: Record<string, string> }> = []
;(globalThis as unknown as { fetch: unknown }).fetch =
  (url: unknown, init?: { headers?: Record<string, string>; method?: string }) =>
    new Promise((resolve) => {
      pending.push({ url: String(url), resolve, headers: init?.headers })
    })
const respond = (status: number, body?: unknown, etag: string | null = null): void => {
  const w = pending.shift()
  assert.ok(w, 'expected a fetch in flight')
  w!.resolve({
    status, ok: status >= 200 && status < 300,
    headers: { get: (k: string) => (k === 'ETag' ? etag : k === 'Content-Type' ? 'application/json' : null) },
    json: async () => body,
  })
}

test('a 304 returns the cached body; the next poll revalidates with its ETag', async () => {
  const first = getWorkItems('org-a', true, true)
  assert.equal(pending[0]?.headers, undefined, 'the first poll has nothing to revalidate')
  assert.match(pending[0]!.url, /work-items\?archived=1&backlogged=1$/)
  const body = { items: [{ slug: 'x' }] }
  respond(200, body, '"w1"')
  const got = await first
  assert.deepEqual(got, body)

  const second = getWorkItems('org-a', true, true)
  assert.equal(pending[0]?.headers?.['If-None-Match'], '"w1"')
  respond(304)
  // the SAME object: React's state setters bail out on an unchanged reference
  assert.equal(await second, got)
  assert.equal(pending.length, 0)
})

test('concurrent pollers of one URL share one request', async () => {
  const a = getWorkItems('org-b', true, true)
  const b = getWorkItems('org-b', true, true)
  const other = getWorkItems('org-b')               // different flags: its own request
  assert.equal(pending.length, 2, 'the two identical polls were not shared')
  respond(200, { items: [1] }, '"b1"')
  respond(200, { items: [] }, '"b2"')
  assert.equal(await a, await b)
  assert.deepEqual(await other, { items: [] })
})

test('a completed mutation drops the shared in-flight poll', async () => {
  const before = getWorkItems('org-c', true, true)   // started before the write
  const write = req('/api/orgs/org-c/work-items/x/reply', { method: 'POST' })
  // the write is answered while the older poll is still in flight
  const w = pending.splice(1, 1)[0]!
  w.resolve({ status: 200, ok: true, headers: { get: () => null }, json: async () => ({ ok: true }) })
  await write
  const after = getWorkItems('org-c', true, true)
  assert.notEqual(before, after, 'a poll after a write reused a request that started before it')
  assert.equal(pending.length, 2)                     // the old poll and a fresh one
  respond(200, { items: ['old'] }, '"c1"')
  respond(200, { items: ['new'] }, '"c2"')
  assert.deepEqual(await before, { items: ['old'] })
  assert.deepEqual(await after, { items: ['new'] })
})
