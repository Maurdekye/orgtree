/* stallwatch.ts - the renderer half of the UI stall tooling (item ui-freezes-intermittently-for-several-seconds-at;
   spec ui-stall-tooling-spec rev 1.3, section R). It answers "WHAT was the page doing when it stopped answering?" for
   every long animation frame (>= 500 ms), and hands ONE record per stall to the main process (window.orgtreeDesktop
   .diagStall), which redacts and writes it (main/stall-log.ts).
   NEVER recorded here: a key, code, value, selection, message body, request or response body, socket data, title,
   agent or org name. The target of an input is a fixed descriptor (data-stall-id or tag[type]); a field's length is
   rounded down to 100; names are counted, never named. freezelog.ts is a separate, older recorder and stays as it is.
   Everything is passive: observers and counters, no timer of its own, nothing written while nothing stalls. */
import { RateCap, STALL_MIN_MS } from '../../../../packages/contracts/stall'
import { readStreamerStats } from './streamerstats'
import type { StallContext, StallCountGetters } from '../../../../packages/contracts/stall'

type Any = Record<string, any>
const DESKTOP_KEY = 'orgtreeDesktop'

// ------------------------------------------------------------------ small rings
/** timestamps (ms, performance.now timebase), newest last, at most `cap` */
export class TimeRing {
  private t: number[] = []
  constructor(private readonly cap = 64) {}
  push(t: number): void { this.t.push(t); if (this.t.length > this.cap) this.t.shift() }
  count(from: number, to: number): number { let n = 0; for (const x of this.t) if (x >= from && x <= to) n++; return n }
}
class SizedRing {
  private t: Array<[number, number]> = []
  constructor(private readonly cap = 512) {}
  push(t: number, size: number): void { this.t.push([t, size]); if (this.t.length > this.cap) this.t.shift() }
  sum(from: number, to: number): { n: number; size: number } {
    let n = 0, size = 0
    for (const [t, s] of this.t) if (t >= from && t <= to) { n++; size += s }
    return { n, size }
  }
}

// ------------------------------------------------------------------ app-registered context and counts (fixed enums only)
let context: StallContext = { screen: 'other', panel: 'none', popout: null }
let getters: StallCountGetters = {}
/** the app calls this at its existing view switches; values are fixed enums, never a name, id or title */
export function setStallContext(next: Partial<StallContext>): void { context = { ...context, ...next } }
export function getStallContext(): StallContext { return { ...context } }
export function registerStallCounts(g: StallCountGetters): void { getters = { ...getters, ...g } }
const read = (f?: () => number): number | null => { try { const v = f?.(); return typeof v === 'number' && Number.isFinite(v) ? v : null } catch { return null } }

/** counters the app bumps: socket frames and draft writes */
const wsFrames = new SizedRing(512)
const draftSaves = new TimeRing(256)
export const stallWsFrame = (bytes: number, t = performance.now()): void => wsFrames.push(t, Math.max(0, bytes | 0))
export const noteDraftSave = (t = performance.now()): void => draftSaves.push(t)

// ------------------------------------------------------------------ React commits (the DevTools hook, installed BEFORE React loads)
export interface CommitCounter { count(from: number, to: number): number }
const commits = new TimeRing(64)
const patched = new WeakSet<object>()
/** Where React reports each commit. If the page has no DevTools hook yet, a minimal one is installed; if one exists its
 *  `onCommitFiberRoot` is wrapped and every call still reaches it. Timestamps only: a production build has no durations. */
export function installReactHook(win: Any = window as Any, now: () => number = () => performance.now()): CommitCounter {
  const existing = win.__REACT_DEVTOOLS_GLOBAL_HOOK__
  if (!existing) {
    const hook = {
      supportsFiber: true, inject() { return 1 }, checkDCE() {}, onCommitFiberUnmount() {}, onPostCommitFiberRoot() {},
      onCommitFiberRoot() { commits.push(now()) },
    }
    patched.add(hook)
    win.__REACT_DEVTOOLS_GLOBAL_HOOK__ = hook
  } else if (!patched.has(existing) && typeof existing.onCommitFiberRoot === 'function') {
    patched.add(existing)
    const original = existing.onCommitFiberRoot
    existing.onCommitFiberRoot = function (this: unknown, ...args: unknown[]) {
      commits.push(now())
      return original.apply(this, args)
    }
  }
  return { count: (from, to) => commits.count(from, to) }
}

// ------------------------------------------------------------------ in-flight engine calls
export interface FlightTracker { open(): Array<{ route: string; method: string; started: number }> }
const MAX_FLIGHTS = 32
/** wrap fetch ONCE: the unsettled calls (route without query, method, start) up to 32, the oldest dropped */
export function wrapFetch(win: Any, now: () => number = () => performance.now()): FlightTracker {
  const flights: Array<{ route: string; method: string; started: number; done: boolean }> = []
  const original = win.fetch
  if (typeof original === 'function') {
    win.fetch = function (this: unknown, input: any, init?: any) {
      let route = '', method = 'GET'
      try {
        const raw = typeof input === 'string' ? input : input?.url ?? String(input)
        route = String(raw).replace(/^https?:\/\/[^/]+/i, '').replace(/[?#].*$/, '')
        method = String(init?.method ?? input?.method ?? 'GET').toUpperCase()
      } catch { /* unreadable: still tracked, route empty */ }
      const entry = { route, method, started: now(), done: false }
      flights.push(entry)
      if (flights.length > MAX_FLIGHTS) flights.shift()
      const finish = () => { entry.done = true; const i = flights.indexOf(entry); if (i >= 0) flights.splice(i, 1) }
      const promise = original.call(win, input, init)
      try { promise.then(finish, finish) } catch { finish() }
      return promise
    }
  }
  return { open: () => flights.filter(f => !f.done).map(({ route, method, started }) => ({ route, method, started })) }
}

// ------------------------------------------------------------------ targets and the DOM census
const KNOWN_TARGET = /^[a-z0-9-]{1,32}$/
/** the nearest ancestor data-stall-id, else tag[type]; never a name, id or text */
export function stallTarget(el: any): string {
  try {
    const marked = el?.closest?.('[data-stall-id]')?.getAttribute('data-stall-id')
    if (marked && KNOWN_TARGET.test(marked)) return marked
    const tag = String(el?.tagName ?? '').toLowerCase()
    if (!tag) return 'other'
    const ce = el.getAttribute?.('contenteditable')
    if (el.isContentEditable === true || ce === '' || ce === 'true' || ce === 'plaintext-only') return `${tag}[contenteditable]`
    const type = tag === 'input' ? String(el.type || 'text').toLowerCase() : ''
    return type ? `${tag}[${type}]` : tag
  } catch { return 'other' }
}
/** length of the focused field's value or text, rounded DOWN to a multiple of 100 (a big draft is a suspect; the text never leaves) */
export function focusedFieldLength(doc: Any): number {
  try {
    const el = doc.activeElement
    if (!el) return 0
    const n = typeof el.value === 'string' ? el.value.length : el.isContentEditable ? (el.textContent ?? '').length : 0
    return Math.floor(n / 100) * 100
  } catch { return 0 }
}
export interface DomCensus { dom_nodes: number; text_nodes: number; max_depth: number; dom_partial: boolean }
/** one iterative walk that stops after `budgetMs`: element nodes, text nodes and the deepest depth */
export function domCensus(root: any, budgetMs = 10, now: () => number = () => performance.now()): DomCensus {
  const t0 = now()
  let dom = 0, text = 0, depth = 0, max = 0, steps = 0
  let node: any = root?.firstChild ?? null
  const stack: any[] = []
  while (node) {
    if (node.nodeType === 1) dom++
    else if (node.nodeType === 3) text++
    if ((++steps & 255) === 0 && now() - t0 > budgetMs) return { dom_nodes: dom, text_nodes: text, max_depth: max, dom_partial: true }
    if (node.firstChild) { stack.push(node); depth++; if (depth > max) max = depth; node = node.firstChild; continue }
    while (node && !node.nextSibling) { node = stack.pop() ?? null; depth-- }
    node = node ? node.nextSibling : null
  }
  return { dom_nodes: dom, text_nodes: text, max_depth: max, dom_partial: false }
}

// ------------------------------------------------------------------ the recorder
export interface StreamerScanLike { start: number; ms: number; trigger: string; mutations: number; nodes_walked: number; text_nodes?: number; text_chars: number; ranges_after: number }
export interface StreamerStatsLike { on: boolean; pace_ms: number; scans: readonly StreamerScanLike[]; masks?: ReadonlyArray<{ start: number; ms: number }> }
export interface StallEnv {
  now: () => number
  wall: () => number
  send: (record: Any) => void
  doc: Any
  fetches: FlightTracker
  commits: CommitCounter
  streamer: () => StreamerStatsLike | null
  heapMb?: () => number | null
  highlightRanges?: () => number
}
const FIELDS = ['invoker', 'invokerType', 'sourceFunctionName', 'sourceURL', 'sourceCharPosition', 'duration', 'forcedStyleAndLayoutDuration'] as const

export class StallWatch {
  private events: Any[] = []
  private keys = new TimeRing(64)
  private selections = new TimeRing(64)
  private small = 0
  private readonly cap = new RateCap()
  constructor(private readonly env: StallEnv) {}

  noteKey(t: number): void { this.keys.push(t) }
  noteSelection(t: number): void { this.selections.push(t) }
  /** Event Timing entries (durationThreshold 16): a ring of the last 64 */
  onEvents(entries: Any[]): void { for (const e of entries) { this.events.push(e); if (this.events.length > 64) this.events.shift() } }

  /** one long-animation-frame entry; below 500 ms it is only counted */
  onLoaf(entry: Any): void {
    if (!(entry.duration >= STALL_MIN_MS)) { if (entry.duration >= 50) this.small++; return }
    const t0 = this.env.now()
    const start = Number(entry.startTime), end = start + Number(entry.duration)
    const all: Any[] = Array.isArray(entry.scripts) ? [...entry.scripts] : []
    // v2: offsets from the frame's start (startTime is a high-resolution time like every other entry field), so waiting
    // for a frame can be told apart from work; renderStart/styleAndLayoutStart are 0 when the frame had no rendering update
    const offset = (t: unknown) => typeof t === 'number' && t > 0 ? t - start : null
    const scripts = [...all]
      .sort((a: Any, b: Any) => (b.duration ?? 0) - (a.duration ?? 0)).slice(0, 10)
      .map((s: Any) => ({
        invoker: s[FIELDS[0]], invoker_type: s[FIELDS[1]], fn: s[FIELDS[2]], url: s[FIELDS[3]], pos: s[FIELDS[4]],
        ms: s[FIELDS[5]], forced_ms: s[FIELDS[6]], at: offset(s.startTime),
      }))
    const scriptsMs = all.reduce((a: number, s: Any) => a + (Number(s.duration) || 0), 0)
    const input = this.events.filter(e => e.startTime <= end && e.startTime + e.duration >= start).slice(0, 8).map(e => {
      const delay = Math.max(0, (e.processingStart ?? e.startTime) - e.startTime)
      const processing = Math.max(0, (e.processingEnd ?? e.processingStart ?? e.startTime) - (e.processingStart ?? e.startTime))
      return { type: e.name, interaction_id: e.interactionId, input_delay: delay, processing,
        presentation: Math.max(0, e.duration - delay - processing), target: stallTarget(e.target) }
    })
    const s = this.env.streamer()
    const inWin = (x: { start: number; ms: number }) => x.start <= end && x.start + x.ms >= start
    const scansIn = s ? s.scans.filter(inWin) : []
    const masksIn = s?.masks ? s.masks.filter(inWin) : []
    const recent = s ? s.scans.filter(x => x.start >= end - 10_000) : []
    const byTrigger: Record<string, number> = { mutation: 0, update: 0, prefs: 0, 'org-list': 0, other: 0 }
    for (const x of scansIn) byTrigger[byTrigger[x.trigger] === undefined ? 'other' : x.trigger]!++
    const ws = wsFrames.sum(start, end)
    const dom = domCensus(this.env.doc, 10, this.env.now)
    const record: Any = {
      at_ms: this.env.wall() - (this.env.now() - start), ms: entry.duration,
      loaf: { blocking: entry.blockingDuration, render_start: entry.renderStart, style_layout_start: entry.styleAndLayoutStart,
        render_at: offset(entry.renderStart), style_layout_at: offset(entry.styleAndLayoutStart), scripts_ms: scriptsMs, scripts_n: all.length, scripts },
      input, keys_2s: this.keys.count(start - 2000, start), field_len: focusedFieldLength(this.env.doc),
      fetch: this.env.fetches.open().filter(f => f.started <= end).map(f => ({ route: f.route, method: f.method, age_ms: Math.max(0, end - f.started) })),
      ws: { frames: ws.n, bytes: ws.size },
      react: { commits_in: this.env.commits.count(start, end), commits_2s: this.env.commits.count(start - 2000, start) },
      ctx: getStallContext(),
      selectionchange: { in: this.selections.count(start, end), before_2s: this.selections.count(start - 2000, start) },
      counts: {
        agents: read(getters.agents), projects: read(getters.projects), watchdogs: read(getters.watchdogs), open_panels: read(getters.open_panels),
        ...dom, heap_mb: this.env.heapMb?.() ?? null, highlight_ranges: this.env.highlightRanges?.() ?? 0,
        draft_saves_10s: draftSaves.count(end - 10_000, end),
      },
      streamer: s ? {
        on: s.on, pace_ms: s.pace_ms, scans_in: scansIn.length, scan_ms_in: scansIn.reduce((a, x) => a + x.ms, 0),
        max_scan_ms_in: scansIn.reduce((a, x) => Math.max(a, x.ms), 0), scans_in_by_trigger: byTrigger,
        scans_10s: recent.length, max_scan_ms_10s: recent.reduce((a, x) => Math.max(a, x.ms), 0),
        masks_in: masksIn.length, mask_ms_in: masksIn.reduce((a, x) => a + x.ms, 0),
        scans: scansIn.slice(-32).map(x => ({ ...x, start: x.start - start })),
      } : { on: false },
      loaf_50_500: this.small,
    }
    this.small = 0
    record.capture_ms = this.env.now() - t0
    const gate = this.cap.take(this.env.now())
    if (!gate.ok) return
    record.dropped = gate.dropped
    try { this.env.send(record) } catch { /* diagnostics never break the page */ }
  }
}

// ------------------------------------------------------------------ install (real observers)
let installed: StallWatch | null = null
/** Idle unless the desktop bridge can take the record and the main process did not switch the tooling off. */
export function installStallWatch(win: Any = window as Any): StallWatch | null {
  if (installed) return installed
  const bridge = win[DESKTOP_KEY]
  if (!bridge || typeof bridge.diagStall !== 'function' || bridge.stallwatch === false) return null
  const supported: string[] = (win.PerformanceObserver?.supportedEntryTypes ?? []) as string[]
  if (!supported.includes('long-animation-frame')) return null
  const doc = win.document
  const fetches = wrapFetch(win)
  const watch = new StallWatch({
    now: () => win.performance.now(), wall: () => Date.now(), send: r => bridge.diagStall(r), doc, fetches,
    commits: installReactHook(win), streamer: readStreamerStats,
    heapMb: () => { const m = win.performance?.memory?.usedJSHeapSize; return typeof m === 'number' ? Math.round(m / 1048576) : null },
    highlightRanges: () => { let n = 0; try { win.CSS?.highlights?.forEach((h: { size: number }) => { n += h.size }) } catch { /* none */ } return n },
  })
  try {
    new win.PerformanceObserver((list: Any) => { for (const e of list.getEntries()) watch.onLoaf(e) }).observe({ type: 'long-animation-frame', buffered: false })
  } catch { return null }
  if (supported.includes('event')) {
    try { new win.PerformanceObserver((list: Any) => watch.onEvents(list.getEntries())).observe({ type: 'event', durationThreshold: 16, buffered: false }) } catch { /* optional */ }
  }
  // key and selection COUNTS only: the handler reads neither the key nor the selection
  doc.addEventListener('keydown', () => watch.noteKey(win.performance.now()), { capture: true, passive: true })
  doc.addEventListener('selectionchange', () => watch.noteSelection(win.performance.now()), { passive: true })
  installed = watch
  return watch
}
