import { createRoot } from 'react-dom/client'
import App from '../src/App'
import '../src/styles.css'

const agent = { id: 'alpha', title: 'alpha', tier: 'haiku', model_id: 'haiku', state: 'live', seat: 1, grant: 0, free: 0, mail_pending: 0, documents: [{ id: 'doc-alpha', title: 'Alpha plan', at: '2026-09-07T17:00:00Z', format: 'md', bytes: 20 }], children: [], lineage: [], turns: [], audiences_held: [], scope: { tools: {}, add_dirs: [], permission_mode: 'default', org_visibility: 'team' } }
const tree = { slug: 'fixture', name: 'Fixture', workspace: null, dirs: [], max_top_grant: 1000, default_top_grant: 50, compact_at: 0, default_tools: null, default_visibility: 'team', default_effort: '', prefer_reserve_default: false, credit_requests: [], tiers: { haiku: 1 }, audiences: [], roots: [agent], cost_usd_total: 0, audit: { live_nodes: 1, top_level_holds: 0, no_overdraft: true, problems: [] }, user_inbox_count: 0, user_inbox_newest: null, fable_lock: null, spend_frozen: false, storage_blocked: false, auto_resume: false, fable_limit_policy: 'freeze', fable_filter_policy: 'halt', cascade_hire: false, cascade_alloc: true, sandboxed: false, audience_requests: [], org_inbox: null, net: null, public: false, epoch: 1, rev: 1, work_items_summary: { attention: 0, active: 0 }, asks: [], asks_open: 0, watchdogs: [] }
const docs = { documents: [{ id: 'doc-alpha', node: 'alpha', title: 'Alpha plan', at: '2026-09-07T17:00:00Z', format: 'md', bytes: 20, evicted: false, node_state: 'live', tier: 'haiku' }] }
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })
window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const path = (typeof input === 'string' ? input : input.toString()).replace(/^https?:\/\/[^/]+/, '').split('?')[0]
  if (init?.method && init.method !== 'GET') throw Error('blocked fixture write: ' + path)
  if (path === '/api/orgs') return json([{ slug: 'fixture', name: 'Fixture', live: 1, seats: 1 }])
  if (path === '/api/orgs/fixture') return json(tree)
  if (path === '/api/orgs/fixture/documents') return json(docs)
  if (path === '/api/orgs/fixture/documents/doc-alpha') return json({ ...docs.documents[0], body: '# Alpha plan\nserved modal body' })
  if (path === '/api/providers') return json({ providers: [] })
  return json({})
}) as typeof fetch
createRoot(document.getElementById('root')!).render(<App />)
