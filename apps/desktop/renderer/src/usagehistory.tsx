// usagehistory.tsx — the usage history panel (docket
// track-usage-over-time-and-show-usage-analytics, phase 2).
//
// The Usage modal is a snapshot; this is the same usage over time, read from
// what the engine recorded (`ot.usage_history`, phase 1) and downsampled in
// the database (`GET /api/usage/history`). It opens from the Orgtree menu,
// right under "Usage…" (user 2026-10-09 22:39Z).
//
// ONE CHART PER SERIES (account × window × model scope), grouped by account:
// small multiples rather than overlaid lines, because a session window and a
// weekly window of the same account are different allowances on the same
// 0-100 % scale, and a dollar balance is not on that scale at all (one axis
// per chart, never two). Each chart is one series, so it wears one colour and
// its title names it — no legend box.
//
// WHAT IS NEVER DRAWN AS CONSUMPTION:
// - a missing reading: where the engine was not running, where the account
//   was unavailable, or where a window reported no number, there is simply no
//   point. Nothing marks the gap and the line joins the readings on either
//   side of it (user 2026-10-10: "don't mark unavailable zones on the graph
//   ... just omit the datapoints"; "connect the datapoints between the missing
//   zones with a line"). Nothing missing is ever drawn as 0, and the average
//   counts only the time readings covered, never the gap.
// - a reset: the line breaks at the recorded reset, which is marked with a
//   solid hairline, and "change" is measured from the last reset on.
//
// THE FUTURE PANE (user 2026-10-09 22:39Z, slider user 2026-10-17): every chart's
// plot spans exactly the chosen period at a FIXED time scale, and the "projected
// ahead" slider sets how much of its width is the future: the now-line sits
// that share in from the RIGHT edge. More share slides the now-line left and
// pushes the oldest history off the left edge (cropped, never squeezed): 0 %
// is the whole period of history, 100 % is all projection. The slider's thumb
// mirrors the now-line (rightmost = 0 %); the default is 20 %. The projected
// trend (a least-squares line through the current window's readings) is drawn
// in the pane dashed and labelled "projected", reaching as far as the pane
// does, and each window's next reset time is a vertical dotted line.
import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { getUsageHistory } from './api'
import type { UsageHistory, UsageHistoryRange, UsageHistoryReset, UsageHistorySeries } from './api'
import { PinFrame } from './canvas/modalpin'
import { ShowChartIcon } from './icons'
import { useOrgLaneFilter } from './orgaccounts'
import { fmtDay, fmtHm, fmtStamp, fmtWhen } from './timefmt'
import { downloadUsageHistory } from './usagehistoryexport'
import type { UsageExportFormat } from './usagehistoryexport'

const RANGES: { id: UsageHistoryRange; label: string }[] = [
  { id: '24h', label: '24 hours' }, { id: '7d', label: '7 days' },
  { id: '30d', label: '30 days' }, { id: '90d', label: '90 days' },
]
/** the panel re-reads this often while it is open (the engine records every
 *  few minutes at most, so faster would only re-draw the same buckets) */
const REFRESH_MS = 60_000
/** the projection's reach past now, as a share of the period, when the caller
 *  gives no horizon (the slider always does; this is the pre-slider layout) */
const FUTURE_SHARE = 0.25
/** the projected-ahead share of the graph's WIDTH, in percent, the slider's
 *  default: the share the pre-slider layout had (a quarter of the period past
 *  now beside the whole period behind it = 20 %). The slider's thumb is
 *  mirrored (its value is 100 − this), so the rightmost thumb is 0 % */
export const AHEAD_DEFAULT = 20
export const AHEAD_KEY = 'orgtree-usage-history-ahead-pct'
/** two consecutive readings at least this far apart are joined by a STEP (the
 *  old value held flat, then a jump at the new reading's time), never a slope:
 *  a diagonal across a long gap would show a gradual change nobody observed
 *  (user 2026-10-19). Closer readings keep the straight line. */
export const STEP_GAP_MS = 30 * 60_000
/** a projection needs a current window at least this long */
const MIN_TREND_MS = 15 * 60_000

const PROVIDERS: Record<string, string> = {
  claude: 'Claude', openai: 'Codex', google: 'Antigravity', openrouter: 'OpenRouter',
  muse: 'Muse',
}
export const providerName = (p: string): string => PROVIDERS[p] ?? p

export interface Pt { t: number; v: number }
export interface SeriesModel {
  key: string
  series: UsageHistorySeries
  /** the measured line, broken only at resets (joined across gaps) */
  segments: Pt[][]
  resets: { t: number; prev: number | null; next: number | null }[]
  nextReset: number | null
  projection: { from: Pt; to: Pt; hits: 'limit' | 'empty' | null } | null
  /** why there is no projection, when there is none */
  noProjection: string | null
  stats: {
    readings: number
    current: Pt | null
    first: Pt | null
    min: number | null
    max: number | null
    avg: number | null
    change: number | null
    /** the change is measured from this reset, not from the period's start */
    changeSince: number | null
  }
}

export const seriesKey = (s: { account: string; window: string; group: string; model: string }): string =>
  [s.account, s.window, s.group, s.model].join('\u001f')

const ms = (iso: string | null | undefined): number | null => {
  if (!iso) return null
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : null
}

/** Least-squares slope (value per ms) through the points, or null. */
export function slope(pts: Pt[]): number | null {
  if (pts.length < 2) return null
  const n = pts.length
  const mt = pts.reduce((a, p) => a + p.t, 0) / n
  const mv = pts.reduce((a, p) => a + p.v, 0) / n
  let num = 0
  let den = 0
  for (const p of pts) { num += (p.t - mt) * (p.v - mv); den += (p.t - mt) ** 2 }
  return den > 0 ? num / den : null
}

/** The corners of a segment's drawn line: across a gap of STEP_GAP_MS or more
 *  an extra corner holds the previous value until the new reading's time. */
export function stepPoints(seg: Pt[]): Pt[] {
  const out: Pt[] = []
  for (const p of seg) {
    const prev = out.at(-1)
    if (prev && p.t - prev.t >= STEP_GAP_MS) out.push({ t: p.t, v: prev.v })
    out.push(p)
  }
  return out
}

/** The reading the hover shows at time t: the one nearest, except inside a
 *  step gap, where the earlier reading is still the value in effect. */
export function readingAt(segments: Pt[][], t: number): Pt | null {
  for (const seg of segments) {
    for (let i = 0; i + 1 < seg.length; i++) {
      const a = seg[i]!
      const b = seg[i + 1]!
      if (t >= a.t && t < b.t && b.t - a.t >= STEP_GAP_MS) return a
    }
  }
  return segments.flat().reduce<Pt | null>((b, p) => (!b || Math.abs(p.t - t) < Math.abs(b.t - t) ? p : b), null)
}

/** Turn one series' buckets and resets into what the chart draws and the
 *  statistics it shows. Pure, so it is tested alone. */
export function modelSeries(series: UsageHistorySeries, resets: UsageHistoryReset[],
  opts: { now: number; since: number; until: number; gapMs: number; horizonMs?: number }): SeriesModel {
  const key = seriesKey(series)
  const pts: Pt[] = []
  for (const b of series.points) {
    const t0 = Date.parse(b.t0)
    const t1 = Date.parse(b.t1)
    if (b.first != null) pts.push({ t: t0, v: b.first })
    if (b.last != null && t1 > t0) pts.push({ t: t1, v: b.last })
  }
  pts.sort((a, b) => a.t - b.t)
  const rs = resets.filter((r) => seriesKey(r) === key)
    .map((r) => ({ t: Date.parse(r.at), prev: r.prev_pct ?? r.prev_amount, next: r.used_pct ?? r.amount }))
    .sort((a, b) => a.t - b.t)
  const segments: Pt[][] = []
  let seg: Pt[] = []
  for (const p of pts) {
    const prev = seg.at(-1)
    // only a reset breaks the line: a fall to a new window is not drawn
    const breaks = prev && rs.some((r) => r.t > prev.t && r.t <= p.t)
    if (breaks) { segments.push(seg); seg = [] }
    seg.push(p)
  }
  if (seg.length) segments.push(seg)

  const values = series.points
  const mins = values.map((b) => b.min).filter((v): v is number => v != null)
  const maxs = values.map((b) => b.max).filter((v): v is number => v != null)
  const current = pts.at(-1) ?? null
  const first = pts[0] ?? null
  // time-weighted: a recorded value holds until the next reading of its
  // segment (the engine only writes a row when the value changes), but not
  // across a gap — nothing was read there, so it does not count
  let area = 0
  let span = 0
  for (const s of segments) {
    for (let i = 0; i + 1 < s.length; i++) {
      const dt = s[i + 1]!.t - s[i]!.t
      if (dt > opts.gapMs) continue
      area += s[i]!.v * dt
      span += dt
    }
  }
  const avg = span > 0 ? area / span : pts.length ? pts.reduce((a, p) => a + p.v, 0) / pts.length : null
  const lastReset = rs.at(-1) ?? null
  const fromPt = lastReset ? pts.find((p) => p.t >= lastReset.t) ?? null : first
  const change = current && fromPt && current !== fromPt ? current.v - fromPt.v : null

  const resetAt = ms(series.latest.resets_at)
  const nextReset = resetAt != null && resetAt > opts.now ? resetAt : null
  let projection: SeriesModel['projection'] = null
  let noProjection: string | null = null
  const live = segments.at(-1) ?? []
  const tail = live.at(-1)
  if (!tail) noProjection = 'no readings'
  else if (opts.now - tail.t > opts.gapMs) noProjection = 'no recent reading'
  else if (live.length < 2 || tail.t - live[0]!.t < MIN_TREND_MS) noProjection = 'not enough readings yet'
  else {
    let k = slope(live) ?? 0
    // a used share only grows inside a window; a fall without a reset is noise
    if (series.kind === 'percent') k = Math.max(0, k)
    const horizon = opts.until + (opts.horizonMs ?? (opts.until - opts.since) * FUTURE_SHARE)
    const end = Math.min(nextReset ?? horizon, horizon)
    const startPt = { t: opts.now, v: tail.v + k * (opts.now - tail.t) }
    let to: Pt = { t: end, v: startPt.v + k * (end - opts.now) }
    let hits: 'limit' | 'empty' | null = null
    if (series.kind === 'percent' && to.v > 100 && k > 0) {
      to = { t: opts.now + (100 - startPt.v) / k, v: 100 }
      hits = 'limit'
    } else if (series.kind === 'amount' && series.window === 'credits' && to.v < 0 && k < 0) {
      to = { t: opts.now + (0 - startPt.v) / k, v: 0 }
      hits = 'empty'
    }
    if (series.kind === 'percent') startPt.v = Math.min(100, startPt.v)
    projection = { from: startPt, to, hits }
  }
  return {
    key, series, segments, resets: rs, nextReset, projection, noProjection,
    stats: {
      readings: values.reduce((a, b) => a + b.n, 0), current, first,
      min: mins.length ? Math.min(...mins) : null, max: maxs.length ? Math.max(...maxs) : null,
      avg, change, changeSince: lastReset && change != null ? lastReset.t : null,
    },
  }
}

export function fmtValue(s: UsageHistorySeries, v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '–'
  if (s.kind === 'percent') return `${v < 10 && v % 1 ? v.toFixed(1) : Math.round(v)}%`
  if ((s.unit ?? '').toUpperCase() === 'USD') return `$${v.toFixed(2)}`
  return `${v.toFixed(2)}${s.unit ? ' ' + s.unit : ''}`
}

function fmtChange(s: UsageHistorySeries, v: number | null): string {
  if (v == null) return '–'
  const sign = v > 0 ? '+' : v < 0 ? '−' : '±'
  const a = Math.abs(v)
  if (s.kind === 'percent') return `${sign}${a < 10 && a % 1 ? a.toFixed(1) : Math.round(a)} pts`
  return sign + fmtValue(s, a)
}

const WINDOW_NAMES: Record<string, string> = {
  session: 'Session', weekly_all: 'Weekly', weekly: 'Weekly', weekly_scoped: 'Weekly (one model)',
  credits: 'Credit balance', spend: 'Metered spend',
}
export function seriesTitle(s: UsageHistorySeries): string {
  const base = s.label || WINDOW_NAMES[s.window] || s.window
  return s.model && !base.toLowerCase().includes(s.model.toLowerCase()) ? `${base} · ${s.model}` : base
}

/** Time ticks for [from, to]: about five, on round local hours or days. */
export function timeTicks(from: number, to: number): { t: number; label: string }[] {
  const H = 3_600_000
  const steps = [H, 2 * H, 3 * H, 6 * H, 12 * H, 24 * H, 48 * H, 7 * 24 * H, 14 * 24 * H]
  const step = steps.find((s) => (to - from) / s <= 6) ?? steps.at(-1)!
  const start = new Date(from)
  start.setMinutes(0, 0, 0)
  if (step >= 24 * H) start.setHours(0)
  // a shorter step starts on its own boundary: from an hour that is not a
  // multiple of it every later tick is skipped below, and the axis has no labels
  else while (start.getHours() % (step / H)) start.setHours(start.getHours() + 1)
  const out: { t: number; label: string }[] = []
  for (let t = start.getTime(); t <= to; t += step) {
    // re-align on local midnight/hour after a DST change
    const d = new Date(t)
    if (step >= 24 * H) d.setHours(0, 0, 0, 0)
    else if (d.getHours() % (step / H)) continue
    if (d.getTime() >= from) out.push({ t: d.getTime(), label: step >= 24 * H ? fmtDay(d.getTime()) : fmtHm(d.getTime()) })
  }
  return out
}

function niceMax(v: number): number {
  if (v <= 0) return 1
  const p = 10 ** Math.floor(Math.log10(v))
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((m) => m >= v)!
}

function useWidth(): [(el: HTMLDivElement | null) => void, number] {
  const [w, setW] = useState(0)
  const ro = useRef<ResizeObserver | null>(null)
  const ref = useCallback((el: HTMLDivElement | null) => {
    ro.current?.disconnect()
    if (!el) return
    setW(el.clientWidth)
    ro.current = new ResizeObserver(() => setW(el.clientWidth))
    ro.current.observe(el)
  }, [])
  useEffect(() => () => ro.current?.disconnect(), [])
  return [ref, w]
}

/** The time axis of one chart as fractions of its plot width. The SCALE is
 *  fixed: the plot always spans exactly the period, so dragging the share only
 *  slides the "now" line, which sits `share` of the way in from the RIGHT edge.
 *  More share moves it left and pushes the oldest history off the left edge
 *  (cropped, not squeezed). 0 = the whole period of history fills the plot,
 *  1 = the plot is all ahead. Pure, so it is tested alone. */
export function aheadAxis(since: number, until: number, share: number) {
  const k = Math.min(1, Math.max(0, share))
  const span = Math.max(1, until - since)
  const left = until - (1 - k) * span
  return {
    nowAt: 1 - k,
    /** the time at the plot's left and right edges */
    left, right: left + span,
    /** time → fraction of the plot width (not clamped: what falls off an edge is clipped, not squeezed) */
    at: (t: number): number => (t - left) / span,
    /** fraction of the plot width → time */
    time: (f: number): number => left + f * span,
  }
}

const clampAhead = (v: number): number => Number.isFinite(v) ? Math.min(100, Math.max(0, Math.round(v))) : AHEAD_DEFAULT
let aheadCache: number | null = null
const aheadSubs = new Set<() => void>()
const readAhead = (): number => {
  if (aheadCache != null) return aheadCache
  let v = AHEAD_DEFAULT
  try {
    const raw = localStorage.getItem(AHEAD_KEY)
    if (raw != null && raw.trim() !== '') v = clampAhead(Number(raw))
  } catch { /* private mode */ }
  return (aheadCache = v)
}
export const setAheadShare = (pct: number): void => {
  aheadCache = clampAhead(pct)
  try { localStorage.setItem(AHEAD_KEY, String(aheadCache)) } catch { /* private mode */ }
  for (const fn of [...aheadSubs]) fn()
}
const subscribeAhead = (fn: () => void): (() => void) => {
  aheadSubs.add(fn)
  const onStorage = (e: StorageEvent) => { if (e.key === null || e.key === AHEAD_KEY) { aheadCache = null; fn() } }
  window.addEventListener('storage', onStorage)
  return () => { aheadSubs.delete(fn); window.removeEventListener('storage', onStorage) }
}
/** the remembered projected-ahead share, in percent (a browser-local preference, like the pinned-modal fade) */
export const useAheadShare = (): number => useSyncExternalStore(subscribeAhead, readAhead, () => AHEAD_DEFAULT)

const H_CHART = 150
const PAD = { l: 44, r: 12, t: 14, b: 22 }

function Chart({ m, from, to, now, ahead }: { m: SeriesModel; from: number; to: number; now: number; ahead: number }) {
  const [ref, width] = useWidth()
  const [hover, setHover] = useState<number | null>(null)
  const s = m.series
  const all = m.segments.flat()
  const top = s.kind === 'percent'
    ? Math.max(100, ...all.map((p) => p.v))
    : niceMax(Math.max(...all.map((p) => p.v), m.projection?.to.v ?? 0, 0) * 1.1)
  const W = Math.max(width, 200)
  const axis = aheadAxis(from, now, ahead / 100)
  const clipId = useId()
  const plotW = W - PAD.l - PAD.r
  const x = (t: number) => PAD.l + axis.at(t) * plotW
  const hasPast = axis.nowAt > 0
  const hasAhead = axis.nowAt < 1
  const y = (v: number) => PAD.t + (1 - v / top) * (H_CHART - PAD.t - PAD.b)
  const yTicks = s.kind === 'percent' ? [0, 50, 100] : [0, top / 2, top]
  // one tick set over the whole fixed-scale axis, thinned where they crowd
  let ticks = timeTicks(axis.left, axis.right)
  let lastTick = -Infinity
  ticks = ticks.filter((k) => { const px = x(k.t); if (px < PAD.l || px > W - PAD.r || px - lastTick < 38) return false; lastTick = px; return true })
  const path = (seg: Pt[]) => seg.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join('')
  // every recorded reset gets its hairline, but only resets far enough
  // apart get a word: 5-hour windows on a week's axis would print a smear
  let lastLabel = -Infinity
  const resetMarks = m.resets.filter((r) => r.t >= axis.left).map((r) => {
    const label = x(r.t) - lastLabel >= 40 && x(r.t) <= x(now) - 30
    if (label) lastLabel = x(r.t)
    return { t: r.t, label }
  })

  // the hover readout: the measured point nearest the pointer, or the
  // projection when the pointer is in the future pane
  let tip: ReactNode = null
  if (hover != null) {
    const t = axis.time((hover - PAD.l) / plotW)
    const near = readingAt(m.segments, t)
    let body: ReactNode
    if (t > now && m.projection && hasAhead) {
      const { from: a, to: b } = m.projection
      const at = Math.min(t, b.t)
      const v = a.v + ((b.v - a.v) * (at - a.t)) / Math.max(1, b.t - a.t)
      body = <><b>projected</b> {fmtValue(s, v)} · {fmtStamp(at)}</>
    } else if (near && hasPast) {
      body = <><b>{fmtValue(s, near.v)}</b> · {fmtStamp(near.t)}</>
    }
    tip = body && <div className="uh-tip" style={{ left: Math.min(Math.max(hover, 80), W - 80) }}>{body}</div>
  }

  return (
    <div className="uh-plot" ref={ref}>
      {width > 0 && (
        <svg width={W} height={H_CHART} role="img"
          aria-label={`${seriesTitle(s)}: ${fmtValue(s, m.stats.current?.v)} now`}
          onPointerMove={(e) => {
            const r = e.currentTarget.getBoundingClientRect()
            const px = e.clientX - r.left
            setHover(px >= PAD.l && px <= W - PAD.r ? px : null)
          }}
          onPointerLeave={() => setHover(null)}>
          {yTicks.map((v) => (
            <g key={v}>
              <line className="uh-gridline" x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} />
              <text className="uh-axis" x={PAD.l - 6} y={y(v) + 3.5} textAnchor="end">
                {s.kind === 'percent' ? `${v}%` : fmtValue(s, v)}</text>
            </g>
          ))}
          {ticks.map((k) => (
            <text key={k.t} className="uh-axis" x={x(k.t)} y={H_CHART - 6} textAnchor="middle">{k.label}</text>
          ))}
          <clipPath id={clipId}><rect x={PAD.l} y={0} width={plotW} height={H_CHART} /></clipPath>
          <g clipPath={`url(#${clipId})`}>
          {hasAhead && <rect className="uh-future" x={x(now)} y={PAD.t} width={Math.max(0, PAD.l + plotW - x(now))}
            height={H_CHART - PAD.t - PAD.b} />}
          {hasPast && resetMarks.map((r) => (
            <g key={r.t}>
              <line className="uh-reset" x1={x(r.t)} x2={x(r.t)} y1={PAD.t} y2={H_CHART - PAD.b} />
              {r.label && <text className="uh-axis" x={x(r.t) + 3} y={PAD.t + 8}>reset</text>}
            </g>
          ))}
          {hasAhead && m.nextReset != null && m.nextReset <= to && (
            <g>
              <line className="uh-next-reset" x1={x(m.nextReset)} x2={x(m.nextReset)} y1={PAD.t} y2={H_CHART - PAD.b} />
              <text className="uh-axis" x={x(m.nextReset) - 3} y={H_CHART - PAD.b - 4} textAnchor="end">next reset</text>
            </g>
          )}
          {hasPast && m.segments.map((seg, i) => seg.length > 1
            ? <path key={i} className="uh-line" d={path(stepPoints(seg))} />
            : <circle key={i} className="uh-dot" cx={x(seg[0]!.t)} cy={y(seg[0]!.v)} r={2.5} />)}
          {hasAhead && m.projection && (
            <g>
              <path className="uh-proj" d={path([m.projection.from, m.projection.to])} />
              <text className="uh-proj-label" x={Math.min(x(m.projection.to.t), W - PAD.r) - 2}
                y={Math.max(PAD.t + 18, y(m.projection.to.v) - 5)} textAnchor="end">projected</text>
            </g>
          )}
          {hasPast && m.stats.current && <circle className="uh-end" cx={x(m.stats.current.t)} cy={y(m.stats.current.v)} r={3.5} />}
          </g>
          {hover != null && <line className="uh-cross" x1={hover} x2={hover} y1={PAD.t} y2={H_CHART - PAD.b} />}
        </svg>
      )}
      {tip}
    </div>
  )
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return <div className="uh-stat" title={hint}><span className="uh-stat-label">{label}</span><b>{value}</b></div>
}

function SeriesCard({ m, from, to, now, ahead }: { m: SeriesModel; from: number; to: number; now: number; ahead: number }) {
  const s = m.series
  const st = m.stats
  const [exportError, setExportError] = useState('')
  const exportReadings = (owner: Document, format: UsageExportFormat) => {
    setExportError('')
    try { downloadUsageHistory(owner, s, m.segments.flat(), from, now, format) }
    catch (e) { setExportError(e instanceof Error ? e.message : 'Export failed. Try again.') }
  }
  const nextResetNote = m.nextReset != null && m.nextReset > to ? `next reset ${fmtWhen(new Date(m.nextReset).toISOString())} ›` : null
  // with no projected-ahead pane (slider at 0 %) there is no projection to describe
  let proj = m.noProjection && ahead > 0 ? `projection: ${m.noProjection}` : null
  if (m.projection && ahead > 0) {
    const p = m.projection
    proj = p.hits === 'limit' ? `projected to reach 100% ≈ ${fmtStamp(p.to.t)}`
      : p.hits === 'empty' ? `projected to run out ≈ ${fmtStamp(p.to.t)}`
      : m.nextReset != null && p.to.t >= m.nextReset ? `projected ${fmtValue(s, p.to.v)} at the reset`
      : `projected ${fmtValue(s, p.to.v)} by ${fmtStamp(p.to.t)}`
  }
  return (
    <section className="uh-card">
      <div className="uh-card-head">
        <span className="uh-title">{seriesTitle(s)}</span>
        {s.group && s.group !== s.window && <span className="dim uh-sub">{s.group}</span>}
        <span className="dim uh-sub">{st.readings} reading{st.readings === 1 ? '' : 's'}</span>
      </div>
      {st.readings === 0
        ? <div className="dim uh-empty-series">No numeric reading in this period — the provider reported this
            window without a value, so nothing is drawn (never as 0).</div>
        : <>
          <div className="uh-stats">
            <Stat label="current" value={fmtValue(s, st.current?.v)}
              hint={st.current ? `read ${fmtStamp(st.current.t)}` : undefined} />
            <Stat label={st.changeSince != null ? 'since reset' : 'change'} value={fmtChange(s, st.change)}
              hint={st.changeSince != null ? `measured from the reset at ${fmtStamp(st.changeSince)}; a reset is not consumption`
                : 'last reading minus the first in the period'} />
            <Stat label="min" value={fmtValue(s, st.min)} />
            <Stat label="max" value={fmtValue(s, st.max)} />
            <Stat label="average" value={fmtValue(s, st.avg)} hint="time-weighted over the covered time" />
          </div>
          <Chart m={m} from={from} to={to} now={now} ahead={ahead} />
          <div className="uh-foot dim">
            {proj && <span>{proj}</span>}
            {nextResetNote && <span>{nextResetNote}</span>}
            {st.readings < 2 && <span>one reading so far — not enough for a trend</span>}
            <span className="uh-exports">
              {(['csv', 'jsonl'] as const).map(format => <button key={format} type="button" className="uh-export-btn"
                aria-label={`Export ${seriesTitle(s)} as ${format.toUpperCase()}`}
                onClick={e => exportReadings(e.currentTarget.ownerDocument, format)}>{format.toUpperCase()}</button>)}
            </span>
          </div>
          {exportError && <div role="alert" className="uh-error">{exportError}</div>}
        </>}
    </section>
  )
}

/** A filter is one compact select; its name is its aria-label and tooltip, and
 *  its "all" entry says what it filters while nothing is chosen. */
function Select({ label, all, value, set, options }: {
  label: string; all: string; value: string; set: (v: string) => void; options: { id: string; label: string }[]
}) {
  return (
    <select className="uh-filter" aria-label={label} title={label} value={value}
      onChange={(e) => set(e.target.value)}>
      <option value="">{all}</option>
      {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
    </select>
  )
}

const uniq = (xs: { id: string; label: string }[]) =>
  [...new Map(xs.map((x) => [x.id, x])).values()].sort((a, b) => a.label.localeCompare(b.label))

export function UsageHistoryModal({ close, org }: { close: () => void; org?: string | null }) {
  // opened from an org window: that org's accounts, the rest behind a toggle
  // (user 2026-10-10); from Home, every account. Recording is not affected.
  const lanes = useOrgLaneFilter(org)
  const [range, setRange] = useState<UsageHistoryRange>('7d')
  const [data, setData] = useState<UsageHistory | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [provider, setProvider] = useState('')
  const [account, setAccount] = useState('')
  const [win, setWin] = useState('')
  const [model, setModel] = useState('')
  const ahead = useAheadShare()

  useEffect(() => {
    let live = true
    const load = () => getUsageHistory(range)
      .then((d) => { if (live) { setData(d); setError(null) } })
      .catch((e: Error) => { if (live) setError(e.message) })
    void load()
    const id = window.setInterval(load, REFRESH_MS)
    return () => { live = false; window.clearInterval(id) }
  }, [range])

  const view = useMemo(() => {
    // the data on hand, whichever period it is for: a period switch keeps showing it (in place)
    // until the new period's answer replaces it, rather than blanking the page
    if (!data) return null
    const since = Date.parse(data.since)
    const until = Date.parse(data.until)
    const now = until
    // a series re-records hourly when nothing changes; longer than that
    // (plus a probe's cadence) without a row means nothing was read
    const gapMs = Math.max((data.keepalive_min + 15) * 60_000, 2 * data.bucket_s * 1000)
    // the projection runs as far as the pane ahead reaches at the chosen share
    const horizonMs = aheadAxis(since, until, ahead / 100).right - until
    const models = data.series.map((s) => modelSeries(s, data.resets, { now, since, until, gapMs, horizonMs }))
    return { since, until, now, models, to: until + horizonMs }
  }, [data, ahead])

  const series = data?.series ?? []
  // the chosen period's answer has not arrived yet: the previous period stays shown, dimmed
  const busy = data != null && data.range !== range && !error
  const shown = (view?.models ?? []).filter((m) => lanes.used(m.series.account))
    .filter((m) => (!provider || m.series.provider === provider)
    && (!account || m.series.account === account) && (!win || m.series.window === win)
    && (!model || (model === '-' ? !m.series.model : m.series.model === model)))
  const byAccount = new Map<string, SeriesModel[]>()
  for (const m of shown) byAccount.set(m.series.account, [...(byAccount.get(m.series.account) ?? []), m])
  // an account that was never readable in the period has no series at all;
  // it still gets its heading, saying why, rather than vanishing
  if (!win && !model) {
    for (const s of data?.states ?? []) {
      if (!byAccount.has(s.account) && lanes.used(s.account)
        && (!provider || s.provider === provider) && (!account || s.account === account)
        && !series.some((x) => x.account === s.account)) byAccount.set(s.account, [])
    }
  }
  const lastState = (acct: string) => data?.states.filter((s) => s.account === acct).at(-1)

  return (
    <PinFrame kind="usage-history" title="Usage history" panel="settings usage-history-modal" close={close}>
      <div className="uh-header">
        <h3><ShowChartIcon fontSize="inherit" /> Usage history</h3>
        <div className="uh-ranges" role="group" aria-label="period" aria-busy={busy}>
          {RANGES.map((r) => (
            <button key={r.id} type="button" className={'uh-range' + (r.id === range ? ' on' : '')}
              aria-pressed={r.id === range} onClick={() => setRange(r.id)}>{r.label}</button>
          ))}
        </div>
        <label className="uh-ahead" title="How much of each graph's width is the projected-ahead view">
          <span>Projected ahead</span>
          {/* the thumb mirrors the "now" line: dragged left it moves the line left (more ahead), rightmost = 0 % */}
          <input type="range" min={0} max={100} step={1} value={100 - ahead} aria-label="Projected-ahead share of the graph"
            aria-valuetext={`${ahead}% of the graph`} onChange={(e) => setAheadShare(100 - Number(e.target.value))} />
          <output>{ahead}%</output>
        </label>
        <div className="uh-filters" role="group" aria-label="filters">
          <Select label="Provider" all="All providers" value={provider} set={setProvider}
            options={uniq(series.filter((s) => lanes.used(s.account))
              .map((s) => ({ id: s.provider, label: providerName(s.provider) })))} />
          <Select label="Account" all="All accounts" value={account} set={setAccount}
            options={uniq(series.filter((s) => lanes.used(s.account))
              .map((s) => ({ id: s.account, label: `${providerName(s.provider)} · ${s.account_label}` })))} />
          <Select label="Window" all="All windows" value={win} set={setWin}
            options={uniq(series.map((s) => ({ id: s.window, label: WINDOW_NAMES[s.window] ?? s.window })))} />
          <Select label="Model scope" all="All models" value={model} set={setModel}
            options={uniq(series.map((s) => (s.model ? { id: s.model, label: s.model } : { id: '-', label: 'every model' })))} />
        </div>
      </div>
      {error && <div className="uh-error">usage history unavailable: {error}</div>}
      {!data && !error && <div className="dim">loading…</div>}
      {view && data && (
        <div className="uh-period dim">
          {fmtStamp(view.since)} – {fmtStamp(view.until)} (now) ·{ahead > 0 && ' the shaded pane on the right is the future ·'}
          {data.oldest ? ` history kept since ${fmtStamp(data.oldest)}` : ' nothing recorded yet'}
          {` (${data.retain_days} days at most)`}
          {data.truncated && ' · too many series: some are not shown'}
        </div>
      )}
      {view && data && !data.oldest && (
        <div className="uh-empty">
          <b>No usage history yet.</b> Orgtree records each signed-in account's usage every few minutes
          while it runs; the graphs fill in from the first reading on. Nothing is shown until then rather
          than an empty line at 0.
        </div>
      )}
      {view && data && data.oldest && !series.length && (
        <div className="uh-empty">
          Nothing was recorded in the last {RANGES.find((r) => r.id === data.range)?.label}. The oldest kept
          reading is from {fmtStamp(data.oldest)} — choose a longer period.
        </div>
      )}
      {view && series.length > 0 && !shown.length && <div className="uh-empty">No series match these filters.</div>}
      {view && [...byAccount].map(([acct, ms]) => {
        const st = lastState(acct)
        return (
          <div className={'uh-account' + (busy ? ' busy' : '')} key={acct}>
            <div className="uh-account-head">
              <b>{providerName(ms[0]?.series.provider ?? st?.provider ?? '')}</b>
              <span>{ms[0]?.series.account_label ?? st?.account_label ?? acct}</span>
              {st && st.state !== 'ok' && (
                <span className="uh-state" title={st.detail ?? undefined}>{st.state} since {fmtStamp(st.at)}</span>
              )}
            </div>
            {!ms.length && <div className="dim uh-empty-series">No usage reading in this period
              {st && st.state !== 'ok' ? ` — the account was ${st.state}${st.detail ? ': ' + st.detail : ''}` : ''}.</div>}
            <div className="uh-grid">
              {ms.map((m) => <SeriesCard key={m.key} m={m} from={view.since} to={view.to} now={view.now} ahead={ahead} />)}
            </div>
          </div>
        )
      })}
    </PinFrame>
  )
}
