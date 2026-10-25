// Actual engine snapshots from superior-centre-ordering.mjs; no live requests.
import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { OrgCanvas } from '../src/canvas/OrgCanvas'
import { CurrentOrg } from '../src/popout'
import { setChartLayout, setStartView } from '../src/canvas/shared'
import { setHireAutoFocusOn } from '../src/hirefocus'
import { newHirePositionOf } from '../src/hireposition'
import type { OpRequest, TreePayload } from '../src/types'
import '../src/styles.css'
import '../src/shell.css'

declare global { interface Window {
  superiorFixture: { before: TreePayload; after: TreePayload }
  superiorRequests: OpRequest[]
  superiorChoice: string
} }
localStorage.clear()
setChartLayout('row'); setStartView('org'); setHireAutoFocusOn(false)
window.superiorChoice = newHirePositionOf()
window.WebSocket = class { close() {} } as unknown as typeof WebSocket
let acceptHire: (body: OpRequest) => { node: string }
window.fetch = async (url, init) => {
  if (String(url).endsWith('/gesture')) {
    const request = JSON.parse(String(init?.body))
    return new Response(JSON.stringify({ results: request.steps.map(acceptHire) }), { headers: { 'Content-Type': 'application/json' } })
  }
  return new Response(JSON.stringify({ entries: [], messages: [], live: [], pending_mail: [],
  busy: false, windowed: true, has_older: false, transfers: [], pending: [], delivered: [], sent: [], items: [],
  archived: [], backlogged: [], counts: { attention: 0, active: 0 }, providers: [{ id: 'openai', label: 'Codex', cli: 'codex', tiers: [], hire_enabled: true,
    status: { installed: true, connected: true }, reason: null }] }),
  { headers: { 'Content-Type': 'application/json' } })
}
window.superiorRequests = []
function Fixture() {
  const [tree, setTree] = useState(window.superiorFixture.before)
  acceptHire = body => {
      if (body.op !== 'hire' || body.name !== 'content-lead' || body.above !== 'copywriter'
        || body.user_position !== undefined) throw Error('Unexpected fixture operation')
      window.superiorRequests.push(body)
      setTree(window.superiorFixture.after)
      return { node: 'content-lead' }
  }
  return <CurrentOrg.Provider value={tree.slug}><div className="app"><main className="solo"><div className="canvas-stage">
    <OrgCanvas tree={tree} slug={tree.slug} toast={() => {}} mailEvt={null} op={async body => acceptHire(body)} />
  </div></main></div></CurrentOrg.Provider>
}
createRoot(document.getElementById('root')!).render(<Fixture />)
