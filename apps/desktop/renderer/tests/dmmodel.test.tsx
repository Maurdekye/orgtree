// The user mailbox as direct messages (4.7.0, USER 2026-11-22 m200806e4af28,
// m1454e651500e): which chats the list holds, in what order, what each one
// counts as unread, what its timeline is and what closing it does. These are
// the pure rules; dmpanel.test.tsx drives the panel itself.
//
// Run:  node apps/desktop/renderer/tests/run.mjs dmmodel

import './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { dmAudienceLoss, dmChats, dmClose, dmNodes, dmTimeline } from '../src/dm/model'
import type { DmChat } from '../src/dm/model'
import type { AskInfo, AudienceGrant, InboxPayload, MailEntry, TreeNode, TreePayload } from '../src/types'

const USER = '@user'

const node = (id: string, children: TreeNode[] = [], extra: Record<string, unknown> = {}): TreeNode => ({
  id, title: id, tier: 'opus', model_id: 'opus', state: 'live', seat: 1, grant: 0, free: 0,
  audiences_held: [], children, lineage: [], ...extra,
} as unknown as TreeNode)

const project = (id: string, children: TreeNode[] = [], extra: Record<string, unknown> = {}) =>
  node(id, children, { kind: 'project', tier: null, ...extra })

const mail = (id: string, from: string, at: string, extra: Record<string, unknown> = {}): MailEntry =>
  ({ id, from, at, kind: 'message', body: `body of ${id}`, ...extra }) as MailEntry

const sent = (id: string, to: string, at: string, extra: Record<string, unknown> = {}) =>
  ({ id, from: USER, to, at, kind: 'message', body: `body of ${id}`, ...extra }) as unknown as InboxPayload['sent'][number]

const grant = (grantee: string): AudienceGrant => ({ grantee, grantor: USER, granted_at: '2026-11-01T00:00:00Z', reason: '' })

const ask = (id: string, nodeId: string, at: string, status = 'open'): AskInfo =>
  ({ id, node: nodeId, at, kind: 'batch', status, tabs: [{ kind: 'question', question: `question ${id}` }], revs: { ask: 1 } }) as unknown as AskInfo

/** lead and solo are top-level; worker reports to lead; member sits under the
 *  top-level project crew, so no agent is above it */
const TREE = {
  slug: 'mine', roots: [
    node('lead', [node('worker'), node('helper')]),
    node('solo'),
    project('crew', [node('member')]),
  ],
} as unknown as TreePayload

const box = (b: Partial<InboxPayload> = {}): InboxPayload => ({ pending: [], delivered: [], sent: [], ...b })

const chats = (o: Partial<Parameters<typeof dmChats>[0]> = {}) => dmChats({
  nodes: dmNodes(TREE), grants: [], box: box(), openAsks: [], doneAsks: [], ...o })
const names = (list: DmChat[]) => list.map(c => c.peer)
const chat = (list: DmChat[], peer: string) => {
  const found = list.find(c => c.peer === peer)
  assert.ok(found, `${peer} is in the list`)
  return found!
}

test('every top-level agent has a chat, with or without mail; an agent below another has none', () => {
  const list = chats()
  assert.deepEqual(names(list), ['lead', 'solo', 'member'],
    'tree order while nobody has written: the two roots, then the agent under the top-level project')
  assert.equal(chat(list, 'lead').topLevel, true)
  assert.equal(chat(list, 'member').topLevel, true, 'only a project is above it, so its line to the user is direct')
  assert.equal(list.some(c => c.peer === 'crew'), false, 'a project without a grant is not a chat')
})

test('an agent holding the user audience has a chat', () => {
  const list = chats({ grants: [grant('worker')] })
  assert.deepEqual(names(list), ['lead', 'worker', 'solo', 'member'],
    'while nobody has written the list follows the tree: a holder sits under its superior')
  const worker = chat(list, 'worker')
  assert.equal(worker.grant, true)
  assert.equal(worker.topLevel, false)
})

test('a grant to somebody else, or by somebody else, opens no chat', () => {
  const other: AudienceGrant = { grantee: 'helper', grantor: 'lead', granted_at: '2026-11-01T00:00:00Z', reason: '' }
  assert.deepEqual(names(chats({ grants: [other] })), ['lead', 'solo', 'member'])
})

test('chats are ordered by their newest message, in either direction', () => {
  const list = chats({
    grants: [grant('worker')],
    box: box({
      delivered: [mail('m1', 'lead', '2026-11-20T10:00:00Z')],
      pending: [mail('m2', 'worker', '2026-11-20T12:00:00Z')],
      sent: [sent('s1', 'solo', '2026-11-20T11:00:00Z')],
    }),
  })
  assert.deepEqual(names(list), ['worker', 'solo', 'lead', 'member'],
    'newest first; a chat nobody has written in comes last')
})

test('a chat counts its own unread mail and its own open requests', () => {
  const list = chats({
    grants: [grant('worker')],
    box: box({
      pending: [mail('m1', 'worker', '2026-11-20T10:00:00Z'), mail('m2', 'worker', '2026-11-20T10:05:00Z'),
        mail('m3', 'lead', '2026-11-20T09:00:00Z')],
      delivered: [mail('m0', 'worker', '2026-11-19T10:00:00Z')],
    }),
    openAsks: [ask('q1', 'lead', '2026-11-20T09:30:00Z')],
  })
  assert.equal(chat(list, 'worker').unread, 2)
  assert.equal(chat(list, 'worker').asks, 0)
  assert.equal(chat(list, 'lead').unread, 1)
  assert.equal(chat(list, 'lead').asks, 1)
  assert.equal(chat(list, 'solo').unread, 0)
})

test('mail read in this window no longer counts as unread', () => {
  const list = chats({
    grants: [grant('worker')],
    box: box({ pending: [mail('m1', 'worker', '2026-11-20T10:00:00Z'), mail('m2', 'worker', '2026-11-20T10:05:00Z')] }),
    isRead: id => id === 'm1',
  })
  assert.equal(chat(list, 'worker').unread, 1)
})

test('a timeline is that chat\'s received mail, sent mail and requests, oldest first', () => {
  const list = chats({
    grants: [grant('worker')],
    box: box({
      delivered: [mail('m1', 'worker', '2026-11-20T10:00:00Z'), mail('x1', 'lead', '2026-11-20T10:01:00Z')],
      pending: [mail('m3', 'worker', '2026-11-20T12:00:00Z')],
      sent: [sent('s2', 'worker', '2026-11-20T11:00:00Z'), sent('x2', 'lead', '2026-11-20T11:01:00Z')],
    }),
    openAsks: [ask('q4', 'worker', '2026-11-20T13:00:00Z')],
    doneAsks: [ask('q0', 'worker', '2026-11-20T09:00:00Z', 'answered')],
  })
  const entries = dmTimeline(chat(list, 'worker'))
  assert.deepEqual(entries.map(e => e.key), ['ask:q0', 'm1', 's2', 'm3', 'ask:q4'])
  assert.deepEqual(entries.map(e => e.out), [false, false, true, false, false])
  assert.deepEqual(entries.map(e => e.unread), [false, false, false, true, true],
    'unread mail and an open request are what still waits on the user')
  assert.equal(chat(list, 'worker').last?.key, 'ask:q4')
})

test('closing: only an audience grant can be closed, and no top-level chat leaves the list', () => {
  const inherited = dmNodes({ slug: 'mine', roots: [
    node('lead', [project('pool', [node('pooled', [], { audiences_inherited: [{ grantor: USER, project: 'pool' }] })])]),
  ] } as unknown as TreePayload)
  const list = chats({ grants: [grant('worker'), grant('solo')] })

  const worker = dmClose(chat(list, 'worker'))
  assert.equal(worker.can, true, 'an agent that is here by its grant can be closed')
  assert.equal(worker.stays, false)
  assert.match(worker.title, /revoke/i)

  const lead = dmClose(chat(list, 'lead'))
  assert.equal(lead.can, false, 'a top-level agent without a grant has nothing to revoke')
  assert.match(lead.title, /top-level/i)
  assert.match(lead.title, /can't be closed/i)

  const solo = dmClose(chat(list, 'solo'))
  assert.equal(solo.can, true, 'a top-level agent that also holds a grant: the grant can be revoked')
  assert.equal(solo.stays, true, 'and its chat stays')
  assert.match(solo.title, /revoke/i)
  assert.match(solo.title, /stays/i)

  const pooled = dmChats({ nodes: inherited, grants: [grant('pool')], box: box({ delivered: [mail('p1', 'pooled', '2026-11-20T10:00:00Z')] }),
    openAsks: [], doneAsks: [] }).find(c => c.peer === 'pooled')
  assert.ok(pooled, 'an agent whose audience comes through its project has a chat once it has written')
  assert.equal(pooled!.inherited, 'pool')
  // (what its close does is the next section: USER 2026-11-23 m0ca89ba635fd)
})

// ---- audiences that come through a project (USER 2026-11-23 m0ca89ba635fd) ----

const via = (...projects: string[]) => ({ audiences_inherited: projects.map(p => ({ grantor: USER, project: p })) })
/** desk is a project under lead holding the user's audience: clerk reaches the
 *  user only through it, runner also holds its own grant; crew is a top-level
 *  project, so its member is top-level */
const DESK = dmNodes({ slug: 'mine', roots: [
  node('lead', [project('desk', [node('clerk', [], via('desk')), node('runner', [], via('desk'))])]),
  project('crew', [node('member', [], via('crew'))]),
] } as unknown as TreePayload)
const deskChats = (grants: AudienceGrant[], selected?: string) => dmChats({
  nodes: DESK, grants, box: box({ delivered: [mail('k1', 'clerk', '2026-11-20T10:00:00Z')] }), openAsks: [], doneAsks: [], selected })

test('a chat knows every project its audience comes through, with or without a grant of its own', () => {
  const list = deskChats([grant('desk'), grant('runner'), grant('crew')])
  assert.deepEqual(chat(list, 'clerk').via, ['desk']); assert.equal(chat(list, 'clerk').grant, false)
  assert.deepEqual(chat(list, 'runner').via, ['desk']); assert.equal(chat(list, 'runner').grant, true)
  assert.deepEqual(chat(list, 'lead').via, [], 'an agent under no such project has none')
  // a project whose grant is gone (revoked a moment ago) is no route, whatever the last tree says
  assert.deepEqual(chat(deskChats([grant('runner'), grant('crew')]), 'runner').via, [])
})

test('closing an agent that reaches the user only through a project closes that project\u2019s audience', () => {
  const clerk = dmClose(chat(deskChats([grant('desk')]), 'clerk'))
  assert.equal(clerk.can, true); assert.equal(clerk.revokes, 'desk'); assert.equal(clerk.project, true); assert.equal(clerk.stays, false)
  assert.match(clerk.title, /clerk reaches you only through project desk: closing revokes that project's audience with you\./)
  // a top-level agent that inherits only: the same close, and its chat stays
  const member = dmClose(chat(deskChats([grant('crew')]), 'member'))
  assert.equal(member.revokes, 'crew'); assert.equal(member.project, true); assert.equal(member.stays, true)
  assert.match(member.title, /The chat stays/)
})

test('with both a grant and a project\u2019s audience, the first close revokes its own grant and the second the project\u2019s', () => {
  const first = dmClose(chat(deskChats([grant('desk'), grant('runner')]), 'runner'))
  assert.equal(first.can, true); assert.equal(first.revokes, undefined, 'its own grant'); assert.equal(first.project, undefined)
  assert.equal(first.stays, true, 'it still reaches the user through the project')
  assert.match(first.title, /Revoke runner's own audience with you\. It still reaches you through project desk: closing again revokes that project's audience\./)
  const second = dmClose(chat(deskChats([grant('desk')], 'runner'), 'runner'))
  assert.equal(second.revokes, 'desk'); assert.equal(second.project, true)
})

test('closing a project\u2019s chat revokes the project\u2019s grant, and says who else loses the audience', () => {
  const desk = dmClose(chat(deskChats([grant('desk'), grant('runner')]), 'desk'))
  assert.equal(desk.can, true); assert.equal(desk.project, true); assert.equal(desk.revokes, undefined)
  assert.deepEqual(dmAudienceLoss(DESK, [grant('desk'), grant('runner')], 'desk'), ['clerk'],
    'clerk reaches the user only through it; runner keeps its own grant')
  assert.deepEqual(dmAudienceLoss(DESK, [grant('desk')], 'desk'), ['clerk', 'runner'])
  assert.deepEqual(dmAudienceLoss(DESK, [grant('crew')], 'crew'), [], 'a top-level agent keeps its direct line: nobody else loses anything')
})

test('several projects: all are listed, and each close revokes the next one', () => {
  // not reachable today (a member inherits from its direct project only); the rule holds if that changes
  const nodes = dmNodes({ slug: 'mine', roots: [
    node('lead', [project('a', [project('b', [node('deep', [], via('a', 'b'))])])]),
  ] } as unknown as TreePayload)
  const of = (grants: AudienceGrant[]) => dmChats({ nodes, grants, box: box(), openAsks: [], doneAsks: [], selected: 'deep' }).find(c => c.peer === 'deep')!
  assert.deepEqual(of([grant('a'), grant('b')]).via, ['a', 'b'])
  assert.equal(dmClose(of([grant('a'), grant('b')])).revokes, 'a', 'the first listed goes first')
  assert.equal(dmClose(of([grant('b')])).revokes, 'b', 'then the next')
  assert.equal(dmClose(of([])).can, false, 'and then there is nothing left to revoke')
})

test('a sender without an audience shows only while something of its waits, or while it is the open chat', () => {
  const read = box({ delivered: [mail('h1', 'helper', '2026-11-20T10:00:00Z')] })
  assert.equal(chats({ box: read }).some(c => c.peer === 'helper'), false, 'read mail of a closed chat stays out of the list')
  assert.equal(chats({ box: read, selected: 'helper' }).some(c => c.peer === 'helper'), true, 'the chat on screen is always listed')
  const unread = box({ pending: [mail('h2', 'helper', '2026-11-20T10:00:00Z')] })
  assert.equal(chat(chats({ box: unread }), 'helper').unread, 1, 'unread mail is never hidden')
  assert.equal(chats({ openAsks: [ask('q1', 'helper', '2026-11-20T10:00:00Z')] }).some(c => c.peer === 'helper'), true,
    'nor is an open request')
  assert.equal(dmClose(chat(chats({ box: unread }), 'helper')).can, false, 'there is no audience to revoke')
})

test('Orgtree\'s own mail is one chat that cannot be closed', () => {
  const list = chats({ box: box({ delivered: [mail('n1', '@system', '2026-11-20T10:00:00Z')] }) })
  const system = chat(list, '@system')
  assert.equal(system.kind, 'system')
  assert.equal(dmClose(system).can, false)
  assert.equal(chats().some(c => c.peer === '@system'), false, 'no row before it has written anything')
})

test('a project holding the user audience is a chat of kind project', () => {
  const list = chats({ grants: [grant('crew')] })
  const crew = chat(list, 'crew')
  assert.equal(crew.kind, 'project')
  assert.equal(dmClose(crew).can, true)
})

// USER 2026-11-24 m15c78be3a1db: "theres a bunch of agents that say not in this
// organization yet in your list". The audiences read keeps the grants of
// retired agents and of names the tree no longer holds; a grant alone made a row.
test('a grant makes a chat only for a live agent of this tree: not for a retired one, and not for a name the tree does not hold', () => {
  const nodes = dmNodes({ slug: 'mine', roots: [node('lead', [node('gone', [], { state: 'archived' })])] } as unknown as TreePayload)
  const input = { nodes, grants: [grant('gone'), grant('accept-field'), grant('account-card')], box: box(), openAsks: [], doneAsks: [] }
  assert.deepEqual(names(dmChats(input)), ['lead'], 'neither the retired holder nor the two unknown names has a row')
  // unread mail is never hidden, whoever sent it
  const waiting = dmChats({ ...input, box: box({ pending: [mail('m1', 'gone', '2026-11-20T10:00:00Z')] }) })
  assert.deepEqual(names(waiting), ['lead', 'gone'])
  assert.equal(chat(waiting, 'gone').live, false)
  // read mail of such a sender is history, not a chat
  assert.deepEqual(names(dmChats({ ...input, box: box({ delivered: [mail('m1', 'gone', '2026-11-20T10:00:00Z')] }) })), ['lead'])
  // the chat on screen stays listed
  assert.deepEqual(names(dmChats({ ...input, selected: 'gone' })), ['lead', 'gone'])
  // an audience request from a name the tree does not hold is not a chat either
  assert.deepEqual(names(dmChats({ ...input, requests: [{ from: 'ghost', reason: 'x', at: '2026-11-20T10:00:00Z' }] })), ['lead'])
})

test('a paused grant is not in effect: its holder has no audience chat', () => {
  const list = chats({ grants: [{ ...grant('worker'), paused: true } as AudienceGrant, grant('helper')] })
  assert.deepEqual(names(list), ['lead', 'helper', 'solo', 'member'], 'helper holds one; the grant of worker is paused')
})

test('a retired top-level agent has no chat of its own', () => {
  const nodes = dmNodes({ slug: 'mine', roots: [node('lead'), node('old', [], { state: 'archived' })] } as unknown as TreePayload)
  assert.deepEqual(names(dmChats({ nodes, grants: [], box: box(), openAsks: [], doneAsks: [] })), ['lead'])
})

test('before the audiences are read, a node\'s own record of its grant counts', () => {
  const nodes = dmNodes({ slug: 'mine', roots: [node('lead', [node('worker', [], { audiences_held: [USER], audiences_explicit: [USER] })])] } as unknown as TreePayload)
  const list = dmChats({ nodes, grants: null, box: box(), openAsks: [], doneAsks: [] })
  assert.equal(chat(list, 'worker').grant, true)
})

// ---- prototype feedback (USER 2026-11-23 mae2b1aa37a9b): an audience request is a chat

test('an audience request is a chat of its own, first in the list, the newest request on top', () => {
  const list = chats({
    box: box({ delivered: [mail('m1', 'lead', '2026-11-20T10:00:00Z')] }),
    requests: [
      { from: 'worker', reason: 'to report to you', at: '2026-11-19T08:00:00Z' },
      { from: 'helper', reason: '', at: '2026-11-19T09:00:00Z' },
    ],
  })
  assert.deepEqual(names(list), ['helper', 'worker', 'lead', 'solo', 'member'],
    'the two requests first (newest first), though lead has newer mail')
  assert.deepEqual(chat(list, 'worker').request, { reason: 'to report to you', at: '2026-11-19T08:00:00Z' })
  assert.equal(chat(list, 'lead').request, null, 'a chat nobody asked for carries no request')
  assert.equal(chat(list, 'worker').grant, false, 'asking is not holding')
})

test('closing a chat that is only a request denies it; a holder of the audience has no request', () => {
  const asking = chat(chats({ requests: [{ from: 'worker', reason: 'r', at: '2026-11-19T08:00:00Z' }] }), 'worker')
  const rule = dmClose(asking)
  assert.equal(rule.can, true); assert.equal(rule.deny, true); assert.equal(rule.stays, false)
  assert.match(rule.title, /Deny worker's audience request and close this chat\./)
  // a request the grant has already answered (the audiences read is one poll behind) is not shown
  const held = chat(chats({ grants: [grant('worker')], requests: [{ from: 'worker', reason: 'r', at: '' }] }), 'worker')
  assert.equal(held.request, null)
  assert.equal(dmClose(held).deny, undefined, 'closing a held audience revokes, as before')
})

// ---- a project's chat is one thread (USER 2026-11-23 mb52269db6058) ----
// The engine keeps one row for the user's message to a project and one more
// "sent by the user" for every hand-out, relay and bundled follow-up.

/** crew holds the user's audience; member and mate work under it; pool is a
 *  project under lead that relays crew's queue, with pooled under it */
const CREW = {
  slug: 'mine', roots: [
    node('lead', [node('worker'), project('pool', [node('pooled')])]),
    project('crew', [node('member'), node('mate')]),
  ],
} as unknown as TreePayload
const crewChats = (b: Partial<InboxPayload>) => dmChats({
  nodes: dmNodes(CREW), grants: [grant('crew')], box: box(b), openAsks: [], doneAsks: [] })
const keys = (c: DmChat) => c.entries.map(e => e.key)

test('R1: the copy the queue hands a member folds into the user\'s message, which says who holds it', () => {
  const list = crewChats({ sent: [
    sent('j1', 'crew', '2026-11-20T10:00:00Z', { queue: { held_by: 'member' } }),
    sent('c1', 'member', '2026-11-20T10:00:05Z', { queue: { job: { id: 9, name: 'crew', mail: 'j1' } } }),
    sent('j2', 'crew', '2026-11-20T11:00:00Z'),
  ] })
  const crew = chat(list, 'crew')
  assert.deepEqual(keys(crew), ['j1', 'j2'], 'one bubble per message: the copy is not a message')
  assert.deepEqual(crew.entries[0]!.job, { state: 'held', holders: ['member'] })
  assert.deepEqual(crew.entries[1]!.job, { state: 'waiting', holders: [] }, 'nobody has taken the second one')
  assert.deepEqual(keys(chat(list, 'member')), [], 'and the copy is not in the member\'s own chat')
})

test('R2: a member\'s answer to its copy is in the project\'s chat under the agent\'s name; its own mail stays in its own chat', () => {
  const list = crewChats({
    sent: [
      sent('j1', 'crew', '2026-11-20T10:00:00Z', { queue: { held_by: 'member' } }),
      sent('c1', 'member', '2026-11-20T10:00:05Z', { queue: { job: { id: 9, name: 'crew', mail: 'j1' } } }),
    ],
    pending: [mail('a1', 'member', '2026-11-20T10:30:00Z', { reply_to: { id: 'c1', kind: 'mail', from: '@user' } })],
    delivered: [mail('own1', 'member', '2026-11-20T09:00:00Z')],
  })
  const crew = chat(list, 'crew')
  assert.deepEqual(keys(crew), ['j1', 'a1'])
  assert.equal(crew.entries[1]!.via, 'member', 'the answer names the agent that wrote it')
  assert.equal(crew.unread, 1, 'and it is the project chat\'s unread mail')
  assert.deepEqual(keys(chat(list, 'member')), ['own1'], 'what the member wrote on its own stays in its chat')
  assert.equal(chat(list, 'member').unread, 0)
})

test('R3: the user\'s reply to a member\'s answer stays in the project\'s thread, marked with whom it went to', () => {
  const list = crewChats({
    sent: [
      sent('j1', 'crew', '2026-11-20T10:00:00Z'),
      sent('c1', 'member', '2026-11-20T10:00:05Z', { queue: { job: { id: 9, name: 'crew', mail: 'j1' } } }),
      sent('r1', 'member', '2026-11-20T10:40:00Z', { reply_to: { id: 'a1', kind: 'mail', from: 'member' } }),
    ],
    delivered: [
      mail('a1', 'member', '2026-11-20T10:30:00Z', { reply_to: { id: 'c1', kind: 'mail', from: '@user' } }),
      mail('a2', 'member', '2026-11-20T10:50:00Z', { reply_to: { id: 'r1', kind: 'mail', from: '@user' } }),
    ],
  })
  const crew = chat(list, 'crew')
  assert.deepEqual(keys(crew), ['j1', 'a1', 'r1', 'a2'], 'the whole exchange is one thread')
  assert.deepEqual(crew.entries.map(e => [e.out, e.via ?? null]), [[true, null], [false, 'member'], [true, 'member'], [false, 'member']])
  assert.equal(crew.entries[2]!.job, undefined, 'a reply to a member is no queue job')
})

test('R4: a relay and a re-hand-out fold the same way, and name each agent the job went to', () => {
  const list = crewChats({ sent: [
    sent('j1', 'crew', '2026-11-20T10:00:00Z', { queue: { held_by: 'pool' } }),
    // pool's relay took it: a child job in pool, naming the job it came from
    sent('j1b', 'pool', '2026-11-20T10:00:02Z', { queue: { relayed_from: { name: 'crew', job: 'j1' }, held_by: 'pooled' } }),
    sent('c1', 'pooled', '2026-11-20T10:00:04Z', { queue: { job: { id: 5, name: 'pool', mail: 'j1b' } } }),
    // a second message, abandoned by member and handed to mate
    sent('j2', 'crew', '2026-11-20T11:00:00Z', { queue: { held_by: 'mate' } }),
    sent('c2', 'member', '2026-11-20T11:00:03Z', { queue: { job: { id: 9, name: 'crew', mail: 'j2' }, released: { by: 'crew', why: 'stale' } } }),
    sent('c3', 'mate', '2026-11-20T11:20:00Z', { queue: { job: { id: 9, name: 'crew', mail: 'j2' } } }),
  ] })
  const crew = chat(list, 'crew')
  assert.deepEqual(keys(crew), ['j1', 'j2'], 'two messages, however many copies')
  assert.deepEqual(crew.entries[0]!.job, { state: 'held', holders: ['pooled'] }, 'the relayed job: the agent that finally got it')
  assert.deepEqual(crew.entries[1]!.job, { state: 'held', holders: ['member', 'mate'] }, 'the re-hand-out: both, oldest first')
  assert.equal(list.some(c => c.peer === 'pool' || c.peer === 'pooled'), false, 'no chat appears for the relay or its worker')
  // an answer from the relay's worker threads back to the first project
  const answered = crewChats({
    sent: [
      sent('j1', 'crew', '2026-11-20T10:00:00Z'),
      sent('j1b', 'pool', '2026-11-20T10:00:02Z', { queue: { relayed_from: { name: 'crew', job: 'j1' } } }),
      sent('c1', 'pooled', '2026-11-20T10:00:04Z', { queue: { job: { id: 5, name: 'pool', mail: 'j1b' } } }),
    ],
    delivered: [mail('a1', 'pooled', '2026-11-20T10:30:00Z', { reply_to: { id: 'c1', kind: 'mail', from: '@user' } })],
  })
  assert.deepEqual(chat(answered, 'crew').entries.map(e => [e.key, e.via ?? null]), [['j1', null], ['a1', 'pooled']])
})

test('a follow-up: bundled with the waiting job it is one bubble; sent straight to the holder it is in the thread, marked', () => {
  const list = crewChats({ sent: [
    sent('j1', 'crew', '2026-11-20T10:00:00Z', { queue: { held_by: 'member', ack: true } }),
    sent('c1', 'member', '2026-11-20T10:00:05Z', { queue: { job: { id: 9, name: 'crew', mail: 'j1', ack: true } } }),
    // bundled while the job waited, then handed with it
    sent('b1', 'crew', '2026-11-20T10:00:03Z', { queue: { follow_up_to: 'j1' } }),
    sent('b1c', 'member', '2026-11-20T10:00:05Z', { queue: { job: { id: 9, name: 'crew', mail: 'b1' }, follow_up_to: 'j1' } }),
    // sent to the holder directly: it names the JOB, and is a message of its own
    sent('f1', 'member', '2026-11-20T10:20:00Z', { queue: { job: { id: 9, name: 'crew', mail: 'j1' }, follow_up_to: 'j1' } }),
  ] })
  const crew = chat(list, 'crew')
  assert.deepEqual(keys(crew), ['j1', 'b1', 'f1'])
  assert.equal(crew.entries[1]!.job, undefined, 'a follow-up follows its job: it has no state of its own')
  assert.equal(crew.entries[2]!.via, 'member', 'the direct follow-up says whom it went to')
  assert.deepEqual(keys(chat(list, 'member')), [])
})

test('a job\'s state: acknowledged, and not delivered', () => {
  const list = crewChats({ sent: [
    sent('j1', 'crew', '2026-11-20T10:00:00Z', { queue: { held_by: 'member', ack: true, acked_at: '2026-11-20T10:30:00Z' } }),
    sent('c1', 'member', '2026-11-20T10:00:05Z', { queue: { job: { id: 9, name: 'crew', mail: 'j1', ack: true } } }),
    sent('j2', 'crew', '2026-11-20T11:00:00Z', { queue: { dead_letter: { by: 'crew', why: 'attempts', attempts: 3 } } }),
  ] })
  assert.deepEqual(chat(list, 'crew').entries.map(e => e.job?.state), ['done', 'dead'])
})

test('a copy whose message is older than the loaded mail stands for it, once, in the project\'s chat', () => {
  const list = crewChats({ sent: [
    sent('c1', 'member', '2026-11-20T10:00:05Z', { queue: { job: { id: 9, name: 'crew', mail: 'gone' } } }),
    sent('c2', 'mate', '2026-11-20T10:30:00Z', { queue: { job: { id: 9, name: 'crew', mail: 'gone' } } }),
  ] })
  assert.deepEqual(chat(list, 'crew').entries.map(e => [e.key, e.via ?? null]), [['c1', 'member']])
})

test('megaphone: each member\'s chat has its copy, and the project\'s chat has the send once, as a record', () => {
  const mega = { name: 'crew', send: 'g1', to: 2 }
  const list = crewChats({ sent: [
    sent('g1a', 'member', '2026-11-20T10:00:00Z', { megaphone: mega }),
    sent('g1b', 'mate', '2026-11-20T10:00:00Z', { megaphone: mega }),
  ] })
  assert.deepEqual(keys(chat(list, 'member')), ['g1a'])
  assert.deepEqual(chat(list, 'member').entries[0]!.megaphone, { project: 'crew', record: false, to: 2, names: ['member', 'mate'] })
  assert.deepEqual(keys(chat(list, 'mate')), ['g1b'])
  const crew = chat(list, 'crew')
  assert.deepEqual(keys(crew), ['megaphone:g1'], 'once')
  assert.deepEqual(crew.entries[0]!.megaphone, { project: 'crew', record: true, to: 2, names: ['member', 'mate'] })
  assert.equal(crew.entries[0]!.job, undefined, 'a megaphone send is no queue job')
  // an answer to a megaphone copy is that member's own conversation
  const answered = crewChats({
    sent: [sent('g1a', 'member', '2026-11-20T10:00:00Z', { megaphone: mega })],
    delivered: [mail('a1', 'member', '2026-11-20T10:10:00Z', { reply_to: { id: 'g1a', kind: 'mail', from: '@user' } })],
  })
  assert.deepEqual(keys(chat(answered, 'member')), ['g1a', 'a1'])
  assert.deepEqual(keys(chat(answered, 'crew')), ['megaphone:g1'])
})

test('a message keeps the ids of the copies folded into it, so a reference to a copy finds it', () => {
  const list = crewChats({ sent: [
    sent('j1', 'crew', '2026-11-20T10:00:00Z'),
    sent('c1', 'member', '2026-11-20T10:00:05Z', { queue: { job: { id: 9, name: 'crew', mail: 'j1' } } }),
    sent('c2', 'mate', '2026-11-20T10:20:00Z', { queue: { job: { id: 9, name: 'crew', mail: 'j1' } } }),
    sent('j2', 'crew', '2026-11-20T11:00:00Z'),
  ] })
  assert.deepEqual(chat(list, 'crew').entries.map(e => e.copies ?? null), [['c1', 'c2'], null])
})

// ---- the grouped list (USER 2026-11-23 ma97ab61a248c) ----

/** office holds the audience: aide and page reach the user only through it, envoy also holds its own grant */
const OFFICE = dmNodes({ slug: 'mine', roots: [
  node('lead', [project('office', [node('aide', [], via('office')), node('page', [], via('office')), node('envoy', [], via('office'))])]),
  node('solo'),
] } as unknown as TreePayload)
const officeChats = (b: Partial<InboxPayload>) => dmChats({
  nodes: OFFICE, grants: [grant('office'), grant('envoy')], box: box(b), openAsks: [], doneAsks: [] })

test('an agent that reaches the user only through a project is listed under it; one with its own grant is not', () => {
  const list = officeChats({ delivered: [
    mail('a1', 'aide', '2026-11-20T10:00:00Z'), mail('p1', 'page', '2026-11-20T11:00:00Z'), mail('e1', 'envoy', '2026-11-20T09:00:00Z'),
  ] })
  assert.deepEqual(list.map(c => [c.peer, c.parent]), [
    ['office', null], ['page', 'office'], ['aide', 'office'], ['envoy', null], ['lead', null], ['solo', null],
  ], 'the project, its two agents by their newest message, then the rest')
  assert.equal(chat(list, 'office').kids, 2)
  assert.equal(chat(list, 'envoy').kids, 0)
})

test('a project is placed by the newest activity of itself or of the chats under it', () => {
  const quiet = officeChats({
    delivered: [mail('a1', 'aide', '2026-11-20T08:00:00Z'), mail('s1', 'solo', '2026-11-20T09:00:00Z')],
    sent: [sent('o1', 'office', '2026-11-20T07:00:00Z')],
  })
  assert.deepEqual(names(quiet), ['solo', 'office', 'aide', 'page', 'lead', 'envoy'], 'solo wrote last; page, silent, is last under its project')
  const busy = officeChats({
    delivered: [mail('a1', 'aide', '2026-11-20T10:00:00Z'), mail('s1', 'solo', '2026-11-20T09:00:00Z')],
    sent: [sent('o1', 'office', '2026-11-20T07:00:00Z')],
  })
  assert.deepEqual(names(busy), ['office', 'aide', 'page', 'solo', 'lead', 'envoy'], 'aide wrote last: its project moves up with it')
})

test('a top-level agent under a project, and an agent whose project has no chat, are listed on their own', () => {
  const crewList = dmChats({ nodes: DESK, grants: [grant('crew')], box: box(), openAsks: [], doneAsks: [] })
  assert.equal(chat(crewList, 'member').parent, null, 'it has its own direct line')
  // the project's grant is hidden (retired holders hidden, or revoked a moment ago): nothing to sit under
  const alone = dmChats({ nodes: OFFICE, grants: [grant('envoy')], box: box({ pending: [mail('a1', 'aide', '2026-11-20T10:00:00Z')] }), openAsks: [], doneAsks: [] })
  assert.equal(chat(alone, 'aide').parent, null)
})

// USER 2026-11-23 mb673f241b650: "list them, since it can be collapsed"
test('every agent that reaches the user only through a project is listed under it, also one that has never written', () => {
  const list = officeChats({ delivered: [mail('a1', 'aide', '2026-11-20T10:00:00Z')] })
  assert.deepEqual(list.map(c => [c.peer, c.parent]), [
    ['office', null], ['aide', 'office'], ['page', 'office'], ['lead', null], ['envoy', null], ['solo', null],
  ], 'page has never written: last under its project; envoy holds its own grant and is on its own')
  assert.equal(chat(list, 'office').kids, 2)
  assert.deepEqual(chat(list, 'page').entries, [], 'its chat is empty')
  // not while the project holds no audience, and never a retired agent or a top-level one
  assert.equal(dmChats({ nodes: OFFICE, grants: [grant('envoy')], box: box(), openAsks: [], doneAsks: [] }).some(c => c.peer === 'page'), false)
  assert.equal(chat(dmChats({ nodes: DESK, grants: [grant('crew')], box: box(), openAsks: [], doneAsks: [] }), 'member').parent, null)
})
