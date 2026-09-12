// trayheight.dump.tsx — the markup half of `trayheight_probe.py`.
//
// The REAL <OrgCanvas/> with its agents tray OPEN and a lot of agents in it,
// dumped as static HTML so a real browser can lay it out against the real
// styles.css. Nothing about the chain under test is re-declared here: the
// `.viewport > .tray-wrap > .surface-inline > .tray-panel > .tray` nesting,
// every class on it and every row inside it come from the components the
// product ships. Only the number of agents and the surface's state (ordinary,
// or pinned) are fixture.
//
//   node tests/trayheight_dump.mjs <out.html> [rows=40] [state=inline|pinned]

import '../tests/harness'
import { writeFileSync } from 'node:fs'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { OrgCanvas } from '../src/canvas/OrgCanvas'
import { CurrentOrg } from '../src/popout'
import { MODAL_PINS_KEY, modalPinKey } from '../src/canvas/modalpin'
import type { TreePayload } from '../src/types'

const asTree = (v: unknown) => v as TreePayload

/** shaped like the payload, trimmed to what OrgCanvas dereferences — the same
 *  fixture idiom agentstray.test.tsx uses */
function tree(nodeIds: string[]): TreePayload {
  const mk = (id: string) => ({
    id, title: id, tier: 'haiku', model_id: 'haiku', state: 'live',
    seat: 1, grant: 0, free: 0, ui_order: 0, cost_usd: 0, occupancy: null,
    context_window: null, charter: null, mail_pending: 0, limit_locked: false,
    last_status: null, prev_status: null, inflight_at: null, last_denials: [],
    turns: [], frozen: null, audiences_held: [], bearer_state: null,
    generation: 0, children: [], lineage: [],
    scope: { permission_mode: 'default', add_dirs: [], tools: {}, org_visibility: 'team' },
  })
  return asTree({
    slug: 'mine', name: 'mine', workspace: null, dirs: [], max_top_grant: 1000,
    default_top_grant: 50, compact_at: 0, default_tools: null,
    default_visibility: 'team', default_effort: '', credit_requests: [],
    tiers: { haiku: 1, sonnet: 3, opus: 5, fable: 10 }, audiences: [],
    roots: nodeIds.map(mk), cost_usd_total: 0,
    audit: { live_nodes: nodeIds.length, top_level_holds: 0, no_overdraft: true, problems: [] },
    user_inbox_count: 0, user_inbox_newest: null, fable_lock: null,
    spend_frozen: false, storage_blocked: false, auto_resume: false,
    fable_limit_policy: 'freeze', fable_filter_policy: 'halt',
    cascade_hire: false, cascade_alloc: true, sandboxed: false,
    audience_requests: [], org_inbox: null, net: null,
  })
}

const dest = process.argv[2]
if (!dest) {
  console.error('usage: node tests/trayheight_dump.mjs <out.html> [rows] [state]')
  process.exit(2)
}
const rows = Number(process.argv[3] || '40') || 40
const state = process.argv[4] || 'inline'

// REAL AGENT-NAME LENGTHS: a tray of `a1`-style stubs is narrower than the
// panel's own min-width and would measure a box the product never draws.
const NAMES = Array.from({ length: rows }, (_, i) =>
  ['coordinator-astra', 'zoom-actions', 'backlog-ui', 'update-glow',
   'generation-owner', 'ticket-descriptions', 'view-performance',
   'support-luna'][i % 8] + '-' + String(i + 1).padStart(2, '0'))

/** the canvas box the pinned fixture pretends to have been measured in — the
 *  1180x760 window `trayheight_probe.py` opens, less its 44px header. */
export const PINNED_CANVAS = { x: 0, y: 44, w: 1180, h: 716 }
/** the pinned rect, in canvas coordinates: TALLER than any capped embedded
 *  surface could be in this canvas, and still legal (it fits), so a cap that
 *  leaked out of the embedded state would visibly shrink it. */
export const PINNED_RECT = { x: 120, y: 16, w: 320, h: 690 }

// ⚠ PINNED IS SET THE WAY THE APP SETS IT — through the persisted pin store
// modalpin.tsx reads on mount, not by hand-adding a class. `agent-list` is the
// surface kind OrgCanvas passes to PinFrame, and `modalPinKey` is what keys it
// per organization.
//
// ⚠ AND THE CANVAS HAS TO BE MEASURABLE, or the pin is meaningless. A pinned
// surface is positioned inside a wrapper the size of the canvas (`bounds`,
// read from `[data-pin-org]` via useCanvasBox) with `overflow: clip`; jsdom
// reports every box as 0x0, so without this stub the dump would bake a 0x0
// wrapper and clip the window it exists to measure. Only the CANVAS is
// stubbed, and only for this state — everything the probe actually measures
// is laid out by the browser afterwards.
if (state === 'pinned') {
  localStorage.setItem(MODAL_PINS_KEY, JSON.stringify(
    { [modalPinKey('agent-list', 'mine')]: { rect: PINNED_RECT, z: 0 } }))
  const real = HTMLElement.prototype.getBoundingClientRect
  HTMLElement.prototype.getBoundingClientRect = function () {
    if (this.dataset?.pinOrg) {
      const { x, y, w, h } = PINNED_CANVAS
      return { x, y, left: x, top: y, right: x + w, bottom: y + h,
        width: w, height: h, toJSON: () => ({}) } as DOMRect
    }
    return real.call(this)
  }
}

const host = document.createElement('div')
// the app's own chain around the canvas (App.tsx: `.canvas-stage` holds the
// drag margin and the viewport). Reproduced because the canvas's height —
// smaller than the window's, by the header above it — is the whole question.
host.className = 'canvas-stage'
document.body.appendChild(host)
const root = createRoot(host)
flushSync(() => {
  root.render(
    <CurrentOrg.Provider value="mine">
      <OrgCanvas tree={tree(NAMES)} op={() => Promise.resolve({} as never)}
        slug="mine" toast={() => {}} mailEvt={null} />
    </CurrentOrg.Provider>)
})

setTimeout(() => {
  const toggle = document.querySelector('.tray-toggle') as HTMLElement | null
  if (!toggle) {
    console.error('no .tray-toggle rendered — the dump would measure nothing')
    process.exit(3)
  }
  flushSync(() => { toggle.click() })
  setTimeout(() => {
    // ⚠ document-, not host-scoped: a PINNED surface is portaled to the pin
    // layer, outside the canvas stage this host holds.
    const tray = document.querySelector('.tray')
    if (!tray) {
      console.error('the tray did not open — the dump would measure nothing')
      process.exit(3)
    }
    const n = document.querySelectorAll('.tray-row').length
    if (n < rows) {
      console.error(`only ${n} of ${rows} agent rows rendered`)
      process.exit(3)
    }
    // ⚠ THE PINNED SURFACE IS PORTALED OUT OF THE WRAP — that is exactly the
    // exclusion under test — so the pinned page has to dump the whole body,
    // not just the canvas stage, or the window would not be in the file.
    const html = state === 'pinned' ? document.body.innerHTML : host.outerHTML
    writeFileSync(dest, html, 'utf8')
    console.log(`wrote ${dest} (${html.length} bytes, ${n} rows, ${state})`)
    process.exit(0)
  }, 30)
}, 30)
