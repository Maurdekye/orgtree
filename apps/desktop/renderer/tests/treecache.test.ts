// The conditional tree cache across ws-patch invalidation (perf-review
// round 3): deleting the entry is not enough for a request already IN
// FLIGHT — its captured hit resolved a 304 to the pre-patch tree, and its
// 200 re-installed a stale cache entry. getTree must fence publication
// (return AND cache) on the invalidation stamp captured before the fetch.
// Round 4: the fence holds on retry EXHAUSTION too — getTree resolves
// null (refresh superseded) instead of publishing a known-stale body.
import './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { getTree, invalidateTreeCache } from '../src/api'
declare const __SRC_DIR__: string

const pending: Array<{ resolve: (r: unknown) => void
                       headers?: Record<string, string> }> = []
;(globalThis as unknown as { fetch: unknown }).fetch =
  (_url: unknown, init?: { headers?: Record<string, string> }) =>
    new Promise((resolve) => { pending.push({ resolve, headers: init?.headers }) })
const respond = (status: number, body?: unknown,
                 etag: string | null = null): void => {
  const w = pending.shift()
  assert.ok(w, 'expected a fetch in flight')
  w!.resolve({
    status, ok: status === 200,
    // ETag only: anything else (X-Orgtree-Instance) must read absent
    headers: { get: (k: string) => (k === 'ETag' ? etag : null) },
    json: async () => body,
  })
}
// let the resolved fetch's .then chain enqueue its follow-up request
const settle = () => new Promise((r) => setTimeout(r, 0))

test('in-flight 304 that raced an invalidation refetches the patched tree', async () => {
  const first = getTree('org-a')
  respond(200, { version: 'pre' }, 'tag-pre')
  assert.deepEqual(await first, { version: 'pre' })       // cache primed

  const raced = getTree('org-a')                // carries If-None-Match
  assert.ok(pending[0]?.headers?.['If-None-Match'] === 'tag-pre')
  invalidateTreeCache('org-a')                  // ws patch landed mid-flight
  respond(304)
  await settle()
  // the retry must be unconditional: the invalidation deleted the entry
  assert.equal(pending[0]?.headers, undefined)
  respond(200, { version: 'patched' }, 'tag-patched')
  assert.deepEqual(await raced, { version: 'patched' })
})

test('in-flight 200 that raced an invalidation is not re-installed as cache', async () => {
  const first = getTree('org-b')
  invalidateTreeCache('org-b')                  // raced while body in flight
  respond(200, { version: 'stale' }, 'tag-stale')
  await settle()
  respond(200, { version: 'fresh' }, 'tag-fresh')
  const fresh = await first
  assert.deepEqual(fresh, { version: 'fresh' })
  // the cache holds the FRESH tree: a 304 hands back the same object
  const second = getTree('org-b')
  assert.ok(pending[0]?.headers?.['If-None-Match'] === 'tag-fresh')
  respond(304)
  assert.strictEqual(await second, fresh)
})

test('exhausted raced retries resolve null; the rendered tree survives', async () => {
  // perf-review round 4: exhaustion used to return the last body uncached,
  // and the caller setTree'd a payload KNOWN to predate the final ws patch
  // — fetched version 2 replaced rendered version 3. Bounded retries must
  // stay bounded, but exhaustion resolves null and the caller keeps its
  // rendered state (both arms: raced 200 body and raced-304 captured hit).
  let rendered: unknown = { version: 0 }
  const request = getTree('org-c').then((t) => {
    if (t) rendered = t                         // the caller's null guard
    return t
  })
  for (let i = 1; i <= 3; i++) {
    rendered = { version: i }                   // ws patch edits the render…
    invalidateTreeCache('org-c')                // …and invalidates the cache
    respond(200, { version: i - 1 }, `t${i}`)   // HTTP body predates the patch
    await settle()
  }
  assert.equal(await request, null)             // superseded, never stale data
  assert.equal(pending.length, 0)               // and bounded: no 4th attempt
  assert.deepEqual(rendered, { version: 3 })    // the FINAL RENDERED value
  const next = getTree('org-c')                 // nothing cached → no validator
  assert.equal(pending[0]?.headers, undefined)
  respond(200, { version: 4 }, 't4')
  assert.deepEqual(await next, { version: 4 })  // next heartbeat real-fetches
})

test('the hidden tree heartbeat is paused, not slowed', () => {
  // accepted requirement (perf-review round 3): hidden windows PAUSE the
  // G1 beat — the ws 'changed' handler covers real changes, and becoming
  // visible refetches immediately. A multiplier is a slower leak, not a pause.
  const src = readFileSync(path.resolve(__SRC_DIR__, 'App.tsx'), 'utf8')
  const g1 = src.slice(src.indexOf('G1 — THE TREE HEARTBEAT'),
                       src.indexOf('the org list/dashboard is LIVE'))
  assert.match(g1, /if \(document\.hidden\) return/)
  assert.doesNotMatch(g1, /TREE_POLL_MS \* \d/)
})
