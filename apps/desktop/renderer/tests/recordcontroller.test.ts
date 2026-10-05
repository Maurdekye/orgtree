import test from 'node:test'
import assert from 'node:assert/strict'
import { RecordFeed } from '../src/recordfeed'
import type { FeedAnswer, FeedCursor, RecordSnapshot, RecordChanges, SubscriptionMessage, FeedState } from '../src/recordfeed'
import type { AgentRuntime } from '../src/recordoverlay'

const cursor = (rev = 1, incarnation = 'first'): FeedCursor => ({ org_uuid: 'org', incarnation, rev })
const row = (id: string, value: unknown = id, set = 'shared') => ({ entity: 'agent', id, body: value, set })
const baseline = (rev = 1, incarnation = 'first'): RecordSnapshot => ({
  type: 'record_snapshot', cursor: cursor(rev, incarnation), records: [row('1')],
})
const changes = (from: number, to: number, upserts = [row('1')], tombstones: RecordChanges['tombstones'] = []): RecordChanges => ({
  type: 'record_changes', ...cursor(to), from, to, upserts, tombstones,
})
const runtime = (seq: number, value: unknown, epoch = 'host', full = false, incarnation = 'first'): AgentRuntime => ({
  type: 'agent_runtime', ...cursor(1, incarnation), epoch, seq, full,
  agents: value === undefined ? {} : { '1': { epoch, seq, busy: value } },
})
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}
function rig(load = true) {
  const loads: ReturnType<typeof deferred<RecordSnapshot>>[] = []
  const reads: { cursor: FeedCursor; subs: unknown; answer: ReturnType<typeof deferred<FeedAnswer>> }[] = []
  const messages: SubscriptionMessage[] = [], errors: Error[] = [], states: FeedState[] = []
  const feed = new RecordFeed({
    snapshot: () => { const d = deferred<RecordSnapshot>(); loads.push(d); return d.promise },
    catchup: (cursor, subs) => { const answer = deferred<FeedAnswer>(); reads.push({ cursor, subs, answer }); return answer.promise },
    project: (records, state) => { states.push(state); if (records.get('agent')?.get('9') === 'bad') throw new Error('bad projection'); return records },
    publish: () => {}, error: e => errors.push(e),
  })
  if (load) feed.receive(baseline())
  const socket = feed.socketOpened(m => messages.push(m))
  const answer = (sub: number, ids: string[], rev = feed.cursor!.rev, incarnation = 'first') =>
    feed.receiveSocket({ type: 'record_subscribed', ...cursor(rev, incarnation), sub,
      records: ids.map(id => row(id, id, `sub:${sub}`)) }, socket)
  const latest = () => messages.filter(m => m.type === 'subscribe').at(-1)!
  return { feed, socket, loads, reads, messages, errors, states, answer, latest }
}
const settle = async () => { for (let n = 0; n < 10; n++) await Promise.resolve() }

test('subscription at unchanged revision adds its full set without an HTTP refetch', () => {
  const r = rig()
  r.feed.subscribe({ agents: ['2'], windows: [{ kind: 'history', agent: '2' }] })
  const sub = r.latest().sub
  r.answer(sub, ['1', '2'])
  assert.deepEqual([...r.feed.records.get('agent')!.keys()], ['1', '2'])
  assert.equal(r.feed.cursor!.rev, 1)
  assert.equal(r.loads.length + r.reads.length, 0)
  assert.deepEqual(r.feed.declarations(), [{ sub, agents: ['2'], windows: [{ kind: 'history', agent: '2' }] }])
})

test('shared departures and unsubscribe preserve other holding sets, with current global bodies', () => {
  const r = rig()
  const a = r.feed.subscribe({ agents: ['1', '2'] }), b = r.feed.subscribe({ agents: ['1', '2'] })
  const [first, second] = r.feed.declarations()
  r.answer(first.sub, ['1', '2']); r.answer(second.sub, ['1', '2'])
  r.feed.receive(changes(1, 2, [row('1', 'new', `sub:${second.sub}`)], [{ entity: 'agent', id: '1' }]))
  a()
  assert.equal(r.feed.records.get('agent')!.get('1'), 'new')
  assert.equal(r.feed.records.get('agent')!.has('2'), true)
  b()
  assert.equal(r.feed.records.get('agent')?.has('1') ?? false, false)
  assert.equal(r.feed.records.get('agent')?.has('2') ?? false, false)
})

test('late answers and deltas cannot resurrect a released or still pending generation', () => {
  const r = rig()
  const release = r.feed.subscribe({ agents: ['2'] }), sub = r.latest().sub
  r.feed.receive(changes(1, 2, [row('2', 'partial', `sub:${sub}`)]))
  assert.equal(r.feed.records.get('agent')?.has('2'), false)
  release(); r.answer(sub, ['2'], 2)
  r.feed.receive(changes(2, 3, [row('2', 'late', `sub:${sub}`)]))
  assert.equal(r.feed.records.get('agent')?.has('2'), false)
  assert.deepEqual(r.feed.declarations(), [])
})

for (const rev of [0, 2]) test(`subscription answer at revision ${rev} is discarded and reissued at a growing generation`, () => {
  const r = rig()
  r.feed.subscribe({ agents: ['2'] })
  const old = r.latest().sub
  r.answer(old, ['2'], rev)
  const next = r.latest().sub
  assert.ok(next > old)
  assert.equal(r.feed.records.get('agent')?.has('2'), false)
  assert.ok(r.messages.some(m => m.type === 'unsubscribe' && m.sub === old))
  r.answer(old, ['2']); r.answer(next, ['2'])
  assert.equal(r.feed.records.get('agent')?.get('2'), '2')
})

test('catch-up declares active and pending sets, never supplies prior membership IDs', async () => {
  const r = rig()
  r.feed.subscribe({ agents: ['2'] }); const a = r.latest().sub; r.answer(a, ['2', '7'])
  r.feed.subscribe({ agents: ['3'] })
  const expected = r.feed.declarations(), read = r.feed.reconnect()
  assert.deepEqual(r.reads[0].subs, expected)
  assert.equal(JSON.stringify(r.reads[0].subs).includes('7'), false)
  r.reads[0].answer.resolve(changes(1, 2, [row('2', 'fresh', `sub:${a}`)]))
  await read
  assert.equal(r.feed.records.get('agent')!.get('2'), 'fresh')
})

test('set replacement at the next revision drops old ancestors atomically while overlaps survive', () => {
  const r = rig()
  r.feed.subscribe({ agents: ['2'] }); const a = r.latest().sub; r.answer(a, ['2', '7'])
  r.feed.subscribe({ agents: ['3'] }); const b = r.latest().sub; r.answer(b, ['3', '7'])
  r.feed.receive({ ...changes(1, 2, []), replacements: [{ set: `sub:${a}`, records: [row('2', 'moved', `sub:${a}`), row('8', 'new parent', `sub:${a}`)] }] })
  assert.equal(r.feed.records.get('agent')!.get('2'), 'moved')
  assert.equal(r.feed.records.get('agent')!.get('8'), 'new parent')
  assert.equal(r.feed.records.get('agent')!.has('7'), true)
  assert.equal(r.feed.memberships.get(`sub:${a}`)!.has(JSON.stringify(['agent', '7'])), false)
})

test('failed projection preserves memberships, bodies, runtime and cursor together', () => {
  const r = rig()
  r.feed.receiveSocket(runtime(1, false, 'host', true), r.socket)
  const records = r.feed.records, memberships = r.feed.memberships, overlay = r.feed.runtime
  r.feed.receive({ ...changes(1, 2, [row('9', 'bad')]), runtime: runtime(2, true) })
  assert.equal(r.feed.records, records)
  assert.equal(r.feed.memberships, memberships)
  assert.equal(r.feed.runtime, overlay)
  assert.equal(r.feed.cursor!.rev, 1)
  assert.equal(r.errors.length, 1)
})

test('reset drops sets immediately and restores desired subscriptions only after a baseline', async () => {
  const r = rig()
  r.feed.subscribe({ agents: ['2'] }); const old = r.latest().sub; r.answer(old, ['2'])
  r.feed.receive({ type: 'record_reset' })
  assert.equal(r.feed.records.get('agent')?.has('2'), false)
  r.answer(old, ['2'])
  assert.equal(r.feed.records.get('agent')?.has('2'), false)
  r.loads[0].resolve(baseline(5)); await settle()
  const next = r.latest().sub; assert.ok(next > old)
  r.answer(next, ['2'], 5)
  assert.equal(r.feed.records.get('agent')?.get('2'), '2')
  assert.equal(r.loads.length, 1)
})

test('new socket fences the old connection and renews desired sets without snapshot reads', () => {
  const r = rig()
  r.feed.subscribe({ agents: ['2'] }); const old = r.latest().sub; r.answer(old, ['2'])
  r.feed.socketClosed(r.socket)
  const token = r.feed.socketOpened(m => r.messages.push(m)), sub = r.latest().sub
  assert.ok(sub > old)
  assert.equal(r.feed.records.get('agent')?.has('2'), false)
  r.feed.receiveSocket(changes(1, 9, [row('1', 'obsolete')]), r.socket)
  assert.equal(r.feed.cursor!.rev, 1)
  r.feed.receiveSocket({ type: 'record_subscribed', ...cursor(), sub, records: [row('2', 'new', `sub:${sub}`)] }, token)
  assert.equal(r.feed.records.get('agent')!.get('2'), 'new')
  assert.equal(r.loads.length, 0)
})

test('runtime received before baseline establishes only the first socket full epoch and stays revision-independent', () => {
  const r = rig(false)
  r.feed.receiveSocket(runtime(4, false, 'host', true), r.socket)
  r.feed.receiveSocket(runtime(5, true), r.socket)
  r.feed.receiveSocket(runtime(999, 'wrong epoch', 'intruder', true), r.socket)
  r.feed.receive({ ...baseline(), runtime: runtime(1000, 'HTTP cannot establish', 'intruder', true) })
  assert.equal(r.feed.runtime.get('1')!.busy, true)
  assert.equal(r.feed.cursor!.rev, 1)
  assert.equal(r.states.at(-1)!.runtime.get('1')!.busy, true)
})

test('delayed HTTP bodies and full runtime cannot rewind a live overlay or resurrect removed values', () => {
  const r = rig()
  r.feed.receiveSocket(runtime(2, false, 'host', true), r.socket)
  r.feed.receiveSocket(runtime(6, true), r.socket)
  r.feed.receive({ ...changes(1, 2), runtime: runtime(4, undefined, 'host', true) })
  assert.equal(r.feed.runtime.get('1')!.busy, true)
  r.feed.receiveSocket(runtime(9, undefined, 'host', true), r.socket)
  r.feed.receive({ ...changes(0, 1), runtime: runtime(8, false) })
  assert.equal(r.feed.runtime.has('1'), false)
  assert.equal(r.feed.cursor!.rev, 2)
})

test('host restart accepts lower sequence only on the next socket and identity replacement clears overlays', () => {
  const r = rig()
  r.feed.receiveSocket(runtime(99, true, 'old', true), r.socket)
  r.feed.receiveSocket(runtime(1, false, 'new', true), r.socket)
  assert.equal(r.feed.runtime.get('1')!.busy, true)
  const token = r.feed.socketOpened(m => r.messages.push(m))
  r.feed.receiveSocket(runtime(1, false, 'new', true), token)
  assert.equal(r.feed.runtime.get('1')!.busy, false)
  r.feed.receive(baseline(0, 'replacement'))
  assert.equal(r.feed.runtime.size, 0)
  r.feed.receiveSocket(runtime(100, true, 'new', false), token)
  assert.equal(r.feed.runtime.size, 0)
})

test('malformed answers and forged runtime cannot partially commit a subscription or overlay', () => {
  const r = rig()
  r.feed.subscribe({ agents: ['2'] }); const sub = r.latest().sub
  r.feed.receiveSocket({ type: 'record_subscribed', ...cursor(), sub, records: [row('2', 'valid', `sub:${sub}`), row('3', 'bad', 'shared')] }, r.socket)
  assert.equal(r.feed.records.get('agent')?.has('2'), false)
  assert.equal(r.errors.length, 1)
})

test('subscription validation is bounded, clones inputs, and dispose retires socket and HTTP work', () => {
  const r = rig(), input = { agents: ['2'], windows: [{ kind: 'history' }] }
  r.feed.subscribe(input); input.agents.push('3'); input.windows[0].kind = 'mutated'
  assert.deepEqual(r.feed.declarations()[0].agents, ['2'])
  assert.equal(r.feed.declarations()[0].windows[0].kind, 'history')
  assert.throws(() => r.feed.subscribe({ agents: ['02'] }), /Invalid/)
  assert.throws(() => r.feed.subscribe({ agents: Array.from({ length: 129 }, (_, n) => String(n + 10)) }), /bound/)
  r.feed.dispose()
  r.feed.receiveSocket(changes(1, 2, [row('1', 'late')]), r.socket)
  assert.equal(r.feed.cursor!.rev, 1)
  assert.throws(() => r.feed.subscribe({}), /disposed/i)
  assert.ok(r.messages.some(m => m.type === 'unsubscribe'))
})
