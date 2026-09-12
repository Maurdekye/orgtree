// agentstray.test.tsx — the AGENTS tray's bottom-left panel (user bug
// 2026-08-21): its max height was capped far short of the canvas, and
// hovering it to scroll zoomed the canvas instead.
//
// The mechanism: OrgCanvas attaches a NATIVE (non-passive) wheel listener to
// `.viewport` for pan/zoom, and always called `preventDefault()` unless the
// event target sat inside `.overlay` or `.desk-over`. `.tray` was not on that
// allowlist, so a wheel over the agents list was captured for zoom before the
// browser ever got a chance to scroll the (already overflow-y:auto) list.
//
// This only proves the fix at the DOM-event layer: jsdom does no layout, so
// it cannot show the list visually scrolling or the CSS max-height resolving
// against the canvas's real pixel height (see render.test.tsx's "jsdom does
// no layout" notes throughout). Two things this DOES prove: (1) a wheel event
// over the tray is no longer preventDefault()'d — which is what lets the
// browser's native overflow-y:auto scroll the list — and the canvas's own
// camera transform is provably untouched by it; (2) the CSS actually ships a
// canvas-bound (not viewport-fraction) max-height, read back from the real
// stylesheet the app ships.
//
// Run:  cd frontend && node tests/run.mjs agentstray

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { advance, flush, inAct, mountView, realClock, useFakeClock } from './harness'
import { JSDOM } from 'jsdom'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import type { TreePayload } from '../src/types'
import type { CanvasNode } from '../src/canvas/shared'
import { MODAL_OPEN_KEY, MODAL_PINS_KEY, forgetModalOpenCache, forgetModalPins, pinModal, rememberModalOpen } from '../src/canvas/modalpin'
import { savedWindows, WINDOW_LAYOUT_KEY } from '../src/windowlayout'

const noop = () => {}
const txt = (el: HTMLElement) => el.textContent ?? ''

function uiTest(name: string,
  body: (k: { mount: (el: React.ReactElement)
    => Promise<{ el: HTMLElement; unmount: () => Promise<void> }> }) => Promise<void>): void {
  test(name, async (t: TestContext) => {
    useFakeClock()
    const open: { unmount: () => Promise<void> }[] = []
    t.after(async () => {
      for (const m of open) { try { await m.unmount() } catch { /* gone */ } }
      realClock()
    })
    await body({
      mount: async (el) => {
        const v = await mountView(el, (host) => host)
        open.push(v)
        return v
      },
    })
  })
}

/** shaped like the payload, not type-checked into it — see mailwire.test.tsx,
 *  same fixture idiom, trimmed to what OrgCanvas actually dereferences */
const asTree = (v: unknown) => v as TreePayload

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

/** the canvas's camera transform — unaffected wheel events must leave this
 *  string byte-identical; a zoom rewrites both the scale() and translate() */
function spaceTransform(el: HTMLElement): string {
  const space = el.querySelector('.space') as HTMLElement | null
  assert.ok(space, 'the canvas world element (.space) did not render')
  return space!.style.transform
}

uiTest('§1 a wheel over the agents tray is not captured for canvas zoom',
  async ({ mount }) => {
    const { OrgCanvas } = await import('../src/canvas/OrgCanvas')
    const { el } = await mount(
      <OrgCanvas tree={tree(['ceo', 'cto'])} op={() => Promise.resolve({} as never)}
        slug="mine" toast={noop} mailEvt={null} />)
    await flush()
    const toggle = [...el.querySelectorAll('.tray-toggle')][0] as HTMLElement
    assert.ok(toggle, 'the agents toggle button rendered')
    assert.ok(txt(toggle).toLowerCase().includes('agents'), 'and it is labeled "agents"')
    await inAct(() => { toggle.click() })
    await flush()
    const tray = el.querySelector('.tray') as HTMLElement | null
    assert.ok(tray, 'the tray opened')
    const before = spaceTransform(el)

    // a real wheel gesture, over a row inside the tray — cancelable and
    // bubbling, exactly as the browser dispatches it
    const row = tray!.querySelector('.tray-row') as HTMLElement | null
    assert.ok(row, 'the fixture agents rendered as tray rows')
    const evt = new WheelEvent('wheel', {
      deltaY: 120, bubbles: true, cancelable: true,
    })
    row!.dispatchEvent(evt)

    assert.equal(evt.defaultPrevented, false,
      'the canvas wheel handler preventDefault()d a wheel over the tray — '
      + 'the browser can no longer run its own overflow-y:auto scroll there')
    assert.equal(spaceTransform(el), before,
      'the canvas camera moved in response to a wheel over the tray — it '
      + 'zoomed instead of the tray scrolling')
  })

uiTest('§2 a wheel over the empty canvas still zooms (the carve-out is scoped)',
  async ({ mount }) => {
    // the fix must not go the OTHER way either — the wheel handler still
    // owns pan/zoom everywhere outside the tray/overlay/desk carve-outs
    const { OrgCanvas } = await import('../src/canvas/OrgCanvas')
    const { el } = await mount(
      <OrgCanvas tree={tree(['ceo'])} op={() => Promise.resolve({} as never)}
        slug="mine" toast={noop} mailEvt={null} />)
    await flush()
    const viewport = el.querySelector('.viewport') as HTMLElement
    assert.ok(viewport, 'the canvas viewport rendered')
    const before = spaceTransform(el)
    const evt = new WheelEvent('wheel', {
      deltaY: -120, bubbles: true, cancelable: true,
      clientX: 50, clientY: 50,
    })
    await inAct(() => { viewport.dispatchEvent(evt) })
    await flush()
    assert.equal(evt.defaultPrevented, true,
      'a wheel on the bare canvas must still be captured for zoom')
    assert.notEqual(spaceTransform(el), before,
      'and the camera must actually have zoomed')
  })

uiTest('§2b a Codex agent row carries the provider-theme class for its context wheel',
  async ({ mount }) => {
    const { OrgCanvas } = await import('../src/canvas/OrgCanvas')
    const fixture = tree(['codex-agent'])
    fixture.roots[0]!.tier = 'sol'
    fixture.roots[0]!.model_id = 'gpt-5.6-sol'
    fixture.roots[0]!.occupancy = 58_000
    fixture.roots[0]!.context_window = 200_000
    const { el } = await mount(
      <OrgCanvas tree={fixture} op={() => Promise.resolve({} as never)}
        slug="mine" toast={noop} mailEvt={null} />)
    await flush()
    await inAct(() => { (el.querySelector('.tray-toggle') as HTMLElement).click() })
    await flush()
    const row = el.querySelector('.tray-row')
    assert.ok(row?.classList.contains('prov-openai'),
      'the Codex tray row lost its provider class, so its context wheel falls '
      + 'back to the global Claude-orange accent')
    assert.ok(row?.querySelector('.ctxwheel .fill'),
      'the fixture context wheel did not render')
  })

uiTest('every Claude tier in the Agents list uses the shared Claude theme',
  async ({ mount }) => {
    const { OrgCanvas } = await import('../src/canvas/OrgCanvas')
    const fixture = tree(['haiku-agent', 'sonnet-agent', 'opus-agent', 'fable-agent',
      'codex-agent', 'antigravity-agent'])
    const tiers = ['haiku', 'sonnet', 'opus', 'fable', 'sol', 'flash']
    fixture.roots.forEach((node, i) => {
      node.tier = tiers[i]!
      node.model_id = tiers[i]!
    })
    const { el } = await mount(
      <OrgCanvas tree={fixture} op={() => Promise.resolve({} as never)}
        slug="mine" toast={noop} mailEvt={null} />)
    await flush()
    await inAct(() => { (el.querySelector('.tray-toggle') as HTMLElement).click() })
    await flush()

    const rows = [...el.querySelectorAll('.tray-row')] as HTMLElement[]
    assert.equal(rows.length, tiers.length, 'all fixture agents rendered in the tray')
    for (const [i, tier] of tiers.entries()) {
      const row = rows[i]!
      assert.ok(row.classList.contains(i < 4 ? 'prov-claude'
        : i === 4 ? 'prov-openai' : 'prov-google'),
        `${tier} row uses the shared providerOf theme class`)
      assert.equal(row.classList.contains('prov-claude'), i < 4,
        `${tier} row does not receive the Claude class when it is non-Claude`)
    }
  })

// ------------------------------------------------------------------- height
// jsdom does no layout (see the file banner), so the CSS is read back from
// the real stylesheet the app ships, not from a computed box.

declare const __SRC_DIR__: string
const CSS = readFileSync(path.join(__SRC_DIR__, 'styles.css'), 'utf8')

function rule(selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(esc + String.raw`\s*\{([^}]*)\}`)
  const m = re.exec(CSS)
  assert.ok(m, `no "${selector}" rule found in styles.css`)
  return m![1]!
}

test('Claude tray rows bind the established Claude accent token', () => {
  assert.match(rule('.tray-row.prov-claude'),
    /--accent:\s*var\(--prov-claude\)/,
    'Claude rows must select the shared Claude provider token')
})

test('§3 the tray’s max-height is bound to the canvas, not a small fixed slice', () => {
  const trayCss = rule('.tray')
  assert.match(trayCss, /overflow-y:\s*auto/,
    'the tray must stay a real scroll container')
  const mh = /max-height:\s*([^;]+);/.exec(trayCss)
  assert.ok(mh, 'the tray declares a max-height at all')
  const value = mh![1]!.trim()
  assert.doesNotMatch(value, /^\d+vh$/,
    `"${value}" is a fixed viewport-height slice, not the canvas's own bound `
    + '— it under- or over-shoots whenever the header/canvas ratio changes')
  // the wrap must give .tray a definite containing-block height for a
  // percentage max-height to mean anything (a flex item's % height resolves
  // to nothing against an auto-height container) — asserted structurally so
  // a revert that keeps "100%" but drops `top` silently breaks it again
  //
  // ⚠ THE VALUE STOPPED BEING A BARE LITERAL on 2026-09-12: the bounded
  // anchor preference (canvas/canvasanchor.tsx) measures these offsets from
  // the rectangle pins leave free, so they read
  // `calc(var(--free-top, 0px) + 10px)`. THE GUARANTEE IS UNCHANGED and is
  // still exactly what is asserted here — both edges set, to something that
  // resolves to a length rather than `auto`. Checked by reading the two
  // declarations instead of pattern-matching their text, so the next legal
  // way of writing a length does not read as a regression either.
  const wrapCss = rule('.tray-wrap')
  const edge = (name: string) => {
    const line = wrapCss.split('\n').map(l => l.trim())
      .find(l => l.startsWith(name + ':'))
    assert.ok(line,
      `.tray-wrap needs both top and bottom set — bottom alone leaves its `
      + `height auto, and .tray’s max-height: 100% would resolve to nothing `
      + `(no \`${name}\` declaration found)`)
    assert.ok(line!.includes('px'),
      `.tray-wrap's \`${name}\` must resolve to a length, not auto: "${line}"`)
  }
  edge('top')
  edge('bottom')
})

// ═══════════════════════════════════════════════════════════════ §5-§7
// THE STATUS SUMMARY, and the references in it (Astra 2026-09-05).
//
// The tray line was excluded from the reference work on two grounds and
// Astra accepted neither: it was `summary.slice(0, 70)`, so a token past the
// 70th character was cut before it could be recognised, and the whole row was
// `role="button"`, so a chip could not be a control inside it without nesting
// one button in another. Both are fixed here rather than argued: the match
// runs over the WHOLE summary and the row is a container whose MAIN LINE is
// the button.
//
// ⚠ THE FIXTURE PUTS THE TOKEN PAST CHARACTER 70 ON PURPOSE. With it early in
// the sentence, every one of these checks passes on the OLD code too — the
// slice would simply not have reached it — and the section would prove
// nothing about the thing it is named after.

const LONG_SUMMARY =
  'rebased the branch, re-ran the affected suites and verified the line '
  + 'endings before landing @item:mine/sort-selector'

function treeWithStatus(ids: string[] = ['ceo']): TreePayload {
  const t = tree(ids)
  const root = (t as unknown as { roots: Record<string, unknown>[] }).roots[0]
  root.last_status = { status: 'working', summary: LONG_SUMMARY,
                       at: '2026-09-05T10:00:00.000Z' }
  return t
}

async function openTray(mount: (el: React.ReactElement) => Promise<{ el: HTMLElement }>,
                        onWorkItem?: (s: string) => void, ids?: string[]) {
  const { CurrentOrg } = await import('../src/popout')
  const { OrgCanvas } = await import('../src/canvas/OrgCanvas')
  const { el } = await mount(
    <CurrentOrg.Provider value="mine"><OrgCanvas tree={treeWithStatus(ids)} op={() => Promise.resolve({} as never)}
      slug="mine" toast={noop} mailEvt={null} onWorkItem={onWorkItem} /></CurrentOrg.Provider>)
  await flush()
  const toggle = el.querySelector('.tray-toggle') as HTMLElement
  await inAct(() => { toggle.click() })
  await flush()
  return el
}

uiTest('§5 a reference past the truncation point is still a control',
  async ({ mount }) => {
    const opened: string[] = []
    const el = await openTray(mount, (s) => { opened.push(s) })
    const sum = el.querySelector('.tray-sum') as HTMLElement | null
    assert.ok(sum, 'positive control: the row rendered its status summary')
    // the token really is past the old cut — otherwise this section is a
    // check on nothing
    assert.ok(LONG_SUMMARY.indexOf('@item:') > 70,
      'the fixture must place the token past the 70-character slice')
    const chip = sum!.querySelector('.ref-chip') as HTMLButtonElement | null
    assert.ok(chip, 'the summary carries no reference chip — the match is '
      + 'still running over a truncated copy')
    assert.equal(chip!.textContent, 'sort-selector')
    await inAct(() => { chip!.click() })
    assert.deepEqual(opened, ['sort-selector'], 'and it opens the item it names')
  })

uiTest('§6 the chip is a control, and it is not inside another control',
  async ({ mount }) => {
    // ⚠ THE ROUTE IS WIRED HERE ON PURPOSE. Without one the chip is correctly
    // a SPAN reading "not from here" — which is the outcome table working,
    // not a failure, and this section is about NESTING, not about outcomes.
    // (This check first ran without a route and failed for exactly that
    // reason; the fix was the fixture, not the code.)
    const el = await openTray(mount, () => {})
    const chip = el.querySelector('.tray-sum .ref-chip') as HTMLElement
    assert.ok(chip, 'no chip to judge')
    assert.equal(chip.tagName, 'BUTTON', 'a ready reference is a real control')
    // ⚠ THE NESTING RULE, ASSERTED AS DOM. Walk up from the chip: nothing
    // between it and the row may be a button or claim to be one.
    let p: HTMLElement | null = chip.parentElement
    while (p && !p.classList.contains('tray-row')) {
      assert.notEqual(p.tagName, 'BUTTON', `the chip sits inside a <${p.tagName}>`)
      assert.notEqual(p.getAttribute('role'), 'button',
        'the chip sits inside an element claiming to be a button')
      p = p.parentElement
    }
    assert.ok(p, 'the chip is not inside a tray row at all')
    assert.notEqual(p!.getAttribute('role'), 'button',
      'the ROW still claims to be a button, so every chip in it is nested')
    // and the control's control: the main line IS a button, so the row did
    // not simply lose its keyboard affordance
    const main = p!.querySelector('.tray-main')
    assert.ok(main, 'the row lost its main line')
    assert.equal(main!.tagName, 'BUTTON',
      'the row navigates by mouse only now — the keyboard route is gone')
  })

uiTest('§7 tray navigation survives: the row still goes to its agent',
  async ({ mount }) => {
    // ⚠ TWO AGENTS, AND THE SECOND ONE. With a single root the opening view
    // is already centred on it, so a working camera command produces no
    // movement and the check would fail on correct code. (It did.)
    const el = await openTray(mount, undefined, ['ceo', 'cto'])
    const rows = [...el.querySelectorAll('.tray-row .tray-main')] as HTMLElement[]
    assert.equal(rows.length, 2, 'positive control: both agents are in the tray')
    const primary = rows[1]!.parentElement
    assert.ok(primary?.classList.contains('tray-primary'), 'the main line stays in the primary row')
    // ⚠ AND NOTHING BESIDE IT (user ruling 2026-09-12). The row carried a ⌖
    // pin and an ↗ popout button here; both moved into the row's context menu,
    // where the rest of the agent's actions already were, so the row is one
    // object you press to go somewhere. The actions themselves are covered in
    // tests/agentrowmenu.test.tsx §7/§7b.
    const controls = primary?.querySelectorAll('.agent-list-control')
    assert.equal(controls?.length, 0,
      'the per-agent pin and popout buttons are gone from the row')
    // ⚠ SETTLE FIRST, THEN READ THE BEFORE. The camera is still animating from
    // mount, so a `before` taken immediately drifts on its own and the check
    // passes whether or not the click did anything — measured: the mutant that
    // removes the row's handler SURVIVED until this line existed.
    await advance(600, 16)
    await flush()
    const before = spaceTransform(el)
    await advance(600, 16)
    await flush()
    assert.equal(spaceTransform(el), before,
      'control for the control: with no click the camera is now still')
    await inAct(() => { rows[1].click() })
    await advance(600, 16)          // the glide is rAF-driven; let it finish
    await flush()
    assert.notEqual(spaceTransform(el), before,
      'clicking the row moved no camera — tray navigation is broken')
  })

uiTest('§8 desk jump cards keep navigation without list controls', async ({ mount }) => {
  const { NavChip } = await import('../src/canvas/desk')
  const report = { id: 'report', generation: 0, tier: 'haiku', state: 'live',
    busy: false, mail_pending: 0 } as CanvasNode
  let jumps = 0
  const chip = await mount(<NavChip n={report} dir="down" onJump={() => { jumps++ }} />)
  const jump = chip.el.querySelector<HTMLButtonElement>('.desk-nav-chip')
  assert.ok(jump, 'the direct-report jump card keeps its navigation button')
  assert.equal(chip.el.querySelector('.agent-list-controls'), null,
    'jump cards do not expose list pin/popout controls')
  await inAct(() => { jump!.click() })
  assert.equal(jumps, 1, 'clicking the jump card still navigates')
})

uiTest('§10 the whole agents list reuses the shared pin and popout surface controls', async ({ mount }) => {
  localStorage.removeItem(MODAL_PINS_KEY)
  const el = await openTray(mount, undefined, ['ceo', 'cto'])
  const panel = el.querySelector('.tray-panel')
  assert.ok(panel, 'the agents list is mounted in its own surface panel')
  assert.equal(panel!.closest('.overlay'), null, 'ordinary agents list must stay in place, without a modal backdrop')
  assert.equal(panel!.getAttribute('role'), 'region', 'ordinary list is not a dialog')
  assert.ok(panel!.closest('.tray-wrap'), 'ordinary list retains its original canvas anchor')
  const popout = panel!.querySelector('[aria-label="Open in new window"]')
  const pin = panel!.querySelector<HTMLButtonElement>('[aria-label="pin this to the window"]')
  assert.ok(popout, 'the whole list exposes the existing native popout control')
  assert.ok(pin, 'the whole list exposes the existing pin control')
  await inAct(() => { pin!.click() })
  await flush(3)
  const pinnedPanel = document.body.querySelector('.tray-panel')!
  const pinnedButton = pinnedPanel.querySelector('[aria-label="unpin this window"]')!
  assert.equal(pinnedButton.getAttribute('aria-pressed'), 'true', 'pinning updates the shared surface state')
  assert.ok(pinnedPanel.classList.contains('modalpin-win'), 'the list remains the same mounted surface when pinned')
  localStorage.removeItem(MODAL_PINS_KEY)
})
uiTest('§11 pinned agent lists ignore main dismissal, restore, close and scope by org', async ({ mount }) => {
  const { OrgCanvas } = await import('../src/canvas/OrgCanvas')
  const { CurrentOrg } = await import('../src/popout')
  const canvas = (ids: string[]) => <CurrentOrg.Provider value="mine"><OrgCanvas tree={treeWithStatus(ids)} op={() => Promise.resolve({} as never)}
    slug="mine" toast={noop} mailEvt={null} /></CurrentOrg.Provider>
  localStorage.clear()
  forgetModalPins(); forgetModalOpenCache()
  pinModal('agent-list', { x: 30, y: 30, w: 420, h: 300 }, 'mine')
  rememberModalOpen('agent-list', 'mine')
  const first = await mount(canvas(['ceo', 'cto']))
  await flush(5)
  assert.ok(document.body.querySelector('.tray-panel'), 'a pinned agent list restores into its owning org')
  await inAct(() => {
    document.body.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, cancelable: true }))
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
  await flush()
  assert.ok(document.body.querySelector('.tray-panel'),
    'main-window outside click and Escape must not dismiss a pinned list')
  const unpin = document.body.querySelector<HTMLButtonElement>('[aria-label="unpin this window"]')
  assert.ok(unpin, 'the pinned list exposes the shared unpin control')
  await inAct(() => { unpin!.click() })
  await flush(3)
  const openRows = JSON.parse(localStorage.getItem(MODAL_OPEN_KEY) || '[]') as { kind: string }[]
  assert.equal(openRows.some((r) => r.kind === 'agent-list'), false,
    'unpin clears the durable open marker')
  await inAct(() => {
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
  await flush()
  assert.equal(document.body.querySelector('.tray-panel'), null,
    'after unpin, ordinary centred Escape dismissal still closes the list')

  // A fresh mount models the renderer restart path: the pinned/open records
  // are the only inputs needed to reopen the list, not an in-memory flag.
  await first.unmount()
  pinModal('agent-list', { x: 30, y: 30, w: 420, h: 300 }, 'mine')
  rememberModalOpen('agent-list', 'mine')
  const restored = await mount(canvas(['ceo', 'cto']))
  await flush(5)
  assert.ok(document.body.querySelector('.tray-panel'),
    'a renderer restart restores the list from the pinned/open records')
  await restored.unmount()
  localStorage.removeItem(MODAL_OPEN_KEY); forgetModalOpenCache()
  rememberModalOpen('agent-list', 'other')
  const foreign = await mount(canvas(['ceo']))
  await flush(5)
  assert.equal(document.body.querySelector('.tray-panel'), null,
    'an open marker for another org must not reopen this org list')
})

uiTest('§12 a detached whole-agent list stays open through main clicks and redocks', async ({ mount }) => {
  const { OrgCanvas } = await import('../src/canvas/OrgCanvas')
  const { CurrentOrg } = await import('../src/popout')
  localStorage.clear(); forgetModalPins(); forgetModalOpenCache()
  localStorage.removeItem(WINDOW_LAYOUT_KEY)
  Object.defineProperty(window, 'orgtreeDesktop', { value: {}, configurable: true })
  const child = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'http://localhost/' })
  const childWindow = child.window as unknown as Window
  childWindow.focus = () => {}
  childWindow.requestAnimationFrame = () => 1
  childWindow.cancelAnimationFrame = () => {}
  const originalOpen = window.open
  const originalObserver = globalThis.MutationObserver
  window.open = (() => childWindow) as typeof window.open
  globalThis.MutationObserver = child.window.MutationObserver
  let view: Awaited<ReturnType<typeof mount>> | null = null
  try {
    view = await mount(<CurrentOrg.Provider value="mine"><OrgCanvas tree={treeWithStatus(['ceo', 'cto'])}
      op={() => Promise.resolve({} as never)} slug="mine" toast={noop} mailEvt={null} /></CurrentOrg.Provider>)
    await flush(5)
    const toggle = view.el.querySelector<HTMLButtonElement>('.tray-toggle')!
    await inAct(() => { toggle.click() })
    await flush(3)
    const panel = view.el.querySelector('.tray-panel') as HTMLElement | null
    assert.ok(panel, 'the centred list is mounted before opening its native window')
    const popout = panel!.querySelector<HTMLButtonElement>('[aria-label="Open in new window"]')
    assert.ok(popout, 'the list exposes the existing native popout action')
    await inAct(() => { popout!.click() })
    await flush(10)
    const childPanel = child.window.document.querySelector('.tray-panel') as HTMLElement | null
    assert.ok(childPanel, 'the whole list moved into the native child window')
    // ⚠ THE POPPED-OUT HALF OF THE EMBEDDED-ONLY HEIGHT CAP (see §13-§14).
    // Asserted here rather than in a section of its own because this is the
    // only place a really detached surface exists: PinFrame emits
    // `.surface-inline` for `inline && !pinned && !detached`, so a window in
    // its own document must carry neither it nor a leftover embedded surface
    // back in the wrap.
    assert.equal(childPanel!.closest('.surface-inline'), null,
      'a popped-out agents window rendered inside .surface-inline, which is the '
      + 'embedded state the viewport height cap bounds')
    assert.equal(view.el.querySelectorAll('.tray-wrap .surface-inline').length, 0,
      'the main window still holds an embedded agents surface while the window '
      + 'is popped out')
    assert.equal(savedWindows().find(r => r.kind === 'agent-list')?.open, true,
      'native popout persistence records the agent-list surface')
    const outside = document.createElement('button'); document.body.appendChild(outside)
    await inAct(() => { outside.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, cancelable: true })) })
    await flush()
    assert.ok(child.window.document.querySelector('.tray-panel'),
      'a main-window outside click must not close a detached list')
    const redock = child.window.document.querySelector<HTMLButtonElement>('[aria-label="Return to main window"]')
    assert.ok(redock, 'the detached list exposes the existing redock action')
    await inAct(() => { redock!.click() })
    await flush(8)
    assert.ok(view.el.querySelector('.tray-panel'), 'redocking returns the same list surface to main')
    assert.equal(savedWindows().find(r => r.kind === 'agent-list')?.open, false,
      'redocking closes the detached window record')
    outside.remove()
  } finally {
    window.open = originalOpen
    globalThis.MutationObserver = originalObserver
    Object.defineProperty(window, 'orgtreeDesktop', { value: undefined, configurable: true })
    child.window.close()
  }
})
// §9 WAS "a registered list row opens its native desk surface", mounting the
// row's own ↗ popout button (DeskListControls) beside a DeskSlot. The user had
// the per-agent pin and popout buttons removed from the Agents List on
// 2026-09-12 and that component went with them, so the same journey — a list
// row asking for a popout, the desk registering, MovableSurface.open reached,
// the child window adopting `.popout-mount` — is now measured through the row's
// CONTEXT MENU on the real canvas, in tests/agentrowmenu.test.tsx §7. Deleted
// here rather than rewritten: that test drives the shipping surface end to end,
// where this one drove a fixture of a component that no longer exists.

// ═══════════════════════════════════════════════════════════ §13-§14
// KEEPING THE AGENTS WINDOW INSIDE THE VIEWPORT (user report 2026-09-12: with
// many agents the ordinary Agents window grew off the TOP of the canvas and
// took its pin/pop-out/close bar and its filter box with it).
//
// ⚠ THE LAYOUT ITSELF IS NOT MEASURED HERE AND CANNOT BE. Whether the surface
// fits, whether the list scrolls and whether the cap survives a resize are
// pixel claims; jsdom applies no stylesheet and does no layout, so
// tests/trayheight_probe.py measures all of that in a real browser against the
// real styles.css. What jsdom CAN prove is the pair of facts the browser check
// rests on, and the pair that broke:
//   §13 the cap's selector actually reaches the element the app renders, and
//   §14 the states that must be excluded are excluded STRUCTURALLY.

/** the shipped embedded cap, read back as `[selector, body]` — found by what
 *  it does (bounds `.surface-inline`) rather than by a selector spelled out
 *  here, which would just restate the thing under test */
function capRule(): [string, string] {
  const m = /^([^\n{}]*\.surface-inline)\s*\{([^}]*max-height:\s*100%[^}]*)\}/m.exec(CSS)
  assert.ok(m, 'styles.css no longer bounds .surface-inline to its container at all')
  return [m![1]!.trim(), m![2]!]
}

uiTest('§13 the embedded height cap selects the surface the app really renders',
  async ({ mount }) => {
    const [selector, body] = capRule()
    // the cap has to be able to shrink the item, or a definite-height wrap
    // means nothing — `min-height: auto` is the flexbox default and is exactly
    // what "never shrink below your content" is spelled
    assert.match(body, /min-height:\s*0/,
      `"${selector}" must let the surface shrink inside the wrap`)
    assert.match(rule('.surface-inline > .tray-panel'), /min-height:\s*0/,
      'the panel inside the surface must be able to shrink too')

    const el = await openTray(mount, undefined,
      ['ceo', 'cto', 'cfo', 'coo', 'cpo', 'cro', 'cso', 'cmo'])
    const surface = el.querySelector('.tray-wrap .surface-inline') as HTMLElement | null
    assert.ok(surface, 'the ordinary agents window did not render a .surface-inline '
      + 'inside .tray-wrap at all')

    // ⚠ THE REGRESSION, ASSERTED AS THE SELECTOR MEETING THE ELEMENT. The rule
    // shipped for weeks as `.tray-wrap > .surface-inline` and matched NOTHING:
    // PinFrame renders through MovableSurface, whose .movable-anchor /
    // -surface / -content / -events wrappers sit in between. They are
    // `display: contents`, so the surface really is a flex item of the wrap
    // for LAYOUT and the rule looked right — but a child combinator reads the
    // DOM tree, not the box tree. Asked this way the check survives any number
    // of wrappers being added or removed, and fails the moment the stylesheet
    // and the markup stop agreeing.
    assert.ok(surface!.matches(selector),
      `the stylesheet bounds "${selector}", which does not match the element the `
      + 'app renders — the cap is dead CSS')
    const panel = surface!.querySelector('.tray-panel') as HTMLElement | null
    assert.ok(panel, 'no agents panel inside the surface')
    assert.ok(panel!.matches('.surface-inline > .tray-panel'),
      'the panel is no longer a direct child of the surface, so its own cap is '
      + 'dead CSS too')
    // and the list that has to absorb the overflow is the one inside it
    assert.ok(panel!.querySelector('.tray'), 'the panel holds no agent list')
    assert.equal(panel!.querySelectorAll('.tray-row').length, 8,
      'every fixture agent is a row — nothing is dropped to make the panel fit')
  })

uiTest('§14 a pinned agents window is outside the embedded cap, structurally',
  async ({ mount }) => {
    const { OrgCanvas } = await import('../src/canvas/OrgCanvas')
    const { CurrentOrg } = await import('../src/popout')
    localStorage.clear(); forgetModalPins(); forgetModalOpenCache()
    pinModal('agent-list', { x: 40, y: 20, w: 320, h: 420 }, 'mine')
    rememberModalOpen('agent-list', 'mine')
    const { el } = await mount(<CurrentOrg.Provider value="mine">
      <OrgCanvas tree={treeWithStatus(['ceo', 'cto'])} op={() => Promise.resolve({} as never)}
        slug="mine" toast={noop} mailEvt={null} /></CurrentOrg.Provider>)
    await flush(5)
    const panel = document.querySelector('.tray-panel.modalpin-win') as HTMLElement | null
    assert.ok(panel, 'the pinned agents window did not render — this section is inert')
    // ⚠ TWO SEPARATE REASONS THE CAP CANNOT REACH IT, and both are load-bearing.
    // PinFrame emits `.surface-inline` only for `inline && !pinned && !detached`
    // (modalpin.tsx), and a pinned surface is anchored to the org's pin layer
    // instead of the wrap. Either one alone would do; asserting both means a
    // change to either is visible here rather than only in a screenshot.
    assert.equal(panel!.closest('.surface-inline'), null,
      'a pinned window rendered inside .surface-inline, which is the embedded '
      + 'state the height cap bounds')
    assert.equal(panel!.closest('.tray-wrap'), null,
      'a pinned window is still inside .tray-wrap — the cap now depends on the '
      + 'selector alone')
    assert.equal(el.querySelectorAll('.tray-wrap .surface-inline').length, 0,
      'the wrap still holds an embedded surface while the window is pinned')
    localStorage.clear(); forgetModalPins(); forgetModalOpenCache()
  })
