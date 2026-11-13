// restoreddesk.test.tsx — Unit/DOM/CSS guards for `.popout-recovery.restored-desk`
// (@item:orgtree/4-5-13-alpha-1-unity-org-window-stuck-on-a-resto).
//
// Complements restoreddesk.capture.cjs (which proves real Electron WM_NCHITTEST
// and Chromium pointer-capture input in Session 0) with fast renderer regression
// checks for:
//   1. CSS app-region specificity on `.popout-recovery` without breaking
//      scrolled-content title-bar drag (pinscrolldrag invariant)
//   2. `.viewport` pointer-capture & wheel-zoom isolation on `.restored-desk`
//   3. `"Return to canvas"` closing the saved layout row (`open: false`),
//      redocking any detached desk window, removing `.restored-desk`, and
//      focusing the agent's desk on the canvas with drafts intact.
import { FakeServer, flush, inAct, installFetch, JSDOM, mountView } from './harness'
import { installBridge, removeBridge, typeInto } from './shellbridge'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { OrgCanvas } from '../src/canvas/OrgCanvas'
import { forgetModalOpenCache, forgetModalPins } from '../src/canvas/modalpin'
import { CurrentOrg } from '../src/popout'
import { endWindowExit, savedWindows, WINDOW_LAYOUT_KEY, windowLayoutKey } from '../src/windowlayout'
import { openSurfaces, resetActionDocument } from '../src/windowlife'
import type { OpResult, TreePayload } from '../src/types'

declare const __SRC_DIR__: string

const SLUG = 'unity'
const AGENT = 'ascii-pup'
const DESK_KIND = `desk:${JSON.stringify([SLUG, AGENT, 0])}`
const LAYOUT_KEY = windowLayoutKey(DESK_KIND, SLUG)

if (!(window as unknown as { PointerEvent?: unknown }).PointerEvent) {
  class FakePointerEvent extends window.MouseEvent {
    pointerId: number
    constructor(type: string, init: MouseEventInit & { pointerId?: number } = {}) {
      super(type, init)
      this.pointerId = init.pointerId ?? 1
    }
  }
  Object.defineProperty(window, 'PointerEvent', { configurable: true, writable: true, value: FakePointerEvent })
  Object.defineProperty(globalThis, 'PointerEvent', { configurable: true, writable: true, value: FakePointerEvent })
}

function mkTree(): TreePayload {
  const mk = (id: string) => ({
    id, title: id, tier: 'opus', model_id: 'opus', state: 'live',
    seat: 1, grant: 0, free: 0, ui_order: 0, cost_usd: 0, occupancy: null,
    context_window: null, charter: null, mail_pending: 0, limit_locked: false,
    last_status: null, prev_status: null, inflight_at: null, last_denials: [],
    turns: [], frozen: null, audiences_held: [], bearer_state: null,
    generation: 0, children: [], lineage: [],
    scope: { permission_mode: 'default', add_dirs: [], tools: { bash: true, web: false, edit: true, subagents: false, mcp: [] }, org_visibility: 'team' },
  })
  return {
    slug: SLUG, name: 'Unity', workspace: null, dirs: [], max_top_grant: 1000,
    default_top_grant: 50, compact_at: 0, default_tools: null,
    default_visibility: 'team', default_effort: 'medium', credit_requests: [],
    tiers: { haiku: 1, sonnet: 3, opus: 5, fable: 10 }, audiences: [],
    roots: [mk('coordinator'), mk(AGENT)],
    cost_usd_total: 0,
    audit: { live_nodes: 2, top_level_holds: 0, no_overdraft: true, problems: [] },
    user_inbox_count: 0, user_inbox_newest: null, fable_lock: null,
    auto_resume: false,
    fable_limit_policy: 'freeze', fable_filter_policy: 'halt',
    cascade_hire: false, cascade_alloc: true,
    audience_requests: [], org_inbox: null, net: null,
    work_items_summary: { attention: 0, active: 0 }, asks: [], asks_open: 0,
    watchdogs: [],
  } as unknown as TreePayload
}

function seedSavedDesk() {
  localStorage.clear()
  forgetModalPins()
  forgetModalOpenCache()
  resetActionDocument()
  endWindowExit()
  localStorage.setItem(WINDOW_LAYOUT_KEY, JSON.stringify([{
    key: LAYOUT_KEY,
    kind: DESK_KIND,
    org: SLUG,
    open: true,
    restore: { agent: AGENT, generation: 0 },
    rect: { x: 140, y: 120, width: 760, height: 640 },
  }]))
}

function installCanvasFetch() {
  const previous = globalThis.fetch
  const server = new FakeServer()
  installFetch(server)
  const inner = globalThis.fetch
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const p = String(url)
    if (/\/inbox(?:\?|$)/.test(p)) {
      return new Response(JSON.stringify({ pending: [], delivered: [], sent: [] }), { status: 200 })
    }
    if (/\/providers(?:\?|$)/.test(p)) {
      return new Response(JSON.stringify({ providers: [] }), { status: 200 })
    }
    if (/\/accounts/.test(p)) {
      return new Response(JSON.stringify({ accounts: [] }), { status: 200 })
    }
    return inner(url, init)
  }) as typeof fetch
  return () => { globalThis.fetch = previous }
}

test('CSS: .popout-recovery cuts a no-drag hole inside .canvas-stage > .viewport without setting descendant app-regions', () => {
  const css = readFileSync(path.join(__SRC_DIR__, 'styles.css'), 'utf8')
  const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map((m) => ({ selectors: m[1]!.split(',').map((s) => s.trim()), body: m[2]! }))
  const region = (body: string) => /-webkit-app-region:\s*([\w-]+)/.exec(body)?.[1] ?? null

  const own = rules.filter((r) => r.selectors.includes('.popout-recovery'))
  assert.ok(own.some((r) => region(r.body) === 'no-drag'), '.popout-recovery must declare -webkit-app-region: no-drag')

  // `.canvas-stage > .viewport *` has specificity (0,2,0) and resets every descendant to `initial`;
  // `.canvas-stage > .viewport .popout-recovery` (0,3,0) must override it on the panel's own box.
  const inViewport = rules.filter((r) => r.selectors.includes('.canvas-stage > .viewport .popout-recovery'))
  assert.ok(
    inViewport.some((r) => region(r.body) === 'no-drag'),
    '.canvas-stage > .viewport .popout-recovery must declare -webkit-app-region: no-drag',
  )

  for (const r of rules) {
    for (const s of r.selectors) {
      if (/popout-recovery.*\*/.test(s) || /restored-desk.*\*/.test(s)) {
        assert.equal(region(r.body), null, `${s} must not set -webkit-app-region on scrolled descendants`)
      }
    }
  }
})

test('docked .restored-desk isolates pointerdown and wheel from .viewport, and Return to canvas closes the saved row and focuses the agent', async () => {
  seedSavedDesk()
  const restoreFetch = installCanvasFetch()
  installBridge({
    getWindowState: async () => ({ visible: true, focused: true, restoreWindows: false }),
    getWindowControlsState: async () => ({ visible: true, minimized: false, maximized: false }),
  })
  const tree = mkTree()
  const v = await mountView(
    <CurrentOrg.Provider value={SLUG}>
      <div className="canvas-stage">
        <OrgCanvas tree={tree} op={async () => ({} as OpResult)} slug={SLUG} toast={() => {}} mailEvt={null} />
      </div>
    </CurrentOrg.Provider>,
    (el) => el,
  )
  try {
    await inAct(async () => { await flush(6) })
    const viewport = v.el.querySelector<HTMLDivElement>('.viewport')!
    assert.ok(viewport, 'viewport mounted')
    viewport.getBoundingClientRect = () => ({
      left: 0, top: 49, right: 1100, bottom: 749, width: 1100, height: 700, x: 0, y: 49, toJSON: () => ({}),
    })
    const captured: number[] = []
    viewport.setPointerCapture = (id: number) => { captured.push(id) }

    const panel = v.el.querySelector<HTMLDivElement>('.popout-recovery.restored-desk')!
    assert.ok(panel, 'restored-desk panel mounted')
    const returnBtn = panel.querySelector<HTMLButtonElement>('.row button')!
    assert.equal(returnBtn.textContent, 'Return to canvas')

    // 1. pointerdown on "Return to canvas" must NOT reach .viewport's setPointerCapture
    const PEvent = (window as unknown as { PointerEvent: typeof MouseEvent }).PointerEvent
    await inAct(async () => {
      returnBtn.dispatchEvent(new PEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, pointerId: 7 } as MouseEventInit))
      await flush(2)
    })
    assert.deepEqual(captured, [], '.viewport must not capture pointerdown originating inside .restored-desk')

    // 2. wheel inside .restored-desk must NOT be preventDefault()ed by .viewport's zoom handler
    const wheel = new window.WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -120, clientX: 120, clientY: 120 })
    panel.dispatchEvent(wheel)
    assert.equal(wheel.defaultPrevented, false, 'wheel inside .restored-desk must scroll the panel rather than zoom the canvas')

    // 3. Type a draft in .restored-desk's composer and click "Return to canvas"
    const composer = panel.querySelector<HTMLTextAreaElement>('textarea')!
    assert.ok(composer, 'docked restored desk holds the composer')
    await inAct(async () => {
      typeInto(composer as unknown as HTMLInputElement, 'kept-docked-draft')
      await flush(3)
    })
    await inAct(async () => {
      returnBtn.click()
      await new Promise((r) => setTimeout(r, 480))
      await flush(6)
    })

    assert.equal(v.el.querySelector('.popout-recovery.restored-desk'), null, '.restored-desk is dismissed')
    assert.equal(savedWindows().find((r) => r.key === LAYOUT_KEY)?.open, false, 'saved window layout row is marked closed')
    const canvasComposer = v.el.querySelector<HTMLTextAreaElement>('.desk-over textarea')
    assert.ok(canvasComposer, 'agent desk is focused on the canvas')
    assert.equal(canvasComposer.value, 'kept-docked-draft', 'composer draft survives Return to canvas')
  } finally {
    await v.unmount()
    removeBridge()
    restoreFetch()
    localStorage.clear()
    endWindowExit()
    resetActionDocument()
  }
})

test('detached .restored-desk Return to canvas redocks the popout window, marks layout closed, and focuses the desk on canvas', async () => {
  seedSavedDesk()
  const restoreFetch = installCanvasFetch()
  const childDom = new JSDOM('<html><head></head><body></body></html>', { url: 'http://localhost/' })
  const childWin = childDom.window as unknown as Window
  Object.defineProperties(childWin, {
    screenX: { value: 140 }, screenY: { value: 120 }, outerWidth: { value: 760 }, outerHeight: { value: 640 },
    closed: { value: false, writable: true },
  })
  childWin.focus = () => {}
  childWin.requestAnimationFrame = () => 1
  childWin.cancelAnimationFrame = () => {}
  const nativeClose = () => {
    ;(childWin as unknown as { closed: boolean }).closed = true
    childWin.dispatchEvent(new childDom.window.Event('pagehide'))
  }
  const origClose = childWin.close.bind(childWin)
  childWin.close = nativeClose
  const origOpen = window.open
  window.open = (() => childWin) as typeof window.open
  const origObserver = globalThis.MutationObserver
  globalThis.MutationObserver = childDom.window.MutationObserver

  installBridge({
    getWindowState: async () => ({ visible: true, focused: true, restoreWindows: true }),
    getWindowControlsState: async () => ({ visible: true, minimized: false, maximized: false }),
    minimizePopout: async () => {},
    toggleMaximizePopout: async () => {},
    closePopout: async () => nativeClose(),
  })

  const tree = mkTree()
  const v = await mountView(
    <CurrentOrg.Provider value={SLUG}>
      <div className="canvas-stage">
        <OrgCanvas tree={tree} op={async () => ({} as OpResult)} slug={SLUG} toast={() => {}} mailEvt={null} />
      </div>
    </CurrentOrg.Provider>,
    (el) => el,
  )
  try {
    await inAct(async () => { await flush(8) })
    const viewport = v.el.querySelector<HTMLDivElement>('.viewport')!
    viewport.getBoundingClientRect = () => ({
      left: 0, top: 49, right: 1100, bottom: 749, width: 1100, height: 700, x: 0, y: 49, toJSON: () => ({}),
    })

    assert.equal(openSurfaces().length, 1, 'popout desk window restored open')
    const detachedComposer = childWin.document.querySelector<HTMLTextAreaElement>('textarea')!
    assert.ok(detachedComposer, 'composer lives in the popped-out window')
    await inAct(async () => {
      typeInto(detachedComposer as unknown as HTMLInputElement, 'kept-detached-draft')
      await flush(3)
    })

    const returnBtn = v.el.querySelector<HTMLButtonElement>('.popout-recovery.restored-desk .row button')!
    assert.equal(returnBtn.textContent, 'Return to canvas')
    await inAct(async () => {
      returnBtn.click()
      await new Promise((r) => setTimeout(r, 480))
      await flush(6)
    })

    assert.equal(openSurfaces().length, 0, 'Return to canvas redocks and closes the detached popout window')
    assert.equal((childWin as unknown as { closed: boolean }).closed, true, 'child window closed')
    assert.equal(v.el.querySelector('.popout-recovery.restored-desk'), null, '.restored-desk removed')
    assert.equal(savedWindows().find((r) => r.key === LAYOUT_KEY)?.open, false, 'saved layout row marked closed')
    const canvasComposer = v.el.querySelector<HTMLTextAreaElement>('.desk-over textarea')
    assert.equal(canvasComposer, detachedComposer, 'the SAME composer element returned to the canvas desk')
    assert.equal(canvasComposer?.value, 'kept-detached-draft', 'draft preserved across redock')
  } finally {
    await v.unmount()
    removeBridge()
    window.open = origOpen
    globalThis.MutationObserver = origObserver
    origClose()
    restoreFetch()
    localStorage.clear()
    endWindowExit()
    resetActionDocument()
  }
})
