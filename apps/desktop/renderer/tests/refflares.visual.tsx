// refflares.visual.tsx — the capture for @item:orgtree/4-5-0-ticket-and-presentation-chips-show-full-ti (USER
// 2026-10-27 m43beb8089dd4, m3eb804e5023a, m919f12828686, mc1c4ab23c4bf): an agent desk whose transcript mentions
// tickets in six statuses and presentations unread, modified since read and read, an orgtree_work tool row's ticket
// chip, three orgtree_present cards and the desk's presentation badges; beside it a docket description naming
// tickets as plain words, an idle-docket reminder card and an agent's Presented list. The surfaces are the app's
// own; browser-only fixture data, no engine, bridge or live org. tools/rig/refflares-visual.mjs captures it in
// every visual theme and contrast.
import { useEffect, useMemo } from 'react'
import { createRoot } from 'react-dom/client'
import { DeskHosts, DeskSlot } from '../src/canvas/deskhosts'
import { DeskDogsProvider } from '../src/canvas/deskdogs'
import { AgentNavProvider, useProvideAgentNav } from '../src/canvas/agentnav'
import { ObjectNavProvider } from '../src/canvas/objectnav'
import { ObjectNavHost } from '../src/canvas/objectnavhost'
import { ObjectMenuBoundary } from '../src/canvas/contextmenu'
import { DocketDescription } from '../src/canvas/docketdesc'
import { buildMentionIndex } from '../src/canvas/workrefs'
import { IdleDocketCards } from '../src/events/idledocket'
import { useRefRoutes } from '../src/canvas/reflinks'
import { AgentGalleryView } from '../src/canvas/gallery'
import { CurrentOrg } from '../src/popout'
import { USER } from '../src/canvas/shared'
import { applyTheme, THEMES } from '../src/themes'
import { applyContrast } from '../src/contrast'
import { CONTRAST_THEMES } from '../../../../packages/contracts/contrast-theme'
import type { CanvasNode, OpFn } from '../src/canvas/shared'
import '../src/styles.css'

const AT = '2026-10-27T10:00:00.000Z', EARLIER = '2026-10-27T09:00:00.000Z'
export const TICKETS = [
  { slug: 'build-docs', title: 'Build the docs site from main', status: 'in_progress' },
  { slug: 'fix-login', title: 'Fix the login redirect', status: 'blocked' },
  { slug: 'review-copy', title: 'Review the onboarding copy', status: 'review' },
  { slug: 'plan-q4', title: 'Plan the Q4 roadmap', status: 'open' },
  { slug: 'park-idea', title: 'Park the theming idea', status: 'backlogged' },
  { slug: 'ship-it', title: 'Ship the release', status: 'done' },
]
/** never opened; replaced since it was opened; opened at its current version */
export const DOCS = [
  { id: 'launch-plan', title: 'Launch plan', at: AT, viewed_at: null as string | null },
  { id: 'release-notes', title: 'Release notes', at: AT, viewed_at: EARLIER as string | null },
  { id: 'old-notes', title: 'Old notes', at: EARLIER, viewed_at: EARLIER as string | null },
]
/** the Presented list's own: its oldest unread opens by itself, the other two keep their flares */
const GALLERY = [
  { id: 'g-read', title: 'Read summary', at: AT, viewed_at: AT as string | null },
  { id: 'g-opened', title: 'Opened first', at: '2026-10-27T08:00:00.000Z', viewed_at: null as string | null },
  { id: 'g-updated', title: 'Updated metrics', at: AT, viewed_at: EARLIER as string | null },
  { id: 'g-new', title: 'New budget', at: '2026-10-27T11:00:00.000Z', viewed_at: null as string | null },
]
const text = 'Status: @item:org/build-docs, @item:org/fix-login, @item:org/review-copy, @item:org/plan-q4, '
  + '@item:org/park-idea and @item:org/ship-it. Read @doc:org/launch-plan, @doc:org/release-notes and @doc:org/old-notes.'
const work = { id: 'w-1', name: 'mcp__orgtree__orgtree_work', arg: 'update build-docs', result: '{}',
  started_at: '2026-10-27T09:04:00.000Z', ended_at: '2026-10-27T09:04:00.050Z',
  refs: [{ kind: 'ticket', id: 'build-docs', status_change: { from: 'open', to: 'in_progress' } }] }
const present = (id: string, title: string, n: number) => ({ id: 'p-' + n, name: 'mcp__orgtree__orgtree_present', arg: title,
  result: 'Presented', started_at: '2026-10-27T09:05:00.000Z', ended_at: '2026-10-27T09:05:00.040Z', presentation: { id, title } })
const messages = [
  { role: 'assistant', seq: 1, event_id: 'r-1', at: '2026-10-27T09:03:00.000Z', text },
  { role: 'assistant', seq: 2, event_id: 'r-2', at: '2026-10-27T09:05:00.000Z', text: 'Updated the ticket and presented three documents.',
    tools: [work, present('launch-plan', 'Launch plan', 1), present('release-notes', 'Release notes', 2), present('old-notes', 'Old notes', 3)] },
]

const json = (payload: unknown) => new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } })
window.fetch = (async (url: RequestInfo | URL) => {
  const p = String(url), u = new URL(p, 'http://fixture.invalid')
  if (/\/work-item-references$/.test(u.pathname)) {
    const names = (u.searchParams.get('names') ?? '').split(',')
    return json({ references: TICKETS.filter(x => names.includes(x.slug)).map(x => ({ ...x, parent: null, archived: false, rev: 1 })) })
  }
  const item = u.pathname.match(/\/work-items\/([^/]+)$/)
  if (item) return json({ item: TICKETS.find(x => x.slug === decodeURIComponent(item[1]!)) ?? null })
  if (/\/work-items/.test(p)) return json({ items: [], archived: [], backlogged: [], references: [], attention: [],
    counts: { attention: 0, active: 0, archived: 0, backlogged: 0 } })
  if (/\/documents\/viewed$/.test(u.pathname)) return json({ ok: true })
  const one = u.pathname.match(/\/documents\/([^/]+)$/)
  if (one) {
    const d = [...DOCS, ...GALLERY].find(x => x.id === decodeURIComponent(one[1]!))
    return d ? json({ ...d, node: 'writer', format: 'markdown', body: `# ${d.title}\n\nSynthetic body.` }) : json({ detail: 'gone' })
  }
  if (u.pathname.endsWith('/documents')) {
    const refs = u.searchParams.get('refs')
    if (refs !== null) return json({ refs: refs.split(',').flatMap(ref => DOCS.filter(d => d.id === ref)
      .map(d => ({ ref, id: d.id, title: d.title, format: 'markdown', at: d.at, viewed_at: d.viewed_at }))) })
    return json({ documents: GALLERY.map(d => ({ ...d, node: 'curator', evicted: false, node_state: 'live', tier: 'sol', format: 'markdown' })),
      total: GALLERY.length, offset: 0, next_offset: null })
  }
  const payload = /\/chat(?:\?|$)/.test(p) ? { busy: false, queued: 0, responding: false, last_error: null,
      messages, live: [], draft_epoch: 'fixture:0', mail_pending: 0, pending_mail: [] }
    : /\/apps$/.test(u.pathname) ? { kind: 'apps', items: [], next_cursor: null, new_count: 0, apps: [], panels: [] }
    : /\/inbox/.test(p) ? { pending: [], delivered: [], sent: [] }
    : /\/transfers/.test(p) ? { transfers: [], next_cursor: null }
    : /\/history(?:\?|$)/.test(p) ? { items: [] } : { ok: true }
  return json(payload)
}) as typeof fetch

const noop = () => {}
const op: OpFn = async () => ({}) as never
const node = (id: string, parent: string, extra: Record<string, unknown> = {}) => ({ id, title: id, parent, tier: 'sonnet',
  state: 'live', generation: 0, busy: false, children: [], seat: 1, grant: 0, free: 0, scope: { tools: {}, add_dirs: [] },
  turns: [], audiences_held: [], documents: [], ...extra }) as unknown as CanvasNode
const writer = node('writer', USER, { tier: 'sol', documents_count: 3, documents: DOCS.map(d => ({ ...d, format: 'markdown' })),
  last_status: { status: 'working', summary: 'Presenting the release documents.' } })
const curator = node('curator', USER, { tier: 'sol' })
const eye = { id: USER, parent: null, tier: null, state: 'user', children: [writer, curator] } as unknown as CanvasNode
const map = new Map<string, CanvasNode>()
const add = (n: CanvasNode) => { map.set(n.id, n); for (const c of n.children ?? []) add(c as CanvasNode) }
add(eye)
const index = buildMentionIndex(TICKETS)
const reminder = { v: 1, variant: 'reminder.idle_docket', actor: { kind: 'system', id: 'engine' }, engine_authored: true,
  object: { kind: 'node', org: 'org', id: 'writer' }, more: 0,
  items: [{ slug: 'fix-login', title: 'Fix the login redirect', status: 'blocked', role: 'owner' }] }

/** the reminder card as a desk draws it: with the desk's references, so its link is a live mention */
function ReminderCard() {
  const agents = useMemo(() => new Map<string, unknown>([['writer', writer]]), [])
  const refs = useRefRoutes('org', agents, { onOpenItem: noop })
  return <IdleDocketCards event={reminder as never} org="org" world={refs.world} onOpen={refs.onOpen} />
}

function AgentMenus() {
  useProvideAgentNav(() => [{ label: 'Focus', onSelect: noop }])
  return null
}

function Surface() {
  useEffect(() => {
    Object.assign(window, { refFlaresVisual: {
      themes: Object.keys(THEMES), contrasts: [...CONTRAST_THEMES],
      labels: Object.fromEntries(Object.entries(THEMES).map(([id, t]) => [id, t.label])),
      apply: (visual: string, contrast: string) => { applyTheme(visual); applyContrast(contrast) },
    } })
  }, [])
  return <CurrentOrg.Provider value="org">
    <AgentNavProvider><ObjectNavProvider><AgentMenus />
      <ObjectNavHost org="org" dogs={[]} openDog={noop} openTicket={noop} openDocument={noop} toast={noop} />
      <ObjectMenuBoundary>
        {/* Session 0's display is 1024 px wide, and a window is clamped to it */}
        <div style={{ display: 'grid', gridTemplateColumns: '600px 392px', gap: 8, padding: 8, alignItems: 'start' }}>
          <DeskHosts map={map} slug="org" treeSlug="org">
            <DeskDogsProvider value={{ dogs: [], slotLeases: [], open: noop }}>
              <div style={{ width: 600, height: 640, display: 'flex' }} data-fixture="agent-desk">
                <DeskSlot node={writer} map={map} slug="org" op={op} toast={noop} bare onJump={noop} onWorkLink={noop} onOpenDoc={noop} />
              </div>
            </DeskDogsProvider>
          </DeskHosts>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div className="docket-modal" data-fixture="docket-desc" style={{ padding: 10, border: '1px solid var(--line)', borderRadius: 8, background: 'var(--panel)' }}>
              <DocketDescription slug="this-item" world={{ org: 'org' }} index={index} onPick={noop}
                text={'Blocked behind fix-login and review-copy; build-docs is already moving.'} />
            </div>
            <div data-fixture="idle-card" style={{ padding: 10, border: '1px solid var(--line)', borderRadius: 8, background: 'var(--panel)' }}>
              <ReminderCard />
            </div>
            <div data-fixture="gallery" style={{ height: 300, display: 'flex', border: '1px solid var(--line)', borderRadius: 8, overflow: 'hidden' }}>
              <AgentGalleryView slug="org" nid="curator" node={curator as never} toast={noop} />
            </div>
          </div>
        </div>
      </ObjectMenuBoundary>
    </ObjectNavProvider></AgentNavProvider>
  </CurrentOrg.Provider>
}
document.body.style.background = 'var(--bg)'
document.body.style.margin = '0'
createRoot(document.getElementById('root')!).render(<Surface />)
