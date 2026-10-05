import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { RecordFeed } from '../src/recordfeed'
import type { FeedCursor, FeedRecord, RecordChanges, SubscriptionMessage } from '../src/recordfeed'

// Driven by tests/test_orgdb_record_subtree_pg.py, which supplies the fixture;
// the plain renderer run has no PostgreSQL parent, so it skips there.
test('actual snapshot subtree catch-up atomically replaces pinned ancestry without refetch',
  { skip: !process.env.ORGTREE_RECORD_SUBTREE_FIXTURE && 'needs the PostgreSQL parent test' }, () => {
  const path = process.env.ORGTREE_RECORD_SUBTREE_FIXTURE
  assert.ok(path, 'the PostgreSQL parent must supply its reached fixture')
  const p = JSON.parse(readFileSync(path, 'utf8')) as {
    cursor: FeedCursor; before: FeedRecord[]; frame: RecordChanges; expected: FeedRecord[]
  }
  let reads = 0
  const errors: Error[] = [], messages: SubscriptionMessage[] = []
  const feed = new RecordFeed({
    snapshot: async () => { reads++; throw new Error('unexpected refetch') },
    catchup: async () => { reads++; throw new Error('unexpected HTTP recovery') },
    project: records => records, publish: () => {}, error: error => errors.push(error),
  })
  feed.receive({ type: 'record_snapshot', cursor: p.cursor, records: p.before.filter(r => r.set === 'shared') })
  const token = feed.socketOpened(m => messages.push(m))
  const release = []
  for (const sub of [1, 2]) {
    const rows = p.before.filter(r => r.set === `sub:${sub}`)
    release.push(feed.subscribe({ agents: [rows[rows.length - 1].id] }))
    assert.equal(messages.at(-1)?.type, 'subscribe')
    feed.receiveSocket({ type: 'record_subscribed', ...p.cursor, sub, records: rows }, token)
  }
  const rows = () => [...feed.memberships].flatMap(([set, keys]) => [...keys].map(key => {
    const [entity, id] = JSON.parse(key) as [string, string]
    return { set, entity, id, body: feed.records.get(entity)?.get(id) }
  })).sort((a, b) => JSON.stringify([a.set, a.entity, a.id]).localeCompare(JSON.stringify([b.set, b.entity, b.id])))
  const expected = p.expected.slice().sort((a, b) =>
    JSON.stringify([a.set, a.entity, a.id]).localeCompare(JSON.stringify([b.set, b.entity, b.id])))
  feed.receiveSocket(p.frame, token)
  assert.deepEqual(rows(), expected)
  assert.equal(feed.cursor?.rev, p.frame.to)
  // A delayed old frame cannot reinstall removed ancestors or inherited values.
  feed.receiveSocket({ ...p.frame, to: p.cursor.rev, from: p.cursor.rev,
    upserts: [], replacements: [{ set: 'sub:1', records: p.before.filter(r => r.set === 'sub:1') }] }, token)
  assert.deepEqual(rows(), expected)
  release[0]()
  // An answer computed before unsubscribe must not revive that set.
  feed.receiveSocket({ ...p.frame, from: p.frame.to, to: p.frame.to + 1 }, token)
  assert.equal(feed.memberships.has('sub:1'), false)
  assert.equal(reads, 0)
  assert.deepEqual(errors, [])
  feed.dispose()
})
