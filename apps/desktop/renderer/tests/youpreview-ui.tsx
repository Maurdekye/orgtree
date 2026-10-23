import { createRoot } from 'react-dom/client'
import { DeskChat } from '../src/canvas/desk'
import type { CanvasNode } from '../src/canvas/shared'
import { hireSegments, requestSegments, requestText } from './youpreview-fixture'
import '../src/styles.css'
import '../src/shell.css'

const node = { id: 'qa-lead', kind: 'agent', state: 'live', tier: 'sol', generation: 1,
  children: [], seat: 2, grant: 0, scope: { tools: {}, add_dirs: [] },
  configured_scope: { tools: {}, add_dirs: [] }, turns: [], lineage: [], audiences_held: [] } as unknown as CanvasNode
const messages = [
  { role: 'user', seq: 0, text: requestText, segments: requestSegments },
  { role: 'user', seq: 1, text: 'Four hire notices', segments: hireSegments },
  { role: 'assistant', seq: 2, text: Array.from({ length: 18 }, (_, i) =>
    `Checked area ${i + 1}: the release checklist is ready for the team to review.`).join('\n\n') },
]
globalThis.fetch = async () => new Response(JSON.stringify({ messages, pending_mail: [], live: [],
  pending: [], delivered: [], items: [], docs: [], references: {}, after: '0:0', has_more: false, total: 0 }),
{ status: 200, headers: { 'Content-Type': 'application/json' } })
document.documentElement.dataset.theme = 'dark'
document.body.style.cssText = 'margin:0;padding:20px;background:#202020;color:#ddd;box-sizing:border-box'
createRoot(document.getElementById('root')!).render(<div style={{ height: 640, maxWidth: 760, margin: 'auto',
  display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
  <DeskChat node={node} map={new Map([[node.id, node]])} slug="you-preview-capture"
    op={async () => ({})} toast={() => {}} bare />
</div>)
