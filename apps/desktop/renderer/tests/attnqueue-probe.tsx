// attnqueue-probe.tsx — the Attention view's entries beside the surfaces they
// are borrowed from, for `attnqueue_probe.py` to compare in a real browser
// (docket v3-attention-view-show-the-full-ticket-detail-vi).
//
// The same three entries — a flagged ticket, an urgent mail, an open question
// — are served to every scene, so a row or body in the Attention view can be
// compared, computed style for computed style, with the same row or body in
// its home surface:
//
//   #attention   the real OrgCanvas + AttentionView, as App composes them
//   #docket      the real DocketModal
//   #inbox       the real InboxPanel
//
// A `-<post>-<get>` suffix on #attention (e.g. #attention-200-300) delays the
// dismiss POST and every /work-items GET by that many milliseconds — a STUBBED
// server, stated as such — so dismissing can be timed click → row gone.
//
// Imports in main.tsx's order (App first, then styles.css, shell.css), so the
// cascade is the app's. No backend.
import { createRoot } from 'react-dom/client'
import '../src/App'
import '../src/styles.css'
import '../src/shell.css'
import { InboxPanel } from '../src/App'
import { OrgCanvas } from '../src/canvas/OrgCanvas'
import { DocketModal } from '../src/canvas/docket'
import { AttentionView } from '../src/attention/AttentionView'
import { setAttentionLayout, setOrgView } from '../src/attention/mode'
import { CurrentOrg } from '../src/popout'
import type { TreePayload } from '../src/types'

const SLUG = 'probe'
const NOW = '2026-09-29T21:00:00.000Z'
const scene = location.hash.replace(/^#/, '') || 'attention'
const [base, postMs, getMs] = scene.split('-')
const POST_MS = Number(postMs || 0), GET_MS = Number(getMs || 0)

const item = {
  slug: 'cutover', rev: 3, kind: 'code', title: 'Cut over the index to the new store',
  objective: 'The index still reads the old store.\n\nMove every read to the new one.',
  status: 'in_progress', blocked_reason: null, archived: false, archived_at: null,
  owner: { node: 'builder', generation: 0 }, owner_current: true, owner_state: 'live',
  reviewer: null, participants: [], created_by: { node: 'coordinator', generation: 0 },
  at: NOW, updated_at: NOW, done_so_far: ['moved the writes'], working_on_next: ['move the reads'],
  docket_at: NOW, last_updater: { node: 'builder', generation: 0 },
  manual_attention: { reason: 'confirm the cutover window before I flip it', at: NOW,
    by: { node: 'builder', generation: 0 }, set_rev: 3 },
  dismissals: [], questions: [], effective_attention: true, attention_sources: ['manual'],
  acceptance: [], dependencies: [], evidence: [], delivery: null, accepted: null,
  superseded_by: null, history: [], view: 'full',
}
let dismissed = false
const liveItem = () => (dismissed
  ? { ...item, manual_attention: null, effective_attention: false, attention_sources: [] }
  : item)
const urgent = {
  id: 'm1', from: 'reviewer', kind: 'message', at: '2026-09-29T20:30:00.000Z',
  body: 'The nightly build has been red for six hours. Should I revert the last merge?',
  urgent: true, urgent_reason: 'the build is down',
}
const ask = {
  id: 'q1', node: 'coordinator', status: 'open', at: '2026-09-29T20:00:00.000Z',
  kind: 'question', question: 'Ship the cutover tonight?',
  options: [{ label: 'Ship it', description: 'tonight at 22:00' }, { label: 'Hold' }],
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
;(window as unknown as { fetch: unknown }).fetch = async (url: string, init?: { method?: string }) => {
  const path = new URL(String(url), location.href).pathname
  const method = init?.method ?? 'GET'
  // the paged work-item routes answer "use the whole-list reader", exactly as
  // tests/workcompat.fixture.ts does for the unit suites
  if (/\/work-items-foreground$|\/work-item-references$/.test(path)) {
    return { status: 409, ok: false, headers: new Headers(),
      json: () => Promise.resolve({ kind: 'compatibility' }) }
  }
  if (/dismiss-attention$/.test(path)) { await wait(POST_MS); dismissed = true }
  if (/\/work-items(?:-view)?$/.test(path) && method === 'GET') await wait(GET_MS)
  const one = path.match(/\/work-items\/([^/]+)$/)
  const body = /\/work-items(?:-view)?$/.test(path)
    ? { items: [liveItem()], archived: [], backlogged: [],
        counts: { attention: dismissed ? 0 : 1, active: 1, archived: 0, backlogged: 0 } }
    : one ? { item: liveItem() }
      : /\/inbox$/.test(path) ? { pending: [urgent], delivered: [], sent: [] }
        : /\/providers$/.test(path) ? { providers: [] }
          : { ok: true }
  return {
    ok: true, status: 200, headers: new Headers(),
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  }
}

function mk(id: string, extra: Record<string, unknown> = {}): unknown {
  return {
    id, title: id, tier: 'opus', model_id: 'opus', state: 'live',
    seat: 1, grant: 10, free: 4, ui_order: 0, cost_usd: 0, occupancy: null,
    context_window: null, charter: null, mail_pending: 0, limit_locked: false,
    last_status: null, prev_status: null, inflight_at: null, last_denials: [],
    turns: [], frozen: null, audiences_held: [], bearer_state: null,
    generation: 0, children: [], lineage: [],
    scope: { permission_mode: 'default', add_dirs: [], tools: {}, org_visibility: 'team', effort: '' },
    ...extra,
  }
}
const tree = {
  slug: SLUG, name: SLUG, workspace: null, dirs: [], max_top_grant: 1000,
  default_top_grant: 50, compact_at: 0, default_tools: null,
  default_visibility: 'team', default_effort: 'medium', credit_requests: [],
  tiers: { haiku: 1, sonnet: 3, opus: 5, fable: 10 }, audiences: [],
  roots: [mk('coordinator', { ask }), mk('reviewer'), mk('builder')],
  cost_usd_total: 0,
  audit: { live_nodes: 3, top_level_holds: 0, no_overdraft: true, problems: [] },
  user_inbox_count: 1, user_inbox_newest: null, fable_lock: null,
  spend_frozen: false, storage_blocked: false, auto_resume: false,
  fable_limit_policy: 'freeze', fable_filter_policy: 'halt',
  cascade_hire: false, cascade_alloc: true, sandboxed: false,
  audience_requests: [], org_inbox: null, net: null,
  work_items_summary: { attention: 1, active: 1 }, asks: [ask], asks_open: 1,
  watchdogs: [],
} as unknown as TreePayload

const host = document.getElementById('root')!
const wrap = (child: React.ReactNode) => (
  <CurrentOrg.Provider value={SLUG}>
    <div className="app"><main className="solo">{child}</main></div>
  </CurrentOrg.Provider>)

if (base === 'docket') {
  createRoot(host).render(wrap(
    <DocketModal slug={SLUG} toast={() => {}} close={() => {}} tree={tree} />))
} else if (base === 'inbox') {
  createRoot(host).render(wrap(
    <InboxPanel slug={SLUG} tree={tree} toast={() => {}} close={() => {}} jumpTo={null} />))
} else {
  setOrgView(SLUG, 'attention')
  setAttentionLayout(SLUG, { split: 0.62, agent: 'coordinator', listOpen: false })
  createRoot(host).render(wrap(
    <div className="canvas-stage">
      <OrgCanvas tree={tree} op={() => Promise.resolve({} as never)}
        slug={SLUG} toast={() => {}} mailEvt={null} canvasContent="hidden"
        renderOrgSlot={(ctx) => (
          <AttentionView slug={ctx.slug} tree={ctx.tree} op={ctx.op}
            toast={ctx.toast} map={ctx.map} posOf={ctx.posOf}
            onOpenItem={ctx.onOpenItem} onFocusAgent={ctx.onFocusAgent}
            onOpenDoc={ctx.onOpenDoc} onOpenMail={ctx.onOpenMail}
            deskExtras={ctx.deskExtras}
            treeStatus={{ loading: false, failed: false, stale: false, unavailable: false,
              at: Date.now(), error: null }} />
        )} />
    </div>))
}
