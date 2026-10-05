import test from 'node:test'
import assert from 'node:assert/strict'
import { RecordTreeSelection } from '../src/recordtreeselection'
import type { SelectionAnswer, SelectionRequest } from '../src/recordtreeselection'
import { RecordFeed } from '../src/recordfeed'
import type { SubscriptionMessage } from '../src/recordfeed'
import type { TreeSelection } from '../src/treeview'

const first = { org_uuid: 'org', incarnation: 'first', rev: 1 }
const idle = async () => { for (let n = 0; n < 8; n++) await Promise.resolve() }
const selected = (extra: Partial<TreeSelection> = {}): TreeSelection => ({ include: [], hideRetired: true, fronts: {}, ...extra })
function rig() {
  const requests: { request: SelectionRequest; answer: (answer: SelectionAnswer) => void }[] = []
  const messages: SubscriptionMessage[] = [], errors: Error[] = []
  let recovery = 0
  const feed = new RecordFeed({ snapshot: async () => { throw new Error('Unexpected baseline') },
    catchup: async () => { throw new Error('Unexpected catchup') }, project: r => r, publish: () => {}, error: e => errors.push(e) })
  feed.receive({ type: 'record_snapshot', cursor: first, records: [] })
  feed.socketOpened(m => messages.push(m))
  const selection = new RecordTreeSelection(feed, request => new Promise(answer => requests.push({ request, answer })),
    () => { recovery++ }, e => errors.push(e))
  const answer = (names: Record<string, string> = {}, missing: string[] = [], matches: string[] = [], cursor = first) =>
    requests.at(-1)!.answer({ cursor, names, missing, matches })
  const advance = (from: number, to: number) => feed.receive({ type: 'record_changes', ...first, from, to, upserts: [], tombstones: [] })
  const close = () => { selection.dispose(); feed.dispose() }
  return { requests, messages, errors, feed, selection, answer, advance, close, recovery: () => recovery }
}

test('300 UI names resolve once and split into bounded stable-ID subscriptions', async () => {
  const r = rig(), names = Object.fromEntries(Array.from({ length: 300 }, (_, n) => [`name-${n}`, String(n + 1)]))
  r.selection.set(selected({ include: Object.keys(names) }))
  assert.equal(r.requests[0].request.names.length, 300)
  r.answer(names); await idle()
  assert.deepEqual(r.feed.declarations().map(d => d.agents.length), [128, 128, 44])
  assert.deepEqual(new Set(r.feed.declarations().flatMap(d => d.agents)), new Set(Object.values(names)))
  r.advance(1, 2); await idle()
  assert.equal(r.requests.length, 1, 'record publication never causes a selection refetch')
  r.selection.set(selected()); r.answer({}, [], [], { ...first, rev: 2 }); await idle()
  assert.equal(r.feed.declarations().length, 0)
  assert.equal(r.messages.filter(m => m.type === 'unsubscribe').length, 3)
  r.close()
})

test('archive browsing, children and chosen fronts use their own set declarations', async () => {
  const r = rig()
  r.selection.set(selected({ browse: { kind: 'all' } })); r.answer(); await idle()
  assert.deepEqual(r.feed.declarations()[0].windows, [{ kind: 'archived_all' }])
  r.selection.set(selected({ browse: { kind: 'children', parent: 'boss' }, hideRetired: false, fronts: { boss: 'old' } }))
  assert.deepEqual(r.requests.at(-1)!.request.names, ['boss', 'old'])
  r.answer({ boss: '1', old: '9' }); await idle()
  assert.deepEqual(r.feed.declarations().map(d => [d.agents, d.windows]), [[['1', '9'], []], [[], [{ kind: 'archived_under', parent: '1' }]]])
  r.selection.set(selected({ browse: { kind: 'children', parent: '' } })); r.answer(); await idle()
  assert.deepEqual(r.feed.declarations()[0].windows, [{ kind: 'archived_under', parent: '0' }])
  r.close()
})

test('a missing child-browser parent never becomes a roots subscription and retries on a new revision', async () => {
  const r = rig()
  r.selection.set(selected({ browse: { kind: 'children', parent: 'missing' } }))
  r.answer({}, ['missing']); await idle()
  assert.equal(r.feed.declarations().length, 0); assert.equal(r.requests.length, 1)
  r.advance(1, 2); await idle()
  assert.equal(r.requests.length, 2)
  r.answer({ missing: '11' }, [], [], { ...first, rev: 2 }); await idle()
  assert.deepEqual(r.feed.declarations()[1].windows, [{ kind: 'archived_under', parent: '11' }])
  r.close()
})

test('missing prototype-named parent is still missing, never an inherited window argument', async () => {
  const r = rig()
  r.selection.set(selected({ browse: { kind: 'children', parent: '__proto__' } }))
  r.answer({}, ['__proto__']); await idle()
  assert.equal(r.feed.declarations().length, 0); assert.equal(r.errors.length, 0)
  r.close()
})

test('delayed previous selections and disposed owners cannot reinstall pins', async () => {
  const r = rig()
  r.selection.set(selected({ include: ['old'] }))
  r.selection.set(selected({ include: ['new'] }))
  r.requests[0].answer({ cursor: first, names: { old: '1' }, missing: [], matches: [] }); await idle()
  assert.equal(r.feed.declarations().length, 0)
  assert.deepEqual(r.requests[1].request.names, ['new'])
  r.selection.dispose(); r.answer({ new: '2' }); await idle()
  assert.equal(r.feed.declarations().length, 0); r.feed.dispose()
})

test('ahead selection waits for stream catchup; a surpassed answer is re-resolved', async () => {
  const r = rig()
  r.selection.set(selected({ include: ['pin'] }))
  r.answer({ pin: '8' }, [], [], { ...first, rev: 3 }); await idle()
  assert.equal(r.recovery(), 1); assert.equal(r.feed.declarations().length, 0)
  r.advance(1, 3); await idle()
  assert.deepEqual(r.feed.declarations()[0].agents, ['8'])
  r.selection.set(selected({ include: ['other'] }))
  r.advance(3, 4); r.answer({ other: '9' }, [], [], { ...first, rev: 3 }); await idle()
  assert.equal(r.requests.length, 3)
  r.answer({ other: '10' }, [], [], { ...first, rev: 4 }); await idle()
  assert.deepEqual(r.feed.declarations()[0].agents, ['10'])
  r.close()
})

test('a replaced org at lower revision fences the old selection and resolves anew', async () => {
  const r = rig(), replacement = { ...first, incarnation: 'replacement', rev: 0 }
  r.selection.set(selected({ include: ['pin'] }))
  r.feed.receive({ type: 'record_snapshot', cursor: replacement, records: [] })
  r.answer({ pin: '1' }); await idle()
  assert.equal(r.feed.declarations().length, 0); assert.equal(r.requests.length, 2)
  r.answer({ pin: '7' }, [], [], replacement); await idle()
  assert.deepEqual(r.feed.declarations()[0].agents, ['7']); r.close()
})

test('replacement releases already installed pins before resolving reused database IDs', async () => {
  const r = rig()
  r.selection.set(selected({ include: ['pin'] })); r.answer({ pin: '1' }); await idle()
  const old = r.feed.declarations()[0].sub
  r.feed.receive({ type: 'record_snapshot', cursor: { ...first, incarnation: 'new', rev: 0 }, records: [] })
  assert.equal(r.feed.declarations().length, 0, 'old key is never declared in the new incarnation')
  assert.ok(r.messages.some(m => m.type === 'unsubscribe' && m.sub === old))
  r.answer({ pin: '3' }, [], [], { ...first, incarnation: 'new', rev: 0 }); await idle()
  assert.deepEqual(r.feed.declarations()[0].agents, ['3']); r.close()
})

test('search results remain one-shot even when missing pins retry or bodies change', async () => {
  const r = rig(), browse = { kind: 'search' as const, query: 'retired', state: 'archived' as const }
  r.selection.set(selected({ include: ['missing'], browse }))
  assert.deepEqual(r.requests[0].request.search, { query: 'retired', state: 'archived' })
  r.answer({}, ['missing'], ['41', '42']); await idle()
  r.advance(1, 2); await idle()
  assert.equal(r.requests[1].request.search, undefined)
  r.answer({ missing: '3' }, [], [], { ...first, rev: 2 }); await idle()
  assert.deepEqual(r.feed.declarations()[0].agents, ['3', '41', '42'])
  r.advance(2, 3); await idle(); assert.equal(r.requests.length, 2)
  r.close()
})

test('unchanged declaration keeps its generation; malformed mapping never installs a set', async () => {
  const r = rig()
  r.selection.set(selected({ include: ['pin'] })); r.answer({ pin: '4' }); await idle()
  const generation = r.feed.declarations()[0].sub
  r.selection.set(selected({ include: ['pin'], hideRetired: false })); r.answer({ pin: '4' }); await idle()
  assert.equal(r.feed.declarations()[0].sub, generation)
  r.selection.set(selected({ include: ['bad'] })); r.answer({ bad: '0005' }); await idle()
  assert.equal(r.errors.length, 1); assert.equal(r.feed.declarations()[0].sub, generation)
  r.close()
})
