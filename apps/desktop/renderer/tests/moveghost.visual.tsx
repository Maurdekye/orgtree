// Isolated visual fixture: no engine, credentials or real organization.
import { createRoot } from 'react-dom/client'
import { OrgCanvas } from '../src/canvas/OrgCanvas'
import { CurrentOrg } from '../src/popout'
import { EYE_ANCHOR_X, NODE_W, setChartLayout, setStartView, saveView } from '../src/canvas/shared'
import type { TreeNode, TreePayload } from '../src/types'
import '../src/styles.css'
import '../src/shell.css'

const slug = 'drag-preview-fixture'
setChartLayout('row'); setStartView('remember')
saveView(slug, { x: innerWidth / 2 - (EYE_ANCHOR_X + NODE_W / 2) * 0.7, y: 70, z: 0.7 })
window.WebSocket = class { close() {} } as unknown as typeof WebSocket
window.fetch = async () => new Response(JSON.stringify({
  entries: [], transfers: [], providers: [], pending: [], delivered: [], sent: [],
  items: [], archived: [], backlogged: [], counts: { attention: 0, active: 0 },
}), { status: 200, headers: { 'Content-Type': 'application/json' } })
const node = (id: string, children: TreeNode[] = []): TreeNode => ({
  id, title: id, tier: 'sol', model_id: 'sol', state: 'live', seat: 2, grant: 2, free: 0,
  ui_order: 0, cost_usd: 0, turns: [], children, lineage: [], audiences_held: [],
  scope: { permission_mode: 'default', add_dirs: [], tools: {}, org_visibility: 'team' },
} as unknown as TreeNode)
const tree = {
  slug, name: slug, roots: [node('lead', [node('old-superior', [node('moving-agent', [node('child')])]),
    node('new-superior', [node('report-one'), node('report-two')])])],
  tiers: { sol: 2 }, dirs: [], credit_requests: [], audience_requests: [], audiences: [],
  user_inbox_count: 0, org_inbox: null, net: null, cost_usd_total: 0,
  max_top_grant: 1000, default_top_grant: 20, default_visibility: 'team', default_effort: '',
  asks: [], asks_open: 0, watchdogs: [], work_items_summary: { attention: 0, active: 0 },
} as unknown as TreePayload
createRoot(document.getElementById('root')!).render(<CurrentOrg.Provider value={slug}>
  <div className="app"><main className="solo"><div className="canvas-stage">
    <OrgCanvas tree={tree} slug={slug} op={async () => ({})} toast={() => {}} mailEvt={null} />
  </div></main></div>
</CurrentOrg.Provider>)

Object.assign(window, { startPreview: () => {
  const source = document.querySelector<HTMLElement>('[data-first-use-agent="moving-agent"]')!
  const target = document.querySelector<HTMLElement>('[data-first-use-agent="new-superior"]')!
  const a = source.getBoundingClientRect(), b = target.getBoundingClientRect()
  for (const [type, r] of [['pointerdown', a], ['pointermove', b]] as const)
    source.dispatchEvent(new PointerEvent(type, { bubbles: true, button: 0, buttons: 1, pointerId: 1,
      clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 }))
  return { source: { x:a.x,y:a.y,w:a.width,h:a.height }, target: { x:b.x,y:b.y,w:b.width,h:b.height } }
} })
