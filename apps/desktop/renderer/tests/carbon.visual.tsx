// carbon.visual.tsx — the fixture for USER 2026-10-28 m09d1c2c45be4 ("i want its model color to be a light charcoal
// grey"): a Carbon agent beside Flash, Pro, Luna and Astra as the app draws them — the norm node, the mini node, the
// tier badge, the agents-summary chip and the hire row — so carbon.capture.cjs can screenshot and measure the
// rendered colours in each theme. Browser-only fixture data: no engine, bridge or live org.
import { createRoot } from 'react-dom/client'
import { NodeSquare, SpawnChips } from '../src/canvas/cards'
import { ALL_TIER_SEAT, NODE_H, NODE_W, setOfferedConditionalTiers, TIER_LETTER, type CanvasNode, type HireState } from '../src/canvas/shared'
import { legacyAppBackend } from './appfeed-fixture'
import '../src/styles.css'
import '../src/shell.css'

// Entirely synthetic: nothing here reaches an engine.
window.fetch = legacyAppBackend(async () => new Response('{}', { headers: { 'content-type': 'application/json' } }))
localStorage.clear()
setOfferedConditionalTiers([{ tier: 'carbon' }])

const TIERS = ['flash', 'pro', 'carbon', 'luna', 'astra']
const ON: HireState = { enabled: true, installed: true, reason: null }
const google: HireState = { ...ON, offeredTiers: ['flash', 'pro', 'carbon'] }
const noop = () => {}
const seats = { ...ALL_TIER_SEAT, carbon: 2 }

const agent = (tier: string): CanvasNode => ({
  id: 'agent-' + tier, title: 'agent-' + tier, state: 'live', tier, model_id: tier,
  parent: null, children: [], seat: 1, grant: 10, free: 10,
  scope: { permission_mode: 'acceptEdits', add_dirs: [], tools: { bash: true, web: true, edit: true, subagents: true, mcp: [] }, org_visibility: 'team' },
  charter: '', team_charter: '', turns: [], audiences_held: [], lineage: [],
} as unknown as CanvasNode)

const GAP = 24
function Node({ tier, lod, x, y }: { tier: string; lod: 'norm' | 'mini'; x: number; y: number }) {
  return <NodeSquare node={agent(tier) as Parameters<typeof NodeSquare>[0]['node']}
    pos={{ x, y }} lod={lod} focused={false} dragging={false} isDrop={false} seats={seats}
    map={new Map()} op={() => Promise.resolve({} as never)} slug="org" toast={noop} pxc={1} zoom={1}
    onSpawn={noop} onSpawnSide={noop} onSpawnTop={noop} onConfig={noop} onInbox={noop} onLineage={noop}
    onOpenDoc={noop} onWorkLink={noop} onRecenter={noop} onJump={noop} cascadeAlloc maxTop={100} onMailLink={noop}
    onDragStart={noop} onDragMove={noop} onDragEnd={noop} onDragCancel={noop}
    claudeHire={ON} codexHire={ON} antigravityHire={google} onNoHarness={noop} />
}

function Stage() {
  const rowH = NODE_H + 28
  return <div id="stage" style={{ padding: 16, background: 'var(--bg)', color: 'var(--ink)', width: 5 * (NODE_W + GAP) + 16, font: '12px var(--sans)' }}>
    <div className="row-label" data-row="norm" style={{ margin: '0 0 6px', color: 'var(--dim)' }}>norm node</div>
    <div data-row="norm" style={{ position: 'relative', height: rowH }}>
      {TIERS.map((t, i) => <Node key={t} tier={t} lod="norm" x={i * (NODE_W + GAP)} y={0} />)}
    </div>
    <div className="row-label" data-row="mini" style={{ margin: '0 0 6px', color: 'var(--dim)' }}>mini node</div>
    <div data-row="mini" style={{ position: 'relative', height: NODE_H + 20 }}>
      {TIERS.map((t, i) => <Node key={t} tier={t} lod="mini" x={i * (NODE_W + GAP)} y={0} />)}
    </div>
    <div className="row-label" data-row="badge" style={{ margin: '6px 0 6px', color: 'var(--dim)' }}>tier badge · agents chip</div>
    <div data-row="badge" style={{ display: 'flex', gap: 14, alignItems: 'center', height: 34 }}>
      {TIERS.map((t) => <span key={t} className={'tier t-' + t} data-badge={t}>{TIER_LETTER[t]}</span>)}
      <span className="chip agents" data-chip="agents" style={{ marginLeft: 14 }}>
        {TIERS.map((t) => <span key={t}>{' '}<b className={'t-' + t} data-chipcount={t}>{TIER_LETTER[t]}</b></span>)}
      </span>
    </div>
    <div className="row-label" data-row="hire" style={{ margin: '8px 0 6px', color: 'var(--dim)' }}>hire row</div>
    <div data-row="hire" className="hire-row" style={{ position: 'relative', height: 72 }}>
      {/* the strip is hidden until a card is hovered; show it in flow for the capture */}
      <style>{'.hire-row .hsof { position: static; transform: none; opacity: 1; pointer-events: none; align-items: flex-start; }'}</style>
      <SpawnChips onSpawn={noop} seats={seats} codexHire={ON} antigravityHire={google} claudeHire={ON}
        allowedTiers={TIERS} />
    </div>
  </div>
}

createRoot(document.getElementById('root')!).render(<Stage />)
