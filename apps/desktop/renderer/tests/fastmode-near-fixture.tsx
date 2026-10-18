import { NodeSquare } from '../src/canvas/cards'
import { syncProviderRegistries } from '../src/canvas/shared'
import type { CanvasNode, Pt } from '../src/canvas/shared'

const noop = () => {}
export const seedFastMode = () => syncProviderRegistries({ providers: [
  { id: 'openai', tiers: [{ tier: 'sol', fast_mode: true, fast_mode_versions: { '6': false } }] },
  { id: 'claude', tiers: [{ tier: 'opus', fast_mode: true }] },
] })
export const agent = (saved = true, extra: Partial<CanvasNode> = {}): CanvasNode => ({
  id: 'worker', state: 'live', tier: 'sol', model_id: 'gpt-6.1-sol',
  children: [], seat: 2, grant: 0, free: 0, busy: false,
  scope: { tools: { mcp: [] }, add_dirs: [], fast_mode: saved },
  audiences_held: [], ...extra,
} as CanvasNode)
export function NearCard({ node, lod = 'norm', mapMode = false, pos = { x: 0, y: 0 } }: {
  node: CanvasNode; lod?: 'mini' | 'norm'; mapMode?: boolean; pos?: Pt
}) {
  return <NodeSquare node={node} pos={pos} lod={lod} focused={false}
    dragging={false} isDrop={false} seats={{ sol: 2, opus: 4 }}
    map={new Map([[node.id, node]])} op={async () => ({} as never)} slug="fixture" toast={noop}
    pxc={1} zoom={lod === 'mini' ? .4 : 1} compactAt={.8} maxTop={0} cascadeAlloc mapMode={mapMode}
    onSpawn={noop} onSpawnSide={noop} onSpawnTop={noop} onConfig={noop} onInbox={noop}
    onLineage={noop} onOpenDoc={noop} onRecenter={noop} onJump={noop}
    onMailLink={noop} onWorkLink={noop}
    onDragStart={noop} onDragMove={noop} onDragEnd={noop} onDragCancel={noop} />
}
