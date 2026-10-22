import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { OrgCanvas } from '../src/canvas/OrgCanvas'
import { CurrentOrg } from '../src/popout'
import type { TreePayload } from '../src/types'
import '../src/styles.css'
import '../src/shell.css'

// Synthetic response projection only. No engine or live application access.
window.WebSocket = class { close() {} } as unknown as typeof WebSocket
localStorage.clear()
const agent = (id: string, children: unknown[] = []) => ({ id, title: id, tier: 'sol', state: 'live',
  seat: 2, grant: 50, free: 40, generation: 0, children, turns: [], lineage: [], audiences_held: [],
  last_denials: [], scope: { tools: {}, add_dirs: [] }, frozen: null })
const initial = { slug: 'superior-target', name: 'Synthetic superior insertion', roots: [agent('coordinator')],
  dirs: [], tiers: { sol: 2 }, undo_history: true, default_top_grant: 50, max_top_grant: 1000,
  cascade_hire: true, default_visibility: 'team', default_tools: {},
  audiences: [], audience_requests: [], credit_requests: [], user_inbox_count: 0 } as unknown as TreePayload
let accept: (() => void) | undefined
const recorded: unknown[] = []
Object.assign(window, { superiorHireRequests: recorded })
window.fetch = (async (url: RequestInfo | URL, options?: RequestInit) => {
  if (String(url).endsWith('/gesture')) {
    const body = JSON.parse(String(options?.body)); recorded.push(body)
    if (body.steps.length !== 1 || body.steps[0].above !== 'coordinator' || body.steps[0].target !== 'coordinator')
      return new Response(JSON.stringify({ detail: 'synthetic anchor mismatch' }), { status: 400 })
    accept?.()
    return new Response(JSON.stringify({ results: [{ node: 'liaison' }] }), { headers: { 'content-type': 'application/json' } })
  }
  return new Response(JSON.stringify({ ok: true, rows: [], items: [], agents: [], counts: {}, pending: [],
    delivered: [], sent: [], transfers: [], history: [], next_cursor: null }), { headers: { 'content-type': 'application/json' } })
}) as typeof fetch
function Fixture() {
  const [tree, setTree] = useState(initial)
  accept = () => setTree({ ...initial, roots: [agent('liaison', [agent('coordinator')])] } as unknown as TreePayload)
  return <CurrentOrg.Provider value={tree.slug}><div className="app"><main className="solo"><div className="canvas-stage">
    <OrgCanvas tree={tree} slug={tree.slug} mailEvt={null} toast={() => {}} op={async () => { throw Error('expected history request') }} />
  </div></main></div></CurrentOrg.Provider>
}
createRoot(document.getElementById('root')!).render(<Fixture />)
document.body.dataset.ready = 'true'
