/** UI STALL LOG: <data root>/diagnostics/ui-stalls.jsonl, written ONLY here (spec ui-stall-tooling-spec rev 1.2 section 2-3).
 *  One JSON line per stall (`v:1`), rotated to .1/.2 past 2 MB, a line is at most 16 KB, at most 30 lines a minute.
 *  Everything that arrives is passed through an ALLOWLIST first: unknown keys are dropped, enum fields outside their
 *  enum become `other`, URLs and paths are shortened, and every other free string goes through the streamer detector
 *  (packages/contracts/streamer.ts) with ALL types on, whatever the user's switches say: the file outlives the screen.
 *  Pure apart from the filesystem (no electron import); tests/stall-log.test.mjs drives it. Best effort: never throws. */
import fs from 'node:fs'
import path from 'node:path'
import { STREAMER_TYPE_LIST, sensitiveSpans } from '../../../packages/contracts/streamer'
import type { StreamerType, StreamerTypes } from '../../../packages/contracts/streamer'
import { RateCap, STALL_PANELS, STALL_SCREENS, STALL_SRCS } from '../../../packages/contracts/stall'
import type { StallSrc } from '../../../packages/contracts/stall'

export const STALL_LOG = path.join('diagnostics', 'ui-stalls.jsonl')
export const STALL_MAX_BYTES = 2 * 1024 * 1024
export const STALL_LINE_MAX = 16 * 1024
const STACK_FRAMES = 40, FRAME_CHARS = 200

/** the redaction of one free string: every sensitive span becomes <redacted:kind> */
export function redactFree(text: string): string {
  const spans: Array<{ start: number; end: number; kind: StreamerType }> = []
  for (const kind of STREAMER_TYPE_LIST) {
    if (kind === 'orgs') continue   // no org list here: org names are never recorded at all
    const only = Object.fromEntries(STREAMER_TYPE_LIST.map(t => [t, t === kind])) as StreamerTypes
    for (const s of sensitiveSpans(text, only)) spans.push({ ...s, kind })
  }
  spans.sort((a, b) => a.start - b.start || b.end - a.end)
  let out = '', at = 0
  for (const s of spans) {
    if (s.start < at) continue
    out += text.slice(at, s.start) + `<redacted:${s.kind}>`
    at = s.end
  }
  return out + text.slice(at)
}

/** a script path: the app's own origin or install folder becomes `app:/`, no query or fragment, no other absolute path */
export function redactUrl(url: unknown): string {
  if (typeof url !== 'string' || !url) return ''
  let u = url.replace(/[?#].*$/, '')
  u = u.replace(/^https?:\/\/[^/]+\//i, 'app:/')
  u = u.replace(/^file:\/\/\/?.*?\/(?:resources\/)?app(?:\.asar)?\//i, 'app:/')
  u = u.replace(/^file:\/\/\/?/i, '')
  return redactFree(u).slice(0, 160)
}

const COLLECTIONS = new Set(['agents', 'projects', 'mail', 'work', 'watchdogs', 'files', 'apps'])
/** an engine route: the org slug and every id after a known collection are placeholders; no query */
export function redactRoute(route: unknown): string {
  if (typeof route !== 'string') return ''
  const r = route.replace(/^https?:\/\/[^/]+/i, '').replace(/[?#].*$/, '')
  const parts = r.split('/')
  const out: string[] = []
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!
    if (i >= 1 && out[out.length - 1] === 'orgs' && p) { out.push('<org>'); continue }
    if (i >= 1 && COLLECTIONS.has(parts[i - 1]!) && p) { out.push('<id>'); continue }
    out.push(p === '' || /^[a-z][a-z0-9_.-]{0,31}$/.test(p) ? p : '<id>')
  }
  return out.join('/').slice(0, 120)
}

const num = (v: unknown, max = 1e12): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? Math.round(Math.min(max, Math.max(-max, v)) * 10) / 10 : undefined
const int = (v: unknown): number | undefined => { const n = num(v); return n === undefined ? undefined : Math.round(n) }
const str = (v: unknown, max = 120): string | undefined => typeof v === 'string' ? redactFree(v).slice(0, max) : undefined
const oneOf = (v: unknown, list: readonly string[], fallback = 'other'): string =>
  typeof v === 'string' && list.includes(v) ? v : fallback
const bool = (v: unknown): boolean | undefined => typeof v === 'boolean' ? v : undefined
const arr = (v: unknown, max: number): unknown[] => Array.isArray(v) ? v.slice(0, max) : []
const rec = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
const compact = <T extends Record<string, unknown>>(o: T): T => {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k]
  return o
}
const EVENT_TYPES = ['keydown', 'keyup', 'keypress', 'input', 'beforeinput', 'pointerdown', 'pointerup', 'pointermove', 'mousedown', 'mouseup',
  'click', 'dblclick', 'compositionstart', 'compositionupdate', 'compositionend', 'contextmenu', 'dragstart', 'dragend', 'drop', 'wheel', 'focusin', 'focusout']
const TRIGGERS = ['mutation', 'update', 'prefs', 'org-list', 'other']
const TARGET = /^[a-z0-9-]{1,32}(?:\[[a-z-]{1,20}\])?$/
/** window ids are the app's own UUIDs (window-events.jsonl): kept as they are, anything else is dropped (v1 read them as secrets) */
const WINDOW_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** Electron's child-process types plus the renderer; the reasons of child-process-gone / render-process-gone */
const GONE_KINDS = ['renderer', 'GPU', 'Utility', 'Zygote', 'Sandbox helper', 'Pepper Plugin', 'Pepper Plugin Broker', 'Unknown']
const GONE_REASONS = ['clean-exit', 'abnormal-exit', 'killed', 'crashed', 'oom', 'launch-failed', 'integrity-failure', 'memory-eviction']
const nullable = (v: unknown): number | null | undefined => v === null ? null : num(v)
/** v2: the GPU process's CPU over the sample window around the stall (main/stall-probe.ts GpuSampler); numbers only */
const gpu = (v: unknown) => { if (v === undefined) return undefined; const g = rec(v)
  return compact({ cpu_pct: nullable(g.cpu_pct), window_ms: num(g.window_ms), restarted: bool(g.restarted), ws_mb: nullable(g.ws_mb) }) }

/** one stack frame "fn (url:line:col)": every url inside shortened, then the whole frame detector-redacted */
function redactFrame(f: string): string {
  const shortened = f.replace(/((?:https?|file):\/\/[^\s)]+)/gi, m => redactUrl(m))
  return redactFree(shortened).slice(0, FRAME_CHARS)
}
/** a stack: `unavailable:<reason>` stays a short string; a text or array of frames becomes redacted frames */
function stack(v: unknown): string | string[] | undefined {
  if (typeof v === 'string' && !v.includes('\n') && v.startsWith('unavailable:')) return redactFree(v).slice(0, FRAME_CHARS)
  const frames = typeof v === 'string' ? v.split(/\r?\n/) : Array.isArray(v) ? v.map(String) : null
  return frames ? frames.filter(Boolean).slice(0, 200).map(redactFrame) : undefined
}
const context = (v: unknown) => {
  const c = rec(v)
  return { screen: oneOf(c.screen, STALL_SCREENS), panel: oneOf(c.panel, STALL_PANELS),
    popout: c.popout === null || c.popout === undefined ? null : oneOf(c.popout, STALL_PANELS) }
}

/** The allowlisted body of one record, per source. Anything not listed here never reaches the file. */
function body(src: StallSrc, r: Record<string, unknown>): Record<string, unknown> {
  const ipc = () => arr(r.ipc, 32).map(x => { const i = rec(x); return compact({ channel: str(i.channel, 80), age_ms: num(i.age_ms) }) })
  if (src === 'renderer-loaf') {
    const l = rec(r.loaf), w = rec(r.ws), re = rec(r.react), c = rec(r.counts), s = rec(r.streamer), sel = rec(r.selectionchange)
    return compact({
      loaf: compact({
        blocking: num(l.blocking), render_start: num(l.render_start), style_layout_start: num(l.style_layout_start),
        render_at: nullable(l.render_at), style_layout_at: nullable(l.style_layout_at), scripts_ms: num(l.scripts_ms), scripts_n: int(l.scripts_n),
        scripts: arr(l.scripts, 10).map(x => { const sc = rec(x); return compact({
          invoker: str(sc.invoker, 80), invoker_type: str(sc.invoker_type, 40), fn: str(sc.fn, 80), url: redactUrl(sc.url),
          pos: int(sc.pos), ms: num(sc.ms), forced_ms: num(sc.forced_ms), at: nullable(sc.at) }) }),
      }),
      input: arr(r.input, 8).map(x => { const i = rec(x); return compact({
        type: oneOf(i.type, EVENT_TYPES), interaction_id: int(i.interaction_id), input_delay: num(i.input_delay),
        processing: num(i.processing), presentation: num(i.presentation),
        target: typeof i.target === 'string' && TARGET.test(i.target) ? i.target : 'other' }) }),
      keys_2s: int(r.keys_2s), field_len: int(r.field_len),
      fetch: arr(r.fetch, 32).map(x => { const f = rec(x); return compact({
        route: redactRoute(f.route), method: oneOf(f.method, ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']), age_ms: num(f.age_ms) }) }),
      ws: compact({ frames: int(w.frames), bytes: int(w.bytes) }),
      react: compact({ commits_in: int(re.commits_in), commits_2s: int(re.commits_2s) }),
      ctx: context(r.ctx),
      counts: compact({ agents: int(c.agents) ?? null, projects: int(c.projects) ?? null, watchdogs: int(c.watchdogs) ?? null,
        open_panels: int(c.open_panels) ?? null, dom_nodes: int(c.dom_nodes), text_nodes: int(c.text_nodes), max_depth: int(c.max_depth),
        dom_partial: bool(c.dom_partial), heap_mb: num(c.heap_mb), highlight_ranges: int(c.highlight_ranges),
        draft_saves_10s: int(c.draft_saves_10s) }),
      selectionchange: compact({ in: int(sel.in), before_2s: int(sel.before_2s) }),
      streamer: compact({ on: bool(s.on), scans_in: int(s.scans_in), scan_ms_in: num(s.scan_ms_in), scans_10s: int(s.scans_10s),
        max_scan_ms_10s: num(s.max_scan_ms_10s), max_scan_ms_in: num(s.max_scan_ms_in), pace_ms: num(s.pace_ms),
        masks_in: int(s.masks_in), mask_ms_in: num(s.mask_ms_in),
        scans_in_by_trigger: Object.fromEntries(TRIGGERS.map(t => [t, int(rec(s.scans_in_by_trigger)[t]) ?? 0])),
        scans: arr(s.scans, 32).map(x => { const k = rec(x); return compact({ start: num(k.start), ms: num(k.ms),
          trigger: oneOf(k.trigger, TRIGGERS), mutations: int(k.mutations), nodes_walked: int(k.nodes_walked), text_nodes: int(k.text_nodes),
          text_chars: int(k.text_chars), ranges_after: int(k.ranges_after) }) }) }),
      loaf_50_500: int(r.loaf_50_500), capture_ms: num(r.capture_ms), gpu: gpu(r.gpu),
    })
  }
  if (src === 'renderer-ping' || src === 'renderer-unresponsive') {
    return compact({ blocked_ms: num(r.blocked_ms), stacks: arr(r.stacks, 2).map(stack), ipc: ipc(), ctx: r.ctx === undefined ? undefined : context(r.ctx), gpu: gpu(r.gpu) })
  }
  if (src === 'main-lag') return compact({ lag_ms: num(r.lag_ms), ipc: ipc(), main_stack: stack(r.main_stack), gpu: gpu(r.gpu) })
  if (src === 'process-gone') return compact({ kind: oneOf(r.kind, GONE_KINDS), reason: oneOf(r.reason, GONE_REASONS), exit_code: int(r.exit_code) })
  if (src === 'attract') {
    // the attract trace (renderer/src/attract/trace.ts): enums and numbers only. No id, title or text field exists here, whatever arrives.
    return compact({ ev: oneOf(r.ev, ['step', 'panel', 'release', 'stop', 'skip']), kind: r.kind === undefined ? undefined : oneOf(r.kind, ['org', 'agent', 'mail', 'doc', 'ticket', 'attention']),
      need_ms: num(r.need_ms), dwell_ms: num(r.dwell_ms), n: int(r.n), docket_pct: num(r.docket_pct, 100), action: r.action === undefined ? undefined : oneOf(r.action, ['open', 'close']),
      panel: r.panel === undefined ? undefined : oneOf(r.panel, ['inbox', 'docket']), owned: bool(r.owned),
      why: r.why === undefined ? undefined : oneOf(r.why, ['canvas', 'share']) })
  }
  return compact({ channel: str(r.channel, 80) })   // sync-ipc
}

/** shrink one over-long line: stacks first (40 frames of 200 characters), then scripts, then whole arrays */
function shrink(line: Record<string, unknown>, max: number): Record<string, unknown> {
  const size = () => Buffer.byteLength(JSON.stringify(line))
  if (size() <= max) return line
  line.truncated = true
  const cut = (s: unknown): unknown => Array.isArray(s) ? s.slice(0, STACK_FRAMES).map(f => String(f).slice(0, FRAME_CHARS)) : s
  if (line.stacks) line.stacks = (line.stacks as unknown[]).map(cut)
  if (line.main_stack) line.main_stack = cut(line.main_stack)
  if (size() <= max) return line
  for (const keep of [3, 0]) {
    const loaf = line.loaf as { scripts?: unknown[] } | undefined
    if (loaf?.scripts) loaf.scripts = loaf.scripts.slice(0, keep)
    if (size() <= max) return line
  }
  for (const k of ['stacks', 'main_stack', 'streamer', 'fetch', 'input', 'ipc']) {
    if (line[k] !== undefined) { delete line[k]; if (size() <= max) return line }
  }
  return line
}

export interface StallLogOptions {
  file: () => string | undefined
  clock?: () => Date
  /** version and short commit, for every line */
  app?: () => string
  maxBytes?: number
  lineMax?: number
}

export class StallLog {
  private readonly cap = new RateCap()
  constructor(private readonly o: StallLogOptions) {}

  /** `window`: the window-events id of the window the stall belongs to (null for main-only stalls) */
  write(src: StallSrc, record: unknown, window: { id?: string; org?: boolean } | null = null): void {
    try {
      if (!(STALL_SRCS as readonly string[]).includes(src)) return
      const file = this.o.file()
      if (!file) return
      const clock = this.o.clock ?? (() => new Date())
      const r = rec(record)
      const gate = this.cap.take(clock().getTime())
      if (!gate.ok) return
      const atMs = typeof r.at_ms === 'number' && Number.isFinite(r.at_ms) ? r.at_ms : undefined   // epoch ms: beyond num()'s cap
      const line = shrink({
        v: 1,
        at: new Date(atMs ?? clock().getTime()).toISOString(), src, ms: num(r.ms ?? r.lag_ms ?? r.blocked_ms),
        window: typeof window?.id === 'string' && WINDOW_ID.test(window.id) ? window.id : undefined, org_window: window?.org === true,
        app: str(this.o.app?.() ?? '', 60) || undefined,
        dropped: (int(r.dropped) ?? 0) + gate.dropped, truncated: false,
        ...body(src, r),
      }, this.o.lineMax ?? STALL_LINE_MAX)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      let size = 0
      try { size = fs.statSync(file).size } catch { /* not there yet */ }
      if (size > (this.o.maxBytes ?? STALL_MAX_BYTES)) {
        try { fs.rmSync(file + '.2', { force: true }) } catch { /* best effort */ }
        try { fs.renameSync(file + '.1', file + '.2') } catch { /* no .1 yet */ }
        fs.renameSync(file, file + '.1')
      }
      fs.appendFileSync(file, JSON.stringify(line) + '\n')
    } catch { /* diagnostics never break the app they describe */ }
  }
}
