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

test('reconnect during a baseline catches up after it, with no later commit or frame', async () => {
  const r = rig()
  const load = r.feed.resync()
  void r.feed.reconnect()
  assert.equal(r.catchups.length, 0, 'baseline is still in flight')
  r.loads[0].resolve(snapshot(103, '103'))
  await load
  assert.deepEqual(r.catchups[0].cursor, cursor(103), 'reconnect must not be swallowed by baseline buffering')
  r.catchups[0].answer.resolve(frame(103, 104, '104'))
  await settle()
  fullLoad(r.feed, snapshot(104, '104'))
})

test('reconnect starts a new catch-up even when an older HTTP snapshot is still in flight', async () => {
  const r = rig()
  r.feed.receive(frame(102, 103, '103'))
  const reconnected = r.feed.reconnect()
  assert.equal(r.catchups.length, 2)
  r.catchups[1].answer.resolve(frame(100, 105, '105'))
  await reconnected
  r.catchups[0].answer.resolve(frame(100, 103, '103'))
  await settle()
  fullLoad(r.feed, snapshot(105, '105'))
})

test('tree selector preserves the engine-provided archived defaults and row overrides', () => {
  const records = table([{ entity: 'org', id: 'org', body: { slug: 'org',
    archived_defaults: { busy: false, documents: [], mail_pending: 0 } } },
    { entity: 'agent', id: '1', body: { id: 'summary', parent_id: null, detail: false, mail_pending: 3 } }])
  const row = projectTree(records).roots[0]
  assert.equal(row.busy, false)
  assert.equal(row.mail_pending, 3)
  assert.deepEqual(row.documents, [])
})

/** Coalescing server oracle: changes name keys; bodies always come from the to snapshot. */
class FakeServer {
  rev = 0
  rows = new Map<string, FeedRecord>()
  changes: { rev: number; entity: string; id: string }[] = []
  write(entity: string, id: string, body?: unknown) {
    ++this.rev
    const key = JSON.stringify([entity, id])
    if (body === undefined) this.rows.delete(key)
    else this.rows.set(key, { entity, id, body })
    this.changes.push({ rev: this.rev, entity, id })
  }
  snapshot(): RecordSnapshot {
    return { type: 'record_snapshot', cursor: cursor(this.rev), records: [...this.rows.values()] }
  }
  after(from: number): RecordChanges {
    const changed = new Map(this.changes.filter(row => row.rev > from)
      .map(row => [JSON.stringify([row.entity, row.id]), row]))
    const upserts: FeedRecord[] = [], tombstones: RecordChanges['tombstones'] = []
    for (const [key, row] of changed) {
      const body = this.rows.get(key)
      if (body) upserts.push(body)
      else tombstones.push({ entity: row.entity, id: row.id })
    }
    return { type: 'record_changes', ...cursor(this.rev), from, to: this.rev, upserts, tombstones }
  }
}

test('server-coalesced reordering, overlap and lost notifications converge exactly to a final full load', async () => {
  const server = new FakeServer()
  const errors: Error[] = []
  const feed = new RecordFeed({ snapshot: async () => server.snapshot(),
    catchup: async c => server.after(c.rev), project: r => r,
    publish: () => {}, error: e => errors.push(e) })
  await feed.resync()
  for (let n = 0; n < 25; n++) {
    const start = server.rev
    server.write('a', String(n % 4), { value: n })
    const older = server.after(start)
    server.write('b', String(n % 3), [n])
    if (n % 2 === 0) server.write('a', String(n % 4)) // update then delete becomes tombstone
    const overlapping = server.after(Math.max(0, start - 2))
    if (n % 3 !== 0) { // lose some notifications entirely
      feed.receive(overlapping)
      feed.receive(older)
      feed.receive(overlapping)
    }
    await settle()
  }
  await feed.reconnect() // the final lost notification needs no later write
  assert.deepEqual(feed.cursor, server.snapshot().cursor)
  const serialized = (records: FeedRecord[]) => [...records].sort((a, b) =>
    JSON.stringify([a.entity, a.id]).localeCompare(JSON.stringify([b.entity, b.id])))
  const held = [...feed.records].flatMap(([entity, rows]) => [...rows].map(([id, body]) => ({ entity, id, body })))
  assert.deepEqual(serialized(held), serialized(server.snapshot().records))
  assert.deepEqual(errors, [])
})

test('invalid tree projection leaves both records and cursor at their previous baseline', async () => {
  const initial: RecordSnapshot = { type: 'record_snapshot', cursor: cursor(1), records: [
    { entity: 'org', id: 'org', body: { slug: 'org' } }, agent('1', 'a', null),
  ] }
  const feed = new RecordFeed({ snapshot: async () => initial, catchup: async () => initial,
    project: projectTree, publish: () => {}, error: () => {} })
  feed.receive(initial)
  const prior = feed.records
  feed.receive({ type: 'record_changes', ...cursor(2), from: 1, to: 2,
    upserts: [agent('1', 'a', '1')], tombstones: [] })
  assert.equal(feed.cursor?.rev, 1)
  assert.equal(feed.records, prior)
  await settle()
  assert.equal(projectTree(feed.records).roots[0].id, 'a')
})
