/* Visual fixture for the canvas background themes: renders the REAL
 * CanvasBackground layer over a few card-shaped stand-ins, driven by URL
 * parameters (?theme=&intensity=&x=&y=&z=&pan=1), so canvasbg-capture.cjs
 * can photograph every theme against something the patterns must stay
 * behind. Also exposes window.__measure() — rAF frame-time stats over 180
 * frames — for the ASCII theme's frame-cost evidence.
 *
 * The preference is seeded through localStorage (the plain-browser path),
 * exactly what the layer reads when no native bridge exists. */
import { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { CanvasBackground } from '../src/canvas/canvasbackground'
import { CANVAS_BG_KEY } from '../src/canvasbgpref'
import '../src/styles.css'

const q = new URLSearchParams(location.search)
const theme = q.get('theme') || 'dots'
const intensity = q.get('intensity')
const pan = q.get('pan') === '1'
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

function Stage() {
  const [view, setView] = useState(start)
  const viewRef = useRef(view)
  viewRef.current = view
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
      <CanvasBackground view={view} viewRef={viewRef} hidden={false} />
      <div style={{
        position: 'absolute', inset: 0, transformOrigin: '0 0',
        transform: `translate(${view.x}px, ${view.y}px) scale(${view.z})`,
      }}>
        {CARDS.map(c => (
          <div key={c.name} style={{
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
        {`${theme}${intensity !== null ? ` @ ${intensity}` : ''} · z=${start.z}${pan ? ' · panning' : ''}`}
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<Stage />)

const w = window as unknown as { __ready?: boolean; __measure?: unknown }
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
