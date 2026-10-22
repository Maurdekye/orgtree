// ticketmention.visual.tsx — captures for docket
// mention-entry-on-ticket-cards-in-transcripts-ins (USER 2026-10-21 19:12:54Z,
// 2026-10-22 18:15:39Z, 18:16:44Z): an agent desk whose transcript names a
// ticket, its shared ticket menu with Mention first, the reference Mention puts
// in the message box, and the @ list offering tickets beside agents. The desk,
// its transcript chip and the object menu are the app's own; browser-only
// fixture data, no engine, bridge or live org.
import { useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { DeskHosts, DeskSlot } from '../src/canvas/deskhosts'
import { DeskDogsProvider } from '../src/canvas/deskdogs'
import { AgentNavProvider, useProvideAgentNav } from '../src/canvas/agentnav'
import { ObjectNavProvider } from '../src/canvas/objectnav'
import { ObjectNavHost } from '../src/canvas/objectnavhost'
import { ObjectMenuBoundary } from '../src/canvas/contextmenu'
import { CurrentOrg } from '../src/popout'
import { USER } from '../src/canvas/shared'
import type { CanvasNode, OpFn } from '../src/canvas/shared'
import '../src/styles.css'

const ticket = (slug: string, title: string, status: string) => ({
  slug, rev: 1, kind: 'code', title, objective: title, status, blocked_reason: null,
  archived: false, archived_at: null, owner: { node: 'dev1', generation: 0 }, owner_current: true, owner_state: 'live',
  reviewer: null, participants: [], created_by: { node: 'boss', generation: 0 }, at: '2026-10-22T08:00:00.000Z',
  updated_at: '2026-10-22T09:00:00.000Z', done_so_far: [], working_on_next: [], docket_at: '2026-10-22T09:00:00.000Z',
  last_updater: { node: 'dev1', generation: 0 }, manual_attention: null, dismissals: [], questions: [], effective_attention: false,
  attention_sources: [], acceptance: [], dependencies: [], evidence: [], delivery: null, accepted: null, superseded_by: null, history: [],
})
const items = [ticket('build-the-docs', 'Build the docs site from main', 'in_progress'),
  ticket('review-the-docs', 'Review the docs before release', 'review')]
const backlogged = [ticket('backlog-cleanup', 'Clean up the backlog labels', 'backlogged')]
const groups: Record<string, ReturnType<typeof ticket>[]> = { items, backlogged }
const all = [...items, ...backlogged]
const message = { role: 'assistant', seq: 0, event_id: 'r-1', at: '2026-10-22T09:05:00.000Z',
  text: 'The docs work is tracked in @item:org/build-the-docs. I will report there.' }

window.fetch = (async (url: RequestInfo | URL) => {
  const p = String(url)
  const u = new URL(p, 'http://fixture.invalid')
  const group = u.searchParams.get('group') ?? 'items'
  const query = (u.searchParams.get('query') ?? '').toLowerCase()
  const rows = (groups[group] ?? []).filter(r => !query || `${r.slug}\n${r.title}`.toLowerCase().includes(query))
  const payload = /\/chat(?:\?|$)/.test(p) ? { busy: false, queued: 0, responding: false, last_error: null,
      messages: [message], live: [], draft_epoch: 'fixture:0', mail_pending: 0, pending_mail: [] }
    : /\/work-items-page/.test(p) ? { format: 'orgtree.work-page/v1', group, rows, total: rows.length,
      totals: { items: 2, archived: 0, backlogged: 1 }, matched: { items: 2, archived: 0, backlogged: 1 },
      counts: { active: 2, attention: 0, archived: 0, backlogged: 1 }, assigned_count: 0, next_offset: null,
      revision: 'r1', at: '2026-10-22T10:00:00.000Z' }
    : /\/work-item-references/.test(p) ? { references: all.filter(r => (u.searchParams.get('names') ?? '').split(',').includes(r.slug))
      .map(({ slug, title, status }) => ({ slug, title, status, parent: null, archived: false, rev: 1 })) }
    : /\/work-items\/[^/?]+$/.test(u.pathname) ? { item: all.find(r => r.slug === u.pathname.split('/').pop()) }
    : /\/work-items/.test(p) ? { items, archived: [], backlogged, references: [], attention: [],
      counts: { attention: 0, active: 2, archived: 0, backlogged: 1 } }
    : /\/inbox/.test(p) ? { pending: [], delivered: [], sent: [] }
    : /\/transfers/.test(p) ? { transfers: [], next_cursor: null }
    : /\/history(?:\?|$)/.test(p) ? { items: [] } : { ok: true }
  return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } })
}) as typeof fetch

const noop = () => {}
const op: OpFn = async () => ({}) as never
const node = (id: string, parent: string, extra: Record<string, unknown> = {}) => ({ id, title: id, parent, tier: 'sonnet',
  state: 'live', generation: 0, busy: false, children: [], seat: 1, grant: 0, free: 0, scope: { tools: {}, add_dirs: [] },
  turns: [], audiences_held: [], documents: [], ...extra }) as unknown as CanvasNode
const dev1 = node('dev1', 'boss', { tier: 'opus' })
const bram = node('bram', 'boss', { tier: 'haiku' })
const boss = node('boss', USER, { tier: 'sol', children: [dev1, bram],
  last_status: { status: 'working', summary: 'Coordinating the docs project.' } })
const eye = { id: USER, parent: null, tier: null, state: 'user', children: [boss] } as unknown as CanvasNode
const map = new Map<string, CanvasNode>()
const add = (n: CanvasNode) => { map.set(n.id, n); for (const c of n.children ?? []) add(c as CanvasNode) }
add(eye)

function AgentMenus() {
  useProvideAgentNav(() => [{ label: 'Focus', onSelect: noop }])
  return null
}

function Surface() {
  useEffect(() => {
    Object.assign(window, { ticketMentionVisual: {
      contrast: (light: boolean) => {
        document.documentElement.classList.toggle('contrast-light', light)
        document.documentElement.classList.toggle('contrast-charcoal', !light)
      } } })
  }, [])
  return <CurrentOrg.Provider value="org">
    <AgentNavProvider><ObjectNavProvider><AgentMenus />
      <ObjectNavHost org="org" dogs={[]} openDog={noop} openTicket={noop} toast={noop} />
      <ObjectMenuBoundary>
        <DeskHosts map={map} slug="org" treeSlug="org">
          <DeskDogsProvider value={{ dogs: [], slotLeases: [], open: noop }}>
            <div style={{ width: 640, height: 560, display: 'flex', padding: 8 }} data-fixture="agent-desk">
              <DeskSlot node={boss} map={map} slug="org" op={op} toast={noop} bare onJump={noop} onWorkLink={noop} />
            </div>
          </DeskDogsProvider>
        </DeskHosts>
      </ObjectMenuBoundary>
    </ObjectNavProvider></AgentNavProvider>
  </CurrentOrg.Provider>
}
document.body.style.background = 'var(--bg)'
document.body.style.margin = '0'
createRoot(document.getElementById('root')!).render(<Surface />)
