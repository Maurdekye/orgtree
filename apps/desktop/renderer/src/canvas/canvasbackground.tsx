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
 * The flowing-ASCII theme is the one animated layer: a WebGL2 wind-field
 * + glyph renderer (asciifield.ts has the model, asciigl.ts the pipeline),
 * independently re-implemented from a prose/math study of the Claude Code
 * backdrop under the user's 2026-10-15 exact-match ruling. It reads the
 * camera from viewRef so panning never re-renders React, runs on a
 * fault-tolerant scheduler with a minutes-long power budget that settles
 * to calm, pauses hidden, stirs under the pointer (taps ripple; every
 * third is a heart), and reduces to still frames under
 * prefers-reduced-motion. Its cost is bounded by the viewport (the grid's
 * device-pixel budget), never by the size of the organization. Where
 * WebGL2 or a hardware GL pipeline is unavailable it simply doesn't
 * appear. Field coordinates are WORLD units (the layer pans/zooms like a
 * floor); at view (0,0, zoom 1) frames coincide with the reference's.
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
import { ASCII_CONFIG, createTouch, gridFor, pickLook, smooth01, visitFromSeed } from './asciifield'
import type { AsciiTouchFrame, AsciiVisit, GlyphPoolKey } from './asciifield'
import { createAsciiRenderer } from './asciigl'
import type { AsciiLayout, AsciiRenderer } from './asciigl'

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
/** Equilateral triangle side; two rows of outlined ▲/▽ per S × √3·S SVG mask tile. */
const TRI_S = 36
/** Honeycomb mask tile (styles.css hex-lines / hex-tiles): pointy-top hexagons of
 *  radius HEX_R; the SVG tile is HEX_R·√3 × 3·HEX_R world px. */
const HEX_R = 17

const px = (n: number): string => `${Math.round(n * 100) / 100}px`

/** Where a CSS theme's pattern sits for this camera. Pure, so the tests can
 *  pin the floor behaviour (and the dots' legacy values) without a DOM. */
export function bgGeometry(theme: CanvasBackgroundTheme, view: View): {
  backgroundPosition: string; backgroundSize: string; maskPosition?: string; maskSize?: string
} {
  const { x, y, z } = view
  switch (theme) {
    case 'line-grid':
      return { backgroundPosition: `${px(x)} ${px(y)}`, backgroundSize: `${px(TILE * z)} ${px(TILE * z)}` }
    case 'checkerboard':
      return { backgroundPosition: `${px(x)} ${px(y)}`, backgroundSize: `${px(2 * TILE * z)} ${px(2 * TILE * z)}` }
    case 'square-tiles':
      return {
        backgroundPosition: '0px 0px', backgroundSize: 'auto',
        maskPosition: `${px(x)} ${px(y)}`, maskSize: `${px(TILE * z)} ${px(TILE * z)}`,
      }
    case 'hex-dots': {
      const w = TILE * z, h = TILE * SQRT3 * z
      return { backgroundPosition: `${px(x)} ${px(y)}, ${px(x + w / 2)} ${px(y + h / 2)}`, backgroundSize: `${px(w)} ${px(h)}` }
    }
    case 'hex-lines':
    case 'hex-tiles':
      // Hexagons and gapped tile outlines use SVG masks (styles.css) so each
      // tile is its own closed outlined polygon inset from its tiling cell.
      // The mask moves with the same floor math as every other theme.
      return {
        backgroundPosition: '0px 0px', backgroundSize: 'auto',
        maskPosition: `${px(x)} ${px(y)}`, maskSize: `${px(HEX_R * SQRT3 * z)} ${px(3 * HEX_R * z)}`,
      }
    case 'triangle-tiles':
      return {
        backgroundPosition: '0px 0px', backgroundSize: 'auto',
        maskPosition: `${px(x)} ${px(y)}`, maskSize: `${px(TRI_S * z)} ${px(TRI_S * SQRT3 * z)}`,
      }
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
  const geo = bgGeometry(pref.theme, view)
  const style: CSSProperties = {
    ...(geo.maskSize
      ? {
        maskPosition: geo.maskPosition, maskSize: geo.maskSize,
        WebkitMaskPosition: geo.maskPosition, WebkitMaskSize: geo.maskSize,
      }
      : { backgroundPosition: geo.backgroundPosition, backgroundSize: geo.backgroundSize }),
    ...(pref.theme === 'dots' || pref.theme === 'hex-dots'
      ? { '--dot-r': `${Math.max(1, 1.1 * view.z).toFixed(2)}px` } : {}),
    ...(intensity < 1 ? { opacity: intensity } : {}),
  }
  return <div className="canvas-bg"
    data-canvas-bg={pref.theme === 'dots' ? undefined : pref.theme} style={style} />
}

/* ── the flowing-ASCII layer ──────────────────────────────────────────────
 * Orchestration around the GL renderer, mirroring the reference's own
 * lifecycle: capability gate → font wait → renderer → resize-driven grid;
 * a setTimeout→rAF frame loop over accumulated animation time A (frame
 * deltas clamped to 250 ms) advancing field time M by dt·energy·N·re,
 * where N is the settle fade past the 180 s budget deadline P and re the
 * resume fade — so the wind itself slows to a stop as the budget ends,
 * then the loop parks (state "calm") until roused by visibility, focus,
 * pointer or keys. Late frames and GPU fence misses strike toward an
 * 83 ms backoff, then a doubling retry (60 s → 480 s); >50 ms stalls go
 * straight there. Everything stops while hidden. */

const LOOK_HISTORY_KEY = 'orgtree.canvasBg.asciiLookHistory'
const LOOK_HISTORY_MAX = 3
const INTERACTIVE = 'a, button, input, textarea, select, [contenteditable], [draggable="true"], '
  + '[tabindex], [role="button"], [role="textbox"], .sq'

function loadLookHistory(win: Window | null): string[] {
  try {
    const raw = win?.localStorage.getItem(LOOK_HISTORY_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch { return [] }
}
function saveLookHistory(win: Window | null, history: readonly string[], look: string): void {
  try {
    win?.localStorage.setItem(LOOK_HISTORY_KEY, JSON.stringify([look, ...history].slice(0, LOOK_HISTORY_MAX)))
  } catch { /* history is a nicety, never a blocker */ }
}
function randomSeed(win: Window | null): number {
  try {
    const buf = new Uint32Array(1)
    win?.crypto.getRandomValues(buf)
    return buf[0] || 1
  } catch { return 1 }
}
/** Resolve any CSS colour to rgb+alpha in [0,1] via a 1px canvas. */
function sampleColour(doc: Document, css: string): { rgb: [number, number, number]; alpha: number } {
  const c = doc.createElement('canvas')
  c.width = 1
  c.height = 1
  const ctx = c.getContext('2d', { willReadFrequently: true })
  if (!ctx) return { rgb: [1, 1, 1], alpha: 1 }
  ctx.fillStyle = '#000'
  ctx.fillStyle = css
  ctx.fillRect(0, 0, 1, 1)
  const d = ctx.getImageData(0, 0, 1, 1).data
  return { rgb: [(d[0] ?? 255) / 255, (d[1] ?? 255) / 255, (d[2] ?? 255) / 255], alpha: (d[3] ?? 255) / 255 }
}

/** Test/fixture pin: fixed seed (and optionally pool) instead of a
 *  per-mount crypto draw. Production never passes it. */
export interface AsciiPin { seed: number; pool?: GlyphPoolKey; budgetS?: number }
export interface AsciiTestApi {
  visit: AsciiVisit
  renderer: () => AsciiRenderer | null
  /** Draw one frame synchronously at the given field time/reveal. */
  drawAt: (fieldTime: number, reveal?: number) => void
  tap: (worldX: number, worldY: number) => void
  simulateLoad?: (kind: 'late' | 'gpu' | 'stall', count?: number) => void
  state: () => {
    animTime: number
    fieldTime: number
    reveal: number
    calm: boolean
    running: boolean
    touchBusy: boolean
    tapBusy?: boolean
    wakeBusy?: boolean
    tapCount?: number
    datasetState: string
    cellWidth?: number
    columns?: number
    rows?: number
    busyWhy?: string
    busyOff?: boolean
    contextLost?: boolean
  }
}

const INITIAL_RETRY_MS = 1500
const MAX_RETRY_MS = 8000

export function AsciiLayer({ view, viewRef, hidden, intensity, pin, onReady }: {
  view: View
  viewRef: { current: View }
  hidden: boolean
  intensity: number
  pin?: AsciiPin
  onReady?: (api: AsciiTestApi) => void
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const live = useRef({ hidden, intensity })
  live.current = { hidden, intensity }
  const stillRef = useRef<(() => void) | null>(null)
  const [reduced] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const doc = host.ownerDocument
    const win = doc.defaultView
    if (!win) return
    const mq = (q: string): boolean => typeof win.matchMedia === 'function' && win.matchMedia(q).matches
    if (mq('(prefers-contrast: more)') || mq('(forced-colors: active)')) return
    let roSupport = true
    try {
      const probe = new win.ResizeObserver(() => {})
      probe.observe(host, { box: 'device-pixel-content-box' })
      probe.disconnect()
    } catch { roSupport = false }
    if (!roSupport) return

    const cfg = ASCII_CONFIG
    const seed = pin?.seed ?? randomSeed(win)
    const history = pin ? [] : loadLookHistory(win)
    const visit = visitFromSeed(seed, pin?.pool ?? pickLook(seed, history))
    if (!pin) saveLookHistory(win, history, visit.key)
    const touch = createTouch()
    const still = reduced

    let cancelled = false
    let renderer: AsciiRenderer | null = null
    let dead = false
    let contextLost = false
    let layoutSig = ''
    let lastLayout: AsciiLayout | null = null
    let gridOk = false
    let shown = false
    let firstShow = true
    let colourKey = ''
    let animTime = 0
    let fieldTime = (seed >>> 0) / 4294967296 * 64
    const budgetS = pin?.budgetS ?? cfg.power.budgetS
    let budgetEnd = budgetS
    let resumeStart = -cfg.power.resumeS
    let revealStart = 0
    let calm = false
    let loopActive = false
    let timer = 0
    let raf = 0
    let rafRequestedAt = 0
    let lastTsMs: number | null = null
    let touchEpochS: number | null = null
    let lateRing: boolean[] = []
    let lateFaults = 0
    let strikes = 0
    let busyWhy = ''
    let busyOff = false
    let goodFrames = 0
    let stallRun = 0
    let retryMs = INITIAL_RETRY_MS
    let retryTimer = 0
    let resizeTimer = 0
    let firstResize = true
    let ro: ResizeObserver | null = null
    let mo: MutationObserver | null = null
    const parent = host.parentElement

    const touchNow = (): number => {
      const nowS = performance.now() / 1000
      if (touchEpochS === null) touchEpochS = nowS
      return nowS - touchEpochS
    }
    const setState = (s: string): void => {
      if (renderer && renderer.canvas.dataset.state !== s) renderer.canvas.dataset.state = s
    }
    const canvasOpacity = (): number => {
      const cs = win.getComputedStyle(host)
      const scheme = cs.colorScheme.includes('light') ? 'light' : 'dark'
      return Math.min(1, Math.min(cfg.strength.base[scheme] * live.current.intensity, cfg.strength.cap[scheme]) * cfg.glow.headroom)
    }
    const applyColours = (): void => {
      if (!renderer || dead || contextLost) return
      const cs = win.getComputedStyle(host)
      const key = `${cs.color} ${cs.colorScheme} ${live.current.intensity}`
      if (key === colourKey) return
      colourKey = key
      const scheme = cs.colorScheme.includes('light') ? 'light' : 'dark'
      const sampled = sampleColour(doc, cs.color)
      renderer.setInk(sampled.rgb, sampled.alpha)
      const glow = cfg.glow.color[scheme]
      renderer.setGlow([glow[0] ?? 0, glow[1] ?? 0, glow[2] ?? 0])
      if (shown) renderer.canvas.style.opacity = `${canvasOpacity()}`
      if (still) drawStill()
    }
    const scheduleColours = (): void => {
      win.requestAnimationFrame(() => { if (!cancelled) applyColours() })
    }
    const computeLayout = (): AsciiLayout | null => {
      const wCss = host.clientWidth, hCss = host.clientHeight
      if (!(wCss > 0 && hCss > 0)) return null
      const v = viewRef.current
      // Bound zoom-out density and device-pixel scale so rapid drag + zoom-out
      // never explodes fragment count, shrinks glyph cells into faint sub-pixel
      // dust, or reallocates the WebGL backbuffer/atlas on every zoom step below z = 1.
      // World-space sampling (worldScale = z * dpr) still zooms the wind field down to z = 0.35.
      const z = Math.max(0.35, v.z)
      const dpr = Math.min(2, Math.max(1, win.devicePixelRatio || 1))
      const gridScale = Math.max(1, z) * dpr
      const grid = gridFor(Math.round(wCss * dpr), Math.round(hCss * dpr), gridScale)
      if (!grid) return null
      const worldScale = z * dpr
      const cellWorldW = grid.cellWidth / worldScale
      const cellWorldH = grid.cellHeight / worldScale
      const worldLeft = -v.x / z, worldTop = -v.y / z
      const i0 = Math.floor(worldLeft / cellWorldW), j0 = Math.floor(worldTop / cellWorldH)
      const originX = i0 * cellWorldW, originY = j0 * cellWorldH
      return {
        grid, originX, originY,
        sampleX: cellWorldW, sampleY: cellWorldH / 2,
        canvasSizeX: grid.columns * cellWorldW, canvasSizeY: grid.rows * cellWorldH,
        calmRadiiX: cfg.card.calmX / z, calmRadiiY: cfg.card.calmY / z,
        cellOriginX: i0, cellOriginY: j0,
        cellCentreX: originX + cellWorldW / 2, cellCentreY: originY + cellWorldH / 2,
        cellWorldW, cellWorldH,
        cssLeft: (originX - worldLeft) * z, cssTop: (originY - worldTop) * z,
        cssW: grid.columns * cellWorldW * z, cssH: grid.rows * cellWorldH * z,
      }
    }
    const drawOnce = (time: number, reveal: number): boolean => {
      if (!renderer || dead || contextLost) return false
      const lay = computeLayout()
      lastLayout = lay
      gridOk = lay !== null
      if (!lay) { setState('unseen'); renderer.canvas.style.display = 'none'; return false }
      renderer.canvas.style.display = ''
      const sig = `${lay.grid.columns},${lay.grid.rows},${lay.grid.cellWidth},${lay.grid.scale},${lay.cellOriginX},${lay.cellOriginY},${lay.cellWorldW}`
      if (sig !== layoutSig) {
        if (!renderer.resize(lay)) return false
        layoutSig = sig
      } else {
        renderer.canvas.style.left = `${lay.cssLeft}px`
        renderer.canvas.style.top = `${lay.cssTop}px`
        renderer.canvas.style.width = `${lay.cssW}px`
        renderer.canvas.style.height = `${lay.cssH}px`
      }
      const v = viewRef.current
      const z = Math.max(0.35, v.z)
      const frame: AsciiTouchFrame = touch.frame(touchNow())
      renderer.draw(time, reveal, frame, {
        originX: lay.originX, originY: lay.originY,
        calmCx: (host.clientWidth / 2 - v.x) / z,
        calmCy: (cfg.card.centerY * host.clientHeight - v.y) / z,
      })
      if (!shown) {
        shown = true
        renderer.canvas.style.transition = firstShow ? 'opacity 3000ms' : 'opacity 600ms'
        firstShow = false
        renderer.canvas.style.opacity = `${canvasOpacity()}`
      }
      return true
    }
    function drawStill(): void {
      if (drawOnce(fieldTime, 1)) setState('still')
    }
    stillRef.current = still ? drawStill : null

    const settleFade = (): number => 1 - smooth01((animTime - budgetEnd) / cfg.power.settleS)
    const resumeFade = (): number => smooth01((animTime - resumeStart) / cfg.power.resumeS)
    const revealNow = (): number => (still ? 1 : smooth01((animTime - revealStart) / cfg.wind.revealS) * settleFade())
    const visibleNow = (): boolean =>
      !doc.hidden && doc.hasFocus() && !live.current.hidden && host.clientWidth > 0 && host.isConnected
    const intervalMs = (): number =>
      busyWhy ? cfg.power.backoffFrameMs
        : touch.rippling(touchNow()) ? cfg.power.rippleFrameMs : cfg.power.frameMs

    const stopLoop = (): void => {
      loopActive = false
      win.clearTimeout(timer)
      win.cancelAnimationFrame(raf)
      lastTsMs = null
    }
    const enterBusyOff = (why: string): void => {
      busyOff = true
      busyWhy = why
      shown = false
      if (renderer) {
        // Hide the paused canvas so a stale world-coordinate frame is never
        // left frozen on screen while the user pans or zooms the org chart.
        renderer.canvas.style.transition = 'opacity 250ms'
        renderer.canvas.style.opacity = '0'
      }
      setState(`busy-${why}`)
      stopLoop()
      win.clearTimeout(retryTimer)
      const waitMs = retryMs
      retryMs = Math.min(MAX_RETRY_MS, retryMs * 2)
      retryTimer = win.setTimeout(() => {
        if (cancelled || dead || contextLost) return
        busyOff = false
        busyWhy = ''
        strikes = 0
        lateFaults = 0
        stallRun = 0
        if (still) drawStill()
        else if (drawOnce(fieldTime, revealNow())) {
          setState('moving')
          tryStart()
        } else {
          tryStart()
        }
      }, waitMs)
    }
    const fault = (why: 'late' | 'gpu' | 'stall'): void => {
      if (busyOff || contextLost) return
      if (why === 'late') {
        lateFaults += 1
        if (lateFaults < 2) return
        lateFaults = 0
      }
      strikes += 1
      if (strikes >= 2) { enterBusyOff(why); return }
      busyWhy = why
      goodFrames = 0
      setState(`busy-${why}`)
    }
    const frame = (tsMs: number): void => {
      if (cancelled || dead || contextLost || !loopActive) return
      const late = performance.now() - rafRequestedAt > 17
      lateRing = [...lateRing.slice(-9), late]
      if (lateRing.filter(Boolean).length >= 5) { lateRing = []; fault('late') }
      if (!loopActive) return
      if (!visibleNow()) { stopLoop(); return }
      const dt = lastTsMs === null ? 0 : Math.min(0.25, Math.max(0, (tsMs - lastTsMs) / 1000))
      lastTsMs = tsMs
      animTime += dt
      fieldTime += dt * cfg.wind.energy * settleFade() * resumeFade()
      const t0 = performance.now()
      const drew = drawOnce(fieldTime, revealNow())
      const tookMs = performance.now() - t0
      stallRun = tookMs > 50 ? stallRun + 1 : 0
      if (stallRun >= 3) { stallRun = 0; fault('stall'); if (!loopActive) return }
      if (renderer?.fellBehind()) fault('gpu')
      if (!loopActive) return
      if (busyWhy) {
        goodFrames = late ? 0 : goodFrames + 1
        if (goodFrames >= 30) {
          busyWhy = ''
          strikes = 0
          retryMs = INITIAL_RETRY_MS
          setState('moving')
        }
      } else if (drew) {
        retryMs = INITIAL_RETRY_MS
        setState('moving')
      }
      if (settleFade() <= 0 && !touch.busy(touchNow())) {
        calm = true
        setState('calm')
        if (renderer) renderer.canvas.style.transition = 'opacity 500ms'
        stopLoop()
        return
      }
      timer = win.setTimeout(() => {
        rafRequestedAt = performance.now()
        raf = win.requestAnimationFrame(frame)
      }, intervalMs())
    }
    const tryStart = (): void => {
      if (cancelled || dead || contextLost || still || loopActive || busyOff || !renderer) return
      if (!visibleNow()) return
      loopActive = true
      lastTsMs = null
      rafRequestedAt = performance.now()
      raf = win.requestAnimationFrame(frame)
    }
    const restart = (): void => {
      revealStart = animTime
      resumeStart = animTime
      budgetEnd = animTime + budgetS
      calm = false
      if (renderer) renderer.canvas.style.transition = 'opacity 3000ms'
      drawOnce(fieldTime, revealNow())
      tryStart()
    }
    const rouse = (): void => {
      if (still || busyOff || !gridOk || dead || contextLost) return
      if (calm) { restart(); return }
      budgetEnd = animTime + budgetS
      tryStart()
    }
    const onVisibleReturn = (): void => {
      if (cancelled || dead || contextLost || still) return
      if (calm) restart()
      else tryStart()
    }

    const applyResize = (): void => {
      if (cancelled || dead || contextLost || !renderer) return
      layoutSig = ''
      if (still) drawStill()
      else if (!drawOnce(fieldTime, revealNow())) stopLoop()
      else tryStart()
    }
    const onResize = (): void => {
      if (firstResize) { firstResize = false; applyResize(); return }
      win.clearTimeout(resizeTimer)
      resizeTimer = win.setTimeout(applyResize, cfg.power.resizeSettleMs)
    }

    const toWorld = (e: PointerEvent): { x: number; y: number } => {
      const rect = host.getBoundingClientRect()
      const v = viewRef.current
      return { x: (e.clientX - rect.left - v.x) / v.z, y: (e.clientY - rect.top - v.y) / v.z }
    }
    const onInteractive = (e: PointerEvent): boolean => {
      const t = e.target
      if (!(t instanceof win.Element) || !parent) return false
      const hit = t.closest(INTERACTIVE)
      return hit !== null && hit !== parent && parent.contains(hit)
    }
    const interactionLive = (): boolean => !still && !busyOff && gridOk && !dead && !contextLost && (loopActive || calm)
    const onPointerMove = (e: PointerEvent): void => {
      if (!interactionLive() || e.pointerType === 'touch') return
      if (onInteractive(e)) { touch.leave(); return }
      const p = toWorld(e)
      if (touch.move(p.x, p.y, touchNow())) rouse()
    }
    const onPointerDown = (e: PointerEvent): void => {
      if (!interactionLive() || e.button !== 0) return
      if (onInteractive(e)) return
      const p = toWorld(e)
      touch.tap(p.x, p.y, touchNow())
      rouse()
    }
    const onPointerLeave = (): void => { touch.leave() }
    const onKeyDown = (): void => { if (interactionLive()) rouse() }
    const onContextLost = (e: Event): void => {
      e.preventDefault()
      contextLost = true
      shown = false
      stopLoop()
      win.clearTimeout(retryTimer)
      if (renderer) {
        renderer.canvas.style.transition = 'opacity 150ms'
        renderer.canvas.style.opacity = '0'
        setState('context-lost')
      }
    }
    const onContextRestored = (): void => {
      if (cancelled || dead || !renderer) return
      contextLost = false
      busyOff = false
      busyWhy = ''
      strikes = 0
      lateFaults = 0
      stallRun = 0
      layoutSig = ''
      colourKey = ''
      if (!renderer.restore()) return
      applyColours()
      if (still) drawStill()
      else if (drawOnce(fieldTime, revealNow())) {
        setState('moving')
        tryStart()
      }
    }

    const idleWait = (ms: number): Promise<void> => new Promise(resolve => {
      const ric = (win as Window & { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => void }).requestIdleCallback
      if (ric) ric(() => resolve(), { timeout: ms })
      else win.setTimeout(resolve, Math.min(ms, 50))
    })

    void (async () => {
      const family = win.getComputedStyle(host).fontFamily || 'monospace'
      try { await doc.fonts?.load(`400 16px ${family}`, '.') } catch { /* fall through */ }
      await idleWait(1500)
      if (cancelled) return
      renderer = createAsciiRenderer(doc, visit, family)
      if (!renderer) return
      renderer.canvas.style.opacity = '0'
      renderer.canvas.dataset.state = 'unseen'
      renderer.canvas.addEventListener('webglcontextlost', onContextLost)
      renderer.canvas.addEventListener('webglcontextrestored', onContextRestored)
      host.appendChild(renderer.canvas)
      applyColours()
      ro = new win.ResizeObserver(onResize)
      try { ro.observe(host, { box: 'device-pixel-content-box' }) } catch { ro.observe(host) }
      mo = new win.MutationObserver(scheduleColours)
      mo.observe(doc.documentElement, { attributes: true, attributeFilter: ['data-visual-theme', 'style', 'class'] })
      win.matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', scheduleColours)
      doc.addEventListener('visibilitychange', onVisibleReturn)
      win.addEventListener('focus', onVisibleReturn)
      if (parent) {
        parent.addEventListener('pointermove', onPointerMove, { passive: true })
        parent.addEventListener('pointerdown', onPointerDown, { passive: true })
        parent.addEventListener('pointerleave', onPointerLeave, { passive: true })
        parent.addEventListener('keydown', onKeyDown, { passive: true, capture: true })
      }
      applyResize()
      onReady?.({
        visit,
        renderer: () => renderer,
        drawAt: (t, reveal = 1) => {
          fieldTime = t
          if (reveal >= 1 && animTime < revealStart + cfg.wind.revealS) {
            animTime = revealStart + cfg.wind.revealS
          }
          if (drawOnce(t, reveal) && renderer) {
            busyWhy = ''
            strikes = 0
            setState(still ? 'still' : calm ? 'calm' : 'moving')
            renderer.canvas.style.transition = 'none'
            renderer.canvas.style.opacity = `${canvasOpacity()}`
            if (loopActive) {
              win.clearTimeout(timer)
              win.cancelAnimationFrame(raf)
              lastTsMs = null
              timer = win.setTimeout(() => {
                rafRequestedAt = performance.now()
                raf = win.requestAnimationFrame(frame)
              }, intervalMs())
            }
          }
        },
        tap: (wx, wy) => { touch.tap(wx, wy, touchNow()); rouse() },
        simulateLoad: (kind, count = 1) => {
          for (let i = 0; i < count; i++) {
            if (kind === 'late') fault('late')
            fault(kind)
          }
        },
        state: () => {
          const now = touchNow()
          return {
            animTime, fieldTime, reveal: revealNow(), calm,
            running: loopActive,
            touchBusy: touch.busy(now),
            tapBusy: touch.rippling(now),
            wakeBusy: touch.waking(now),
            tapCount: touch.liveTaps(now).length,
            datasetState: renderer?.canvas.dataset.state ?? '',
            cellWidth: lastLayout?.grid.cellWidth,
            columns: lastLayout?.grid.columns,
            rows: lastLayout?.grid.rows,
            busyWhy,
            busyOff,
            contextLost,
          }
        },
      })
    })()

    return () => {
      cancelled = true
      stopLoop()
      win.clearTimeout(retryTimer)
      win.clearTimeout(resizeTimer)
      ro?.disconnect()
      mo?.disconnect()
      doc.removeEventListener('visibilitychange', onVisibleReturn)
      win.removeEventListener('focus', onVisibleReturn)
      if (parent) {
        parent.removeEventListener('pointermove', onPointerMove)
        parent.removeEventListener('pointerdown', onPointerDown)
        parent.removeEventListener('pointerleave', onPointerLeave)
        parent.removeEventListener('keydown', onKeyDown, { capture: true })
      }
      if (renderer) {
        renderer.canvas.removeEventListener('webglcontextlost', onContextLost)
        renderer.canvas.removeEventListener('webglcontextrestored', onContextRestored)
        renderer.destroy()
      }
      if (stillRef.current === drawStill) stillRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduced, viewRef])

  // Still mode has no autonomous loop: repaint the one frame when the
  // user's own pan/zoom moves the floor, or the colours change.
  useEffect(() => { if (reduced) stillRef.current?.() }, [reduced, view, intensity])
  // The canvas world coming back (or going away) is a visibility edge the
  // loop's own checks also see; nudging here restarts without a 50 ms lag.
  useEffect(() => {
    if (!hidden && reduced) stillRef.current?.()
  }, [hidden, reduced])

  return <div ref={hostRef} className="canvas-bg-ascii" data-canvas-bg="ascii"
    data-motion={reduced ? 'reduced' : 'full'} aria-hidden="true" />
}
