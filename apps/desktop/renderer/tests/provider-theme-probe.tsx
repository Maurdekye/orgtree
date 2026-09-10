// Actual cards and independently hosted desk bodies under a neutral app theme.
import { createRoot } from 'react-dom/client'
import { NodeSquare } from '../src/canvas/cards'
import { DeskChat } from '../src/canvas/desk'
import { applyTheme } from '../src/themes'
import type { CanvasNode } from '../src/canvas/shared'
import type { OpResult } from '../src/types'

const noop = () => {}
const op = () => Promise.resolve({} as OpResult)
const hire = { enabled: true, installed: true, reason: null }
const tiers = ['haiku', 'sonnet', 'opus', 'fable', 'astra', 'pro', 'or-test']
const nodes = tiers.map(tier => ({
  id: tier + '-agent', tier, model_id: tier, generation: 1, state: 'live',
  grant: 0, free: 0, seat: 1, scope: { tools: {}, add_dirs: [] },
  children: [], lineage: [], turns: [], audiences_held: [],
  last_status: { status: 'idle', summary: '', at: '' },
  busy: false, proc_warm: true, proc_live: true, mail_pending: 1,
} as unknown as CanvasNode))
const map = new Map(nodes.map(n => [n.id, n]))
window.fetch = async () => new Response(JSON.stringify({
  chat: [], live: [], pending_mail: [], documents: [], history: [],
  providers: [], items: [], enabled: false,
}), { headers: { 'Content-Type': 'application/json' } })
applyTheme('orgtree')
;(window as unknown as { setProbeTheme: typeof applyTheme }).setProbeTheme = applyTheme

createRoot(document.getElementById('root')!).render(<>
  <h2 style={{ color: 'var(--accent)' }}>Orgtree: neutral application theme</h2>
  <section id="cards" style={{ position: 'relative', height: 175 }}>
    {nodes.map((node, i) => <NodeSquare key={node.id} node={node}
      pos={{ x: 20 + i * 155, y: 15 }} lod="norm" focused={false}
      dragging={false} isDrop={false} seats={{}} codexHire={hire}
      antigravityHire={hire} claudeHire={hire} map={map} op={op}
      slug="fixture" toast={noop} pxc={1} zoom={.8} compactAt={.8}
      pub={false} maxTop={100} kioskRemaining={null} cascadeAlloc
      onSpawn={noop} onSpawnSide={noop} onSpawnTop={noop} onConfig={noop}
      onInbox={noop} onDocket={noop} onLineage={noop} onOpenDoc={noop}
      onRecenter={noop} onJump={noop} onMailLink={noop}
      onDragStart={noop} onDragMove={noop} onDragEnd={noop}
      onDragCancel={noop} onPin={noop} />)}
  </section>
  <section id="standalone" style={{ width: 900, height: 430, margin: 20 }}>
    <DeskChat node={nodes[3]} map={map} op={op} slug="fixture"
      toast={noop} pub={false} bare onPin={noop} onConfig={noop} />
  </section>
</>)
