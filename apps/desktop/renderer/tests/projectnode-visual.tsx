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
//             headers of slot holder sa and waiting sb (10:52:50Z);
//   hosts   — the REAL canvas with sb and project build pinned as windows;
//             the capture script also opens sa's and build's temporary
//             desks, so the four desk hosts can be set side by side (user
//             2026-10-18 11:14Z: one title bar, no empty strip).
//   deskhead — two full-width project desks: the header cards outlined
//             (top) and filled (below) in one row with the ↑ superior link,
//             the near-zoom cards under them for the colours (user
//             2026-10-19 19:02Z, 19:15Z); &theme=light for the light theme;
//   deskinbox — one desk whose inbox opens on its listeners folder (19:05Z-
//             19:33Z): ack mode (dev1 holds a job), &mode=rr round robin;
//             PROJECTNODE_VISUAL_ONLY=deskjump opens each of its tabs: the
//             jump cards stay on every one (19:58Z); &mode=lt its event
//             listeners table (one-shot, continuous, fired, never fired,
//             paused; two watches, one with a fire action, user 21:08Z-
//             21:11Z), &mode=empty a project nobody listens to (21:19Z);
//             &mode=history the three tables with their history (user
//             2026-10-20 06:22Z-06:42Z: Working, Line, Dead Letter Line and
//             Recently Finished; Recently Fired; the Slots Watchdog column),
//             &mode=historyrr the Mail listeners in round-robin; &w=740 a
//             desk that wide, &long=1 the long agent and dog names of the
//             user's narrow-desk screenshot (2026-10-20 09:00Z).
//   unwired — the REAL canvas: project site under boss, dev1 and dev2
//             listening on it and boss watching it, its event listeners on
//             (dev2 paused itself: a dim line); &off=1 the same after a
//             superior switched them off: every dog disabled, so no line
//             (user 2026-10-20 10:50Z: switching off unwires them);
//   deskinbox &mode=lsoff — a desk whose event listeners are off: no
//             Listeners tab, no cyan card; under it a disabled, an
//             owner-paused and an armed listener chip, as the canvas and the
//             desks draw them; &mode=lson the same desk switched on, its
//             Listeners tab open; &inbox=0 either one with no listener on
//             the inbox, so the message box's yellow note shows as well;
//   jumpscroll — a desk on the canvas with many jump cards (user 2026-10-20
//             09:41Z-09:50Z): stack16-agent-a under &up=N nested projects
//             under boss, with &down=N reports named and badged like the
//             user's screenshot and &dogs=N watchdogs; the canvas focuses it,
//             so its desk opens there and a wheel over a jump row meets the
//             canvas's own handler.
import { createRoot } from 'react-dom/client'
import { ProjectSquare } from '../src/canvas/projectcard'
import { SpawnChips } from '../src/canvas/cards'
import { OrgCanvas } from '../src/canvas/OrgCanvas'
import { DeskChat } from '../src/canvas/desk'
import { DeskDogsProvider } from '../src/canvas/deskdogs'
import { addPin } from '../src/canvas/pins'
import { CurrentOrg } from '../src/popout'
import { AgentGalleryView } from '../src/canvas/gallery'
import { ProjectDesk, ProjectDeskModal } from '../src/canvas/projectdesk'
import { NodeConfig } from '../src/canvas/modals'
import { AgentDeskPanel } from '../src/attention/AgentDeskPanel'
import { setAttentionLayout } from '../src/attention/mode'
import { InboxView } from '../src/canvas/mail'
import { AgentSurfaceRoutesProvider, PanelCorner } from '../src/canvas/panelcorner'
import { WatchdogSatellite } from '../src/canvas/watchdogchip'
import { WatchdogLink } from '../src/canvas/watchdoglink'
import type { CanvasNode, OpRequest, OpResult } from '../src/canvas/shared'
import type { TreePayload } from '../src/types'

const noop = () => {}
const answer = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }))
const relayInboxNow = Date.now()
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
  if (p.endsWith('/nodes/relay/inbox')) {
    // fixed at page load: the inbox re-polls, and a job's hand-out must not move
    const at = (m: number) => new Date(relayInboxNow - m * 60_000).toISOString()
    return answer({ pending: [], sent: [], delivered: [
      { id: 'm1', from: 'boss', kind: 'message', body: 'Ship the release notes', at: at(1), queue: { held_by: 'dev1', ack: true, held_at: at(0.8) } },
      { id: 'm2', from: 'boss', kind: 'message', body: 'Rebuild the docs', at: at(30), queue: { held_by: 'dev2', ack: true, held_at: at(20), acked_at: at(12) } },
    ] })
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

/** jumpscroll's reports: the names of the user's 09:41Z screenshot, then
 *  project stacks and their agents */
const JUMP_NAMES = ['build-slot', 'desk-parity-opus', 'inbox-ui-opus', 'skilltree-opus', 'compaction-cmds-sol', 'message-docs-luna',
  'docket-access-luna', 'image-embed-luna', 'helper-transcript-sol', 'hubchat-jumplist-sol', 'project-nodes-opus', 'taskbar-orgs-sol',
  'agy-accounts-opus', 'uninit-model-sol', 'standalone-wonder', 'rig-sol-b', 'epic-combo-sol', 'usage-header-sonnet', 'ordering-sol',
  'activefilter-luna', 'mentions-argon', 'hubchat-dm-sol', 'transparency-astra', 'transparency-opus', 'mqtt-watchdog-opus',
  'listener-smoke', 'test-project', 'test-project-worker-a', 'test-proj-worker-b', 'test-proj-worker-c', 'project-transparency-committee',
  ...[20, 12, 8, 5, 3].flatMap((k) => [...Array.from({ length: k }, (_, i) => `stack${k}-${String(i + 1).padStart(2, '0')}`),
    ...['a', 'b', 'c'].map((x) => `stack${k}-agent-${x}`)])]
const JUMP_PROJECTS = /^(build-slot|listener-smoke|test-project|project-transparency-committee|stack\d+-\d+)$/
function JumpScroll() {
  const q = new URLSearchParams(location.search)
  const down = Number(q.get('down') ?? 12), up = Number(q.get('up') ?? 3), dogCount = Number(q.get('dogs') ?? 0)
  const level = (i: number) => `stack16-${String(i).padStart(2, '0')}`
  const tiers = ['opus', 'sol', 'luna', 'sonnet', 'astra', 'argon', 'wonder', 'fable']
  const reports = JUMP_NAMES.slice(0, down).map((id, i) => JUMP_PROJECTS.test(id)
    ? projectNode(id, 'stack16-agent-a')
    : agent(id, 'stack16-agent-a', { tier: tiers[i % tiers.length], model_id: tiers[i % tiers.length],
      mail_pending: [42, 16, 0, 38, 21, 0, 43, 32, 0, 29, 0, 15][i % 12], busy: i % 7 === 1 }))
  const lead = agent('stack16-agent-a', up ? level(up) : 'boss', { tier: 'luna', model_id: 'luna', children: reports })
  let top: unknown = lead
  for (let i = up; i >= 1; i--) top = projectNode(level(i), i === 1 ? 'boss' : level(i - 1), [top])
  const dogs = Array.from({ length: dogCount }, (_, i) => headDog('file', 'stack16-agent-a', `watch-${i + 1}`, { target: 'x.log' }))
  return (
    <div style={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column' }}>
      <style>{'html, body, #root { height: 100%; margin: 0 } .viewport { flex: 1; min-height: 600px }'}</style>
      <CurrentOrg.Provider value="org">
        <OrgCanvas tree={tree([top], dogs)} slug="org" op={() => Promise.resolve({} as OpResult)}
          toast={noop} mailEvt={null} onOpenAgentGallery={noop} focusAgent="stack16-agent-a" />
      </CurrentOrg.Provider>
    </div>
  )
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

/** deskhead / deskinbox: project relay under boss, its header cards outlined
 *  (one event listener count, mail waiting with nobody listening, 2 of 3
 *  slots) and filled (a listener watch, two mail listeners in ack mode, all
 *  3 slots with 2 waiting) */
const headDog = (kind: string, owner: string, name: string, extra: Record<string, unknown> = {}) => ({
  id: owner + '/' + name, owner, name, kind, target: 'relay', interval_s: 5, state: 'armed',
  at: new Date(Date.now() - 42 * 60_000).toISOString(), fired: 0, once: false, spent: false, ...extra })
const relay = (scope: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  ...projectNode('relay', 'boss', [agent('dev1', 'relay', { busy: true }), agent('dev2', 'relay'), agent('lead', 'relay')]),
  charter: 'Relay: hands each job to the next free worker.',
  configured_scope: { tools: {}, add_dirs: [], ...scope }, ...extra }) as unknown as CanvasNode
const relayLease = (agentId: string, slot: number) =>
  ({ project: 'relay', agent: agentId, slot, lease: 'r' + slot, since: new Date(Date.now() - (10 + slot) * 60_000).toISOString(), reminders: 0 })
interface HeadSet { node: CanvasNode; dogs: unknown[]; leases: unknown[] }
const mailDogs = [
  headDog('fair_queue', 'dev1', 'mail-a', { fired: 4, last_fired: new Date(Date.now() - 48_000).toISOString() }),
  headDog('fair_queue', 'dev2', 'mail-b', { fired: 2, last_fired: new Date(Date.now() - 20 * 60_000).toISOString() }),
  headDog('fair_queue', 'lead', 'mail-c', { state: 'paused', fired: 1 }),
  headDog('fair_queue', 'boss', 'mail-d', { at: new Date(Date.now() - 25_000).toISOString() }),
]
const ago = (seconds: number) => new Date(Date.now() - seconds * 1000).toISOString()
const headSets: Record<'outlined' | 'filled' | 'roundrobin' | 'listeners' | 'empty', HeadSet> = {
  outlined: { node: relay({ slots_capacity: 3, event_listeners: true }, { mail_pending: 3 }),
    dogs: [headDog('project_listener', 'dev1', 'ready-a'), headDog('project_listener', 'dev2', 'ready-b')],
    leases: [relayLease('dev1', 1), relayLease('dev2', 2)] },
  filled: { node: relay({ slots_capacity: 3, mail_queue: 'ack', event_listeners: true }, { mail_pending: 3, mail_held: 1 }),
    dogs: [headDog('project_listener', 'dev1', 'ready-a'), headDog('project_listener', 'dev2', 'ready-b'),
      headDog('listener_watch', 'lead', 'all-ready', { count: 3 }),
      ...mailDogs,
      headDog('slot', 'lead', 'wait-a', { once: true, queued_at: new Date(Date.now() - 5 * 60_000).toISOString() }),
      headDog('slot', 'boss', 'wait-b', { once: true, queued_at: new Date(Date.now() - 2 * 60_000).toISOString() })],
    leases: [relayLease('dev1', 1), relayLease('dev2', 2), relayLease('lead', 3)] },
  roundrobin: { node: relay({ slots_capacity: 3 }, { mail_pending: 2 }), dogs: mailDogs, leases: [] },
  listeners: { node: relay({ slots_capacity: 3, event_listeners: true }, { mail_pending: 2 }),
    dogs: [headDog('project_listener', 'dev1', 'ready-a', { once: true }),
      headDog('project_listener', 'dev2', 'build-done', { fired: 3, last_fired: ago(180) }),
      headDog('project_listener', 'lead', 'deploy-watch'),
      headDog('project_listener', 'boss', 'ready-boss', { once: true, state: 'paused' }),
      headDog('listener_watch', 'lead', 'all-ready', { once: true, count: 3,
        fire_actions: [{ tool: 'orgtree_project', args: { action: 'fire_event', name: 'relay' } }] }),
      headDog('listener_watch', 'boss', 'quorum', { count: 2, state: 'paused', notice: true, fired: 1, last_fired: ago(7200) }),
      ...mailDogs],
    leases: [relayLease('dev1', 1), relayLease('dev2', 2)] },
  empty: { node: relay({ event_listeners: true }), dogs: [], leases: [] },
}
/** history: the desk's three tables with the engine's history reads */
const historyDogs = [
  ...headSets.listeners.dogs.filter((w) => (w as { kind: string }).kind !== 'fair_queue'),
  ...mailDogs,
  headDog('event', 'boss', 'dead-watch', { target: 'project.dead_letter', fired: 1, last_fired: ago(1500) }),
  headDog('slot', 'lead', 'wait-a', { once: true, queued_at: ago(300) }),
]
const historySets = {
  ack: { node: relay({ slots_capacity: 3, mail_queue: 'ack', event_listeners: true }, { mail_pending: 1, mail_held: 1, dead_letters: 1 }),
    dogs: historyDogs, leases: [relayLease('dev1', 1), relayLease('dev2', 2)] } as HeadSet,
  rr: { node: relay({ slots_capacity: 3, event_listeners: true }, { mail_pending: 0 }), dogs: historyDogs, leases: [] } as HeadSet,
}
/** &long=1: names as long as the user's 09:00Z screenshot's, so a narrow desk
 *  shortens them (the fixture's data with each name swapped) */
const LONG: Record<string, string> = {
  dev1: 'test-proj-worker-c', dev2: 'test-project-worker-a', lead: 'test-proj-worker-b', boss: 'coordinator-opus',
  'mail-a': 'ack-test-listener-c', 'mail-b': 'ack-test-listener-a', 'mail-c': 'ack-test-listener-b', 'mail-d': 'dlq-smoke-listener',
  'dead-watch': 'dlq-smoke-dead-letter-watch', 'ready-a': 'ready-for-the-build-a', 'build-done': 'build-done-listener',
  'deploy-watch': 'deploy-watch-continuous', 'all-ready': 'all-ready-listener-watch', 'build-slot': 'build-slot-for-alpha-17',
  'test-slot': 'test-slot-for-rig-proofs', 'first-build': 'first-build-of-the-day', 'wait-a': 'wait-for-a-build-slot',
}
const lengthen = <T,>(x: T): T => JSON.parse(JSON.stringify(x)
  .replace(new RegExp(`\\b(${Object.keys(LONG).join('|')})\\b`, 'g'), (m) => LONG[m]!)) as T
const kept = (owner: string, name: string, kind: string, gone = false) => ({ id: `${owner}/${name}`, owner, name, kind, once: kind === 'slot', state: gone ? 'spent' : 'armed', gone })
function historyAnswer(b: OpRequest, rr: boolean): unknown {
  if (b.op === 'mail_queue_history') {
    if (rr) {
      const d = (id: number, agent: string, name: string, gist: string, held: number, waited: number) =>
        ({ id, copy: `c${id}`, agent, mail: `m${id}`, gist, dog: kept(agent, name, 'fair_queue'), held_at: ago(held), waited_from: ago(waited) })
      return { project: 'relay', ack: false, history: [d(9, 'dev1', 'mail-a', 'Ship the release notes', 48, 300),
        d(8, 'boss', 'mail-d', 'Tag the build', 400, 425), d(7, 'dev2', 'mail-b', 'Rebuild the docs', 1200, 2600),
        d(6, 'dev1', 'mail-a', 'Update the changelog', 2400, 2500)], history_next: 'c6' }
    }
    const end = (id: number, agent: string, name: string, how: string, gist: string, waited: number, held: number, ended: number,
      extra: Record<string, unknown> = {}) => ({ id, mail: `m${id}`, gist, copy: `c${id}`, agent, dog: kept(agent, name, 'fair_queue'), how,
      attempt: 1, waited_from: ago(waited), held_at: ago(held), ended_at: ago(ended), ...extra })
    return { project: 'relay', ack: true, max_attempts: 3, dead_letters: true,
      working: [{ mail: 'm1', gist: 'Ship the release notes', copy: 'c1', agent: 'dev1', dog: kept('dev1', 'mail-a', 'fair_queue'),
        attempts: 1, waited_from: ago(300), held_at: ago(48) }],
      history: [
        end(5, 'dev2', 'mail-b', 'acked', 'Rebuild the docs', 2600, 1200, 720, { ack: 'a5', ack_gist: 'Docs rebuilt and pushed' }),
        end(4, 'lead', 'mail-c', 'failed', 'Fix the flaky test', 3400, 3300, 1800, { why: 'was halted' }),
        end(3, 'dev1', 'mail-a', 'taken_back', 'Update the changelog', 4000, 3900, 2400, { why: 'had it taken back by @user' }),
        end(2, 'dev2', 'mail-b', 'dead_letter', 'Migrate the old wiki', 9000, 8800, 6000, { why: 'did not ack it after 2 reminders', attempt: 3 }),
        end(1, 'dev1', 'mail-a', 'acked', 'Write the release plan', 12000, 11000, 9500, { ack: 'a1', ack_gist: 'Plan written: docs/release.md' }),
      ], history_next: 'c1' }
  }
  if (b.op === 'listener_history') {
    return { project: 'relay', history: [
      { id: 12, at: ago(180), kind: 'event', by: 'lead', message: 'go: start build 7\nThen run the full test round and report the results to lead before 18:00.',
        listeners: [
          { agent: 'dev1', dog: 'ready-a', name: 'ready-a', once: true, since: ago(480), mail: 'mf1' },
          { agent: 'dev2', dog: 'build-done', name: 'build-done', once: false, since: ago(240), mail: 'mf2' },
          { agent: 'lead', dog: 'deploy-watch', name: 'deploy-watch', once: false, since: ago(2400), mail: 'mf3', mail_gone: true },
        ] },
      { id: 11, at: ago(181), kind: 'watch', by: 'lead', message: null,
        watch: { agent: 'lead', dog: 'all-ready', name: 'all-ready', count: 3, armed: 3, since: ago(900) },
        listeners: [
          { agent: 'dev1', dog: 'ready-a', name: 'ready-a', once: true, since: ago(480) },
          { agent: 'dev2', dog: 'build-done', name: 'build-done', once: false, since: ago(240) },
          { agent: 'lead', dog: 'deploy-watch', name: 'deploy-watch', once: false, since: ago(2400) },
        ] },
      { id: 10, at: ago(5400), kind: 'event', by: '@user', message: null, listeners: [] },
    ], history_next: 'c10' }
  }
  if (b.op === 'slot_status') {
    return { project: 'relay', slots: 3, held: 2,
      holders: [{ lease: 'r1', agent: 'dev1', slots: 1, reason: 'build-slot', since: ago(660), queued: ago(700), reminders: 0, dog: kept('dev1', 'build-slot', 'slot', true) },
        { lease: 'r2', agent: 'dev2', slots: 1, reason: 'test-slot', since: ago(720), reminders: 1, dog: kept('dev2', 'test-slot', 'slot', true) }],
      line: [{ position: 1, agent: 'lead', dog: 'lead/wait-a', slots: 1, since: ago(300) }],
      history: [{ lease: 'r0', agent: 'lead', slots: 1, reason: 'first-build', since: ago(4000), queued: ago(4100), ended: ago(3000), how: 'released',
        dog: kept('lead', 'first-build', 'slot', true) }], history_next: null }
  }
  return {}
}
const headTree = (set: HeadSet) => ({ ...tree([set.node]), watchdogs: set.dogs, slot_leases: set.leases }) as unknown as TreePayload
const headMap = (set: HeadSet) => {
  const above = (set.node as unknown as { parent: string }).parent
  const boss = agent(above, '', { parent: null, tier: 'opus', model_id: 'opus', seat: 5, grant: 20 }) as unknown as CanvasNode
  const kids = (set.node as unknown as { children: CanvasNode[] }).children
  return new Map<string, CanvasNode>([[boss.id, boss], [set.node.id, set.node], ...kids.map((k) => [k.id, k] as [string, CanvasNode])])
}
/** the slots tab's slot_status, from the set's leases and its waiting slot dogs */
const headSlotStatus = (set: HeadSet) => {
  const dogs = set.dogs as { kind: string; owner: string; id: string; queued_at?: string }[]
  const line = dogs.filter((w) => w.kind === 'slot').map((w, i) => ({ position: i + 1, agent: w.owner, dog: w.id, since: w.queued_at ?? null }))
  const slots = (set.node as unknown as { configured_scope: { slots_capacity?: number } }).configured_scope.slots_capacity ?? 0
  return { project: set.node.id, slots, held: set.leases.length, holders: set.leases, line, history: [], history_next: null }
}
function HeadDesk({ set, top, height, id, route = false, answer, width = 980 }: { set: HeadSet; top: number; height: number; id: string; route?: boolean
  answer?: (b: OpRequest) => unknown; width?: number }) {
  const desk = <ProjectDesk bare node={set.node} slug="org" tree={headTree(set)} map={headMap(set)}
    op={(b) => Promise.resolve((answer ? answer(b) : b.op === 'slot_status' ? headSlotStatus(set) : {}) as unknown as OpResult)}
    toast={noop} refs={{ world: { org: 'org' }, onOpen: noop } as never} onJump={noop} />
  return (
    // on the panel colour, as the desk modal's frame (.tempdesk-panel), so the sticky Action cells match the app
    <div id={id} className="head-desk" style={{ position: 'absolute', left: 10, top, width, height, border: '1px solid var(--line)', overflow: 'hidden',
      background: 'var(--panel)' }}>
      {/* the canvas's dog route, so watchdog chips are the buttons the app shows */}
      {route ? <DeskDogsProvider value={{ org: 'org', dogs: set.dogs as never, open: noop }}>{desk}</DeskDogsProvider> : desk}
    </div>
  )
}
/** deskinbox &mode=lsoff / lson: relay's event listeners off (its dogs
 *  disabled) or on (the same dogs armed); &inbox=0 without its inbox's
 *  fair_queue listeners, so the message box's no-listener note shows too */
const RELAY_OFF = "project relay's event listeners were turned off by boss"
const lsSet = (on: boolean, inbox: boolean): HeadSet => ({
  node: relay({ slots_capacity: 3, ...(on ? { event_listeners: true } : {}) }, { mail_pending: 2 }),
  dogs: [headDog('project_listener', 'dev1', 'ready-a', on ? {} : { state: 'paused', disabled: RELAY_OFF }),
    headDog('project_listener', 'dev2', 'build-done', { fired: 3, last_fired: ago(180), ...(on ? {} : { state: 'paused', disabled: RELAY_OFF }) }),
    headDog('project_listener', 'lead', 'deploy-watch', { state: 'paused' }),
    headDog('listener_watch', 'boss', 'quorum', { count: 2, ...(on ? {} : { state: 'paused', disabled: RELAY_OFF }) }),
    ...(inbox ? mailDogs : [])],
  leases: [relayLease('dev1', 1)],
})
function ListenerSetting({ on, inbox }: { on: boolean; inbox: boolean }) {
  const set = lsSet(on, inbox)
  const chips = [
    headDog('project_listener', 'dev1', 'ready-a', { state: 'paused', disabled: RELAY_OFF }),
    headDog('project_listener', 'lead', 'deploy-watch', { state: 'paused' }),
    headDog('project_listener', 'dev2', 'build-done'),
  ] as never[]
  return <main style={{ position: 'relative', width: 1000, height: 700, background: 'var(--bg)' }}>
    <HeadDesk set={set} top={10} height={on ? 680 : 470} id="desk-inbox" route />
    {!on && <div id="ls-chips" style={{ position: 'absolute', left: 10, top: 500, width: 980, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
        <span style={{ width: 150, color: 'var(--dim)' }}>canvas satellites</span>
        {chips.map((w: { id: string }) => <span key={w.id} style={{ position: 'relative', display: 'inline-block', width: 150, height: 24 }}>
          <WatchdogSatellite dog={w as never} dogs={chips as never} org="org" onOpen={noop} style={{ position: 'absolute', left: 0, top: 0 }} /></span>)}
      </div>
      <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
        <span style={{ width: 150, color: 'var(--dim)' }}>desk chips</span>
        {chips.map((w: { id: string }) => <WatchdogLink key={w.id} dog={w as never} org="org" onOpen={noop} />)}
      </div>
    </div>}
  </main>
}
function DeskHead() {
  const near = (set: HeadSet, x: number, id: string) => <div id={id} style={{ position: 'absolute', left: x, top: 0 }}>
    <ProjectSquare node={set.node} pos={{ x: 0, y: 0 }} lod="norm" tree={headTree(set)} map={headMap(set)}
      dragging={false} isDrop={false} op={() => Promise.resolve({} as OpResult)} slug="org" toast={noop}
      zoom={1.5} hire={{}} seats={{}} onHire={noop} onNewProject={noop} onInbox={noop}
      onDragStart={noop} onDragMove={noop} onDragEnd={noop} onDragCancel={noop} />
  </div>
  return (
    <main style={{ position: 'relative', width: 1000, height: 700, background: 'var(--bg)' }}>
      <HeadDesk set={headSets.outlined} top={10} height={200} id="desk-outlined" />
      <HeadDesk set={headSets.filled} top={220} height={200} id="desk-filled" />
      <div style={{ position: 'absolute', left: 60, top: 440, transform: 'scale(1.5)', transformOrigin: '0 0' }}>
        {near(headSets.outlined, 0, 'near-outlined')}
        {near(headSets.filled, 170, 'near-filled')}
      </div>
    </main>
  )
}

/** attn — the Attention desk panel with project website selected: the project
 *  desk, not the agent desk (user 2026-10-18 14:36Z) */
function Attn() {
  const boss = agent('boss', '', { parent: null, tier: 'opus', model_id: 'opus', seat: 5, grant: 20 }) as unknown as CanvasNode
  const kids = ((card as unknown as { children: CanvasNode[] }).children)
  const map = new Map<string, CanvasNode>([[boss.id, boss], [card.id, card], ...kids.map(k => [k.id, k] as [string, CanvasNode])])
  setAttentionLayout('org', { agent: 'website' })
  return (
    <main className="attn-panel attn-panel-desk" style={{ position: 'relative', width: 1000, height: 700, background: 'var(--bg)' }}>
      <AgentDeskPanel slug="org" tree={tree([card])} op={() => Promise.resolve({} as OpResult)} toast={noop} map={map} />
    </main>
  )
}

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
function Slots({ multi = false } = {}) {
  const full = buildProject([agent('sa', 'build'), agent('sb', 'build'), agent('sc', 'build')], multi ? 3 : 1) as unknown as CanvasNode
  const empty = buildProject([agent('sa', 'build')], 2) as unknown as CanvasNode
  const currentLease = multi ? { ...slotLease, slots: 2 } : slotLease
  const t = tree([], [{ ...slotDog('sc', 'tests-ui', 4), slots: multi ? 3 : 1 }, slotDog('sb', 'cargo-test', 1)], { slot_leases: [currentLease] })
  const currentStatus = multi ? { ...slotStatus, slots: 3, held: 2, holders: [currentLease],
    line: slotStatus.line.map((w, i) => ({ ...w, slots: i === 0 ? 3 : 1 })),
    history: slotStatus.history.map((h, i) => ({ ...h, slots: i === 0 ? 2 : 1 })) } : slotStatus
  const desk = (nd: CanvasNode, tr: TreePayload, status: unknown, left: number) => (
    <div className="slots-desk" style={{ position: 'absolute', left, top: 10, width: multi ? 980 : 480, height: 680, border: '1px solid var(--line)' }}>
      <ProjectDesk bare node={nd} slug="org" tree={tr} map={new Map([[nd.id, nd]])}
        op={(b) => Promise.resolve((b.op === 'slot_status' ? status : {}) as unknown as OpResult)}
        toast={noop} refs={{ world: { org: 'org' }, onOpen: noop } as never} onJump={noop} onConfig={noop} />
    </div>)
  return (
    <main style={{ position: 'relative', width: 1000, height: 700, background: 'var(--bg)' }}>
      {desk(full, t, currentStatus, 10)}
      {!multi && desk(empty, tree([]), { project: 'build', slots: 2, held: 0, holders: [], line: [], history: [] }, 505)}
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
/** unwired: project site's listeners, its event listeners on or (&off=1) switched off */
const lsOff = new URLSearchParams(location.search).get('off') === '1'
const OFF_WHY = "project site's event listeners were turned off by the user"
const lsDog = (name: string, owner: string, state: string, extra: Record<string, unknown> = {}) => ({ id: owner + '/' + name, owner, name,
  kind: 'project_listener', target: 'site', interval_s: 5, state, at: new Date().toISOString(), fired: 0, once: false, spent: false, ...extra })
const lsDogs = lsOff
  ? [lsDog('ready-a', 'dev1', 'paused', { disabled: OFF_WHY }), lsDog('ready-b', 'dev2', 'paused', { disabled: OFF_WHY }),
    lsDog('quorum', 'boss', 'paused', { kind: 'listener_watch', count: 2, disabled: OFF_WHY })]
  : [lsDog('ready-a', 'dev1', 'armed'), lsDog('ready-b', 'dev2', 'paused'), lsDog('quorum', 'boss', 'armed', { kind: 'listener_watch', count: 2 })]
const dogs: Record<string, unknown[]> = {
  unwired: lsDogs,
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
if (scene === 'hosts') {
  addPin('org', 'sb', { x: 20, y: 330, w: 470, h: 300 })
  addPin('org', 'build', { x: 510, y: 330, w: 470, h: 300 })
}
const rows: Record<string, unknown[]> = {
  hosts: [agent('sa', 'boss'), agent('sb', 'boss', { cost_usd: 1.03 }),
    { ...buildProject([agent('sc', 'build', { busy: true, inflight_at: minsAgo(22) })], 1),
      charter: 'Build machine permit: claim the slot before any heavy phase.' }],
  'row-end': [agent('a1', 'boss'), agent('a2', 'boss'), projectNode('site', 'boss')],
  between: [agent('a1', 'boss'), projectNode('site', 'boss'), agent('a2', 'boss')],
  fairqueue: [agent('lead', 'boss'), projectNode('site', 'boss', [agent('dev1', 'site'), agent('dev2', 'site')])],
  unwired: [agent('lead', 'boss'), { ...projectNode('site', 'boss', [agent('dev1', 'site'), agent('dev2', 'site')]),
    configured_scope: { tools: {}, add_dirs: [], event_listeners: !lsOff } }],
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
  : scene === 'jumpscroll' ? <JumpScroll />
  : scene === 'slots' ? <Slots />
  : scene === 'multi-slots' ? <Slots multi />
  : scene === 'cardfix' ? <CardFix />
  : scene === 'attn' ? <Attn />
  : scene === 'deskhead' ? <DeskHead />
  : scene === 'deskinbox' ? (() => {
    const mode = new URLSearchParams(location.search).get('mode')
    if (mode === 'lsoff' || mode === 'lson') {
      return <ListenerSetting on={mode === 'lson'} inbox={new URLSearchParams(location.search).get('inbox') !== '0'} />
    }
    if (mode === 'history' || mode === 'historyrr') {
      const rr = mode === 'historyrr'
      const q = new URLSearchParams(location.search)
      const width = Number(q.get('w')) || 980
      const named = q.get('long') === '1' ? lengthen : <T,>(x: T) => x
      return <main style={{ position: 'relative', width: width + 20, height: 700, background: 'var(--bg)' }}>
        <HeadDesk set={named(rr ? historySets.rr : historySets.ack)} top={10} height={680} width={width} id="desk-inbox" route
          answer={(b) => named(historyAnswer(b, rr))} />
      </main>
    }
    return <main style={{ position: 'relative', width: 1000, height: 700, background: 'var(--bg)' }}>
      <HeadDesk set={mode === 'rr' ? headSets.roundrobin : mode === 'lt' ? headSets.listeners : mode === 'empty' ? headSets.empty : headSets.filled}
        top={10} height={680} id="desk-inbox" route={mode === 'lt' || mode === 'empty'} />
    </main>
  })() : (
  <div style={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column' }}>
    <style>{'html, body, #root { height: 100%; margin: 0 } .viewport { flex: 1; min-height: 600px }'}</style>
    {/* inside the org, as the app is: only an org's surfaces pin and pop out */}
    <CurrentOrg.Provider value="org">
      <OrgCanvas tree={tree(rows[scene]!, dogs[scene], extras[scene])} slug="org" op={() => Promise.resolve({} as OpResult)}
        toast={noop} mailEvt={null} onOpenAgentGallery={noop} />
    </CurrentOrg.Provider>
  </div>
))
