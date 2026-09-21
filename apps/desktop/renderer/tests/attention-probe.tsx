// attention-probe.tsx — the Attention view's GEOMETRY, measured in a real
// Chromium instead of asserted structurally.
//
//   node tools/run-probe.mjs apps/desktop/renderer/tests/attention-probe.tsx <outdir>
//
// WHY THIS EXISTS. Every claim in attentionview.test.tsx and
// attentiondesk.test.tsx about SHAPE is structural, because jsdom computes no
// layout: "the agents list does not cost the desk width" is asserted there as
// "the desk element is the same node and did not move in the tree", which is
// the falsifiable half of the claim but not the claim itself. The ticket's
// wording is about pixels — "rolls it out OVER the agent Desk rather than
// permanently consuming Desk width", "the margin between them is a draggable
// divider that resizes their relative widths" — so the honest way to close
// that gap is to measure it where there is a layout engine.
//
// ⚠ WHAT THIS PROBE DOES NOT COVER, so nobody reads more into a green result
// than it carries. It mounts `AttentionView` DIRECTLY, not the integrated
// application: nothing imports these modules yet (App.tsx and the OrgCanvas
// host render slot belong to other owners), so the real mode switch inside the
// shell, a real native pop-out, and coexistence with the canvas's own pinned
// windows are NOT exercised here and remain owed after integration. What is
// covered is this view's own layout, which is the part this file owns.
//
// ⚠ TWO FIXTURE CONCESSIONS, both stated rather than hidden:
//   · `fetch` is stubbed to answer the two feeds with nothing waiting. The
//     probe is about layout, and an empty queue still lays out its list and
//     pane; a probe that depended on a live engine would be a different and
//     much weaker test.
//   · `setPointerCapture` is stubbed to a no-op. Chromium throws
//     NotFoundError for a pointerId that was never a real pointer, which every
//     synthetic drag has. This is an artefact of dispatching events by hand,
//     not a property of the product: the surrounding code follows the app's
//     own idiom (see PinFrameInner in canvas/modalpin.tsx, which likewise
//     calls setPointerCapture unguarded and guards only the release).

import { createRoot } from 'react-dom/client'
import '../src/styles.css'
import type { CanvasNode, OpFn } from '../src/canvas/shared'
import { USER } from '../src/canvas/shared'
import type { TreePayload } from '../src/types'
import { pinModal } from '../src/canvas/modalpin'
import { CurrentOrg } from '../src/popout'
import { AttentionView, QUEUE_KIND } from '../src/attention/AttentionView'
import { setAttentionLayout, setOrgView } from '../src/attention/mode'

const SLUG = 'probe'

type Box = { x: number; y: number; w: number; h: number }
type Result = Record<string, unknown> & { done?: boolean; error?: string }
const PROBE: Result = {}
;(window as unknown as { PROBE: Result }).PROBE = PROBE
const phase = (p: string) => { document.title = p }

// ------------------------------------------------------------- the fixture
;(window as unknown as { fetch: unknown }).fetch = (url: string) => {
  const path = new URL(String(url), location.href).pathname
  const body = /\/work-items$/.test(path)
    ? { items: [], archived: [], backlogged: [],
        counts: { attention: 0, active: 0, archived: 0, backlogged: 0 } }
    : /\/inbox$/.test(path) ? { pending: [], delivered: [], sent: [] }
      : { ok: true }
  return Promise.resolve({
    ok: true, status: 200, headers: new Headers(),
    json: () => Promise.resolve(body),
  })
}
Element.prototype.setPointerCapture = function noop() { /* see the header */ }
Element.prototype.releasePointerCapture = function noop() { /* see the header */ }

const node = (id: string, parent: string | null, o: Partial<CanvasNode> = {}): CanvasNode => ({
  id, parent, tier: 'opus', state: 'live', generation: 0, children: [],
  seat: 1, grant: 10, free: 4, turns: [], lineage: [], audiences_held: [],
  scope: { tools: {}, add_dirs: [] }, ...o,
} as unknown as CanvasNode)

const map = new Map<string, CanvasNode>([
  node(USER, null, { tier: null, state: 'user' }),
  node('alpha', USER),
  node('beta', USER),
].map((n) => [n.id, n] as [string, CanvasNode]))

const tree = {
  slug: SLUG, name: 'Probe', epoch: 1, rev: 1, roots: [],
  work_items_summary: { attention: 0, active: 0 },
  user_inbox_count: 0, user_inbox_urgent_count: 0, asks: [], asks_open: 0,
  max_top_grant: 1000,
} as unknown as TreePayload

const op: OpFn = () => Promise.resolve({ ok: true } as never)

// -------------------------------------------------------------- measuring
const el = (sel: string) => document.querySelector(sel) as HTMLElement | null
const box = (sel: string): Box | null => {
  const e = el(sel)
  if (!e) return null
  const r = e.getBoundingClientRect()
  return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }
}
const shown = (sel: string): boolean => {
  const e = el(sel)
  if (!e) return false
  const r = e.getBoundingClientRect()
  return getComputedStyle(e).display !== 'none' && r.width > 0 && r.height > 0
}
const overlaps = (a: Box | null, b: Box | null): boolean =>
  !!a && !!b && a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y

/**
 * ⚠ TIMERS, NOT `requestAnimationFrame` — MEASURED, on the first run of this
 * probe. `tools/run-probe.mjs` opens the window with `show: false`, and a
 * hidden Chromium window does not paint, so rAF callbacks are throttled to
 * almost nothing. The mount phase (16 rAF ticks) crawled through, the hover
 * phase never finished, and the harness's own watchdog paused the renderer
 * twice and gave up at exit 9 — which reads exactly like a runaway render loop
 * in the component under test and is nothing of the kind.
 *
 * Layout does not need a paint: it is computed synchronously when something
 * reads `getBoundingClientRect`, so a macrotask after React has committed is
 * enough for the measurements here. Anything that genuinely needed a painted
 * frame would need `show: true`, and would be a different probe.
 */
const tick = (ms = 16) => new Promise<void>((r) => { setTimeout(r, ms) })
const settle = async (n = 4) => { for (let i = 0; i < n; i++) await tick() }

const pointer = (target: Element, type: string, clientX: number, clientY: number) => {
  target.dispatchEvent(new PointerEvent(type, {
    bubbles: true, cancelable: true, composed: true,
    pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: type === 'pointerup' ? 0 : 1,
    clientX, clientY,
  }))
}

// ------------------------------------------------------------------- run
async function run() {
  setOrgView(SLUG, 'attention')
  setAttentionLayout(SLUG, { split: 0.38, agent: 'alpha', listOpen: false })

  phase('mount')
  const host = document.getElementById('root')!
  // a real stage needs a real box: the host slot gives the view the height and
  // width the canvas-stage would, which is what `flex` is dividing up
  host.style.cssText = 'position:absolute;inset:0;display:flex'
  // ⚠ `CurrentOrg` IS NOT DECORATION. PinFrame reads it (`useCurrentOrg`) and
  // renders `pinnable={false}` with NO MovableSurface at all when it is absent
  // — so without this provider the panels cannot pin and cannot pop out, and
  // every "pinned" assertion below would pass over an ordinary inline panel.
  // The first run of this probe did exactly that: it reported the "pinned"
  // panel at the stage slot's own box instead of the pin rect.
  createRoot(host).render(
    <CurrentOrg.Provider value={SLUG}>
      <AttentionView slug={SLUG} tree={tree} op={op} toast={() => {}} map={map} />
    </CurrentOrg.Provider>)
  await settle(8)

  PROBE.mounted = {
    stage: box('.attn-stage'), queue: box('.attn-panel-queue'), desk: box('.attn-panel-desk'),
    divider: box('.attn-divider'), list: box('.attn-list'), pane: box('.attn-pane'),
  }

  // ---- 1. the queue's list and pane are side by side, neither collapsed
  const list = box('.attn-list'), pane = box('.attn-pane')
  PROBE.queueLayout = {
    listWidth: list?.w ?? 0, paneWidth: pane?.w ?? 0,
    sideBySide: !!list && !!pane && pane.x >= list.x + list.w - 2,
    neitherCollapsed: (list?.w ?? 0) > 40 && (pane?.w ?? 0) > 40,
  }

  // ---- 2. rolling the agents list out must not cost the Desk any width
  phase('hover')
  const deskBefore = box('.attn-desk')
  const agents = el('.attn-agents')!
  const ab = agents.getBoundingClientRect()
  pointer(agents, 'pointerover', ab.left + 4, ab.top + 20)
  await settle(10)
  const deskAfter = box('.attn-desk')
  const listOut = box('.attn-agents')
  PROBE.rollOut = {
    opened: !!el('.attn-agents-wrap.list-open'),
    deskBefore, deskAfter,
    // THE MEASURED CLAIM: the desk's box is unchanged by the roll-out
    deskWidthUnchanged: deskBefore?.w === deskAfter?.w,
    deskLeftUnchanged: deskBefore?.x === deskAfter?.x,
    listBox: listOut,
    listVisible: shown('.attn-agents'),
    // …and the list is OVER the desk, which is the other half of the wording
    listOverlapsDesk: overlaps(listOut, deskAfter),
  }
  pointer(agents, 'pointerout', ab.left - 40, ab.top + 20)
  await settle(6)
  PROBE.retracted = { closed: !el('.attn-agents-wrap.list-open'), desk: box('.attn-desk') }

  // ---- 3. the divider really resizes the two panels
  phase('drag')
  const stage = box('.attn-stage')!
  const divider = el('.attn-divider')!
  const before = { queue: box('.attn-slot-queue'), desk: box('.attn-slot-desk') }
  const d0 = divider.getBoundingClientRect()
  const targetX = Math.round(stage.x + stage.w * 0.6)
  pointer(divider, 'pointerdown', Math.round(d0.left + d0.width / 2), Math.round(d0.top + d0.height / 2))
  pointer(divider, 'pointermove', targetX, Math.round(d0.top + d0.height / 2))
  await settle(6)
  const during = { queue: box('.attn-slot-queue'), desk: box('.attn-slot-desk') }
  pointer(divider, 'pointerup', targetX, Math.round(d0.top + d0.height / 2))
  await settle(6)
  const after = { queue: box('.attn-slot-queue'), desk: box('.attn-slot-desk') }
  PROBE.drag = {
    stageWidth: stage.w, targetX, before, during, after,
    queueGrew: (after.queue?.w ?? 0) > (before.queue?.w ?? 0),
    deskShrank: (after.desk?.w ?? 0) < (before.desk?.w ?? 0),
    // the two slots plus the divider still fill the stage — a resize that lost
    // or invented width would show up here and nowhere else
    fillsStage: Math.abs(((after.queue?.w ?? 0) + (after.desk?.w ?? 0)
      + (box('.attn-divider')?.w ?? 0)) - stage.w) <= 2,
    // the drag asked for 60% of the stage; the panel should be about that
    queueFraction: Number((((after.queue?.w ?? 0) / stage.w)).toFixed(3)),
  }

  // ---- 4. a pinned panel stays VISIBLE while the hidden stage is display:none
  phase('pin')
  pinModal(QUEUE_KIND, { x: 40, y: 40, w: 420, h: 480 }, SLUG)
  await settle(8)
  PROBE.pinnedInAttention = { queueVisible: shown('.attn-panel-queue'), box: box('.attn-panel-queue') }

  setOrgView(SLUG, 'canvas')
  await settle(8)
  const stageEl = el('.attn-stage')
  PROBE.pinnedOnCanvas = {
    stageDisplay: stageEl ? getComputedStyle(stageEl).display : null,
    // THE RETENTION CLAIM, MEASURED: the stage is gone from layout and the
    // pinned panel the user placed is still a real box on screen
    stageHidden: stageEl ? getComputedStyle(stageEl).display === 'none' : false,
    queueVisible: shown('.attn-panel-queue'),
    queueBox: box('.attn-panel-queue'),
    deskPresent: !!el('.attn-panel-desk'),
  }

  phase('done')
  PROBE.done = true
}

run().catch((e: unknown) => {
  PROBE.error = String((e as Error)?.stack ?? e)
  PROBE.done = true
  phase('error')
})
