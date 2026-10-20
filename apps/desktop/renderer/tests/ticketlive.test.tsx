import { inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { ToolChip } from '../src/canvas/desk'
import { forgetWorkInflight } from '../src/api'
import { RecordFeed } from '../src/recordfeed'
import { OrgRecordContext } from '../src/recordsession'

const cursor = { org_uuid: 'fixture-org', incarnation: 'one', rev: 1 }
const call = { id: 'old-call', name: 'mcp__orgtree__orgtree_work', arg: 'update repair', result: '{}',
  started_at: '2026-10-19T10:00:00Z', ended_at: '2026-10-19T10:00:01Z',
  refs: [{ kind: 'ticket' as const, id: 'repair', status_change: { from: 'blocked', to: 'done' } }] }
const response = (status: string) => new Response(JSON.stringify({ references: [{ slug: 'repair', title: 'Repair fixture', status }] }),
  { status: 200, headers: { 'content-type': 'application/json' } })
function feed() {
  const f = new RecordFeed({ snapshot: async () => { throw Error('No extra baseline') }, catchup: async () => { throw Error('No reconnect loop') },
    project: r => r, publish: () => {}, error: e => { throw e } })
  f.receive({ type: 'record_snapshot', cursor, records: [] }); return f
}
const view = (f: ReturnType<typeof feed>) => <OrgRecordContext.Provider value={{ slug: 'synthetic', session: f }}>
  <ToolChip t={call} slug="synthetic" nid="author" onWorkLink={() => {}} />
</OrgRecordContext.Provider>

test('native record changes repaint an old transcript card without a legacy live bump', async t => {
  forgetWorkInflight(); const f = feed(); let status = 'blocked'
  globalThis.fetch = async () => response(status)
  const v = await mountView(view(f), el => el); t.after(async () => { await v.unmount(); f.dispose() })
  const oldCard = v.el.querySelector('.tool-ticket')
  assert.ok(v.el.querySelector('.tool-ticket.status-blocked'))
  status = 'done'
  await inAct(async () => { f.receive({ type: 'record_changes', ...cursor, from: 1, to: 2, upserts: [], tombstones: [] }); await Promise.resolve() })
  assert.ok(v.el.querySelector('.tool-ticket.status-done'), 'accepted native org cursor must refresh current reference')
  assert.equal(oldCard === v.el.querySelector('.tool-ticket'), true, 'the same old card updates in place')
  assert.equal(v.el.querySelector('.tool-work-transition')?.textContent, 'Blocked → Done')
})

test('native runtime-only publications do not refetch ticket references', async t => {
  forgetWorkInflight(); const f = feed(); let reads = 0
  globalThis.fetch = async () => { ++reads; return response('blocked') }
  const v = await mountView(view(f), el => el); t.after(async () => { await v.unmount(); f.dispose() })
  const socket = f.socketOpened(() => {})
  assert.equal(reads, 1)
  await inAct(() => {
    for (let seq = 1; seq <= 20; seq++) f.receiveSocket({ type: 'agent_runtime', ...cursor, epoch: 'host', seq, full: true,
      agents: { '1': { epoch: 'host', seq, busy: true } } }, socket)
  })
  assert.equal(reads, 1, 'runtime token/clock frames at the same cursor are not docket invalidations')
})
