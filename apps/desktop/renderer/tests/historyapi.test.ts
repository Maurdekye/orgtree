import './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { applyUserHistory, getUserHistory, userGesture } from '../src/historyapi'
import { req } from '../src/api'

const history = { bound: 100, undo: null, redo: null, entries: [] }
test('undo transport preserves structured empty/moved/conflict replies while ordinary calls still throw', async t => {
  const previous = globalThis.fetch
  t.after(() => { globalThis.fetch = previous })
  for (const [status, code] of [[404, 'history_empty'], [409, 'history_moved'], [409, 'history_conflict']] as const) {
    globalThis.fetch = (async () => new Response(JSON.stringify({ code, history, reason: 'row changed' }), { status })) as typeof fetch
    assert.equal((await applyUserHistory('org', 'undo', 3) as { code: string }).code, code)
    await assert.rejects(req('/ordinary-call'))
  }
})
test('gesture retries reuse an explicit request ID, keep newborn references literal on the wire, and follow duplicate node results', async t => {
  const previous = globalThis.fetch, requests: { path: string; body: Record<string, unknown> }[] = []
  t.after(() => { globalThis.fetch = previous })
  globalThis.fetch = (async (url, init) => {
    requests.push({ path: String(url), body: JSON.parse(String(init?.body)) })
    return new Response(JSON.stringify({ duplicate: requests.length > 1, history_entry: { id: 10, kind: 'hire', label: 'Hire' }, results: [{ node: requests.length > 1 ? 'renamed' : 'born' }, { node: 'born' }] }))
  }) as typeof fetch
  const steps = [{ op: 'hire', parent: 'alice', tier: 'haiku' }, { op: 'reorder', node: '$0.node', before: 'bob' }]
  const first = await userGesture('an org', steps, 'Hire', 'same-id')
  const repeat = await userGesture('an org', steps, 'Hire', 'same-id')
  assert.equal(first.results?.[0]?.node, 'born'); assert.equal(repeat.results?.[0]?.node, 'renamed')
  assert.equal(repeat.duplicate, true)
  assert.deepEqual(requests[0], requests[1]); assert.equal(requests[0]?.path, '/api/orgs/an%20org/gesture')
  assert.deepEqual(requests[0]?.body.steps, steps)
})
test('history uses the undo-history routes and carries only target ID and optional confirmation', async t => {
  const previous = globalThis.fetch, requests: { path: string; body: unknown }[] = []
  t.after(() => { globalThis.fetch = previous })
  globalThis.fetch = (async (url, init) => {
    requests.push({ path: String(url), body: init?.body ? JSON.parse(String(init.body)) : null })
    return new Response(JSON.stringify(init?.method === 'POST' ? { status: 'undone', id: 1, label: 'Hire', history } : history))
  }) as typeof fetch
  await getUserHistory('one'); await applyUserHistory('one', 'undo', 1, 'count-token'); await applyUserHistory('two', 'redo', 2)
  assert.deepEqual(requests, [{ path: '/api/orgs/one/undo-history', body: null },
    { path: '/api/orgs/one/undo-history/undo', body: { id: 1, confirm: 'count-token' } },
    { path: '/api/orgs/two/undo-history/redo', body: { id: 2 } }])
})
