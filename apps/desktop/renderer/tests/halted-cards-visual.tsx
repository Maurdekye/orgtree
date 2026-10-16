import { createRoot } from 'react-dom/client'
import { FarZoomStateIcon } from '../src/canvas/cards'
import { AgentWorkstate } from '../src/canvas/desk'
import type { CanvasNode } from '../src/canvas/shared'

const halted = {
  id: 'halted-agent', state: 'live', tier: 'haiku', halt: { phase: 'halted' },
  frozen: null, limit_locked: false, busy: false, waiting: false,
  phase: null, last_status: null, last_error: null,
} as unknown as CanvasNode
const idle = {
  id: 'idle-agent', state: 'live', tier: 'haiku', halt: null,
  frozen: null, limit_locked: false, busy: false, waiting: false,
  phase: null, last_status: { status: 'idle', summary: 'idle' }, last_error: null,
} as unknown as CanvasNode

function Card({ node, haltedState, zoom }: { node: CanvasNode; haltedState: boolean; zoom: 'mini' | 'norm' }) {
  return <article className={'sq ' + zoom + ' live tier-haiku prov-claude' + (haltedState ? ' halted' : '')}
    data-zoom={zoom}>
    {zoom === 'mini'
      ? <FarZoomStateIcon node={node} />
      : <div className="sq-meta"><div className="sq-workstate">
        <AgentWorkstate node={node} live turn={undefined} />
      </div></div>}
  </article>
}

createRoot(document.getElementById('root')!).render(
  <main className="halted-capture">
    <h1>Halted and idle card states</h1>
    <div className="halted-capture-zoom">
      <h2>Far zoom</h2>
      <div className="halted-capture-row">
        <section><h3>Halted</h3><Card node={halted} haltedState zoom="mini" /></section>
        <section><h3>Idle</h3><Card node={idle} haltedState={false} zoom="mini" /></section>
      </div>
    </div>
    <div className="halted-capture-zoom">
      <h2>Normal zoom</h2>
      <div className="halted-capture-row">
        <section><h3>Halted</h3><Card node={halted} haltedState zoom="norm" /></section>
        <section><h3>Idle</h3><Card node={idle} haltedState={false} zoom="norm" /></section>
      </div>
    </div>
  </main>,
)
