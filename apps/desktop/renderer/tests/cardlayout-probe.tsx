// Browser fixture for cardlayout_probe.py. This mounts the real NodeSquare
// component; the probe supplies the stylesheet and measures the resulting
// boxes/cascade in Edge.
import { createRoot } from 'react-dom/client'
import { NodeSquare } from '../src/canvas/cards'
import type { CanvasNode } from '../src/canvas/shared'
import type { OpResult } from '../src/types'

const noop = () => {}
const op = () => Promise.resolve({} as OpResult)
const seats = { haiku: 1, terra: 2, sol: 5, luna: .2, flash: 1 }
const hire = { enabled: true, installed: true, reason: null }
const opened: string[] = []
const configured: string[] = []
// the click→focus pipeline's first hop: a pointerdown that reaches the CARD
// (not a shortcut button's stopPropagation) calls onDragStart — recording it
// lets the probe prove a far-zoom click is routed to focusing, not swallowed
const dragStarts: string[] = []

// an idle node has a COMPLETED TURN, so its age actually renders — without one
// LastTurnAge draws nothing and the placement check would measure an empty seat
const lastTurn = [{ at: new Date(Date.now() - 120_000).toISOString(), killed: false,
  cost: 0, denials: 0 }]

function node(id: string, tier: string, busy: boolean): CanvasNode {
  return {
    id, title: id, state: 'live', tier, model_id: tier, seat: seats[tier as keyof typeof seats] ?? 1,
    grant: 0, free: 0, scope: { tools: {}, add_dirs: [] }, children: [], lineage: [],
    turns: lastTurn,
    audiences_held: [], bearer_state: null, frozen: null, limit_locked: false, mail_pending: 3,
    last_status: busy ? { status: 'working', summary: 'browser fixture', at: '' }
      : { status: 'done', summary: 'idle positive control', at: '' }, prev_status: null,
    inflight_at: busy ? new Date().toISOString() : null, last_denials: [], occupancy: 620, context_window: 1000, occupancy_est: false,
    busy, activity: { phase: 'tool', tool: 'shell · browser fixture' }, proc_warm: true,
    proc_live: true, proc_relaunch: false, proc_relaunch_reason: null, isBearerOf: undefined,
  } as unknown as CanvasNode
}

function card(n: CanvasNode, lod: 'norm' | 'mini', pinned = false,
  pos = { x: 0, y: 0 }) {
  return <NodeSquare node={n} pos={pos} lod={lod} focused={false}
    dragging={false} isDrop={false} seats={seats} codexHire={hire} antigravityHire={hire}
    claudeHire={hire} map={new Map([[n.id, n]])} op={op} slug="probe" toast={noop}
    pxc={1} zoom={lod === 'mini' ? .4 : .8} compactAt={.8} pub={false} maxTop={100}
    kioskRemaining={null} cascadeAlloc onSpawn={noop} onSpawnSide={noop} onSpawnTop={noop}
    onConfig={() => { configured.push(n.id) }} onInbox={noop} onDocket={noop}
    onLineage={noop} onOpenDoc={noop} onRecenter={noop}
    onOpenAgentGallery={noop}
    onJump={noop} onMailLink={noop}
    onDragStart={(_e, id) => { dragStarts.push(id) }} onDragMove={noop} onDragEnd={noop}
    onDragCancel={noop} onPin={() => { opened.push(n.id) }} pinned={pinned} />
}

const nodes = [
  node('claude-agent', 'haiku', true),
  node('codex-terra-agent', 'terra', true),
  node('codex-sol-agent', 'sol', true),
  node('luna-agent', 'luna', true),
  node('agy-agent', 'flash', true),
  node('idle-luna-agent', 'luna', false),
  node('idle-flash-agent', 'flash', false),
]
;(nodes[0] as unknown as { documents: unknown[] }).documents = [{ id: 'presented-doc' }]
createRoot(document.getElementById('root')!).render(<>
  <section id="normal" style={{ position: 'relative', height: 150 }}>{nodes.map((n, i) => <div key={n.id}>{card(n, 'norm', false, { x: i * 150, y: 0 })}</div>)}</section>
  <section id="mini" style={{ position: 'relative', height: 150 }}>{nodes.map((n, i) => <div key={n.id}>{card(n, 'mini', false, { x: i * 150, y: 0 })}</div>)}</section>
  {/* norm, not mini: mini cards no longer mount ANY action row, so a mini
      pinned card would make the no-duplicate-expand check pass vacuously */}
  <section id="pinned" style={{ position: 'relative', height: 150 }}>{card(node('already-pinned', 'terra', false), 'norm', true, { x: 600, y: 0 })}</section>
</>)
;(window as unknown as { opened: string[]; configured: string[] }).opened = opened
;(window as unknown as { configured: string[] }).configured = configured
;(window as unknown as { dragStarts: string[] }).dragStarts = dragStarts
