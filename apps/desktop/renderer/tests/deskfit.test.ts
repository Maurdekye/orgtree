// deskfit.test.ts — a desk focused on the canvas stays readable on a small
// viewport (UI audit 2026-11-09 problem 4, docket
// ui-720p-fix-c-an-agent-desk-focused-on-the-canva).
//
// The desk is authored in a 900px virtual panel counter-scaled into the 124px
// card (DESK_SCALE), and the focus glide fits the card to min(w, h) − 48 of
// the free region. On-screen text is therefore authored × DESK_SCALE × zoom:
// ≈1.02 at 1920x1080@100% and ≈0.98 device px at 1920x1080@125%, but only
// ≈0.59 at 1280x720 (measured: a 522px desk with 6-8px text). The fix lays the
// desk out in a smaller authored space (the same mechanism as the reader's
// text-size dial) so that the FOCUS-FIT zoom lands at a readable scale, and it
// leaves every viewport that is already readable exactly as it was.
//
// Geometry below is MEASURED from the audit captures
// (C:/orgtree-build/rig-sol-b/ui-audit-20261109/core-detail-c-S*/
// 004-agent-desk-chat-focused-S*.json, the `.viewport` rect).
//
// ⚠ The module is imported dynamically so that, at a base without the rule,
// each test below fails by name instead of the whole file failing to bundle.

import './testguard.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

/** injected by tests/run.mjs — the bundle does not sit next to the sources */
declare const __SRC_DIR__: string

type Fit = (region: { w: number; h: number }, dpr: number, dpi?: number) => number
type Zoom = (region: { w: number; h: number }) => number
const load = async () => {
  const m = await import('../src/canvas/shared') as Record<string, unknown>
  const deskFit = m.deskFit as Fit | undefined
  const focusFitZoom = m.focusFitZoom as Zoom | undefined
  const READ = m.DESK_READABLE as number | undefined
  assert.equal(typeof deskFit, 'function', 'shared.ts exports deskFit(region, dpr, dpi)')
  assert.equal(typeof focusFitZoom, 'function', 'shared.ts exports focusFitZoom(region)')
  assert.equal(typeof READ, 'number', 'shared.ts exports DESK_READABLE')
  return { deskFit: deskFit!, focusFitZoom: focusFitZoom!, READ: READ!, SCALE: m.DESK_SCALE as number }
}

const S1 = { w: 1884, h: 994 }       // 1920x1080 @100%
const S2 = { w: 1500, h: 778.6 }     // 1920x1080 @125% (CSS 1536x864)
const S3 = { w: 1244, h: 597 }       // 1280x720 @100%

test('S1 1920x1080@100%: unchanged (fit 1)', async () => {
  const { deskFit } = await load()
  assert.equal(deskFit(S1, 1), 1)
  assert.equal(deskFit(S1, 1, 1.25), 1, 'the reader\'s own dial is not the fit')
})

test('S2 1920x1080@125%: unchanged (fit 1)', async () => {
  const { deskFit } = await load()
  assert.equal(deskFit(S2, 1.25), 1)
})

test('larger screens are unchanged (2560x1440, 4K@200%)', async () => {
  const { deskFit } = await load()
  assert.equal(deskFit({ w: 2524, h: 1354 }, 1), 1)
  assert.equal(deskFit({ w: 1884, h: 994 }, 2), 1)
})

test('S3 1280x720: the focused desk lands at a readable scale', async () => {
  const { deskFit, focusFitZoom, READ, SCALE } = await load()
  const z = focusFitZoom(S3)
  const before = SCALE * z
  assert.ok(before < 0.65, `control: today's focus scale at S3 is unreadable (${before.toFixed(3)})`)
  const fit = deskFit(S3, 1)
  assert.ok(fit > 1, `S3 must boost (got ${fit})`)
  const after = SCALE * z * fit
  assert.ok(Math.abs(after - READ) < 1e-9, `focused text scale ${after.toFixed(3)} == DESK_READABLE ${READ}`)
  // "about the size the 1080p focus shows today": S1's device-px scale
  const s1 = SCALE * focusFitZoom(S1)
  assert.ok(after >= s1 * 0.9, `S3 ${after.toFixed(3)} is within 10% of S1 ${s1.toFixed(3)}`)
})

test('the fit is relative to the reader\'s dial and capped at the dial\'s max (3)', async () => {
  const { deskFit } = await load()
  const f1 = deskFit(S3, 1, 1)
  assert.equal(deskFit(S3, 1, 1.25), f1, 'same fit whatever the dial: the dial still multiplies on top')
  const tiny = { w: 420, h: 300 }
  assert.ok(deskFit(tiny, 1, 1) <= 3)
  assert.ok(deskFit(tiny, 1, 2) * 2 <= 3 + 1e-9, 'dial × fit never exceeds 3')
  assert.ok(deskFit(tiny, 1, 3) >= 1, 'the fit never shrinks a desk')
})

test('an unmeasured viewport (jsdom, before first paint) is fit 1', async () => {
  const { deskFit } = await load()
  assert.equal(deskFit({ w: 0, h: 0 }, 1), 1)
  assert.equal(deskFit({ w: 1244, h: 597 }, 0), deskFit({ w: 1244, h: 597 }, 1), 'dpr 0 reads as 1')
})

test('focusFitZoom is the focus camera\'s own fit (min side − 48 over the card, Z_DESK..Z_MAX)', async () => {
  const { focusFitZoom } = await load()
  assert.equal(focusFitZoom(S1), (994 - 48) / 124)
  assert.equal(focusFitZoom({ w: 300, h: 200 }), 2.1, 'floored at Z_DESK')
  assert.equal(focusFitZoom({ w: 9000, h: 9000 }), 12, 'capped at Z_MAX')
  const src = readFileSync(path.join(__SRC_DIR__, 'canvas', 'OrgCanvas.tsx'), 'utf8')
  assert.match(src, /focusFitZoom\(r\)/, 'focusView asks the same function, so the camera and the fit cannot drift')
  assert.match(src, /'--desk-fit'/, 'the canvas publishes the fit to its desks')
})

test('every counter-scaled canvas desk surface follows --desk-fit', () => {
  const css = readFileSync(path.join(__SRC_DIR__, 'styles.css'), 'utf8')
  for (const sel of ['.desk-inner {', '.popout-placeholder.desk-elsewhere {']) {
    const at = css.indexOf(sel)
    assert.ok(at >= 0, sel)
    const body = css.slice(at, css.indexOf('}', at))
    assert.match(body, /transform: scale\(calc\(0\.13333 \* var\(--desk-dpi, 1\) \* var\(--desk-fit, 1\)\)\)/, `${sel} scale`)
    assert.match(body, /900px \/ \(var\(--desk-dpi, 1\) \* var\(--desk-fit, 1\)\)/, `${sel} authored width`)
  }
})
