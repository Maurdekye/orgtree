// controlgutter.test.tsx — 4.5.11 UI audit problems 5+6 (user 2026-11-10
// m1a4a3c0b76a7 "fix the 8 ui errors"; coordinator rule: "No canvas overlay
// control may cover any part of a pinned panel"). At 1280x720 a pinned inbox
// or docket fills the canvas, no free rectangle fits the controls, and the
// zoom stack and Agents toggle were drawn over the pin's footer.
//
//   §1  the gutter exists only when the controls are blocked in their corner
//   §2  a pin is drawn clear of it: translated when it fits, else narrowed
//   §3  a canvas-filling pin: the canvas is guttered and the pin starts at 48px
//   §4  no pin, a pin away from the corner, or a free rectangle: unchanged
//   §5  the shipped stylesheet moves the toggle into the column
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs controlgutter

import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { avoidControlGutter, controlGutter, CONTROL_GUTTER_W } from '../src/canvas/controlgutter'
import { forgetCanvasAnchor } from '../src/canvas/canvasanchor'
import { addPin, clampRect, forgetPins, pinsKey } from '../src/canvas/pins'
import { OrgCanvas } from '../src/canvas/OrgCanvas'
import type { TreePayload } from '../src/types'

declare const __SRC_DIR__: string

// the canvas viewport of a 1280x720 window (audit S3)
const VP = { w: 1244, h: 617 }

test('§1 the gutter exists only when the controls are blocked in their corner', () => {
  const full = { x: 18, y: 17, w: 1204, h: 595 }
  const g = controlGutter(VP, [full], false)
  assert.deepEqual(g, { x: 0, y: VP.h - g!.h, w: CONTROL_GUTTER_W, h: g!.h })
  assert.equal(CONTROL_GUTTER_W, 48, 'the column is the stylesheet’s 10px + 30px button + 8px gap')
  assert.ok(g!.h >= 10 + 5 * 28 + 4 * 4, 'tall enough for four zoom buttons and the Agents toggle')
  assert.equal(controlGutter(VP, [full], true), null, 'anchored to a free rectangle: nothing to avoid')
  assert.equal(controlGutter(VP, [], false), null, 'no pins: nothing to avoid')
  assert.equal(controlGutter(VP, [{ x: 600, y: 0, w: 600, h: 300 }], false), null,
    'a pin away from the bottom-left corner leaves the controls alone')
  assert.equal(controlGutter({ w: 0, h: 0 }, [full], false), null, 'unmeasured viewport')
})

test('§2 a pin is drawn clear of the gutter: translated when it fits, else narrowed', () => {
  const g = controlGutter(VP, [{ x: 0, y: 0, w: VP.w, h: VP.h }], false)!
  assert.deepEqual(avoidControlGutter({ x: 18, y: 17, w: 1204, h: 595 }, g, VP),
    { x: 48, y: 17, w: 1174, h: 595 }, 'no room to translate: keep the right edge, narrow')
  assert.deepEqual(avoidControlGutter({ x: 0, y: 300, w: 400, h: 317 }, g, VP),
    { x: 48, y: 300, w: 400, h: 317 }, 'room to translate: the size is kept')
  const high = { x: 0, y: 0, w: 400, h: 200 }
  assert.equal(avoidControlGutter(high, g, VP), high, 'a pin above the column is untouched')
  const right = { x: 300, y: 300, w: 400, h: 317 }
  assert.equal(avoidControlGutter(right, g, VP), right, 'a pin right of the column is untouched')
  assert.equal(avoidControlGutter(high, null, VP), high, 'no gutter, no change')
})

const agent = (id: string) => ({ id, title: id, tier: 'haiku', model_id: 'haiku',
  state: 'live', seat: 1, grant: 0, free: 0, mail_pending: 0, documents: [],
  children: [], lineage: [], turns: [], audiences_held: [],
  scope: { tools: {}, add_dirs: [], permission_mode: 'default', org_visibility: 'team' } })
const SLUG = 'gutter'
const tree = (): TreePayload => ({ slug: SLUG, name: SLUG, workspace: null, dirs: [],
  max_top_grant: 1000, default_top_grant: 50, compact_at: 0, default_tools: null,
  default_visibility: 'team', default_effort: '', credit_requests: [], tiers: { haiku: 1 },
  audiences: [], roots: [agent('a1')], cost_usd_total: 0,
  audit: { live_nodes: 1, top_level_holds: 0, no_overdraft: true, problems: [] },
  user_inbox_count: 0, user_inbox_newest: null, fable_lock: null,
  auto_resume: false, fable_limit_policy: 'freeze',
  fable_filter_policy: 'halt', cascade_hire: false, cascade_alloc: true,
  audience_requests: [], org_inbox: null, net: null, epoch: 1, rev: 1,
  work_items_summary: { attention: 0, active: 0 }, asks: [], asks_open: 0, watchdogs: [] } as unknown as TreePayload)

/** the canvas with a MEASURED viewport (stub on the prototype before mount;
 *  see canvasanchor.test.tsx for why) */
async function canvas(t: { after: (fn: () => void | Promise<void>) => void },
  pin?: { x: number; y: number; w: number; h: number }) {
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
const pinWin = (el: HTMLElement) => el.querySelector('.pinwin[data-id="a1"]') as HTMLElement | null

test('§3 a canvas-filling pin: the canvas is guttered and the pin starts at 48px', async (t) => {
  const { view, vp } = await canvas(t, { x: 18, y: 17, w: 1204, h: 595 })
  const win = pinWin(view.el)
  assert.ok(win, 'POSITIVE CONTROL: the pinned desk rendered')
  assert.ok(vp.classList.contains('controls-guttered'),
    `the blocked controls move into their column (class: ${vp.className})`)
  assert.equal(win!.style.left, '48px', 'the pin is drawn clear of the controls’ column')
  // the pin layer clamps against the viewport's CONTENT box (the stylesheet's
  // border comes off), so the right edge to keep is that clamp's, not 1222
  const cs = getComputedStyle(vp)
  const inner = { w: VP.w - (parseFloat(cs.borderLeftWidth) || 0) - (parseFloat(cs.borderRightWidth) || 0),
    h: VP.h - (parseFloat(cs.borderTopWidth) || 0) - (parseFloat(cs.borderBottomWidth) || 0) }
  const clamped = clampRect({ x: 18, y: 17, w: 1204, h: 595 }, inner)
  assert.equal(win!.style.width, `${clamped.x + clamped.w - 48}px`, 'keeping its right edge')
  const toggle = view.el.querySelector('.tray-toggle') as HTMLButtonElement | null
  assert.ok(toggle, 'the Agents toggle is still rendered')
  assert.equal(toggle!.getAttribute('aria-label'), 'agents', 'and keeps an accessible name when icon-only')
})

test('§4 no pin, a pin away from the corner, or a free rectangle: unchanged', async (t) => {
  {
    const { vp } = await canvas(t)
    assert.ok(!vp.classList.contains('controls-guttered'), 'no pin: the canvas is unchanged')
  }
  {
    const { view, vp } = await canvas(t, { x: 600, y: 0, w: 600, h: 300 })
    assert.ok(!vp.classList.contains('controls-guttered'), 'a pin away from the corner: unchanged')
    assert.equal(pinWin(view.el)!.style.left, '600px')
  }
  {
    // a desk down the left leaves a free rectangle: the controls anchor there
    const { view, vp } = await canvas(t, { x: 0, y: 0, w: 400, h: VP.h })
    assert.ok(!vp.classList.contains('controls-guttered'), 'anchored controls need no gutter')
    assert.equal(pinWin(view.el)!.style.left, '0px', 'and the pin is drawn where it was saved')
  }
})

test('§5 the shipped stylesheet moves the toggle into the column', () => {
  const css = readFileSync(path.join(__SRC_DIR__, 'styles.css'), 'utf8')
  assert.match(css, /\.viewport\.controls-guttered \.tray-wrap \{ left: 10px; bottom: calc\(10px \+ 4 \* 28px \+ 4 \* 4px\); \}/)
  assert.match(css, /\.viewport\.controls-guttered \.tray-toggle-label \{ display: none; \}/)
})
