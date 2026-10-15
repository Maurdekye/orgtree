/* The organization canvas's background layer (user 2026-10-15; picker in
 * App settings > Display, canvasbgsetting.tsx; preference in
 * contracts/canvas-background.ts).
 *
 * One component in the slot the dot grid always occupied — first child of
 * `.canvas-world`, under `.space`, pointer-events none. With no preference
 * stored it renders the shipped dot grid with byte-identical inline styles,
 * parallax and all. The six grid/tile themes are pure CSS patterns
 * (styles.css) whose size and position are computed here so they pan and
 * zoom with the canvas like a floor (user ruling 2026-10-15 18:20Z); they
 * cost no JavaScript per frame beyond the style update OrgCanvas already
 * did for the dots. Intensity is the layer's opacity: patterns paint at
 * full strength in the current theme's colours, and one number fades the
 * whole layer — the same compositing as mixing alpha into every colour.
 *
 * The flowing-ASCII theme is the one animated layer: a <canvas> painted
 * from pre-rendered glyph sprites (asciifield.ts has the model), reading
 * the camera from viewRef so panning never re-renders it, throttled to
 * ~30 fps, paused while the document or the canvas world is hidden, and
 * reduced to a single still frame under prefers-reduced-motion. Its cost
 * is bounded by the viewport (asciiStep's cell budget), never by the size
 * of the organization.
 *
 * EPIC Mode needs nothing from this layer: its stage is a fixed overlay
 * far above the canvas (epic/stage.ts), so the two coexist as independent,
 * separately bounded painters. */
import { useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { useCanvasBackground } from '../canvasbgpref'
import { DEFAULT_CANVAS_INTENSITIES } from '../../../../../packages/contracts/canvas-background'
import type { CanvasBackgroundTheme } from '../../../../../packages/contracts/canvas-background'
import type { View } from './shared'
import { ASCII_BUCKETS, ASCII_CELL_H, ASCII_CELL_W, ASCII_GLYPHS, asciiBucket, asciiField, asciiGlyphAt, asciiStep } from './asciifield'

/* The ORIGINAL dot grid's pan rate relative to the foreground's (user
 * feature 2026-09-03, moved here from OrgCanvas with the layer): kept close
 * to 1 so the effect stays a tiny "farther away" cue, not a distinct layer
 * racing past the cards. Only `dots` parallaxes; the themes added in
 * 2026-10 pan 1:1 like a floor, as ruled. Zoom scales every theme 1:1. */
const PARALLAX_BG = 0.88

/** World-space pattern pitch: the dot grid's own 28, shared so switching
 *  themes keeps the floor's scale. */
const TILE = 28
const SQRT3 = Math.sqrt(3)
/** Hexagon pattern unit: tile 4u × 7u with half-tile offsets (styles.css). */
const HEX_U = 14
/** Equilateral triangle side; the conic pair's tile is S × (3√3/4)S. */
const TRI_S = 36

const px = (n: number): string => `${Math.round(n * 100) / 100}px`

/** Where a CSS theme's pattern sits for this camera. Pure, so the tests can
 *  pin the floor behaviour (and the dots' legacy values) without a DOM. */
export function bgGeometry(theme: CanvasBackgroundTheme, view: View): { backgroundPosition: string; backgroundSize: string } {
  const { x, y, z } = view
  switch (theme) {
    case 'line-grid':
      return { backgroundPosition: `${px(x)} ${px(y)}`, backgroundSize: `${px(TILE * z)} ${px(TILE * z)}` }
    case 'square-tiles':
      return { backgroundPosition: `${px(x)} ${px(y)}`, backgroundSize: `${px(2 * TILE * z)} ${px(2 * TILE * z)}` }
    case 'hex-dots': {
      const w = TILE * z, h = TILE * SQRT3 * z
      return { backgroundPosition: `${px(x)} ${px(y)}, ${px(x + w / 2)} ${px(y + h / 2)}`, backgroundSize: `${px(w)} ${px(h)}` }
    }
    case 'hex-lines':
    case 'hex-tiles': {
      const a = `${px(x)} ${px(y)}`
      const b = `${px(x + 2 * HEX_U * z)} ${px(y + 3.5 * HEX_U * z)}`
      return { backgroundPosition: `${a}, ${a}, ${b}, ${b}, ${a}, ${b}`, backgroundSize: `${px(4 * HEX_U * z)} ${px(7 * HEX_U * z)}` }
    }
    case 'triangle-tiles':
      return { backgroundPosition: `${px(x)} ${px(y)}`, backgroundSize: `${px(TRI_S * z)} ${px(TRI_S * SQRT3 * 0.75 * z)}` }
    default:
      // dots (and ascii, which never reaches here): the shipped backdrop,
      // values verbatim from the OrgCanvas div this component replaced
      return { backgroundPosition: `${x * PARALLAX_BG}px ${y * PARALLAX_BG}px`, backgroundSize: `${28 * z}px ${28 * z}px` }
  }
}

export function CanvasBackground({ view, viewRef, hidden }: {
  /** The camera as state — CSS themes repaint with OrgCanvas's own renders,
   *  exactly as the inline dot-grid div did. */
  view: View
  /** The same camera as a ref, for the ASCII painter's own frame loop. */
  viewRef: { current: View }
  /** The canvas world is put away (another view is presented). */
  hidden: boolean
}) {
  const pref = useCanvasBackground()
  const intensity = pref.intensities[pref.theme] ?? DEFAULT_CANVAS_INTENSITIES[pref.theme] ?? 1
  if (pref.theme === 'ascii') {
    return <AsciiLayer view={view} viewRef={viewRef} hidden={hidden} intensity={intensity} />
  }
  const style: CSSProperties = {
    ...bgGeometry(pref.theme, view),
    ...(pref.theme === 'dots' || pref.theme === 'hex-dots'
      ? { '--dot-r': `${Math.max(1, 1.1 * view.z).toFixed(2)}px` } : {}),
    ...(intensity < 1 ? { opacity: intensity } : {}),
  }
  return <div className="canvas-bg"
    data-canvas-bg={pref.theme === 'dots' ? undefined : pref.theme} style={style} />
}

/* ── the flowing-ASCII layer ──────────────────────────────────────────────
 * Glyphs are pre-rendered once per brightness bucket into sprite sheets
 * (one row of the whole glyph pool, tinted from the theme's accent mixed
 * toward its dim ink — the reference's faint steel tint, in whichever
 * colours the current visual theme declares). A frame is then nothing but
 * drawImage calls for the cells whose field value clears the bucket floor;
 * the reference's dark negative space costs one field sample and no paint.
 * Sheets rebuild only when the theme colours actually change (observed,
 * debounced — an animated rainbow accent rebuilds at most ~3×/s). */

const SHEET_GW = 24
const SHEET_GH = 44
const ASCII_DPR_CAP = 2
const ASCII_FRAME_MS = 33
const ASCII_TINT_MIX = 0.45
const ASCII_REBUILD_MS = 350

interface Rgb { r: number; g: number; b: number }
function parseColour(text: string): Rgb | null {
  const m = /rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)/.exec(text)
  if (m) return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) }
  const h = /^#([0-9a-f]{6})$/i.exec(text.trim())
  if (h) { const n = parseInt(h[1]!, 16); return { r: n >> 16, g: (n >> 8) & 255, b: n & 255 } }
  return null
}
const mixColour = (a: Rgb, b: Rgb, t: number): string =>
  `rgb(${Math.round(a.r + (b.r - a.r) * t)}, ${Math.round(a.g + (b.g - a.g) * t)}, ${Math.round(a.b + (b.b - a.b) * t)})`

function AsciiLayer({ view, viewRef, hidden, intensity }: {
  view: View
  viewRef: { current: View }
  hidden: boolean
  intensity: number
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const live = useRef({ hidden, intensity })
  live.current = { hidden, intensity }
  const paintRef = useRef<((t: number) => void) | null>(null)
  const [reduced] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const doc = canvas.ownerDocument
    const win = doc.defaultView
    let sheets: HTMLCanvasElement[] = []
    let builtTint = ''
    let lastBuild = -Infinity
    let raf = 0
    let last = 0
    let alive = true

    const tintNow = (): { tint: string; mono: string } => {
      const cs = win?.getComputedStyle(canvas)
      const accent = parseColour(cs?.getPropertyValue('--accent') ?? '') ?? { r: 217, g: 119, b: 87 }
      const dim = parseColour(cs?.getPropertyValue('--dim') ?? '') ?? { r: 157, g: 157, b: 157 }
      const mono = (cs?.getPropertyValue('--mono') ?? '').trim() || 'Consolas, monospace'
      return { tint: mixColour(accent, dim, ASCII_TINT_MIX), mono }
    }
    const buildSheets = (force = false): void => {
      const now = performance.now()
      if (!force && now - lastBuild < ASCII_REBUILD_MS) return
      const { tint, mono } = tintNow()
      if (!force && tint === builtTint && sheets.length === ASCII_BUCKETS) return
      lastBuild = now
      builtTint = tint
      sheets = []
      for (let b = 0; b < ASCII_BUCKETS; b++) {
        const sheet = doc.createElement('canvas')
        sheet.width = SHEET_GW * ASCII_GLYPHS.length
        sheet.height = SHEET_GH
        const ctx = sheet.getContext('2d')
        if (!ctx) return
        ctx.font = `${Math.round(SHEET_GH * 0.72)}px ${mono}`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillStyle = tint
        ctx.globalAlpha = 0.18 + (0.82 * b) / (ASCII_BUCKETS - 1)
        for (let g = 0; g < ASCII_GLYPHS.length; g++) {
          ctx.fillText(ASCII_GLYPHS[g]!, g * SHEET_GW + SHEET_GW / 2, SHEET_GH / 2 + 1)
        }
        sheets.push(sheet)
      }
    }

    const paint = (t: number): void => {
      const cssW = canvas.clientWidth, cssH = canvas.clientHeight
      if (!(cssW > 0 && cssH > 0) || sheets.length < ASCII_BUCKETS) return
      const dpr = Math.min(ASCII_DPR_CAP, win?.devicePixelRatio || 1)
      const bw = Math.round(cssW * dpr), bh = Math.round(cssH * dpr)
      if (canvas.width !== bw || canvas.height !== bh) { canvas.width = bw; canvas.height = bh }
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      const v = viewRef.current
      const step = asciiStep(v.z, cssW, cssH)
      const cw = ASCII_CELL_W * step, ch = ASCII_CELL_H * step
      const cellPw = cw * v.z * dpr, cellPh = ch * v.z * dpr
      const x0 = (-v.x) / v.z, y0 = (-v.y) / v.z
      const i0 = Math.floor(x0 / cw), i1 = Math.ceil((x0 + cssW / v.z) / cw)
      const j0 = Math.floor(y0 / ch), j1 = Math.ceil((y0 + cssH / v.z) / ch)
      ctx.clearRect(0, 0, bw, bh)
      ctx.globalAlpha = live.current.intensity
      for (let j = j0; j <= j1; j++) {
        const wy = j * ch + ch / 2
        const sy = (j * ch * v.z + v.y) * dpr
        for (let i = i0; i <= i1; i++) {
          const bucket = asciiBucket(asciiField(i * cw + cw / 2, wy, t))
          if (bucket < 0) continue
          ctx.drawImage(sheets[bucket]!, asciiGlyphAt(i, j) * SHEET_GW, 0, SHEET_GW, SHEET_GH,
            (i * cw * v.z + v.x) * dpr, sy, cellPw, cellPh)
        }
      }
      ctx.globalAlpha = 1
    }
    paintRef.current = paint
    buildSheets(true)

    const RO = win?.ResizeObserver
    const ro = RO ? new RO(() => { if (reduced) paint(0) }) : null
    ro?.observe(canvas)
    // the visual theme (dataset, inline vars, rainbow epochs) owns the
    // colours; follow it without polling getComputedStyle per frame
    const MO = win?.MutationObserver
    const mo = MO ? new MO(() => { buildSheets(); if (reduced) paint(0) }) : null
    mo?.observe(doc.documentElement, { attributes: true, attributeFilter: ['data-visual-theme', 'style', 'class'] })

    if (reduced) {
      paint(0)
    } else {
      const loop = (now: number): void => {
        if (!alive) return
        raf = requestAnimationFrame(loop)
        if (doc.hidden || live.current.hidden) return
        if (now - last < ASCII_FRAME_MS) return
        last = now
        paint(now / 1000)
      }
      raf = requestAnimationFrame(loop)
    }
    return () => {
      alive = false
      cancelAnimationFrame(raf)
      ro?.disconnect()
      mo?.disconnect()
      if (paintRef.current === paint) paintRef.current = null
    }
  }, [reduced, viewRef])

  // Reduced motion means no autonomous loop: one still frame, repainted
  // only when the user's own pan or zoom moves the floor under it.
  useEffect(() => { if (reduced) paintRef.current?.(0) }, [reduced, view, intensity])

  return <canvas ref={canvasRef} className="canvas-bg-ascii" data-canvas-bg="ascii"
    data-motion={reduced ? 'reduced' : 'full'} aria-hidden="true" />
}
