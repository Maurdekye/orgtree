// projectnode-visual.tsx — the project card at the canvas's two card zooms,
// for projectnode-visual.mjs (user 2026-10-17 21:20Z: no left-edge stripe,
// a much larger folder when zoomed out). The cards sit in a scaled world, as
// the canvas draws them; an agent card beside each is the comparison.
import { createRoot } from 'react-dom/client'
import { ProjectSquare } from '../src/canvas/projectcard'
import type { CanvasNode, OpResult } from '../src/canvas/shared'

const noop = () => {}
const project = {
  id: 'website', title: 'website', kind: 'project', state: 'live', tier: 'project', model_id: '',
  seat: 0, grant: 0, free: 0, scope: { tools: {}, add_dirs: [] }, charter: 'The company website.',
  children: [], lineage: [], turns: [], audiences_held: [], mail_pending: 0,
} as unknown as CanvasNode

function Card({ lod, x }: { lod: 'mini' | 'norm'; x: number }) {
  return <ProjectSquare node={project} pos={{ x, y: 0 }} lod={lod} dragging={false} isDrop={false}
    op={() => Promise.resolve({} as OpResult)} slug="org" toast={noop} zoom={lod === 'mini' ? 0.4 : 1.2}
    hire={{}} seats={{}} onHire={noop} onNewProject={noop} onInbox={noop}
    onDragStart={noop} onDragMove={noop} onDragEnd={noop} onDragCancel={noop} />
}

createRoot(document.getElementById('root')!).render(
  <main style={{ position: 'relative', width: 1000, height: 700, background: 'var(--bg)' }}>
    <div id="world" style={{ position: 'absolute', left: 60, top: 160, transform: 'scale(2.4)', transformOrigin: '0 0' }}>
      <Card lod="mini" x={0} />
      <Card lod="norm" x={170} />
    </div>
  </main>,
)
