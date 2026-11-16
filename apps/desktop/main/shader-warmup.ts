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
// SKIP. A marker in userData records the key it ran for (app version, Chromium version, GPU
// vendor/device/driver). Same key and GrShaderCache still there: nothing runs.
//
// MAIN THREAD. Everything here is async and event driven: one timer per idle check, no
// synchronous work on a timer beyond reading the system idle time.

import path from 'node:path'

export const WARMUP_MARKER = 'shader-warmup.json'
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

export type WarmupKeyParts = { app: string; chrome: string; vendor?: number; device?: number; driver?: string }
export const warmupKey = (k: WarmupKeyParts): string =>
  [k.app, k.chrome, k.vendor ?? '?', k.device ?? '?', k.driver ?? '?'].join('|')

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
  /** the GPU rasters (feature status). Read after keyParts, never at app ready: Chromium reports
   *  every feature as software until its GPU process has started (measured 2026-11-16) */
  gpuRasters(): boolean
  keyParts(): Promise<WarmupKeyParts>
  readMarker(): Promise<string | null>
  writeMarker(text: string): Promise<void>
  cacheExists(): Promise<boolean>
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
  /** give up when the user was never idle within this long (they warm it by using the app) */
  giveUpMs: number
  /** the window is destroyed this long after it was created, done or not */
  deadlineMs: number
}

export const WARMUP_DEFAULTS: WarmupOptions = { delayMs: 15_000, idleS: 5, retryMs: 10_000, giveUpMs: 10 * 60_000, deadlineMs: 8_000 }

export type WarmupOutcome = 'skipped-warm' | 'skipped-no-gpu' | 'gave-up-busy' | 'done' | 'deadline' | 'failed' | 'stopped'

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
    // everything waits for the launch to settle first, the skip check included (its log line needs the data folder)
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

  private finish(o: WarmupOutcome, extra: Record<string, unknown> = {}): void {
    if (this.settled) return
    this.settled = true
    this.deps.log({ outcome: o, ms: this.deps.now() - this.started, ...extra })
    this.resolve(o)
  }

  private close(): void {
    const w = this.window
    this.window = null
    if (w && !w.isDestroyed()) { try { w.destroy() } catch { /* already gone */ } }
  }

  private async decide(): Promise<void> {
    let key: string
    try {
      // keyParts first: reading the GPU info waits for the GPU process, after which the feature status is real
      key = warmupKey(await this.deps.keyParts())
      // GPU only (USER 2026-11-16 09:43:35Z: no CPU raster): with software raster there is nothing to warm
      if (!this.deps.gpuRasters()) return this.finish('skipped-no-gpu')
      const [marker, cache] = await Promise.all([this.deps.readMarker(), this.deps.cacheExists()])
      if (cache && marker && safeKey(marker) === key) return this.finish('skipped-warm')
    } catch (e) { return this.finish('failed', { error: String(e) }) }
    if (this.stopped) return
    this.whenIdle(key)
  }

  private whenIdle(key: string): void {
    this.timer = null
    if (this.stopped) return
    if (this.deps.idleSeconds() >= this.opts.idleS) return void this.run(key)
    if (this.deps.now() - this.started >= this.opts.giveUpMs) return this.finish('gave-up-busy')
    this.timer = this.deps.setTimeout(() => this.whenIdle(key), this.opts.retryMs)
  }

  private async run(key: string): Promise<void> {
    let w: WarmupWindow
    try { w = this.window = this.deps.createWindow() } catch (e) { return this.finish('failed', { error: String(e) }) }
    const t0 = this.deps.now()
    let ended = false
    const end = (o: WarmupOutcome, extra: Record<string, unknown> = {}) => {
      // the first end wins: destroying the window below fires its own 'closed'
      if (ended || this.settled || this.stopped) return
      ended = true
      if (this.timer !== null) { this.deps.clearTimeout(this.timer); this.timer = null }
      this.close()
      const done = () => this.finish(o, { window_ms: this.deps.now() - t0, ...extra })
      // only a scene that ran to its end marks the cache warm; a cut-off one runs again next launch
      if (o === 'done') this.deps.writeMarker(JSON.stringify({ key, at: new Date(this.deps.now()).toISOString() })).then(done, e => this.finish('failed', { error: String(e) }))
      else done()
    }
    w.onTitle(title => { if (title === WARMUP_DONE_TITLE) end('done') })
    w.onGone(() => end('failed', { error: 'window gone' }))
    this.timer = this.deps.setTimeout(() => end('deadline'), this.opts.deadlineMs)
    try { await w.loadURL(this.deps.url) } catch (e) { end('failed', { error: String(e) }) }
  }
}

function safeKey(text: string): string | null {
  try { const k = (JSON.parse(text) as { key?: unknown }).key; return typeof k === 'string' ? k : null } catch { return null }
}
