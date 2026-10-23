import { createRoot } from 'react-dom/client'
import { DeskChat } from '../src/canvas/desk'
import type { CanvasNode } from '../src/canvas/shared'
import '../src/styles.css'
import '../src/shell.css'

const nodes = ['short-queue', 'long-queue'].map(id => ({ id, kind: 'agent', state: 'live', tier: 'sol',
  generation: 1, children: [], seat: 2, grant: 0, scope: { tools: {}, add_dirs: [] },
  configured_scope: { tools: {}, add_dirs: [] }, turns: [], lineage: [], audiences_held: [] } as unknown as CanvasNode))
const map = new Map(nodes.map(node => [node.id, node]))
globalThis.fetch = async input => {
  const id = String(input).includes('long-queue') ? 'long-queue' : 'short-queue'
  const pending_mail = Array.from({ length: id === 'long-queue' ? 6 : 1 }, (_, i) => ({
    id: `${id}-${i}`, from: '@user', kind: 'message', body: `Please check queued item ${i + 1}.`,
    at: '2026-10-23T14:00:00Z',
  }))
  return new Response(JSON.stringify({ messages: [], pending_mail, live: [], busy: false,
    pending: [], delivered: [], items: [], docs: [], references: {}, after: '0:0', has_more: false, total: 0 }),
  { status: 200, headers: { 'Content-Type': 'application/json' } })
}
document.documentElement.dataset.theme = 'dark'
document.body.style.cssText = 'margin:0;padding:20px;background:#202020;color:#ddd;box-sizing:border-box'
createRoot(document.getElementById('root')!).render(<div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18 }}>
  {nodes.map((node, i) => <section key={node.id} data-probe={i ? 'long' : 'short'}>
    <p style={{ margin: '0 0 12px' }}>{i ? 'Six queued messages · automatic collapse' : 'One queued message · toggle always available'}</p>
    <div style={{ height: 600, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <DeskChat node={node} map={map} slug="queued-fold-capture" op={async () => ({})} toast={() => {}} bare />
    </div>
  </section>)}
</div>)
