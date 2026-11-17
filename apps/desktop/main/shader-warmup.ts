// shader-warmup.ts - 4.6.1: compile the desk/node GPU shaders once, before the user's first desk switch.
//
// WHY. Electron 44.11.3 keeps Skia's compiled shaders in <userData>/GrShaderCache, but the cache
// starts cold after an install, an Electron update or a GPU driver update (Chromium checks it
// against both). On a cold cache, the first time each desk/node effect is drawn its shaders are
// compiled on the GPU process's main thread, and the frame waits 0.5 to 3 s. Measured on
// 4.6.1-alpha.2 (2026-11-16 15:52-15:58Z): every stall of 500 ms or more lined up with a new
// GrShaderCache entry. Item hang-every-time-a-new-desk-loads-especially-whil, option B
// (USER 2026-11-16 20:03:34Z m67c841ee83a3 "Add a warm-up").
//
// WHAT. Once after launch, while the user is idle, an OFFSCREEN-RENDERED window (never shown:
// no screen, no taskbar, no Alt-Tab, no focus) draws a synthetic org (renderer/shader-warmup.html,
// no user data, no engine, no network) through the real canvas, nodes and desks, on the GPU.
// The compiled shaders land in the same cache the org windows then read. The window is
// destroyed when the scene says done, or at the deadline, whichever comes first.
//
// EVERY LAUNCH (4.6.2). A warm disk cache is not enough: on the user's 4.6.2-alpha.1 (trace of
// 2026-11-17 18:53Z) every program was a GrShaderCache HIT (44 loads, no store) and each first use
// in the new app run still blocked the GPU main thread 0.5-1 s. So it runs on every launch and no
// longer skips on a marker. Programs live in the GPU process, so the warm-up's window warms them for
// the org windows too.
//
// IDLE, CAPPED. After the launch settle it waits for the user to be idle, but at most idleWaitMs
// (30 s): the user of 4.6.2-alpha.1 stayed busy, the warm-up waited 5.5 min, and the canvas stalled
// 16 times meanwhile. A run at the cap moves those hitches into the first minute after launch.
//
// DEADLINE. 45 s, not 8: on the user's GPU each compile takes 200-850 ms and 4.6.1-alpha.3's
// warm-up was cut off at 8 s. The scene itself moves on only once frames are quick again.
//
// MAIN THREAD. Everything here is async and event driven: one timer per idle check, no
// synchronous work on a timer beyond reading the system idle time.

import path from 'node:path'

export const WARMUP_PATH = '/shader-warmup.html'
export const WARMUP_DONE_TITLE = 'orgtree-shader-warmup:done'

export const WARMUP_ORIGIN = 'https://orgtree-shader-warmup.invalid'
export const WARMUP_TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.json': 'application/json' }

/** The UI file a warm-up request names, or null: only plain paths inside the UI folder. */
export function warmupFile(uiDirectory: string, url: string): string | null {
  let u: URL
  try { u = new URL(url) } catch { return null }
  if (u.origin !== WARMUP_ORIGIN) return null
  const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '')
  if (!rel || rel.includes('\0')) return null
  const root = path.resolve(uiDirectory), file = path.resolve(root, rel)
  return file.startsWith(root + path.sep) && WARMUP_TYPES[path.extname(file).toLowerCase()] ? file : null
}

/** What the window is created with: the only options the warm-up ever uses. */
export const WARMUP_WINDOW_OPTIONS = {
  width: 1400, height: 900, show: false, paintWhenInitiallyHidden: true,
  skipTaskbar: true, focusable: false, frame: false, transparent: false,
  webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false,
    webviewTag: false, backgroundThrottling: false, spellcheck: false },
} as const

export type WarmupWindow = {
  loadURL(url: string): Promise<void>
  onTitle(fn: (title: string) => void): void
  onGone(fn: () => void): void
  destroy(): void
  isDestroyed(): boolean
}

export type WarmupDeps = {
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
  /** seconds since the user's last input, system-wide (powerMonitor.getSystemIdleTime) */
  idleSeconds(): number
  /** the GPU rasters (feature status). Read after gpuReady, never at app ready: Chromium reports
   *  every feature as software until its GPU process has started (measured 2026-11-16) */
  gpuRasters(): boolean
  /** resolves once the GPU process is up (reading the GPU info waits for it) */
  gpuReady(): Promise<void>
  /** the GrShaderCache folder's creation time (ms) and size in bytes, or null when there is none */
  cacheInfo(): Promise<{ birth: number; bytes: number } | null>
  /** a never-shown offscreen window on its own in-memory session that serves only the UI files */
  createWindow(): WarmupWindow
  url: string
  log(line: Record<string, unknown>): void
}

export type WarmupOptions = {
  /** wait this long after start() before the skip check and the first idle check */
  delayMs: number
  /** the user counts as idle after this many seconds without input */
  idleS: number
  /** time between idle checks */
  retryMs: number
  /** after the delay, wait at most this long for the user to be idle, then run anyway */
  idleWaitMs: number
  /** the window is destroyed this long after it was created, done or not */
  deadlineMs: number
}

export const WARMUP_DEFAULTS: WarmupOptions = { delayMs: 15_000, idleS: 5, retryMs: 5_000, idleWaitMs: 30_000, deadlineMs: 45_000 }

export type WarmupOutcome = 'skipped-no-gpu' | 'done' | 'deadline' | 'failed' | 'stopped'

export class ShaderWarmup {
  private timer: unknown = null
  private window: WarmupWindow | null = null
  private started = 0
  private stopped = false
  private settled = false
  private resolve!: (o: WarmupOutcome) => void
  readonly outcome: Promise<WarmupOutcome> = new Promise(r => { this.resolve = r })

  constructor(private deps: WarmupDeps, private opts: WarmupOptions = WARMUP_DEFAULTS) {}

  start(): Promise<WarmupOutcome> {
    this.started = this.deps.now()
    // everything waits for the launch to settle first, the GPU check included (its log line needs the data folder)
    this.timer = this.deps.setTimeout(() => { this.timer = null; void this.decide() }, this.opts.delayMs)
    return this.outcome
  }

  /** app quit / data move: tear down at once, never write the marker */
  stop(): void {
    this.stopped = true
    if (this.timer !== null) { this.deps.clearTimeout(this.timer); this.timer = null }
    this.close()
    this.finish('stopped')
  }

  /** what the start saw of the cache folder; every line carries it (null: no folder) */
  private cache: { birth: number; bytes: number } | null | undefined = undefined

  private finish(o: WarmupOutcome, extra: Record<string, unknown> = {}): void {
    if (this.settled) return
    this.settled = true
    this.deps.log({ outcome: o, ms: this.deps.now() - this.started, ...this.cacheFields(), ...extra })
    this.resolve(o)
  }

  private cacheFields(): Record<string, unknown> {
    return this.cache === undefined ? {} : this.cache === null ? { cache_birth: null, cache_bytes: null }
      : { cache_birth: new Date(this.cache.birth).toISOString(), cache_bytes: this.cache.bytes }
  }

  private close(): void {
    const w = this.window
    this.window = null
    if (w && !w.isDestroyed()) { try { w.destroy() } catch { /* already gone */ } }
  }

  private async decide(): Promise<void> {
    try {
      // the GPU process first: once it is up, the feature status is real
      await this.deps.gpuReady()
      // GPU only (USER 2026-11-16 09:43:35Z: no CPU raster): with software raster there is nothing to warm
      if (!this.deps.gpuRasters()) return this.finish('skipped-no-gpu')
      this.cache = await this.deps.cacheInfo()
    } catch (e) { return this.finish('failed', { error: String(e) }) }
    if (this.stopped) return
    this.whenIdle(this.deps.now() + this.opts.idleWaitMs)
  }

  /** run once the user is idle, or at the cap regardless */
  private whenIdle(cap: number): void {
    this.timer = null
    if (this.stopped) return
    if (this.deps.idleSeconds() >= this.opts.idleS) return void this.run(true)
    const left = cap - this.deps.now()
    if (left <= 0) return void this.run(false)
    this.timer = this.deps.setTimeout(() => this.whenIdle(cap), Math.min(this.opts.retryMs, left))
  }

  private async run(idle: boolean): Promise<void> {
    let w: WarmupWindow
    try { w = this.window = this.deps.createWindow() } catch (e) { return this.finish('failed', { error: String(e) }) }
    // a line when every run starts: a visible window's stalls while it runs are its own
    this.deps.log({ outcome: 'started', idle, ms: this.deps.now() - this.started, ...this.cacheFields() })
    const t0 = this.deps.now()
    let ended = false
    const end = (o: WarmupOutcome, extra: Record<string, unknown> = {}) => {
      // the first end wins: destroying the window below fires its own 'closed'
      if (ended || this.settled || this.stopped) return
      ended = true
      if (this.timer !== null) { this.deps.clearTimeout(this.timer); this.timer = null }
      this.close()
      const done = () => this.finish(o, { window_ms: this.deps.now() - t0, ...extra })
      if (o !== 'done') return done()
      // the folder it warmed: a new run's cache may only appear during the scene, so read it again now
      void this.deps.cacheInfo().catch(() => null).then(cache => { this.cache = cache }).then(done)
    }
    w.onTitle(title => { if (title === WARMUP_DONE_TITLE) end('done') })
    w.onGone(() => end('failed', { error: 'window gone' }))
    this.timer = this.deps.setTimeout(() => end('deadline'), this.opts.deadlineMs)
    try { await w.loadURL(this.deps.url) } catch (e) { end('failed', { error: String(e) }) }
  }
}
