import { createRoot } from 'react-dom/client'
import { CurrentOrg } from '../src/popout'
import { BulkCompactConfirm } from '../src/canvas/bulkcompact'
import { applyTheme } from '../src/themes'
import type { CanvasNode } from '../src/canvas/shared'

applyTheme('orgtree')
const agent = (id: string, extra = {}): CanvasNode => ({ id, state: 'live', tier: 'sonnet', children: [], session_id: id + '-session', occupancy: 40000, context_window: 200000, ...extra } as CanvasNode)
const targets = [agent('lead'), agent('muse-worker'), agent('codex-worker'), agent('busy-worker', { busy: true }), agent('new-worker', { session_id: null })]
window.fetch = async url => {
  const id = String(url).split('/nodes/')[1]?.split('/')[0]
  return new Response(JSON.stringify(id === 'codex-worker'
    ? { supported: false, reason: 'Normal compaction is not available for Codex in Orgtree.' }
    : { supported: true, reason: null }), { headers: { 'Content-Type': 'application/json' } })
}
createRoot(document.getElementById('root')!).render(<CurrentOrg.Provider value="fixture">
  <div style={{ padding: 24, color: 'var(--ink)' }}>Synthetic subtree selection</div>
  <BulkCompactConfirm title="Compact subtree of lead?" scope="subtree of lead" targets={targets}
    op={async () => ({} as never)} toast={() => {}} close={() => {}} />
</CurrentOrg.Provider>)
