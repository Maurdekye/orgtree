// presentedwidth.visual.tsx — captures for the Presented screen addition
// (docket 4-5-0-presentations-identified-by-a-readable-slu, @coordinator-opus
// md743332e2d26): the list column stops at 400px so a maximised window gives
// the presentation the room (USER 2026-10-27 mb56fc243d55d), and the HTML card's
// chip reads "</> HTML" (mbebb35945cb1). Both surfaces of the one gallery rule:
// an agent's Presented view (the desk's Presented tab, and the body of the
// agent's Presented window) filling the window as a desk or a popped-out
// window across the screen does, and the Presented documents window in its
// centred place. The components and styles are the app's own; the engine's
// reads are answered here from synthetic presentations.
// Browser-only fixture data: no engine, bridge or live org. The capture
// replaces the page's clipboard before anything renders.
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { AgentGalleryView, DocGalleryModal } from '../src/canvas/gallery'
import type { DocRow } from '../src/api'
import '../src/styles.css'
import '../src/shell.css'

const SLUG = 'synthetic-presentations'
const AT = Date.UTC(2026, 9, 27, 9)
const card = (i: number) => `<div class="card"><span>Metric ${i}</span><b>${(i * 37) % 100}%</b><div class="bar"><i style="width:${(i * 37) % 100}%"></i></div></div>`
const DASHBOARD = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Release dashboard</title><style>
body{margin:0;font:14px system-ui,sans-serif;background:#f4f6fa;color:#1d2433}
.board{width:1600px;padding:24px;box-sizing:border-box}h1{margin:0 0 16px;font-size:28px}
.cards{display:grid;grid-template-columns:repeat(6,1fr);gap:16px}
.card{background:#fff;border-radius:10px;padding:16px;box-shadow:0 1px 3px rgba(0,0,0,.15)}
.card b{display:block;font-size:30px;margin-top:6px}.bar{height:12px;background:#dde3ee;border-radius:6px;margin-top:10px}
.bar i{display:block;height:100%;border-radius:6px;background:#3b6fe0}
.edge{margin-top:18px;display:flex;justify-content:space-between;font-weight:700;color:#b42318}
</style></head><body><div class="board"><h1>Release dashboard, 1600 px wide</h1>
<div class="cards">${[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(card).join('')}</div>
<div class="edge"><span>&#9664; left edge</span><span>right edge &#9654;</span></div></div></body></html>`

// newest first; two are unread
const DOCS: { id: string; title: string; format: 'markdown' | 'html'; hours: number; read: boolean }[] = [
  { id: 'release-dashboard', title: 'Release dashboard', format: 'html', hours: 0, read: true },
  { id: 'weekly-status-week-44', title: 'Weekly status, week 44', format: 'markdown', hours: 2, read: false },
  { id: 'q4-roadmap', title: 'Q4 roadmap: hiring, budget and the platform migration', format: 'markdown', hours: 5, read: true },
  { id: 'pricing-experiment', title: 'Pricing experiment results', format: 'html', hours: 9, read: false },
  { id: 'incident-review-login-outage', title: 'Incident review: the login outage of 26 October', format: 'markdown', hours: 20, read: true },
  { id: 'onboarding-checklist', title: 'Onboarding checklist', format: 'markdown', hours: 30, read: true },
  { id: 'design-review-desk-view', title: 'Design review: desk view', format: 'html', hours: 44, read: true },
  { id: 'retrospective-4-4-5', title: 'Retrospective: 4.4.5', format: 'markdown', hours: 70, read: true },
]
const iso = (hours: number) => new Date(AT - hours * 3600e3).toISOString()
const body = (d: typeof DOCS[number]) => d.format === 'html' ? DASHBOARD.replace('Release dashboard', d.title)
  : `# ${d.title}\n\nA synthetic presentation for this capture.\n`
const rows: DocRow[] = DOCS.map((d) => ({ id: d.id, node: 'writer', presented_by: 'writer', title: d.title, at: iso(d.hours),
  viewed_at: d.read ? iso(d.hours) : null, format: d.format, bytes: new TextEncoder().encode(body(d)).length,
  evicted: false, node_state: 'live', tier: 'sol' }))

const lookups: string[] = []
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
window.fetch = (async (url: RequestInfo | URL) => {
  const u = new URL(String(url), 'http://fixture.invalid')
  lookups.push(u.pathname + u.search)
  const prefix = `/api/orgs/${SLUG}/documents`
  if (u.pathname === prefix) {
    return json({ documents: rows, total: rows.length, next_offset: null, offset: 0,
      ...(u.searchParams.has('opening') ? { opening_id: 'release-dashboard', opening_position: 0 } : {}) })
  }
  if (u.pathname === prefix + '/viewed') return json({ ok: true })
  const mockup = u.pathname.match(/\/documents\/([^/]+)\/mockup$/)
  const one = u.pathname.match(/\/documents\/([^/]+)$/)
  const doc = DOCS.find((d) => d.id === decodeURIComponent((mockup ?? one)?.[1] ?? ''))
  if (mockup && doc?.format === 'html') return new Response(body(doc), { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } })
  if (one && doc) {
    return json({ id: doc.id, node: 'writer', presented_by: 'writer', title: doc.title, body: body(doc), at: iso(doc.hours),
      format: doc.format, bytes: new TextEncoder().encode(body(doc)).length, viewed_at: iso(doc.hours) })
  }
  return json({ detail: 'not in this fixture' }, 404)
}) as typeof fetch

function Fixture() {
  const [view, setView] = useState<'agent' | 'modal'>('agent')
  const [mount, setMount] = useState(0)
  ;(window as unknown as { presentedWidthVisual: unknown }).presentedWidthVisual = {
    /** a fresh opening of one surface */
    show: (next: 'agent' | 'modal') => { setView(next); setMount((n) => n + 1) },
    lookups: () => lookups,
  }
  return view === 'agent'
    ? <div data-fixture="agent" key={mount} style={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column', background: 'var(--bg)' }}>
        <AgentGalleryView slug={SLUG} nid="writer" toast={() => {}} />
      </div>
    : <div data-fixture="modal" key={mount}><DocGalleryModal slug={SLUG} toast={() => {}} close={() => {}} /></div>
}

createRoot(document.getElementById('root')!).render(<Fixture />)
