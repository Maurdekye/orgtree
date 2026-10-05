import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { RecordFeed } from '../src/recordfeed'
import type { FeedRecord, FeedCursor, RecordChanges } from '../src/recordfeed'

const path = process.env.ORGTREE_RECORD_MEMBERSHIP_FIXTURE
test('actual SQL two-writer and seeded membership frames converge without refetch',
  { skip: path ? false : 'run through test_orgdb_record_membership_pg.py for real SQL frames' }, () => {
  assert.ok(path, 'the reached PostgreSQL parent supplies these records')
  const packet = JSON.parse(readFileSync(path, 'utf8')) as { cases: {
    label: string; cursor: FeedCursor; before: FeedRecord[]; declarations: any[];
    updates: { frame: RecordChanges; expected: FeedRecord[] }[]
  }[] }
  assert.ok(packet.cases.length)
  const sort = (rows: FeedRecord[]) => rows.slice().sort((a, b) =>
    JSON.stringify([a.set, a.entity, a.id]).localeCompare(JSON.stringify([b.set, b.entity, b.id])))
  for (const example of packet.cases) {
    let reads = 0
    const errors: Error[] = []
    const feed = new RecordFeed({ snapshot: async () => { reads++; throw new Error('no refetch') },
      catchup: async () => { reads++; throw new Error('no HTTP recovery') },
      project: records => records, publish: () => {}, error: error => errors.push(error) })
    const token = feed.socketOpened(() => {})
    feed.receive({ type: 'record_snapshot', cursor: example.cursor,
      records: example.before.filter(row => row.set === 'shared') })
    for (const [i, declaration] of example.declarations.entries()) {
      const sub = i + 1
      feed.subscribe(declaration)
      feed.receiveSocket({ type: 'record_subscribed', ...example.cursor, sub,
        records: example.before.filter(row => row.set === `sub:${sub}`) }, token)
    }
    const rows = () => sort([...feed.memberships].flatMap(([set, keys]) => [...keys].map(key => {
      const [entity, id] = JSON.parse(key) as [string, string]
      return { set, entity, id, body: feed.records.get(entity)?.get(id) }
    })))
    assert.deepEqual(rows(), sort(example.before), example.label + ' baseline')
    for (const update of example.updates) {
      feed.receiveSocket(update.frame, token)
      assert.deepEqual(rows(), sort(update.expected), example.label)
      assert.equal(feed.cursor?.rev, update.frame.to)
      // A duplicate cannot reinstall departed members or older bodies.
      feed.receiveSocket(update.frame, token)
      assert.deepEqual(rows(), sort(update.expected), example.label + ' duplicate')
    }
    assert.equal(reads, 0, example.label)
    assert.deepEqual(errors, [], example.label)
    feed.dispose()
  }
})
