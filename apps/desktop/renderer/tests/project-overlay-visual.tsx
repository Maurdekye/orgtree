import { createRoot } from 'react-dom/client'
import { NodeSquare } from '../src/canvas/cards'
import { ProjectSquare } from '../src/canvas/projectcard'
import type { CanvasNode } from '../src/canvas/shared'
import type { OpResult } from '../src/types'

const noop = () => {}
const op = async () => ({} as OpResult)
const hire = { enabled: true, installed: true, reason: null }
const agent = { id: 'mqtt-watchdog-opus', title: 'mqtt-watchdog-opus', state: 'live', tier: 'opus', model_id: 'opus',
  seat: 1, grant: 0, free: 0, scope: { tools: {}, add_dirs: [] }, children: [], lineage: [], turns: [], audiences_held: [],
  occupancy: 0, context_window: 1000, busy: false, proc_warm: false, proc_live: false, generation: 1 } as unknown as CanvasNode
const project = { ...agent, id: 'project-transparency-complete-reporting', title: 'project-transparency-complete-reporting',
  kind: 'project', tier: 'project' } as CanvasNode
createRoot(document.getElementById('root')!).render(<div className="space" style={{ position: 'absolute', left: 40, top: 60,
  width: 700, height: 400, transform: 'scale(1.3)', transformOrigin: 'top left' }}>
  <NodeSquare node={agent} pos={{ x: 60, y: 100 }} lod="norm" focused={false} dragging={false} isDrop={false}
    seats={{ opus: 1 }} codexHire={hire} antigravityHire={hire} claudeHire={hire} map={new Map([[agent.id, agent]])}
    op={op} slug="synthetic-overlay" toast={noop} pxc={1} zoom={1.3} compactAt={.8} maxTop={100} cascadeAlloc
    onSpawn={noop} onSpawnSide={noop} onSpawnTop={noop} onConfig={noop} onInbox={noop} onLineage={noop}
    onOpenDoc={noop} onRecenter={noop} onJump={noop} onMailLink={noop} onDragStart={noop} onDragMove={noop}
    onDragEnd={noop} onDragCancel={noop} pinned={false} />
  <ProjectSquare node={project} pos={{ x: 350, y: 100 }} lod="norm" zoom={1.3} dragging={false} isDrop={false}
    op={op} slug="synthetic-overlay" toast={noop} hire={{}} seats={{}} onHire={noop} onNewProject={noop}
    onInbox={noop} onDragStart={noop} onDragMove={noop} onDragEnd={noop} onDragCancel={noop} />
</div>)
