import { createContext, useContext, useEffect, useState } from 'react'
import { EditIcon, ArrowRightIcon } from '../icons'
import type { ToolChip } from '../types'

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

/** Generation starts immediately at the observed block start, never after a threshold. */
export function ToolWritingLine({ name, startedAt }: { name: string; startedAt?: string }) {
  const start = Date.parse(startedAt ?? '')
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [startedAt])
  return <span className="tool-writing" aria-label={`Writing ${name || 'tool call'}`}>
    <EditIcon fontSize="inherit" />
    {Number.isFinite(start) && <span title={'Writing ' + (name || 'tool call') + ': writing time so far'}> {formatDuration(Math.max(0, now - start))}</span>}
  </span>
}

export function ToolTimes({ tool }: { tool: ToolChip }) {
  const turnActive = useContext(TurnActiveContext)
  const writing = typeof tool.writing_secs === 'number' ? formatDuration(tool.writing_secs * 1000) : ''
  const ran = executionTime(tool.started_at, tool.ended_at)
  const finished = tool.result !== undefined || !!tool.error || !!tool.ended_at
  return <>
    {tool.writing_started_at ? <span className="dim tool-writing-time">{' · '}<ToolWritingLine name={tool.name} startedAt={tool.writing_started_at} /></span>
      : (writing || finished) && <span className="dim tool-writing-time" title={writing ? 'writing time' : 'Writing time was not observed for this call'} aria-label={writing ? `written in ${writing}` : 'writing time unavailable'}>
        {' · '}<EditIcon fontSize="inherit" /> {writing || '—'}</span>}
    {ran ? <span className="dim tool-exec-time" title="execution time" aria-label={`ran for ${ran}`}>
      {' · '}<ArrowRightIcon fontSize="inherit" /> {ran}</span>
      : !tool.writing_started_at && turnActive && typeof tool.started_at === 'string' && Number.isFinite(Date.parse(tool.started_at)) && tool.result === undefined && !tool.error
        ? <RunningTimer startedAt={tool.started_at} />
        : !tool.writing_started_at && (finished || tool.started_at)
          ? <span className="dim tool-exec-time" title="Execution time was not observed for this call" aria-label="execution time unavailable">{' · '}<ArrowRightIcon fontSize="inherit" /> —</span> : null}
  </>
}

/** A call still waiting for its result: a live count of how long it has run,
 *  shown immediately, only while the turn is active. */
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
  if (!turnActive || Number.isNaN(start)) return null
  const elapsed = formatDuration(Math.max(0, now - start))
  return <span className="dim tool-running" title="execution time so far" aria-label={'running for ' + elapsed}> · <ArrowRightIcon fontSize="inherit" /> {elapsed}</span>
}
