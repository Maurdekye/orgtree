import { createContext, useContext, useEffect, useState } from 'react'

/** Whether the desk this transcript belongs to has a turn running. A tool call
 *  with no result only counts up while it does: a call left open by an
 *  interrupted or restarted turn shows no timer. Histories and other read-only
 *  surfaces leave the default (false). */
export const TurnActiveContext = createContext(false)

/** "840 ms", "1.2s", "12s", "1m 05s", "1h 02m". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return ''
  if (ms < 1000) return `${Math.round(ms)} ms`
  const s = ms / 1000
  if (s < 10) return `${s.toFixed(1)}s`
  if (s < 60) return `${Math.floor(s)}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(Math.floor(s % 60)).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

/** How long a finished call took, from the engine's recorded start and result
 *  stamps; '' when either is missing (older rows, an interrupted call). */
export function executionTime(startedAt?: unknown, endedAt?: unknown): string {
  if (typeof startedAt !== 'string' || typeof endedAt !== 'string') return ''
  const a = Date.parse(startedAt), b = Date.parse(endedAt)
  return Number.isNaN(a) || Number.isNaN(b) ? '' : formatDuration(b - a)
}

/** A call still waiting for its result: a live count of how long it has run,
 *  shown once it passes ten seconds, only while the turn is active. */
export function RunningTimer({ startedAt }: { startedAt: string }) {
  const turnActive = useContext(TurnActiveContext)
  const start = Date.parse(startedAt)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!turnActive || Number.isNaN(start)) return
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [turnActive, start])
  if (!turnActive || Number.isNaN(start) || now - start <= 10000) return null
  return <span className="dim tool-running" title="running time so far"> · {formatDuration(now - start)}</span>
}
