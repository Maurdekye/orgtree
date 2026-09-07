import { createRoot } from 'react-dom/client'
import { AgentGalleryView, DocGalleryModal } from '../src/canvas/gallery'
const rows = [
  { id: 'a-md', node: 'alpha', title: 'Alpha markdown', at: '2026-09-07T00:00:00Z', format: 'md', evicted: false, node_state: 'live', bytes: 40 },
  { id: 'a-html', node: 'alpha', title: 'Alpha HTML', at: '2026-09-07T00:01:00Z', format: 'html', evicted: false, node_state: 'live', bytes: 80 },
  { id: 'b-md', node: 'beta', title: 'Beta private', at: '2026-09-07T00:02:00Z', format: 'md', evicted: false, node_state: 'live', bytes: 40 },
]
const long = Array.from({length: 80}, (_, i) => `line ${i + 1}: long body`).join('\n')
;(globalThis as any).__calls = []
;(globalThis as any).fetch = (url: string) => {
  ;(globalThis as any).__calls.push(String(url))
  const id = url.match(/\/documents\/([^/?]+)$/)?.[1]
  const response = id ? { id, node: id.startsWith('a-') ? 'alpha' : 'beta', title: id, body: id === 'a-md' ? long : 'html body' } : { documents: rows }
  return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: () => Promise.resolve(response) })
}
const node = { id: 'alpha', state: 'live', tier: 'opus', documents: [{ id: 'stale', title: 'stale copy' }] }
createRoot(document.getElementById('root')!).render(<div className="desk-fixture" style={{width: '900px', height: '600px'}}><AgentGalleryView slug="org1" nid="alpha" node={node} toast={() => {}} onChanged={() => {}} /><div style={{display: 'none'}}><DocGalleryModal slug="org1" toast={() => {}} close={() => {}} /></div></div>)
