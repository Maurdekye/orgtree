// Canvas background themes (user 2026-10-15): the native preference's
// validation, the resolver's defaults, the CSS themes' floor geometry, the
// ASCII field's math, and the layer OrgCanvas actually renders — including
// that an untouched install gets the shipped dot grid byte-for-byte.
//
// Absence checks compare booleans: a failing assertion handed a
// React-rendered element exhausts the reporter's memory (team notes,
// rig-opus 2026-10-14).

import { flush, inAct, mountView } from './harness'
import type { MountedView } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { DEFAULT_PREFERENCES, preferencesPatch } from '../../main/policy'
import { CANVAS_BACKGROUNDS, DEFAULT_CANVAS_INTENSITIES, canvasBackgroundOf, resolveCanvasBackground, sanitizeCanvasBackground } from '../../../../packages/contracts/canvas-background'
import { CanvasBackground, bgGeometry } from '../src/canvas/canvasbackground'
import {
  ATLAS_CHARS, GLYPH_POOLS, createTouch, fieldAt, glyphChoiceAt, gradientNoise, gridFor,
  hash32, headingFor, heartRadius, pcg, pickLook, rngStream, sequenceFor, spanFor,
  unitFromHash, valueNoise, visitFromSeed,
} from '../src/canvas/asciifield'
import { CANVAS_BG_KEY } from '../src/canvasbgpref'

declare const __SRC_DIR__: string

/* ── the native preference ─────────────────────────────────────────────── */

test('canvas background is absent from the default preferences', () => {
  assert.equal('canvasBackground' in DEFAULT_PREFERENCES, false)
})

test('native validation accepts the stored shapes and rebuilds them clean', () => {
  assert.deepEqual(preferencesPatch({ canvasBackground: { theme: 'ascii' } }),
    { canvasBackground: { theme: 'ascii' } })
  assert.deepEqual(
    preferencesPatch({ canvasBackground: { theme: 'hex-lines', intensities: { ascii: 0.5, dots: 0, 'hex-lines': 1 } } }),
    { canvasBackground: { theme: 'hex-lines', intensities: { ascii: 0.5, dots: 0, 'hex-lines': 1 } } })
  // unknown fields are dropped, not stored
  assert.deepEqual(preferencesPatch({ canvasBackground: { theme: 'dots', bogus: 1 } }),
    { canvasBackground: { theme: 'dots' } })
  for (const theme of CANVAS_BACKGROUNDS) {
    assert.deepEqual(preferencesPatch({ canvasBackground: { theme } }), { canvasBackground: { theme } }, theme)
  }
})

test('native validation refuses anything that is not a known theme at a sane intensity', () => {
  const bad: unknown[] = [
    'ascii', 42, null, ['dots'],
    { theme: 'plaid' }, { theme: '' }, { intensities: { ascii: 0.5 } },
    { theme: 'ascii', intensities: 'high' },
    { theme: 'ascii', intensities: { ascii: 1.01 } },
    { theme: 'ascii', intensities: { ascii: -0.1 } },
    { theme: 'ascii', intensities: { ascii: Number.NaN } },
    { theme: 'ascii', intensities: { ascii: Number.POSITIVE_INFINITY } },
    { theme: 'ascii', intensities: { plaid: 0.5 } },
    { theme: 'ascii', intensities: { ascii: '0.5' } },
  ]
  for (const value of bad) {
    assert.throws(() => preferencesPatch({ canvasBackground: value }), /Invalid canvas background/, JSON.stringify(value))
    assert.equal(sanitizeCanvasBackground(value), null, JSON.stringify(value))
  }
})

test('the resolver fills defaults and falls back to the dot grid', () => {
  for (const junk of [null, undefined, 42, 'ascii', { theme: 'plaid' }]) {
    const r = resolveCanvasBackground(junk)
    assert.equal(r.theme, 'dots')
    assert.deepEqual(r.intensities, DEFAULT_CANVAS_INTENSITIES)
  }
  const r = resolveCanvasBackground({ theme: 'ascii', intensities: { ascii: 0.2 } })
  assert.equal(r.theme, 'ascii')
  assert.equal(r.intensities.ascii, 0.2)
  assert.equal(r.intensities.dots, 1)
  assert.equal(r.intensities['line-grid'], DEFAULT_CANVAS_INTENSITIES['line-grid'])
  assert.equal(canvasBackgroundOf({ canvasBackground: { theme: 'hex-tiles' } }).theme, 'hex-tiles')
  assert.equal(canvasBackgroundOf({}).theme, 'dots')
  assert.equal(canvasBackgroundOf(null).theme, 'dots')
})

/* ── floor geometry ────────────────────────────────────────────────────── */

const V = { x: 120, y: -40, z: 1.5 }

test('dots geometry is the shipped dot grid verbatim (parallax included)', () => {
  const g = bgGeometry('dots', V)
  assert.equal(g.backgroundPosition, `${V.x * 0.88}px ${V.y * 0.88}px`)
  assert.equal(g.backgroundSize, `${28 * V.z}px ${28 * V.z}px`)
})

test('grid themes pan and zoom 1:1 with the canvas like a floor', () => {
  assert.deepEqual(bgGeometry('line-grid', V),
    { backgroundPosition: '120px -40px', backgroundSize: '42px 42px' })
  assert.deepEqual(bgGeometry('square-tiles', V),
    { backgroundPosition: '120px -40px', backgroundSize: '84px 84px' })
  const hexDots = bgGeometry('hex-dots', V)
  assert.equal(hexDots.backgroundPosition, '120px -40px, 141px -3.63px')
  assert.equal(hexDots.backgroundSize, '42px 72.75px')
  // both hexagon themes ride SVG masks with the same 1:1 floor math
  for (const theme of ['hex-lines', 'hex-tiles'] as const) {
    const hex = bgGeometry(theme, V)
    assert.equal(hex.maskPosition, '120px -40px', theme)
    assert.equal(hex.maskSize, '44.17px 76.5px', theme)
  }
  const tri = bgGeometry('triangle-tiles', V)
  const [tw, th] = tri.backgroundSize.split(' ').map(s => parseFloat(s))
  assert.equal(tw, 54)
  assert.ok(Math.abs((th ?? 0) / (tw ?? 1) - 0.866) < 0.01, `triangle tile ratio ${th}/${tw}`)
})

/* ── the ASCII backdrop's spec module ──────────────────────────────────────
 * Goldens below were produced by evaluating the studied algorithm's
 * formulas (docs: asciifield.ts header) and are pinned so any drift in the
 * re-implementation — hash constants, draw order, noise lattice, field
 * composition — fails here before it can reach the GL-vs-CPU comparison in
 * the visual fixture. */

const close = (a: number, b: number, eps = 1e-9): void =>
  assert.ok(Math.abs(a - b) <= eps, `${a} not within ${eps} of ${b}`)

test('ascii seeded draws are pinned: hash, streams, heading, look, visit', () => {
  assert.equal(hash32(0), 0)
  assert.equal(hash32(1), 2261973619)
  assert.equal(hash32(0xDEADBEEF), 707447538)
  const wind = rngStream(42, 'wind')
  assert.deepEqual([wind(), wind(), wind(), wind()],
    [0.23142166482284665, 0.37323672021739185, 0.2431450269650668, 0.5499723774846643])
  assert.equal(rngStream(42, 'look')(), 0.7473347645718604)
  assert.equal(headingFor(0), Math.PI / 10)
  assert.equal(headingFor(0.25), 0.52238110402714)
  assert.equal(headingFor(0.5), Math.PI - Math.PI / 10)
  assert.equal(pickLook(42, []), 'figured')
  assert.equal(pickLook(42, ['mixed']), 'figured')
  assert.equal(pickLook(42, ['figured']), 'lettered')
  assert.deepEqual(visitFromSeed(42, 'mixed'), {
    key: 'mixed', seed: 42, heading: 0.5069074435872191, speed: 50.21120784478262,
    gustLength: 423.766104853712, gustWidth: 158.4980664239265,
    bend: 66.95667947875336, bendScale: 385.4144315654412,
  })
  assert.equal(visitFromSeed(7, 'plaid').key, 'mixed')
  for (const s of [0, 1, 123456, 0xFFFFFFFF]) {
    const v = visitFromSeed(s, 'mixed')
    assert.ok(v.speed >= 42 && v.speed < 64, `speed ${v.speed}`)
    assert.ok(v.gustLength >= 380 && v.gustLength < 560)
    assert.ok(v.gustWidth >= 120 && v.gustWidth < 190)
    assert.ok(v.bend >= 60 && v.bend < 110)
    assert.ok(v.bendScale >= 300 && v.bendScale < 440)
    const lo = Math.PI / 10, hi = Math.PI / 4.3
    assert.ok((v.heading >= lo && v.heading <= hi) || (v.heading >= Math.PI - hi && v.heading <= Math.PI - lo),
      `heading ${v.heading} blows up or down`)
  }
})

test('ascii pcg and noises are pinned, bounded and deterministic (negative lattice included)', () => {
  assert.equal(pcg(0), 129708002)
  assert.equal(pcg(1), 2831084092)
  assert.equal(pcg(0xFFFFFFFF), 3861530882)
  assert.equal(unitFromHash(pcg(7)), 0.49376022815704346)
  assert.equal(valueNoise(1.5, 2.5, 3.5, 42, 0x51), -0.009111270308494568)
  assert.equal(valueNoise(-3.25, 0.75, 8, 42, 0x60), -0.7458693910061811)
  assert.equal(gradientNoise(1.5, 2.5, 3.5, 42, 0x59), -0.3005865102639296)
  assert.equal(gradientNoise(-0.5, -0.5, 0, 7, 0x66), -0.025293255131964787)
  for (let x = -20; x <= 20; x += 1.37) for (let y = -20; y <= 20; y += 1.73) {
    const v = valueNoise(x, y, 3.25, 99, 0x57)
    assert.ok(v >= -1.0001 && v <= 1.0001, `valueNoise ${v}`)
    assert.equal(v, valueNoise(x, y, 3.25, 99, 0x57))
    const g = gradientNoise(x, y, 3.25, 99, 0x5b)
    assert.ok(g >= -1.6 && g <= 1.6, `gradientNoise ${g}`)
    assert.equal(g, gradientNoise(x, y, 3.25, 99, 0x5b))
  }
})

test('ascii heart radius: a circle on the axes, lobes one way, point the other', () => {
  assert.equal(heartRadius(0, 1), 1)
  assert.equal(heartRadius(0, -1), 1)
  assert.equal(heartRadius(1, 0), 1)
  const d = Math.SQRT1_2
  close(heartRadius(d, -d), 1.412198264183006, 1e-12)
  close(heartRadius(d, d), 0.7926722973571825, 1e-12)
  assert.equal(heartRadius(-d, -d), heartRadius(d, -d))
  assert.equal(heartRadius(-d, d), heartRadius(d, d))
})

test('ascii grid sizing: minima refuse, the pixel budget shrinks, cells stay 1:2', () => {
  assert.deepEqual(gridFor(1600, 900, 1),
    { cellWidth: 7, cellHeight: 14, columns: 229, rows: 65, left: -1, top: -5, scale: 1 })
  assert.equal(gridFor(100, 100, 1), null)
  assert.equal(gridFor(120, 900, 1), null)
  assert.equal(gridFor(0, 900, 1), null)
  assert.equal(gridFor(1600, 900, Number.NaN), null)
  const big = gridFor(8000, 4500, 2)
  assert.equal(big === null, false)
  assert.ok(big!.columns * big!.cellWidth * big!.rows * big!.cellHeight <= 21_000_000)
  assert.equal(big!.cellHeight, big!.cellWidth * 2)
  assert.ok(big!.cellWidth >= 5)
})

test('ascii atlas set and pools are the recorded parameters; sequences exclude missing glyphs', () => {
  assert.equal(ATLAS_CHARS.length, 96)
  assert.equal(ATLAS_CHARS[0], ' ')
  assert.equal(ATLAS_CHARS[95], '·')
  assert.deepEqual(Object.values(GLYPH_POOLS).map(p => p.length), [48, 44, 48])
  for (const pool of Object.values(GLYPH_POOLS)) {
    for (const ch of pool) assert.ok(ATLAS_CHARS.includes(ch), `pool char ${ch} outside the atlas`)
  }
  const none = new Array<boolean>(96).fill(false)
  assert.deepEqual(Array.from(sequenceFor('mixed', none)),
    [65, 66, 16, 67, 33, 68, 69, 17, 70, 37, 71, 72, 18, 73, 39, 74, 75, 19, 76, 40, 77, 78, 20, 79,
      43, 80, 81, 21, 82, 45, 83, 84, 22, 85, 50, 86, 87, 23, 88, 51, 89, 90, 24, 78, 52, 25, 69, 55])
  const some = none.slice()
  some[65] = true
  const trimmed = sequenceFor('mixed', some)
  assert.equal(trimmed.length, 47)
  assert.equal(Array.from(trimmed).includes(65), false)
  assert.deepEqual(Array.from(sequenceFor('mixed', new Array<boolean>(96).fill(true))), [14])
})

test('ascii field mirror: bounded, mostly dark, calm-gated at the centre, moving with time', () => {
  const visit = visitFromSeed(42, 'mixed')
  const span = spanFor(visit, 800, 600)
  close(span, 574.5976370204518, 1e-9)
  const base = { time: 8, reveal: 1, visit, span, calmCx: 400, calmCy: 270, taps: [], touchFrame: null, now: 0 }
  const at = fieldAt({ ...base, x: 100, y: 100 })
  assert.equal(at.strength, 0)
  close(at.blowX, 0.8661998248790839, 1e-12)
  close(at.blowY, 0.49969777203770305, 1e-12)
  close(at.gate, 0.9967095713829071, 1e-12)
  close(fieldAt({ ...base, x: 400, y: 270 }).gate, 0.3, 1e-12)
  let zeros = 0, total = 0, moved = 0
  for (let x = -1000; x <= 1000; x += 37) for (let y = -600; y <= 600; y += 41) {
    const f = fieldAt({ ...base, x, y })
    total++
    if (f.strength === 0) zeros++
    assert.ok(f.strength >= 0 && f.strength <= 1.2, `strength ${f.strength}`)
    assert.ok(f.gate >= 0 && f.gate <= 1, `gate ${f.gate}`)
    close(Math.hypot(f.blowX, f.blowY), 1, 1e-9)
    if (fieldAt({ ...base, x, y, time: 40 }).strength !== f.strength) moved++
  }
  const dark = zeros / total
  assert.ok(dark > 0.55 && dark < 0.75, `negative-space fraction ${dark}`)
  assert.ok(moved > total / 2, `only ${moved}/${total} samples moved in 32 s`)
  const hiddenField = fieldAt({ ...base, x: 100, y: 100, reveal: 0 })
  assert.equal(hiddenField.strength, 0)
  assert.equal(hiddenField.gate, 0)
})

test('ascii touch: every third tap is the heart, fast sweeps stir wakes, slow ones do not', () => {
  const t = createTouch()
  t.tap(100, 100, 1); t.tap(120, 90, 1.2); t.tap(140, 110, 1.4)
  const f = t.frame(1.5)
  assert.equal(f.tapCount, 3)
  assert.equal(f.taps[3], 1)
  assert.equal(f.taps[7], 1)
  close(f.taps[11] ?? 0, -1.15, 1e-6)
  assert.equal(t.rippling(4.9), true)
  assert.equal(t.frame(5.1).tapCount, 0)
  assert.equal(t.busy(5.1), false)
  const fast = createTouch()
  for (let i = 0; i <= 20; i++) fast.move(i * 20, 100, i * 0.025)
  assert.equal(fast.frame(0.51).wakeCount, 10)
  assert.equal(fast.busy(2.8), true)
  assert.equal(fast.busy(3.0), false)
  const slow = createTouch()
  for (let i = 0; i <= 20; i++) slow.move(i * 1.5, 100, i * 0.1)
  assert.equal(slow.frame(2.01).wakeCount, 0)
})

test('ascii glyph choice cycles the pool sequence at a per-cell pace', () => {
  const none = new Array<boolean>(96).fill(false)
  const seq = sequenceFor('mixed', none)
  assert.deepEqual(glyphChoiceAt(3, 4, 8, 42, seq, null), { glyph: 67, steps: 13, glowX: 0, glowY: 0 })
  assert.deepEqual(glyphChoiceAt(-7, 12, 8, 42, seq, null), { glyph: 75, steps: 7, glowX: 0, glowY: 0 })
  assert.deepEqual(glyphChoiceAt(3, 4, 40, 42, seq, null), { glyph: 68, steps: 63, glowX: 0, glowY: 0 })
  const members = new Set(Array.from(seq))
  for (let cx = -30; cx < 30; cx++) for (let cy = -20; cy < 20; cy++) {
    const choice = glyphChoiceAt(cx, cy, 12.5, 42, seq, null)
    assert.equal(choice === null, false)
    assert.equal(members.has(choice!.glyph), true)
  }
  const roused = glyphChoiceAt(3, 4, 8, 42, seq, { pushX: 0, pushY: 0, raise: 0, rouse: 1, glowX: 0.5, glowY: 0.25 })
  assert.equal(roused === null, false)
  assert.ok(roused!.steps > 13, `roused steps ${roused!.steps}`)
  assert.ok(roused!.glowX >= 0.5 * 0.65 && roused!.glowX <= 0.5, `glowX ${roused!.glowX}`)
  assert.ok(roused!.glowY >= 0.25 * 0.65 && roused!.glowY <= 0.25, `glowY ${roused!.glowY}`)
})

/* ── the stylesheet ────────────────────────────────────────────────────── */

test('styles.css carries every theme pattern, the ascii layer and the mobile-off rule', () => {
  const css = readFileSync(path.join(__SRC_DIR__, 'styles.css'), 'utf8')
  for (const theme of ['line-grid', 'hex-dots', 'hex-lines', 'square-tiles', 'triangle-tiles', 'hex-tiles']) {
    assert.equal(css.includes(`.canvas-bg[data-canvas-bg="${theme}"]`), true, theme)
  }
  assert.equal(css.includes('.canvas-bg-ascii {'), true)
  assert.equal(css.includes('html.mobile .canvas-bg-ascii { display: none; }'), true)
})

/* ── the rendered layer (plain-browser preference path) ────────────────── */

async function mountBg(t: TestContext): Promise<MountedView<HTMLElement>> {
  const mounted = await mountView(<CanvasBackground view={V} viewRef={{ current: V }} hidden={false} />, el => el)
  await inAct(async () => { await flush(8) })
  t.after(async () => { await mounted.unmount(); localStorage.removeItem(CANVAS_BG_KEY) })
  return mounted
}

const storePref = (value: unknown): void => localStorage.setItem(CANVAS_BG_KEY, JSON.stringify(value))

test('with nothing stored the layer is the shipped dot grid, style for style', async (t) => {
  localStorage.removeItem(CANVAS_BG_KEY)
  const view = await mountBg(t)
  const el = view.el
  const bg = el.querySelector<HTMLElement>('.canvas-bg')
  assert.equal(bg === null, false)
  assert.equal(el.querySelector('[data-canvas-bg]') === null, true)
  assert.equal(el.querySelector('canvas') === null, true)
  assert.equal(bg!.style.backgroundPosition, `${V.x * 0.88}px ${V.y * 0.88}px`)
  assert.equal(bg!.style.backgroundSize, `${28 * V.z}px ${28 * V.z}px`)
  assert.equal(bg!.style.getPropertyValue('--dot-r'), '1.65px')
  assert.equal(bg!.style.opacity, '')
})

test('a stored grid theme renders its pattern layer at its remembered intensity', async (t) => {
  storePref({ theme: 'line-grid', intensities: { 'line-grid': 0.4 } })
  const view = await mountBg(t)
  const bg = view.el.querySelector<HTMLElement>('[data-canvas-bg="line-grid"]')
  assert.equal(bg === null, false)
  assert.equal(bg!.style.backgroundPosition, '120px -40px')
  assert.equal(bg!.style.backgroundSize, '42px 42px')
  assert.equal(bg!.style.opacity, '0.4')
})

test('dots with a lowered intensity keep the parallax and fade by opacity', async (t) => {
  storePref({ theme: 'dots', intensities: { dots: 0.5 } })
  const view = await mountBg(t)
  const bg = view.el.querySelector<HTMLElement>('.canvas-bg')
  assert.equal(bg === null, false)
  assert.equal(view.el.querySelector('[data-canvas-bg]') === null, true)
  assert.equal(bg!.style.backgroundPosition, `${V.x * 0.88}px ${V.y * 0.88}px`)
  assert.equal(bg!.style.opacity, '0.5')
})

test('a corrupt stored value renders the dot grid, never a broken layer', async (t) => {
  localStorage.setItem(CANVAS_BG_KEY, '{"theme":"plaid","intensities":{"ascii":99}}')
  const view = await mountBg(t)
  assert.equal(view.el.querySelector('.canvas-bg') === null, false)
  assert.equal(view.el.querySelector('[data-canvas-bg]') === null, true)
})

function stubReducedMotion(t: TestContext, matches: boolean): void {
  const w = window as unknown as { matchMedia?: unknown }
  const prev = w.matchMedia
  w.matchMedia = (query: string) => ({
    matches, media: query, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
    dispatchEvent: () => false,
  })
  t.after(() => { w.matchMedia = prev })
}

test('the ascii theme renders its host layer, flagged reduced under reduced motion', async (t) => {
  storePref({ theme: 'ascii' })
  stubReducedMotion(t, true)
  const view = await mountBg(t)
  const host = view.el.querySelector<HTMLElement>('.canvas-bg-ascii')
  assert.equal(host === null, false)
  assert.equal(host!.dataset.canvasBg, 'ascii')
  assert.equal(host!.dataset.motion, 'reduced')
  assert.equal(view.el.querySelector('.canvas-bg') === null, true)
})

test('the ascii theme is flagged full-motion when the user allows motion', async (t) => {
  storePref({ theme: 'ascii' })
  stubReducedMotion(t, false)
  const view = await mountBg(t)
  const host = view.el.querySelector<HTMLElement>('.canvas-bg-ascii')
  assert.equal(host === null, false)
  assert.equal(host!.dataset.canvasBg, 'ascii')
  assert.equal(host!.dataset.motion, 'full')
})
