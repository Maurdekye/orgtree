// cardshortcuts.visual.tsx — captures for "agent card shortcuts dont derender
// on project nodes when viewing the desk" and the shortcuts added beside them
// (docket agent-shortcut-badges-stay-rendered-beside-an-op, user 2026-10-20
// 09:23Z–09:25Z): a project's open desk at canvas zoom with the pointer on it,
// then the project and agent cards at overview zoom, each hovered. Cards sit
// in a `.space` world layer like OrgCanvas's. Browser-only fixture data; no
// engine, bridge or live org.
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ProjectSquare } from '../src/canvas/projectcard'
import { NodeSquare } from '../src/canvas/cards'
import { AgentSurfaceRoutesProvider } from '../src/canvas/panelcorner'
import { CurrentOrg } from '../src/popout'
import { setAgentShortcutsOn, USER, Z_MAX } from '../src/canvas/shared'
import type { CanvasNode, OpFn } from '../src/canvas/shared'
import type { TreePayload } from '../src/types'
import '../src/styles.css'

window.fetch = (async (url: RequestInfo | URL) => {
  const p = String(url)
  const payload = /\/work-items-page/.test(p) ? { format: 'orgtree.work-page/v1', group: 'items', rows: [], total: 0,
      totals: { items: 0, archived: 0, backlogged: 0 }, matched: { items: 0, archived: 0, backlogged: 0 },
      counts: { active: 0, attention: 0, archived: 0, backlogged: 0 }, assigned_count: 0, next_offset: null, revision: 'r1',
      at: '2026-10-20T09:00:00.000Z' }
    : /\/work-items/.test(p) ? { items: [], archived: [], backlogged: [], references: [], attention: [],
      counts: { attention: 0, active: 0, archived: 0, backlogged: 0 } }
    : /\/inbox/.test(p) ? { pending: [], delivered: [], sent: [] }
    : /\/transfers/.test(p) ? { transfers: [], next_cursor: null }
    : /\/history(?:\?|$)/.test(p) ? { items: [] } : { ok: true }
  return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } })
}) as typeof fetch

const noop = () => {}
const op: OpFn = async () => ({}) as never
const refs = { world: { org: 'org' }, onOpen: noop } as never
const offer = { enabled: true, installed: true, reason: null }
const seats = { haiku: 1, sonnet: 2, opus: 5, fable: 10, luna: 0.2, sol: 5, astra: 8 }

const agent = (id: string, tier: string, parent: string, extra: Partial<CanvasNode> = {}) => ({
  id, title: id, parent, tier, model_id: tier, state: 'live', generation: 0, seat: seats[tier as keyof typeof seats] ?? 1,
  grant: 2, free: 0, scope: { tools: {}, add_dirs: [] }, children: [], lineage: [], turns: [], audiences_held: [],
  bearer_state: null, frozen: null, limit_locked: false, mail_pending: 0, documents: [],
  last_status: { status: 'working', summary: 'fixture', at: '' }, prev_status: null, inflight_at: null, last_denials: [],
  occupancy: 300, occupancy_est: false, context_window: 1000, busy: false, activity: null,
  proc_warm: true, proc_live: true, proc_relaunch: false, proc_relaunch_reason: null, isBearerOf: undefined,
  ...extra,
}) as unknown as CanvasNode

const members = ['stack3-agent-a', 'stack3-agent-b', 'stack3-agent-c'].map((id) => agent(id, 'sol', 'stack3-03'))
const project = { id: 'stack3-03', title: 'stack3-03', parent: 'lead', tier: 'project', kind: 'project', state: 'live',
  model_id: '', generation: 0, seat: 0, grant: 0, free: 0, scope: { tools: {}, add_dirs: [] },
  configured_scope: { tools: {}, add_dirs: [], slots_capacity: 2, event_listeners: true }, charter: '', children: members, lineage: [], turns: [],
  audiences_held: [], mail_pending: 0, mail_held: 0, dead_letters: 0, documents: [], documents_count: 0,
  last_status: null, occupancy: 0, context_window: 0, busy: false, activity: null,
} as unknown as CanvasNode
const helper = agent('helper', 'sonnet', 'lead')
const lead = agent('lead', 'opus', USER, { children: [project, helper], mail_pending: 2,
  documents: [{ id: 'd1', title: 'Plan', kind: 'md', at: '2026-10-20T08:00:00Z' }] } as never)
const map = new Map<string, CanvasNode>()
const add = (n: CanvasNode) => { map.set(n.id, n); for (const c of n.children ?? []) add(c as CanvasNode) }
add(lead)
const tree = { slug: 'org', name: 'Fixture', epoch: 1, rev: 1, roots: [lead], watchdogs: [], slot_leases: [],
  work_items_summary: { attention: 0, active: 0 }, user_inbox_count: 0, user_inbox_urgent_count: 0,
  asks: [], asks_open: 0, max_top_grant: 1000 } as unknown as TreePayload

setAgentShortcutsOn(true)

type Scene = 'desk' | 'cards' | 'far'
/** where each scene puts the world: the desk fills most of the window; the
 *  cards sit at overview zoom, then below 1 where their rows can wrap */
const VIEW: Record<Scene, { x: number; y: number; z: number }> = {
  desk: { x: 200, y: 36, z: 5 }, cards: { x: 90, y: 150, z: 2.4 }, far: { x: 250, y: 260, z: 0.9 },
}

function World({ scene }: { scene: Scene }) {
  const { x, y, z } = VIEW[scene]
  const hire = { claudeHire: offer }
  const projectCard = <ProjectSquare node={project} pos={{ x: 0, y: 0 }} lod="norm" focused={scene === 'desk'}
    dragging={false} isDrop={false} op={op} slug="org" toast={noop} zoom={z} tree={tree} map={map} refs={refs}
    hire={hire} seats={seats} onHire={noop} onNewProject={noop} onSpawnSide={noop} onSpawnTop={noop} onNewProjectAt={noop}
    onInbox={noop} onDocket={noop} onTeam={noop} onSettings={noop} onOpenGallery={noop} onOpenDoc={noop}
    onOpenTemporary={noop} onFocus={noop} onJump={noop}
    onDragStart={noop} onDragMove={noop} onDragEnd={noop} onDragCancel={noop} />
  return <div className="space" data-scene={scene} style={{ width: 600, height: 400,
    transform: `translate(${x}px, ${y}px) scale(${z})`,
    '--invz': Math.min(2.4, Math.max(1 / Z_MAX, 1 / z)).toFixed(3),
    '--invzf': Math.max(1 / Z_MAX, 1 / z).toFixed(3) } as React.CSSProperties}>
    {projectCard}
    {scene !== 'desk' && <NodeSquare node={lead} pos={{ x: 160, y: 0 }} lod="norm" focused={false}
      dragging={false} isDrop={false} seats={seats} claudeHire={offer} map={map} op={op} slug="org" toast={noop}
      pxc={1} zoom={z} compactAt={0.8} maxTop={100} cascadeAlloc
      onSpawn={noop} onSpawnSide={noop} onSpawnTop={noop} onConfig={noop} onInbox={noop} onTeam={noop} onDocket={noop}
      onPin={noop} onOpenAgentGallery={noop} onLineage={noop} onOpenDoc={noop} onRecenter={noop} onJump={noop}
      onMailLink={noop} onWorkLink={noop} onDragStart={noop} onDragMove={noop} onDragEnd={noop} onDragCancel={noop} />}
  </div>
}

function Surface() {
  const [scene, setScene] = useState<Scene>('desk')
  useEffect(() => { Object.assign(window, { cardShortcutsScene: setScene }) }, [])
  return <CurrentOrg.Provider value="org">
    <AgentSurfaceRoutesProvider value={{ open: noop, show: noop }}>
      <World key={scene} scene={scene} />
    </AgentSurfaceRoutesProvider>
  </CurrentOrg.Provider>
}

Object.assign(window, { cardShortcutsVisual: {
  scene: (s: Scene) => (window as unknown as { cardShortcutsScene: (v: Scene) => void }).cardShortcutsScene(s),
  contrast: (light: boolean) => {
    document.documentElement.classList.toggle('contrast-light', light)
    document.documentElement.classList.toggle('contrast-charcoal', !light)
  },
} })
document.body.style.background = 'var(--bg)'
document.body.style.margin = '0'
createRoot(document.getElementById('root')!).render(<Surface />)
