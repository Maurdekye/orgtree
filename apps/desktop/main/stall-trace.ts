// main/stall-trace.ts: a short Chromium trace around a frame that WAITED.
//
// Item hang-every-time-a-new-desk-loads-especially-whil (4.6.1). The user's
// stall records were long-animation frames with almost no script and no
// blocking task, in both org windows at once, with the GPU process busy: the
// frame waited on delivery (GPU, compositor, display), which no renderer probe
// sees and Session 0 cannot reproduce (its GPU process exits). So the app
// traces itself: the first such frame ARMS a capture of the GPU/compositor
// categories, and the next one lands inside it.
//
// Bounded by construction: one capture per 10 minutes and three per run, 20 s
// at most (or 3 s after the stall it was waiting for), three files kept.
// Private by construction: the categories carry no page content, and every
// event is rewritten through an allowlist before it reaches the disk (the
// raw recording is deleted). Never throws: diagnostics never break the app.
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import zlib from 'node:zlib'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'

export const TRACE_DIR = path.join('diagnostics', 'stall-traces')
/** what is traced: frame production and delivery, nothing that names page content */
export const TRACE_CATEGORIES = ['gpu', 'cc', 'viz', 'benchmark', 'toplevel', 'disabled-by-default-gpu.service', 'disabled-by-default-viz.gpu_composite_time']
export const ARM_MIN_MS = 500
export const ARM_MAX_BLOCKING_MS = 50
export const ARM_MAX_SCRIPT_SHARE = 0.2
export const CAPTURE_MAX_MS = 20_000
export const AFTER_CAUGHT_MS = 3000
export const CAPTURE_EVERY_MS = 10 * 60_000
export const CAPTURES_PER_RUN = 3
export const TRACES_KEPT = 3

type Rec = Record<string, unknown>
const rec = (v: unknown): Rec => v && typeof v === 'object' && !Array.isArray(v) ? v as Rec : {}
const num = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) ? v : null

/** a long-animation frame of 500 ms or more in which the renderer's main thread was mostly free */
export function waitingFrame(src: string, record: unknown): boolean {
  if (src !== 'renderer-loaf') return false
  const r = rec(record), l = rec(r.loaf)
  const ms = num(r.ms), blocking = num(l.blocking), scripts = num(l.scripts_ms) ?? 0
  if (ms === null || blocking === null || ms < ARM_MIN_MS) return false
  return blocking < ARM_MAX_BLOCKING_MS && scripts < ARM_MAX_SCRIPT_SHARE * ms
}

const ALLOWED_CATS = new Set(TRACE_CATEGORIES)
const ARG_KEYS = new Set(['frame', 'frame_number', 'sequence_number', 'source_id', 'size', 'count', 'step', 'state', 'priority', 'begin_frame_id', 'sequence', 'num_frames', 'deadline'])
const IDENT = /^[A-Za-z0-9_:.()<>\- ]{1,96}$/
const FREEISH = /[/\\]|\s{2}|[,;!?]|\b(?:https?|file):/i
const safeName = (v: unknown): string => typeof v === 'string' && IDENT.test(v) && !FREEISH.test(v) ? v : 'other'

/** One line of Chromium's trace JSON (one event per line, trailing comma) rewritten through the
 *  allowlist, or null to drop it. Metadata events keep only process/thread names. */
export function filterTraceLine(line: string): string | null {
  const t = line.trim().replace(/,$/, '')
  if (!t.startsWith('{') || !t.endsWith('}')) return null
  let e: Rec
  try { e = rec(JSON.parse(t)) } catch { return null }
  const ph = typeof e.ph === 'string' ? e.ph : ''
  if (!ph || ph.length > 2) return null
  const out: Rec = {}
  for (const k of ['pid', 'tid', 'ts', 'dur', 'tdur', 'tts', 'id', 's']) {
    const v = e[k]
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v
    else if (k === 'id' && typeof v === 'string' && /^(?:0x)?[0-9a-f]{1,32}$/i.test(v)) out[k] = v
    else if (k === 's' && (v === 'g' || v === 'p' || v === 't')) out[k] = v
  }
  out.ph = ph
  if (ph === 'M') {
    if (e.name !== 'process_name' && e.name !== 'thread_name' && e.name !== 'thread_sort_index' && e.name !== 'process_sort_index') return null
    out.name = e.name
    const a = rec(e.args)
    out.args = typeof a.name === 'string' ? { name: safeName(a.name) } : typeof a.sort_index === 'number' ? { sort_index: a.sort_index } : {}
    return JSON.stringify(out)
  }
  const cats = typeof e.cat === 'string' ? e.cat.split(',') : []
  if (!cats.length || !cats.every(c => ALLOWED_CATS.has(c))) return null
  out.cat = e.cat
  out.name = safeName(e.name)
  const args: Rec = {}
  for (const [k, v] of Object.entries(rec(e.args))) {
    if (ARG_KEYS.has(k) && (typeof v === 'number' || typeof v === 'boolean')) args[k] = v
  }
  out.args = args
  return JSON.stringify(out)
}

/** keep the newest `keep` *.json.gz files in `dir` (by modification time) */
export function pruneTraces(dir: string, keep = TRACES_KEPT): void {
  try {
    const files = fs.readdirSync(dir).filter(f => /^[0-9TZ-]+\.json\.gz$/.test(f))
      .map(f => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t)
    for (const { f } of files.slice(keep)) fs.rmSync(path.join(dir, f), { force: true })
  } catch { /* best effort */ }
}

export interface TraceMeta {
  v: 1
  app: string
  armed_by: { ms: number | null; blocking: number | null; scripts_ms: number | null; window: string | null }
  caught: { ms: number | null; blocking: number | null; scripts_ms: number | null; window: string | null } | null
  canvas_bg: { theme: string; webgl?: boolean } | null
}

/** Stream the raw recording through the filter into `out` (gzip JSON), then delete the raw file.
 *  Line by line and asynchronous, so main is never held by one large parse. */
export async function processTrace(raw: string, out: string, meta: TraceMeta): Promise<{ events: number; bytes: number }> {
  fs.mkdirSync(path.dirname(out), { recursive: true })
  let events = 0
  const lines = readline.createInterface({ input: fs.createReadStream(raw, { encoding: 'utf8' }), crlfDelay: Infinity })
  async function* body() {
    yield `{"meta":${JSON.stringify(meta)},"traceEvents":[`
    let first = true
    for await (const line of lines) {
      const kept = filterTraceLine(line)
      if (kept === null) continue
      events++
      yield (first ? '\n' : ',\n') + kept
      first = false
    }
    yield '\n]}\n'
  }
  try {
    await pipeline(Readable.from(body()), zlib.createGzip({ level: 6 }), fs.createWriteStream(out))
  } finally {
    try { fs.rmSync(raw, { force: true }) } catch { /* best effort */ }
  }
  return { events, bytes: fs.statSync(out).size }
}

export interface StallTracerDeps {
  now(): number
  setTimeout(fn: () => void | Promise<void>, ms: number): unknown
  clearTimeout(handle: unknown): void
  /** the stall-traces directory under the data root, or undefined (no data root, a data move in flight) */
  dir(): string | undefined
  tracing: { start(categories: string[]): Promise<void>; stop(file: string): Promise<string> }
  process(raw: string, out: string, meta: TraceMeta): Promise<{ events: number; bytes: number }>
  log(line: Rec): void
  app(): string
}

const frameOf = (record: unknown, window: string | null) => {
  const r = rec(record), l = rec(r.loaf)
  return { ms: num(r.ms), blocking: num(l.blocking), scripts_ms: num(l.scripts_ms), window }
}
const bgOf = (record: unknown): TraceMeta['canvas_bg'] => {
  const b = rec(rec(record).canvas_bg)
  return typeof b.theme === 'string' ? { theme: b.theme, ...(typeof b.webgl === 'boolean' ? { webgl: b.webgl } : {}) } : null
}
const stamp = (ms: number) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z').replace(/:/g, '-')

export class StallTracer {
  private capture: { dir: string; started: number; stopTimer: unknown; meta: TraceMeta; stopping: boolean } | null = null
  private lastStart = -Infinity
  private runs = 0
  constructor(private readonly d: StallTracerDeps) {}

  /** every stall record main writes passes here; only waiting frames matter */
  async onStall(src: string, record: unknown, window: string | null = null): Promise<void> {
    try {
      if (!waitingFrame(src, record)) return
      const now = this.d.now()
      const c = this.capture
      if (c) {
        if (!c.meta.caught && !c.stopping) {
          c.meta.caught = frameOf(record, window)
          c.meta.canvas_bg ??= bgOf(record)
          this.d.clearTimeout(c.stopTimer)
          c.stopTimer = this.d.setTimeout(() => this.stop(), AFTER_CAUGHT_MS)
        }
        return
      }
      if (this.runs >= CAPTURES_PER_RUN || now - this.lastStart < CAPTURE_EVERY_MS) return
      const dir = this.d.dir()
      if (!dir) return
      this.lastStart = now
      this.runs++
      await this.d.tracing.start([...TRACE_CATEGORIES])
      const meta: TraceMeta = { v: 1, app: this.d.app(), armed_by: frameOf(record, window), caught: null, canvas_bg: bgOf(record) }
      this.capture = { dir, started: now, meta, stopping: false, stopTimer: this.d.setTimeout(() => this.stop(), CAPTURE_MAX_MS) }
    } catch { this.capture = null }
  }

  private async stop(): Promise<void> {
    const c = this.capture
    if (!c || c.stopping) return
    c.stopping = true
    try {
      const name = `${stamp(c.started)}.json.gz`
      const raw = await this.d.tracing.stop(path.join(c.dir, `.raw-${stamp(c.started)}.json`))
      const ms = this.d.now() - c.started
      const { events, bytes } = await this.d.process(raw, path.join(c.dir, name), c.meta)
      pruneTraces(c.dir)
      this.d.log({ ms, file: name, events, bytes, caught: c.meta.caught !== null, canvas_bg: c.meta.canvas_bg })
    } catch { /* best effort */ } finally { this.capture = null }
  }
}
