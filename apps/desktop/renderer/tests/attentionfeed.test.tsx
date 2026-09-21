// attentionfeed.test.tsx — the Attention view's mixed feed, as a model.
//
// The ticket gives the "Needs attention" list three different KINDS of member
// and three different rules for when a member leaves. Those are pure decisions
// over data the renderer already fetches, so they live in `attention/feed.ts`
// as pure functions and are pinned here without a DOM: a rule that can only be
// exercised through a mounted panel is a rule that gets quietly reinterpreted
// the next time the panel is restyled.
//
// What this file defends, in the ticket's own words:
//   • "every ticket currently marked as needing user attention; every unread
//     urgent mail item; and every unanswered question" — and nothing else
//   • "a ticket disappears as soon as its attention request is dismissed"
//   • "an urgent mail item disappears once it has been read and is no longer
//     selected"
//   • "a question disappears as soon as it is answered"
//   • "does not retain stale resolved rows"
// plus the coordinator's 2026-09-21 ruling that a ticket carrying BOTH a
// manual flag and a question produces two independently resolvable rows, while
// a question-only ticket produces only the question.
//
// Run:  node apps/desktop/renderer/tests/run.mjs attentionfeed

import './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import type { AskInfo, MailEntry, TreeNode, TreePayload, WorkItem } from '../src/types'
import {
  attentionNodes, buildAttentionRows, compareRows, countRows, isRetained,
  nextSelection, oneLine, retainSelected,
} from '../src/attention/feed'
import type { AttentionRow } from '../src/attention/feed'

// --------------------------------------------------------------- fixtures
const mkItem = (o: Partial<WorkItem>): WorkItem => ({
  slug: o.title ?? 'item', rev: 1, kind: 'code', title: 'Item', objective: 'o',
  status: 'in_progress', blocked_reason: null, archived: false, archived_at: null,
  owner: { node: 'agent1', generation: 0 }, owner_current: true, owner_state: 'live',
  reviewer: null, participants: [], created_by: { node: 'agent1', generation: 0 },
  at: '2026-09-20T08:00:00.000Z', updated_at: '2026-09-20T09:00:00.000Z',
  done_so_far: [], working_on_next: [], docket_at: null,
  last_updater: null, manual_attention: null, dismissals: [], questions: [],
  effective_attention: false, attention_sources: [], acceptance: [],
  dependencies: [], evidence: [], delivery: null, accepted: null,
  superseded_by: null, history: [],
  ...o,
} as WorkItem)

/** a ticket with the MANUAL flag raised — the ticket flavour's only source */
const flagged = (title: string, at: string, reason = 'please confirm') => mkItem({
  title, slug: title,
  manual_attention: { reason, at, by: { node: 'agent1', generation: 0 }, set_rev: 3 },
  effective_attention: true, attention_sources: ['manual'],
})

/** a ticket whose attention is a QUESTION and nothing else. `effective_attention`
 *  is true on the wire for this shape; the feed must still not list it as a
 *  ticket, because there is no manual flag for a Dismiss to clear. */
const questionOnly = (title: string, at: string) => mkItem({
  title, slug: title, updated_at: at,
  questions: [{ id: 'q1', node: 'agent1', at } as unknown as WorkItem['questions'][number]],
  effective_attention: true, attention_sources: ['question'],
})

const mail = (id: string, at: string, urgent: boolean, reason?: string): MailEntry => ({
  id, from: 'agent1', kind: 'message', body: 'the body of ' + id, at,
  ...(urgent ? { urgent: true, urgent_reason: reason ?? 'the build is down' } : {}),
})

const ask = (id: string, node: string, at: string, status = 'open'): AskInfo => ({
  id, node, status, at, kind: 'question', question: 'ship it?',
})

const nodeWith = (id: string, a?: AskInfo): TreeNode => ({
  id, tier: 'opus', state: 'live', children: [], ...(a ? { ask: a } : {}),
} as unknown as TreeNode)

const keys = (rows: readonly AttentionRow[]) => rows.map((r) => r.key)

// ------------------------------------------------------------------ §1
test('§1 all three flavours land in one list, newest first', () => {
  const rows = buildAttentionRows({
    items: [flagged('ticket-a', '2026-09-20T10:00:00.000Z')],
    pending: [mail('m1', '2026-09-20T12:00:00.000Z', true)],
    nodes: [nodeWith('agent1', ask('a1', 'agent1', '2026-09-20T11:00:00.000Z'))],
  })
  assert.deepEqual(keys(rows), ['mail:m1', 'question:a1', 'ticket:ticket-a'],
    'one mixed list, ordered newest first')
  assert.deepEqual(rows.map((r) => r.kind), ['mail', 'question', 'ticket'])
  assert.deepEqual(countRows(rows), { ticket: 1, mail: 1, question: 1, total: 3 })
})

test('§1.1 nothing else qualifies', () => {
  const rows = buildAttentionRows({
    // an ordinary ticket, a read mail, a NON-urgent unread mail, a resolved ask
    items: [mkItem({ title: 'ordinary', slug: 'ordinary' })],
    pending: [mail('quiet', '2026-09-20T12:00:00.000Z', false)],
    nodes: [nodeWith('agent2', ask('done', 'agent2', '2026-09-20T11:00:00.000Z', 'answered'))],
  })
  assert.deepEqual(keys(rows), [], 'only the three named flavours are members')
})

test('§1.2 a pending ask is open too — the ask card\'s own live states', () => {
  const rows = buildAttentionRows({
    nodes: [nodeWith('a', ask('p', 'a', '2026-09-20T11:00:00.000Z', 'pending'))],
  })
  assert.deepEqual(keys(rows), ['question:p'])
})

test('§1.3 the order is total, so an identical timestamp cannot reshuffle', () => {
  const at = '2026-09-20T10:00:00.000Z'
  const build = () => buildAttentionRows({
    items: [flagged('b-ticket', at), flagged('a-ticket', at)],
    pending: [mail('m', at, true)],
    nodes: [nodeWith('n', ask('q', 'n', at))],
  })
  assert.deepEqual(keys(build()), keys(build()), 'the same input gives the same order')
  const rows = build()
  assert.equal(compareRows(rows[0]!, rows[0]!), 0, 'and a row does not outrank itself')
})

// ------------------------------------------------------------------ §2
test('§2 the ticket flavour is keyed on the MANUAL flag, not effective_attention', () => {
  const rows = buildAttentionRows({
    items: [questionOnly('q-only', '2026-09-20T10:00:00.000Z')],
    nodes: [nodeWith('agent1', ask('a1', 'agent1', '2026-09-20T10:00:00.000Z'))],
  })
  // the ticket carries `effective_attention: true` on the wire, and is STILL
  // not a ticket row: its attention is the question, which is its own row and
  // has its own resolution. A ticket row here would have a dead Dismiss.
  assert.deepEqual(keys(rows), ['question:a1'],
    'a question-only ticket yields only the question row')
})

test('§2.1 a flag AND a question give two independently resolvable rows', () => {
  const at = '2026-09-20T10:00:00.000Z'
  const both = mkItem({
    title: 'both', slug: 'both',
    manual_attention: { reason: 'confirm the cutover', at, by: { node: 'agent1', generation: 0 }, set_rev: 5 },
    questions: [{ id: 'q9', node: 'agent1', at } as unknown as WorkItem['questions'][number]],
    effective_attention: true, attention_sources: ['manual', 'question'],
  })
  const rows = buildAttentionRows({
    items: [both],
    nodes: [nodeWith('agent1', ask('q9', 'agent1', at))],
  })
  assert.equal(rows.length, 2, 'the flag and the question are two demands')
  assert.ok(keys(rows).includes('ticket:both'))
  assert.ok(keys(rows).includes('question:q9'))

  // resolving ONE leaves the other standing, which is what "independently
  // resolvable" has to mean
  const afterDismiss = buildAttentionRows({
    items: [{ ...both, manual_attention: null, attention_sources: ['question'] }],
    nodes: [nodeWith('agent1', ask('q9', 'agent1', at))],
  })
  assert.deepEqual(keys(afterDismiss), ['question:q9'])
  const afterAnswer = buildAttentionRows({
    items: [both],
    nodes: [nodeWith('agent1', ask('q9', 'agent1', at, 'answered'))],
  })
  assert.deepEqual(keys(afterAnswer), ['ticket:both'])
})

// ------------------------------------------------------------------ §3
test('§3 a ticket disappears as soon as its attention is dismissed — even selected', () => {
  const at = '2026-09-20T10:00:00.000Z'
  const before = buildAttentionRows({ items: [flagged('t', at)] })
  const after = buildAttentionRows({
    items: [{ ...flagged('t', at), manual_attention: null, attention_sources: [] }],
  })
  assert.deepEqual(keys(after), [], 'the server stopped flagging it, so it is gone')
  // and the selection cannot hold it: retention is the MAIL rule only
  assert.deepEqual(keys(retainSelected(after, before, 'ticket:t')), [],
    'a selected ticket is not retained — only urgent mail is')
})

test('§3.1 a question disappears as soon as it is answered — even selected', () => {
  const at = '2026-09-20T10:00:00.000Z'
  const before = buildAttentionRows({ nodes: [nodeWith('n', ask('q', 'n', at))] })
  const after = buildAttentionRows({ nodes: [nodeWith('n', ask('q', 'n', at, 'answered'))] })
  assert.deepEqual(keys(after), [])
  assert.deepEqual(keys(retainSelected(after, before, 'question:q')), [])
})

// ------------------------------------------------------------------ §4
test('§4 an urgent mail leaves once read AND deselected, not before', () => {
  const at = '2026-09-20T12:00:00.000Z'
  const unread = buildAttentionRows({ pending: [mail('m1', at, true)] })
  assert.deepEqual(keys(unread), ['mail:m1'])

  // read: the server stops listing it as pending
  const read = buildAttentionRows({ pending: [] })
  assert.deepEqual(keys(read), [], 'the feed itself no longer holds it')

  // …but while it is the SELECTED row the panel keeps showing it
  const held = retainSelected(read, unread, 'mail:m1')
  assert.deepEqual(keys(held), ['mail:m1'], 'a read mail stays while it is selected')
  assert.ok(isRetained(held[0]!, read), 'and it is marked as no longer live')
  assert.equal(held[0]!.mail?.id, 'm1', 'the retained row still carries its message')

  // deselect — nothing puts it back
  assert.deepEqual(keys(retainSelected(read, held, null)), [],
    'deselecting releases it immediately')
  assert.deepEqual(keys(retainSelected(read, held, 'mail:other')), [],
    'and selecting something else releases it too')
})

test('§4.1 retention never invents a row the panel was not already showing', () => {
  const read = buildAttentionRows({ pending: [] })
  assert.deepEqual(keys(retainSelected(read, [], 'mail:never-seen')), [],
    'with nothing shown before, there is nothing to hold')
})

test('§4.2 a retained mail does not displace the rows that are still live', () => {
  const shown = buildAttentionRows({
    pending: [mail('m1', '2026-09-20T12:00:00.000Z', true)],
    items: [flagged('t', '2026-09-20T13:00:00.000Z')],
    nodes: [nodeWith('n', ask('q', 'n', '2026-09-20T11:00:00.000Z'))],
  })
  const live = buildAttentionRows({
    pending: [],
    items: [flagged('t', '2026-09-20T13:00:00.000Z')],
    nodes: [nodeWith('n', ask('q', 'n', '2026-09-20T11:00:00.000Z'))],
  })
  const held = retainSelected(live, shown, 'mail:m1')
  assert.deepEqual(keys(held), ['ticket:t', 'mail:m1', 'question:q'],
    'the held row returns to its own place in the order, not to the top')
  assert.equal(isRetained(held[0]!, live), false, 'the live ticket is not marked resolved')
})

// ------------------------------------------------------------------ §5
test('§5 attention is counted over archived and backlogged groups too', () => {
  const rows = buildAttentionRows({
    items: [flagged('active', '2026-09-20T10:00:00.000Z')],
    archived: [flagged('archived', '2026-09-20T11:00:00.000Z')],
    backlogged: [flagged('backlog', '2026-09-20T12:00:00.000Z')],
  })
  assert.deepEqual(keys(rows), ['ticket:backlog', 'ticket:archived', 'ticket:active'],
    'a flag raised on archived or backlogged work is still waiting on the user')
})

test('§5.1 the same item served in two groups is listed once', () => {
  const it = flagged('dup', '2026-09-20T10:00:00.000Z')
  const rows = buildAttentionRows({ items: [it], archived: [it] })
  assert.deepEqual(keys(rows), ['ticket:dup'])
})

test('§5.2 absent feeds are an empty list, never a throw', () => {
  assert.deepEqual(buildAttentionRows({}), [])
  assert.deepEqual(buildAttentionRows({ items: null, pending: null, nodes: null }), [])
})

// ------------------------------------------------------------------ §6
test('§6 the selection moves to a neighbour when its row resolves', () => {
  const rows = buildAttentionRows({
    items: [flagged('t', '2026-09-20T10:00:00.000Z')],
    pending: [mail('m', '2026-09-20T12:00:00.000Z', true)],
    nodes: [nodeWith('n', ask('q', 'n', '2026-09-20T11:00:00.000Z'))],
  })
  assert.equal(nextSelection(rows, 'mail:m'), 'question:q', 'the next row down')
  assert.equal(nextSelection(rows, 'ticket:t'), 'question:q', 'or the one above, at the end')
  assert.equal(nextSelection(rows, 'nothing'), null)
  assert.equal(nextSelection([rows[0]!], rows[0]!.key), null, 'an only row leaves nothing')
})

// ------------------------------------------------------------------ §7
test('§7 rows carry the context a reader needs, and the payload a control needs', () => {
  const rows = buildAttentionRows({
    items: [flagged('cutover', '2026-09-20T10:00:00.000Z', 'confirm the cutover window')],
    pending: [mail('m', '2026-09-20T12:00:00.000Z', true, 'the build is down')],
    nodes: [nodeWith('asker', ask('q', 'asker', '2026-09-20T11:00:00.000Z'))],
  })
  const byKind = Object.fromEntries(rows.map((r) => [r.kind, r]))
  assert.equal(byKind.ticket!.title, 'cutover')
  assert.equal(byKind.ticket!.subtitle, 'confirm the cutover window')
  assert.equal(byKind.ticket!.item?.slug, 'cutover', 'the item, for the Dismiss call')
  // the sender had to justify marking it urgent; that reason is the headline
  assert.equal(byKind.mail!.title, 'the build is down')
  assert.equal(byKind.mail!.subtitle, 'the body of m')
  assert.equal(byKind.mail!.mail?.id, 'm', 'the message, for the reading pane')
  assert.equal(byKind.question!.title, 'ship it?')
  assert.equal(byKind.question!.ask?.id, 'q', 'the ask, for the card')
  assert.equal(byKind.question!.agent, 'asker')
})

test('§7.1 a ticket row is timed by the FLAG, not by an unrelated later edit', () => {
  const rows = buildAttentionRows({
    items: [mkItem({
      title: 't', slug: 't', updated_at: '2026-09-21T23:00:00.000Z',
      manual_attention: { reason: 'r', at: '2026-09-20T10:00:00.000Z',
        by: { node: 'a', generation: 0 }, set_rev: 1 },
      effective_attention: true, attention_sources: ['manual'],
    })],
  })
  assert.equal(rows[0]!.at, '2026-09-20T10:00:00.000Z',
    'the row exists because the flag was raised, so that is when it is from')
})

test('§7.2 long text is trimmed for the row and kept whole on the payload', () => {
  const long = 'x'.repeat(400)
  assert.equal(oneLine(long).length, 140)
  assert.ok(oneLine(long).endsWith('…'))
  assert.equal(oneLine(' a \n b '), 'a b', 'whitespace is flattened, not preserved')
  assert.equal(oneLine(undefined), '')
  const rows = buildAttentionRows({ pending: [{ ...mail('m', '2026-09-20T12:00:00.000Z', true), body: long }] })
  assert.equal(rows[0]!.mail?.body, long, 'the pane still gets the whole body')
})

// ------------------------------------------------------------------ §8
test('§8 attentionNodes walks the whole tree, at every depth', () => {
  const tree = {
    roots: [{ id: 'a', children: [{ id: 'b', children: [{ id: 'c', children: [] }] }] }],
  } as unknown as TreePayload
  assert.deepEqual(attentionNodes(tree).map((n) => n.id), ['a', 'b', 'c'])
  assert.deepEqual(attentionNodes(null), [], 'before the tree arrives, nothing is claimed')
})

test('§8.1 a deep agent\'s question is listed like any other', () => {
  const tree = {
    roots: [{
      id: 'top', children: [{
        id: 'deep', children: [], ask: ask('dq', 'deep', '2026-09-20T10:00:00.000Z'),
      }],
    }],
  } as unknown as TreePayload
  const rows = buildAttentionRows({ nodes: attentionNodes(tree) })
  assert.deepEqual(keys(rows), ['question:dq'])
  assert.equal(rows[0]!.agent, 'deep')
})
