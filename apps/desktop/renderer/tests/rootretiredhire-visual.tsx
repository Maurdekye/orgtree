import { createRoot } from 'react-dom/client'
import { OrgCanvas } from '../src/canvas/OrgCanvas'
import { CurrentOrg } from '../src/popout'
import { setHideRetiredOn } from '../src/canvas/shared'
import { bunchTree, agent } from './projectbunch-fixture'

// Synthetic records and transport only; this fixture never contacts an engine.
window.WebSocket = class { close() {} } as unknown as typeof WebSocket
window.fetch = (async () => new Response(JSON.stringify({ ok: true, rows: [], items: [], agents: [],
  counts: {}, pending: [], delivered: [], sent: [], transfers: [], history: [], next_cursor: null }),
  { headers: { 'content-type': 'application/json' } })) as typeof fetch
localStorage.clear()
localStorage.setItem('orgtree-start-zoom', '0')
setHideRetiredOn(true)
const tree = { ...bunchTree([agent('worker')]), foreground: { hidden_retired_roots: 8 },
  tiers: { haiku: 1, sonnet: 2, opus: 5, fable: 10, luna: .2, terra: 2, sol: 5, astra: 10, flash: 1, pro: 2 } }
document.body.style.margin = '0'
createRoot(document.getElementById('root')!).render(<CurrentOrg.Provider value="root-hire-fixture">
  <div className="app"><main className="solo"><div className="canvas-stage">
    <OrgCanvas tree={tree} op={async () => ({} as never)} slug="root-hire-fixture" toast={() => {}} mailEvt={null} />
  </div></main></div>
</CurrentOrg.Provider>)
