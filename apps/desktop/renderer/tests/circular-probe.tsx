// Browser fixture for circular_probe.py: real NodeSquare cards at the real
// layout() positions in Circular mode, radial wires drawn with the same
// edge-trim arithmetic as OrgCanvas.treeSeg.
import { createRoot } from 'react-dom/client'
import { NodeSquare } from '../src/canvas/cards'
import { layout, NODE_H, NODE_W, USER } from '../src/canvas/shared'
import type { CanvasNode } from '../src/canvas/shared'
import type { OpResult } from '../src/types'

const noop = () => {}
const op = () => Promise.resolve({} as OpResult)
const seats = { haiku: 1, terra: 2, sol: 5, luna: .2, flash: 1 }
const hire = { enabled: true, installed: true, reason: null }
const mk = (id: string, children: CanvasNode[] = []): CanvasNode => ({
  id, title: id, state: 'live', tier: 'haiku', model_id: 'haiku', seat: 1, grant: 0, free: 0,
  scope: { tools: {}, add_dirs: [] }, children, lineage: [], turns: [], audiences_held: [],
  bearer_state: null, frozen: null, limit_locked: false, mail_pending: 0,
  last_status: { status: 'done', summary: '', at: '' }, prev_status: null, inflight_at: null,
  last_denials: [], occupancy: 300, context_window: 1000, occupancy_est: false, busy: false,
  activity: null, proc_warm: true, proc_live: true, proc_relaunch: false, proc_relaunch_reason: null,
} as unknown as CanvasNode)
const team = (pre: string, fan: number[]): CanvasNode[] =>
  fan.length === 0 ? [] : Array.from({ length: fan[0]! }, (_, i) =>
    mk(`${pre}${i}`, team(`${pre}${i}.`, fan.slice(1))))
const eye = (kids: CanvasNode[]): CanvasNode =>
  ({ ...mk(USER, kids), title: 'you', tier: null, state: 'user' } as CanvasNode)

const which = new URLSearchParams(location.search).get('org') ?? 'small'
const root = which === 'small' ? eye(team('a', [3, 2])) : eye(team('t', [8, 5, 4]))
const pos = layout(root, new Map(), 'circular')
const lod = which === 'small' ? 'norm' : 'mini'
const all: CanvasNode[] = []
const walk = (n: CanvasNode) => { all.push(n); n.children.forEach(walk) }
walk(root)
let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
for (const p of pos.values()) {
  minX = Math.min(minX, p.x); minY = Math.min(minY, p.y)
  maxX = Math.max(maxX, p.x + NODE_W); maxY = Math.max(maxY, p.y + NODE_H)
}
const pad = 40, W = maxX - minX + 2 * pad, H = maxY - minY + 2 * pad
const at = (id: string) => ({ x: pos.get(id)!.x - minX + pad, y: pos.get(id)!.y - minY + pad })
const wires: JSX.Element[] = []
const link = (p: CanvasNode) => p.children.forEach((c) => {
  const a = at(p.id), b = at(c.id)
  const ca = { x: a.x + NODE_W / 2, y: a.y + NODE_H / 2 }, cb = { x: b.x + NODE_W / 2, y: b.y + NODE_H / 2 }
  const dx = cb.x - ca.x, dy = cb.y - ca.y
  const e = (hw: number, hh: number) => Math.min(hw / (Math.abs(dx) || 1e-9), hh / (Math.abs(dy) || 1e-9))
  const ta = e(NODE_W / 2, NODE_H / 2), tb = e(NODE_W / 2, NODE_H / 2)
  wires.push(<line key={c.id} x1={ca.x + dx * ta} y1={ca.y + dy * ta} x2={cb.x - dx * tb} y2={cb.y - dy * tb}
    stroke="#7a8aa0" strokeWidth={which === 'small' ? 2 : 3} />)
  link(c)
})
link(root)
const z = which === 'small' ? 1 : Math.min(1, 2400 / W)
createRoot(document.getElementById('root')!).render(
  <div style={{ width: W * z, height: H * z, position: 'relative', overflow: 'hidden' }}>
    <div style={{ position: 'absolute', left: 0, top: 0, width: W, height: H, transform: `scale(${z})`, transformOrigin: '0 0' }}>
      <svg width={W} height={H} style={{ position: 'absolute', left: 0, top: 0 }}>{wires}</svg>
      {all.filter((n) => n.id !== USER).map((n) =>
        <NodeSquare key={n.id} node={n} pos={at(n.id)} lod={lod} focused={false}
          dragging={false} isDrop={false} seats={seats} codexHire={hire} antigravityHire={hire}
          claudeHire={hire} map={new Map([[n.id, n]])} op={op} slug="probe" toast={noop}
          pxc={1} zoom={lod === 'mini' ? .4 : .8} compactAt={.8} pub={false} maxTop={100}
          kioskRemaining={null} cascadeAlloc onSpawn={noop} onSpawnSide={noop} onSpawnTop={noop}
          onConfig={noop} onInbox={noop} onDocket={noop} onLineage={noop} onOpenDoc={noop}
          onRecenter={noop} onOpenAgentGallery={noop} onJump={noop} onMailLink={noop}
          onDragStart={noop} onDragMove={noop} onDragEnd={noop} onDragCancel={noop}
          onPin={noop} pinned={false} />)}
      <div style={{ position: 'absolute', left: at(USER).x, top: at(USER).y, width: NODE_W, height: NODE_H, background: '#2b3a55',
        color: '#fff', display: 'grid', placeItems: 'center', borderRadius: 10, font: '16px sans-serif' }}>you (eye)</div>
    </div>
  </div>)
;(window as unknown as { count: number }).count = all.length
