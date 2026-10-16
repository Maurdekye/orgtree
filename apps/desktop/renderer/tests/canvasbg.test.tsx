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
import {
  CANVAS_BACKGROUNDS, CANVAS_BACKGROUND_LABELS, DEFAULT_CANVAS_INTENSITIES,
  canvasBackgroundOf, resolveCanvasBackground, sanitizeCanvasBackground,
} from '../../../../packages/contracts/canvas-background'
import type { CanvasBackgroundTheme } from '../../../../packages/contracts/canvas-background'
import { AsciiLayer, CanvasBackground, bgGeometry } from '../src/canvas/canvasbackground'
import type { AsciiTestApi } from '../src/canvas/canvasbackground'
import { buildAtlas, createAsciiRenderer } from '../src/canvas/asciigl'
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

test('Claude Waves is the last background option and Checkerboard is kept beside the tile presets', () => {
  assert.equal(CANVAS_BACKGROUNDS[0], 'dots')
  assert.equal(CANVAS_BACKGROUNDS[CANVAS_BACKGROUNDS.length - 1], 'ascii')
  assert.equal(CANVAS_BACKGROUND_LABELS.ascii, 'Claude Waves')
  assert.equal((CANVAS_BACKGROUNDS as readonly string[]).includes('checkerboard'), true)
  assert.equal(CANVAS_BACKGROUND_LABELS['checkerboard' as keyof typeof CANVAS_BACKGROUND_LABELS], 'Checkerboard')
})

test('native validation accepts the stored shapes (including backward-compatible ascii, claude-waves, and legacy square-tiles -> checkerboard migration) and rebuilds them clean', () => {
  assert.deepEqual(preferencesPatch({ canvasBackground: { theme: 'ascii' } }),
    { canvasBackground: { theme: 'ascii' } })
  assert.deepEqual(preferencesPatch({ canvasBackground: { theme: 'claude-waves', intensities: { 'claude-waves': 0.6 } } }),
    { canvasBackground: { theme: 'ascii', intensities: { ascii: 0.6 } } })
  assert.deepEqual(preferencesPatch({ canvasBackground: { theme: 'checkerboard', intensities: { checkerboard: 0.4 } } }),
    { canvasBackground: { theme: 'checkerboard', intensities: { checkerboard: 0.4 } } })
  // Legacy unversioned square-tiles selection and intensity migrate to checkerboard (user mb271a07b3fce)
  assert.deepEqual(
    preferencesPatch({ canvasBackground: { theme: 'square-tiles', intensities: { 'square-tiles': 0.3 } } }),
    { canvasBackground: { theme: 'checkerboard', intensities: { checkerboard: 0.3 } } })
  assert.deepEqual(
    preferencesPatch({ canvasBackground: { theme: 'dots', intensities: { 'square-tiles': 0.25 } } }),
    { canvasBackground: { theme: 'dots', intensities: { checkerboard: 0.25 } } })
  // Version 2 square-tiles selects the new gapped outlined square tiling preset
  assert.deepEqual(
    preferencesPatch({ canvasBackground: { theme: 'square-tiles', version: 2, intensities: { 'square-tiles': 0.4, checkerboard: 0.3 } } }),
    { canvasBackground: { theme: 'square-tiles', version: 2, intensities: { 'square-tiles': 0.4, checkerboard: 0.3 } } })
  assert.deepEqual(
    preferencesPatch({ canvasBackground: { theme: 'hex-lines', intensities: { ascii: 0.5, dots: 0, 'hex-lines': 1 } } }),
    { canvasBackground: { theme: 'hex-lines', intensities: { ascii: 0.5, dots: 0, 'hex-lines': 1 } } })
  // unknown fields are dropped, not stored
  assert.deepEqual(preferencesPatch({ canvasBackground: { theme: 'dots', bogus: 1 } }),
    { canvasBackground: { theme: 'dots' } })
  for (const theme of CANVAS_BACKGROUNDS) {
    const input = theme === 'square-tiles' ? { theme, version: 2 as const } : { theme }
    assert.deepEqual(preferencesPatch({ canvasBackground: input }), { canvasBackground: input }, theme)
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
    { theme: 'square-tiles', version: 99 },
    { theme: 'square-tiles', version: '2' },
  ]
  for (const value of bad) {
    assert.throws(() => preferencesPatch({ canvasBackground: value }), /Invalid canvas background/, JSON.stringify(value))
    assert.equal(sanitizeCanvasBackground(value), null, JSON.stringify(value))
  }
})

test('the resolver fills defaults, migrates legacy square-tiles to checkerboard, and falls back to the dot grid', () => {
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
  const legacySq = resolveCanvasBackground({ theme: 'square-tiles', intensities: { 'square-tiles': 0.3 } })
  assert.equal(legacySq.theme, 'checkerboard')
  assert.equal(legacySq.intensities.checkerboard, 0.3)
  assert.equal(legacySq.intensities['square-tiles'], DEFAULT_CANVAS_INTENSITIES['square-tiles'])
  const v2Sq = resolveCanvasBackground({ theme: 'square-tiles', version: 2, intensities: { 'square-tiles': 0.65 } })
  assert.equal(v2Sq.theme, 'square-tiles')
  assert.equal(v2Sq.intensities['square-tiles'], 0.65)
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

test('grid, checkerboard and outlined tile themes pan and zoom 1:1 with the canvas like a floor', () => {
  assert.deepEqual(bgGeometry('line-grid', V),
    { backgroundPosition: '120px -40px', backgroundSize: '42px 42px' })
  assert.deepEqual(bgGeometry('checkerboard' as CanvasBackgroundTheme, V),
    { backgroundPosition: '120px -40px', backgroundSize: '84px 84px' })
  const hexDots = bgGeometry('hex-dots', V)
  assert.equal(hexDots.backgroundPosition, '120px -40px, 141px -3.63px')
  assert.equal(hexDots.backgroundSize, '42px 72.75px')
  // square-tiles, triangle-tiles, hex-lines and hex-tiles ride SVG masks with 1:1 floor math
  const sq = bgGeometry('square-tiles', V)
  assert.equal(sq.maskPosition, '120px -40px')
  assert.equal(sq.maskSize, '42px 42px')
  for (const theme of ['hex-lines', 'hex-tiles'] as const) {
    const hex = bgGeometry(theme, V)
    assert.equal(hex.maskPosition, '120px -40px', theme)
    assert.equal(hex.maskSize, '44.17px 76.5px', theme)
  }
  const tri = bgGeometry('triangle-tiles', V)
  assert.equal(tri.maskPosition, '120px -40px')
  const [tw, th] = (tri.maskSize ?? '').split(' ').map(s => parseFloat(s))
  assert.equal(tw, 54)
  assert.ok(Math.abs((th ?? 0) / (tw ?? 1) - 1.732) < 0.01, `triangle mask tile ratio ${th}/${tw}`)
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
  assert.equal(t.waking(4.9), false)
  assert.equal(t.frame(5.1).tapCount, 0)
  assert.equal(t.busy(5.1), false)
  const fast = createTouch()
  for (let i = 0; i <= 20; i++) fast.move(i * 20, 100, i * 0.025)
  assert.equal(fast.frame(0.51).wakeCount, 10)
  assert.equal(fast.waking(2.8), true)
  assert.equal(fast.rippling(2.8), false)
  assert.equal(fast.busy(2.8), true)
  assert.equal(fast.waking(3.0), false)
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

function ruleBlock(css: string, theme: string): string {
  const idx = css.indexOf(`.canvas-bg[data-canvas-bg="${theme}"]`)
  if (idx < 0) return ''
  const end = css.indexOf('}', idx)
  return end < 0 ? '' : css.slice(idx, end + 1)
}

test('styles.css carries every theme pattern, Checkerboard, gapped outlined tile presets, the ascii layer and the mobile-off rule', () => {
  const css = readFileSync(path.join(__SRC_DIR__, 'styles.css'), 'utf8')
  for (const theme of ['line-grid', 'hex-dots', 'hex-lines', 'checkerboard', 'square-tiles', 'triangle-tiles', 'hex-tiles']) {
    assert.equal(css.includes(`.canvas-bg[data-canvas-bg="${theme}"]`), true, theme)
  }
  assert.equal(css.includes('.canvas-bg-ascii {'), true)
  assert.equal(css.includes('html.mobile .canvas-bg-ascii { display: none; }'), true)

  // Checkerboard keeps the existing alternating filled-square conic-gradient unchanged
  const checker = ruleBlock(css, 'checkerboard')
  assert.equal(checker.includes('conic-gradient(from 90deg at 50% 50%, var(--canvas-dot) 25%, transparent 0 50%, var(--canvas-dot) 0 75%, transparent 0)'), true)

  // Tile presets (square-tiles, triangle-tiles, hex-tiles) are separately outlined shapes with small gaps
  for (const tile of ['square-tiles', 'triangle-tiles', 'hex-tiles'] as const) {
    const block = ruleBlock(css, tile)
    assert.equal(block.includes('background-color: var(--line)'), true, `${tile} uses var(--line) fill under mask`)
    assert.equal(block.includes('conic-gradient'), false, `${tile} must not be a filled conic-gradient`)
    assert.equal(block.includes("fill%3D'none'%20stroke%3D'white'%20stroke-width%3D'1.5'"), true, `${tile} must be stroked outlines, not filled shapes`)
    const encoded = /mask-image:\s*url\("data:image\/svg\+xml,([^"]+)"\)/.exec(block)?.[1] ?? ''
    const svg = decodeURIComponent(encoded)
    const d = /\bd='([^']+)'/.exec(svg)?.[1] ?? ''
    const subpaths = d.split('Z').map(s => s.trim()).filter(Boolean)
    if (tile === 'square-tiles') {
      assert.equal(subpaths.length, 1, 'square-tiles has one closed inset square per tile')
      assert.equal(d.includes('2.5'), true, 'square-tiles is inset from the 0..28 cell edges')
    } else if (tile === 'triangle-tiles') {
      assert.equal(subpaths.length, 6, 'triangle-tiles has 6 closed inset triangles (up and down across 2 rows) in the {3,6} periodic tile')
      assert.equal(d.includes('4.80') && d.includes('2.40'), true, 'triangle-tiles insets both upward and downward triangles')
    } else if (tile === 'hex-tiles') {
      assert.equal(subpaths.length, 5, 'hex-tiles has 5 closed inset hexagons in the {6,3} periodic tile')
      assert.equal(d.includes('3.06') || d.includes('2.65'), true, 'hex-tiles insets each hexagon from the shared honeycomb boundary')
    }
  }
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

test('a stored checkerboard theme or legacy square-tiles preference renders the 2x2 square pattern, while v2 square-tiles renders the gapped mask', async (t) => {
  storePref({ theme: 'checkerboard', intensities: { checkerboard: 0.35 } })
  const view = await mountBg(t)
  const bg = view.el.querySelector<HTMLElement>('[data-canvas-bg="checkerboard"]')
  assert.equal(bg === null, false)
  assert.equal(bg!.style.backgroundPosition, '120px -40px')
  assert.equal(bg!.style.backgroundSize, '84px 84px')
  assert.equal(bg!.style.opacity, '0.35')
  await view.unmount()

  // Legacy unversioned square-tiles selection loads as Checkerboard with its remembered intensity
  storePref({ theme: 'square-tiles', intensities: { 'square-tiles': 0.3 } })
  const viewLegacy = await mountBg(t)
  const bgLegacy = viewLegacy.el.querySelector<HTMLElement>('[data-canvas-bg="checkerboard"]')
  assert.equal(bgLegacy === null, false)
  assert.equal(bgLegacy!.style.backgroundSize, '84px 84px')
  assert.equal(bgLegacy!.style.opacity, '0.3')
  await viewLegacy.unmount()

  // Version 2 square-tiles selection renders the gapped outlined square-tiles mask
  storePref({ theme: 'square-tiles', version: 2, intensities: { 'square-tiles': 0.4 } })
  const viewV2 = await mountBg(t)
  const bgV2 = viewV2.el.querySelector<HTMLElement>('[data-canvas-bg="square-tiles"]')
  assert.equal(bgV2 === null, false)
  assert.equal(bgV2!.style.maskSize, '42px 42px')
  assert.equal(bgV2!.style.opacity, '0.4')
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

/* ── zoom-out bounding, GPU fence misses, graceful load degradation & recovery ── */

interface MockGlControl {
  fenceSignaled: boolean
  contextLost: boolean
  ctxGen: number
  lastLostPrevented: boolean
  invalidResourceUses: number
  atlasFonts: string[]
}

function installAsciiGlEnv(t: TestContext, dpr = 1): MockGlControl {
  const ctrl: MockGlControl = {
    fenceSignaled: true,
    contextLost: false,
    ctxGen: 1,
    lastLostPrevented: false,
    invalidResourceUses: 0,
    atlasFonts: [],
  }
  const w = window as unknown as Record<string, unknown>
  const prevRo = w.ResizeObserver
  const prevDpr = Object.getOwnPropertyDescriptor(window, 'devicePixelRatio')
  const prevFocus = document.hasFocus
  const prevCw = Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, 'clientWidth')
  const prevCh = Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, 'clientHeight')
  const prevGetContext = window.HTMLCanvasElement.prototype.getContext

  w.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Object.defineProperty(window, 'devicePixelRatio', { configurable: true, get: () => dpr })
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
  w.requestAnimationFrame = globalThis.requestAnimationFrame
  w.cancelAnimationFrame = globalThis.cancelAnimationFrame
  document.hasFocus = () => true
  Object.defineProperty(window.HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 800 })
  Object.defineProperty(window.HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 600 })

  window.HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, kind: string): unknown {
    if (kind === '2d') {
      const cw = this.width || 1, ch = this.height || 1
      const rgba = new Uint8ClampedArray(cw * ch * 4)
      let currentFont = '400 10px monospace'
      let glyphPx = 10
      let clipX = 0, clipY = 0, clipW = cw, clipH = ch
      return {
        fillStyle: '#fff',
        textAlign: 'left',
        textBaseline: 'alphabetic',
        set font(f: string) {
          currentFont = f
          ctrl.atlasFonts.push(f)
          const m = /(\d+(?:\.\d+)?)px/.exec(f)
          glyphPx = m ? Number(m[1]) : 10
        },
        get font() { return currentFont },
        measureText: (txt: string) => ({
          width: txt.length * glyphPx * 0.6,
          fontBoundingBoxAscent: glyphPx * 0.8,
          fontBoundingBoxDescent: glyphPx * 0.2,
        }),
        save() {},
        restore() {},
        beginPath() {},
        rect(x: number, y: number, rw: number, rh: number) { clipX = x; clipY = y; clipW = rw; clipH = rh },
        clip() {},
        fillRect(x: number, y: number, rw: number, rh: number) {
          for (let py = y; py < y + rh && py < ch; py++) {
            for (let px = x; px < x + rw && px < cw; px++) {
              const idx = (py * cw + px) * 4
              rgba[idx] = 180; rgba[idx + 1] = 180; rgba[idx + 2] = 180; rgba[idx + 3] = 255
            }
          }
        },
        fillText(txt: string) {
          if (!txt || txt === ' ') return
          // 1px text on a 2D canvas produces sub-threshold alpha (< 8), reproducing the zoom-out blanking bug
          const alpha = glyphPx >= 4 ? 255 : 2
          const gx = Math.min(clipW - 1, Math.max(1, Math.floor(clipW / 2)))
          const gy = Math.min(clipH - 1, Math.max(1, Math.floor(clipH / 2)))
          const idx = ((clipY + gy) * cw + (clipX + gx)) * 4
          if (idx + 3 < rgba.length) rgba[idx + 3] = alpha
        },
        getImageData: () => ({ data: rgba }),
      }
    }
    if (kind === 'webgl2') {
      const canvasEl = this
      const SIGNALED = 0x9119, UNSIGNALED = 0x9118, SYNC_STATUS = 0x9114
      const COMPILE_STATUS = 0x8B81, LINK_STATUS = 0x8B82, ACTIVE_UNIFORMS = 0x8B86
      return {
        SIGNALED, UNSIGNALED, SYNC_STATUS, COMPILE_STATUS, LINK_STATUS, ACTIVE_UNIFORMS,
        VERTEX_SHADER: 0x8B31, FRAGMENT_SHADER: 0x8B30,
        TEXTURE0: 0x84C0, TEXTURE1: 0x84C1, TEXTURE2: 0x84C2, TEXTURE3: 0x84C3,
        TEXTURE_2D: 0x0DE1, TEXTURE_WRAP_S: 0x2802, TEXTURE_WRAP_T: 0x2803,
        TEXTURE_MIN_FILTER: 0x2801, TEXTURE_MAG_FILTER: 0x2800,
        CLAMP_TO_EDGE: 0x812F, NEAREST: 0x2600, LINEAR: 0x2601,
        FRAMEBUFFER: 0x8D40, COLOR_ATTACHMENT0: 0x8CE0,
        DEPTH_TEST: 0x0B71, BLEND: 0x0BE2, ONE: 1, ONE_MINUS_SRC_ALPHA: 0x0303,
        UNPACK_ALIGNMENT: 0x0CF5, R8: 0x8229, RED: 0x1903,
        RGBA8: 0x8058, RGBA: 0x1908, RGBA8UI: 0x8D7C, RGBA_INTEGER: 0x8D99,
        UNSIGNED_BYTE: 0x1401, COLOR_BUFFER_BIT: 0x4000, TRIANGLES: 0x0004,
        SYNC_GPU_COMMANDS_COMPLETE: 0x9117, RENDERER: 0x1F01,
        getExtension: (name: string) => {
          if (ctrl.contextLost) return null
          if (name === 'WEBGL_debug_renderer_info') return { UNMASKED_RENDERER_WEBGL: 0x9246 }
          if (name === 'WEBGL_lose_context') {
            return {
              loseContext() {
                ctrl.contextLost = true
                ctrl.ctxGen += 1
                const ev = new window.Event('webglcontextlost', { cancelable: true })
                canvasEl.dispatchEvent(ev)
                ctrl.lastLostPrevented = ev.defaultPrevented
              },
              restoreContext() {
                if (!ctrl.lastLostPrevented) return
                ctrl.contextLost = false
                canvasEl.dispatchEvent(new window.Event('webglcontextrestored'))
              },
            }
          }
          return null
        },
        getParameter: (p: number) => p === ACTIVE_UNIFORMS ? 0 : 'ANGLE (NVIDIA GeForce RTX, Direct3D11)',
        isContextLost: () => ctrl.contextLost,
        disable() {}, enable() {}, blendFunc() {}, pixelStorei() {},
        createShader: () => (ctrl.contextLost ? null : { gen: ctrl.ctxGen }), shaderSource() {}, compileShader() {},
        getShaderParameter: (s: { gen?: number } | null) => !ctrl.contextLost && s?.gen === ctrl.ctxGen,
        createProgram: () => (ctrl.contextLost ? null : { gen: ctrl.ctxGen }), attachShader() {}, linkProgram() {},
        getProgramParameter: (p: { gen?: number } | null, pname: number) =>
          pname === LINK_STATUS ? (!ctrl.contextLost && p?.gen === ctrl.ctxGen) : 0,
        getActiveUniform: () => null, getUniformLocation: () => ({}),
        createTexture: () => (ctrl.contextLost ? null : { gen: ctrl.ctxGen }), activeTexture() {},
        bindTexture(_target: number, tex: { gen?: number } | null) {
          if (tex && tex.gen !== ctrl.ctxGen) ctrl.invalidResourceUses += 1
        },
        texParameteri() {},
        createFramebuffer: () => (ctrl.contextLost ? null : { gen: ctrl.ctxGen }),
        bindFramebuffer(_target: number, fb: { gen?: number } | null) {
          if (fb && fb.gen !== ctrl.ctxGen) ctrl.invalidResourceUses += 1
        },
        framebufferTexture2D() {},
        useProgram(p: { gen?: number } | null) {
          if (!p || p.gen !== ctrl.ctxGen) ctrl.invalidResourceUses += 1
        },
        uniform1ui() {}, uniform1i() {}, uniform1f() {},
        uniform2f() {}, uniform2i() {}, uniform3f() {}, uniform4f() {}, uniform4fv() {},
        texImage2D() {}, viewport() {}, clearColor() {}, clear() {}, drawArrays() {},
        fenceSync: () => (ctrl.contextLost ? null : { gen: ctrl.ctxGen }),
        getSyncParameter: () => ctrl.contextLost ? null : (ctrl.fenceSignaled ? SIGNALED : UNSIGNALED),
        deleteSync() {},
        readPixels(_x: number, _y: number, _w: number, _h: number, _f: number, _t: number, out: Uint8Array) {
          if (!ctrl.contextLost && out.length > 0) out[0] = 128
        },
      }
    }
    return null
  } as typeof window.HTMLCanvasElement.prototype.getContext

  t.after(() => {
    w.ResizeObserver = prevRo
    if (prevDpr) Object.defineProperty(window, 'devicePixelRatio', prevDpr)
    document.hasFocus = prevFocus
    if (prevCw) Object.defineProperty(window.HTMLElement.prototype, 'clientWidth', prevCw)
    if (prevCh) Object.defineProperty(window.HTMLElement.prototype, 'clientHeight', prevCh)
    window.HTMLCanvasElement.prototype.getContext = prevGetContext
  })
  return ctrl
}

test('buildAtlas keeps a readable glyph size when zoomed far out and retires slow GPU fences without double-faulting', (t) => {
  const ctrl = installAsciiGlEnv(t, 1)
  // At extreme zoom-out (scale=0.15) where gridFor clamps cellWidth to 5, buildAtlas must not rasterize at 1px
  const atlas = buildAtlas(document, 5, 10, 'monospace', 0.15)
  assert.equal(atlas.missing.some(m => !m), true, 'zoomed-out 5x10 atlas must retain visible glyphs instead of blanking to 1px')

  const visit = visitFromSeed(42, 'mixed')
  const renderer = createAsciiRenderer(document, visit, 'monospace')
  assert.equal(renderer === null, false)
  const grid = gridFor(800, 600, 1)!
  assert.equal(renderer!.resize({
    grid, originX: 0, originY: 0, sampleX: 7, sampleY: 7,
    canvasSizeX: 800, canvasSizeY: 600, calmRadiiX: 200, calmRadiiY: 140,
    cellOriginX: 0, cellOriginY: 0, cellCentreX: 3.5, cellCentreY: 7,
    cellWorldW: 7, cellWorldH: 14, cssLeft: 0, cssTop: 0, cssW: 800, cssH: 600,
  }), true)

  ctrl.fenceSignaled = false
  const fv = { originX: 0, originY: 0, calmCx: 400, calmCy: 300 }
  for (let i = 1; i <= 5; i++) renderer!.draw(i, 1, null, fv)
  assert.equal(renderer!.fellBehind(), false, '1st unsignaled check after fence creation at draw 4 is not yet a fault')
  renderer!.draw(6, 1, null, fv)
  assert.equal(renderer!.fellBehind(), true, '2nd unsignaled check on the head fence signals fellBehind')
  renderer!.draw(7, 1, null, fv)
  assert.equal(renderer!.fellBehind(), false, 'slow fence must be retired on strike so draw 7 does not immediately double-fault on the same fence')
  renderer!.destroy()
})

test('Claude Waves bounds high-DPI zoom-out cost, degrades cleanly under outside load without leaving a frozen frame, and recovers automatically from load and WebGL context loss', async (t) => {
  const ctrl = installAsciiGlEnv(t, 2)
  stubReducedMotion(t, false)
  const viewRef = { current: { x: 0, y: 0, z: 1 } }
  let api: AsciiTestApi | null = null
  const mounted = await mountView(
    <div>
      <AsciiLayer view={viewRef.current} viewRef={viewRef} hidden={false} intensity={1}
        pin={{ seed: 42, pool: 'mixed' }} onReady={a => { api = a }} />
      <div className="sq" data-card="coordinator-opus">coordinator-opus</div>
    </div>,
    el => el,
  )
  t.after(async () => { await mounted.unmount() })
  for (let i = 0; i < 20 && !api; i++) {
    await inAct(async () => { await new Promise(r => setTimeout(r, 20)); await flush(4) })
  }
  assert.equal(api === null, false, 'AsciiLayer should initialize with mock WebGL2')

  // 1. High-DPI zoom-out bounding: at dpr=2, zooming out to z=0.35 and z=0.05 keeps the z=1 cellWidth (13) and moving state
  const stateAt1 = api!.state()
  viewRef.current = { x: -400, y: -300, z: 0.35 }
  api!.drawAt(8, 1)
  const canvasAt035 = mounted.el.querySelector('canvas')!
  assert.equal(canvasAt035 === null, false)
  const state035 = api!.state()
  assert.equal(state035.cellWidth, stateAt1.cellWidth, 'zoom-out below z=1 preserves z=1 screen-space glyph cell width')
  assert.ok((state035.cellWidth ?? 0) >= 13, `expected dpr=2 zoom-out cellWidth >= 13, got ${state035.cellWidth}`)
  viewRef.current = { x: -400, y: -300, z: 0.05 }
  api!.drawAt(9, 1)
  const state005 = api!.state()
  assert.equal(state005.columns, state035.columns, 'zooming below 0.35 clamps to the minimum ASCII zoom grid')
  assert.equal(state005.rows, state035.rows)
  assert.equal(state005.datasetState, 'moving')

  // 1b. Pointer wake vs card-click ripple separation:
  // Stir a pointer wake on the floor, then click a .sq card: wakeBusy/touchBusy are true, but tapBusy/tapCount stay false/0
  viewRef.current = { x: 0, y: 0, z: 1 }
  const hostParent = mounted.el.querySelector('.canvas-bg-ascii')!.parentElement!
  const cardEl = mounted.el.querySelector('.sq')!
  const PointerEv = window.PointerEvent ?? window.MouseEvent
  for (let i = 0; i <= 6; i++) {
    hostParent.dispatchEvent(new PointerEv('pointermove', { bubbles: true, clientX: 40 + i * 35, clientY: 120 }))
    await new Promise(r => setTimeout(r, 40))
  }
  assert.equal(api!.state().wakeBusy, true, 'pointer sweep over floor stirs a wake')
  assert.equal(api!.state().tapBusy, false, 'pointer sweep alone creates no tap ripple')
  cardEl.dispatchEvent(new PointerEv('pointerdown', { bubbles: true, button: 0, clientX: 350, clientY: 240 }))
  const afterCardClick = api!.state()
  assert.equal(afterCardClick.touchBusy, true, 'pre-existing pointer wake keeps touchBusy true')
  assert.equal(afterCardClick.tapBusy, false, 'clicking a .sq card must not emit a tap ripple')
  assert.equal(afterCardClick.tapCount, 0)
  hostParent.dispatchEvent(new PointerEv('pointerdown', { bubbles: true, button: 0, clientX: 120, clientY: 120 }))
  const afterFloorClick = api!.state()
  assert.equal(afterFloorClick.tapBusy, true, 'clicking the empty floor emits a tap ripple')
  assert.equal(afterFloorClick.tapCount, 1)

  // 2. Graceful degradation under heavy outside GPU/CPU load:
  const simLoad = (api as unknown as { simulateLoad?: (kind: 'gpu' | 'late' | 'stall', count?: number) => void }).simulateLoad
  assert.equal(typeof simLoad, 'function', 'AsciiTestApi exposes simulateLoad for deterministic load testing')
  simLoad!('gpu', 1)
  assert.equal(api!.state().datasetState, 'busy-gpu')
  assert.equal(api!.state().running, true, '1st GPU fault backs off frame rate while continuing to run')
  simLoad!('gpu', 1)
  const pausedState = api!.state()
  assert.equal(pausedState.running, false, '2nd GPU fault pauses the loop cleanly')
  const pausedCanvas = mounted.el.querySelector('canvas')!
  assert.equal(pausedCanvas.style.opacity, '0', 'paused backdrop must fade opacity to 0 so a frozen frame never sticks to the viewport while panning/zooming')

  // Wait for automatic recovery (must recover within ~2.5s, never stuck for 60s)
  for (let i = 0; i < 30 && !api!.state().running; i++) {
    await inAct(async () => { await new Promise(r => setTimeout(r, 100)); await flush(2) })
  }
  assert.equal(api!.state().running, true, 'backdrop must recover automatically after outside load subsides')

  // 3. Real WEBGL_lose_context loss & restoration (invalidating pre-loss GL resources):
  const renderer = api!.renderer()!
  const glCanvas = renderer.canvas
  assert.equal(renderer.loseContext(), true, 'WEBGL_lose_context.loseContext() succeeds')
  assert.equal(ctrl.lastLostPrevented, true, 'webglcontextlost must call preventDefault so context can restore')
  assert.equal(renderer.isContextLost(), true)
  assert.equal(renderer.readWind(), null, 'readWind returns null while GL context is lost')
  assert.equal(api!.state().running, false, 'loop stops while WebGL context is lost')
  assert.equal(glCanvas.style.opacity, '0', 'lost context hides canvas instead of leaving a dead element')

  assert.equal(renderer.restoreContext(), true, 'WEBGL_lose_context.restoreContext() succeeds')
  await inAct(async () => { await new Promise(r => setTimeout(r, 50)); await flush(4) })
  assert.equal(renderer.isContextLost(), false)
  assert.equal(api!.state().running, true, 'webglcontextrestored automatically rebuilds the renderer and resumes animation')
  api!.drawAt(10, 1)
  const windAfterRestore = renderer.readWind()
  assert.equal(windAfterRestore === null, false, 'regenerated GL resources draw and read back wind texture after context restore')
  assert.equal(windAfterRestore!.data[0], 128)
  assert.equal(ctrl.invalidResourceUses, 0, 'restored renderer must never bind or use invalidated pre-loss GL programs, textures, or framebuffers')
  assert.equal(mounted.el.querySelector('canvas') === null, false, 'canvas remains mounted after context restoration')
})
