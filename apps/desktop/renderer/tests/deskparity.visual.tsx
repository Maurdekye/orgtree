// deskparity.visual.tsx — captures for the project desk parity pass
// (final-parity-pass-project-desks-behave-like-agen): an agent desk beside
// a nested project desk, in dark and light, with the project's inbox window.
// Browser-only fixture data; no engine, bridge or live org.
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { DeskHosts, DeskSlot } from '../src/canvas/deskhosts'
import { DeskDogsProvider } from '../src/canvas/deskdogs'
import * as projectdesk from '../src/canvas/projectdesk'
import { CurrentOrg } from '../src/popout'
import { USER } from '../src/canvas/shared'
import type { CanvasNode, OpFn } from '../src/canvas/shared'
import type { TreePayload } from '../src/types'
import '../src/styles.css'

const { ProjectDesk } = projectdesk
const ProjectInboxModal = (projectdesk as unknown as Record<string, unknown>).ProjectInboxModal as
  typeof projectdesk.ProjectDeskModal | undefined

const waiting = { id: 'm1', from: '@user', kind: 'message', body: 'Please deploy the docs site after the review.', at: '2026-10-19T12:00:00Z' }
const held = { id: 'm2', from: 'boss', kind: 'question', body: 'Which branch is the release on?', at: '2026-10-19T11:40:00Z',
  queue: { held_by: 'dev1', held_at: '2026-10-19T11:41:00Z', ack: false } }
const ticket = (slug: string, owner: string, status: string) => ({
  slug, rev: 1, kind: 'code', title: slug.replace(/-/g, ' '), objective: slug, status, blocked_reason: status === 'blocked' ? 'waits on review' : null,
  archived: false, archived_at: null, owner: { node: owner, generation: 0 }, owner_current: true, owner_state: 'live',
  reviewer: null, participants: [], created_by: { node: owner, generation: 0 }, at: '2026-10-19T08:00:00.000Z',
  updated_at: '2026-10-19T09:00:00.000Z', done_so_far: [], working_on_next: [], docket_at: '2026-10-19T09:00:00.000Z',
  last_updater: { node: owner, generation: 0 }, manual_attention: null, dismissals: [], questions: [], effective_attention: false,
  attention_sources: [], acceptance: [], dependencies: [], evidence: [], delivery: null, accepted: null, superseded_by: null, history: [],
})
const rows = [ticket('build-the-docs', 'dev1', 'in_progress'), ticket('review-the-docs', 'dev2', 'review'),
  ticket('fix-the-links', 'dev1', 'blocked'), ticket('ship-v1', 'dev2', 'done')]

window.fetch = (async (url: RequestInfo | URL) => {
  const p = String(url)
  const group = new URL(p, 'http://fixture.invalid').searchParams.get('group') ?? 'items'
  const payload = /\/chat(?:\?|$)/.test(p) ? { busy: false, queued: 0, responding: false,
      last_error: null, messages: [], live: [], draft_epoch: 0, mail_pending: 0, pending_mail: [] }
    : /\/work-items-page/.test(p) ? { format: 'orgtree.work-page/v1', group: 'items', rows: group === 'items' ? rows : [],
      total: rows.length, totals: { items: rows.length, archived: 0, backlogged: 0 }, matched: { items: rows.length, archived: 0, backlogged: 0 },
      counts: { active: 3, attention: 0, archived: 0, backlogged: 0 }, assigned_count: 0, next_offset: null, revision: 'r1', at: '2026-10-19T12:00:00.000Z' }
    : /\/work-items/.test(p) ? { items: [], archived: [], backlogged: [], references: [], attention: [],
      counts: { attention: 0, active: 0, archived: 0, backlogged: 0 } }
    : /\/nodes\/inner\/inbox/.test(p) ? { pending: [waiting], delivered: [held], sent: [] }
    : /\/inbox/.test(p) ? { pending: [], delivered: [], sent: [] }
    : /\/transfers/.test(p) ? { transfers: [], next_cursor: null } : { ok: true }
  return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } })
}) as typeof fetch

const noop = () => {}
const op: OpFn = async () => ({}) as never
const refs = { world: { org: 'org' }, onOpen: noop } as never

const node = (id: string, parent: string, extra: Record<string, unknown> = {}) => ({ id, parent, tier: 'sonnet', state: 'live',
  generation: 0, busy: false, children: [], seat: 1, grant: 0, free: 0, scope: { tools: {}, add_dirs: [] }, turns: [],
  audiences_held: [], documents: [], ...extra }) as unknown as CanvasNode
const proj = (id: string, parent: string, children: CanvasNode[], extra: Record<string, unknown> = {}) => ({ id, title: id, parent,
  tier: 'project', kind: 'project', state: 'live', model_id: '', seat: 0, grant: 0, free: 0, scope: { tools: {}, add_dirs: [] },
  configured_scope: { tools: {}, add_dirs: [] }, charter: '# The docs site\n\nShip the **docs** from `main` only.', children,
  lineage: [], turns: [], audiences_held: [], mail_pending: 1, mail_held: 1, dead_letters: 0, documents: [], documents_count: 0,
  last_status: null, occupancy: 0, context_window: 0, busy: false, activity: null, ...extra }) as unknown as CanvasNode

const dev2 = node('dev2', 'ui', { tier: 'haiku' })
const old = node('old', 'ui', { state: 'archived' })
const ui = proj('ui', 'inner', [dev2, old], { mail_pending: 0, mail_held: 0 })
const dev1 = node('dev1', 'inner', { tier: 'opus', busy: true })
const gone = node('gone', 'inner', { state: 'archived', tier: 'sol' })
const inner = proj('inner', 'outer', [dev1, ui, gone])
const outer = proj('outer', 'boss', [inner], { mail_pending: 0, mail_held: 0 })
const boss = node('boss', USER, { tier: 'opus', children: [outer], mail_pending: 1,
  last_status: { status: 'working', summary: 'Coordinating the docs project.' } })
const eye = { id: USER, parent: null, tier: null, state: 'user', children: [boss] } as unknown as CanvasNode
const map = new Map<string, CanvasNode>()
const add = (n: CanvasNode) => { map.set(n.id, n); for (const c of n.children ?? []) add(c as CanvasNode) }
add(eye)
const tree = { slug: 'org', name: 'Fixture', epoch: 1, rev: 1, roots: [boss], watchdogs: [
  { id: 'dev1/mail', owner: 'dev1', name: 'mail', kind: 'fair_queue', target: 'inner', interval_s: 5, state: 'armed',
    at: '2026-10-19T09:00:00.000Z', fired: 1, once: false, spent: false }], slot_leases: [],
  work_items_summary: { attention: 0, active: 0 }, user_inbox_count: 0, user_inbox_urgent_count: 0,
  asks: [], asks_open: 0, max_top_grant: 1000 } as unknown as TreePayload

function Surface() {
  const [inboxWindow, setInboxWindow] = useState(false)
  useEffect(() => {
    Object.assign(window, { deskParityVisual: {
      inboxWindow: (v: boolean) => setInboxWindow(v),
      hasInboxWindow: () => typeof ProjectInboxModal === 'function',
      contrast: (light: boolean) => {
        document.documentElement.classList.toggle('contrast-light', light)
        document.documentElement.classList.toggle('contrast-charcoal', !light)
      } } })
  }, [])
  return <CurrentOrg.Provider value="org">
    <DeskHosts map={map} slug="org" treeSlug="org">
      <DeskDogsProvider value={{ dogs: [], slotLeases: [], open: noop }}>
        <div style={{ display: 'flex', gap: 10, padding: 8, alignItems: 'flex-start' }}>
          <div style={{ width: 470, height: 660, display: 'flex' }} data-fixture="agent-desk">
            <DeskSlot node={map.get('boss')!} map={map} slug="org" op={op} toast={noop} bare onJump={noop} />
          </div>
          <div style={{ width: 500, height: 660, display: 'flex' }} data-fixture="project-desk">
            <ProjectDesk node={map.get('inner')!} slug="org" tree={tree} map={map} op={op} toast={noop} refs={refs} bare onJump={noop} />
          </div>
        </div>
        {inboxWindow && ProjectInboxModal && <ProjectInboxModal node={map.get('inner')!} slug="org" tree={tree} map={map} op={op}
          toast={noop} refs={refs} close={() => setInboxWindow(false)} />}
      </DeskDogsProvider>
    </DeskHosts>
  </CurrentOrg.Provider>
}
document.body.style.background = 'var(--bg)'
createRoot(document.getElementById('root')!).render(<Surface />)
