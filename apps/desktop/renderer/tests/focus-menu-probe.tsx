import { createRoot } from 'react-dom/client'
import App from '../src/App'
import '../src/styles.css'
import '../src/shell.css'
import { OrgCanvas } from '../src/canvas/OrgCanvas'
import { AttentionView } from '../src/attention/AttentionView'
import { setAttentionLayout, setOrgView, useOrgView } from '../src/attention/mode'
import { CurrentOrg } from '../src/popout'
import type { TreePayload } from '../src/types'

const slug = 'focus-probe'
const noop = () => {}
const op = () => Promise.resolve({})
const node = (id: string) => ({ id, title: id, tier: 'haiku', model_id: 'haiku',
  state: 'live', generation: 0, seat: 1, grant: 0, free: 0, children: [], lineage: [],
  turns: [], occupancy: null, context_window: null, charter: null, mail_pending: 0,
  last_status: null, audiences_held: [],
  scope: { permission_mode: 'default', add_dirs: [], tools: {}, org_visibility: 'team' } })
const tree = { slug, name: slug, workspace: null, dirs: [], max_top_grant: 1000,
  default_top_grant: 50, compact_at: 0, tiers: { haiku: 1, opus: 4 },
  roots: [node('alpha'), node('beta')], audiences: [], credit_requests: [],
  audience_requests: [], asks: [], asks_open: 0,
  audit: { live_nodes: 2, top_level_holds: 0, no_overdraft: true, problems: [] },
  work_items_summary: { attention: 0, active: 0 }, user_inbox_count: 0 } as unknown as TreePayload

const messages = Array.from({ length: 3000 }, (_, i) => ({
  role: i % 2 ? 'assistant' : 'user', text: `Message ${i}: ${'Synthetic transcript text. '.repeat(12)}`,
  at: '2026-09-30T00:00:00Z', ordinal: i, segments: [],
}))
window.fetch = async input => {
  const path = new URL(String(input), location.href).pathname
  if (path.endsWith('/foreground-tree')) return new Response('{"kind":"compatibility"}', { status: 409 })
  const body = path === '/api/orgs' ? [{ slug, name: slug, live: 2, seats: 2 }]
    : path === `/api/orgs/${slug}` ? tree
    : /\/detail$/.test(path) ? node(path.includes('/beta/') ? 'beta' : 'alpha')
    : /\/chat$/.test(path) ? { messages, windowed: false, has_older: false, generation: 0 }
    : /\/work-items$/.test(path) ? { items: [], archived: [], backlogged: [] }
      : /\/inbox$/.test(path) ? { pending: [], delivered: [], sent: [] }
        : path === '/api/providers' ? { providers: [] }
        : { ok: true }
  return { ok: true, status: 200, headers: new Headers(), json: async () => body,
    text: async () => JSON.stringify(body) } as Response
}
setOrgView(slug, 'canvas')
setAttentionLayout(slug, { agent: 'alpha', listOpen: false })
Object.assign(window, { changeView: (view: 'canvas' | 'attention') => setOrgView(slug, view) })
function Fixture() {
  const mode = useOrgView(slug)
  return <CurrentOrg.Provider value={slug}><div className="app"><main className="solo">
    <div className="canvas-stage"><OrgCanvas tree={tree} slug={slug} op={op} toast={noop}
      mailEvt={null} canvasContent={mode === 'attention' ? 'hidden' : 'shown'}
      renderOrgSlot={ctx => <AttentionView slug={slug} tree={tree} op={op} toast={noop}
        map={ctx.map} posOf={ctx.posOf} onFocusAgent={ctx.onFocusAgent} deskExtras={ctx.deskExtras} />} />
    </div></main></div></CurrentOrg.Provider>
}
const fullApp = location.hash === '#app'
if (fullApp) {
  const identity = { windowId: 'focus-window', kind: 'org', org: slug, notificationOwner: false }
  Object.assign(window, { orgtreeDesktop: {
    windowIdentity: identity, getWindowIdentity: async () => identity,
    requestOrg: async () => ({ action: 'focused', org: slug }),
    onEvent: () => noop, getPreferences: async () => ({}),
    notify: async () => true, syncNotifications: async () => {},
    getAppVersion: async () => '3.0.0-alpha.9',
  } })
  window.history.replaceState(null, '', `/o/${slug}`)
}
createRoot(document.getElementById('root')!).render(fullApp ? <App /> : <Fixture />)
