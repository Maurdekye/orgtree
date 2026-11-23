// The user mailbox as direct messages (4.7.0, USER 2026-11-22 m200806e4af28,
// m1454e651500e): which chats the list holds, in what order, what each one
// counts as unread, what its timeline is and what closing it does. These are
// the pure rules; dmpanel.test.tsx drives the panel itself.
//
// Run:  node apps/desktop/renderer/tests/run.mjs dmmodel

import './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { dmChats, dmClose, dmNodes, dmTimeline } from '../src/dm/model'
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

  const pooled = dmChats({ nodes: inherited, grants: [], box: box({ delivered: [mail('p1', 'pooled', '2026-11-20T10:00:00Z')] }),
    openAsks: [], doneAsks: [] }).find(c => c.peer === 'pooled')
  assert.ok(pooled, 'an agent whose audience comes through its project has a chat once it has written')
  assert.equal(pooled!.inherited, 'pool')
  const viaProject = dmClose(pooled!)
  assert.equal(viaProject.can, false, 'it holds no grant of its own')
  assert.match(viaProject.title, /pool/)
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

test('a retired grant holder is listed last and dim, and not at all when retired agents are hidden', () => {
  const nodes = dmNodes({ slug: 'mine', roots: [node('lead', [node('gone', [], { state: 'archived' })])] } as unknown as TreePayload)
  const input = { nodes, grants: [grant('gone')], box: box(), openAsks: [], doneAsks: [] }
  const shown = dmChats(input)
  assert.deepEqual(names(shown), ['lead', 'gone'])
  assert.equal(chat(shown, 'gone').live, false)
  assert.deepEqual(names(dmChats({ ...input, hideRetired: true })), ['lead'])
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
