import './harness'
import { mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { EventCard } from '../src/events/card'
import { noticeSummary } from '../src/events/change'
import { isEvent } from '../src/events/decode'
import { MailMessage, SegmentList } from '../src/events/segments'
import { SystemRuns, segmentEntries } from '../src/events/systemruns'
import type { KnownEvent } from '../src/events/project'
declare const __SRC_DIR__: string

// USER 2026-10-30 mc5d2672d3cc9 (change-notices-permissions-changed-audience-chan), verbatim: "the "permission
// changed " / "audience chsnged" etc. status update messagss should show inline what exactly chsnged: what in the
// system prompt (a diff), which foldeds were sdded / removed / chsnged, which tools weee added, etc."; meeff02af965d
// "same for all similar update messages". @coordinator-opus macb41248ab05: a notice with no permission parts reads
// "Settings changed". Every change card carries one line naming the change right under its header, on every surface,
// with any further detail (long lists, an instructions diff) in a closed fold beneath it.

const fixture = (name: string) => JSON.parse(readFileSync(path.resolve(__SRC_DIR__, '../tests/fixtures/events', name + '.json'), 'utf8')).private
/** a stored event of `variant` with these fields (the fixture supplies a valid actor and object) */
const ev = (variant: string, fields: Record<string, unknown>, actor?: unknown) =>
  ({ ...fixture(variant), ...(actor ? { actor } : {}), ...fields }) as KnownEvent
const USER = { kind: 'user', id: '@user' }
const flat = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim()

async function card(t: test.TestContext, event: unknown) {
  const view = await mountView(<EventCard org="acme" profile="operator" row={{ ev: event, body: 'STORED BODY', notice: true }} />, h => h)
  t.after(() => view.unmount())
  return view.el
}
const title = (el: HTMLElement) => flat(el.querySelector('.event-head strong')?.textContent)
const line = (el: HTMLElement) => flat(el.querySelector('.event-change-line')?.textContent)

/** each kind's stored event and the one line its card shows */
const LINES: [string, KnownEvent, string][] = [
  ['settings only', ev('access.scope_changed', { by: '@user', changed: ['effort', 'fast_mode'],
    values: [{ key: 'effort', from: 'high', to: 'max' }, { key: 'fast_mode', from: 'off', to: 'on' }] }, USER),
    'Thinking effort: high → max · Fast mode: off → on'],
  ['the other settings', ev('access.scope_changed', { by: 'boss', changed: ['model_version', 'account_fallback', 'harness', 'session', 'peer_mail', 'auto_cheap_compact'],
    values: [{ key: 'model_version', from: null, to: 'claude-opus-5-5' }, { key: 'account_fallback', from: 'off', to: 'on' },
      { key: 'harness', from: null, to: 'codex-cli' }, { key: 'session', from: null, to: 'session0' },
      { key: 'peer_mail', from: 'on', to: 'off' }, { key: 'auto_cheap_compact', from: null, to: 'on at 25%' }] }),
    'Model version: latest → claude-opus-5-5 · Switch accounts when limited: off → on · Harness: default → codex-cli'
    + ' · Desktop session: default → Always Session 0 · Subordinates may message each other: on → off'
    + ' · Start fresh when needed: default → on at 25%'],
  ['file access', ev('access.scope_changed', { by: 'boss', changed: ['permission_mode'],
    values: [{ key: 'permission_mode', from: 'acceptEdits', to: 'bypassPermissions' }] }),
    'File access: Allow normal changes → Unrestricted access'],
  ['account applied', ev('access.scope_changed', { by: 'boss', changed: ['account'],
    values: [{ key: 'account', from: 'claude-5', to: 'claude/primary' }] }), 'Account: claude-5 → claude/primary'],
  ['account queued', ev('access.scope_changed', { by: 'boss', changed: ['account'],
    values: [{ key: 'account', from: 'claude-5', to: 'claude/primary' }], pending: 'queued' }),
    'Account: claude-5 → claude/primary when the current turn ends'],
  ['account change cancelled', ev('access.scope_changed', { by: 'boss', changed: ['account'],
    values: [{ key: 'account', from: 'claude-5', to: 'claude/primary' }], pending: 'cancelled' }),
    'Account: change to claude/primary cancelled, stays claude-5'],
  ['own team instructions', ev('access.scope_changed', { by: 'boss', changed: ['team_charter'],
    team_charter: { plus: 2, minus: 0, lines: ['@@ -1 +1,3 @@', ' keep', '+one', '+two'] } }), 'Team instructions: +2 −0'],
  ['team instructions from a superior', ev('access.scope_changed', { by: 'lead', changed: ['team_charter'], cascade_for: 'lead',
    team_charter: { plus: 1, minus: 1, lines: ['@@ -1 +1 @@', '-old', '+new'] } }), 'Team instructions from @lead: +1 −1'],
  ['folders a descendant lost', ev('access.scope_changed', { by: 'boss', changed: ['folders'], cascade_for: 'lead',
    folders: { added: [], changed: [], removed: [{ path: 'D:\\shared', mode: 'rw' }] } }), 'Folders: − D:\\shared · via @lead'],
  ['an old stored notice', ev('access.scope_changed', { by: 'boss', changed: ['folders', 'tools'] }), 'Changed: folders, tools'],
  ['audience granted', ev('access.audience_changed', { outcome: 'audience_with', by: 'boss', target: 'rig', other: null }),
    'Granted: audience with @rig'],
  ['user audience granted', ev('access.audience_changed', { outcome: 'user_audience', by: '@user', target: '@user', other: null }),
    'Granted: audience with the user'],
  ['audience to you', ev('access.audience_changed', { outcome: 'audience_from', by: 'boss', target: 'worker', other: 'peer' }),
    'Granted: @peer may message you'],
  ['org mailbox', ev('access.audience_changed', { outcome: 'org_inbox', by: '@user', target: '@extern', other: null }),
    'Granted: the org mailbox'],
  ['org mailbox released', ev('access.audience_changed', { outcome: 'org_inbox_released', by: 'worker', target: '@extern', other: null }),
    'Released: the org mailbox'],
  ['rescinded, project route remains', ev('access.audience_changed', { outcome: 'rescinded', by: 'boss', target: '@user', other: 'build-slot' }),
    'Rescinded: audience with the user · still reachable through project @build-slot'],
  ['rescinded, nothing remains', ev('access.audience_changed', { outcome: 'rescinded', by: 'boss', target: 'rig', other: '' }),
    'Rescinded: audience with @rig · no project route remains'],
  ['audience declined', ev('access.audience_changed', { outcome: 'declined', by: '@user', target: '@user', other: null }),
    'Declined: audience with the user'],
  ['audience decision', ev('decision.audience', { granted: false, target: 'rig', decided_by: 'boss' }), 'Declined: audience with @rig'],
  ['own grant', ev('access.grant_changed', { relation: 'self', node: 'worker', delta: 2, now: 6, free: 4, by: 'boss' }),
    'Grant: +2 → 6 (4 free)'],
  ['a report\'s grant', ev('access.grant_changed', { relation: 'report', node: 'kid', delta: -1, now: 3, free: 3, by: 'boss' }),
    '@kid\'s grant: −1 → 3'],
  ['credit decision', ev('decision.credit', { outcome: 'counter', old: 2, asked: 10, granted: 5, now: 5 }),
    'Countered: asked 10, granted 5 · 2 → 5'],
  ['credit declined', ev('decision.credit', { outcome: 'declined', old: 2, asked: 10, granted: null, now: null }), 'Declined: asked 10'],
  ['model switched', ev('lifecycle.model_switched', { old: 'opus', new: 'sol', crossed: true }), 'Model: opus → sol · new provider session'],
  ['model switched, same provider', ev('lifecycle.model_switched', { old: 'opus', new: 'sonnet', crossed: false }), 'Model: opus → sonnet'],
  ["a report's model switched", ev('lifecycle.model_switched', { relation: 'report', node: 'kid', old: 'opus', new: 'sol', crossed: false }),
    "@kid's model: opus → sol"],
  ['model change queued', ev('lifecycle.switch_queued', { old: 'opus', new: 'sol' }), 'Model: opus → sol when the current turn ends'],
  ['model change cancelled', ev('lifecycle.switch_cancelled', { target: 'sol' }), 'Model: queued change to sol cancelled'],
  ['model change dropped', ev('lifecycle.switch_dropped', { target: 'sol', kept: 'opus', reason: 'no such account' }),
    'Model: change to sol dropped, stays opus'],
  ['renamed', ev('lifecycle.renamed', { old: 'alpha', new: 'beta', by: 'boss' }), 'Name: alpha → beta'],
  ['moved', ev('lifecycle.moved', { node: 'worker', from_parent: 'alpha', to_parent: null, role: 'self', by: 'boss', tail: null }),
    'Reports to: @alpha → the user'],
  ['a report moved away', ev('lifecycle.moved', { node: 'kid', from_parent: 'alpha', to_parent: 'beta', role: 'old_parent', by: 'boss', tail: null }),
    '@kid reports to: @alpha → @beta'],
  ['hired', ev('lifecycle.hired', { node: 'kid', relation: 'report', tier: 'opus', grant: 4, parent: 'boss', why: null }),
    '@kid hired under @boss · opus · grant 4'],
  ['rehired', ev('lifecycle.rehired', { node: 'kid', relation: 'report', grant: 4 }), '@kid rehired · grant 4'],
  ['retired', ev('lifecycle.retired', { node: 'kid', relation: 'report', freed: 5 }), '@kid retired · 5 credits freed'],
  ['hire rescinded', ev('lifecycle.rescinded', { node: 'kid', clawed: 3 }), '@kid\'s hire rescinded · 3 credits returned'],
  ['team dissolved', ev('lifecycle.dissolved', { node: 'kid', relation: 'report', nodes: 3, freed: 2.5 }),
    '@kid\'s team dissolved · 3 agents · 2.5 credits freed'],
  ['deleted', ev('lifecycle.deleted', { node: 'kid', relation: 'report', extra: 2 }), '@kid deleted, with 2 below'],
  ['seats exchanged', ev('lifecycle.seat_swapped', { a: 'x', b: 'y' }), 'Seats: @x ⇄ @y'],
  ['subtree promoted', ev('lifecycle.subtree_promoted', { promoted: 'p', demoted: 'd' }), '@p now above @d'],
  ['superior inserted', ev('lifecycle.inserted', { node: 'n', above: 'a' }), '@n inserted above @a'],
  ['compacted', ev('lifecycle.compacted', { relation: 'self', auto: true }), 'Conversation compacted automatically'],
  ['compacted on request', ev('lifecycle.compacted', { relation: 'self', auto: false }), 'Conversation compacted on request'],
  ['a report compacted', ev('lifecycle.compacted', { relation: 'report', node: 'kid', auto: true }), "@kid's conversation compacted automatically"],
  ['session reset', ev('lifecycle.cheap_compacted', { relation: 'self' }), 'Fresh session; the previous one stays in history'],
  ["a report's session reset", ev('lifecycle.cheap_compacted', { relation: 'report', node: 'kid' }),
    '@kid has a fresh session; the previous one stays in history'],
  ['capacity reset', ev('policy.limit_reset', { relation: 'self', released: ['frozen'] }), 'Released: frozen'],
  ["a report's capacity reset", ev('policy.limit_reset', { relation: 'report', node: 'kid', released: ['frozen'] }), '@kid released: frozen'],
]

for (const [name, event, expected] of LINES) {
  test(`RED ${name}: the card names the change on one line under its header`, async t => {
    assert.ok(isEvent(event), `${name}: the stored event decodes`)
    const el = await card(t, event)
    assert.equal(line(el), expected)
    // the line sits right under the header, before the body and the Context fold
    const change = el.querySelector('.event-change')!
    assert.ok(change.previousElementSibling?.matches('.event-head'), `${name}: the line follows the header`)
    // the inbox list row and jump labels read the same line
    assert.equal(flat(noticeSummary(event)), expected, `${name}: list preview`)
  })
}

test('RED a permissions change names every folder, tool and setting, with the instructions diff folded beneath', async t => {
  const event = ev('access.scope_changed', { by: 'boss', changed: ['folders', 'tools', 'org_visibility', 'charter'],
    folders: { added: [{ path: 'D:\\work', mode: 'rw' }], changed: [{ path: 'D:\\docs', from: 'rw', to: 'ro' }],
      removed: [{ path: 'E:\\old', mode: 'rw' }] },
    tools: { added: ['mcp:github'], removed: ['web'] },
    values: [{ key: 'org_visibility', from: 'team', to: 'subtree' }],
    charter: { plus: 1, minus: 1, lines: ['@@ -1,3 +1,3 @@', ' keep', '-old rule', '+new rule', ' tail'] } })
  const el = await card(t, event)
  assert.equal(title(el), 'Permissions changed')
  assert.equal(line(el), 'Folders: + D:\\work (read-write), − E:\\old, D:\\docs read-write → read-only'
    + ' · Tools: + MCP server github, − Browse the web · Visible agents: Its team → Its team and all reports · Instructions: +1 −1')
  const fold = el.querySelector<HTMLDetailsElement>('details.event-change')!
  assert.ok(fold, 'the line is the summary of a fold')
  assert.equal(fold.open, false, 'the details start folded')
  assert.ok(fold.querySelector(':scope > summary.event-change-line'), 'the line is the fold summary')
  // drawn exactly like an Edit tool call's diff (canvas/desk.tsx)
  const pre = fold.querySelector('[data-change-part="charter"] pre.filepre.diffpre')!
  assert.ok(pre, 'the instructions diff is a diffpre')
  assert.deepEqual([...pre.children].map(l => [l.className, l.textContent]),
    [['dhunk', '@@ -1,3 +1,3 @@'], ['', ' keep'], ['dminus', '-old rule'], ['dplus', '+new rule'], ['', ' tail']])
  // the header no longer repeats the categories; Context keeps who did it
  assert.equal(el.querySelector('.event-head [data-event-field="changed"]'), null)
  assert.ok(el.querySelector('.event-context [data-event-field="by"]'))
})

test('RED a settings change with no permission part is titled "Settings changed"', async t => {
  const el = await card(t, LINES.find(([n]) => n === 'settings only')![1])
  assert.equal(title(el), 'Settings changed')
  for (const part of ['folders', 'tools', 'org_visibility', 'permission_mode', 'charter']) {
    const event = ev('access.scope_changed', { by: 'boss', changed: [part] })
    const view = await card(t, event)
    assert.equal(title(view), 'Permissions changed', part)
  }
})

test('RED a long folder list counts on the line and lists every folder in the fold', async t => {
  const paths = ['D:\\a', 'D:\\b', 'D:\\c', 'D:\\d']
  const el = await card(t, ev('access.scope_changed', { by: 'boss', changed: ['folders'],
    folders: { added: paths.map(path => ({ path, mode: 'ro' })), changed: [], removed: [] } }))
  assert.equal(line(el), 'Folders: 4 added')
  const items = [...el.querySelectorAll('details.event-change [data-change-part="folders"] li')].map(li => flat(li.textContent))
  assert.deepEqual(items, paths.map(p => `+ ${p} (read-only)`))
})

test('RED a dropped account change keeps its reason in the fold', async t => {
  const el = await card(t, ev('access.scope_changed', { by: 'boss', changed: ['account'], pending: 'dropped', reason: 'no account claude-9',
    values: [{ key: 'account', from: 'claude-5', to: 'claude-9' }] }))
  assert.equal(line(el), 'Account: change to claude-9 dropped, stays claude-5')
  assert.match(flat(el.querySelector('details.event-change')?.textContent), /no account claude-9/)
})

test('RED header fields that only restated the change move into Context', async t => {
  const audience = await card(t, LINES.find(([n]) => n === 'audience granted')![1])
  assert.doesNotMatch(flat(audience.querySelector('.event-head')!.textContent), /Outcome|audience_with/)
  const model = await card(t, LINES.find(([n]) => n === 'model switched')![1])
  assert.doesNotMatch(flat(model.querySelector('.event-head')!.textContent), /Before|After/)
  const grant = await card(t, LINES.find(([n]) => n === 'own grant')![1])
  assert.doesNotMatch(flat(grant.querySelector('.event-head')!.textContent), /Change:|Current total/)
  // the dropped switch keeps its reason in the body
  const dropped = await card(t, LINES.find(([n]) => n === 'model change dropped')![1])
  assert.match(flat(dropped.querySelector('.event-body')!.textContent), /no such account/)
})

test('RED the same line on the transcript notice row and in the mailbox reader', async t => {
  const event = LINES.find(([n]) => n === 'settings only')![1]
  const expected = LINES.find(([n]) => n === 'settings only')![2]
  const transcript = await mountView(<SegmentList slug="acme" nid="worker" profile="operator" segments={[
    { kind: 'notices', rows: [{ at: '2026-10-30T17:00:00Z', text: 'agent text', ev: event }] }]} />, h => h)
  t.after(() => transcript.unmount())
  assert.equal(line(transcript.el), expected)
  const reader = await mountView(<MailMessage slug="acme" nid="worker" profile="operator"
    row={{ id: 'm1', from: '@system', kind: 'system', notice: true, body: 'agent text', at: '2026-10-30T17:00:00Z', ev: event }} />, h => h)
  t.after(() => reader.unmount())
  assert.equal(line(reader.el), expected)
})

test('RED a folded run of notices lists each change in its tooltip', async t => {
  const first = LINES.find(([n]) => n === 'settings only')!, second = LINES.find(([n]) => n === 'audience granted')!
  // passive system mail folds into a run (a notice-segment row an agent or the user authored stays its own card)
  const mail = (id: string, ev: KnownEvent) => ({ id, from: '@system', kind: 'system', notice: true, body: 'agent text', at: '2026-10-30T17:00:00Z', ev })
  const entries = segmentEntries([{ kind: 'mail', rows: [mail('n1', first[1]), mail('n2', second[1])] }])
  const view = await mountView(<SystemRuns entries={entries} render={e => <div key={e.key}>{e.label}</div>} />, h => h)
  t.after(() => view.unmount())
  const kinds = view.el.querySelector('.system-run-kinds')
  assert.ok(kinds, 'the two notices fold into one run')
  const tip = kinds.getAttribute('title') ?? ''
  assert.match(tip, new RegExp(first[2].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(tip, /Granted: audience with @rig/)
})

test('RED the schema stays closed: an unlisted member or setting key does not decode', () => {
  const good = LINES.find(([n]) => n === 'account applied')![1] as unknown as Record<string, unknown>
  assert.equal(isEvent(good), true)
  assert.equal(isEvent({ ...good, values: [{ key: 'account', from: 'a', to: 'b', token: 'SECRET' }] }), false)
  assert.equal(isEvent({ ...good, values: [{ key: 'api_key', from: 'a', to: 'b' }] }), false)
  assert.equal(isEvent({ ...good, folders: { added: [], changed: [], removed: [], env: {} } }), false)
})
