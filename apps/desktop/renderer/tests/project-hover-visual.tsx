import { createRoot } from 'react-dom/client'
import { ProjectSquare } from '../src/canvas/projectcard'
import { AgentNavProvider } from '../src/canvas/agentnav'
import type { CanvasNode } from '../src/canvas/shared'
import type { OpResult } from '../src/types'

const noop = () => {}
const id = 'project-transparency-complete-reporting-and-placement'
const node = { id, title: id, kind: 'project', state: 'live', tier: 'project', children: [],
  scope: { tools: {}, add_dirs: [] }, turns: [] } as unknown as CanvasNode
createRoot(document.getElementById('root')!).render(<AgentNavProvider>
  <div className="space" style={{ position: 'absolute', left: 100, top: 150, width: 2400, height: 1400,
    transform: 'scale(.24)', transformOrigin: 'top left', '--invzf': 1 / .24 } as React.CSSProperties}>
    <ProjectSquare node={node} lod="mini" pos={{ x: 1400, y: 500 }} zoom={.24}
      dragging={false} isDrop={false} op={async () => ({} as OpResult)} slug="synthetic-hover" toast={noop}
      hire={{}} seats={{}} onHire={noop} onNewProject={noop} onInbox={noop}
      onDragStart={noop} onDragMove={noop} onDragEnd={noop} onDragCancel={noop} />
  </div>
</AgentNavProvider>)
