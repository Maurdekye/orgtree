import { NodeSquare } from '../src/canvas/cards'
import { ProjectSquare } from '../src/canvas/projectcard'
import { agent, project, bunchTree } from './projectbunch-fixture'
import type { CanvasNode } from '../src/canvas/shared'
import type { Watchdog } from '../src/types'

const noop = () => {}, op = async () => ({ ok: true } as never)
const hire = { enabled: true, installed: true, reason: null }
export function CardHoverCard({ kind, lod, crowded, serial = 0, effort }: { kind: 'agent' | 'project'; lod: 'norm' | 'mini'; crowded: boolean; serial?: number; effort?: string }) {
  const id = kind === 'project' ? 'project-transparency-committee' : 'agent-with-a-very-long-display-name'
  const node = { ...(kind === 'agent' ? agent(id) : project(id)), tier: kind === 'agent' ? 'sol' : 'project',
    ...(effort ? { scope: { ...agent(id).scope, effort } } : {}),
    configured_scope: crowded ? { slots_capacity: 9999999, mail_queue: 'ack' } : {},
    mail_pending: crowded ? 9999999 : 0, mail_held: crowded ? 9999999 : 0,
    proc_warm: false, proc_live: false, busy: false, occupancy: 0, context_window: 1000,
  } as unknown as CanvasNode
  const tree = { ...bunchTree([node]), watchdogs: crowded ? (['project_listener','listener_watch','fair_queue'] as const).map((k,i) => ({
    id: 'observer/'+i, owner: 'observer', name: k, kind: k, target: id, state: 'armed', at: '', count: 999999999,
  } as Watchdog)) : [] }
  const pos = { x: kind === 'agent' ? 50 : 300, y: 65 }
  const common = { node, pos, lod, dragging: false, isDrop: false, zoom: 1, op, slug: 'hover-fit', toast: noop,
    retiredCount: 1, onRetired: noop, onDragStart: noop, onDragMove: noop, onDragEnd: noop, onDragCancel: noop }
  return <div data-kind={kind} data-serial={serial}>
    {kind === 'project' ? <ProjectSquare {...common} tree={tree} hire={{}} seats={{}} onHire={noop} onNewProject={noop} onInbox={noop} />
      : <NodeSquare {...common} focused={false} seats={{ sol: 1 }} codexHire={hire} antigravityHire={hire} claudeHire={hire}
        map={new Map([[id,node]])} pxc={1} compactAt={.8} maxTop={100} cascadeAlloc
        slotHolds={crowded ? Array.from({ length: 10 },(_,i) => ({ project: 'pool-'+i, agent:id, slot:1, lease:'lease-'+i, since:'' })) : []}
        onSpawn={noop} onSpawnSide={noop} onSpawnTop={noop} onConfig={noop} onInbox={noop} onLineage={noop}
        onOpenDoc={noop} onRecenter={noop} onJump={noop} onMailLink={noop} onDragStart={noop} onDragMove={noop}
        onDragEnd={noop} onDragCancel={noop} pinned={false} />}
  </div>
}
