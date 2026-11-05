import { Fragment, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { getAgentStates, type AgentStateSpan, type AgentStateTotals, type AgentStateWord, type AgentStatesPage } from '../api'
import { fmtAge, fmtDay, fmtFull, fmtHm, fmtStamp, isToday } from '../timefmt'
import { ageClockNow, deriveAgentVisualState, subscribeAgeClock } from './desk'
import { useLoadWhenSeen } from './loadmore'

const WORDS: AgentStateWord[] = ['active', 'idle', 'blocked', 'halted', 'frozen']
const LABEL: Record<AgentStateWord, string> = {
  active: 'Active', idle: 'Idle', blocked: 'Blocked', halted: 'Halted', frozen: 'Frozen',
}

/** A span in the desk's age words (`45s`, `12m`, `2h`): the same buckets as every other age. */
const fmtSpan = (secs: number): string => fmtAge(0, Math.max(0, secs) * 1000)

function TotalsLine({ label, totals }: { label: string; totals: AgentStateTotals }) {
  const parts = WORDS.filter(w => totals[w] > 0)
  return <span className="agent-states-window"><b>{label}</b>{' '}
    {parts.length ? parts.map((w, i) => <span key={w} data-state={w}>{i ? ' · ' : ''}{LABEL[w]} {fmtSpan(totals[w])}</span>)
      : <span className="dim">nothing recorded</span>}</span>
}

/** Bar length (percent of the track) for a span on a log scale: 1 s or less is the minimum, `maxSecs` or more the full
 *  bar, length proportional to log(duration) between. The maximum is the AGENT's tier (`scaleMaxSecs`), fixed per agent
 *  so every page and live update of one agent compares; the default is the 7 d scale. */
const WEEK = 7 * 86400
const MONTH = 30 * 86400
const YEAR = 365 * 86400
const BAR_MIN_PCT = 2
export const barWidthPct = (secs: number, maxSecs: number = WEEK): number => {
  if (!(secs > 1)) return BAR_MIN_PCT
  if (secs >= maxSecs) return 100
  return Math.max(BAR_MIN_PCT, 100 * Math.log(secs) / Math.log(maxSecs))
}

/** LONGER SCALES FOR OLDER AGENTS (USER 2026-11-05 m7a0e94f5e592): an agent older than 1 week has a 1 month (30 d) full
 *  bar, older than 1 month a 1 year (365 d) one; otherwise 7 d. Exactly a week or a month is not yet "over". */
export const scaleMaxSecs = (ageSecs: number): number => ageSecs > MONTH ? YEAR : ageSecs > WEEK ? MONTH : WEEK

/** The agent's age in seconds: from the hire time (`created`) or the earliest loaded span, whichever is older; 0 when neither
 *  is known. The hire time makes the tier right from the first page; without it the tier can only rise as older pages load. */
export const ageSecsOf = (created: string | undefined, spans: { start: string }[], nowMs: number): number => {
  let earliest = Number.POSITIVE_INFINITY
  for (const t of [created, ...spans.map(s => s.start)]) {
    const ms = t ? Date.parse(t) : NaN
    if (Number.isFinite(ms) && ms < earliest) earliest = ms
  }
  return Number.isFinite(earliest) ? Math.max(0, Math.floor((nowMs - earliest) / 1000)) : 0
}

/** Scale pips on every row's track: 1 minute, 1 hour and 1 day at the bars' own log positions (USER m45c0e03468a6). A pip
 *  beyond the track (`maxSecs` below its duration) is omitted; the full scale ends at 7 d, so all three show by default. */
const PIPS = [{ secs: 60, label: '1 min' }, { secs: 3600, label: '1 hour' }, { secs: 86400, label: '1 day' },
  { secs: WEEK, label: '1 week' }, { secs: MONTH, label: '1 month' }] as const
/** 1 min / 1 hour / 1 day always (while within the scale); 1 week once the scale reaches a month; 1 month once it reaches a
 *  year. A pip sitting at the scale's end (the week at 7 d, the month at 30 d) is not drawn. */
export const scalePips = (maxSecs: number = WEEK) =>
  PIPS.filter(p => p.secs <= 86400 ? p.secs <= maxSecs : p.secs < maxSecs).map(p => ({ ...p, pct: barWidthPct(p.secs, maxSecs) }))

/** The exact duration for a hover: "1d 1h 1m 1s", zero parts left out. */
export const fmtExact = (secs: number): string => {
  let rest = Math.floor(Math.max(0, secs))
  const parts: string[] = []
  for (const [unit, size] of [['d', 86400], ['h', 3600], ['m', 60], ['s', 1]] as const) {
    const n = Math.floor(rest / size)
    rest -= n * size
    if (n) parts.push(`${n}${unit}`)
  }
  return parts.length ? parts.join(' ') : '0s'
}

/** The local calendar day of an instant ("2026-11-02", in the user's display zone): the key a date divider changes on. */
export const dayKey = (at: string): string => fmtStamp(at).slice(0, 10)

/** The date divider's label: "Today", else "Nov 2". */
export const dayLabel = (at: string): string => isToday(at) ? 'Today' : fmtDay(at)

/** The recorded state the node's own live data shows right now, or undefined when it shows none of the five (a queued or
 *  compacting turn, say): read through the desk's badge derivation, whose precedence the engine's recording copies. Only
 *  a CHANGE of this while the tab is open adds a row, locally (spec: no engine plumbing). */
export function liveRecordedState(node: Parameters<typeof deriveAgentVisualState>[0]): AgentStateWord | undefined {
  switch (deriveAgentVisualState(node).kind) {
    case 'halted': return 'halted'
    case 'frozen': return 'frozen'
    case 'active': return 'active'
    case 'blocked': return 'blocked'
    case 'queued': case 'compacting': return undefined
    default: return 'idle'
  }
}

/** A state the agent entered while the tab was open, seen from the renderer's own live node data (never refetched). */
export interface LiveState { state: AgentStateWord; at: number }

/** The recorded spans with the live transitions applied: the spans fetched on open, the open one closed where the first
 *  live transition begins, the live ones prepended newest first (the last open). Pure. */
export function withLive(fetched: AgentStateSpan[], live: LiveState[], nowMs: number): AgentStateSpan[] {
  if (!live.length) return fetched
  const ms = (t: number) => new Date(t).toISOString()
  const fresh: AgentStateSpan[] = live.map((l, i) => {
    const end = live[i + 1]?.at ?? null
    return { state: l.state, start: ms(l.at), end: end === null ? null : ms(end),
      secs: Math.max(0, Math.floor(((end ?? nowMs) - l.at) / 1000)) }
  }).reverse()
  const rest = fetched.map((sp, i) => i === 0 && sp.end === null
    ? { ...sp, end: ms(live[0]!.at), secs: Math.max(sp.secs, Math.floor((live[0]!.at - Date.parse(sp.start)) / 1000)) } : sp)
  return [...fresh, ...rest]
}

/** The totals with the time since the page was read added locally (they converge on the next open): the span that was
 *  open at the read keeps accruing until the first live transition, then each live span does. */
export function totalsWithLive(base: AgentStateTotals, fetchedAtMs: number, openState: AgentStateWord | null, live: LiveState[], nowMs: number): AgentStateTotals {
  const out = { ...base }
  const marks: { state: AgentStateWord; from: number }[] = [
    ...(openState ? [{ state: openState, from: fetchedAtMs }] : []), ...live.map(l => ({ state: l.state, from: l.at }))]
  marks.forEach((m, i) => {
    const to = marks[i + 1]?.from ?? nowMs
    out[m.state] += Math.max(0, Math.floor((to - m.from) / 1000))
  })
  return out
}

/** The agent's state history in node settings: time per state over the last
 *  24 hours and 7 days, then each span newest first, the first page on open and
 *  older pages as the list scrolls. The rows are the engine's own recorded state
 *  changes (the desk transcript's state rows read as spans); nothing here is
 *  recorded or computed again. While the tab is open a state the agent enters
 *  (`liveState`, read from the node the renderer already holds) is added at the
 *  top and the open span closed, locally: no polling, no refetch; the next open
 *  reads the record. `provider` paints Active in the agent's provider colour. */
export function AgentStatesView({ slug, nid, provider, liveState, created }: { slug: string; nid: string; provider?: string; liveState?: AgentStateWord | null; created?: string }) {
  const [first, setFirst] = useState<AgentStatesPage | null>(null)
  const [fetchedAt, setFetchedAt] = useState(0)
  const [older, setOlder] = useState<AgentStateSpan[]>([])
  const [next, setNext] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [olderError, setOlderError] = useState('')
  const olderInFlight = useRef(false)
  const [error, setError] = useState('')
  const [live, setLive] = useState<LiveState[]>([])
  const identity = useRef(0)
  const nextRef = useRef<string | null>(null)
  nextRef.current = next
  // what the node showed when the page arrived: only a CHANGE from there is a new state
  const lastLive = useRef<AgentStateWord | null | undefined>(undefined)
  // set once the first page has been read (lastLive may legitimately be undefined: a queued or compacting agent shows no state)
  const liveReady = useRef(false)
  const loadFirst = useCallback(async () => {
    const request = identity.current
    setBusy(true); setError('')
    try {
      const page = await getAgentStates(slug, nid)
      if (request !== identity.current) return
      setFirst(page); setFetchedAt(Date.now()); setNext(page.next_cursor); setLive([])
      lastLive.current = liveStateRef.current; liveReady.current = true
    } catch (e) {
      if (request === identity.current) setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (request === identity.current) setBusy(false)
    }
  }, [slug, nid])
  const liveStateRef = useRef(liveState)
  liveStateRef.current = liveState
  /** the next page by cursor; never two at once, nothing once the cursor is spent */
  const loadOlder = useCallback(async () => {
    const before = nextRef.current
    if (!before || olderInFlight.current) return
    const request = identity.current
    olderInFlight.current = true
    setLoadingOlder(true); setOlderError('')
    try {
      const page = await getAgentStates(slug, nid, before)
      if (request !== identity.current) return
      setOlder(prev => [...prev, ...page.states])
      setNext(page.next_cursor)
    } catch (e) {
      if (request === identity.current) setOlderError(e instanceof Error ? e.message : String(e))
    } finally {
      olderInFlight.current = false
      if (request === identity.current) setLoadingOlder(false)
    }
  }, [slug, nid])
  // opening the tab always reads the first page fresh (nothing refreshes it after that)
  useEffect(() => {
    ++identity.current
    setFirst(null); setOlder([]); setNext(null); setOlderError(''); setLoadingOlder(false); setLive([]); olderInFlight.current = false
    lastLive.current = undefined; liveReady.current = false
    void loadFirst()
    return () => { ++identity.current }
  }, [slug, nid])  // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!first || !liveReady.current) return
    if (!liveState || liveState === lastLive.current) return
    lastLive.current = liveState
    setLive(prev => [...prev, { state: liveState, at: Date.now() }])
  }, [liveState, first])
  // the shared second: the open span grows with the clock, never shrinks below the server's reading
  const nowSec = useSyncExternalStore(subscribeAgeClock, ageClockNow)
  const nowMs = nowSec * 1000
  const secsOf = (s: AgentStateSpan) => s.end ? s.secs
    : Math.max(s.secs, nowSec - Math.floor(Date.parse(s.start) / 1000))
  const spans = [...withLive(first?.states ?? [], live, nowMs), ...older]
  const maxSecs = scaleMaxSecs(ageSecsOf(created, spans, nowMs))
  const pips = scalePips(maxSecs)
  const openAtFetch = first?.states[0] && first.states[0].end === null ? first.states[0].state : null
  // the sentinel arms while a page is left and the last attempt did not fail; a new cursor or a longer list re-arms it,
  // so a page that leaves the end in view loads the next at once
  const sentinel = useRef<HTMLDivElement>(null)
  useLoadWhenSeen(sentinel, next && !olderError ? `${next}:${spans.length}` : null, () => { void loadOlder() })
  const totals = first?.totals && live.length
    ? { h24: totalsWithLive(first.totals.h24, fetchedAt, openAtFetch, live, nowMs), d7: totalsWithLive(first.totals.d7, fetchedAt, openAtFetch, live, nowMs) }
    : first?.totals
  return <section className={'agent-states' + (provider ? ` prov-${provider}` : '')} aria-label={`${nid}'s state history`}>
    <div className="agent-states-head"><span className="dim">State history</span></div>
    {totals && <div className="agent-states-totals">
      <TotalsLine label="Last 24 hours" totals={totals.h24} />
      <TotalsLine label="Last 7 days" totals={totals.d7} />
    </div>}
    {error && <p role="alert">Could not load state history: {error}{' '}<button onClick={() => void loadFirst()}>Retry</button></p>}
    {busy && !first && <p role="status" className="dim">Loading state history…</p>}
    {first && spans.length === 0 && <p className="dim">No state changes recorded yet.</p>}
    <ol className="agent-states-list">{spans.map((s, i) => {
      const secs = secsOf(s)
      // a divider before the first (newest) row of each local day, over the WHOLE loaded list: a day that continues
      // across a page join gets none
      const newDay = i === 0 || dayKey(s.start) !== dayKey(spans[i - 1]!.start)
      return <Fragment key={s.start}>
        {newDay && <li className="agent-states-day pending-divider" role="separator" data-day={dayKey(s.start)}><span>{dayLabel(s.start)}</span></li>}
        <li data-state={s.state} data-open={s.end ? undefined : ''}>
          <span className="agent-states-name"><i className={`state-dot ${s.state}`} aria-hidden="true" />{LABEL[s.state]}</span>
          <time className="agent-states-when dim" dateTime={s.start}
            title={`${fmtFull(s.start)} → ${s.end ? fmtFull(s.end) : 'now'}`}>{fmtHm(s.start)}</time>
          <span className="agent-states-bar" title={`${LABEL[s.state]} for ${fmtExact(secs)}`}>
            <i className={`state-bar ${s.state}`} style={{ width: `${barWidthPct(secs, maxSecs)}%` }} />
            {pips.map(p => <b key={p.secs} className="state-pip" style={{ left: `${p.pct}%` }} title={p.label} />)}
          </span>
          <span className="agent-states-dur">{fmtSpan(secs)}</span>
        </li>
      </Fragment>
    })}</ol>
    {next && <div className="agent-states-tail">
      <div ref={sentinel} className="agent-states-sentinel" aria-hidden="true" />
      {loadingOlder && <p role="status" className="dim agent-states-loading">Loading older states…</p>}
      {olderError && <p role="alert" className="agent-states-retry">Could not load older states: {olderError}{' '}
        <button onClick={() => void loadOlder()}>Retry</button></p>}
    </div>}
  </section>
}
