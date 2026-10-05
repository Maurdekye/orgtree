import test from 'node:test'
import assert from 'node:assert/strict'
import { RecordStore } from '../src/recordstore'
import { RecordOverlay, agentRuntimeFields } from '../src/recordoverlay'
import { projectTree, treeOrgGroups } from '../src/recordprojection'
import type { FeedRecord, RecordTable } from '../src/recordfeed'
import type { AgentRuntime } from '../src/recordoverlay'

const row = (id: string, body: unknown, set = 'shared'): FeedRecord => ({ entity: 'agent', id, body, set })
const held = (state: RecordStore, id: string) => state.records.get('agent')?.get(id)
const identity = { org_uuid: 'org', incarnation: 'first' }
const runtime = (seq: number, agents: Record<string, Record<string, unknown>>, full = false,
  epoch = 'host1'): AgentRuntime => ({ type: 'agent_runtime', ...identity, epoch, seq, full,
  agents: Object.fromEntries(Object.entries(agents).map(([id, fields]) => [id, { epoch, seq, ...fields }])) })

test('shared tombstone retains overlapping subscriptions and the latest set-independent body', () => {
  const initial = new RecordStore().change([row('1', 'old'), row('1', 'old', 'sub:1'), row('1', 'old', 'sub:2')])
  const changed = initial.change([row('1', 'new', 'sub:1')], [{ entity: 'agent', id: '1' }])
  assert.equal(held(changed, '1'), 'new')
  assert.equal(held(initial, '1'), 'old', 'the candidate did not mutate its base')
  assert.equal(held(changed.drop('sub:1'), '1'), 'new')
  assert.equal(held(changed.drop('sub:1').drop('sub:2'), '1'), undefined)
})

test('complete subscription replacement removes departed ancestors but preserves other holding sets', () => {
  const initial = new RecordStore().change([row('1', 'parent', 'sub:1'), row('2', 'pin', 'sub:1'),
    row('1', 'parent'), row('9', 'other', 'sub:2')])
  const next = initial.change([], [], [{ set: 'sub:1', records: [row('2', 'pin moved', 'sub:1'), row('3', 'new parent', 'sub:1')] }])
  assert.equal(held(next, '1'), 'parent')
  assert.equal(held(next, '2'), 'pin moved')
  assert.equal(held(next, '3'), 'new parent')
  assert.equal(held(next, '9'), 'other')
  assert.equal(held(next.change([], [{ entity: 'agent', id: '1' }]), '1'), undefined)
})

test('late entries for unsubscribed and still-pending generations cannot populate the store', () => {
  const onlyShared = (set: string) => set === 'shared'
  const state = new RecordStore().change([row('1', 'shared'), row('2', 'late', 'sub:4')],
    [], [{ set: 'sub:3', records: [row('9', 'pending', 'sub:3')] }], onlyShared)
  assert.equal(held(state, '1'), 'shared')
  assert.equal(held(state, '2'), undefined)
  assert.equal(held(state, '9'), undefined)
  assert.equal(state.memberships.has('sub:3'), false)
})

test('invalid replacements and record keys leave the previous immutable state unchanged', () => {
  const state = new RecordStore().change([row('1', 'old')])
  assert.throws(() => state.change([row('', 'bad')]), /key/)
  assert.throws(() => state.change([], [], [{ set: 'sub:1', records: [row('1', 'wrong', 'sub:2')] }]), /different set/)
  assert.throws(() => state.drop('sub:9007199254740992'), /generation/)
  assert.throws(() => state.change([], [], [{ set: 'sub:1', records: [] }, { set: 'sub:1', records: [] }]), /Duplicate/)
  assert.equal(held(state, '1'), 'old')
  assert.deepEqual([...state.memberships.keys()], ['shared'])
})

test('HTTP cannot establish an epoch, and a different epoch or org identity is ignored', () => {
  const none = new RecordOverlay(identity)
  assert.equal(none.receive(runtime(4, { '1': { busy: true } }, true)), none)
  const established = none.receive(runtime(4, { '1': { busy: true } }, true), true)
  assert.equal(established.epoch, 'host1')
  assert.equal(established.receive(runtime(99, { '1': { busy: false } }, true, 'other')), established)
  assert.equal(established.receive({ ...runtime(99, { '1': { busy: false } }), incarnation: 'replacement' }, true), established)
})

test('delayed full copies cannot rewind a newer live value or remove it', () => {
  let overlay = new RecordOverlay(identity).receive(runtime(4, { '1': { busy: false }, '2': { busy: false } }, true), true)
  overlay = overlay.receive(runtime(10, { '1': { busy: true }, '3': { waiting: true } }))
  overlay = overlay.receive(runtime(6, { '1': { busy: false } }, true))
  assert.equal(overlay.values.get('1')?.busy, true)
  assert.equal(overlay.values.get('2'), undefined)
  assert.equal(overlay.values.get('3')?.waiting, true)
  assert.equal(overlay.values.get('1')?.seq, 10)
})

test('full-copy removal rejects a delayed partial resurrection, including equal sequence', () => {
  let overlay = new RecordOverlay(identity).receive(runtime(4, { '1': { busy: true } }, true), true)
  overlay = overlay.receive(runtime(8, {}, true))
  overlay = overlay.receive(runtime(7, { '1': { busy: true } }))
  overlay = overlay.receive(runtime(8, { '1': { busy: true } }))
  assert.equal(overlay.values.has('1'), false)
  overlay = overlay.receive(runtime(9, { '1': { busy: false } }))
  assert.equal(overlay.values.get('1')?.busy, false)
})

test('new socket host epoch replaces old state at a lower sequence; same epoch preserves newer live values', () => {
  const original = new RecordOverlay(identity).receive(runtime(20, { '1': { busy: true } }, true), true)
  const same = original.receive(runtime(15, {}, true), true)
  assert.equal(same.values.get('1')?.busy, true)
  const replaced = same.receive(runtime(1, { '2': { waiting: true } }, true, 'host2'), true)
  assert.equal(replaced.values.has('1'), false)
  assert.equal(replaced.values.get('2')?.seq, 1)
  assert.equal(replaced.epoch, 'host2')
  assert.equal(replaced.receive(runtime(100, { '1': { busy: true } })), replaced)
})

test('runtime values cannot overwrite topology, persisted bodies or app-owned values', () => {
  const frame = runtime(2, { '1': { busy: true, parent_id: 'bad', id: 'bad', children: [],
    account_label: 'bad', tasks: [{ id: 'original' }] } }, true)
  const overlay = new RecordOverlay(identity).receive(frame, true)
  frame.agents['1'].tasks = []
  assert.deepEqual(Object.keys(overlay.values.get('1')!).sort(), ['busy', 'epoch', 'seq', 'tasks'])
  assert.deepEqual(overlay.values.get('1')?.tasks, [{ id: 'original' }])
  assert.equal(agentRuntimeFields.has('scope'), false)
})

test('malformed runtime frame does not partly apply values or remove old state', () => {
  const overlay = new RecordOverlay(identity).receive(runtime(1, { '1': { busy: false } }, true), true)
  const malformed = runtime(3, { '1': { busy: true }, '2': { seq: 4 } }, true)
  assert.throws(() => overlay.receive(malformed), /value/)
  assert.equal(overlay.values.get('1')?.busy, false)
  assert.equal(overlay.floor, 1)
})

function groups(fields: Record<string, Record<string, unknown>> = {}): FeedRecord[] {
  return treeOrgGroups.map(id => ({ entity: 'org', id, body: fields[id] ?? {} }))
}
const agent = (id: string, name: string, parent_id: string | null, fields: Record<string, unknown> = {}) =>
  row(id, { id: name, parent_id, state: 'live', ui_order: 0, created: '', ord: 0, ...fields })
const table = (records: FeedRecord[]): RecordTable => new RecordStore().change(records).records

test('R1 merges all twelve org groups, including future-visible fields, without silent collisions', () => {
  const fields: Record<string, Record<string, unknown>> = Object.fromEntries(
    treeOrgGroups.map((group, i) => [group, { ['value' + i]: i }]))
  fields.settings.slug = 'org'
  const projected = projectTree(table(groups(fields))) as unknown as Record<string, unknown>
  for (let i = 0; i < treeOrgGroups.length; i++) assert.equal(projected['value' + i], i)
  assert.throws(() => projectTree(table(groups(fields).slice(1))), /missing org group: settings/)
  assert.throws(() => projectTree(table(groups({ settings: { slug: 'org' }, net: { slug: 'other' } }))), /repeat/)
})

test('R2 sorts by ui_order, created, ordinal and Python Unicode name order, never database ID or locale', () => {
  const records = table([...groups({ settings: { slug: 'org' } }),
    agent('1', '\u{10000}', null, { created: 'b', ord: 2 }),
    agent('9', '\ue000', null, { created: 'b', ord: 2 }),
    agent('3', 'earlier ordinal', null, { created: 'b', ord: 1 }),
    agent('4', 'earlier date', null, { created: 'a', ord: 99 }),
    agent('5', 'earlier order', null, { ui_order: -1, created: 'z' })])
  assert.deepEqual(projectTree(records).roots.map(n => n.id),
    ['earlier order', 'earlier date', 'earlier ordinal', '\ue000', '\u{10000}'])
})

test('R4 counts distinct subscription-only retired children and roots, excluding successor-bearing lineage', () => {
  const org = groups({ settings: { slug: 'org' }, foreground: { retired_roots_total: 5, retired_total: 20 } })
  const parent = agent('1', 'parent', null, { retired_children_total: 6 })
  const child = { ...agent('2', 'retired child', '1', { state: 'archived' }), set: 'sub:1' }
  const state = new RecordStore().change([...org, parent, child, { ...child, set: 'sub:2' },
    agent('3', 'bearer', '1', { state: 'archived', successor: 'somewhere else', axis: 'lineage' }),
    { ...agent('4', 'root retired', null, { state: 'archived', retired_children_total: 0 }), set: 'sub:1' }])
  const projected = projectTree(state.records)
  const p = projected.roots.find(n => n.id === 'parent')! as typeof projected.roots[0] & { hidden_retired_children: number }
  assert.deepEqual(p.children.map(n => n.id), ['retired child'])
  assert.equal(p.hidden_retired_children, 5)
  assert.equal(projected.foreground?.hidden_retired_roots, 4)
  assert.equal(projected.foreground?.present.includes('bearer'), true)
  assert.equal((projectTree(state.drop('sub:1').records).roots[0] as typeof p).hidden_retired_children, 5)
  assert.equal((projectTree(state.drop('sub:1').drop('sub:2').records).roots[0] as typeof p).hidden_retired_children, 6)
})

test('ordered overlay controls restart ask visibility and context; favourite catalogs merge add-only', () => {
  const records = table([...groups({ settings: { slug: 'org' }, tiers: {
    tiers: { own: 4 }, models: { own: 'persisted' } } }),
    agent('1', 'agent', null, { ask: { status: 'answered' }, context_window: 10, busy: false })])
  const overlay = new RecordOverlay(identity).receive(runtime(1, { '1': {
    ask_linger_visible: false, context_window: 100, busy: true } }, true), true)
  const input = { runtime: overlay.values, favourites: { tiers: { own: 9, other: 2 }, models: { own: 'fav', other: 'new' } } }
  const tree = projectTree(records, input)
  assert.equal(tree.roots[0].ask, null)
  assert.equal(tree.roots[0].context_window, 100)
  assert.equal(tree.roots[0].busy, true)
  assert.deepEqual(tree.tiers, { own: 4, other: 2 })
  assert.deepEqual(tree.models, { own: 'persisted', other: 'new' })
  assert.equal((records.get('agent')?.get('1') as Record<string, unknown>).context_window, 10)
  const shown = overlay.receive(runtime(2, { '1': { ask_linger_visible: true, context_window: 200 } }))
  assert.deepEqual(projectTree(records, { runtime: shown.values }).roots[0].ask, { status: 'answered' })
  assert.deepEqual(projectTree(records, { favourites: {} }).models, { own: 'persisted' })
})

test('projection keeps missing ancestors unknown, detects off-axis cycles and refuses impossible retired totals', () => {
  const org = groups({ settings: { slug: 'org' } })
  assert.equal(projectTree(table([...org, agent('1', 'child', 'missing')])).roots.length, 0)
  assert.throws(() => projectTree(table([...org, agent('1', 'a', '2'),
    agent('2', 'b', '1', { state: 'archived', successor: 'outside' })])), /cycle/)
  assert.throws(() => projectTree(table([...org, agent('1', 'p', null, { retired_children_total: 0 }),
    agent('2', 'r', '1', { state: 'archived' })])), /retired count/)
})
