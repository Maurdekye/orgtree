import { createRoot } from 'react-dom/client'
import { useRef } from 'react'
import { CurrentOrg } from '../src/popout'
import { PinLayer, addPin } from '../src/canvas/pins'
import { TranscriptSelectionContext } from '../src/canvas/transcriptselection'
import type { CanvasNode } from '../src/canvas/shared'
import '../src/styles.css'
import '../src/shell.css'

const slug = 'selection-menu-capture'
const node = { id: 'writer', kind: 'agent', state: 'live', tier: 'sol', generation: 1, children: [], seat: 2, grant: 0,
  scope: { tools: {}, add_dirs: [] }, configured_scope: { tools: {}, add_dirs: [] }, turns: [], lineage: [], audiences_held: [] } as unknown as CanvasNode
const map = new Map([[node.id, node]])
globalThis.fetch = async () => new Response(JSON.stringify({ messages: [{ role: 'assistant', event_id: 'e1', seq: 1,
  text: 'The selection menu should open beside this passage in the pinned desk.', at: '2026-10-24T12:00:00Z' }],
  pending_mail: [], pending: [], delivered: [], live: [], busy: false, items: [], docs: [], references: {}, after: '1:0', has_more: false, total: 1 }),
{ status: 200, headers: { 'Content-Type': 'application/json' } })
document.documentElement.dataset.theme = 'dark'
document.body.style.cssText = 'margin:0;background:#202020;color:#ddd'
addPin(slug, node.id, { x: 500, y: 45, w: 480, h: 620 })
const noop = () => {}
function Fixture() {
  const viewport = useRef<HTMLDivElement>(null)
  return <CurrentOrg.Provider value={slug}><TranscriptSelectionContext.Provider value={{ org: slug, agent: node.id, generation: 1 }}>
    <div ref={viewport} style={{ position: 'relative', width: '100vw', height: '100vh' }}>
      <p style={{ padding: 28, maxWidth: 360 }}>Selection replies · pinned desk<br />Right-click selected transcript text.</p>
      <PinLayer slug={slug} map={map} viewportRef={viewport} targetOf={() => null} op={async () => ({})} toast={noop}
        maxTop={10} pxc={1} onMailLink={noop} onWorkLink={noop} onOpenDoc={noop} onLineage={noop} onConfig={noop} onJump={noop} onShowOnCanvas={noop} />
    </div>
  </TranscriptSelectionContext.Provider></CurrentOrg.Provider>
}
createRoot(document.getElementById('root')!).render(<Fixture />)
