import test from 'node:test'
import assert from 'node:assert/strict'
import { projectEvents, projectHistory, projectMailbox, projectUserInbox } from '../src/recordpanels'
import type { RecordTable } from '../src/recordfeed'

const table = (...entries: [string, [string, unknown][]][]): RecordTable =>
  new Map(entries.map(([entity, rows]) => [entity, new Map(rows)]))

test('shared projections keep declared membership and exact bigint order', () => {
  const records = table(['user_inbox', [['9007199254740993', { id: 'second' }], ['9007199254740992', { id: 'first' }]]],
    ['event:shared', [['2', { op: 'b' }], ['1', { op: 'a' }]]], ['org', [['events_count', { events_count: 402 }]]])
  assert.deepEqual(projectUserInbox(records), { pending: [{ id: 'first' }, { id: 'second' }], delivered: [], sent: [] })
  assert.deepEqual(projectEvents(records), { events: [{ op: 'a' }, { op: 'b' }], total: 402 })
})

test('history merges events before notices at equal timestamps', () => {
  const row = (kind: string) => ({ at: 'same', kind, actor: 'a', detail: {} })
  const records = table(['agent_history:7', [['notice:1', row('notice')], ['event:20', row('second')], ['event:3', row('first')]]])
  assert.deepEqual(projectHistory(records, '7').map(row => row.kind), ['first', 'second', 'notice'])
  assert.deepEqual(projectHistory(records, '8'), [])
})

test('mailbox overlays stages without mutating durable rows or mixing folders', () => {
  const pending = { folder: 'pending', order: ['same', 0, 1], batch: 'tok', mail: { id: 'p', body: 'pending' } }
  const sent = (id: string, first: string) => ({ folder: 'sent', order: ['same', 0, first, '00000000000000000001'], mail: { id, to: 'recipient' } })
  const records = table(['agent_mail:7', [['7/pending:delivery:1:0', pending],
    ['7/sent:mail_log:2', sent('later', '00009007199254740993')],
    ['7/sent:mail_log:1', sent('earlier', '00009007199254740992')],
    ['7/delivered:mail_log:8', { folder: 'delivered', order: [8], mail: { id: 'd' } }]]])
  const runtime = new Map([['7', { epoch: 'e', seq: 3, mail_stages: { tok: 'steer' } }]])
  const result = projectMailbox(records, runtime, '7')
  assert.equal(result.pending[0].stage, 'steer')
  assert.equal('stage' in pending.mail, false)
  assert.deepEqual(result.sent.map(row => row.id), ['earlier', 'later'])
  assert.deepEqual(result.delivered.map(row => row.id), ['d'])
  assert.equal(projectMailbox(records, new Map(), '7').pending[0].stage, undefined)
})
