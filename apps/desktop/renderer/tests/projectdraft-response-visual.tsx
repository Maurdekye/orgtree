import { createRoot } from 'react-dom/client'
import { OrgCanvas } from '../src/canvas/OrgCanvas'
import { CurrentOrg } from '../src/popout'
import type { OpResult, TreePayload } from '../src/types'

// Synthetic transport only. No engine, provider or live data access.
window.WebSocket = class { close() {} } as unknown as typeof WebSocket
window.fetch = (async () => new Response(JSON.stringify({ ok: true, rows: [], items: [], agents: [],
  counts: {}, pending: [], delivered: [], sent: [], transfers: [], history: [], next_cursor: null }),
  { headers: { 'content-type': 'application/json' } })) as typeof fetch
localStorage.clear()
const requests: Array<(value: OpResult) => void> = []
Object.assign(window, { finishProject: () => requests[0]?.({ node: 'project-a' }) })
const tree = { slug: 'project-response', name: 'Synthetic', roots: [], dirs: [], tiers: { sol: 2 },
  default_top_grant: 12, max_top_grant: 100, cascade_hire: true,
  audiences: [], audience_requests: [], credit_requests: [], user_inbox_count: 0,
  default_visibility: 'team', default_tools: {},
} as unknown as TreePayload
createRoot(document.getElementById('root')!).render(<CurrentOrg.Provider value={tree.slug}>
  <div className="app"><main className="solo"><div className="canvas-stage">
    <OrgCanvas tree={tree} slug={tree.slug} mailEvt={null} toast={() => {}}
      op={() => new Promise<OpResult>(resolve => requests.push(resolve))} />
  </div></main></div>
</CurrentOrg.Provider>)
