/* Visual fixture for the canvas background themes: renders the REAL
 * CanvasBackground layer over a few card-shaped stand-ins, driven by URL
 * parameters (?theme=&intensity=&x=&y=&z=&pan=1), so canvasbg-capture.cjs
 * can photograph every theme against something the patterns must stay
 * behind. Also exposes window.__measure() — rAF frame-time stats over 180
 * frames — for the ASCII theme's frame-cost evidence.
 *
 * With ?theme=ascii&seed=N the fixture instead mounts AsciiLayer directly
 * with a pinned seed/pool (and optional &budget=seconds), and exposes the
 * layer's test API plus __compareWind(t): draws one frame at field time t,
 * reads the GL wind texture back, and diffs every sample against the CPU
 * field mirror — the seeded numerical proof that the shaders implement
 * the studied algorithm.
 *
 * The preference is seeded through localStorage (the plain-browser path),
 * exactly what the layer reads when no native bridge exists. */
import { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { AsciiLayer, CanvasBackground } from '../src/canvas/canvasbackground'
import type { AsciiTestApi } from '../src/canvas/canvasbackground'
import { ASCII_CONFIG, fieldAt, gridFor, spanFor } from '../src/canvas/asciifield'
import type { GlyphPoolKey } from '../src/canvas/asciifield'
import { CANVAS_BG_KEY } from '../src/canvasbgpref'
import '../src/styles.css'

const q = new URLSearchParams(location.search)
const theme = q.get('theme') || 'dots'
const intensity = q.get('intensity')
const pan = q.get('pan') === '1'
const seedParam = q.get('seed')
const pinned = theme === 'ascii' && seedParam !== null
  ? {
    seed: Number(seedParam) >>> 0,
    pool: (q.get('pool') as GlyphPoolKey | null) ?? undefined,
    budgetS: q.get('budget') !== null ? Number(q.get('budget')) : undefined,
  }
  : null
const start = {
  x: Number(q.get('x') ?? -260),
  y: Number(q.get('y') ?? -180),
  z: Number(q.get('z') ?? 1),
}
localStorage.setItem(CANVAS_BG_KEY, JSON.stringify({
  theme,
  ...(intensity !== null ? { intensities: { [theme]: Number(intensity) } } : {}),
}))

const CARDS: { x: number; y: number; name: string; status: string }[] = [
  { x: 300, y: 220, name: 'coordinator-opus', status: 'working — release composition' },
  { x: 520, y: 200, name: 'rig-sol-b', status: 'verifying batch 452' },
  { x: 520, y: 330, name: 'epic-wonder-full', status: 'canvas background themes' },
  { x: 740, y: 260, name: 'model-research-sol', status: 'done — reference sent' },
  { x: 300, y: 430, name: 'hubchat-opus', status: 'idle' },
  { x: 760, y: 470, name: 'audience-luna', status: 'working — acquire flow' },
]

const liveView = { current: start }

function Stage() {
  const [view, setView] = useState(start)
  const viewRef = useRef(view)
  viewRef.current = view
  liveView.current = view
  useEffect(() => {
    if (!pan) return
    let raf = 0
    const tick = () => {
      raf = requestAnimationFrame(tick)
      setView(v => ({ ...v, x: v.x - 1.2, y: v.y - 0.4 }))
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'var(--bg)', overflow: 'hidden' }}>
      {pinned
        ? <AsciiLayer view={view} viewRef={viewRef} hidden={false} intensity={1} pin={pinned} onReady={onAsciiReady} />
        : <CanvasBackground view={view} viewRef={viewRef} hidden={false} />}
      <div style={{
        position: 'absolute', inset: 0, transformOrigin: '0 0',
        transform: `translate(${view.x}px, ${view.y}px) scale(${view.z})`,
      }}>
        {CARDS.map(c => (
          <div key={c.name} className="sq" data-card={c.name}
            onClick={() => { w.__cardClicks = (w.__cardClicks ?? 0) + 1 }}
            style={{
              position: 'absolute', left: c.x, top: c.y, width: 168, padding: '10px 12px',
              background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 10,
              color: 'var(--ink)', font: '12px/1.45 system-ui, sans-serif',
            }}>
            <div style={{ color: 'var(--ink-strong)', fontWeight: 600 }}>{c.name}</div>
            <div style={{ color: 'var(--dim)' }}>{c.status}</div>
          </div>
        ))}
      </div>
      <div style={{
        position: 'fixed', left: 8, bottom: 6, color: 'var(--dim)',
        font: '11px var(--mono)', opacity: 0.85,
      }}>
        {`${theme}${pinned ? ` seed=${pinned.seed}` : ''}${intensity !== null ? ` @ ${intensity}` : ''} · z=${start.z}${pan ? ' · panning' : ''}`}
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<Stage />)

interface FixtureWindow {
  __ready?: boolean
  __measure?: unknown
  __ascii?: AsciiTestApi
  __asciiReady?: boolean
  __asciiDraw?: (t: number, reveal?: number) => void
  __asciiTap?: (x: number, y: number) => void
  __asciiState?: () => unknown
  __compareWind?: (t: number) => unknown
  __cardClicks?: number
}
const w = window as unknown as FixtureWindow

function onAsciiReady(api: AsciiTestApi): void {
  w.__ascii = api
  w.__asciiReady = true
}
w.__asciiDraw = (t, reveal) => w.__ascii?.drawAt(t, reveal)
w.__asciiTap = (x, y) => w.__ascii?.tap(x, y)
w.__asciiState = () => w.__ascii?.state() ?? null
/* The numerical proof: draw at a pinned field time, read the wind texture
 * back, and diff every sample against the CPU mirror evaluated at the
 * same world points (fragment centres included). Per-channel stats in
 * byte units; R = light strength, GB = wind direction, A = calm gate. */
w.__compareWind = (t: number) => {
  const api = w.__ascii
  const renderer = api?.renderer()
  const host = document.querySelector('.canvas-bg-ascii')
  if (!api || !renderer || !host) return { error: 'ascii layer not ready' }
  api.drawAt(t, 1)
  const read = renderer.readWind()
  if (!read) return { error: 'wind readback unavailable' }
  const v = liveView.current
  const wCss = (host as HTMLElement).clientWidth, hCss = (host as HTMLElement).clientHeight
  const dpr = window.devicePixelRatio || 1
  const grid = gridFor(Math.round(wCss * dpr), Math.round(hCss * dpr), v.z * dpr)
  if (!grid) return { error: 'no grid at this size' }
  const cellWorldW = grid.cellWidth / grid.scale
  const cellWorldH = grid.cellHeight / grid.scale
  const originX = Math.floor((-v.x / v.z) / cellWorldW) * cellWorldW
  const originY = Math.floor((-v.y / v.z) / cellWorldH) * cellWorldH
  const span = spanFor(api.visit, grid.columns * cellWorldW, grid.rows * cellWorldH)
  const calmCx = (wCss / 2 - v.x) / v.z
  const calmCy = (ASCII_CONFIG.card.centerY * hCss - v.y) / v.z
  const clamp255 = (x: number): number => Math.round(Math.min(1, Math.max(0, x)) * 255)
  const channels = ['R', 'G', 'B', 'A'].map(name => ({ name, diffs: [] as number[] }))
  const mismatches: unknown[] = []
  for (let sy = 0; sy < read.height; sy++) {
    for (let sx = 0; sx < read.width; sx++) {
      const f = fieldAt({
        x: originX + (sx + 0.5) * cellWorldW,
        y: originY + (sy + 0.5) * (cellWorldH / 2),
        time: t, reveal: 1, visit: api.visit, span, calmCx, calmCy,
        taps: [], touchFrame: null, now: 0,
      })
      const expected = [
        clamp255(f.strength), clamp255(f.blowX * 0.5 + 0.5),
        clamp255(f.blowY * 0.5 + 0.5), clamp255(f.gate),
      ]
      const at = (sy * read.width + sx) * 4
      for (let c = 0; c < 4; c++) {
        channels[c]!.diffs.push(Math.abs((read.data[at + c] ?? 0) - (expected[c] ?? 0)))
      }
      if (mismatches.length < 8 && Math.abs((read.data[at + 1] ?? 0) - (expected[1] ?? 0)) > 16) {
        mismatches.push({
          sx, sy,
          gl: [read.data[at], read.data[at + 1], read.data[at + 2], read.data[at + 3]],
          cpu: expected,
          blow: [f.blowX, f.blowY],
        })
      }
    }
  }
  const stats = (diffs: number[]) => {
    const sorted = [...diffs].sort((a, b) => a - b)
    const pick = (p: number): number => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0
    return {
      mean: Math.round((diffs.reduce((a, b) => a + b, 0) / diffs.length) * 1000) / 1000,
      p50: pick(0.5), p99: pick(0.99), max: pick(1),
      within2: Math.round((diffs.filter(d => d <= 2).length / diffs.length) * 10000) / 10000,
    }
  }
  return {
    samples: read.width * read.height, width: read.width, height: read.height,
    channels: Object.fromEntries(channels.map(c => [c.name, stats(c.diffs)])),
    mismatches,
  }
}
requestAnimationFrame(() => requestAnimationFrame(() => { w.__ready = true }))
w.__measure = (): Promise<unknown> => new Promise(resolve => {
  const deltas: number[] = []
  let last = performance.now()
  const tick = (now: number): void => {
    deltas.push(now - last)
    last = now
    if (deltas.length >= 180) {
      const sorted = [...deltas].sort((a, b) => a - b)
      resolve({
        frames: sorted.length,
        medianMs: Math.round(sorted[Math.floor(sorted.length / 2)]! * 100) / 100,
        p95Ms: Math.round(sorted[Math.floor(sorted.length * 0.95)]! * 100) / 100,
        maxMs: Math.round(sorted[sorted.length - 1]! * 100) / 100,
      })
    } else requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
})
