/* Zoom-flicker probe fixture for the "Claude Waves" canvas background (USER 2026-10-28 22:52:55Z mfaa7411710fb
 * "the claude waves background is abbit glitchy when zooming the canvas in and out", 22:53:05Z mf070ca638693 "it tenss to
 * flicker"). Mounts the REAL AsciiLayer (or, as the control, the real CanvasBackground for another theme) behind card-shaped
 * stand-ins, with OrgCanvas's own wheel zoom: `viewRef` is written by the wheel handler AHEAD of React's commit and overwritten
 * by the render, exactly as OrgCanvas.tsx does, so the layer sees the camera the same way it does in the app.
 *
 * URL: ?theme=ascii|dots|line-grid|...  &seed=N (ascii, pinned)  &x= &y= &z= (start camera)  &sw=1
 *
 * &sw=1 is for a machine whose Session 0 has no usable GPU process (measured 2026-10-29: `GPU process exited unexpectedly:
 * exit_code=34` at window creation, even for canvasbg-capture.cjs): Electron then runs with SwiftShader (software WebGL2) and
 * THIS FIXTURE, not the product, shims the layer's hardware gate (drops failIfMajorPerformanceCaveat and reports a
 * non-software renderer string) so the real layer, shaders and scheduler run. Geometry and painted pixels are the real
 * layer's; frame TIMING is software-GL timing and says nothing about a real GPU.
 *
 * window.__zp (driven by wavezoom.capture.cjs):
 *   install()             patch the ASCII renderer's draw/resize so every real draw is recorded (device-pixel readback of the
 *                         frame, in the same task as the draw, while the drawing buffer is still valid)
 *   sweep(...)            deterministic geometry: set the camera, draw one frame at a FIXED field time, record it
 *   startTicks()/stopTicks()   one record per displayed frame (rAF): camera the DOM shows, camera the layer last drew with,
 *                         the canvas's computed opacity/display and its data-state
 *   result()              everything recorded so far
 */
import { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { AsciiLayer, CanvasBackground } from '../src/canvas/canvasbackground'
import type { AsciiTestApi } from '../src/canvas/canvasbackground'
import { Z_MAX } from '../src/canvas/shared'
import { CANVAS_BG_KEY } from '../src/canvasbgpref'
import '../src/styles.css'

type View = { x: number; y: number; z: number }
const q = new URLSearchParams(location.search)
const theme = q.get('theme') || 'ascii'
const seed = Number(q.get('seed') ?? 1) >>> 0
const MIN_Z = 0.24 // the desktop minimum zoom (canvas-background-themes.md, minimum-zoom fix)
if (q.get('sw') === '1') {
  const getContext = HTMLCanvasElement.prototype.getContext as (this: HTMLCanvasElement, type: string, opts?: unknown) => unknown
  HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, opts?: unknown) {
    const o = opts as { failIfMajorPerformanceCaveat?: boolean } | undefined
    return getContext.call(this, type, type === 'webgl2' && o?.failIfMajorPerformanceCaveat ? { ...o, failIfMajorPerformanceCaveat: false } : opts)
  } as typeof HTMLCanvasElement.prototype.getContext
  const getParameter = WebGL2RenderingContext.prototype.getParameter
  WebGL2RenderingContext.prototype.getParameter = function (this: WebGL2RenderingContext, p: number) {
    return p === 0x9246 ? 'ANGLE (Fixture, Shimmed GL Adapter)' : getParameter.call(this, p)
  } as typeof getParameter
}
const start: View = { x: Number(q.get('x') ?? 0), y: Number(q.get('y') ?? 0), z: Number(q.get('z') ?? 1) }
localStorage.setItem(CANVAS_BG_KEY, JSON.stringify({ theme, ...(theme === 'square-tiles' ? { version: 2 } : {}) }))

const CARDS = [
  { x: 300, y: 220, name: 'coordinator-opus', status: 'working — release composition' },
  { x: 520, y: 200, name: 'rig-sol-b', status: 'verifying batch 452' },
  { x: 520, y: 330, name: 'epic-wonder-full', status: 'canvas background themes' },
  { x: 740, y: 260, name: 'model-research-sol', status: 'done — reference sent' },
  { x: 300, y: 430, name: 'hubchat-opus', status: 'idle' },
  { x: 760, y: 470, name: 'audience-luna', status: 'working — acquire flow' },
]

interface FixtureWindow {
  __ascii?: AsciiTestApi
  __asciiReady?: boolean
  __ready?: boolean
  __zp?: unknown
  __setView?: (v: View) => void
}
const w = window as unknown as FixtureWindow

let committed: View = start // the camera the DOM last committed (what the cards are drawn with)
let viewRefExternal: { current: View } | null = null
let setViewExternal: ((v: View) => void) | null = null

function Stage() {
  const [view, setView] = useState(start)
  const viewRef = useRef(view)
  viewRef.current = view // OrgCanvas.tsx:1385 — the render overwrites the ref ...
  committed = view
  viewRefExternal = viewRef
  setViewExternal = setView
  const vp = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = vp.current!
    const onWheel = (e: WheelEvent) => { // ... and the wheel writes it ahead of the render (OrgCanvas.tsx:2802-2819)
      e.preventDefault()
      const v = viewRef.current
      const factor = Math.exp(-e.deltaY * 0.0012)
      const z = Math.min(Z_MAX, Math.max(MIN_Z, v.z * factor))
      const r = el.getBoundingClientRect()
      const mx = e.clientX - r.left, my = e.clientY - r.top
      const wx = (mx - v.x) / v.z, wy = (my - v.y) / v.z
      const nv = { x: mx - wx * z, y: my - wy * z, z }
      viewRef.current = nv
      setView(nv)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    w.__ready = true
    return () => el.removeEventListener('wheel', onWheel)
  }, [])
  return (
    <div ref={vp} style={{ position: 'fixed', inset: 0, background: 'var(--bg)', overflow: 'hidden' }}>
      {theme === 'ascii'
        ? <AsciiLayer view={view} viewRef={viewRef} hidden={false} intensity={1} pin={{ seed }} onReady={(api) => { w.__ascii = api; w.__asciiReady = true }} />
        : <CanvasBackground view={view} viewRef={viewRef} hidden={false} />}
      <div className="space" data-space style={{
        position: 'absolute', left: 0, top: 0, width: 1200, height: 900, transformOrigin: '0 0',
        transform: `translate(${view.x}px, ${view.y}px) scale(${view.z})`,
      }}>
        {CARDS.map(c => (
          <div key={c.name} className="sq" data-card={c.name} style={{
            position: 'absolute', left: c.x, top: c.y, width: 168, padding: '10px 12px',
            background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 10,
            color: 'var(--ink)', font: '12px/1.45 system-ui, sans-serif',
          }}>
            <div style={{ color: 'var(--ink-strong)', fontWeight: 600 }}>{c.name}</div>
            <div style={{ color: 'var(--dim)' }}>{c.status}</div>
          </div>
        ))}
      </div>
      <div style={{ position: 'fixed', left: 8, bottom: 6, color: 'var(--dim)', font: '11px var(--mono)', opacity: 0.85 }}>
        {`${theme} · z=${view.z.toFixed(2)}`}
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<Stage />)

/* ── probe ─────────────────────────────────────────────────────────────── */
const COARSE_W = 96, COARSE_H = 54
interface DrawRec {
  i: number; t: number; zRef: number; zDom: number; cov: number
  cw: number; cols: number; rows: number; canvasW: number; canvasH: number; state: string; coarse: number[]
}
interface ResizeRec { t: number; cw: number; cols: number; rows: number; zRef: number }
interface TickRec {
  t: number; zDom: number; zRef: number; draws: number; opacity: string; display: string; state: string
  canvasW: number; canvasH: number
}
const draws: DrawRec[] = []
const resizes: ResizeRec[] = []
const ticks: TickRec[] = []
let installedOn: unknown = null
let tickRaf = 0
let glCanvas: HTMLCanvasElement | null = null

const layerCanvas = (): HTMLCanvasElement | null => document.querySelector('[data-canvas-bg="ascii"] canvas')

function record(): void {
  const api = w.__ascii, c = layerCanvas()
  if (!api || !c) return
  const gl = c.getContext('webgl2') as WebGL2RenderingContext | null
  if (!gl) return
  const W = c.width, H = c.height
  const px = new Uint8Array(W * H * 4)
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px)
  const sum = new Float64Array(COARSE_W * COARSE_H), cnt = new Float64Array(COARSE_W * COARSE_H)
  let total = 0
  for (let y = 0; y < H; y++) {
    const by = Math.min(COARSE_H - 1, Math.floor((y * COARSE_H) / H))
    for (let x = 0; x < W; x++) {
      const a = px[(y * W + x) * 4 + 3]!
      const k = by * COARSE_W + Math.min(COARSE_W - 1, Math.floor((x * COARSE_W) / W))
      sum[k] = sum[k]! + a; cnt[k] = cnt[k]! + 1; total += a
    }
  }
  const st = api.state()
  draws.push({
    i: draws.length, t: performance.now(), zRef: viewRefExternal?.current.z ?? NaN, zDom: committed.z,
    cov: total / (W * H * 255), cw: st.cellWidth ?? 0, cols: st.columns ?? 0, rows: st.rows ?? 0,
    canvasW: W, canvasH: H, state: st.datasetState,
    coarse: Array.from(sum, (s, k) => Math.round((s / Math.max(1, cnt[k]!)) * 100) / 100),
  })
}

function install(): boolean {
  const r = w.__ascii?.renderer() as unknown as { draw: (...a: unknown[]) => void; resize: (l: { grid: { cellWidth: number; columns: number; rows: number } }) => boolean } | null | undefined
  if (!r) return false
  if (installedOn === r) return true
  installedOn = r
  const origDraw = r.draw.bind(r), origResize = r.resize.bind(r)
  r.draw = (...a: unknown[]) => { origDraw(...a); record() }
  r.resize = (lay) => {
    const ok = origResize(lay)
    resizes.push({ t: performance.now(), cw: lay.grid.cellWidth, cols: lay.grid.columns, rows: lay.grid.rows, zRef: viewRefExternal?.current.z ?? NaN })
    return ok
  }
  return true
}

function tick(): void {
  tickRaf = requestAnimationFrame(tick)
  const c = layerCanvas() ?? glCanvas
  if (c) glCanvas = c
  const cs = c ? getComputedStyle(c) : null
  ticks.push({
    t: performance.now(), zDom: committed.z, zRef: viewRefExternal?.current.z ?? NaN, draws: draws.length,
    opacity: cs ? cs.opacity : '', display: cs ? cs.display : '', state: c?.dataset.state ?? '',
    canvasW: c?.width ?? 0, canvasH: c?.height ?? 0,
  })
}

/** Put the camera at `v` (ref AND state) and draw one frame synchronously at a fixed field time (deterministic geometry). */
function sweepDraw(v: View, fieldTime: number): void {
  if (viewRefExternal) viewRefExternal.current = v
  w.__ascii?.drawAt(fieldTime, 1)
}

/** One sweep step (the camera zooms geometrically from `from` to `to` with the world point under (ax, ay) held fixed); returns ms. */
let sweepView: View = { x: 0, y: 0, z: 1 }
function sweepStep(i: number, steps: number, from: number, to: number, ax: number, ay: number, fieldTime: number): number {
  const z = from * Math.pow(to / from, i / steps)
  if (i === 0) sweepView = { x: 0, y: 0, z: from }
  const wx = (ax - sweepView.x) / sweepView.z, wy = (ay - sweepView.y) / sweepView.z
  sweepView = { x: ax - wx * z, y: ay - wy * z, z }
  const t0 = performance.now()
  sweepDraw(sweepView, fieldTime)
  return performance.now() - t0
}

/** One pan step at a fixed zoom: the camera moves `dx` screen px left per step (the baseline for "plain motion"); returns ms. */
function panStep(i: number, dx: number, z: number, fieldTime: number): number {
  const t0 = performance.now()
  sweepDraw({ x: -dx * i, y: 0, z }, fieldTime)
  return performance.now() - t0
}

/** Pixel identity: draw each camera at a fixed field time and hash the layer's full device-pixel drawing buffer (FNV-1a over RGBA),
 *  with the canvas box and grid shape. Equal hashes before/after a change = the pixels are identical. */
function identity(views: View[], fieldTime: number): { z: number; x: number; y: number; hash: string; w: number; h: number; box: { left: string; top: string; width: string; height: string }; cw: number; cols: number; rows: number }[] {
  const out = []
  for (const v of views) {
    sweepDraw(v, fieldTime)
    const c = layerCanvas()!
    const gl = c.getContext('webgl2') as WebGL2RenderingContext
    const px = new Uint8Array(c.width * c.height * 4)
    gl.readPixels(0, 0, c.width, c.height, gl.RGBA, gl.UNSIGNED_BYTE, px)
    let h = 0x811c9dc5
    for (let i = 0; i < px.length; i++) { h ^= px[i]!; h = Math.imul(h, 0x01000193) >>> 0 }
    const st = w.__ascii!.state()
    out.push({ ...v, hash: h.toString(16), w: c.width, h: c.height,
      box: { left: c.style.left, top: c.style.top, width: c.style.width, height: c.style.height },
      cw: st.cellWidth ?? 0, cols: st.columns ?? 0, rows: st.rows ?? 0 })
  }
  return out
}

w.__setView = (v) => { if (viewRefExternal) viewRefExternal.current = v; setViewExternal?.(v) }
w.__zp = {
  install, sweepDraw, sweepStep, panStep, identity,
  startTicks: () => { ticks.length = 0; cancelAnimationFrame(tickRaf); tickRaf = requestAnimationFrame(tick) },
  stopTicks: () => { cancelAnimationFrame(tickRaf) },
  reset: () => { draws.length = 0; resizes.length = 0; ticks.length = 0 },
  result: () => ({ draws, resizes, ticks, dpr: window.devicePixelRatio, inner: [innerWidth, innerHeight] }),
  state: () => w.__ascii?.state() ?? null,
  view: () => ({ ref: viewRefExternal?.current, dom: committed }),
}
