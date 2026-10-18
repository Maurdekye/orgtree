// Synthetic Attention list for attnmention-visual: @user mention rows from
// agents' transcripts beside an urgent mail and a mail that mentions @user,
// so the mention row can be compared with the inbox rows around it. Fixture
// data only; window.fetch answers as the legacy engine does in tests.
import { createRoot } from 'react-dom/client'
import { AttentionQueue } from '../src/attention/AttentionQueue'
import { AgentNavProvider, useProvideAgentNav } from '../src/canvas/agentnav'
import { applyTheme } from '../src/themes'
import type { TreeNode, TreePayload } from '../src/types'

const node = (id: string, tier: string, blurb: string, at: string) => ({
  id, state: 'live', tier, children: [],
  user_mention: { id: `${id}:1`, turn_id: 1, seq: 0, event_id: `ev-${id}`, blurb, at },
}) as unknown as TreeNode
const roots = [
  // the user's screenshot (2026-10-18 14:39Z): the engine cut both ends mid-word
  node('coordinator-opus', 'opus', '…nd you one short message @user. It can already message y…', '2026-10-18T14:39:00Z'),
  node('helper-transcript-sol', 'sol', 'Done with the migration. Heads up @user: it finished cleanly and the logs are in the evidence folder.', '2026-10-18T14:20:00Z'),
  node('skilltree-opus', 'opus', 'please make sure that the overnight build and the smoke tests are done before @user wakes up tomorrow…', '2026-10-18T13:55:00Z'),
]
const pending = [
  { id: 'u1', from: 'rig-sol-b', kind: 'message', at: '2026-10-18T14:30:00Z', urgent: true, urgent_reason: 'the alpha.9 smoke failed',
    body: 'The alpha.9 smoke failed on the synthetic rig; the details are in the receipt.' },
  { id: 'u2', from: 'taskbar-orgs-sol', kind: 'message', at: '2026-10-18T14:10:00Z', mailbox_attention: true,
    body: 'The picker structure is ready, @user, please try the new popover when you can.' },
]
window.fetch = async (input: RequestInfo | URL) => {
  const url = String(input)
  if (url.endsWith('/api/app/records'))
    return new Response(JSON.stringify({ detail: 'fixture uses the legacy engine' }), { status: 501 })
  const json = url.includes('/work-items') ? { items: [], archived: [], backlogged: [],
    counts: { attention: 0, active: 0, archived: 0, backlogged: 0 }, now: '2026-10-18T15:00:00Z' }
    : url.includes('/inbox') ? { pending, delivered: [], sent: [] } : {}
  return new Response(JSON.stringify(json), { headers: { 'Content-Type': 'application/json' } })
}
function Fixture() {
  useProvideAgentNav((id) => [{ label: `Desk of ${id}`, action: () => {} }], (id) => ({ title: `Agent ${id}` }))
  const tree = { slug: 'org', roots, asks: [] } as unknown as TreePayload
  return <div id="probe" style={{ width: 940, height: 560, display: 'flex', flexDirection: 'column', padding: 12, boxSizing: 'border-box' }}>
    <AttentionQueue slug="org" tree={tree} toast={() => {}} onFocusAgent={() => {}}
      treeStatus={{ loading: false, stale: false, unavailable: false }} />
  </div>
}
applyTheme('orgtree')
createRoot(document.getElementById('root')!).render(<AgentNavProvider><Fixture /></AgentNavProvider>)
