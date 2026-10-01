// appchrome-fixture.tsx — the REAL App in a v3 organization window, on fake
// data, for screenshots and geometry of the window chrome (header, footer,
// edges). Built by appchrome-build.mjs and driven by appchrome_probe.py.
//
// Everything outside the renderer is faked: the native bridge says this is a
// v3 org window bound to `studio`, `fetch` answers from a fixed tree, and the
// WebSocket never delivers a frame. No engine, no data root.
import { createRoot } from 'react-dom/client'
import App from '../src/App'
import '../src/styles.css'
import '../src/shell.css'
import { setOrgView } from '../src/attention/mode'

const SLUG = 'studio'
const params = new URLSearchParams(location.search)
const latched = params.get('killswitch') === '1'
const fixtureTier = (id: string) => params.has('providers')
  ? ({'worker-a':'astra','worker-g':'pro','worker-r':'or-probe'} as Record<string,string>)[id] ?? 'opus'
  : 'opus'

const agent = (id: string, docs = 0, children: unknown[] = []) => ({
  id, state: 'live', tier: fixtureTier(id), model_id: fixtureTier(id), children, parent: null,
  seat: 1, grant: 10, free: 5, cost_usd: 0, occupancy: 0, context_window: 100000,
  documents_count: docs,
  scope: { tools: {}, add_dirs: [], permission_mode: 'default', org_visibility: 'team' },
})

const tree = {
  slug: SLUG, name: 'Studio', workspace: null, dirs: [],
  max_top_grant: 1000, default_top_grant: 50, compact_at: 0, default_tools: null,
  default_visibility: 'team', default_effort: '', prefer_reserve_default: false,
  credit_requests: [], tiers: { opus: 1 }, audiences: [],
  roots: [agent('coordinator', 2, params.has('providers')
    ? [agent('worker-a',1),agent('worker-g'),agent('worker-r')]
    : [agent('worker-a', 1)])],
  cost_usd_total: 0, audit: { live_nodes: 2, top_level_holds: 0, no_overdraft: true, problems: [] },
  user_inbox_count: 4, user_inbox_newest: null, fable_lock: null, spend_frozen: false,
  storage_blocked: false, auto_resume: false, fable_limit_policy: 'freeze',
  fable_filter_policy: 'halt', cascade_hire: false, cascade_alloc: true, sandboxed: false,
  audience_requests: [], org_inbox: null, net: null, public: false, epoch: 1, rev: 1,
  work_items_summary: { attention: 0, active: 7 }, asks: [], asks_open: 0, watchdogs: [],
  killswitch: latched ? { at: Date.now() / 1000 } : null,
}

const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body),
  { status: 200, headers: { 'Content-Type': 'application/json' } }))
window.fetch = ((input: RequestInfo | URL) => {
  const path = String(input).replace(/^https?:\/\/[^/]+/, '').split('?')[0]!
  if (path === '/api/orgs') return json([{ slug: SLUG, name: 'Studio', live: 2, seats: 2 }])
  if (path === `/api/orgs/${SLUG}` || path === `/api/orgs/${SLUG}/foreground-tree`) return json(tree)
  if (path === '/api/providers') return json({ providers: [] })
  if (/inbox|mailbox|\/mail/.test(path)) {
    return json({ pending: [], delivered: [], history: [], messages: [], items: [], unread: 0 })
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
  ? { windowId: 'w-fixture', kind: 'homepage', notificationOwner: false }
  : { windowId: 'w-fixture', kind: 'org', org: SLUG, notificationOwner: false }
const idle = async () => {}
Object.defineProperty(window, 'orgtreeDesktop', { configurable: true, value: {
  getAppVersion: async () => '3.0.0-alpha.0',
  getPreferences: async () => ({}),
  onEvent: () => () => {},
  windowIdentity: identity,
  getWindowIdentity: async () => identity,
  requestOrg: async (org: string) => ({ action: 'focused', org }),
  openOrgs: async () => [SLUG],
  getWindowControlsState: async () => ({ maximized: false }),
  minimizeWindow: idle, toggleMaximizeWindow: idle, closeWindow: idle,
} })

history.replaceState(null, '', home ? '/' : `/o/${SLUG}`)
createRoot(document.getElementById('root')!).render(<App />)
