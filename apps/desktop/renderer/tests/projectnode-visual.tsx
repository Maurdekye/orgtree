// projectnode-visual.tsx — project nodes on screen, for projectnode-visual.mjs
// (user 2026-10-17 21:20Z–21:23:44Z). ?scene=
//   cards   — the project card at far and middle zoom beside the project hire
//             token (no left stripe, a large folder, the activity chip, the
//             token in the card's theme colours);
//   row-end — the REAL canvas: boss with a1, a2 and a project at the row's end
//             (no neighbour segment reaches the project);
//   between — the REAL canvas: a1, a project, a2 (one line runs past it);
//   activity — middle-zoom cards with Show agent card shortcuts on: one
//             active, one quiet for 7m, with the hover row (points 21-22);
//   jumps   — two real desks: dev2 (in project ui, in project site, under
//             boss) and boss, showing the up and down jump card rows
//             passing through projects (user 2026-10-17 22:13Z).
//   fairqueue — the REAL canvas: dev1 holds an armed fair_queue dog on project
//             site, boss a paused one; &theme=light draws the light theme
//             (point 26, user 2026-10-17 22:48Z).
import { createRoot } from 'react-dom/client'
import { ProjectSquare } from '../src/canvas/projectcard'
import { SpawnChips } from '../src/canvas/cards'
import { OrgCanvas } from '../src/canvas/OrgCanvas'
import { DeskChat } from '../src/canvas/desk'
import type { CanvasNode, OpResult } from '../src/canvas/shared'
import type { TreePayload } from '../src/types'

const noop = () => {}
const answer = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }))
window.fetch = ((input: RequestInfo | URL) => {
  const p = new URL(String(input), location.href).pathname
  if (p.endsWith('/api/providers')) return answer({ providers: [] })
  if (p.endsWith('/api/accounts')) return answer({ version: 2, primary: null, keys: [], assignments: {}, accounts: [] })
  return answer({ detail: 'not in the fixture' }, 404)
}) as typeof fetch

const agent = (id: string, parent: string, extra: Record<string, unknown> = {}) => ({
  id, title: id, tier: 'haiku', model_id: 'haiku', state: 'live', parent,
  seat: 1, grant: 0, free: 0, ui_order: 0, cost_usd: 0, occupancy: null,
  context_window: null, charter: null, mail_pending: 0, limit_locked: false,
  last_status: null, prev_status: null, inflight_at: null, last_denials: [],
  turns: [], frozen: null, audiences_held: [], bearer_state: null,
  generation: 1, children: [], lineage: [],
  scope: { permission_mode: 'default', add_dirs: [], tools: {}, org_visibility: 'team' },
  ...extra,
})
const projectNode = (id: string, parent: string, children: unknown[] = []) =>
  agent(id, parent, { kind: 'project', tier: 'project', model_id: '', seat: 0, charter: 'The site.', children })

const card = {
  ...projectNode('website', 'boss', [agent('dev1', 'website', { busy: true }), agent('dev2', 'website')]),
} as unknown as CanvasNode

function Cards() {
  const sq = (lod: 'mini' | 'norm', x: number) => <ProjectSquare node={card} pos={{ x, y: 0 }} lod={lod}
    dragging={false} isDrop={false} op={() => Promise.resolve({} as OpResult)} slug="org" toast={noop}
    zoom={lod === 'mini' ? 0.4 : 1.2} hire={{}} seats={{}} onHire={noop} onNewProject={noop} onInbox={noop}
    onDragStart={noop} onDragMove={noop} onDragEnd={noop} onDragCancel={noop} />
  return (
    <main style={{ position: 'relative', width: 1000, height: 700, background: 'var(--bg)' }}>
      <div id="world" style={{ position: 'absolute', left: 60, top: 120, transform: 'scale(2.4)', transformOrigin: '0 0' }}>
        {sq('mini', 0)}
        {sq('norm', 170)}
      </div>
      {/* the strip shows on a card's hover; here it is held open for the capture */}
      <style>{'#token .hsof { opacity: 1 !important; pointer-events: auto !important; position: static !important; }'}</style>
      <div id="token" style={{ position: 'absolute', left: 140, top: 450, transform: 'scale(2)', transformOrigin: '0 0' }}>
        <SpawnChips onSpawn={noop} seats={{ haiku: 1 }} claudeHire={{ enabled: true, installed: true, reason: null }}
          onProject={noop} zoom={1} expanded />
      </div>
    </main>
  )
}

function tree(children: unknown[], watchdogs: unknown[] = []): TreePayload {
  return {
    watchdogs,
    slug: 'org', name: 'org', workspace: null, dirs: [], max_top_grant: 1000, default_top_grant: 50,
    compact_at: 0, default_tools: null, default_visibility: 'team', default_effort: '', credit_requests: [],
    tiers: { haiku: 1, sonnet: 3, opus: 5 }, audiences: [], cost_usd_total: 0,
    roots: [agent('boss', '', { parent: null, tier: 'opus', model_id: 'opus', seat: 5, grant: 20, children })],
    audit: { live_nodes: 1, top_level_holds: 0, no_overdraft: true, problems: [] },
    user_inbox_count: 0, user_inbox_newest: null, fable_lock: null, auto_resume: false,
    fable_limit_policy: 'freeze', fable_filter_policy: 'halt', cascade_hire: false, cascade_alloc: true,
    audience_requests: [], org_inbox: null, net: null,
  } as unknown as TreePayload
}

function Jumps() {
  const boss = agent('boss', 'eye', { tier: 'opus', model_id: 'opus' }) as unknown as CanvasNode
  const lead = agent('lead', 'boss') as unknown as CanvasNode
  const site = projectNode('site', 'boss') as unknown as CanvasNode
  const dev1 = agent('dev1', 'site') as unknown as CanvasNode
  const ui = projectNode('ui', 'site') as unknown as CanvasNode
  const dev2 = agent('dev2', 'ui', { tier: 'sonnet', model_id: 'sonnet' }) as unknown as CanvasNode
  ui.children = [dev2]
  site.children = [dev1, ui]
  boss.children = [lead, site]
  const map = new Map([boss, lead, site, dev1, ui, dev2].map((x) => [x.id, x]))
  const box = (node: CanvasNode) => (
    <div style={{ width: 480, height: 640, border: '1px solid var(--line)', position: 'relative', overflow: 'hidden' }}>
      <DeskChat node={node} map={map} op={() => Promise.resolve({} as OpResult)} slug="org" toast={noop} bare onJump={noop} />
    </div>
  )
  return <main style={{ display: 'flex', gap: 16, padding: 12, background: 'var(--bg)' }}>{box(dev2)}{box(boss)}</main>
}

function Activity() {
  const quietNode = {
    ...projectNode('site', 'boss', [agent('dev3', 'site', {
      turns: [{ at: new Date(Date.now() - 420_000).toISOString(), cost: 0, denials: 0 }], documents_count: 2 })]),
    mail_pending: 2,
  } as unknown as CanvasNode
  const sq = (nd: CanvasNode, x: number) => <ProjectSquare node={nd} pos={{ x, y: 0 }} lod="norm"
    dragging={false} isDrop={false} op={() => Promise.resolve({} as OpResult)} slug="org" toast={noop}
    zoom={1.2} hire={{}} seats={{}} onHire={noop} onNewProject={noop} onInbox={noop} onDocket={noop}
    onOpenGallery={noop} onDragStart={noop} onDragMove={noop} onDragEnd={noop} onDragCancel={noop} />
  return (
    <main style={{ position: 'relative', width: 1000, height: 700, background: 'var(--bg)' }}>
      <div style={{ position: 'absolute', left: 60, top: 120, transform: 'scale(2.4)', transformOrigin: '0 0' }}>
        {sq(card, 0)}
        {sq(quietNode, 170)}
      </div>
    </main>
  )
}

const scene = new URLSearchParams(location.search).get('scene') || 'cards'
if (new URLSearchParams(location.search).get('theme') === 'light') document.documentElement.classList.add('contrast-light')
const fqDog = (id: string, owner: string, state: string) => ({ id, owner, name: id, kind: 'fair_queue', target: 'site',
  interval_s: 5, state, at: new Date().toISOString(), fired: 0, once: false })
const dogs: Record<string, unknown[]> = {
  fairqueue: [fqDog('q1', 'dev1', 'armed'), fqDog('q2', 'boss', 'paused')],
}
if (scene === 'activity') { try { localStorage.setItem('orgtree-agent-shortcuts', '1') } catch { /* private mode */ } }
// the hover row reveals its buttons on the card's :hover, as on an agent card;
// here it is held open for the capture
if (scene === 'activity') document.head.insertAdjacentHTML('beforeend',
  '<style>.sq.project .sq-actions .mailbtn { opacity: .8 !important; visibility: visible !important; }</style>')
const rows: Record<string, unknown[]> = {
  'row-end': [agent('a1', 'boss'), agent('a2', 'boss'), projectNode('site', 'boss')],
  between: [agent('a1', 'boss'), projectNode('site', 'boss'), agent('a2', 'boss')],
  fairqueue: [agent('lead', 'boss'), projectNode('site', 'boss', [agent('dev1', 'site'), agent('dev2', 'site')])],
}
createRoot(document.getElementById('root')!).render(scene === 'cards' ? <Cards /> : scene === 'jumps' ? <Jumps />
  : scene === 'activity' ? <Activity /> : (
  <div style={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column' }}>
    <style>{'html, body, #root { height: 100%; margin: 0 } .viewport { flex: 1; min-height: 600px }'}</style>
    <OrgCanvas tree={tree(rows[scene]!, dogs[scene])} slug="org" op={() => Promise.resolve({} as OpResult)}
      toast={noop} mailEvt={null} onOpenAgentGallery={noop} />
  </div>
))
