import { createRoot } from 'react-dom/client'
import { Msg } from '../src/canvas/desk'
import { RecordFeed } from '../src/recordfeed'
import { OrgRecordContext } from '../src/recordsession'
const cursor = { org_uuid: 'fixture-org', incarnation: 'one', rev: 1 }
const feed = new RecordFeed({ snapshot: async () => { throw Error('No extra baseline') }, catchup: async () => { throw Error('No extra catchup') },
  project: r => r, publish: () => {}, error: e => { throw e } })
feed.receive({ type: 'record_snapshot', cursor, records: [] })
let status = 'blocked', reads = 0
window.fetch = (async () => {
  ++reads
  return new Response(JSON.stringify({ references: [{ slug: 'repair', title: 'Synthetic repair', status }] }),
    { status: 200, headers: { 'content-type': 'application/json' } })
}) as typeof fetch
Object.assign(window, {
  ticketLiveChange: (next: string) => {
    status = next
    const from = feed.cursor!.rev
    feed.receive({ type: 'record_changes', ...cursor, from, to: from + 1, upserts: [], tombstones: [] })
  }, ticketLiveReads: () => reads,
})
createRoot(document.getElementById('root')!).render(<main style={{ margin: '48px auto', width: 860 }}>
  <h2>Ticket status after the tool call</h2>
  <p className="dim">This old transcript card stays mounted while the ticket changes from Blocked to Done.</p>
  <OrgRecordContext.Provider value={{ slug: 'synthetic', session: feed }}>
    <Msg slug="synthetic" nid="author" onWorkLink={() => {}} m={{ role: 'assistant', text: '', seq: 1,
      ts: '2026-10-19T10:00:00Z', tools: [{ id: 'old-call', name: 'mcp__orgtree__orgtree_work', arg: 'update repair', result: '{}',
        started_at: '2026-10-19T10:00:00Z', ended_at: '2026-10-19T10:00:01Z',
        refs: [{ kind: 'ticket', id: 'repair', status_change: { from: 'blocked', to: 'done' } }] }] }} />
  </OrgRecordContext.Provider>
</main>)
