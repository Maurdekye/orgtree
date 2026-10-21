import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { OrgCanvas } from '../src/canvas/OrgCanvas'
import { CurrentOrg } from '../src/popout'
import { setHideRetiredOn } from '../src/canvas/shared'
import { agent, project, bunchTree } from './projectbunch-fixture'
import type { Watchdog } from '../src/types'

window.WebSocket = class { onmessage = null; onclose = null; onerror = null; close() {} } as unknown as typeof WebSocket
const reads: string[] = []
window.fetch = (async input => {
  const url = String(input); reads.push(url)
  const data = url.includes('/retired') ? { agents: [{ ...agent('retired-example'), state: 'archived' }], next_cursor: null }
    : url.includes('/watchdogs?') ? { watchdogs: [], total: 123, next_cursor: null }
    : url.includes('/work-items-page') ? { rows: [], total: 0, counts: {}, next_offset: null }
    : url.includes('/work-items') ? { items: [], archived: [], backlogged: [], counts: {} }
    : url.includes('/inbox') ? { pending: [], delivered: [], sent: [] }
    : url.includes('/transfers') ? { transfers: [], next_cursor: null }
    : url.includes('/history') ? { history: [], items: [] } : { ok: true }
  return new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } })
}) as typeof fetch
let sequence = 0
function Fixture() {
  const [state, setState] = useState({ kind: 'agent', count: 624, dogs: 123, key: 0 })
  ;(window as unknown as { retiredHeaderFixture: unknown }).retiredHeaderFixture = {
    render: (kind: string, count: number, dogs: number) => {
      const key = ++sequence; setState({ kind, count, dogs, key }); return key
    }, reads,
  }
  const owner = state.kind === 'agent' ? agent('owner') : project('owner', [project('next-project', [agent('worker')])])
  owner.hidden_retired_children = state.count
  owner.effort = 'medium'
  const dogs = Array.from({ length: Math.min(8, state.dogs) }, (_, i) => ({ id: `owner/watch-${i}`, owner: 'owner', name: `watch-${i}`,
    kind: 'file', target: 'synthetic', state: 'armed', once: false, fired: 0, interval_s: 600, at: '2026-10-21T00:00:00Z' })) as Watchdog[]
  const tree = { ...bunchTree([owner]), slug: 'retired-header-fixture', name: 'Retired header badges', watchdogs: dogs,
    watchdog_counts: { owner: { total: state.dogs, kept: state.dogs, one_shot: 0 } } }
  document.body.dataset.fixture = String(state.key)
  return <CurrentOrg.Provider value={tree.slug}><div className="app"><main className="solo"><div className="canvas-stage">
    <OrgCanvas key={state.key} tree={tree} slug={tree.slug} op={async () => ({ ok: true } as never)} toast={() => {}} mailEvt={null} />
  </div></main></div></CurrentOrg.Provider>
}
localStorage.clear(); localStorage.setItem('orgtree-start-zoom', '0')
setHideRetiredOn(true)
document.body.style.margin = '0'
createRoot(document.getElementById('root')!).render(<Fixture />)
