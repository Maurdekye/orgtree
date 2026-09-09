// Browser fixture for subordinatebadge_probe.py. Mounts the REAL `Msg`
// component (which mounts the real `SegmentList`) with an untyped/legacy
// mail row — the shape most subordinate messages actually have (plain
// body, no schema'd `ev`) — so the badge and sender-navigation fix from
// label-subordinate-messages-and-link-their-sender renders exactly as it
// does in the live transcript. A second, `.mailrow`-wrapped instance of
// the SAME badge class sits alongside it as a cross-check: both are
// expected to compute to the identical bordered-pill treatment now that
// the rule is no longer scoped to `.mailrow` alone.
import { createRoot } from 'react-dom/client'
import { Msg } from '../src/canvas/desk'
import { AgentDirectoryProvider } from '../src/canvas/identity'
import type { AgentDirectory } from '../src/canvas/identity'
import type { ChatMessage } from '../src/types'

const opened: string[] = []
const dir: AgentDirectory = {
  resolve: (id: string) => (id === 'list-controls' ? { tier: 'sonnet' } : undefined),
  onFocus: (id: string) => { opened.push(id) },
}
;(window as unknown as { opened: string[] }).opened = opened

const legacyReport: ChatMessage = {
  role: 'user', text: 'fallback', seq: 1, ts: '2026-09-09T13:52:15Z',
  segments: [{ kind: 'mail', rows: [{
    id: 'row-1', from: 'list-controls', relationship: 'your report', kind: 'status',
    at: '2026-09-09T13:52:15Z',
    body: 'I received the supplemental scope: fix only narrow header/control flex behavior.',
  }] }],
}

function Fixture() {
  return <div id="transcript">
    <AgentDirectoryProvider value={dir}>
      <Msg m={legacyReport} slug="probe" nid="agent" />
    </AgentDirectoryProvider>
    {/* the SAME class, `.mailrow`-wrapped — the badge's original intended
        context, kept as a same-page cross-check that unscoping the rule
        did not change what it looks like there either */}
    <div id="mailrow-reference" className="mailrow">
      <span className="event-row-kind">Status</span>
    </div>
  </div>
}

createRoot(document.getElementById('root')!).render(<Fixture />)
