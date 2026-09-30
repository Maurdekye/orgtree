import { createRoot } from 'react-dom/client'
import App from '../src/App'
import '../src/styles.css'
import '../src/shell.css'
import { OrgCanvas } from '../src/canvas/OrgCanvas'
import { AttentionView } from '../src/attention/AttentionView'
import { setAttentionLayout, setOrgView, useOrgView } from '../src/attention/mode'
import { CurrentOrg } from '../src/popout'
import { pinModal } from '../src/canvas/modalpin'
import { setCrowdPilesOn, setChartLayout } from '../src/canvas/shared'
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
const detached = location.hash === '#detached'
if (detached) {
  setCrowdPilesOn(true)
  setChartLayout('circular')
  tree.roots = [{ ...node('alpha'), children: [
    ...Array.from({ length: 24 }, (_, i) => ({ ...node(`child-${i}`), parent: 'alpha' })),
    { ...node('beta'), parent: 'alpha', children: [{ ...node('gamma'), parent: 'beta' }] },
    ...Array.from({ length: 1100 }, (_, i) => ({ ...node(`retired-${i}`), parent: 'alpha', state: 'archived' })),
  ] }] as TreePayload['roots']
}
const copiedRoots = (window as unknown as { copiedRoots?: TreePayload['roots'] }).copiedRoots
if (copiedRoots) tree.roots = copiedRoots

const copied = (window as unknown as { copiedMessages?: Record<string, unknown>[] }).copiedMessages
const targetCopied = (window as unknown as { targetCopiedMessages?: Record<string, unknown>[] }).targetCopiedMessages
const targetMessages = targetCopied?.map((message, seq) => ({ ...message, seq }))
const messages = copied ? copied.map((message, seq) => ({ ...message, seq })) : Array.from({ length: 3000 }, (_, i) => ({
  role: i % 2 ? 'assistant' : 'user', text: `Message ${i}: ${'Synthetic transcript text. '.repeat(12)}`,
  at: '2026-09-30T00:00:00Z', ordinal: i, segments: [],
}))
window.fetch = async input => {
  const path = new URL(String(input), location.href).pathname
  if (path.endsWith('/foreground-tree')) {
    const nodes: Record<string, unknown> = {}
    const walk = (n: TreePayload['roots'][number], parent: string | null) => {
      nodes[n.id] = { ...n, parent, children: n.children.map(c => c.id),
        axis: 'org', hidden_retired_children: 0, lineage_loaded: false,
        predecessor: null, successor: null, detail: false, detail_rev: 'probe-detail' }
      n.children.forEach(c => walk(c, n.id))
    }
    tree.roots.forEach(n => walk(n, null))
    return new Response(JSON.stringify({ format: 'orgtree.foreground-tree/v1', kind: 'snapshot',
      revision: 'probe-tree', catalog_revision: 'probe-catalog', org_rev: 1, sync_rev: 1,
      nodes, roots: tree.roots.map(n => n.id), missing_requested: [],
      header: { ...tree, roots: undefined, hidden_retired_roots: 0, retired_total: 1100 } }),
      { headers: { 'content-type': 'application/json' } })
  }
  const requested = decodeURIComponent(path.split('/').at(-2) ?? '')
  const findNode = (nodes: TreePayload['roots']): TreePayload['roots'][number] | undefined => {
    for (const n of nodes) { if (n.id === requested) return n; const found = findNode(n.children); if (found) return found }
  }
  const body = path === '/api/orgs' ? [{ slug, name: slug, live: 2, seats: 2 }]
    : path === `/api/orgs/${slug}` ? tree
    : /\/detail$/.test(path) ? { ...findNode(tree.roots), children: undefined, detail: true }
    : /\/chat$/.test(path) ? { messages: path.includes('/beta/') ? targetMessages ?? messages : messages,
      windowed: false, has_older: false, generation: 0 }
    : /\/work-items$/.test(path) ? { items: [], archived: [], backlogged: [] }
      : /\/inbox$/.test(path) ? { pending: [], delivered: [], sent: [] }
        : path === '/api/providers' ? { providers: [] }
        : { ok: true }
  return { ok: true, status: 200, headers: new Headers(), json: async () => body,
    text: async () => JSON.stringify(body) } as Response
}
setOrgView(slug, detached ? 'attention' : 'canvas')
setAttentionLayout(slug, { agent: 'alpha', listOpen: false })
if (detached) {
  pinModal('attention-queue', { x: 20, y: 20, w: 450, h: 500 }, slug)
  pinModal('attention-desk', { x: 650, y: 20, w: 900, h: 850 }, slug)
}
Object.assign(window, { changeView: (view: 'canvas' | 'attention') => setOrgView(slug, view) })
Object.assign(window, { loadedProbeMessages: messages.length })
function Fixture() {
  const mode = useOrgView(slug)
  return <CurrentOrg.Provider value={slug}><div className="app"><main className="solo">
    <div className="canvas-stage"><OrgCanvas tree={tree} slug={slug} op={op} toast={noop}
      mailEvt={null} canvasContent={mode === 'attention' ? 'hidden' : 'shown'}
      renderOrgSlot={ctx => <AttentionView slug={slug} tree={tree} op={op} toast={noop}
        map={ctx.map} posOf={ctx.posOf} onFocusAgent={ctx.onFocusAgent} deskExtras={ctx.deskExtras} />} />
    </div></main></div></CurrentOrg.Provider>
}
const fullApp = detached || location.hash === '#app'
if (fullApp) {
  const identity = { windowId: 'focus-window', kind: 'org', org: slug, notificationOwner: false }
  if (!window.orgtreeDesktop) Object.assign(window, { orgtreeDesktop: {
    windowIdentity: identity, getWindowIdentity: async () => identity,
    requestOrg: async () => ({ action: 'focused', org: slug }),
    onEvent: () => noop, getPreferences: async () => ({}),
    notify: async () => true, syncNotifications: async () => {},
    getAppVersion: async () => '3.0.0-alpha.9',
  } })
  window.history.replaceState(null, '', `/o/${slug}`)
}
createRoot(document.getElementById('root')!).render(fullApp ? <App /> : <Fixture />)
