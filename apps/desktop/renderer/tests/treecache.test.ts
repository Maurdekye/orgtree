// The conditional tree cache across ws-patch invalidation, under the
// base+patch protocol (2026-09-19, treesync.ts). The invalidation stamp
// now fences the CACHE only: a body that raced an invalidation is
// RETURNED (the caller replays newer buffered patch frames on top of it —
// convergence by revision arithmetic) but never installed as a cache
// entry, so a later 304 can never revalidate a pre-patch body. The old
// contract — refetch on a raced 304, resolve null on retry exhaustion —
// is retired: under a working swarm's continuous patch traffic every
// bounded attempt raced some invalidation, refreshes starved, and
// lifecycle state sat visibly stale for over a minute (beta.1 wave 2).
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

test('a raced 304 returns the captured body once — replay converges it, no refetch loop', async () => {
  const first = getTree('org-a')
  respond(200, { version: 'pre' }, 'tag-pre')
  assert.deepEqual(await first, { version: 'pre' })       // cache primed

  const raced = getTree('org-a')                // carries If-None-Match
  assert.ok(pending[0]?.headers?.['If-None-Match'] === 'tag-pre')
  invalidateTreeCache('org-a')                  // ws patch landed mid-flight
  respond(304)
  // ONE request, ONE answer: the body is returned (the caller replays the
  // buffered patch frames newer than its sync_rev), never chained into a
  // refetch loop that patch traffic can starve
  assert.deepEqual(await raced, { version: 'pre' })
  assert.equal(pending.length, 0)
  // the invalidation still emptied the cache: the next call real-fetches
  const next = getTree('org-a')
  assert.equal(pending[0]?.headers, undefined)
  respond(200, { version: 'patched' }, 'tag-patched')
  assert.deepEqual(await next, { version: 'patched' })
})

test('a raced 200 is returned but never installed as a cache entry', async () => {
  const first = getTree('org-b')
  invalidateTreeCache('org-b')                  // raced while body in flight
  respond(200, { version: 'raced' }, 'tag-raced')
  // the body flows to the caller (replay reconciles it) …
  assert.deepEqual(await first, { version: 'raced' })
  assert.equal(pending.length, 0)               // and exactly one request ran
  // … but the cache did NOT adopt it: no validator on the next call, so a
  // 304 can never revalidate the pre-patch body
  const second = getTree('org-b')
  assert.equal(pending[0]?.headers, undefined)
  respond(200, { version: 'fresh' }, 'tag-fresh')
  const fresh = await second
  assert.deepEqual(fresh, { version: 'fresh' })
  // the un-raced body IS cached: a 304 hands back the same object
  const third = getTree('org-b')
  assert.ok(pending[0]?.headers?.['If-None-Match'] === 'tag-fresh')
  respond(304)
  assert.strictEqual(await third, fresh)
})

test('continuous patch traffic can no longer starve refreshes', async () => {
  // the beta.1 failure shape: an invalidation lands during EVERY fetch.
  // The old bounded-retry contract resolved null every time and the
  // rendered lifecycle state never advanced. Now every call is exactly one
  // request whose body is returned; convergence is the replay's job.
  for (let i = 1; i <= 3; i++) {
    const call = getTree('org-c')
    invalidateTreeCache('org-c')                // patch races the fetch, again
    respond(200, { version: i }, `t${i}`)
    assert.deepEqual(await call, { version: i },
      'a raced fetch must still deliver its body')
  }
  assert.equal(pending.length, 0)               // one request per call, no tail
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
