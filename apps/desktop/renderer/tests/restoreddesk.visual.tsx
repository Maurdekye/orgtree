// restoreddesk.visual.tsx — Electron fixture for restoreddesk.capture.cjs
// (@item:orgtree/4-5-13-alpha-1-unity-org-window-stuck-on-a-resto).
//
// Mounts the real v3 ShellHeader + .window-drag-margin + OrgCanvas in main.tsx's
// stylesheet cascade order with a saved open desk layout row for `ascii-pup`,
// matching the post-update state where `.popout-recovery.restored-desk` opens
// over the canvas. Browser-only synthetic fixture: no engine or network.
import { createRoot } from 'react-dom/client'
import '../src/App'
import '../src/styles.css'
import '../src/shell.css'
import { ShellHeader } from '../src/shell/header'
import { OrgCanvas } from '../src/canvas/OrgCanvas'
import { CurrentOrg } from '../src/popout'
import { WINDOW_LAYOUT_KEY, windowLayoutKey } from '../src/windowlayout'
import type { OpResult, TreePayload } from '../src/types'

interface ClickRecord {
  tag: string
  className: string
  text: string
}

const SLUG = 'unity'
const AGENT = 'ascii-pup'
const DESK_KIND = `desk:${JSON.stringify([SLUG, AGENT, 0])}`
const scene = (new URLSearchParams(location.search).get('scene') || location.hash.replace(/^#/, '') || 'docked').trim()

const clicks: ClickRecord[] = []
;(window as unknown as { __restoredDeskClicks: ClickRecord[] }).__restoredDeskClicks = clicks
document.addEventListener('click', (e) => {
  const t = e.target as HTMLElement | null
  clicks.push({
    tag: t?.tagName ?? 'NONE',
    className: String(t?.className ?? ''),
    text: (t?.textContent ?? '').trim().slice(0, 60),
  })
}, true)

window.fetch = (async (url: RequestInfo | URL) => {
  const p = new URL(String(url), location.href).pathname
  const payload = /\/chat$/.test(p)
    ? {
        busy: false, queued: 0, responding: false, last_error: null,
        messages: [
          { id: 'm1', role: 'user', text: 'status report', ts: '2026-11-13T19:00:00Z' },
          { id: 'm2', role: 'assistant', text: 'ready on canvas', ts: '2026-11-13T19:00:05Z' },
        ],
        live: [], draft_epoch: 0, mail_pending: 0, pending_mail: [],
      }
    : /\/work-items$/.test(p)
      ? { items: [], archived: [], backlogged: [], references: [], attention: [],
          counts: { attention: 0, active: 0, archived: 0, backlogged: 0 } }
      : /\/inbox$/.test(p)
        ? { pending: [], delivered: [], sent: [] }
        : /\/providers$/.test(p)
          ? { providers: [] }
          : /\/accounts/.test(p)
            ? { accounts: [] }
            : { ok: true }
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}) as typeof fetch

function mkNode(id: string) {
  return {
    id, title: id, tier: 'opus', model_id: 'opus', state: 'live',
    seat: 1, grant: 0, free: 0, ui_order: 0, cost_usd: 0, occupancy: null,
    context_window: null, charter: null, mail_pending: 0, limit_locked: false,
    last_status: null, prev_status: null, inflight_at: null, last_denials: [],
    turns: [], frozen: null, audiences_held: [], bearer_state: null,
    generation: 0, children: [], lineage: [],
    scope: { permission_mode: 'default', add_dirs: [], tools: { bash: true, web: false, edit: true, subagents: false, mcp: [] }, org_visibility: 'team' },
  }
}

const tree = {
  slug: SLUG, name: 'Unity', workspace: null, dirs: [], max_top_grant: 1000,
  default_top_grant: 50, compact_at: 0, default_tools: null,
  default_visibility: 'team', default_effort: 'medium', credit_requests: [],
  tiers: { haiku: 1, sonnet: 3, opus: 5, fable: 10 }, audiences: [],
  roots: [mkNode('coordinator'), mkNode(AGENT)],
  cost_usd_total: 0,
  audit: { live_nodes: 2, top_level_holds: 0, no_overdraft: true, problems: [] },
  user_inbox_count: 0, user_inbox_newest: null, fable_lock: null,
  auto_resume: false,
  fable_limit_policy: 'freeze', fable_filter_policy: 'halt',
  cascade_hire: false, cascade_alloc: true,
  audience_requests: [], org_inbox: null, net: null,
  work_items_summary: { attention: 0, active: 0 }, asks: [], asks_open: 0,
  watchdogs: [],
} as unknown as TreePayload

localStorage.clear()
localStorage.setItem(WINDOW_LAYOUT_KEY, JSON.stringify([{
  key: windowLayoutKey(DESK_KIND, SLUG),
  kind: DESK_KIND,
  org: SLUG,
  open: true,
  restore: { agent: AGENT, generation: 0 },
  rect: { x: 120, y: 120, width: 760, height: 640 },
}]))

;(window as unknown as { orgtreeDesktop: unknown }).orgtreeDesktop = {
  getAppVersion: async () => '4.5.13-alpha.1',
  getPreferences: async () => ({}),
  getWindowState: async () => ({
    visible: true,
    focused: true,
    maximized: false,
    minimized: false,
    restoreWindows: scene === 'detached',
  }),
  getWindowControlsState: async () => ({
    visible: true,
    maximized: false,
    minimized: false,
  }),
  minimizeWindow: async () => {},
  toggleMaximizeWindow: async () => {},
  closeWindow: async () => {},
  minimizePopout: async () => {},
  toggleMaximizePopout: async () => {},
  closePopout: async () => {},
  onEvent: () => () => {},
}

const op = () => Promise.resolve({} as OpResult)
const noop = () => {}

createRoot(document.getElementById('root')!).render(
  <CurrentOrg.Provider value={SLUG}>
    <div className="app shell-v3">
      <main className="solo">
        <ShellHeader
          menu={<button type="button" className="iconbtn" aria-label="Orgtree menu">☰</button>}
          title="Unity"
          orgSlug={SLUG}
          modes={scene === 'wrapped'
            ? <div data-testid="wrapped-spacer" style={{ height: 60, width: 8 }} />
            : undefined}
        />
        <div className="canvas-stage">
          <div className="window-drag-margin" aria-hidden="true" />
          <OrgCanvas tree={tree} op={op} slug={SLUG} toast={noop} mailEvt={null} canvasContent="shown" />
          <div className="window-drag-margin" aria-hidden="true" />
        </div>
      </main>
    </div>
  </CurrentOrg.Provider>,
)
