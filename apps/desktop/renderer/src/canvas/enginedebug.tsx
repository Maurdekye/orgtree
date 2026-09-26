/* Developer › engine debug view (user request 2026-09-26, v3 only).

   The user wants to judge the engine's memory growth themselves, so this shows
   RAW numbers with a short moving history — never a verdict light:
   • each open app window's websocket outbox: frames queued and their bytes
     against the cap, and how often that window was dropped and reconnected;
   • the engine's private bytes;
   • the docket list's last minute: full 200 answers vs 304s, the bytes the
     200s carried, and the docket bodies the engine is holding in its cache.

   ⚠ OFF BY CONSTRUCTION (same contract as the Desk toggles in shared.ts): an
   unset key reads null and null !== '1'. While off nothing is mounted and
   nothing polls. While on, ONE request is in flight at most — the next poll is
   scheduled only after the previous answer — and the history is capped at
   HISTORY samples of four numbers, so the view adds no meaningful load. */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { getEngineStats, WINDOW_ID } from '../api'
import type { EngineStats } from '../api'
import { SetToggle } from './settingskit'

export const ENGINE_DEBUG_KEY = 'orgtree-engine-debug'
export const POLL_MS = 1000
export const HISTORY = 60

export const engineDebugOn = (): boolean => {
  try { return localStorage.getItem(ENGINE_DEBUG_KEY) === '1' } catch { return false }
}
const subs = new Set<() => void>()
export const setEngineDebugOn = (on: boolean): void => {
  try { localStorage.setItem(ENGINE_DEBUG_KEY, on ? '1' : '0') } catch { /* private mode */ }
  for (const fn of [...subs]) fn()
}
const subscribe = (fn: () => void): (() => void) => {
  subs.add(fn)
  window.addEventListener('storage', fn)
  return () => { subs.delete(fn); window.removeEventListener('storage', fn) }
}
export const useEngineDebug = (): boolean => useSyncExternalStore(subscribe, engineDebugOn)

export function EngineDebugToggle() {
  const on = useEngineDebug()
  return (
    <SetToggle label="show the engine debug view" checked={on} onChange={setEngineDebugOn}
      hint={'a live panel with each window’s websocket backlog, the engine’s '
        + 'memory and the docket list’s traffic, refreshed every second'} />
  )
}

export function fmtBytes(n: number | null | undefined): string {
  if (n == null) return '—'
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v.toFixed(v < 10 ? 2 : 1)} ${units[i]}`
}

/** One sample of the numbers worth a history line. */
interface Sample {
  priv: number
  queued: number
  bytes200: number
  cached: number
}

export function Sparkline({ values, label }: { values: number[]; label: string }) {
  const w = 120
  const h = 22
  if (values.length < 2) return <svg className="edbg-spark" width={w} height={h} aria-label={label} />
  const lo = Math.min(...values)
  const hi = Math.max(...values)
  const span = hi - lo || 1
  const step = w / (HISTORY - 1)
  const x0 = w - (values.length - 1) * step
  const pts = values.map((v, i) =>
    `${(x0 + i * step).toFixed(1)},${(h - 1 - ((v - lo) / span) * (h - 2)).toFixed(1)}`)
  return (
    <svg className="edbg-spark" width={w} height={h} aria-label={label} role="img">
      <polyline points={pts.join(' ')} fill="none" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  )
}

function Metric({ name, value, series, fmt, detail }: {
  name: string; value: number | null; series: number[]
  fmt: (n: number | null) => string; detail?: string
}) {
  return (
    <div className="edbg-metric">
      <span className="edbg-name">{name}</span>
      <span className="edbg-value">{fmt(value)}</span>
      <Sparkline values={series} label={`${name}, last ${series.length} s`} />
      {series.length > 1 && (
        <span className="edbg-range dim">
          {fmt(Math.min(...series))} – {fmt(Math.max(...series))}
        </span>
      )}
      {detail && <span className="edbg-detail dim">{detail}</span>}
    </div>
  )
}

export function EngineDebugPanel({ onClose }: { onClose?: () => void }) {
  const [stats, setStats] = useState<EngineStats | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [history, setHistory] = useState<Sample[]>([])
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = async (): Promise<void> => {
      try {
        const s = await getEngineStats()
        if (!alive.current) return
        setStats(s)
        setError(null)
        const sample: Sample = {
          priv: s.memory.private_bytes ?? s.memory.rss_bytes ?? 0,
          queued: s.websockets.sockets.reduce((a, r) => a + r.pending, 0),
          bytes200: s.work_list.bytes_200,
          cached: s.work_list.cached_bytes,
        }
        setHistory(h => [...h.slice(-(HISTORY - 1)), sample])
      } catch (e) {
        if (alive.current) setError(e instanceof Error ? e.message : String(e))
      }
      // the next poll waits for this answer: never more than one in flight
      if (alive.current) timer = setTimeout(() => { void tick() }, POLL_MS)
    }
    void tick()
    return () => { alive.current = false; if (timer) clearTimeout(timer) }
  }, [])

  const col = (k: keyof Sample): number[] => history.map(h => h[k])
  const ws = stats?.websockets
  const wl = stats?.work_list
  const privLabel = stats && stats.memory.private_bytes == null ? 'memory (rss)' : 'private bytes'
  return (
    <section className="edbg-panel" aria-label="Engine debug view">
      <header className="edbg-head">
        <strong>Engine debug</strong>
        {stats && <span className="dim"> pid {stats.pid} · every {POLL_MS / 1000} s · last {history.length} s</span>}
        {onClose && <button type="button" className="iconbtn edbg-close" title="turn the debug view off"
          aria-label="turn the debug view off" onClick={onClose}>×</button>}
      </header>
      {error && <div className="ask-warn" role="alert">engine-stats: {error}</div>}
      {!stats && !error && <div className="dim">reading…</div>}
      {stats && ws && wl && <>
        <h4>Engine memory</h4>
        <Metric name={privLabel} value={stats.memory.private_bytes ?? stats.memory.rss_bytes}
          series={col('priv')} fmt={fmtBytes}
          detail={stats.memory.private_bytes != null ? `rss ${fmtBytes(stats.memory.rss_bytes)}` : undefined} />

        <h4>Docket list, last {wl.window_s} s</h4>
        <div className="edbg-row">
          <span>full 200s <b className="edbg-n200">{wl.full_200}</b></span>
          <span>304s <b className="edbg-n304">{wl.not_modified_304}</b></span>
        </div>
        <Metric name="200 bytes / min" value={wl.bytes_200} series={col('bytes200')} fmt={fmtBytes} />
        <Metric name="cached bodies" value={wl.cached_bytes} series={col('cached')} fmt={fmtBytes}
          detail={`${wl.cached_bodies} held · evicted after ${wl.cache_idle_s} s idle`} />

        <h4>Websockets</h4>
        <Metric name="frames queued (all)" value={history.length ? history[history.length - 1].queued : 0} series={col('queued')}
          fmt={n => String(n ?? 0)}
          detail={`cap ${ws.queue_max}/socket · write timeout ${ws.send_timeout_s} s · dropped: `
            + Object.entries(ws.drops).map(([k, v]) => `${k} ${v}`).join(', ')} />
        <table className="edbg-table">
          <thead><tr>
            <th>org</th><th>window</th><th>queued</th><th>queued bytes</th>
            <th>sent</th><th>connected</th><th>connects</th><th>drops</th>
          </tr></thead>
          <tbody>
            {ws.sockets.length === 0 && <tr><td colSpan={8} className="dim">no open sockets</td></tr>}
            {ws.sockets.map((r, i) => (
              <tr key={`${r.window}-${r.org}-${i}`} className={r.window === WINDOW_ID ? 'edbg-self' : undefined}>
                <td>{r.org}</td>
                <td>{r.window}{r.window === WINDOW_ID ? ' (this)' : ''}{r.public ? ' · kiosk' : ''}</td>
                <td>{r.pending} / {ws.queue_max}</td>
                <td>{fmtBytes(r.pending_bytes)}</td>
                <td>{r.sent}</td>
                <td>{Math.round(r.age_s)} s</td>
                <td>{r.window_connects}</td>
                <td>{r.window_drops}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </>}
    </section>
  )
}
