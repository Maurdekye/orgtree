// tests/s6symmetry.visual.tsx — what s6symmetry.capture.cjs draws for UX
// symmetry S6 (@item:orgtree/symmetry-fixes-s6-kimi-k3-1-pro-trial-docket-esc):
// C1 the centred agent docket's search and Escape (#19), C2 a pinned custom
// app panel's move and resize under Escape (#20), C3 the Presentations
// gallery's history search (#21), C4 the multi-reply composer, the desk
// transcript's sent bubble and a sent mail preview (#37). No engine: each
// scene answers its own reads from synthetic data, with times relative to
// now. The same file draws the base (before) and the tip (after), so it
// imports only what both have.
import '../src/styles.css'
import '../src/shell.css'
import { createRoot } from 'react-dom/client'
import { AgentDocketModal } from '../src/canvas/agentdocket'
import { AppsWorkspace } from '../src/canvas/apps/ui'
import { DocGalleryModal } from '../src/canvas/gallery'
import { DeskChat } from '../src/canvas/desk'
import { MailReplyPreview } from '../src/canvas/mailreply'
import { draftKey } from '../src/draftstore'
import { readReplies, storeReplies } from '../src/eventReply'
import { compatibilityWorkFixture } from './workcompat.fixture'
import type { CanvasNode } from '../src/canvas/shared'
import type { TreePayload, WorkItem } from '../src/types'

const SLUG = 's6-fixture'
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR
const ago = (ms: number) => new Date(Date.now() - ms).toISOString()
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const reads: string[] = []
const noop = () => {}
const root = createRoot(document.getElementById('root')!)
let closed = 0
const closeSurface = () => {
  closed++
  root.render(<div className="sym-closed" style={{ padding: 40, color: 'var(--dim)' }}>the surface closed</div>)
}

// C1: four tickets of one agent, two of them "rel"
const item = (slug: string, title: string, at: number): WorkItem => ({
  slug, rev: 1, kind: 'code', title, objective: title + '.', status: 'in_progress', blocked_reason: null,
  archived: false, archived_at: null, owner: { node: 'worker', generation: 1 }, owner_current: true, owner_state: 'live',
  reviewer: null, participants: [], created_by: { node: 'worker', generation: 1 }, at: ago(at + HOUR),
  updated_at: ago(at), docket_at: ago(at), status_at: ago(at), done_so_far: [], working_on_next: [],
  last_updater: { node: 'worker', generation: 1 }, manual_attention: null, dismissals: [], questions: [],
  effective_attention: false, attention_sources: [], acceptance: [], dependencies: [], evidence: [], delivery: null,
  accepted: null, superseded_by: null, history: [],
} as unknown as WorkItem)
const ITEMS = [item('release-notes', 'Release notes for 4.5.2', 30 * MIN), item('relay-config', 'Relay config cleanup', 2 * HOUR),
  item('fix-login', 'Fix login', 5 * HOUR), item('add-search', 'Add search bar', 2 * DAY)]
const TREE = { slug: SLUG, roots: [{ id: 'worker', state: 'live', tier: 'sol', generation: 1, children: [] }],
  tiers: { sol: 1 } } as unknown as TreePayload
const workAnswer = (u: URL, items: WorkItem[]): Response | null => {
  if (/\/work-items\/[^/]+$/.test(u.pathname)) return json({ item: items.find((i) => i.slug === u.pathname.split('/').pop()) })
  if (/\/work-items(?:-view)?$/.test(u.pathname)) {
    return json({ items, references: items.map(({ slug, title, archived, status, rev }) => ({ slug, title, archived, status, rev })),
      attention: [], archived: [], backlogged: [], counts: { attention: 0, active: items.length, archived: 0, backlogged: 0 },
      now: new Date().toISOString() })
  }
  if (/\/reader-availability$/.test(u.pathname)) return json({ work: { own: true, team: false }, presented: { own: false, team: false } })
  return null
}
const docketFetch = compatibilityWorkFixture(((raw: RequestInfo | URL) => {
  const u = new URL(String(raw), 'http://local')
  reads.push(u.pathname + u.search)
  return Promise.resolve(workAnswer(u, ITEMS) ?? json({}))
}) as typeof fetch)

// C2: one app, one panel pinned as a window (customapps-pinrelease.test.tsx's)
const APP = { id: 'notes', name: 'Notes', description: 'Saved notes', rev: 1, permission_rev: 1, width: 360, height: 280,
  capabilities: [], permissions: {}, created_by: 'maker', updated_at: '',
  definition: { name: 'Notes', description: '', html: '<p>Notes</p>', initial_state: {}, capabilities: [], width: 360, height: 280 } }
const PLACED = { mode: 'window', x: 120, y: 80, width: 400, height: 300 }
const newPanel = () => ({ id: 'one', app: 'notes', label: 'Panel 1', rev: 1, open: true, running: true, state: {}, event_seq: 0,
  placement: { ...PLACED }, used_at: ago(MIN), updated_at: '', created_at: ago(DAY) })
let panel = newPanel()
const appCalls: Record<string, unknown>[] = []
const appsFetch = (async (raw: RequestInfo | URL, init?: RequestInit) => {
  const u = new URL(String(raw), 'http://local')
  reads.push(u.pathname + u.search)
  if (!u.pathname.endsWith('/apps')) return json({})
  const input = init?.method === 'POST' ? JSON.parse(String(init.body)) : JSON.parse(u.searchParams.get('request') ?? '{}')
  appCalls.push(input)
  if (input.action === 'list') return json({ items: input.kind === 'apps' ? [APP] : [JSON.parse(JSON.stringify(panel))], next_cursor: null, new_count: 0 })
  if (input.action === 'app_get') return json(APP)
  if (input.action === 'panel_get') return json(panel)
  if (input.action === 'events') return json({ events: [], next_cursor: null, oldest_retained: null })
  if (input.action === 'session_close' || input.action === 'runtime') return json({ items: [], next_cursor: null })
  if (input.action === 'panel_update') {
    for (const k of ['label', 'open', 'placement']) if (k in input) (panel as Record<string, unknown>)[k] = input[k]
    panel = { ...panel, rev: panel.rev + 1 }
    return json(panel)
  }
  return json({})
}) as typeof fetch

// C3: 130 presentations; the only "weekly" one sits far below the first page (40)
const DOCS = Array.from({ length: 130 }, (_, i) => ({ id: 'd' + i, node: 'coordinator', tier: 'opus',
  title: i === 95 ? 'Weekly digest of the hub' : `Presentation ${130 - i}`, at: ago(i * HOUR + 5 * MIN), evicted: false,
  node_state: 'live', format: 'markdown', bytes: 120 }))
const galleryFetch = (async (raw: RequestInfo | URL) => {
  const u = new URL(String(raw), 'http://local')
  reads.push(u.pathname + u.search)
  const doc = u.pathname.match(/\/documents\/([^/]+)$/)
  if (doc) {
    const d = DOCS.find((r) => r.id === decodeURIComponent(doc[1]!))
    return json({ ...d, body: `# ${d?.title}\n\nA synthetic presentation.` })
  }
  if (u.pathname.endsWith('/documents')) {
    const q = u.searchParams
    const terms = (q.get('search') ?? '').toLowerCase().split(/\s+/).filter(Boolean)
    const rows = DOCS.filter((r) => terms.every((t) => `${r.title} ${r.id}`.toLowerCase().includes(t)))
    const offset = Number(q.get('offset') ?? 0), limit = Number(q.get('limit') || 40), locate = q.get('locate') ?? ''
    return json({ documents: rows.slice(offset, offset + limit), total: rows.length, offset,
      next_offset: offset + limit < rows.length ? offset + limit : null, ...(locate ? { located: locate } : {}) })
  }
  return json({})
}) as typeof fetch

// C4: four stored reply targets in the composer, and a sent message answering four
const WRITER = { id: 'writer', generation: 2, state: 'live', tier: 'sol', children: [], seat: 1, grant: 0, free: 0,
  scope: { tools: {}, add_dirs: [] } } as unknown as CanvasNode
const DRAFT = draftKey(SLUG, 'writer', 2)
const wire = (n: number) => ({ source_event_ref: { org: SLUG, agent: 'writer', generation: 2, eventId: 'e' + n },
  quoted_context: 'Source message ' + n })
const CHAT = { busy: false, queued: 0, responding: false, last_error: null, occupancy: null, occupancy_estimated: false,
  messages: [...[1, 2, 3, 4].map((n) => ({ role: 'assistant', text: 'Source message ' + n, seq: n, event_id: 'e' + n, at: ago((9 - n) * MIN) })),
    { role: 'user', text: 'One answer for all four.', seq: 5, event_id: 'e5', at: ago(3 * MIN), replies: [1, 2, 3, 4].map(wire) }],
  live: [], draft_epoch: 's6-boot:0', mail_pending: 0, pending_mail: [] } // draft_epoch is "<boot>:<n>", as the engine sends
const deskFetch = compatibilityWorkFixture(((raw: RequestInfo | URL) => {
  const u = new URL(String(raw), 'http://local')
  reads.push(u.pathname + u.search)
  if (/\/chat$/.test(u.pathname)) return Promise.resolve(json(CHAT))
  // the rest as the test harness answers them (tests/harness.ts installFetch)
  if (/\/history$/.test(u.pathname)) return Promise.resolve(json({ items: [] }))
  if (/\/scratch$/.test(u.pathname)) return Promise.resolve(json({ path: '', entries: [] }))
  if (/\/mention-candidates$/.test(u.pathname)) return Promise.resolve(json({ items: [], next_cursor: null }))
  if (/\/documents$/.test(u.pathname)) return Promise.resolve(json({ documents: [], total: 0, next_offset: null }))
  return Promise.resolve(workAnswer(u, []) ?? json({ ok: true }))
}) as typeof fetch)

type Scene = 'docket' | 'pinned' | 'gallery' | 'composer' | 'sent'
let seq = 0
Object.assign(window, { s6Fixture: {
  reads, appCalls,
  closed: () => closed,
  placement: () => ({ ...panel.placement }),
  replies: () => readReplies(DRAFT).map((r) => r.eventId),
  show: (scene: Scene) => {
    localStorage.setItem('orgtree-contrast-theme', 'charcoal')
    document.documentElement.classList.remove('contrast-light')
    closed = 0
    const key = scene + ++seq
    if (scene === 'docket') {
      window.fetch = docketFetch
      root.render(<AgentDocketModal key={key} slug={SLUG} nid="worker" tree={TREE} toast={noop} close={closeSurface}
        refs={{ world: { org: SLUG }, onOpen: noop } as never} />)
    } else if (scene === 'pinned') {
      window.fetch = appsFetch
      panel = newPanel(); appCalls.length = 0
      root.render(<div key={key}>
        <div data-pin-org={SLUG} style={{ position: 'fixed', left: 0, top: 40, right: 0, bottom: 0, border: 0 }} />
        <AppsWorkspace slug={SLUG} />
      </div>)
    } else if (scene === 'gallery') {
      window.fetch = galleryFetch
      root.render(<DocGalleryModal key={key} slug={SLUG} toast={noop} close={closeSurface} />)
    } else if (scene === 'composer') {
      window.fetch = deskFetch
      storeReplies(DRAFT, [1, 2, 3, 4].map((n) => ({ org: SLUG, agent: 'writer', generation: 2, eventId: 'e' + n,
        quote: 'Source message ' + n, sender: 'writer' })))
      root.render(<div key={key} className="desk" style={{ position: 'fixed', inset: 24, display: 'flex', flexDirection: 'column',
        width: 'auto', height: 'auto', transform: 'none', background: 'var(--bg)' }}>
        <DeskChat node={WRITER} map={new Map([[WRITER.id, WRITER]])} slug={SLUG} op={async () => ({})} toast={noop} bare />
      </div>)
    } else {
      window.fetch = deskFetch
      root.render(<div key={key} className="settings" style={{ position: 'fixed', inset: 32, width: 'auto', height: 'auto' }}>
        <h3>A sent mail answering four messages</h3>
        <MailReplyPreview org={SLUG} row={{ replies: [1, 2, 3, 4].map((n) => ({ from: 'writer', gist: 'Retained sent quote ' + n })) }} />
      </div>)
    }
  },
} })
