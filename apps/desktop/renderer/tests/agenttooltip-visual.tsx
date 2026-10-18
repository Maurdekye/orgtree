import { createRoot } from 'react-dom/client'
import {
  AgentNavProvider, useProvideAgentNav,
} from '../src/canvas/agentnav'
import { NodeSquare } from '../src/canvas/cards'
import type { CanvasNode } from '../src/canvas/shared'
import type { OpResult } from '../src/types'
import type { AgentTooltipInfo } from '../src/canvas/agentnav'

const id = 'coordinator-opus'
const info: AgentTooltipInfo = { title: 'Claude Opus 5.5 · high' }
const node = {
  id, state: 'live', tier: 'opus', model_id: 'claude-opus-5-5',
  children: [], seat: 1, grant: 0, free: 0, scope: { tools: {}, add_dirs: [] },
} as unknown as CanvasNode
const noop = () => {}

function RegisteredCard() {
  useProvideAgentNav(() => [], target => target === id ? info : null)
  return <main style={{
    position: 'relative', width: 1000, height: 700, overflow: 'hidden',
    background: '#111827', color: '#f9fafb', padding: 0,
  }}>
    <NodeSquare node={node} pos={{ x: 120, y: 140 }} lod="norm" focused={false}
      dragging={false} isDrop={false} seats={{ opus: 4 }} map={new Map([[id, node]])}
      op={() => Promise.resolve({} as OpResult)} slug="org" toast={noop}
      pxc={1} zoom={1} compactAt={0.8} maxTop={0} cascadeAlloc
      onSpawn={noop} onConfig={noop} onInbox={noop} onLineage={noop}
      onRecenter={noop} onJump={noop} onMailLink={noop} onWorkLink={noop}
      onDragStart={noop} onDragMove={noop} onDragEnd={noop} onDragCancel={noop} />
  </main>
}

createRoot(document.getElementById('root')!).render(
  <AgentNavProvider><RegisteredCard /></AgentNavProvider>,
)
