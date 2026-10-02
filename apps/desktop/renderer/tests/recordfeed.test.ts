import test from 'node:test'
import assert from 'node:assert/strict'
import { RecordFeed } from '../src/recordfeed'
import type { FeedAnswer, FeedCursor, FeedRecord, RecordChanges, RecordSnapshot, RecordTable } from '../src/recordfeed'
import { agentRecordIds, projectOrgs, projectTree } from '../src/recordprojection'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}
const cursor = (rev: number, incarnation = 'first'): FeedCursor => ({ org_uuid: 'org', incarnation, rev })
const snapshot = (rev: number, value: string, incarnation = 'first'): RecordSnapshot => ({
  type: 'record_snapshot', cursor: cursor(rev, incarnation), records: [{ entity: 'value', id: '1', body: value }],
})
const frame = (from: number, to: number, value: string, incarnation = 'first'): RecordChanges => ({
  type: 'record_changes', ...cursor(to, incarnation), from, to,
  upserts: [{ entity: 'value', id: '1', body: value }], tombstones: [],
})
function rig(initial = snapshot(100, '100')) {
  const loads: ReturnType<typeof deferred<RecordSnapshot>>[] = []
  const catchups: { cursor: FeedCursor; answer: ReturnType<typeof deferred<FeedAnswer>> }[] = []
  const errors: Error[] = []
  const published: unknown[] = []
  const feed = new RecordFeed({
    snapshot: () => { const d = deferred<RecordSnapshot>(); loads.push(d); return d.promise },
    catchup: c => { const d = deferred<FeedAnswer>(); catchups.push({ cursor: c, answer: d }); return d.promise },
    project: r => r.get('value')?.get('1'),
    publish: value => published.push(value), error: error => errors.push(error),
  })
  feed.receive(initial)
  return { feed, loads, catchups, errors, published }
}
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }
const value = (r: ReturnType<typeof rig>) => r.feed.records.get('value')?.get('1')
const fullLoad = (feed: RecordFeed<unknown>, expected: RecordSnapshot) => {
  assert.deepEqual(feed.cursor, expected.cursor)
  assert.deepEqual([...feed.records].flatMap(([entity, rows]) => [...rows].map(([id, body]) => ({ entity, id, body }))),
    expected.records)
}

test('overlapping batch applies whole; duplicate and reordered frames never rewind the store', () => {
  const r = rig(snapshot(103, '103'))
  r.feed.receive(frame(100, 105, '105')) // joining between server batches
  r.feed.receive(frame(100, 105, 'bad duplicate'))
  r.feed.receive(frame(99, 102, 'bad older'))
  fullLoad(r.feed, snapshot(105, '105'))
  assert.equal(r.catchups.length, 0)
  assert.deepEqual(r.published, ['103', '105'])
})

test('gap asks for catch-up from own cursor; a slow HTTP answer cannot overwrite newer live state', async () => {
  const r = rig()
  r.feed.receive(frame(102, 104, '104'))
  assert.equal(value(r), '100')
  assert.deepEqual(r.catchups.map(c => c.cursor), [cursor(100)])
  r.feed.receive(frame(100, 106, '106'))
  r.catchups[0].answer.resolve(frame(100, 104, '104'))
  await settle()
  fullLoad(r.feed, snapshot(106, '106'))
})

test('reconnect catches up even if no later commit reveals the missed update', async () => {
  const r = rig()
  const recovery = r.feed.reconnect()
  assert.deepEqual(r.catchups[0].cursor, cursor(100))
  r.catchups[0].answer.resolve(frame(100, 101, '101'))
  await recovery
  fullLoad(r.feed, snapshot(101, '101'))
})

test('reset buffers live frames during baseline; baseline inside batch converges to final full load', async () => {
  const r = rig()
  r.feed.receive({ type: 'record_reset' })
  r.feed.receive(frame(100, 105, '105'))
  r.loads[0].resolve(snapshot(103, '103'))
  await settle()
  fullLoad(r.feed, snapshot(105, '105'))
})

test('a delayed older baseline does not overwrite a newer answer in the ordered pipeline', async () => {
  const r = rig()
  const pending = r.feed.resync()
  r.feed.receive(snapshot(106, '106'))
  r.loads[0].resolve(snapshot(103, '103'))
  await pending
  fullLoad(r.feed, snapshot(106, '106'))
})

test('retention reset loads a baseline; replaced identity rejects old HTTP and buffered frames', async () => {
  const r = rig()
  void r.feed.reconnect()
  r.catchups[0].answer.resolve({ type: 'record_reset' })
  await settle()
  r.feed.receive(frame(100, 105, 'old'))
  r.loads[0].resolve(snapshot(2, 'replacement', 'second'))
  await settle()
  fullLoad(r.feed, snapshot(2, 'replacement', 'second'))
  void r.feed.reconnect()
  r.feed.receive(frame(0, 3, 'third-db', 'third'))
  r.catchups[1].answer.resolve(frame(2, 4, 'late-second', 'second'))
  r.loads[1].resolve(snapshot(1, 'third-db', 'third'))
  await settle()
  fullLoad(r.feed, snapshot(1, 'third-db', 'third'))
})

test('upserts and tombstones commit atomically and keep unknown entities for future selectors', () => {
  const r = rig()
  r.feed.receive({ ...frame(100, 101, 'unused'), upserts: [{ entity: 'new-entity', id: '9', body: { x: 1 } }],
    tombstones: [{ entity: 'value', id: '1' }] })
  assert.equal(r.feed.records.get('value')?.has('1'), false)
  assert.deepEqual(r.feed.records.get('new-entity')?.get('9'), { x: 1 })
})

test('streams have independent cursors; disposal prevents delayed replies publishing', async () => {
  const a = rig(), b = rig(snapshot(3, 'registry'))
  a.feed.receive(frame(100, 101, 'org'))
  assert.equal(b.feed.cursor?.rev, 3)
  const pending = a.feed.resync()
  a.feed.dispose()
  a.loads[0].resolve(snapshot(102, 'late'))
  await pending
  assert.equal(value(a), 'org')
})

test('invalid bounds do not advance cursor or corrupt state and request a full baseline', () => {
  const r = rig()
  r.feed.receive(frame(100, Number.NaN, 'bad'))
  assert.equal(value(r), '100')
  assert.equal(r.feed.cursor?.rev, 100)
  assert.equal(r.errors.length, 1)
  assert.equal(r.loads.length, 1)
})

function table(records: FeedRecord[]): RecordTable {
  const out = new Map<string, Map<string, unknown>>()
  for (const row of records) {
    const rows = out.get(row.entity) ?? new Map<string, unknown>()
    rows.set(row.id, row.body); out.set(row.entity, rows)
  }
  return out
}
const agent = (key: string, name: string, parent_id: string | null, sibling_order = 0): FeedRecord => ({
  entity: 'agent', id: key, body: { id: name, parent_id, sibling_order, children: ['ignored nested child'] },
})

test('tree selector uses surrogate parent links, explicit sibling order, and updated names', () => {
  const records = table([{ entity: 'org', id: 'org', body: { slug: 'org', name: 'Organization' } },
    agent('1', 'renamed-parent', null), agent('2', 'last', '1', 9), agent('3', 'first', '1', 1)])
  const tree = projectTree(records)
  assert.equal(tree.roots[0].id, 'renamed-parent')
  assert.deepEqual(tree.roots[0].children.map(n => n.id), ['first', 'last'])
  assert.equal(agentRecordIds(records).get('renamed-parent'), '1')
  assert.equal(tree.roots[0].children[0].children.length, 0)
})

test('partial sets keep missing parents unknown; cycles and duplicate names are refused', () => {
  const org: FeedRecord = { entity: 'org', id: 'org', body: { slug: 'org', foreground: { partial: true } } }
  assert.equal(projectTree(table([org, agent('2', 'not-loaded-parent', '1')])).roots.length, 0)
  assert.throws(() => projectTree(table([org, agent('1', 'a', '2'), agent('2', 'b', '1')])), /cycle/)
  assert.throws(() => projectTree(table([org, agent('1', 'same', null), agent('2', 'same', null)])), /duplicated/)
  assert.deepEqual(projectOrgs(table([{ entity: 'registry_org', id: '7', body: { slug: 'unavailable', state: 'unavailable' } }])),
    [{ slug: 'unavailable', state: 'unavailable' }])
})
