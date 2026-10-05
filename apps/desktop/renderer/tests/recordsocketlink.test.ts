import test from 'node:test'
import assert from 'node:assert/strict'
import { RecordFeed } from '../src/recordfeed'
import { RecordSocketLink } from '../src/recordsocketlink'
import type { RecordSnapshot } from '../src/recordfeed'

const cursor = { org_uuid: 'org', incarnation: 'first', rev: 1 }
const snapshot: RecordSnapshot = { type: 'record_snapshot', cursor, records: [] }
const runtime = (seq: number, count: number, epoch = 'host') => ({
  type: 'agent_runtime' as const, ...cursor, epoch, seq, full: true,
  agents: { '1': { epoch, seq, mcp_tool_count: count } },
})
function rig() {
  const loads: (() => void)[] = [], errors: Error[] = []
  const feed = new RecordFeed({
    snapshot: () => new Promise<RecordSnapshot>(resolve => loads.push(() => resolve(snapshot))),
    catchup: async () => { throw new Error('unexpected catch-up') },
    project: rows => rows, publish: () => {}, error: e => errors.push(e),
  })
  return { feed, loads, errors, link: new RecordSocketLink() }
}

test('connection buffers its first full runtime before detection and before the HTTP baseline', async () => {
  const r = rig(), connection = r.link.open(() => {})
  r.link.receive(runtime(8, 8), connection)
  r.link.receive(runtime(999, 999, 'intruder'), connection)
  const read = r.feed.resync()
  r.link.attach(r.feed)
  r.loads[0](); await read
  assert.equal(r.feed.runtime.get('1')?.mcp_tool_count, 8)
  assert.equal(r.feed.cursor?.rev, 1)
  assert.equal(r.errors.length, 0)
  r.feed.dispose()
})

test('old connection frames and closes cannot affect a new socket or its lower host sequence', () => {
  const r = rig()
  r.feed.receive(snapshot); r.link.attach(r.feed)
  const old = r.link.open(() => {})
  r.link.receive(runtime(8, 8), old)
  const next = r.link.open(() => {})
  r.link.receive(runtime(1, 1, 'new host'), next)
  r.link.receive(runtime(999, 999), old); r.link.close(old)
  r.link.receive(runtime(2, 2, 'new host'), next)
  assert.equal(r.feed.runtime.get('1')?.mcp_tool_count, 2)
  assert.equal(r.loads.length, 0)
  r.feed.dispose()
})

test('detach fences the previous org controller while the new one adopts buffered frames', () => {
  const r = rig(), other = rig()
  r.feed.receive(snapshot); r.link.attach(r.feed)
  const connection = r.link.open(() => {})
  r.link.receive(runtime(1, 1), connection)
  r.link.detach(); r.link.receive(runtime(2, 2), connection)
  other.feed.receive(snapshot); r.link.attach(other.feed)
  assert.equal(r.feed.runtime.get('1')?.mcp_tool_count, 1)
  assert.equal(other.feed.runtime.get('1')?.mcp_tool_count, 2)
  r.feed.dispose(); other.feed.dispose()
})

test('overflow resets missed record state without losing the socket epoch anchor', async () => {
  const r = rig(), connection = r.link.open(() => {})
  r.link.receive(runtime(1, 1), connection)
  for (let i = 0; i < 300; i++) r.link.receive({ type: 'record_changes', ...cursor,
    from: i + 1, to: i + 2, upserts: [], tombstones: [] }, connection)
  r.link.attach(r.feed)
  assert.equal(r.loads.length, 1, 'overflow demands a new baseline')
  r.loads[0](); await Promise.resolve(); await Promise.resolve()
  assert.equal(r.feed.runtime.get('1')?.mcp_tool_count, 1, 'HTTP can update the retained host epoch')
  r.feed.dispose()
})

test('replacement baseline requests a new connection but same-identity copies do not', () => {
  let replacements = 0
  const feed = new RecordFeed({ snapshot: async () => snapshot, catchup: async () => snapshot,
    project: rows => rows, publish: () => {}, error: e => { throw e },
    identityChanged: () => { replacements++ } })
  feed.receive(snapshot); feed.receive(snapshot)
  feed.receive({ ...snapshot, cursor: { ...cursor, incarnation: 'replacement', rev: 0 } })
  assert.equal(replacements, 1)
  assert.equal(feed.cursor?.rev, 0)
  feed.dispose()
})
