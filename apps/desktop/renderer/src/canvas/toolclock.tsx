import { createContext, useContext, useEffect, useState } from 'react'
import { EditIcon, ArrowRightIcon } from '../icons'
import type { ToolChip } from '../types'
import { LiveTokenContext, TokenCount } from './tokencount'

/** Whether the desk this transcript belongs to has a turn running. A tool call
 *  with no result only counts up while its own turn runs (`RunningTurnContext`):
 *  a call left open by an interrupted, restarted or earlier turn shows no
 *  timer. Histories and other read-only surfaces leave the default (false). */
export const TurnActiveContext = createContext(false)

/** When the turn running on this desk was admitted (the engine's
 *  `turn_started_at`), or null: none runs, or the desk does not know which
 *  yet (the composer marks a desk busy before its turn exists). Every call of
 *  that turn started after it. A call that started before it belongs to an
 *  earlier turn, and one that turn left open is never timed live again
 *  (user report 2026-10-14: yesterday's call counting "23h 08m"). */
export const RunningTurnContext = createContext<string | null>(null)

/** Whether a call that started at `startedAt` is the running turn's, by the
 *  engine's own stamps. */
export function ofRunningTurn(startedAt: unknown, turnStart: string | null): boolean {
  if (typeof startedAt !== 'string' || typeof turnStart !== 'string') return false
  const call = Date.parse(startedAt), turn = Date.parse(turnStart)
  return Number.isFinite(call) && Number.isFinite(turn) && call >= turn
}

/** The later of the two turn starts a desk holds (its chat payload's and its
 *  node's): an older one can only be a turn that has ended. */
export function newerStamp(a?: string | null, b?: string | null): string | null {
  const ok = (s?: string | null): s is string => typeof s === 'string' && Number.isFinite(Date.parse(s))
  if (!ok(a)) return ok(b) ? b : null
  if (!ok(b)) return a
  return Date.parse(a) >= Date.parse(b) ? a : b
}

/** A call is timed live only while its own turn runs on this desk. */
export function useLiveCall(startedAt: unknown): boolean {
  const active = useContext(TurnActiveContext)
  const turnStart = useContext(RunningTurnContext)
  return active && ofRunningTurn(startedAt, turnStart)
}

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

function exactTimeTitle(label: string, ms: number): string {
  return Number.isFinite(ms) && ms >= 0 ? `${label}: ${ms.toFixed(3)}ms` : `${label}: not observed for this call`
}

/** Keep the sub-ms part separate: adding it to a large epoch loses digits.
 * A stamp without millisecond precision cannot provide a precise duration. */
function stampParts(value: unknown) {
  if (typeof value !== 'string') return undefined
  const whole = Date.parse(value)
  if (!Number.isFinite(whole)) return undefined
  const fraction = value.match(/\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/)?.[1]
  return { whole, part: Number(`0.${fraction?.slice(3) || '0'}`), precise: !!fraction && fraction.length >= 3 }
}

function recordedTimeTitle(label: string, start: unknown, end: unknown): string {
  const a = stampParts(start), b = stampParts(end)
  if (!a || !b) return `${label}: not observed for this call`
  if (!a.precise || !b.precise) return `${label}: millisecond precision unavailable`
  return exactTimeTitle(label, b.whole - a.whole + b.part - a.part)
}

/** Sample the hover itself without increasing the visible clock's cadence. */
function useLiveTimeTitle(label: string, startedAt: string | undefined, active: boolean) {
  const [hover, setHover] = useState<{ start: string | undefined; at: number } | null>(null)
  const at = hover?.start === startedAt ? hover!.at : Date.now()
  const sample = () => setHover({ start: startedAt, at: Date.now() })
  return { title: active ? recordedTimeTitle(label, startedAt, new Date(at).toISOString()) : `${label}: not running for this turn`,
    onMouseEnter: sample, onFocus: sample }
}

/** Live clocks floor actual elapsed time and schedule at its next second,
 *  rather than preserving the arbitrary phase when this component mounted.
 *  Delayed callbacks recompute from the timestamp; completed clocks keep
 *  formatDuration's original precision. */
function useLiveDuration(startedAt?: string, active = true): string {
  const start = Date.parse(startedAt ?? '')
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active || !Number.isFinite(start)) return
    let timer: ReturnType<typeof setTimeout>
    const tick = () => {
      const current = Date.now()
      setNow(current)
      const elapsed = current - start
      timer = setTimeout(tick, elapsed < 0 ? 1000 - elapsed : 1000 - elapsed % 1000)
    }
    tick()
    return () => clearTimeout(timer)
  }, [active, start])
  return active && Number.isFinite(start) ? `${Math.floor(Math.max(0, now - start) / 1000)}s` : ''
}

/** Generation starts immediately at the observed block start, never after a
 *  threshold. A call known to be an earlier turn's is not timed. */
export function ToolWritingLine({ name, startedAt }: { name: string; startedAt?: string }) {
  const turnStart = useContext(RunningTurnContext)
  const earlier = turnStart !== null && !ofRunningTurn(startedAt, turnStart)
  const elapsed = useLiveDuration(startedAt, !earlier)
  const tooltip = useLiveTimeTitle('writing time', startedAt, !earlier)
  return <span className="tool-writing" {...tooltip} aria-label={`Writing ${name || 'tool call'}`}>
    <EditIcon fontSize="inherit" />
    {elapsed && <span> {elapsed}</span>}
  </span>
}

export function ToolTimes({ tool }: { tool: ToolChip }) {
  const tokens = useContext(LiveTokenContext)
  const count = (!tool.ended_at && tool.result === undefined && tool.id && tokens[tool.id]) || tool
  const live = useLiveCall(tool.started_at)
  const writing = typeof tool.writing_secs === 'number' ? formatDuration(tool.writing_secs * 1000) : ''
  const ran = executionTime(tool.started_at, tool.ended_at)
  const finished = tool.result !== undefined || !!tool.error || !!tool.ended_at
  return <>
    {tool.writing_started_at ? <span className="dim tool-writing-time">{' · '}<ToolWritingLine name={tool.name} startedAt={tool.writing_started_at} /></span>
      : writing && <span className="dim tool-writing-time" title={exactTimeTitle('writing time', tool.writing_secs! * 1000)} aria-label={`written in ${writing}`}>
        {' · '}<EditIcon fontSize="inherit" /> {writing}</span>}
    {ran ? <span className="dim tool-exec-time" title={recordedTimeTitle('execution time', tool.started_at, tool.ended_at)} aria-label={`ran for ${ran}`}>
      {' · '}<ArrowRightIcon fontSize="inherit" /> {ran}</span>
      : !tool.writing_started_at && live && typeof tool.started_at === 'string' && tool.result === undefined && !tool.error
        ? <RunningTimer startedAt={tool.started_at} />
        : !tool.writing_started_at && (finished || tool.started_at)
          ? <span className="dim tool-exec-time" title="Execution time was not observed for this call" aria-label="execution time unavailable">{' · '}<ArrowRightIcon fontSize="inherit" /> —</span> : null}
    <TokenCount count={count.output_tokens} estimated={count.output_tokens_estimated !== false} sampled={count.output_tokens_sampled} />
  </>
}

/** A call still waiting for its result: a live count of how long it has run,
 *  shown immediately, only while its own turn runs. */
export function RunningTimer({ startedAt }: { startedAt: string }) {
  const live = useLiveCall(startedAt)
  const elapsed = useLiveDuration(startedAt, live)
  const tooltip = useLiveTimeTitle('execution time', startedAt, live)
  if (!elapsed) return null
  return <span className="dim tool-running" {...tooltip} aria-label={'running for ' + elapsed}> · <ArrowRightIcon fontSize="inherit" /> {elapsed}</span>
}

/** A provider compaction's row text. Running: "Compacting context · compacting
 *  for 12s" counting from the engine's recorded start. Finished: the text and
 *  how long it took, only when both stamps were recorded (never invented). */
export function CompactingLine({ text, state, startedAt, endedAt }:
  { text: string; state?: string; startedAt?: string; endedAt?: string }) {
  const running = state === 'running'
  const elapsed = useLiveDuration(startedAt, running)
  if (running) {
    return <span className="compacting-line" aria-label={elapsed ? `compacting for ${elapsed}` : 'compacting'}>
      {elapsed ? `compacting for ${elapsed}` : text}</span>
  }
  const took = state === 'done' || state === 'failed' ? executionTime(startedAt, endedAt) : ''
  return <>{text}{took && <span className="dim" aria-label={`took ${took}`}>{' · took ' + took}</span>}</>
}
