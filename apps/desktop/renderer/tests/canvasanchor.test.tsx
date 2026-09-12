// canvasanchor.test.tsx — user 2026-09-12: the zoom cluster and the Agents
// list anchor to the whole canvas, so a pinned modal or an expanded desk over
// that corner leaves them looking detached from the area actually in use.
// An OPT-IN preference, OFF by default, anchors them to the rectangle those
// surfaces leave free instead — same corner, same offsets, different
// reference rectangle.
//
//   §1  the insets are the free rectangle's own edges
//   §2  …and nothing is emitted when there is nothing to anchor to
//   §3  the preference is off by default and survives a round trip
//   §4  OFF: the canvas carries no variables at all  (placement unchanged)
//   §5  ON with a pin: the canvas carries the free rectangle's insets
//   §6  the shipped stylesheet actually reads them
//
// ⚠ WHY §4 IS THE ONE THAT MATTERS MOST. This is an opt-in preference, so the
// promise that costs the most if broken is that the DEFAULT is untouched.
// §4 is that promise: no variables set, so `calc(0px + 10px)` is the 10px the
// stylesheet always had.
//
// ⚠ WHAT jsdom CANNOT DO. It performs no layout, so §5's viewport box is one
// this file installs and §6 reads the stylesheet as text rather than
// observing a computed position. The arithmetic (§1, §2) needs no layout at
// all, and §5 proves the wiring carries the right numbers to the right
// element — which is the half that would rot if `regionOf` were swapped for
// a second, quietly different rectangle.
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs canvasanchor

import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { CANVAS_ANCHOR_KEY, forgetCanvasAnchor, freeInsets, setCanvasAnchor, useCanvasAnchor } from '../src/canvas/canvasanchor'
import { addPin, forgetPins, pinsKey } from '../src/canvas/pins'
import { PIN_GAP } from '../src/canvas/clearRect'
import { pinSurfaceKey, updatePinSurface } from '../src/canvas/pinspace'
import { OrgCanvas } from '../src/canvas/OrgCanvas'
import type { TreePayload } from '../src/types'

declare const __SRC_DIR__: string

const VP = { w: 1000, h: 800 }

test('§1 the insets are the free rectangle’s own edges', () => {
  // a pin down the left side leaves the canvas free from x=300 rightwards
  const reduced = { rect: { x: 300, y: 0, w: 700, h: 800 }, status: 'reduced' }
  assert.deepEqual(freeInsets(reduced, VP), {
    '--free-left': '300px', '--free-top': '0px', '--free-bottom': '0px',
  })
  // and one along the bottom leaves it free above
  const shortened = { rect: { x: 0, y: 0, w: 1000, h: 500 }, status: 'reduced' }
  assert.deepEqual(freeInsets(shortened, VP), {
    '--free-left': '0px', '--free-top': '0px', '--free-bottom': '300px',
  })
})

test('§2 nothing is emitted when there is nothing to anchor to', () => {
  // `full` = nothing obstructs, or nothing measured yet; `blocked` = no usable
  // rectangle at all. In both cases the stylesheet's own numbers must stand.
  assert.equal(freeInsets({ rect: { x: 0, y: 0, w: 1000, h: 800 }, status: 'full' }, VP), null)
  assert.equal(freeInsets({ rect: { x: 0, y: 0, w: 0, h: 0 }, status: 'blocked' }, VP), null)
  assert.equal(freeInsets(null, VP), null)
  assert.equal(freeInsets({ rect: { x: 0, y: 0, w: 700, h: 800 }, status: 'reduced' }, { w: 0, h: 0 }), null)
  assert.equal(freeInsets({ rect: { x: NaN, y: 0, w: 700, h: 800 }, status: 'reduced' }, VP), null)
})

test('§3 the preference is off by default and survives a round trip', async (t) => {
  localStorage.clear(); forgetCanvasAnchor()
  t.after(() => { localStorage.clear(); forgetCanvasAnchor() })
  const seen: boolean[] = []
  function Probe() { seen.push(useCanvasAnchor().enabled); return null }
  const view = await mountView(<Probe />, el => el)
  t.after(() => view.unmount())
  assert.equal(seen[0], false, 'a fresh browser must not get this behaviour unasked')

  await inAct(() => { setCanvasAnchor({ enabled: true }) })
  assert.equal(seen[seen.length - 1], true, 'turning it on must reach a mounted reader')
  assert.match(localStorage.getItem(CANVAS_ANCHOR_KEY) ?? '', /"enabled":true/)

  forgetCanvasAnchor()
  await inAct(() => { setCanvasAnchor({ enabled: false }) })
  assert.equal(seen[seen.length - 1], false, 'and turning it off again must too')
})

// ------------------------------------------------------------ the real canvas
const agent = (id: string) => ({ id, title: id, tier: 'haiku', model_id: 'haiku',
  state: 'live', seat: 1, grant: 0, free: 0, mail_pending: 0, documents: [],
  children: [], lineage: [], turns: [], audiences_held: [],
  scope: { tools: {}, add_dirs: [], permission_mode: 'default', org_visibility: 'team' } })
const SLUG = 'anchor'
const tree = (): TreePayload => ({ slug: SLUG, name: SLUG, workspace: null, dirs: [],
  max_top_grant: 1000, default_top_grant: 50, compact_at: 0, default_tools: null,
  default_visibility: 'team', default_effort: '', credit_requests: [], tiers: { haiku: 1 },
  audiences: [], roots: [agent('a1')], cost_usd_total: 0,
  audit: { live_nodes: 1, top_level_holds: 0, no_overdraft: true, problems: [] },
  user_inbox_count: 0, user_inbox_newest: null, fable_lock: null, spend_frozen: false,
  storage_blocked: false, auto_resume: false, fable_limit_policy: 'freeze',
  fable_filter_policy: 'halt', cascade_hire: false, cascade_alloc: true, sandboxed: false,
  audience_requests: [], org_inbox: null, net: null, public: false, epoch: 1, rev: 1,
  work_items_summary: { attention: 0, active: 0 }, asks: [], asks_open: 0, watchdogs: [] } as unknown as TreePayload)

/** the canvas, with a MEASURED viewport.
 *
 *  ⚠ The stub goes on the PROTOTYPE and goes in BEFORE mounting: OrgCanvas
 *  measures from a ResizeObserver whose first delivery lands inside the same
 *  `act()` that mounts it, so an element-level stub applied afterwards is one
 *  measurement too late and the canvas stays 0x0 forever. */
async function canvas(t: { after: (fn: () => void | Promise<void>) => void }, pin?: { x: number; y: number; w: number; h: number }) {
  localStorage.clear(); forgetCanvasAnchor(); forgetPins(SLUG)
  localStorage.removeItem(pinsKey(SLUG))
  if (pin) addPin(SLUG, 'a1', pin)
  const proto = HTMLElement.prototype
  const real = proto.getBoundingClientRect
  proto.getBoundingClientRect = function (this: HTMLElement) {
    if (this.classList?.contains('viewport')) {
      return { x: 0, y: 0, left: 0, top: 0, width: VP.w, height: VP.h,
        right: VP.w, bottom: VP.h, toJSON() {} } as DOMRect
    }
    return real.call(this)
  }
  const view = await mountView(
    <OrgCanvas tree={tree()} op={() => Promise.resolve({} as never)} slug={SLUG}
      toast={() => {}} mailEvt={null} />, el => el)
  t.after(async () => {
    proto.getBoundingClientRect = real
    await view.unmount()
    localStorage.clear(); forgetCanvasAnchor(); forgetPins(SLUG)
  })
  await inAct(async () => { await flush(10) })
  const vp = view.el.querySelector('.viewport') as HTMLElement | null
  assert.ok(vp, 'the canvas rendered a viewport')
  return { view, vp: vp! }
}

const varsOf = (el: HTMLElement) => ({
  left: el.style.getPropertyValue('--free-left'),
  top: el.style.getPropertyValue('--free-top'),
  bottom: el.style.getPropertyValue('--free-bottom'),
})

test('§4 OFF: the canvas carries no anchoring variables at all', async (t) => {
  const { vp } = await canvas(t, { x: 0, y: 0, w: 400, h: 800 })
  assert.deepEqual(varsOf(vp), { left: '', top: '', bottom: '' },
    'with the preference off nothing may be written - the stylesheet’s own '
    + 'numbers are the placement, unchanged')
})

test('§5 ON: the canvas carries the free rectangle’s insets', async (t) => {
  const { vp } = await canvas(t, { x: 0, y: 0, w: 400, h: 800 })
  await inAct(() => { setCanvasAnchor({ enabled: true }) })
  await inAct(async () => { await flush(10) })
  const vars = varsOf(vp)
  assert.notEqual(vars.left, '',
    'POSITIVE CONTROL: turning it on with a pin present must write something')
  // ⚠ 400 + PIN_GAP, NOT 400. The free region deliberately keeps a 12px
  // gutter from an obstacle (clearRect.ts), so the usable canvas starts one
  // gap beyond the pin's right edge. Taking the constant from the source
  // rather than writing 412 keeps this test honest if the gutter ever moves -
  // and writing 400 here, as the first draft did, was asserting a rectangle
  // the app has never produced.
  assert.equal(vars.left, `${400 + PIN_GAP}px`,
    `a pin 400px wide down the left leaves the canvas free one gap beyond it `
    + `(got ${JSON.stringify(vars)})`)
  assert.equal(vars.bottom, '0px', 'nothing eats into the bottom edge')
  assert.equal(vars.top, '0px', 'nor the top')
})

test('§6 the shipped stylesheet actually reads the variables', () => {
  // jsdom computes no layout, so this is a claim about the CSS and is checked
  // as one. It is the other half of §4: OFF is only "unchanged" if the
  // fallback really is 0px, because calc(0px + 10px) is the 10px that was
  // there before and anything else is a silent move.
  //
  // Plain substring matching, deliberately: a hand-built regex for a CSS rule
  // is one escaping mistake away from matching nothing and passing for the
  // wrong reason, which is exactly what the first draft of this section did.
  const css = readFileSync(path.join(__SRC_DIR__, 'styles.css'), 'utf8')
  const rule = (name: string) => {
    const at = css.indexOf('.' + name + ' {')
    assert.ok(at >= 0, 'the .' + name + ' rule has gone')
    const end = css.indexOf('}', at)
    assert.ok(end > at, 'the .' + name + ' rule is unterminated')
    return css.slice(at, end)
  }
  const needs = (body: string, text: string, why: string) =>
    assert.ok(body.includes(text), why + ' — expected to find: ' + text)

  const hud = rule('zoomhud')
  needs(hud, 'left: calc(var(--free-left, 0px) + 10px)',
    'the zoom cluster must take its left from the free rectangle, defaulting to 0')
  needs(hud, 'bottom: calc(var(--free-bottom, 0px) + 10px)',
    'and its bottom the same way')

  const tray = rule('tray-wrap')
  needs(tray, 'left: calc(var(--free-left, 0px) + 48px)',
    'the Agents list keeps its own 48px offset, measured from the free rectangle')
  needs(tray, 'top: calc(var(--free-top, 0px) + 10px)', 'its top follows too')
  needs(tray, 'bottom: calc(var(--free-bottom, 0px) + 10px)',
    'top AND bottom, so the wrap keeps a definite height for the tray to grow in')
})

// ════════════════════════════════════════════ perf-review, 2026-09-12
// Two defects found in the first candidate, each reproduced here as the
// reviewer stated it. Both were real: the first placed controls OUTSIDE an
// `overflow: hidden` viewport, the second anchored to a desk edge that had
// not been true since the gesture started.

test('§7 a region too small for the controls is not anchored into', () => {
  // A 960px full-height desk leaves 28px once the region's own gap is taken.
  // Anchoring there put the Agents toggle at x=1020 and the end of the zoom
  // buttons at x=1012, in a 1000px viewport that clips.
  assert.equal(freeInsets({ rect: { x: 972, y: 0, w: 28, h: 800 }, status: 'reduced' }, VP), null,
    'a 28px-wide strip cannot hold the Agents list; the controls must stay put')
  // A full-width desk at y=80 leaves 68px at the top, which starts the
  // four-button zoom stack at y=-66.
  assert.equal(freeInsets({ rect: { x: 0, y: 0, w: 1000, h: 68 }, status: 'reduced' }, VP), null,
    'a 68px-tall band cannot hold the zoom stack; the controls must stay put')

  // POSITIVE CONTROL: a region that genuinely fits is still anchored into, so
  // the guard above is a size test and not a blanket refusal.
  assert.ok(freeInsets({ rect: { x: 400, y: 0, w: 600, h: 800 }, status: 'reduced' }, VP),
    'a 600x800 free rectangle is ample and must still be used')
})

test('§8 the anchor follows a desk DURING a resize, not only after it', async (t) => {
  // `PinWindow` publishes its live rect to the surface registry on every
  // move and commits the persisted pin only at pointer-up. The first
  // candidate read the persisted rect, so a desk dragged from 400 to 600 wide
  // left the controls at the old edge until the gesture ended.
  const { vp } = await canvas(t, { x: 0, y: 0, w: 400, h: 800 })
  await inAct(() => { setCanvasAnchor({ enabled: true }) })
  await inAct(async () => { await flush(10) })
  assert.equal(varsOf(vp).left, `${400 + PIN_GAP}px`,
    'POSITIVE CONTROL: it starts anchored to the committed 400px desk')

  // the gesture: a live rect, published exactly as PinWindow publishes it,
  // with the persisted pin still saying 400
  await inAct(() => {
    updatePinSurface(pinSurfaceKey(SLUG, 'a1', false), SLUG, { x: 0, y: 0, w: 600, h: 800 }, false)
  })
  await inAct(async () => { await flush(10) })
  assert.equal(varsOf(vp).left, `${600 + PIN_GAP}px`,
    'the anchor must follow the desk being dragged, not the rect it was last committed at')
})
