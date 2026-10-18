// lightsurvey-fixture.tsx: the REAL App in an organization window on fake
// data, for the light-mode survey (lightsurvey-visual.mjs). One agent per
// provider lane and a spread of desk states (a running turn, a warm process,
// pending mail, done/blocked/working statuses, a halted and a read-only seat),
// and a user inbox whose rows draw every accent and status cue. Modelled on
// appchrome-fixture.tsx: the native bridge says this is an org window,
// `fetch` answers from fixed data, the WebSocket never delivers a frame, and
// every write is refused. window.__survey switches the contrast family and
// the visual theme with the app's own setters. No engine, no data root.
import { createRoot } from 'react-dom/client'
import App from '../src/App'
import '../src/styles.css'
import '../src/shell.css'
import { applyTheme } from '../src/themes'
import { applyContrast } from '../src/contrast'
import { setOrgView } from '../src/attention/mode'

const SLUG = 'studio'
const params = new URLSearchParams(location.search)
const at = (min: number) => new Date(Date.UTC(2026, 9, 18, 15, 0) - min * 60000).toISOString()

const agent = (id: string, tier: string, extra: Record<string, unknown> = {}, children: unknown[] = []) => ({
  id, title: id, state: 'live', tier, model_id: tier, children, parent: null,
  seat: 1, grant: 10, free: 5, cost_usd: 0, occupancy: 0.3, context_window: 200000,
  mail_pending: 0, documents_count: 0, busy: false, proc_live: false, proc_warm: false,
  last_status: null, prev_status: null, inflight_at: null, frozen: null,
  scope: { tools: {}, add_dirs: [], permission_mode: 'default', org_visibility: 'team' },
  ...extra,
})
const status = (s: string, summary: string, min: number) => ({ status: s, summary, at: at(min) })

const workers = [
  agent('designer-sonnet', 'sonnet', { last_status: status('done', 'Light mode slice 1 handed in', 12), documents_count: 2 }),
  agent('scout-haiku', 'haiku', { read_only: true, last_status: status('idle', 'Waiting for the next survey', 40) }),
  agent('rig-sol', 'sol', { busy: true, proc_live: true, turn_started_at: at(2), inflight_at: at(2), last_status: status('working', 'Building alpha.9', 3), mail_pending: 3 }),
  agent('review-astra', 'astra', { proc_live: true, proc_warm: true, last_status: status('blocked', 'Waiting on the build slot', 9) }),
  agent('agy-pro', 'pro', { last_status: status('working', 'Reading the docket', 5) }),
  agent('flash-helper', 'flash', { halt: { phase: 'halted', requested_at: at(30), at: at(29), by: 'user' } }),
  agent('muse-wonder', 'wonder', { mail_pending: 1, last_status: status('done', 'Captures attached', 20) }),
  agent('or-probe', 'or-probe', { last_status: status('working', 'Comparing models', 7) }),
  agent('ls-local', 'ls-llamacpp', { last_status: status('idle', '', 50) }),
]
const coordinator = agent('coordinator', 'opus', {
  busy: true, proc_live: true, turn_started_at: at(1), inflight_at: at(1), mail_pending: 2, documents_count: 3,
  last_status: status('working', 'Integrating the light-mode slices', 1),
}, workers)

const tree = {
  slug: SLUG, name: 'Studio', workspace: null, dirs: [],
  max_top_grant: 1000, default_top_grant: 50, compact_at: 0, default_tools: null,
  default_visibility: 'team', default_effort: '', prefer_reserve_default: false,
  credit_requests: [], tiers: { opus: 4, sonnet: 2, haiku: 0.5, sol: 2, astra: 4, pro: 2, flash: 1, wonder: 4 }, audiences: [],
  roots: [coordinator],
  cost_usd_total: 0, audit: { live_nodes: workers.length + 1, top_level_holds: 0, no_overdraft: true, problems: [] },
  user_inbox_count: 4, user_inbox_newest: at(4), fable_lock: null,
  auto_resume: false, fable_limit_policy: 'freeze',
  fable_filter_policy: 'halt', cascade_hire: false, cascade_alloc: true,
  audience_requests: [], org_inbox: null, net: null, epoch: 1, rev: 1,
  work_items_summary: { attention: 2, active: 7 }, asks: [], asks_open: 0, watchdogs: [],
  killswitch: null,
}

// the user's mailbox: an urgent row, an @user mention, a question, a request,
// a tagged and a read row (what lightaccent-visual.tsx draws, through the App)
const pending = [
  { id: 'u1', from: 'rig-sol', to: 'user', kind: 'message', at: at(4), urgent: true, urgent_reason: 'the alpha.9 smoke failed',
    body: 'The alpha.9 smoke failed on the synthetic rig; the details are in [the receipt](https://example.invalid/receipt).' },
  { id: 'u2', from: 'designer-sonnet', to: 'user', kind: 'message', at: at(14), mailbox_attention: true, tags: ['light mode'],
    body: 'The light mode survey is ready, @user, please look at the desks when you can.' },
  { id: 'q1', from: 'coordinator', to: 'user', kind: 'question', at: at(25),
    body: 'Should the solarized surfaces keep their warm paper tone?' },
  { id: 'r1', from: 'review-astra', to: 'user', kind: 'request', at: at(35),
    body: 'Please review the contrast table for the presets.' },
]
const delivered = [
  { id: 'd1', from: 'muse-wonder', to: 'user', kind: 'message', at: at(70), tags: ['alpha', 'captures'], read: true,
    body: 'Captures for every theme are attached.' },
  { id: 'd2', from: 'agy-pro', to: 'user', kind: 'message', at: at(95), read: true,
    body: 'The docket is current.' },
]

const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body),
  { status: 200, headers: { 'Content-Type': 'application/json' } }))
window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const [path, query = ''] = String(input).replace(/^https?:\/\/[^/]+/, '').split('?') as [string, string?]
  if (init?.method && init.method !== 'GET') return Promise.reject(new Error('blocked fixture write: ' + path))
  if (path === `/api/orgs/${SLUG}/inbox` && query.includes('tags_only=true')) return json({ tag_choices: ['alpha', 'captures', 'light mode'], next_tag_cursor: null })
  if (path === '/api/orgs') return json([{ slug: SLUG, name: 'Studio', live: workers.length + 1, seats: workers.length + 1 }])
  if (path === `/api/orgs/${SLUG}` || path === `/api/orgs/${SLUG}/foreground-tree`) return json(tree)
  if (path === '/api/providers') return json({ providers: [] })
  if (path === `/api/orgs/${SLUG}/inbox`) return json({ pending, delivered, sent: [], tag_choices: ['alpha', 'captures', 'light mode'] })
  if (/inbox|mailbox|\/mail/.test(path)) {
    return json({ pending: [], delivered: [], sent: [], history: [], messages: [], items: [], unread: 0 })
  }
  if (/\/(work|items|documents|asks|watchdogs|events|audiences)$/.test(path)) return json([])
  return json({})
}) as typeof fetch

class QuietSocket {
  readyState = 1
  onmessage: ((ev: MessageEvent) => void) | null = null
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  send() {}
  close() {}
  addEventListener() {}
  removeEventListener() {}
}
;(window as unknown as { WebSocket: unknown }).WebSocket = QuietSocket

const home = params.get('view') === 'home'
if (params.get('view') === 'attention') setOrgView(SLUG, 'attention')
const identity = home
  ? { windowId: 'w-survey', kind: 'homepage', notificationOwner: false }
  : { windowId: 'w-survey', kind: 'org', org: SLUG, notificationOwner: false }
const idle = async () => {}
Object.defineProperty(window, 'orgtreeDesktop', { configurable: true, value: {
  getAppVersion: async () => '4.4.0-alpha.0',
  getPreferences: async () => ({}),
  onEvent: () => () => {},
  windowIdentity: identity,
  getWindowIdentity: async () => identity,
  requestOrg: async (org: string) => ({ action: 'focused', org }),
  openOrgs: async () => [SLUG],
  getWindowControlsState: async () => ({ maximized: false }),
  minimizeWindow: idle, toggleMaximizeWindow: idle, closeWindow: idle,
} })

// the app's own setters: one contrast class on the root, the theme's inline
// accent and its data-visual-theme
;(window as unknown as { __survey: unknown }).__survey = {
  set({ contrast, theme }: { contrast?: string; theme?: string }) {
    if (contrast) applyContrast(contrast)
    if (theme) applyTheme(theme)
  },
}
applyContrast(params.get('contrast') ?? 'light')
applyTheme(params.get('theme') ?? 'orgtree')

history.replaceState(null, '', (home ? '/' : `/o/${SLUG}`) + location.search)
createRoot(document.getElementById('root')!).render(<App />)
