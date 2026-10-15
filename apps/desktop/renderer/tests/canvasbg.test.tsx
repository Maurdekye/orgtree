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
import { ASCII_BUCKETS, ASCII_GLYPHS, ASCII_MAX_CELLS, asciiBucket, asciiField, asciiGlyphAt, asciiStep } from '../src/canvas/asciifield'
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
  const hex = bgGeometry('hex-tiles', V)
  assert.equal(hex.backgroundSize, '84px 147px')
  assert.equal(hex.backgroundPosition.split(', ').length, 6)
  assert.equal(hex.backgroundPosition.startsWith('120px -40px, 120px -40px, 162px 33.5px'), true)
  assert.deepEqual(bgGeometry('hex-lines', V), hex)
  const tri = bgGeometry('triangle-tiles', V)
  const [tw, th] = tri.backgroundSize.split(' ').map(s => parseFloat(s))
  assert.equal(tw, 54)
  assert.ok(Math.abs((th ?? 0) / (tw ?? 1) - 1.299) < 0.01, `triangle tile ratio ${th}/${tw}`)
})

/* ── the ASCII field ───────────────────────────────────────────────────── */

test('ascii glyphs are stable per world cell and cover the pool', () => {
  const seen = new Set<number>()
  for (let i = -40; i < 40; i++) for (let j = -25; j < 25; j++) {
    const g = asciiGlyphAt(i, j)
    assert.equal(g, asciiGlyphAt(i, j))
    assert.ok(g >= 0 && g < ASCII_GLYPHS.length)
    seen.add(g)
  }
  assert.ok(seen.size > ASCII_GLYPHS.length * 0.7, `only ${seen.size} distinct glyphs`)
})

test('ascii field stays in 0..1, keeps dark negative space, and moves with time', () => {
  let zeros = 0, total = 0
  for (let x = -2000; x <= 2000; x += 137) for (let y = -2000; y <= 2000; y += 149) {
    for (const t of [0, 13.7, 999]) {
      const v = asciiField(x, y, t)
      assert.ok(v >= 0 && v <= 1, `field(${x},${y},${t}) = ${v}`)
      total++
      if (t === 0 && v === 0) zeros++
    }
  }
  const dark = zeros / (total / 3)
  assert.ok(dark > 0.2 && dark < 0.85, `negative-space fraction ${dark}`)
  let moved = 0
  for (let x = -1000; x <= 1000; x += 211) {
    if (asciiField(x, 300, 0) !== asciiField(x, 300, 30)) moved++
  }
  assert.ok(moved > 3, 'field did not change over 30 seconds')
})

test('ascii buckets are monotonic with a skip floor, and the step honours the cell budget', () => {
  assert.equal(asciiBucket(0), -1)
  assert.equal(asciiBucket(0.02), -1)
  assert.equal(asciiBucket(1), ASCII_BUCKETS - 1)
  let prev = -1
  for (let v = 0; v <= 1.0001; v += 0.05) {
    const b = asciiBucket(Math.min(1, v))
    assert.ok(b >= prev, `bucket went backwards at ${v}`)
    prev = b
  }
  assert.equal(asciiStep(1, 1000, 700), 1)
  assert.equal(asciiStep(0.1, 1000, 700), 7)
  const big = asciiStep(1, 8000, 4000)
  assert.ok(big > 1)
  assert.ok((8000 / (10 * big)) * (4000 / (19 * big)) <= ASCII_MAX_CELLS)
  assert.equal(asciiStep(0, 100, 100), 1)
  assert.equal(asciiStep(Number.NaN, 100, 100), 1)
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

test('the ascii theme renders its canvas layer, flagged reduced under reduced motion', async (t) => {
  storePref({ theme: 'ascii' })
  stubReducedMotion(t, true)
  const view = await mountBg(t)
  const canvas = view.el.querySelector<HTMLCanvasElement>('canvas.canvas-bg-ascii')
  assert.equal(canvas === null, false)
  assert.equal(canvas!.dataset.canvasBg, 'ascii')
  assert.equal(canvas!.dataset.motion, 'reduced')
  assert.equal(view.el.querySelector('.canvas-bg') === null, true)
})

test('the ascii theme is flagged full-motion when the user allows motion', async (t) => {
  storePref({ theme: 'ascii' })
  stubReducedMotion(t, false)
  const view = await mountBg(t)
  const canvas = view.el.querySelector<HTMLCanvasElement>('canvas.canvas-bg-ascii')
  assert.equal(canvas === null, false)
  assert.equal(canvas!.dataset.motion, 'full')
})
