// Isolated real renderer with mock admission; no engine/auth/live data.
import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { OrgCanvas } from '../src/canvas/OrgCanvas'
import { HireAutoFocusSetting, NewHirePositionSetting } from '../src/canvas/hirepositionsetting'
import { CurrentOrg } from '../src/popout'
import { setChartLayout, setStartView, setStartZoomOn } from '../src/canvas/shared'
import { setHireAutoFocusOn } from '../src/hirefocus'
import type { TreeNode, TreePayload } from '../src/types'
import '../src/styles.css'
import '../src/shell.css'

setChartLayout('row'); setStartView('org'); setStartZoomOn(false); setHireAutoFocusOn(true)
const slug = 'hire-focus-fixture'
window.WebSocket = class { close() {} } as unknown as typeof WebSocket
window.fetch = async () => new Response(JSON.stringify({ entries: [], messages: [], live: [], pending_mail: [],
  busy: false, windowed: true, has_older: false, transfers: [], pending: [], delivered: [], sent: [], items: [],
  archived: [], backlogged: [], counts: { attention: 0, active: 0 }, providers: [],
}), { headers: { 'Content-Type': 'application/json' } })
const node = (id: string, children: TreeNode[] = []): TreeNode => ({ id, title: id, state: 'live', tier: 'sol',
  model_id: 'sol', generation: 0, children, seat: 2, grant: 20, free: 20, turns: [], lineage: [], audiences_held: [],
  scope: { tools: {}, add_dirs: [], permission_mode: 'default', org_visibility: 'team' },
} as unknown as TreeNode)
const initial = { slug, name: 'Synthetic team', roots: [node('manager')], tiers: { sol: 2 }, dirs: [],
  credit_requests: [], audience_requests: [], audiences: [], asks: [], asks_open: 0, watchdogs: [],
  user_inbox_count: 0, org_inbox: null, net: null, cost_usd_total: 0,
  work_items_summary: { active: 0, attention: 0 }, default_top_grant: 20, max_top_grant: 1000,
} as unknown as TreePayload
function Fixture() {
  const [tree, setTree] = useState(initial)
  return <CurrentOrg.Provider value={slug}><div style={{ display: 'grid', gridTemplateColumns: '390px 1fr', height: '100vh' }}>
    <section className="settings" style={{ width: 'auto', padding: 24, borderRight: '1px solid var(--line)' }}>
      <h2>App settings</h2><p className="field-label">Display · Desk</p>
      <NewHirePositionSetting /><HireAutoFocusSetting />
    </section>
    <div className="app"><main className="solo"><div className="canvas-stage">
      <OrgCanvas tree={tree} slug={slug} toast={() => {}} mailEvt={null} op={async body => {
        if (body.op !== 'hire') throw new Error('unexpected operation')
        Object.assign(window, { fixtureHire: body })
        setTree({ ...initial, roots: [node('manager', [node(String(body.name))])] })
        return { node: String(body.name) }
      }} />
    </div></main></div>
  </div></CurrentOrg.Provider>
}
createRoot(document.getElementById('root')!).render(<Fixture />)
