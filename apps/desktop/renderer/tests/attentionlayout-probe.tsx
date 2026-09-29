// attentionlayout-probe.tsx — the Attention view, the effort card and the App
// settings tabs, laid out the way the SHIPPED APP lays them out, for
// `attentionlayout_probe.py` to measure and screenshot in a real browser.
//
// WHY A SECOND ATTENTION PROBE. `attention-probe.tsx` mounts `AttentionView`
// on its own and imports styles.css FIRST, so attention.css lands after it and
// wins every tie. The app does the opposite: main.tsx imports App (and through
// it attention.css) BEFORE styles.css, so `.settings { width: 660px }` beat
// `.attn-panel { width: auto }` and the panels never followed the divider —
// user report 2026-09-29, image-17. That probe also measured the SLOTS, which
// did move, not the panels inside them. So this page:
//   · imports in main.tsx's order (App first, then styles.css, then shell.css),
//     so the cascade is the app's cascade;
//   · mounts the real OrgCanvas inside a real `.canvas-stage` with the view in
//     its `renderOrgSlot`, exactly as App.tsx composes them, so the canvas and
//     the slot share the stage the way they do on screen.
//
// Scenes, picked by the URL hash: #canvas, #attention, #pinned,
// #settings-<tab>, and #canvas-restored / #attention-restored: a desk that was
// popped out last session, restored as a full-window panel (review finding on
// 39d0581 — it must stay with the canvas, not cover the Attention view).
// No backend: `fetch` answers every feed with an empty document.
import { createRoot } from 'react-dom/client'
import '../src/App'
import '../src/styles.css'
import '../src/shell.css'
import { OrgCanvas } from '../src/canvas/OrgCanvas'
import { AccountsPanel } from '../src/canvas/accounts'
import { AttentionView } from '../src/attention/AttentionView'
import { setAttentionLayout, setOrgView } from '../src/attention/mode'
import { addPin, pinsKey } from '../src/canvas/pins'
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

function mk(id: string, effort = ''): unknown {
  return {
    id, title: id, tier: 'opus', model_id: 'opus', state: 'live',
    seat: 1, grant: 0, free: 0, ui_order: 0, cost_usd: 0, occupancy: null,
    context_window: null, charter: null, mail_pending: 0, limit_locked: false,
    last_status: null, prev_status: null, inflight_at: null, last_denials: [],
    turns: [], frozen: null, audiences_held: [], bearer_state: null,
    generation: 0, children: [], lineage: [],
    effort_effective: effort || undefined,
    scope: { permission_mode: 'default', add_dirs: [], tools: {},
      org_visibility: 'team', effort },
  }
}

const tree = {
  slug: SLUG, name: SLUG, workspace: null, dirs: [], max_top_grant: 1000,
  default_top_grant: 50, compact_at: 0, default_tools: null,
  default_visibility: 'team', default_effort: 'medium', credit_requests: [],
  tiers: { haiku: 1, sonnet: 3, opus: 5, fable: 10 }, audiences: [],
  roots: [mk('coordinator', 'high'), mk('reviewer'), mk('builder', 'low')],
  cost_usd_total: 0,
  audit: { live_nodes: 3, top_level_holds: 0, no_overdraft: true, problems: [] },
  user_inbox_count: 0, user_inbox_newest: null, fable_lock: null,
  spend_frozen: false, storage_blocked: false, auto_resume: false,
  fable_limit_policy: 'freeze', fable_filter_policy: 'halt',
  cascade_hire: false, cascade_alloc: true, sandboxed: false,
  audience_requests: [], org_inbox: null, net: null,
  work_items_summary: { attention: 0, active: 0 }, asks: [], asks_open: 0,
  // two of coordinator's own watchdogs and one of reviewer's: the desk's
  // watchdog cards must show exactly the first two
  watchdogs: [
    { id: 'w1', owner: 'coordinator', name: 'build-done', kind: 'file', target: 'build.log',
      interval_s: 30, state: 'armed', at: '2026-09-29T00:00:00Z', fired: 0, once: false, spent: false },
    { id: 'w2', owner: 'coordinator', name: 'ci-red', kind: 'command', target: 'gh run list',
      interval_s: 60, state: 'paused', at: '2026-09-29T00:00:00Z', fired: 0, once: true, spent: false },
    { id: 'w3', owner: 'reviewer', name: 'not-mine', kind: 'file', target: 'x',
      interval_s: 30, state: 'armed', at: '2026-09-29T00:00:00Z', fired: 0, once: false, spent: false },
  ],
} as unknown as TreePayload

const scene = location.hash.replace(/^#/, '') || 'canvas'
const host = document.getElementById('root')!

if (scene.startsWith('settings')) {
  // the v3 desktop bridge, so the startup choice renders the way it does in
  // the shipped shell (it is absent in a plain browser by design)
  ;(window as unknown as { orgtreeDesktop: unknown }).orgtreeDesktop = {
    requestOrg: () => Promise.resolve(),
    onEvent: () => () => {},
    getPreferences: () => Promise.resolve({ startupMode: 'restore' }),
    setPreferences: (p: unknown) => Promise.resolve(p),
    getAppVersion: () => Promise.resolve('3.0.0-alpha.0'),
  }
  const tab = scene.slice('settings-'.length) || undefined
  createRoot(host).render(
    <AccountsPanel toast={() => {}} close={() => {}}
      initialTab={tab as Parameters<typeof AccountsPanel>[0]['initialTab']} />)
} else {
  // #pinned: the canvas with coordinator's desk PINNED — the look the
  // Attention view's desk panel is meant to share (docket
  // v3-agents-list-desk-panel-reuse-the-pinned-agent)
  localStorage.removeItem(pinsKey(SLUG))
  if (scene.endsWith('-restored')) {
    // restored windows exist only in the desktop shell
    ;(window as unknown as { orgtreeDesktop: unknown }).orgtreeDesktop = {
      onEvent: () => () => {}, getPreferences: () => Promise.resolve({}),
    }
    localStorage.setItem(WINDOW_LAYOUT_KEY, JSON.stringify([{
      key: 'restored-reviewer', kind: `desk:${JSON.stringify([SLUG, 'reviewer', 0])}`, org: SLUG,
      open: true, rect: { x: 0, y: 0, width: 800, height: 700 } }]))
  }
  if (scene === 'pinned') addPin(SLUG, 'coordinator', { x: 40, y: 40, w: 640, h: 760 })
  const attention = scene.startsWith('attention')
  setOrgView(SLUG, attention ? 'attention' : 'canvas')
  setAttentionLayout(SLUG, { split: 0.38, agent: 'coordinator', listOpen: false })
  createRoot(host).render(
    <CurrentOrg.Provider value={SLUG}>
      <div className="app">
        <main className="solo">
          <div className="canvas-stage">
            <OrgCanvas tree={tree} op={() => Promise.resolve({} as never)}
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
}
