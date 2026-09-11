// Browser fixture for minihire_probe.py — the FAR-MAP hire tokens.
//
// Unlike cardlayout-probe, this one reproduces the real switchboard geometry:
// a `.viewport > .space` scaled by the canvas zoom, with the same `--invz` /
// `--invzf` counter-scale variables OrgCanvas writes, and cards laid out on
// the real world grid (SX 186 / SY 200). That matters because every question
// here is about SCREEN size: the hire chips are counter-scaled, the cards are
// not, so only a really-scaled page can say whether a token covers a card.
//
// `?z=` picks the canvas zoom; the fixture derives `lod` from Z_MINI exactly
// as OrgCanvas does, so `?z=0.24` is the most zoomed-out view the desktop
// wheel clamp allows and `?z=0.8` is an ordinary one.
import { createRoot } from 'react-dom/client'
import { NodeSquare } from '../src/canvas/cards'
import { NODE_H, NODE_W, Z_MAX, Z_MINI } from '../src/canvas/shared'
import type { CanvasNode } from '../src/canvas/shared'
import type { OpResult } from '../src/types'

const noop = () => {}
const op = () => Promise.resolve({} as OpResult)
const seats = { haiku: 1, sonnet: 2, opus: 5, fable: 10, terra: 2, sol: 5, flash: 1, pro: 2 }
const hire = { enabled: true, installed: true, reason: null }

// what the probe reads back: every route a click can take
const spawned: string[] = []
const dragStarts: string[] = []
const dragEnds: string[] = []
const configured: string[] = []

const z = Number(new URL(location.href).searchParams.get('z') ?? '0.24')
const lod: 'mini' | 'norm' = z < Z_MINI ? 'mini' : 'norm'

// the real grid spacing OrgCanvas lays children out on (shared.ts SX/SY are
// module-private, so they are restated here — the probe asserts the derived
// screen gaps, which is what the question is actually about)
const SX = 186, SY = 200

function node(id: string): CanvasNode {
  return {
    id, title: id, state: 'live', tier: 'haiku', model_id: 'haiku',
    seat: 1, grant: 0, free: 0, scope: { tools: {}, add_dirs: [] },
    children: [], lineage: [], turns: [], audiences_held: [],
    bearer_state: null, frozen: null, limit_locked: false, mail_pending: 0,
    last_status: { status: 'working', summary: 'far-map fixture', at: '' },
    prev_status: null, inflight_at: null, last_denials: [],
    occupancy: 100, occupancy_est: false, context_window: 1000,
    busy: false, activity: null, proc_warm: true, proc_live: true,
    proc_relaunch: false, proc_relaunch_reason: null, isBearerOf: undefined,
  } as unknown as CanvasNode
}

// centre card + the four neighbours whose bodies a screen-constant token
// could reach: below (bottom strip), above (top strip), left and right
const CENTRE = { id: 'centre', x: SX, y: SY }
const PLACES = [
  CENTRE,
  { id: 'below', x: SX, y: SY * 2 },
  { id: 'above', x: SX, y: 0 },
  { id: 'left', x: 0, y: SY },
  { id: 'right', x: SX * 2, y: SY },
]
const nodes = PLACES.map((p) => node(p.id))
const map = new Map(nodes.map((n) => [n.id, n]))

function card(n: CanvasNode, pos: { x: number; y: number }) {
  return <NodeSquare key={n.id} node={n} pos={pos} lod={lod} focused={false}
    dragging={false} isDrop={false} seats={seats} codexHire={hire}
    antigravityHire={hire} claudeHire={hire} map={map} op={op} slug="probe"
    toast={noop} pxc={1} zoom={z} compactAt={0.8} pub={false} maxTop={100}
    kioskRemaining={null} cascadeAlloc
    onSpawn={(t) => { spawned.push(`${n.id}:b:${t}`) }}
    onSpawnSide={(t, side) => { spawned.push(`${n.id}:${side}:${t}`) }}
    onSpawnTop={(t) => { spawned.push(`${n.id}:t:${t}`) }}
    onConfig={() => { configured.push(n.id) }} onInbox={noop} onLineage={noop}
    onOpenDoc={noop} onRecenter={noop} onJump={noop} onMailLink={noop}
    onDragStart={(_e, id) => { dragStarts.push(id) }} onDragMove={noop}
    onDragEnd={(_e, id) => { dragEnds.push(id) }} onDragCancel={noop} />
}

const space: Record<string, string | number> = {
  width: SX * 3 + NODE_W, height: SY * 3 + NODE_H,
  transform: `translate(40px, 40px) scale(${z})`,
  // verbatim from OrgCanvas: the clamped counter-scale for badges and the
  // UNCLAMPED one the hire chips ride
  '--invz': Math.min(2.4, Math.max(1 / Z_MAX, 1 / z)).toFixed(3),
  '--invzf': Math.max(1 / Z_MAX, 1 / z).toFixed(3),
}

createRoot(document.getElementById('root')!).render(
  <div className="viewport" style={{ width: 1200, height: 900, position: 'relative', overflow: 'hidden' }}>
    <div className="space" style={space as React.CSSProperties}>
      {nodes.map((n, i) => card(n, { x: PLACES[i]!.x, y: PLACES[i]!.y }))}
    </div>
  </div>,
)

Object.assign(window as unknown as Record<string, unknown>, {
  spawned, dragStarts, dragEnds, configured,
  probeMeta: { z, lod, SX, SY, NODE_W, NODE_H },
})
