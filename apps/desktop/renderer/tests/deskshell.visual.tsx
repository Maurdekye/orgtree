// deskshell.visual.tsx — before/after captures for the desk-shell
// extraction (agent-desks-and-project-desks-share-one-common-d): the agent
// desk and the project desk side by side, docked, in dark and light, plus
// the project desk in its modal frame (the pin/pop-out frame both desks
// share). Browser-only fixture data; no engine, bridge or live org.
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { DeskHosts, DeskSlot } from '../src/canvas/deskhosts'
import { DeskDogsProvider } from '../src/canvas/deskdogs'
import { ProjectDesk, ProjectDeskModal } from '../src/canvas/projectdesk'
import { CurrentOrg } from '../src/popout'
import { USER } from '../src/canvas/shared'
import type { CanvasNode, OpFn } from '../src/canvas/shared'
import type { TreePayload, Watchdog } from '../src/types'
import '../src/styles.css'

window.fetch = (async (url: RequestInfo | URL) => {
  const p = String(url)
  const payload = /\/chat(?:\?|$)/.test(p) ? { busy: false, queued: 0, responding: false,
      last_error: null, messages: [], live: [], draft_epoch: 0, mail_pending: 1, pending_mail: [] }
    : /\/work-items/.test(p) ? { items: [], archived: [], backlogged: [], references: [], attention: [],
      counts: { attention: 0, active: 0, archived: 0, backlogged: 0 } }
    : /\/inbox/.test(p) ? { pending: [], delivered: [], sent: [] } : { ok: true }
  return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } })
}) as typeof fetch

const noop = () => {}
const op: OpFn = async (body) => {
  if (body.op === 'slot_status') return {
    project: 'build', slots: 3, held: 1,
    holders: [{ lease: 's1', agent: 'alpha', slot: 1, reason: 'cargo build', queued: '2026-10-19T09:55:00.000Z', since: '2026-10-19T10:00:00.000Z', reminders: 0 }],
    line: [{ position: 1, agent: 'beta', dog: 'build-slot', since: '2026-10-19T10:05:00.000Z' }],
    history: [{ lease: 's0', agent: 'beta', slot: 1, reason: 'tests', queued: '2026-10-19T08:35:00.000Z',
      since: '2026-10-19T08:40:00.000Z', ended: '2026-10-19T08:52:00.000Z', how: 'released', by: 'beta' }],
  } as never
  return {} as never
}
const refs = { world: { org: 'org' }, onOpen: noop } as never

const alpha = { id: 'alpha', parent: 'build', tier: 'opus', state: 'live', generation: 0, busy: false,
  children: [], seat: 10, grant: 5, free: 5, mail_pending: 1, documents: [],
  last_status: { status: 'working', summary: 'Building the desk shell.' },
  scope: { tools: {}, add_dirs: [] }, turns: [], audiences_held: [] } as unknown as CanvasNode
const beta = { id: 'beta', parent: 'build', tier: 'haiku', state: 'live', generation: 0, busy: true,
  children: [], seat: 1, grant: 0, free: 0, scope: { tools: {}, add_dirs: [] }, turns: [], audiences_held: [] } as unknown as CanvasNode
const build = { id: 'build', title: 'build', tier: 'project', kind: 'project', state: 'live', model_id: '',
  seat: 0, grant: 0, free: 0, parent: USER, charter: 'Build slot project.', summary: 'Build slot project.',
  scope: { tools: {}, add_dirs: [] },
  configured_scope: { tools: {}, add_dirs: [], slots_capacity: 3, mail_queue: 'ack', peer_mail: true },
  children: [alpha, beta], lineage: [], turns: [], audiences_held: [],
  mail_pending: 2, mail_held: 1, dead_letters: 0, documents: [], documents_count: 0,
  last_status: null, occupancy: 0, context_window: 0, busy: false, activity: null } as unknown as CanvasNode
const map = new Map<string, CanvasNode>([[USER, { id: USER, parent: null, tier: null, state: 'user',
  children: ['build'] } as unknown as CanvasNode], ['build', build], ['alpha', alpha], ['beta', beta]])
const dog = (kind: Watchdog['kind'], owner: string, name: string, extra: Partial<Watchdog> = {}): Watchdog =>
  ({ id: owner + '/' + name, owner, name, kind, target: 'build', interval_s: 5, state: 'armed',
    at: '2026-10-19T09:00:00.000Z', fired: 0, once: true, spent: false, ...extra } as Watchdog)
const dogs = [
  dog('fair_queue', 'alpha', 'mail-a', { once: false }),
  dog('project_listener', 'alpha', 'ready-a'),
  dog('project_listener', 'beta', 'ready-b', { once: false }),
  dog('listener_watch', 'alpha', 'all-in', { count: 2 }),
  dog('slot', 'beta', 'build-slot', { queued_at: 1760000000000 }),
]
const leases = [{ lease: 's1', holder: 'alpha', project: 'build', since: '2026-10-19T10:00:00.000Z', reason: 'cargo build' }]
const tree = { slug: 'org', name: 'Fixture', epoch: 1, rev: 1, roots: [build], watchdogs: dogs, slot_leases: leases,
  work_items_summary: { attention: 0, active: 0 }, user_inbox_count: 0, user_inbox_urgent_count: 0,
  asks: [], asks_open: 0, max_top_grant: 1000 } as unknown as TreePayload

function Surface() {
  const [modal, setModal] = useState(false)
  useEffect(() => {
    Object.assign(window, { deskShellVisual: {
      modal: (v: boolean) => setModal(v),
      contrast: (light: boolean) => {
        document.documentElement.classList.toggle('contrast-light', light)
        document.documentElement.classList.toggle('contrast-charcoal', !light)
      } } })
  }, [])
  return <CurrentOrg.Provider value="org">
    <DeskHosts map={map} slug="org" treeSlug="org">
      <DeskDogsProvider value={{ dogs, slotLeases: leases as never, open: noop }}>
        <div style={{ display: 'flex', gap: 16, padding: 12, alignItems: 'flex-start' }}>
          <div style={{ width: 620, height: 640, display: 'flex' }} data-fixture="agent-desk">
            <DeskSlot node={alpha} map={map} slug="org" op={op} toast={noop} bare />
          </div>
          <div style={{ width: 620, height: 640, display: 'flex' }} data-fixture="project-desk">
            <ProjectDesk node={build} slug="org" tree={tree} map={map} op={op} toast={noop} refs={refs} bare />
          </div>
        </div>
        {modal && <ProjectDeskModal node={build} slug="org" tree={tree} map={map} op={op} toast={noop}
          refs={refs} close={() => setModal(false)} />}
      </DeskDogsProvider>
    </DeskHosts>
  </CurrentOrg.Provider>
}
document.body.style.background = 'var(--bg)'
createRoot(document.getElementById('root')!).render(<Surface />)
