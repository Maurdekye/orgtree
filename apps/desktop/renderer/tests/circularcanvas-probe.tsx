// circularcanvas-probe.tsx — the REAL OrgCanvas (real styles, app import
// order) on a generated org, in Circular mode, for circularcanvas_probe.py.
// Scenes by URL hash: #small (9 agents), #large (208 agents: 8x5x4), #huge (2000 direct reports).
import { createRoot } from 'react-dom/client'
import '../src/App'
import '../src/styles.css'
import '../src/shell.css'
import { OrgCanvas } from '../src/canvas/OrgCanvas'
import { CHART_LAYOUT_KEY } from '../src/canvas/shared'
import { CurrentOrg } from '../src/popout'
import type { TreePayload } from '../src/types'

const SLUG = 'probe'
;(window as unknown as { fetch: unknown }).fetch = () => Promise.resolve({
  ok: true, status: 200, headers: new Headers(),
  json: () => Promise.resolve({ items: [], archived: [], backlogged: [], pending: [], delivered: [], sent: [], providers: [] }),
  text: () => Promise.resolve('{}'),
})

const mk = (id: string, children: unknown[] = []): unknown => ({
  id, title: id, tier: 'haiku', model_id: 'haiku', state: 'live',
  seat: 1, grant: 0, free: 0, ui_order: 0, cost_usd: 0, occupancy: null,
  context_window: null, charter: null, mail_pending: 0, limit_locked: false,
  last_status: null, prev_status: null, inflight_at: null, last_denials: [],
  turns: [], frozen: null, audiences_held: [], bearer_state: null,
  generation: 0, children, lineage: [],
  scope: { permission_mode: 'default', add_dirs: [], tools: {}, org_visibility: 'team', effort: '' },
})
const team = (pre: string, fan: number[]): unknown[] =>
  fan.length === 0 ? [] : Array.from({ length: fan[0]! }, (_, i) =>
    mk(`${pre}${i}`, team(`${pre}${i}.`, fan.slice(1))))
const count = (n: unknown[]): number =>
  n.reduce<number>((a, x) => a + 1 + count((x as { children: unknown[] }).children), 0)

const scene = location.hash.replace(/^#/, '') || 'small'
const roots = scene === 'huge' ? team('h', [2000]) : scene === 'large' ? team('t', [8, 5, 4]) : team('a', [3, 2])
localStorage.setItem(CHART_LAYOUT_KEY, 'circular')
const tree = {
  slug: SLUG, name: SLUG, workspace: null, dirs: [], max_top_grant: 1000,
  default_top_grant: 50, compact_at: 0, default_tools: null,
  default_visibility: 'team', default_effort: 'medium', credit_requests: [],
  tiers: { haiku: 1, sonnet: 3, opus: 5, fable: 10 }, audiences: [],
  roots, cost_usd_total: 0,
  audit: { live_nodes: count(roots), top_level_holds: 0, no_overdraft: true, problems: [] },
  user_inbox_count: 0, user_inbox_newest: null, fable_lock: null,
  spend_frozen: false, storage_blocked: false, auto_resume: false,
  fable_limit_policy: 'freeze', fable_filter_policy: 'halt',
  cascade_hire: false, cascade_alloc: true, sandboxed: false,
  audience_requests: [], org_inbox: null, net: null,
  work_items_summary: { attention: 0, active: 0 }, asks: [], asks_open: 0,
} as unknown as TreePayload
;(window as unknown as { agents: number }).agents = count(roots)
createRoot(document.getElementById('root')!).render(
  <CurrentOrg.Provider value={SLUG}>
    <div className="app"><main className="solo"><div className="canvas-stage">
      <OrgCanvas tree={tree} op={() => Promise.resolve({} as never)}
        slug={SLUG} toast={() => {}} mailEvt={null} canvasContent="shown" />
    </div></main></div>
  </CurrentOrg.Provider>)
