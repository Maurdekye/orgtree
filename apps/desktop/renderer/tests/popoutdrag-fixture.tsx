// popoutdrag-fixture.tsx — the REAL panels the user named, each one ready to
// be popped out for real. The markup half of `popoutdrag_probe.py`.
//
// ⚠ WHY THE REAL PANELS AND NOT ONE STAND-IN. The defect was a property of
// the DOM the components produce: an unpinned `.modalpin-bar` is a button
// cluster with `margin-left: auto`, and the existing native probe missed it
// for a whole release because its bar was hand-written HTML that happened to
// contain a title. A fixture that hand-builds a panel could hide exactly the
// same way, so each panel here is the shipped component — DocketModal,
// UsageModal, InboxPanel, DocGalleryModal — and the desk is the real DeskChat
// inside the real DeskHosts, as the passing control.
//
//   node tests/popoutdrag-build.mjs && python -B tests/popoutdrag_probe.py

import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { CurrentOrg } from '../src/popout'
import { UsageModal, InboxPanel } from '../src/App'
import { DocketModal } from '../src/canvas/docket'
import { DocGalleryModal } from '../src/canvas/gallery'
import { DeskHosts } from '../src/canvas/deskhosts'
import { DeskChat } from '../src/canvas/desk'
import type { CanvasNode } from '../src/canvas/shared'
import type { TreePayload } from '../src/types'
import '../src/styles.css'

const SLUG = 'fixture'
const noop = () => {}
const toast = () => {}

const NODE = {
  id: 'builder', title: 'builder', tier: 'haiku', model_id: 'haiku', state: 'live',
  parent: 'user', seat: 1, grant: 5, free: 5, ui_order: 0, cost_usd: 0, generation: 4,
  occupancy: null, context_window: null, charter: null, mail_pending: 0,
  limit_locked: false, last_status: null, prev_status: null, inflight_at: null,
  last_denials: [], turns: [], frozen: null, audiences_held: [], bearer_state: null,
  children: [], lineage: [], session_id: 'fixture-session',
  scope: { permission_mode: 'default', add_dirs: [], tools: {}, org_visibility: 'team' },
} as unknown as CanvasNode

const TREE = {
  slug: SLUG, name: 'Fixture', roots: [NODE], tiers: { haiku: 1 },
  audience_requests: [], credit_requests: [], audiences: [], workspace: null, dirs: [],
  audit: { live_nodes: 1, top_level_holds: 6, no_overdraft: true, problems: [] },
  max_top_grant: 100, default_top_grant: 5, compact_at: 0, cost_usd_total: 0,
  user_inbox_count: 0, org_inbox: null, net: null, public: false,
} as unknown as TreePayload

const ITEM = {
  slug: 'make-popped-out-modals-draggable', parent: null, rev: 1, kind: 'code',
  title: 'Make popped-out modals draggable',
  objective: 'A popped-out modal has no title bar to move it by.',
  status: 'in_progress', blocked_reason: null, archived: false, archived_at: null,
  owner: { node: 'builder', generation: 4 }, owner_current: true, owner_state: 'live',
  participants: [], created_by: { node: 'builder', generation: 4 },
  at: '2026-09-12T08:00:00.000Z', updated_at: '2026-09-12T09:00:00.000Z',
  done_so_far: ['measured a real popped-out window'], working_on_next: ['the shared fix'],
  docket_at: '2026-09-12T09:00:00.000Z', last_updater: { node: 'builder', generation: 4 },
  manual_attention: null, dismissals: [], questions: [], effective_attention: false,
  attention_sources: [], acceptance: [], dependencies: [], evidence: [], delivery: null,
  accepted: null, superseded_by: null, history: [],
}

const DOC = {
  id: 'doc-1', node: 'builder', title: 'A presented plan', kind: 'document',
  at: '2026-09-12T09:00:00.000Z', generation: 4, format: 'markdown', private: false,
  bytes: 42, audience: 'user',
}

const limit = (kind: string, group: string, percent: number) => ({
  kind, group, percent, severity: null, resets_at: '2026-09-15T18:00:00Z',
  is_active: true, model: null, label: kind,
})
const USAGE = {
  available: true, plan: 'max', email: 'fixture@example.com',
  observed_at: '2026-09-12T18:26:29Z',
  limits: [limit('session', 'session', 29), limit('weekly', 'weekly_all', 96)],
}
const ACCOUNT_USAGE = { account: 'openai/primary', label: 'openai/primary', available: true,
  provider: 'openai', email: 'fixture@example.com', observed_at: '2026-09-12T18:26:29Z',
  limits: [limit('weekly', 'weekly_all', 29)] }
const INBOX = { pending: [], delivered: [], sent: [] }

const json = (data: unknown) => new Response(JSON.stringify(data),
  { headers: { 'Content-Type': 'application/json' } })

window.fetch = (async (input: RequestInfo | URL) => {
  const url = String(input)
  if (url.includes('work-items')) {
    return json({ items: [ITEM], counts: { attention: 0, active: 1, archived: 0, backlogged: 0 } })
  }
  if (url.includes('/documents')) return json({ documents: [DOC], total: 1, next_offset: null })
  if (url.includes('/inbox')) return json(INBOX)
  if (url.includes('/api/usage')) return json(USAGE)
  if (url.includes('usage')) return json(ACCOUNT_USAGE)
  if (url.includes('/api/providers')) {
    return json({ providers: [{ id: 'claude', installed: true, signed_in: true, hire: true, available: true }] })
  }
  if (url.includes('/api/accounts')) {
    return json({ version: 1, primary: { signed_in: true, email: 'fixture@example.com' }, keys: [] })
  }
  if (url.includes('/chat')) {
    return json({ messages: [], total: 0, busy: false, pending_mail: [], session_id: 'fixture', node: 'builder' })
  }
  // ⚠ EMPTY LISTS, NOT AN EMPTY OBJECT. A panel that reads `payload.x.find(...)`
  // on an unstubbed route throws, React unmounts the whole tree, and the probe
  // then measures an empty page rather than the panel it came to measure.
  return json({ items: [], keys: [], accounts: [], limits: [], documents: [], messages: [],
    pending: [], delivered: [], sent: [], asks: [], notices: [], files: [], providers: [],
    available: false })
}) as typeof fetch

function Desk() {
  const map = React.useMemo(() => new Map([['builder', NODE]]), [])
  return <DeskHosts map={map} slug={SLUG}><div style={{ height: 700, width: 850 }}>
    <DeskChat bare node={NODE} map={map} slug={SLUG} pub={false} toast={toast}
      op={async () => ({})} onJump={noop} />
  </div></DeskHosts>
}

function Fixture() {
  const which = new URLSearchParams(location.search).get('panel') ?? 'usage'
  const [, setJump] = useState<string | null>(null)
  return <CurrentOrg.Provider value={SLUG}>
    {which === 'usage' && <UsageModal close={noop} toast={toast} />}
    {which === 'docket' && <DocketModal slug={SLUG} tree={TREE} toast={toast} close={noop}
      jumpTo={null} jumpSeq={null} onJumpHandled={noop} />}
    {which === 'inbox' && <InboxPanel slug={SLUG} tree={TREE} toast={toast} close={noop}
      jumpTo={null} jumpSeq={null} onFocusAgent={(id) => setJump(id)} />}
    {which === 'gallery' && <DocGalleryModal slug={SLUG} toast={toast} close={noop} />}
    {which === 'desk' && <Desk />}
  </CurrentOrg.Provider>
}

createRoot(document.getElementById('root')!).render(<Fixture />)
