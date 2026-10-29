// letterchips.visual.tsx — Session 0 visual capture fixture for
// @item:orgtree/hire-tokens-letter-sits-off-centre-on-linux (USER md447762e475e
// + UX symmetry rule mb6da9f3ee862).
//
// Mounts the real production components with identical synthetic inputs for
// both the `before` bundle (compiled against `--base` via `git show <base>:...`)
// and the `after` bundle (compiled against the worktree tip), with no synthetic
// CSS overrides or hand-built stand-in spans:
//   1. Hire tokens (`SpawnChips` offered tokens, signed-out preview, and far-zoom expand arrow)
//   2. Desk model letter (`DeskModelButton` live button + archived `TierChip`)
//   3. Node model letters (`TierChip`, `createTierChipEl`, `NodeSquare` norm/mini/mapMode, `AgentTray`)
//   4. Tier pickers (`DraftNode`, QuickChat `SpawnChips`, `TierStandings`)
//   5. Initials avatars (`OrgPictureEditor` `.org-logo-avatar`)
import { useEffect, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { TierStandings } from '../src/canvas/accounts'
import { AgentTray, trayRows } from '../src/canvas/agenttray'
import { DraftNode, NodeSquare, SpawnChips } from '../src/canvas/cards'
import { DeskModelButton } from '../src/canvas/deskmodel'
import { createTierChipEl, TierChip } from '../src/canvas/identity'
import { OrgPictureEditor } from '../src/canvas/orgpicture'
import { applyTheme } from '../src/themes'
import { applyContrast } from '../src/contrast'
import type { CanvasNode, OpFn } from '../src/canvas/shared'
import type { TreePayload } from '../src/types'
import '../src/styles.css'
import '../src/canvas/orglogo.css'

window.fetch = (async (url: RequestInfo | URL) => {
  const p = String(url)
  if (p.includes('/picture')) {
    return new Response(JSON.stringify({ owner: 1, picture: null }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  return new Response(JSON.stringify({ tiers: [], providers: [], presets: [] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}) as typeof fetch

const noop = () => {}
const op: OpFn = async () => ({}) as never
const offer = { enabled: true, installed: true, reason: null }
const signedOut = { enabled: true, installed: true, connected: false, reason: 'run codex login' }
const seats = { haiku: 1, sonnet: 2, opus: 5, fable: 10, terra: 2, sol: 5, flash: 1, pro: 2, argon: 2 }

const liveNode: CanvasNode = {
  id: 'coord-opus',
  title: 'coord-opus',
  tier: 'opus',
  state: 'live',
  children: [],
  seat: 5,
  grant: 20,
  free: 20,
  cost_usd: 0,
  occupancy: null,
  turns: [],
  frozen: null,
  last_denials: [],
  audiences_held: [],
  lineage: [],
  generation: 0,
}

const sampleTree: TreePayload = {
  slug: 'orgtree',
  name: 'Orgtree',
  roots: [liveNode],
  dirs: [],
  tiers: seats,
  default_top_grant: 12,
  max_top_grant: 100,
  cascade_hire: true,
  audiences: [],
  audience_requests: [],
  credit_requests: [],
  user_inbox_count: 0,
  default_visibility: 'team',
  default_tools: {},
} as unknown as TreePayload

const nodeMap = new Map<string, CanvasNode>([[liveNode.id, liveNode]])

function DomTierChipMount() {
  const hostRef = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    host.replaceChildren()
    const el = createTierChipEl(document, 'sonnet', 'impl-sonnet')
    if (el) host.appendChild(el)
  }, [])
  return <span ref={hostRef} style={{ display: 'inline-flex', alignItems: 'center' }} />
}

function Surface() {
  useEffect(() => {
    applyTheme('claude')
    applyContrast('charcoal')
  }, [])

  const cardStyle = {
    padding: 12,
    border: '1px solid var(--line)',
    borderRadius: 8,
    background: 'var(--panel)',
    boxSizing: 'border-box' as const,
  }

  return (
    <div
      data-fixture="letter-chips"
      style={{
        width: 1120,
        padding: 14,
        display: 'grid',
        gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
        gap: 12,
        background: 'var(--bg)',
        color: 'var(--ink)',
        fontFamily: 'var(--sans)',
        boxSizing: 'border-box',
      }}
    >
      <section style={cardStyle} data-surface-group="1-hire-tokens">
        <h4 style={{ margin: '0 0 8px', fontSize: 13 }}>1. Hire tokens (SpawnChips: offered, signed-out, compact expand)</h4>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 24, minHeight: 84 }}>
          <div className="sq desk edge-b" style={{ position: 'relative', width: 220, height: 18, padding: 0 }}>
            <SpawnChips
              onSpawn={noop}
              seats={seats}
              claudeHire={offer}
              codexHire={signedOut}
              antigravityHire={offer}
            />
          </div>
          <div className="sq desk edge-b" style={{ position: 'relative', width: 90, height: 18, padding: 0 }}>
            <SpawnChips
              onSpawn={noop}
              seats={seats}
              claudeHire={offer}
              zoom={0.25}
              expanded={false}
            />
          </div>
        </div>
      </section>

      <section style={cardStyle} data-surface-group="2-desk-model-letter">
        <h4 style={{ margin: '0 0 8px', fontSize: 13 }}>2. Desk model letter (DeskModelButton live &amp; archived)</h4>
        <div className="cc-head-left" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <DeskModelButton node={liveNode} slug="org" op={op} toast={noop} />
          <DeskModelButton node={{ ...liveNode, id: 'retired-sol', tier: 'sol', state: 'archived' }} slug="org" op={op} toast={noop} />
        </div>
      </section>

      <section style={cardStyle} data-surface-group="3-node-model-letters">
        <h4 style={{ margin: '0 0 8px', fontSize: 13 }}>3. Node model letters (TierChip, createTierChipEl, NodeSquare norm/mini/map, AgentTray)</h4>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
          <TierChip tier="opus" agentName="coord-opus" />
          <TierChip tier="argon" agentName="symmetry-argon" />
          <DomTierChipMount />
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
          <div style={{ position: 'relative', width: 156, height: 96, overflow: 'hidden' }}>
            <NodeSquare
              node={liveNode}
              pos={{ x: 0, y: 0 }}
              lod="norm"
              focused={false}
              dragging={false}
              isDrop={false}
              seats={seats}
              claudeHire={offer}
              map={nodeMap}
              op={op}
              slug="orgtree"
              toast={noop}
              pxc={1}
              zoom={1}
              onSpawn={noop}
              onConfig={noop}
              onInbox={noop}
              onLineage={noop}
              onDragStart={noop}
              onDragMove={noop}
              onDragEnd={noop}
              onDragCancel={noop}
            />
          </div>
          <div style={{ position: 'relative', width: 132, height: 96, overflow: 'hidden' }}>
            <NodeSquare
              node={liveNode}
              pos={{ x: 0, y: 0 }}
              lod="mini"
              focused={false}
              dragging={false}
              isDrop={false}
              seats={seats}
              claudeHire={offer}
              map={nodeMap}
              op={op}
              slug="orgtree"
              toast={noop}
              pxc={1}
              zoom={0.35}
              onSpawn={noop}
              onConfig={noop}
              onInbox={noop}
              onLineage={noop}
              onDragStart={noop}
              onDragMove={noop}
              onDragEnd={noop}
              onDragCancel={noop}
            />
          </div>
          <div style={{ position: 'relative', width: 156, height: 96, overflow: 'hidden' }}>
            <NodeSquare
              node={liveNode}
              pos={{ x: 0, y: 0 }}
              lod="norm"
              mapMode={true}
              focused={false}
              dragging={false}
              isDrop={false}
              seats={seats}
              claudeHire={offer}
              map={nodeMap}
              op={op}
              slug="orgtree"
              toast={noop}
              pxc={1}
              zoom={1}
              onSpawn={noop}
              onConfig={noop}
              onInbox={noop}
              onLineage={noop}
              onDragStart={noop}
              onDragMove={noop}
              onDragEnd={noop}
              onDragCancel={noop}
            />
          </div>
        </div>
        <AgentTray
          map={nodeMap}
          rows={trayRows(nodeMap)}
          query=""
          onQuery={noop}
          archived={false}
          onArchived={noop}
          onPick={noop}
        />
      </section>

      <section style={cardStyle} data-surface-group="4-tier-pickers">
        <h4 style={{ margin: '0 0 8px', fontSize: 13 }}>4. Tier pickers (DraftNode, QuickChat SpawnChips, TierStandings)</h4>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14, flexWrap: 'wrap', marginBottom: 8 }}>
          <div style={{ position: 'relative', width: 220, height: 112, overflow: 'hidden' }}>
            <DraftNode
              pos={{ x: 0, y: 0 }}
              draft={{ parent: null, tier: 'haiku' }}
              tree={sampleTree}
              seats={seats}
              claudeHire={offer}
              map={new Map()}
              maxTop={100}
              defaultTop={12}
              zoom={1}
              pxc={1}
              onConfirm={noop}
              onCancel={noop}
              onTierChange={noop}
            />
          </div>
          <div className="quickchat-pop-model" style={{ position: 'static' }}>
            <SpawnChips onSpawn={noop} seats={seats} claudeHire={offer} soleHire selected="opus" />
          </div>
        </div>
        <TierStandings
          tiers={[
            { tier: 'opus', available: true, refresh_at: null },
            { tier: 'argon', available: true, refresh_at: null },
          ]}
        />
      </section>

      <section style={{ ...cardStyle, gridColumn: '1 / -1' }} data-surface-group="5-initials-avatars">
        <h4 style={{ margin: '0 0 8px', fontSize: 13 }}>5. Initials avatars (OrgPictureEditor .org-logo-avatar)</h4>
        <OrgPictureEditor slug="orgtree" name="Orgtree Team" />
      </section>
    </div>
  )
}

document.body.style.background = 'var(--bg)'
document.body.style.margin = '0'
createRoot(document.getElementById('root')!).render(<Surface />)
