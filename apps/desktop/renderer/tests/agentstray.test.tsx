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
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import type { TreePayload } from '../src/types'

const noop = () => {}
const txt = (el: HTMLElement) => el.textContent ?? ''

function uiTest(name: string,
  body: (k: { mount: (el: React.ReactElement)
    => Promise<{ el: HTMLElement }> }) => Promise<void>): void {
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
        return { el: v.el }
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
  const wrapCss = rule('.tray-wrap')
  assert.match(wrapCss, /top:\s*[\d.]+px/,
    '.tray-wrap needs both top and bottom set — bottom alone leaves its '
    + 'height auto, and .tray’s max-height: 100% would resolve to nothing')
  assert.match(wrapCss, /bottom:\s*[\d.]+px/)
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
  const { OrgCanvas } = await import('../src/canvas/OrgCanvas')
  const { el } = await mount(
    <OrgCanvas tree={treeWithStatus(ids)} op={() => Promise.resolve({} as never)}
      slug="mine" toast={noop} mailEvt={null} onWorkItem={onWorkItem} />)
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
