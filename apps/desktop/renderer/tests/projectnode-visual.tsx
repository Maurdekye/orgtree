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
//   presented — point 25/27: a project card's presentation chips (its own and
//             its subtree's) beside the TEAM presentations gallery for boss,
//             whose rows name, as links, the agent that presented each card;
//   fairqueue — the REAL canvas: dev1 holds an armed fair_queue dog on project
//             site, boss a paused one; &theme=light draws the light theme
//             (point 26, user 2026-10-17 22:48Z).
//   desc    — a bare project desk: the description at rest (no border or
//             background) and the header's pop-out button; the capture
//             script clicks into the Markdown to open the editor (user
//             2026-10-18 07:14Z-07:15Z); beside it a pinned project window's
//             frame and an agent's, under a custom org theme (07:24Z);
//   settings — project settings: the frame's pop-out and pin against the
//             header's Open project folder (07:24Z);
//   corner  — an inbox tab with the Transfers box under the tab's
//             pin/pop-out/mail corner (07:27Z);
//   slotlines — the REAL canvas: project build with 1 slot held by sa (who
//             also listens with a fair_queue dog and holds an audience to
//             it: three lines side by side), sc and sb waiting (dashed); the
//             card badge, sa's holder chip and the waiters' chips (user
//             2026-10-18, the approved slots mockup);
//   slots   — a bare project desk with its Slots tab (full), beside an empty
//             one (0 of 2);
//   cardfix — project cards whose "2/19 Active 80s" and "12/140 Active 1h 5m"
//             ran off the card (user 2026-10-18 10:51Z), beside the desk
//             headers of slot holder sa and waiting sb (10:52:50Z).
import { createRoot } from 'react-dom/client'
import { ProjectSquare } from '../src/canvas/projectcard'
import { SpawnChips } from '../src/canvas/cards'
import { OrgCanvas } from '../src/canvas/OrgCanvas'
import { DeskChat } from '../src/canvas/desk'
import { DeskDogsProvider } from '../src/canvas/deskdogs'
import { AgentGalleryView } from '../src/canvas/gallery'
import { ProjectDesk, ProjectDeskModal } from '../src/canvas/projectdesk'
import { NodeConfig } from '../src/canvas/modals'
import { InboxView } from '../src/canvas/mail'
import { AgentSurfaceRoutesProvider, PanelCorner } from '../src/canvas/panelcorner'
import type { CanvasNode, OpResult } from '../src/canvas/shared'
import type { TreePayload } from '../src/types'

const noop = () => {}
const answer = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }))
window.fetch = ((input: RequestInfo | URL) => {
  const p = new URL(String(input), location.href).pathname
  if (p.endsWith('/api/providers')) return answer({ providers: [] })
  if (p.endsWith('/transfers')) return answer({ next_cursor: null, transfers: [
    { id: 't1', direction: 'upload', message_id: 'm1', peer: '@net:phone', state: 'done', attempt: 1 }] })
  if (p.endsWith('/api/accounts')) return answer({ version: 2, primary: null, keys: [], assignments: {}, accounts: [] })
  if (p.endsWith('/documents')) {
    const at = (m: number) => new Date(Date.now() - m * 60_000).toISOString()
    const row = (id: string, node: string, by: string, tier: string, title: string, m: number) =>
      ({ id, node, presented_by: by, presenter_tier: tier, title, at: at(m), format: 'md', bytes: 100,
        evicted: false, node_state: 'live', tier: node === 'website' ? 'project' : tier })
    const documents = [row('d1', 'website', 'boss', 'opus', 'Website plan', 3), row('d2', 'dev1', 'dev1', 'haiku', 'Dev notes', 9),
      row('d3', 'boss', 'boss', 'opus', 'Boss notes', 20)]
    return answer({ documents, total: documents.length, next_offset: null, offset: 0 })
  }
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

function tree(children: unknown[], watchdogs: unknown[] = [], extra: Record<string, unknown> = {}): TreePayload {
  return {
    watchdogs,
    ...extra,
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

function Desc() {
  const nd = { ...card, charter: '# The website\n\nDeploy from **main** only, after the [release checklist](https://example.invalid/checklist) passes.\n\n- keep the build green\n- review every change' } as CanvasNode
  const map = new Map([[nd.id, nd]])
  return (
    <main style={{ position: 'relative', width: 1000, height: 700, background: 'var(--bg)' }}>
      <div style={{ position: 'absolute', left: 20, top: 20, width: 600, height: 660, border: '1px solid var(--line)' }}>
        <ProjectDesk bare node={nd} slug="org" tree={tree([])} map={map} op={() => Promise.resolve({} as OpResult)}
          toast={noop} refs={{ world: { org: 'org' }, onOpen: noop } as never} onJump={noop} onConfig={noop}
          onPin={noop} onPopout={noop} />
      </div>
      {/* the pinned window's frame only: its accent class decides the border */}
      <div className="pinwin pin-project" id="pin-project" style={{ position: 'absolute', left: 660, top: 40, width: 300, height: 200 }} />
      <div className="pinwin prov-claude" id="pin-agent" style={{ position: 'absolute', left: 660, top: 280, width: 300, height: 200 }} />
    </main>
  )
}

function Presented() {
  const nd = { ...card, documents: [{ id: 'd1', title: 'Website plan', at: new Date(Date.now() - 180_000).toISOString() }],
    documents_count: 1, children: [{ ...(card.children ?? [])[0]!, documents: [{ id: 'd2', title: 'Dev notes',
      at: new Date(Date.now() - 540_000).toISOString() }], documents_count: 1 }, ...(card.children ?? []).slice(1)] } as CanvasNode
  return (
    <main style={{ position: 'relative', width: 1000, height: 700, background: 'var(--bg)' }}>
      <div style={{ position: 'absolute', left: 20, top: 120, transform: 'scale(2)', transformOrigin: '0 0' }}>
        <ProjectSquare node={nd} pos={{ x: 0, y: 0 }} lod="norm" dragging={false} isDrop={false}
          op={() => Promise.resolve({} as OpResult)} slug="org" toast={noop} zoom={1.2} hire={{}} seats={{}}
          onHire={noop} onNewProject={noop} onInbox={noop} onOpenDoc={noop}
          onDragStart={noop} onDragMove={noop} onDragEnd={noop} onDragCancel={noop} />
      </div>
      <div style={{ position: 'absolute', left: 400, top: 20, width: 580, height: 660, border: '1px solid var(--line)' }}>
        <AgentGalleryView slug="org" nid="boss" toast={noop} team onFocusAgent={noop} />
      </div>
    </main>
  )
}
const minsAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString()
const slotDog = (owner: string, name: string, m: number) => ({ id: owner + '/w1', owner, name, kind: 'slot', target: 'build',
  interval_s: 5, state: 'armed', at: minsAgo(m), queued_at: minsAgo(m), fired: 0, once: true, spent: false })
const slotLease = { project: 'build', agent: 'sa', slot: 1, lease: 's3f1c', reason: 'alpha7-build', since: minsAgo(7), reminders: 0 }
const buildProject = (children: unknown[], slots: number) =>
  ({ ...projectNode('build', 'boss', children), charter: 'The build machine.',
    configured_scope: { tools: {}, add_dirs: [], slots_capacity: slots } })
const slotStatus = {
  project: 'build', slots: 1, held: 1, holders: [{ ...slotLease }],
  line: [{ position: 1, agent: 'sc', dog: 'w1', since: minsAgo(4) }, { position: 2, agent: 'sb', dog: 'w1', since: minsAgo(1) }],
  history: [
    { lease: 's1', agent: 'sb', slot: 1, reason: 'cargo', since: minsAgo(21), ended: minsAgo(9), how: 'released', by: 'sb' },
    { lease: 's2', agent: 'sc', slot: 1, reason: null, since: minsAgo(140), ended: minsAgo(76), how: 'idle: not released after 3 reminders', by: 'orgtree' },
    { lease: 's3', agent: 'sa', slot: 1, reason: null, since: minsAgo(200), ended: minsAgo(178), how: 'released (forced by @user)', by: '@user' },
    { lease: 's4', agent: 'sb', slot: 1, reason: null, since: minsAgo(300), ended: minsAgo(297), how: 'halted', by: 'orgtree' }],
}
function Slots() {
  const full = buildProject([agent('sa', 'build'), agent('sb', 'build'), agent('sc', 'build')], 1) as unknown as CanvasNode
  const empty = buildProject([agent('sa', 'build')], 2) as unknown as CanvasNode
  const t = tree([], [slotDog('sc', 'tests-ui', 4), slotDog('sb', 'cargo-test', 1)], { slot_leases: [slotLease] })
  const desk = (nd: CanvasNode, tr: TreePayload, status: unknown, left: number) => (
    <div className="slots-desk" style={{ position: 'absolute', left, top: 10, width: 480, height: 680, border: '1px solid var(--line)' }}>
      <ProjectDesk bare node={nd} slug="org" tree={tr} map={new Map([[nd.id, nd]])}
        op={(b) => Promise.resolve((b.op === 'slot_status' ? status : {}) as unknown as OpResult)}
        toast={noop} refs={{ world: { org: 'org' }, onOpen: noop } as never} onJump={noop} onConfig={noop} />
    </div>)
  return (
    <main style={{ position: 'relative', width: 1000, height: 700, background: 'var(--bg)' }}>
      {desk(full, t, slotStatus, 10)}
      {desk(empty, tree([]), { project: 'build', slots: 2, held: 0, holders: [], line: [], history: [] }, 505)}
    </main>
  )
}
function CardFix() {
  const crowd = (n: number, busy: number, since: number) => projectNode('build', 'boss', Array.from({ length: n }, (_, i) =>
    agent('a' + i, 'build', i < busy ? { busy: true, inflight_at: new Date(Date.now() - since * 1000).toISOString() } : {}))) as unknown as CanvasNode
  const sq = (nd: CanvasNode, x: number) => <ProjectSquare node={nd} pos={{ x, y: 0 }} lod="norm"
    dragging={false} isDrop={false} op={() => Promise.resolve({} as OpResult)} slug="org" toast={noop}
    zoom={1.2} hire={{}} seats={{}} onHire={noop} onNewProject={noop} onInbox={noop}
    onDragStart={noop} onDragMove={noop} onDragEnd={noop} onDragCancel={noop} />
  const sa = agent('sa', 'boss', { cost_usd: 4.56 }) as unknown as CanvasNode
  const sb = agent('sb', 'boss') as unknown as CanvasNode
  const route = { org: 'org', dogs: [slotDog('sc', 'tests-ui', 4), slotDog('sb', 'cargo-test', 1)], slotLeases: [slotLease], open: noop } as never
  const box = (nd: CanvasNode) => (
    <div style={{ width: 470, height: 150, border: '1px solid var(--line)', position: 'relative', overflow: 'hidden' }}>
      <DeskChat node={nd} map={new Map([[nd.id, nd]])} op={() => Promise.resolve({} as OpResult)} slug="org" toast={noop} bare />
    </div>)
  return (
    <main style={{ position: 'relative', width: 1000, height: 700, background: 'var(--bg)' }}>
      <div style={{ position: 'absolute', left: 30, top: 30, transform: 'scale(2)', transformOrigin: '0 0' }}>
        {sq(crowd(19, 2, 80), 0)}
        {sq(crowd(140, 12, 3900), 170)}
      </div>
      <DeskDogsProvider value={route}>
        <div style={{ position: 'absolute', left: 20, top: 380, display: 'flex', gap: 16 }}>{box(sa)}{box(sb)}</div>
      </DeskDogsProvider>
    </main>
  )
}
if (new URLSearchParams(location.search).get('theme') === 'light') document.documentElement.classList.add('contrast-light')
const fqDog = (id: string, owner: string, state: string) => ({ id, owner, name: id, kind: 'fair_queue', target: 'site',
  interval_s: 5, state, at: new Date().toISOString(), fired: 0, once: false })
const dogs: Record<string, unknown[]> = {
  fairqueue: [fqDog('q1', 'dev1', 'armed'), fqDog('q2', 'boss', 'paused')],
  slotlines: [{ ...fqDog('q1', 'sa', 'armed'), target: 'build' }, slotDog('sc', 'tests-ui', 4), slotDog('sb', 'cargo-test', 1)],
}
const extras: Record<string, Record<string, unknown>> = {
  slotlines: { slot_leases: [slotLease], audiences: [{ grantor: 'sa', grantee: 'build', reason: 'reports', at: minsAgo(30) }] },
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
  slotlines: [agent('sa', 'boss'), agent('sb', 'boss'), buildProject([agent('sc', 'build')], 1)],
}
createRoot(document.getElementById('root')!).render(scene === 'cards' ? <Cards /> : scene === 'jumps' ? <Jumps />
  : scene === 'presented' ? <Presented />
  : scene === 'desc' ? <Desc />
  : scene === 'modal' ? <ProjectDeskModal node={card} slug="org" tree={tree([])} map={new Map([[card.id, card]])}
    op={() => Promise.resolve({} as OpResult)} toast={noop} refs={{ world: { org: 'org' }, onOpen: noop } as never} close={noop} />
  : scene === 'settings' ? <NodeConfig node={card} map={new Map([[card.id, card]])} tree={tree([])} slug="org"
    op={() => Promise.resolve({} as OpResult)} toast={noop} close={noop} onScratchFolder={noop} />
  : scene === 'corner' ? (
    <main style={{ position: 'relative', width: 1000, height: 700, background: 'var(--bg)', padding: 20 }}>
      <AgentSurfaceRoutesProvider value={{ open: noop, show: noop }}>
        <div className="desk-tabpanel" style={{ position: 'relative', width: 900, height: 600 }}>
          <PanelCorner kind="node-inbox" slug="org" nid="boss" />
          <InboxView slug="org" nid="boss" toast={noop} tierOf={() => 'opus'} hasAgent={() => true}
            refs={{ world: { org: 'org' }, onOpen: noop } as never} />
        </div>
      </AgentSurfaceRoutesProvider>
    </main>)
  : scene === 'activity' ? <Activity />
  : scene === 'slots' ? <Slots />
  : scene === 'cardfix' ? <CardFix /> : (
  <div style={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column' }}>
    <style>{'html, body, #root { height: 100%; margin: 0 } .viewport { flex: 1; min-height: 600px }'}</style>
    <OrgCanvas tree={tree(rows[scene]!, dogs[scene], extras[scene])} slug="org" op={() => Promise.resolve({} as OpResult)}
      toast={noop} mailEvt={null} onOpenAgentGallery={noop} />
  </div>
))
