// desktabmemory.visual.tsx — captures for "desks remember their last tab, and
// the Inbox tab is renamed Mail" (user 2026-10-20 06:22Z; coordinator 06:33Z):
// an agent desk beside a project desk, opened from remembered tabs as after a
// restart, then picked, unmounted and mounted again, and the project's mail
// window. Browser-only fixture data; no engine, bridge or live org.
import { useEffect, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { DeskHosts, DeskSlot } from '../src/canvas/deskhosts'
import { DeskDogsProvider } from '../src/canvas/deskdogs'
import { ProjectDesk, ProjectInboxModal } from '../src/canvas/projectdesk'
import { NodeInboxModal } from '../src/canvas/mail'
import { CurrentOrg } from '../src/popout'
import { USER } from '../src/canvas/shared'
import type { CanvasNode, OpFn } from '../src/canvas/shared'
import type { TreePayload } from '../src/types'
import '../src/styles.css'

const waiting = { id: 'm1', from: '@user', kind: 'message', body: 'Please deploy the docs site after the review.', at: '2026-10-20T06:00:00Z' }
const sent = { id: 's1', from: 'inner', to: 'boss', kind: 'message', body: 'The docs build is green.', at: '2026-10-20T05:40:00Z' }

window.fetch = (async (url: RequestInfo | URL) => {
  const p = String(url)
  const payload = /\/chat(?:\?|$)/.test(p) ? { busy: false, queued: 0, responding: false,
      last_error: null, messages: [], live: [], draft_epoch: 'fixture:0', mail_pending: 0, pending_mail: [] }
    : /\/work-items-page/.test(p) ? { format: 'orgtree.work-page/v1', group: 'items', rows: [], total: 0,
      totals: { items: 0, archived: 0, backlogged: 0 }, matched: { items: 0, archived: 0, backlogged: 0 },
      counts: { active: 0, attention: 0, archived: 0, backlogged: 0 }, assigned_count: 0, next_offset: null, revision: 'r1',
      at: '2026-10-20T06:00:00.000Z' }
    : /\/work-items/.test(p) ? { items: [], archived: [], backlogged: [], references: [], attention: [],
      counts: { attention: 0, active: 0, archived: 0, backlogged: 0 } }
    : /\/nodes\/inner\/inbox/.test(p) ? { pending: [waiting], delivered: [], sent: [sent] }
    : /\/inbox/.test(p) ? { pending: [], delivered: [], sent: [] }
    : /\/transfers/.test(p) ? { transfers: [], next_cursor: null }
    : /\/history(?:\?|$)/.test(p) ? { items: [] } : { ok: true }
  return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } })
}) as typeof fetch

const noop = () => {}
const op: OpFn = async () => ({}) as never
const refs = { world: { org: 'org' }, onOpen: noop } as never

const dev1 = { id: 'dev1', parent: 'inner', tier: 'sonnet', state: 'live', generation: 0, busy: false, children: [], seat: 1,
  grant: 0, free: 0, scope: { tools: {}, add_dirs: [] }, turns: [], audiences_held: [], documents: [] } as unknown as CanvasNode
const inner = { id: 'inner', title: 'inner', parent: 'boss', tier: 'project', kind: 'project', state: 'live', model_id: '',
  seat: 0, grant: 0, free: 0, scope: { tools: {}, add_dirs: [] }, configured_scope: { tools: {}, add_dirs: [], event_listeners: true },
  charter: '# The docs site\n\nShip the **docs** from `main` only.', children: [dev1], lineage: [], turns: [],
  audiences_held: [], mail_pending: 1, mail_held: 0, dead_letters: 0, documents: [], documents_count: 0,
  last_status: null, occupancy: 0, context_window: 0, busy: false, activity: null } as unknown as CanvasNode
const boss = { id: 'boss', parent: USER, tier: 'opus', state: 'live', generation: 0, busy: false, children: [inner], seat: 1,
  grant: 0, free: 0, scope: { tools: {}, add_dirs: [] }, turns: [], audiences_held: [], documents: [], mail_pending: 2,
  last_status: { status: 'working', summary: 'Coordinating the docs project.' } } as unknown as CanvasNode
const eye = { id: USER, parent: null, tier: null, state: 'user', children: [boss] } as unknown as CanvasNode
const map = new Map<string, CanvasNode>()
const add = (n: CanvasNode) => { map.set(n.id, n); for (const c of n.children ?? []) add(c as CanvasNode) }
add(eye)
const dog = (kind: string, name: string) => ({ id: 'dev1/' + name, owner: 'dev1', name, kind, target: 'inner', interval_s: 5,
  state: 'armed', at: '2026-10-20T05:00:00.000Z', fired: 0, once: false, spent: false })
const tree = { slug: 'org', name: 'Fixture', epoch: 1, rev: 1, roots: [boss],
  watchdogs: [dog('fair_queue', 'mail'), dog('project_listener', 'ready')], slot_leases: [],
  work_items_summary: { attention: 0, active: 0 }, user_inbox_count: 0, user_inbox_urgent_count: 0,
  asks: [], asks_open: 0, max_top_grant: 1000 } as unknown as TreePayload

/** what an earlier session left: boss on Docket, inner's Mail tab on Listeners */
const SEED = JSON.stringify({ boss: { tab: 'docket' }, inner: { tab: 'inbox', mail: 'listeners' } })
const seed = () => localStorage.setItem('orgtree-desk-tabs:org', SEED)
seed()

function Surface() {
  const [window_, setWindow] = useState<'project' | 'agent' | null>(null)
  useEffect(() => { Object.assign(window, { deskTabMemoryWindow: setWindow }) }, [])
  return <CurrentOrg.Provider value="org">
    <DeskHosts map={map} slug="org" treeSlug="org">
      <DeskDogsProvider value={{ dogs: [], slotLeases: [], open: noop }}>
        <div style={{ display: 'flex', gap: 10, padding: 8, alignItems: 'flex-start' }}>
          <div style={{ width: 470, height: 660, display: 'flex' }} data-fixture="agent-desk">
            <DeskSlot node={boss} map={map} slug="org" op={op} toast={noop} bare onJump={noop} />
          </div>
          <div style={{ width: 500, height: 660, display: 'flex' }} data-fixture="project-desk">
            <ProjectDesk node={inner} slug="org" tree={tree} map={map} op={op} toast={noop} refs={refs} bare onJump={noop} onOpenDoc={noop} />
          </div>
        </div>
        {window_ === 'project' && <ProjectInboxModal node={inner} slug="org" tree={tree} map={map} op={op} toast={noop} refs={refs}
          close={() => setWindow(null)} />}
        {window_ === 'agent' && <NodeInboxModal node={boss} slug="org" toast={noop} close={() => setWindow(null)} />}
      </DeskDogsProvider>
    </DeskHosts>
  </CurrentOrg.Provider>
}

let root: Root | null = null
const mount = () => { root = createRoot(document.getElementById('root')!); root.render(<Surface />) }
Object.assign(window, { deskTabMemoryVisual: {
  /** a revisit: both desks unmount, and mount again from storage */
  remount: () => { root?.unmount(); mount() },
  /** back to the earlier session's memory, mounted fresh */
  reseed: () => { root?.unmount(); seed(); mount() },
  window: (w: 'project' | 'agent' | null) => (window as unknown as { deskTabMemoryWindow: (v: typeof w) => void }).deskTabMemoryWindow(w),
  contrast: (light: boolean) => {
    document.documentElement.classList.toggle('contrast-light', light)
    document.documentElement.classList.toggle('contrast-charcoal', !light)
  },
} })
document.body.style.background = 'var(--bg)'
mount()
