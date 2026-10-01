// attnmodel-probe.tsx — the Attention view as the shipped app composes it, with
// a hook to deliver a NEW tree the way a tree refresh does, for
// `attnmodel_probe.py` (docket v3-changing-an-agent-s-model-does-not-show-at-on:
// the user changed an agent's model and the Attention view did not show it).
// `window.__retier(id, tier)` re-renders with a fresh tree in which that agent
// has the new tier; nothing else changes.
//
// Same composition as attentionlayout-probe.tsx (main.tsx's CSS order, the real
// OrgCanvas with AttentionView in its `renderOrgSlot`), kept separate so this
// check does not ride on that page's fixture. The coordinator is at generation
// 2 so its desk draws the `gen N` lineage badge as well as the settings gear.
//
// Scenes, picked by the URL hash: #attention (the desk is the Attention view's
// desk panel) and #canvas-restored (reviewer's desk restored from the last
// session as a full-window panel on the canvas).
// No backend: `fetch` answers every feed with an empty document.
import { createRoot } from 'react-dom/client'
import '../src/App'
import '../src/styles.css'
import '../src/shell.css'
import { OrgCanvas } from '../src/canvas/OrgCanvas'
import { AttentionView } from '../src/attention/AttentionView'
import { setAttentionLayout, setOrgView } from '../src/attention/mode'
import { pinsKey } from '../src/canvas/pins'
import { CurrentOrg } from '../src/popout'
import { WINDOW_LAYOUT_KEY } from '../src/windowlayout'
import type { TreePayload } from '../src/types'

const SLUG = 'probe'

;(window as unknown as { fetch: unknown }).fetch = (url: string) => {
  const path = new URL(String(url), location.href).pathname
  const body = /\/work-items$/.test(path)
    ? { items: [], archived: [], backlogged: [],
        counts: { attention: 0, active: 0, archived: 0, backlogged: 0 } }
    : /\/inbox$/.test(path) ? { pending: [], delivered: [], sent: [] }
      : /\/providers$/.test(path) ? { providers: [] }
        : { ok: true }
  return Promise.resolve({
    ok: true, status: 200, headers: new Headers(),
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  })
}

function mk(id: string, generation: number, children: unknown[] = [], tier = 'opus'): unknown {
  return {
    id, title: id, tier, model_id: tier, state: 'live',
    seat: 1, grant: 0, free: 0, ui_order: 0, cost_usd: 0, occupancy: null,
    context_window: null, charter: null, mail_pending: 0, limit_locked: false,
    last_status: null, prev_status: null, inflight_at: null, last_denials: [],
    turns: [], frozen: null, audiences_held: [], bearer_state: null,
    generation, children, lineage: [],
    scope: { permission_mode: 'default', add_dirs: [], tools: {},
      org_visibility: 'team', effort: '' },
  }
}

const makeTree = (tiers: Record<string, string>) => ({
  slug: SLUG, name: SLUG, workspace: null, dirs: [], max_top_grant: 1000,
  default_top_grant: 50, compact_at: 0, default_tools: null,
  default_visibility: 'team', default_effort: 'medium', credit_requests: [],
  tiers: { haiku: 1, sonnet: 3, opus: 5, fable: 10 }, audiences: [],
  // builder reports to coordinator, so coordinator's desk draws a jump card
  roots: [mk('coordinator', 2, [mk('builder', 0, [], tiers.builder)], tiers.coordinator), mk('reviewer', 1, [], tiers.reviewer)],
  cost_usd_total: 0,
  audit: { live_nodes: 3, top_level_holds: 0, no_overdraft: true, problems: [] },
  user_inbox_count: 0, user_inbox_newest: null, fable_lock: null,
  spend_frozen: false, storage_blocked: false, auto_resume: false,
  fable_limit_policy: 'freeze', fable_filter_policy: 'halt',
  cascade_hire: false, cascade_alloc: true, sandboxed: false,
  audience_requests: [], org_inbox: null, net: null,
  work_items_summary: { attention: 0, active: 0 }, asks: [], asks_open: 0,
  watchdogs: [],
}) as unknown as TreePayload
const tiers: Record<string, string> = { coordinator: 'opus', builder: 'opus', reviewer: 'opus' }

const scene = location.hash.replace(/^#/, '') || 'attention'
localStorage.removeItem(pinsKey(SLUG))
if (scene.endsWith('-restored')) {
  // restored windows exist only in the desktop shell
  ;(window as unknown as { orgtreeDesktop: unknown }).orgtreeDesktop = {
    onEvent: () => () => {}, getPreferences: () => Promise.resolve({}),
  }
  localStorage.setItem(WINDOW_LAYOUT_KEY, JSON.stringify([{
    key: 'restored-reviewer', kind: `desk:${JSON.stringify([SLUG, 'reviewer', 1])}`, org: SLUG,
    open: true, rect: { x: 0, y: 0, width: 800, height: 700 } }]))
}
const attention = scene.startsWith('attention')
setOrgView(SLUG, attention ? 'attention' : 'canvas')
setAttentionLayout(SLUG, { split: 0.38, agent: 'coordinator', listOpen: false })
const root = createRoot(document.getElementById('root')!)
const draw = () => root.render(
  <CurrentOrg.Provider value={SLUG}>
    <div className="app">
      <main className="solo">
        <div className="canvas-stage">
          <OrgCanvas tree={makeTree(tiers)} op={() => Promise.resolve({} as never)}
            slug={SLUG} toast={() => {}} mailEvt={null}
            canvasContent={attention ? 'hidden' : 'shown'}
            renderOrgSlot={(ctx) => (
              <AttentionView slug={ctx.slug} tree={ctx.tree} op={ctx.op}
                toast={ctx.toast} map={ctx.map} posOf={ctx.posOf}
                onOpenItem={ctx.onOpenItem} onFocusAgent={ctx.onFocusAgent}
                onOpenDoc={ctx.onOpenDoc} onOpenMail={ctx.onOpenMail}
                deskExtras={ctx.deskExtras} />
            )} />
        </div>
      </main>
    </div>
  </CurrentOrg.Provider>)
draw()
;(window as unknown as { __retier: unknown }).__retier = (id: string, tier: string) => { tiers[id] = tier; draw() }
