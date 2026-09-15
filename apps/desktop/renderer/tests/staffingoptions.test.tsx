// The renderer half of the warm staffing source: it loads before anything is
// opened, every consumer shares the one load, and an opening surface never
// starts a second.
//
// Each section carries a control, because "no second request" is the classic
// assertion that passes because the first request never happened either.
import './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  invalidateStaffingOptions, peekStaffingOptions, prefetchQuickStaff,
  prefetchStaffingOptions, requestCount, resetStaffingOptionsForTests,
  retryStaffingOptions, staffingOptions, staffingOptionsPath, staffingOptionsState,
} from '../src/canvas/staffingoptions'

const OPTIONS = {
  tiers: [{ tier: 'haiku', seat: 1, efforts: ['low'], accounts: [], default_ok: true }],
  at: 1, stale: false, errors: [], loading: false, generation: 1,
}

/** A fetch double that can be held open, so "in flight" is a state the test
 *  can actually be in rather than a moment it hopes to hit. */
function serve(t: { after: (fn: () => void) => void },
               opts: { fail?: boolean; hold?: boolean } = {}) {
  const old = globalThis.fetch
  const urls: string[] = []
  let release: (() => void) | undefined
  globalThis.fetch = async (url: RequestInfo | URL) => {
    urls.push(String(url))
    if (opts.hold) await new Promise<void>(r => { release = r })
    if (opts.fail) {
      return new Response(JSON.stringify({ detail: 'discovery offline' }),
        { status: 422, headers: { 'Content-Type': 'application/json' } })
    }
    return new Response(JSON.stringify(OPTIONS),
      { headers: { 'Content-Type': 'application/json' } })
  }
  t.after(() => { globalThis.fetch = old; resetStaffingOptionsForTests() })
  return { urls, release: () => release?.() }
}

test('the org prefetch loads once and every later reader is free', async t => {
  resetStaffingOptionsForTests()
  const net = serve(t)
  await prefetchStaffingOptions('acme')
  assert.equal(net.urls.length, 1)
  assert.equal(net.urls[0], staffingOptionsPath('acme'))
  for (let i = 0; i < 5; i++) await staffingOptions('acme')
  assert.equal(net.urls.length, 1, 'a warm read must not hit the network')
  assert.deepEqual(peekStaffingOptions('acme')!.tiers[0]!.tier, 'haiku')
  assert.deepEqual(staffingOptionsState('acme'),
                   { loaded: true, loading: false, failed: false, requests: 1 })
})

test('concurrent consumers of a cold source share ONE in-flight request', async t => {
  resetStaffingOptionsForTests()
  const net = serve(t, { hold: true })
  const all = [prefetchStaffingOptions('acme'), prefetchStaffingOptions('acme'),
               staffingOptions('acme'), staffingOptions('acme')]
  assert.equal(staffingOptionsState('acme').loading, true)
  net.release()
  const results = await Promise.all(all)
  assert.equal(net.urls.length, 1, 'four consumers, one request')
  assert.ok(results.every(r => r === results[0]), 'and one answer')
})

test('control: separate orgs are separate loads, so the dedup is keyed not global', async t => {
  resetStaffingOptionsForTests()
  const net = serve(t)
  await Promise.all([prefetchStaffingOptions('acme'), prefetchStaffingOptions('other')])
  assert.equal(net.urls.length, 2)
})

test('a ticket menu consumes the prefetch its row already started', async t => {
  // ⚠ THE REQUIREMENT ITSELF. The hover starts the load; the right-click that
  // follows must find it rather than begin another.
  resetStaffingOptionsForTests()
  const net = serve(t, { hold: true })
  const path = '/api/orgs/acme/work-items/ticket-one/quick-staff'
  const hover = prefetchQuickStaff(path)              // the row is hovered
  const opened = prefetchQuickStaff(path)             // the menu is opened
  net.release()
  const [a, b] = await Promise.all([hover, opened])
  assert.equal(requestCount(path), 1, 'opening the menu started no second request')
  assert.equal(a, b)
})

test('control: with no prefetch, opening alone is the one that loads', async t => {
  resetStaffingOptionsForTests()
  const net = serve(t)
  const path = '/api/orgs/acme/work-items/ticket-two/quick-staff'
  await prefetchQuickStaff(path)
  assert.equal(net.urls.length, 1)
  assert.equal(requestCount(path), 1)
})

test('an invalidation drops what is held so the next read gets the new answer', async t => {
  resetStaffingOptionsForTests()
  const net = serve(t)
  await prefetchStaffingOptions('acme')
  assert.equal(peekStaffingOptions('acme')!.generation, 1)
  invalidateStaffingOptions('acme')
  assert.equal(peekStaffingOptions('acme'), undefined)
  await prefetchStaffingOptions('acme')
  assert.equal(net.urls.length, 2)
  // CONTROL: without the invalidation the same read is still free
  await prefetchStaffingOptions('acme')
  assert.equal(net.urls.length, 2)
})

test('an invalidation is scoped to its org and never touches another', async t => {
  resetStaffingOptionsForTests()
  serve(t)
  await Promise.all([prefetchStaffingOptions('acme'), prefetchStaffingOptions('other')])
  invalidateStaffingOptions('acme')
  assert.equal(peekStaffingOptions('acme'), undefined)
  assert.ok(peekStaffingOptions('other'))
})

test('a failed load reports itself and retries without inventing an empty list', async t => {
  resetStaffingOptionsForTests()
  const old = globalThis.fetch
  let fail = true
  const urls: string[] = []
  globalThis.fetch = async (url: RequestInfo | URL) => {
    urls.push(String(url))
    return fail
      ? new Response(JSON.stringify({ detail: 'discovery offline' }),
          { status: 422, headers: { 'Content-Type': 'application/json' } })
      : new Response(JSON.stringify(OPTIONS), { headers: { 'Content-Type': 'application/json' } })
  }
  t.after(() => { globalThis.fetch = old; resetStaffingOptionsForTests() })
  await assert.rejects(prefetchStaffingOptions('acme'))
  // ⚠ NOT an empty answer: a surface must be able to tell "could not find out"
  // from "there is nothing", and `peek` returning undefined is what says so.
  assert.equal(peekStaffingOptions('acme'), undefined)
  assert.deepEqual(staffingOptionsState('acme'),
                   { loaded: false, loading: false, failed: true, requests: 1 })
  fail = false
  const recovered = await retryStaffingOptions('acme')
  assert.equal(recovered.tiers[0]!.tier, 'haiku')
  assert.ok(urls.some(u => u.endsWith('/staffing-options/refresh')),
            'the retry asks the backend to refresh, not just re-reads')
  assert.equal(staffingOptionsState('acme').failed, false)
})
