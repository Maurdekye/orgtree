// Isolated renderer capture with mock admission; no engine, auth or live org.
import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { OrgCanvas } from '../src/canvas/OrgCanvas'
import { NewHirePositionSetting } from '../src/canvas/hirepositionsetting'
import { CurrentOrg } from '../src/popout'
import { setChartLayout, setStartView } from '../src/canvas/shared'
import { setNewHirePosition } from '../src/hireposition'
import type { OpRequest, TreeNode, TreePayload } from '../src/types'
import '../src/styles.css'
import '../src/shell.css'

setChartLayout('row'); setStartView('org'); setNewHirePosition('end')
const slug = 'hire-position-fixture'
window.WebSocket = class { close() {} } as unknown as typeof WebSocket
window.fetch = async () => new Response(JSON.stringify({
  entries: [], messages: [], live: [], pending_mail: [], busy: false, windowed: true,
  has_older: false, transfers: [], pending: [], delivered: [], sent: [], items: [],
  archived: [], backlogged: [], counts: { attention: 0, active: 0 },
  providers: [{ id: 'openai', label: 'Codex', cli: 'codex', tiers: [], hire_enabled: true,
    status: { installed: true, connected: true }, reason: null }],
}), { headers: { 'Content-Type': 'application/json' } })
const node = (id: string, children: TreeNode[] = []): TreeNode => ({
  id, title: id, state: 'live', tier: 'sol', model_id: 'sol', generation: 0,
  children, seat: 2, grant: 40, free: 30, ui_order: 0, turns: [], lineage: [],
  audiences_held: [], scope: { tools: {}, add_dirs: [], permission_mode: 'default', org_visibility: 'team' },
} as unknown as TreeNode)
const initial = { slug, name: 'Synthetic team', roots: [node('manager', [node('alpha'),
  { ...node('project'), kind: 'project', tier: null, seat: 0 }, node('omega')])],
  tiers: { sol: 2 }, dirs: [], credit_requests: [], audience_requests: [], audiences: [],
  asks: [], asks_open: 0, watchdogs: [], user_inbox_count: 0, org_inbox: null,
  net: null, cost_usd_total: 0, work_items_summary: { active: 0, attention: 0 },
  default_top_grant: 20, max_top_grant: 1000,
} as unknown as TreePayload
const requests: OpRequest[] = []
function Fixture() {
  const [tree, setTree] = useState(initial)
  Object.assign(window, { fixtureRequests: requests, fixtureOrder: tree.roots[0]!.children.map(n => n.id) })
  return <CurrentOrg.Provider value={slug}>
    <div style={{ display: 'grid', gridTemplateColumns: '360px 1fr', height: '100vh' }}>
      <section className="settings" style={{ width: 'auto', padding: 24, borderRight: '1px solid var(--line)' }}>
        <h2>App settings</h2><div className="field-label">Display · Desk</div>
        <NewHirePositionSetting />
        <p className="dim">Centre: A B [new] C</p>
        <p className="dim">Ordinary new agents and projects follow this choice.</p>
      </section>
      <div className="app"><main className="solo"><div className="canvas-stage">
        <OrgCanvas tree={tree} slug={slug} toast={() => {}} mailEvt={null} op={async body => {
          if (body.op !== 'hire' || body.user_position !== 'centre') throw new Error('expected centre hire')
          requests.push(body)
          // Mock the already unit-tested admission ordinal for this visual only.
          setTree(current => {
            const parent = current.roots[0]!, children = [...parent.children]
            children.splice(Math.ceil(children.length / 2), 0, node(String(body.name)))
            return { ...current, roots: [{ ...parent, children }] }
          })
          return { node: String(body.name) }
        }} />
      </div></main></div>
    </div>
  </CurrentOrg.Provider>
}
createRoot(document.getElementById('root')!).render(<Fixture />)
