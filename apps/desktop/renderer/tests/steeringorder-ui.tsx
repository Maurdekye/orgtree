import { createRoot } from 'react-dom/client'
import { DeskChat } from '../src/canvas/desk'
import type { CanvasNode } from '../src/canvas/shared'
import '../src/styles.css'
import '../src/shell.css'

const report = { id: 'reviewer', parent: 'worker', tier: 'sol', kind: 'agent', state: 'live',
  generation: 1, children: [], seat: 2, grant: 0 } as unknown as CanvasNode
const worker = { id: 'worker', tier: 'sol', kind: 'agent', state: 'live', generation: 1,
  busy: true, children: [report], seat: 2, grant: 8, free: 6, mail_pending: 0,
  scope: { tools: {}, add_dirs: [], effort: 'high' }, configured_scope: { tools: {}, add_dirs: [] },
  turns: [], lineage: [], audiences_held: [] } as unknown as CanvasNode
globalThis.fetch = async (input, init) => new Response(JSON.stringify(
  init?.method === 'POST' && String(input).endsWith('/message') ? { id: 'sent-1', steering: true }
    : { messages: [{ role: 'assistant', text: 'I am checking the results. Send any new direction below.',
      seq: 0, event_id: 'reply-1' }], pending_mail: [], live: [], pending: [], delivered: [],
      items: [], docs: [], references: {}, after: '0:0', has_more: false, total: 0 }
), { status: 200, headers: { 'Content-Type': 'application/json' } })
document.documentElement.dataset.theme = 'dark'
document.body.style.cssText = 'margin:0;padding:20px;background:#202020;color:#ddd;box-sizing:border-box'
createRoot(document.getElementById('root')!).render(<div style={{ height: 640, maxWidth: 760, margin: 'auto' }}>
  <DeskChat node={worker} map={new Map([[worker.id, worker], [report.id, report]])}
    slug="steering-capture" op={async () => ({})} toast={() => {}} bare onJump={() => {}} />
</div>)
