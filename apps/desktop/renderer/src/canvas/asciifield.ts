/* The flowing-ASCII backdrop's mathematics — pure functions, no DOM, no
 * GL — shared by the WebGL renderer (asciigl.ts), the layer orchestration
 * (canvasbackground.tsx) and the tests.
 *
 * This is an independent re-implementation of the Claude Code desktop
 * "New session" backdrop algorithm, written from a prose/math study of the
 * real renderer under the user's 2026-10-15 ruling (read the real code
 * read-only; copy none of it; parameters and algorithm matched). The model
 * in brief: a seeded per-visit wind (heading, speed, gust size, bend)
 * carries a field of gradient-noise gusts in its own frame; the field's
 * strength lights a grid of glyphs, each cell cycling through one of three
 * character pools at its own hashed pace; pointer motion warms wakes and
 * clicks launch ripples (every third in a heart shape); a power budget
 * settles the whole thing to calm after minutes unless roused. The CPU
 * mirror of the field at the bottom exists so tests can compare the GL
 * output against this spec numerically at a pinned seed. */

/** Every tunable, grouped as the reference groups them. Adaptations for
 *  Orgtree (world-space sampling, intensity = strength.scale) live in the
 *  layer, not by editing these values. */
export const ASCII_CONFIG = {
  strength: { scale: 1, base: { dark: 0.26, light: 0.26 }, cap: { dark: 0.9, light: 0.9 }, rest: 0.03 },
  surface: { fill: 1, weight: 300, glyphCss: 9, skipUnseen: true },
  wind: {
    energy: 1, friction: 0.6, flick: 1.2, lull: 0.5, streak: 0.4, detail: 0.6,
    edge: 0.75, curl: 0.65, wisp: 0.5, tail: 0.35, sweep: 0.3, morph: 3, revealS: 4,
  },
  glow: { amount: 1, headroom: 3, color: { dark: [0.1, 0.68, 1], light: [0, 0.25, 1] } },
  touch: { stir: 1, ripple: 1, slowPxS: 60, fastPxS: 800 },
  card: { centerY: 0.45, calmX: 250, calmY: 80, left: 0.3 },
  grid: { cellCss: 6.5, minCols: 24, minRows: 8, maxDevicePixels: 21_000_000 },
  power: {
    frameMs: 40, rippleFrameMs: 10, backoffFrameMs: 83, budgetS: 180, settleS: 8,
    resumeS: 3, retryS: 60, retryMaxS: 480, resizeSettleMs: 150, linkDeadlineMs: 20_000,
  },
} as const

/** The atlas set: printable ASCII in code order, plus the middle dot. */
export const ATLAS_CHARS: string =
  Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).join('') + '·'
export const ATLAS_COLS = 16
export const ATLAS_ROWS = 6

/** The three character pools ("looks"), in cycle order. Parameters of the
 *  reference algorithm, recorded from study. */
export const GLYPH_POOLS = {
  mixed: 'ab0cAde1fEgh2iGjk3lHmn4oKpq5rMst6uRvw7xSyz8nT9eW',
  lettered: 'abcd3efgRhijk7lmnAopqr0stuEvwxy5zaeKiou2gcS9',
  figured: '0a1b2C3d4e5F6g7h8i9J0k1m2N3p4q5R6s7t8U9v0w1X2y3z',
} as const
export type GlyphPoolKey = keyof typeof GLYPH_POOLS
export const GLYPH_POOL_KEYS = Object.keys(GLYPH_POOLS) as GlyphPoolKey[]

/** Clamped cubic smoothstep on [0,1] — the one easing used everywhere. */
export function smooth01(x: number): number {
  const t = Math.min(1, Math.max(0, x))
  return t * t * (3 - 2 * t)
}

/** Xorshift-multiply u32 finalizer (the JS-side visit hash). */
export function hash32(v: number): number {
  let t = v >>> 0
  t = Math.imul(t ^ (t >>> 16), 569420461)
  t = Math.imul(t ^ (t >>> 15), 1935289751)
  return (t ^ (t >>> 15)) >>> 0
}

/** A labelled deterministic stream: fold the label's chars into the hash,
 *  then step by the golden-ratio increment, hashing each draw. */
export function rngStream(seed: number, label: string): () => number {
  let state = hash32(seed)
  for (const ch of label) state = hash32(state ^ ch.charCodeAt(0))
  return () => {
    state = (state + 2654435769) >>> 0
    return hash32(state) / 4294967296
  }
}

/** Pick this visit's pool: one not among the recent looks if possible, else
 *  one differing from the most recent, else any — seeded, never Math.random. */
export function pickLook(seed: number, recent: readonly string[], keys: readonly GlyphPoolKey[] = GLYPH_POOL_KEYS): GlyphPoolKey {
  const fresh = keys.filter(k => !recent.includes(k))
  const notLast = keys.filter(k => k !== recent[0])
  const pool = fresh.length > 0 ? fresh : notLast.length > 0 ? notLast : keys
  return pool[Math.floor(rngStream(seed, 'look')() * pool.length)] ?? 'mixed'
}

export interface AsciiVisit {
  key: GlyphPoolKey
  seed: number
  heading: number
  speed: number
  gustLength: number
  gustWidth: number
  bend: number
  bendScale: number
}

/** Heading draw: an angle sliding π/10 → π/4.3 across u, mirrored past u=½
 *  so the wind always blows sideways, never straight up or down. */
export function headingFor(u: number): number {
  const lo = Math.PI / 10
  const a = lo + (Math.PI / 4.3 - lo) * ((u * 2) % 1)
  return u < 0.5 ? a : Math.PI - a
}

/** Everything one mount ("visit") fixes for its lifetime, drawn from the
 *  seed in a fixed order: heading, speed, gustLength, gustWidth, bend,
 *  bendScale. Speeds/sizes in CSS px (world units in Orgtree at zoom 1). */
export function visitFromSeed(seed: number, look: string): AsciiVisit {
  const next = rngStream(seed, 'wind')
  const between = (a: number, b: number): number => a + (b - a) * next()
  const heading = headingFor(next())
  const speed = between(42, 64)
  const gustLength = between(380, 560)
  const gustWidth = between(120, 190)
  const bend = between(60, 110)
  const bendScale = between(300, 440)
  return {
    key: (look in GLYPH_POOLS ? look : 'mixed') as GlyphPoolKey,
    seed: seed >>> 0, heading, speed, gustLength, gustWidth, bend, bendScale,
  }
}

export interface AsciiGrid {
  cellWidth: number
  cellHeight: number
  columns: number
  rows: number
  left: number
  top: number
  scale: number
}

/** Grid geometry for a device-pixel size: cells 6.5 CSS px wide (min 5
 *  device px) and twice as tall, centred, shrunk to the device-pixel
 *  budget; null when the pane is too small to bother (or degenerate). */
export function gridFor(deviceWidth: number, deviceHeight: number, devicePixelRatio: number): AsciiGrid | null {
  const { grid } = ASCII_CONFIG
  const dpr = devicePixelRatio
  if (!(deviceWidth > 0 && deviceHeight > 0 && dpr > 0)) return null
  const cellWidth = Math.max(5, Math.round(grid.cellCss * dpr))
  const cellHeight = cellWidth * 2
  let columns = Math.ceil(deviceWidth / cellWidth)
  let rows = Math.ceil(deviceHeight / cellHeight)
  if (columns < grid.minCols || rows < grid.minRows) return null
  const over = (columns * cellWidth * rows * cellHeight) / grid.maxDevicePixels
  if (over > 1) {
    columns = Math.floor(columns / Math.sqrt(over))
    rows = Math.floor(rows / Math.sqrt(over))
  }
  return {
    cellWidth, cellHeight, columns, rows,
    left: Math.round((deviceWidth - columns * cellWidth) / 2),
    top: Math.round((deviceHeight - rows * cellHeight) / 2),
    scale: dpr,
  }
}

/* ── touch: pointer wakes and tap ripples ────────────────────────────────
 * All coordinates are in the field's own units (CSS px in the reference;
 * world units in Orgtree — the layer converts at record time). */

export interface AsciiTap { x: number; y: number; at: number; force: number; wayX: number; wayY: number }
export interface AsciiTouchFrame {
  now: number
  tapCount: number
  taps: Float32Array
  wakeCount: number
  wakes: Float32Array
  ways: Float32Array
}

const TAP_LIFE_S = 3.6
const WAKE_LIFE_S = 2.4
const SPEED_TAU_S = 0.08
const WAKE_MIN_DIST = 18
const WAKE_MIN_DT = 0.035
const WAKE_RISE_S = 0.05
const WAKE_DECAY_S = 0.65
const WAKE_REACH_BASE = 50
const WAKE_REACH_GROWTH = 40
const MAX_TAPS = 6
const MAX_WAKES = 48

export interface AsciiTouch {
  /** Pointer moved; returns true when a wake was emitted. */
  move: (x: number, y: number, now: number) => boolean
  /** Pointer tapped (every third tap is the heart). */
  tap: (x: number, y: number, now: number) => void
  leave: () => void
  busy: (now: number) => boolean
  rippling: (now: number) => boolean
  frame: (now: number) => AsciiTouchFrame
  /** Unfiltered live tap records (CPU-mirror/tests). */
  liveTaps: (now: number) => AsciiTap[]
}

export function createTouch(): AsciiTouch {
  const { touch } = ASCII_CONFIG
  let taps: AsciiTap[] = []
  let wakeRecs: AsciiTap[] = []
  let last: { x: number; y: number; at: number } | null = null
  let anchor: { x: number; y: number; at: number } | null = null
  let speedEma = 0
  let tapTotal = 0
  const out: AsciiTouchFrame = {
    now: 0, tapCount: 0, taps: new Float32Array(24),
    wakeCount: 0, wakes: new Float32Array(192), ways: new Float32Array(192),
  }
  return {
    move(x, y, now) {
      if (!last || !anchor || now - last.at > 0.25) {
        last = { x, y, at: now }
        anchor = last
        speedEma = 0
        return false
      }
      const dt = Math.max(now - last.at, 1 / 240)
      const dist = Math.hypot(x - last.x, y - last.y)
      speedEma += (dist / dt - speedEma) * Math.min(1, dt / SPEED_TAU_S)
      last = { x, y, at: now }
      const span = Math.hypot(x - anchor.x, y - anchor.y)
      if (span < WAKE_MIN_DIST || now - anchor.at < WAKE_MIN_DT) return false
      const force0 = touch.stir * smooth01((speedEma - touch.slowPxS) / (touch.fastPxS - touch.slowPxS))
      const from = anchor
      anchor = last
      if (force0 < 0.04) return false
      wakeRecs = [...wakeRecs.slice(-(MAX_WAKES - 1)), {
        x: (x + from.x) / 2, y: (y + from.y) / 2, at: now,
        force: force0 * span / (span + 90), wayX: (x - from.x) / 2, wayY: (y - from.y) / 2,
      }]
      return true
    },
    tap(x, y, now) {
      tapTotal += 1
      const force = tapTotal % 3 === 0 ? -1.15 * touch.ripple : touch.ripple
      taps = [...taps.slice(-(MAX_TAPS - 1)), { x, y, at: now, force, wayX: 0, wayY: 0 }]
    },
    leave() { last = null },
    busy: now => taps.some(t => now - t.at < TAP_LIFE_S) || wakeRecs.some(w => now - w.at < WAKE_LIFE_S),
    rippling: now => taps.some(t => now - t.at < TAP_LIFE_S),
    liveTaps: now => taps.filter(t => now - t.at < TAP_LIFE_S),
    frame(now) {
      taps = taps.filter(t => now - t.at < TAP_LIFE_S)
      wakeRecs = wakeRecs.filter(w => now - w.at < WAKE_LIFE_S)
      out.now = now
      out.tapCount = taps.length
      taps.forEach((t, i) => { out.taps.set([t.x, t.y, t.at, t.force], i * 4) })
      const missing = MAX_WAKES - wakeRecs.length
      let count = 0
      wakeRecs.forEach((w, i) => {
        const age = Math.max(0, now - w.at)
        const warm = w.force * Math.min(1, (i + 1 + missing) / 8)
          * (1 - Math.exp(-age / WAKE_RISE_S)) * Math.exp(-age / WAKE_DECAY_S)
        if (warm < 0.002) return
        const reach = WAKE_REACH_BASE + WAKE_REACH_GROWTH * age
        const len = Math.hypot(w.wayX, w.wayY)
        out.wakes.set([w.x, w.y, warm, 1 / (reach * reach)], count * 4)
        out.ways.set([w.wayX / (len || 1), w.wayY / (len || 1), len, 0], count * 4)
        count += 1
      })
      out.wakeCount = count
      return out
    },
  }
}

/* ── CPU mirror of the field mathematics ─────────────────────────────────
 * The same math the shaders run, in TypeScript, so tests can pin the GL
 * output numerically. u32 ops go through Math.imul/>>>0 to stay bit-exact
 * with GLSL uint arithmetic (including wraparound of negative lattice
 * coordinates, which world-space sampling produces). */

/** PCG hash (published constants). */
export function pcg(v: number): number {
  const s = (Math.imul(v >>> 0, 747796405) + 2891336453) >>> 0
  const w = Math.imul(((s >>> ((s >>> 28) + 4)) ^ s) >>> 0, 277803737)
  return ((w >>> 22) ^ w) >>> 0
}

export const unitFromHash = (h: number): number => (h >>> 8) * (1 / 16777216)

const latticeHashes = (ix: number, iy: number, iz: number, seed: number, salt: number) => {
  const z0 = pcg(((iz >>> 0) ^ seed ^ salt) >>> 0)
  const z1 = pcg((((iz + 1) >>> 0) ^ seed ^ salt) >>> 0)
  return {
    x0: ix >>> 0, x1: (ix + 1) >>> 0,
    a: pcg(((iy >>> 0) ^ z0) >>> 0), b: pcg((((iy + 1) >>> 0) ^ z0) >>> 0),
    c: pcg(((iy >>> 0) ^ z1) >>> 0), d: pcg((((iy + 1) >>> 0) ^ z1) >>> 0),
  }
}

const fade = (f: number): number => f * f * f * (f * (f * 6 - 15) + 10)
const mix = (a: number, b: number, t: number): number => a + (b - a) * t
const cornerValue = (v: number): number => unitFromHash(pcg(v)) * 2 - 1

/** 3D value noise on a seed-hashed integer lattice, about [−1, 1]. */
export function valueNoise(px: number, py: number, pz: number, seed: number, salt: number): number {
  const ix = Math.floor(px), iy = Math.floor(py), iz = Math.floor(pz)
  const fx = px - ix, fy = py - iy, fz = pz - iz
  const { x0, x1, a, b, c, d } = latticeHashes(ix, iy, iz, seed >>> 0, salt >>> 0)
  const wx = fade(fx), wy = fade(fy), wz = fade(fz)
  return mix(
    mix(mix(cornerValue((x0 ^ a) >>> 0), cornerValue((x1 ^ a) >>> 0), wx),
      mix(cornerValue((x0 ^ b) >>> 0), cornerValue((x1 ^ b) >>> 0), wx), wy),
    mix(mix(cornerValue((x0 ^ c) >>> 0), cornerValue((x1 ^ c) >>> 0), wx),
      mix(cornerValue((x0 ^ d) >>> 0), cornerValue((x1 ^ d) >>> 0), wx), wy),
    wz)
}

const slopeOf = (v: number): [number, number, number] => {
  const h = pcg(v)
  return [
    (h & 1023) * (2 / 1023) - 1,
    ((h >>> 10) & 1023) * (2 / 1023) - 1,
    ((h >>> 20) & 1023) * (2 / 1023) - 1,
  ]
}

/** Gradient noise on the same lattice (“swirl”): crosses zero between
 *  lattice points, scaled ×1.5, about [−1, 1]. */
export function gradientNoise(px: number, py: number, pz: number, seed: number, salt: number): number {
  const ix = Math.floor(px), iy = Math.floor(py), iz = Math.floor(pz)
  const fx = px - ix, fy = py - iy, fz = pz - iz
  const { x0, x1, a, b, c, d } = latticeHashes(ix, iy, iz, seed >>> 0, salt >>> 0)
  const wx = fade(fx), wy = fade(fy), wz = fade(fz)
  const dot = (g: [number, number, number], ox: number, oy: number, oz: number): number =>
    g[0] * (fx - ox) + g[1] * (fy - oy) + g[2] * (fz - oz)
  return 1.5 * mix(
    mix(mix(dot(slopeOf((x0 ^ a) >>> 0), 0, 0, 0), dot(slopeOf((x1 ^ a) >>> 0), 1, 0, 0), wx),
      mix(dot(slopeOf((x0 ^ b) >>> 0), 0, 1, 0), dot(slopeOf((x1 ^ b) >>> 0), 1, 1, 0), wx), wy),
    mix(mix(dot(slopeOf((x0 ^ c) >>> 0), 0, 0, 1), dot(slopeOf((x1 ^ c) >>> 0), 1, 0, 1), wx),
      mix(dot(slopeOf((x0 ^ d) >>> 0), 0, 1, 1), dot(slopeOf((x1 ^ d) >>> 0), 1, 1, 1), wx), wy),
    wz)
}

/** How far a heart's outline lies in direction (ux, uy) (unit, y down)
 *  against a circle's 1 — solved by fixed-point iteration. */
export function heartRadius(ux: number, uy: number): number {
  const k = -ux * ux * uy * uy * uy
  const c = Math.sign(k) * Math.pow(Math.abs(k), 1 / 3)
  let r = 1
  for (let i = 0; i < 6; i++) r = Math.sqrt(Math.max(0.05, 1 + c * Math.pow(r, 5 / 3)))
  return r
}

export interface TapEffect { pushX: number; pushY: number; raise: number; rouse: number; glowX: number; glowY: number }

/** The combined effect of all live taps at a point: an expanding front
 *  (heart-shaped for negative-force taps) that pushes air outward, raises
 *  the wind in rings behind it, and leaves a fading glow trail. */
export function tapsAt(px: number, py: number, taps: readonly AsciiTap[], now: number): TapEffect {
  let pushX = 0, pushY = 0, raise = 0, rouse = 0, glowX = 0, glowY = 0
  for (const tap of taps.slice(0, MAX_TAPS)) {
    const age = now - tap.at
    const awayX = px - tap.x, awayY = py - tap.y
    const d = Math.hypot(awayX, awayY)
    const reach = tap.force < 0 ? d / heartRadius(awayX / Math.max(d, 1), awayY / Math.max(d, 1)) : d
    const behind = 620 * (1 - Math.exp(-age / 1.3)) - reach
    const width = 85 + 60 * age
    const front = smooth01((behind + 16) / 26) * Math.exp(-behind * behind / (width * width))
    const swell = Math.abs(tap.force) * Math.exp(-age / 1.5) * front
    pushX += (awayX / Math.max(d, 1)) * (44 * swell)
    pushY += (awayY / Math.max(d, 1)) * (44 * swell)
    raise += 1.9 * swell * (0.25 + 0.75 * Math.cos(behind * (Math.PI * 2 / 130)))
    rouse += swell
    const trail = smooth01(behind / 70) * Math.exp(-Math.max(behind, 0) / 260)
    glowX += Math.abs(tap.force) * (Math.exp(-age / 1.0) * front + 0.7 * Math.exp(-age / 1.3) * trail)
    glowY += Math.abs(tap.force) * (1 - Math.exp(-age / 0.2)) * Math.exp(-age / 1.2) * trail
  }
  return { pushX, pushY, raise, rouse, glowX, glowY }
}

/** Warmth left by the moving hand: capsule segments with gaussian falloff,
 *  saturated so stirring can only warm so far. Reads the packed frame. */
export function warmthAt(px: number, py: number, frame: AsciiTouchFrame): number {
  let warmth = 0
  for (let i = 0; i < frame.wakeCount; i++) {
    const wx = frame.wakes[i * 4] ?? 0, wy = frame.wakes[i * 4 + 1] ?? 0
    const warm = frame.wakes[i * 4 + 2] ?? 0, inv = frame.wakes[i * 4 + 3] ?? 0
    const dx = frame.ways[i * 4] ?? 0, dy = frame.ways[i * 4 + 1] ?? 0, half = frame.ways[i * 4 + 2] ?? 0
    let ax = px - wx, ay = py - wy
    const along = Math.min(half, Math.max(-half, ax * dx + ay * dy))
    ax -= dx * along
    ay -= dy * along
    warmth += warm * Math.exp(-(ax * ax + ay * ay) * inv)
  }
  return 1 - Math.exp(-1.5 * warmth)
}

/** Distance the wind has carried the field by time t (surges and slackens). */
export function carriedAt(time: number, visit: AsciiVisit): number {
  return visit.speed * (time + valueNoise(time * 0.09, 3.7, 0, visit.seed, 0x58))
}

/** The pane's extent projected onto the wind heading (swell wavelength). */
export function spanFor(visit: AsciiVisit, sizeX: number, sizeY: number): number {
  return 0.58 * (Math.abs(Math.cos(visit.heading)) * sizeX + Math.abs(Math.sin(visit.heading)) * sizeY)
}

/** Gusts in the wind's own frame: four gradient-noise octaves travelling
 *  nearly together, thin strands between, gathered on long swells. */
export function gustsAt(ax: number, ay: number, carried: number, time: number, visit: AsciiVisit, span: number): number {
  const { wind } = ASCII_CONFIG
  const gain = mix(0.38, 0.62, wind.detail)
  let gust = 0, weight = 1, power = 0
  let sizeX = 0.85 * visit.gustLength, sizeY = 0.75 * visit.gustWidth
  for (let k = 0; k < 4; k++) {
    gust += weight * gradientNoise(
      (ax - carried * (1 + 0.1 * k)) / sizeX, ay / sizeY,
      wind.morph * time * (0.03 + 0.018 * k) + 11 * k, visit.seed, 0x60 + k)
    power += weight * weight
    weight *= gain
    sizeX *= 0.5
    sizeY *= 0.58
  }
  const strand = 1 - Math.abs(gradientNoise(
    (ax - 1.15 * carried) / (0.7 * visit.gustLength), ay / (0.95 * visit.gustWidth),
    wind.morph * time * 0.05 + 2, visit.seed, 0x66))
  const swell = Math.cos(
    (ax - carried + 0.5 * span * valueNoise(time * 0.045, ay / (2.5 * visit.gustWidth), 7, visit.seed, 0x67))
    * (Math.PI * 2 / span))
  return gust / Math.sqrt(power) + wind.wisp * 0.5 * (strand * strand * strand - 0.35) + wind.sweep * swell
}

export interface FieldInput {
  x: number
  y: number
  time: number
  reveal: number
  visit: AsciiVisit
  span: number
  calmCx: number
  calmCy: number
  taps: readonly AsciiTap[]
  touchFrame: AsciiTouchFrame | null
  now: number
}
export interface FieldSample { strength: number; blowX: number; blowY: number; gate: number }

/** One wind-field sample, exactly as the wind pass computes it:
 *  strength (R), local wind direction (GB before encoding), gate (A). */
export function fieldAt(input: FieldInput): FieldSample {
  const { wind, card } = ASCII_CONFIG
  const { visit, time } = input
  const seed = visit.seed
  const headingX = Math.cos(visit.heading), headingY = Math.sin(visit.heading)
  const acrossX = -headingY, acrossY = headingX
  const carried = carriedAt(time, visit)
  const frame = input.touchFrame
  const hasTouch = input.taps.length > 0 || (frame !== null && frame.wakeCount > 0)
  let hand: TapEffect = { pushX: 0, pushY: 0, raise: 0, rouse: 0, glowX: 0, glowY: 0 }
  let warm = 0
  if (hasTouch) {
    const nearX = input.x + 24 * valueNoise(input.x / 95, input.y / 95, input.now * 0.12, seed, 0x71)
    const nearY = input.y + 24 * valueNoise(input.x / 95 + 9.1, input.y / 95 + 9.1, input.now * 0.12 + 4, seed, 0x72)
    hand = tapsAt(nearX, nearY, input.taps, input.now)
    warm = frame ? warmthAt(nearX, nearY, frame) : 0
    hand.raise += 0.25 * warm
    hand.rouse += 0.05 * warm
  }
  const fromX = input.x - hand.pushX, fromY = input.y - hand.pushY
  const turnX = valueNoise(fromX / visit.bendScale, fromY / visit.bendScale, time * 0.04, seed, 0x51)
  const turnY = valueNoise(fromX / visit.bendScale + 17.3, fromY / visit.bendScale + 17.3, time * 0.04 + 5, seed, 0x52)
  const bentX = fromX + visit.bend * turnX, bentY = fromY + visit.bend * turnY
  const qx = bentX * headingX + bentY * headingY
  const qy = bentX * acrossX + bentY * acrossY
  const ridingX = qx - 0.85 * carried, ridingY = qy
  const eddySize = 1.15 * visit.gustWidth, fineSize = 0.38 * visit.gustWidth
  const eddyX = gradientNoise(ridingX / eddySize, ridingY / eddySize, wind.morph * time * 0.04, seed, 0x59)
  const eddyY = gradientNoise(ridingX / eddySize + 31.7, ridingY / eddySize + 31.7, wind.morph * time * 0.04 + 3, seed, 0x5a)
  const foldedX = ridingX + wind.curl * 0.9 * visit.gustWidth * eddyX
  const foldedY = ridingY + wind.curl * 0.9 * visit.gustWidth * eddyY
  const fineX = gradientNoise(foldedX / fineSize, foldedY / fineSize, wind.morph * time * 0.06, seed, 0x5b)
  const fineY = gradientNoise(foldedX / fineSize + 13.1, foldedY / fineSize + 13.1, wind.morph * time * 0.06 + 7, seed, 0x5c)
  const creasedX = (foldedX + 0.3 * visit.gustWidth * fineX) / 24
  const creasedY = (foldedY + 0.3 * visit.gustWidth * fineY) / 24
  const tinyX = gradientNoise(creasedX, creasedY, time * 0.07, seed, 0x5d)
  const tinyY = gradientNoise(creasedX + 5.3, creasedY + 5.3, time * 0.07 + 1, seed, 0x5e)
  const pullScale = wind.curl * (1 + 0.9 * Math.min(hand.rouse, 1.5))
  const curledX = qx + pullScale * (visit.gustWidth * (0.9 * eddyX + 0.3 * fineX) + wind.detail * 30 * tinyX)
  const curledY = qy + pullScale * (visit.gustWidth * (0.9 * eddyY + 0.3 * fineY) + wind.detail * 30 * tinyY)
  const blX = headingX + 0.6 * turnX + hand.pushX / 14
    + wind.curl * ((0.45 * eddyX + 0.25 * fineX) * headingX + (0.45 * eddyY + 0.25 * fineY) * acrossX)
  const blY = headingY + 0.6 * turnY + hand.pushY / 14
    + wind.curl * ((0.45 * eddyX + 0.25 * fineX) * headingY + (0.45 * eddyY + 0.25 * fineY) * acrossY)
  const blLen = Math.hypot(blX, blY) || 1
  const still = gustsAt(curledX, curledY, carried, time, visit, input.span)
  const field = still + hand.raise
  const level = mix(0.02, 0.82, wind.lull)
  const band = mix(0.26, 0.03, wind.edge)
  const blowing = field > level - band - 0.55 * wind.tail
  let streaks = 0, strength = 0
  if (blowing || warm > 0) {
    const thread = valueNoise((curledX - carried * 1.6) / 140, curledY / 30, time * 0.16, seed, 0x57)
    streaks = 1 - smooth01(Math.abs(thread) / 0.5)
  }
  if (blowing) {
    const ahead = gustsAt(curledX + 56, curledY, carried, time, visit, input.span)
    const leaving = smooth01((ahead - still + 0.05) / 0.12)
    const lit = smooth01((field - (level - band - 0.55 * wind.tail * leaving)) / (2 * band + 0.55 * wind.tail * leaving))
    const broad = lit * lit * mix(0.45, 1, Math.min(1, Math.max(0, (field - level) / 0.45))) * (0.82 + 0.18 * fineY)
    strength = broad * mix(1, 0.25 + 0.95 * streaks, wind.streak)
  }
  if (warm > 0) {
    const grain = 0.55 * fineY + 0.45 * tinyX + 0.3 * (streaks - 0.4)
    strength = 1 - (1 - strength) * (1 - 0.85 * warm * smooth01((grain + 0.5) / 0.75))
  }
  const ex = (input.x - input.calmCx) / card.calmX, ey = (input.y - input.calmCy) / card.calmY
  const calm = 1 - (1 - card.left) * Math.exp(-0.9 * (ex * ex + ey * ey))
  const shown = Math.max(input.reveal, Math.min(1, 2 * hand.rouse + warm))
  return { strength: strength * calm * shown, blowX: blX / blLen, blowY: blY / blLen, gate: calm * shown }
}

/** The atlas sequence for a pool: pool chars → atlas indices (>0, present),
 *  in pool order; [index of "."] if somehow empty. */
export function sequenceFor(key: GlyphPoolKey, missing: readonly boolean[]): Uint8Array {
  const chars = [...(GLYPH_POOLS[key] ?? GLYPH_POOLS.mixed)]
  const idx = chars.map(ch => ATLAS_CHARS.indexOf(ch)).filter(i => i > 0 && missing[i] !== true)
  return Uint8Array.from(idx.length > 0 ? idx : [ATLAS_CHARS.indexOf('.')])
}

export interface GlyphChoice { glyph: number; steps: number; glowX: number; glowY: number }

/** Which glyph a cell shows at a time, and its tap glow — the vertex
 *  stage's choice, minus the wind-based unseen cull (needs field samples;
 *  tests compose it from fieldAt). Null when the fill draw skips the cell. */
export function glyphChoiceAt(
  cx: number, cy: number, time: number, seed: number,
  sequence: Uint8Array, tapEffect: TapEffect | null,
): GlyphChoice | null {
  const cell = pcg((Math.imul(cx >>> 0, 0x9E3779B9) ^ pcg(((cy >>> 0) ^ (seed >>> 0)) >>> 0)) >>> 0)
  if (unitFromHash(cell) >= ASCII_CONFIG.surface.fill) return null
  const pace = pcg(cell)
  let steps = Math.floor(time * ASCII_CONFIG.wind.flick * (0.6 + 0.8 * unitFromHash(pace)) + unitFromHash(pcg(pace)))
  let glowX = 0, glowY = 0
  if (tapEffect) {
    steps += Math.floor(6 * tapEffect.rouse + unitFromHash(pcg((pace ^ 0x33) >>> 0)))
    const vary = 0.65 + 0.35 * unitFromHash(pcg((pace ^ 0x51) >>> 0))
    glowX = tapEffect.glowX * vary
    glowY = tapEffect.glowY * vary
  }
  const at = ((cell >>> 8) + steps) % sequence.length
  return { glyph: sequence[at] ?? 0, steps, glowX, glowY }
}
