import test from 'node:test'
import assert from 'node:assert/strict'
import { RecordFeed } from '../src/recordfeed'
import type { SubscriptionMessage, RecordSubscribed } from '../src/recordfeed'

const cursor = { org_uuid: 'org', incarnation: 'first', rev: 1 }
function rig() {
  const messages: SubscriptionMessage[] = [], errors: Error[] = [], published: number[] = []
  const feed = new RecordFeed({
    snapshot: async () => ({ type: 'record_snapshot' as const, cursor, records: [] }),
    catchup: async () => { throw new Error('unexpected HTTP') },
    project: r => r, publish: r => published.push(r.get('agent')?.size ?? 0), error: e => errors.push(e),
  })
  feed.receive({ type: 'record_snapshot', cursor, records: [] })
  const token = feed.socketOpened(m => messages.push(m))
  feed.subscribe({ windows: [{ kind: 'archived_all' }] })
  const latest = () => messages.filter(m => m.type === 'subscribe').at(-1)!.sub
  const page = (index: number, final: boolean, start: number, size: number, sub = latest(), rev = 1): RecordSubscribed => ({
    type: 'record_subscribed', ...cursor, rev, sub, page: index, final,
    records: Array.from({ length: size }, (_, i) => ({ entity: 'agent', id: String(start + i), body: start + i, set: `sub:${sub}` })),
  })
  return { feed, messages, errors, published, token, latest, page }
}

test('300 predicate records publish atomically only on the last ordered page', () => {
  const r = rig(), before = r.published.length
  r.feed.receiveSocket(r.page(0, false, 1, 128), r.token)
  r.feed.receiveSocket(r.page(1, false, 129, 128), r.token)
  assert.equal(r.feed.records.get('agent')?.size ?? 0, 0)
  assert.equal(r.published.length, before, 'partial set never reaches the tree')
  r.feed.receiveSocket(r.page(2, true, 257, 44), r.token)
  assert.equal(r.feed.records.get('agent')?.size, 300)
  assert.equal(r.published.length, before + 1)
  assert.equal(r.errors.length, 0)
  r.feed.dispose()
})

test('cursor change during page assembly discards all pages and renews the generation', () => {
  const r = rig(), sub = r.latest()
  r.feed.receiveSocket(r.page(0, false, 1, 128), r.token)
  r.feed.receiveSocket({ type: 'record_changes', ...cursor, from: 1, to: 2, upserts: [], tombstones: [] }, r.token)
  r.feed.receiveSocket(r.page(1, true, 129, 1, sub), r.token)
  assert.ok(r.latest() > sub)
  assert.equal(r.feed.records.get('agent')?.size ?? 0, 0)
  r.feed.receiveSocket(r.page(2, true, 130, 1, sub), r.token)
  r.feed.receiveSocket(r.page(0, true, 9, 1, r.latest(), 2), r.token)
  assert.deepEqual([...r.feed.records.get('agent')!.keys()], ['9'])
  r.feed.dispose()
})

for (const fault of ['duplicate', 'missing', 'mixed-format']) test(`paged answer rejects ${fault} ordering`, () => {
  const r = rig(), sub = r.latest()
  r.feed.receiveSocket(r.page(0, false, 1, 1), r.token)
  const next = r.page(fault === 'duplicate' ? 0 : 2, true, 2, 1)
  if (fault === 'mixed-format') { delete next.page; delete next.final }
  r.feed.receiveSocket(next, r.token)
  assert.ok(r.latest() > sub)
  assert.equal(r.feed.records.get('agent')?.size ?? 0, 0)
  r.feed.dispose()
})

test('unsubscribe and a new socket discard partial pages and fence old finals', () => {
  const r = rig()
  const release = r.feed.subscribe({ agents: ['7'] }), old = r.latest()
  r.feed.receiveSocket(r.page(0, false, 7, 1, old), r.token)
  release(); r.feed.receiveSocket(r.page(1, true, 8, 1, old), r.token)
  const sub = r.feed.declarations()[0].sub
  r.feed.receiveSocket(r.page(0, false, 1, 1, sub), r.token)
  const token = r.feed.socketOpened(m => r.messages.push(m))
  r.feed.receiveSocket(r.page(1, true, 2, 1, sub), r.token)
  r.feed.receiveSocket(r.page(0, true, 9, 1), token)
  assert.deepEqual([...r.feed.records.get('agent')!.keys()], ['9'])
  r.feed.dispose()
})

test('300 includes are supported by three declarations with each include bound preserved', () => {
  const r = rig()
  for (let start = 1; start <= 300; start += 128) r.feed.subscribe({
    agents: Array.from({ length: Math.min(128, 301 - start) }, (_, i) => String(start + i)),
  })
  assert.deepEqual(r.feed.declarations().slice(1).map(s => s.agents.length), [128, 128, 44])
  assert.throws(() => r.feed.subscribe({ agents: Array.from({ length: 129 }, (_, i) => String(i + 1)) }), /bound/)
  r.feed.dispose()
})
