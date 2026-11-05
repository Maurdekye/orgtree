/** MAIN-SIDE STALL PROBES (spec ui-stall-tooling-spec rev 1.2, section M). Pure over injected clocks, timers, ports and
 *  stack collectors, so tests/stall-probe.test.mjs drives every rule with fake time; main/index.ts only supplies the real
 *  ones. ORGTREE_STALLWATCH=0 turns all of it off: no interval, worker, ping, header or switch.
 *
 *  Four independent probes:
 *   - MainLagProbe   a 100 ms interval; a tick 500+ ms late is a main stall (and doubles as the worker's heartbeat)
 *   - PingWatchdog   per window: a ping over a MessagePort answered from the preload, i.e. on the renderer's main thread
 *   - IpcTracker     which ipcMain handlers were running or pending, and how long a sendSync handler blocked
 *   - stack capture  the renderer call stack (webContents.mainFrame.collectJavaScriptCallStack) and the main thread's
 *                    (an inspector session from a worker thread), both best effort: failures become `unavailable:<reason>` */

export const STALLWATCH_ENV = 'ORGTREE_STALLWATCH'
export const MAIN_TICK_MS = 100
export const MAIN_STALL_MS = 500
export const PING_EVERY_MS = 500
export const PING_FIRST_STACK_MS = 400
export const PING_SECOND_STACK_MS = 2000
export const SYNC_IPC_MS = 100
export const MAIN_STACK_EVERY_MS = 60_000
export const STACK_POLICY = 'include-js-call-stacks-in-crash-reports'
export const STACK_SWITCH = 'enable-features=DocumentPolicyIncludeJSCallStacksInCrashReports'

/** `ORGTREE_STALLWATCH=0` is the one off switch (the overhead A/B and a safety valve). No UI. */
export const stallWatchEnabled = (env: Record<string, string | undefined>): boolean => env[STALLWATCH_ENV] !== '0'
/** the command-line switch to append before app ready; nothing when off */
export const stallSwitches = (env: Record<string, string | undefined>): string[] => stallWatchEnabled(env) ? [STACK_SWITCH] : []
/** The Document-Policy header the app's OWN origin gets so collectJavaScriptCallStack works; nothing for any other origin or when off. */
export function withStackPolicy(headers: Record<string, string[]>, url: string, origin: string, env: Record<string, string | undefined>): Record<string, string[]> {
  if (!stallWatchEnabled(env) || !origin || !(url === origin || url.startsWith(origin + '/'))) return headers
  return { ...headers, 'Document-Policy': [STACK_POLICY] }
}

const reason = (e: unknown): string => `unavailable:${String((e as Error)?.message ?? e ?? 'unknown').replace(/\s+/g, ' ').slice(0, 80)}`

// ---------------------------------------------------------------- in-flight IPC
export interface IpcSpan { channel: string; window: string; start: number; end: number | null }
export class IpcTracker {
  private spans: IpcSpan[] = []
  constructor(private readonly now: () => number, private readonly keep = 64) {}
  begin(channel: string, window = ''): () => void {
    const span: IpcSpan = { channel, window, start: this.now(), end: null }
    this.spans.push(span)
    if (this.spans.length > this.keep) this.spans = this.spans.filter(s => s.end === null || this.spans.indexOf(s) > this.spans.length - this.keep)
    return () => { span.end ??= this.now() }
  }
  /** handlers that were pending or ran at any time in [from, to]; `window` narrows to one window */
  overlapping(from: number, to: number, window?: string): Array<{ channel: string; age_ms: number }> {
    return this.spans
      .filter(s => (!window || s.window === window) && s.start <= to && (s.end ?? Infinity) >= from)
      .slice(-32).map(s => ({ channel: s.channel, age_ms: Math.max(0, to - s.start) }))
  }
}

export interface IpcLike {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): unknown
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown
}
/** Wrap `handle` and `on` ONCE where they are registered, so no call site changes. A sendSync handler (`on` that sets
 *  event.returnValue) blocks the renderer by design: one taking 100+ ms is reported through `onSync`. */
export function trackIpc(ipc: IpcLike, tracker: IpcTracker, now: () => number, onSync: (channel: string, ms: number) => void,
  windowOf: (event: unknown) => string = () => ''): void {
  const handle = ipc.handle.bind(ipc), on = ipc.on.bind(ipc)
  ipc.handle = (channel, listener) => handle(channel, (event, ...args) => {
    const end = tracker.begin(channel, windowOf(event))
    let result: unknown
    try { result = listener(event, ...args) } catch (e) { end(); throw e }
    if (result && typeof (result as Promise<unknown>).then === 'function') {
      (result as Promise<unknown>).then(end, end)
    } else end()
    return result
  })
  ipc.on = (channel, listener) => on(channel, (event, ...args) => {
    const end = tracker.begin(channel, windowOf(event)), t0 = now()
    try { listener(event, ...args) } finally {
      end()
      const ms = now() - t0
      if (ms >= SYNC_IPC_MS) { try { onSync(channel, ms) } catch { /* diagnostics only */ } }
    }
  })
}

// ---------------------------------------------------------------- main event-loop lag
export interface MainLagDeps {
  now: () => number
  setInterval: (fn: () => void, ms: number) => unknown
  clearInterval: (h: unknown) => void
  tracker: IpcTracker
  /** the main thread's stack from the worker, if it captured one near this stall */
  mainStack: (from: number, to: number) => string | string[]
  report: (record: { at_ms: number; lag_ms: number; ipc: Array<{ channel: string; age_ms: number }>; main_stack: string | string[] }) => void
  /** called on every tick: the worker's heartbeat */
  beat?: (t: number) => void
}
export class MainLagProbe {
  private handle: unknown = null
  private last = 0
  constructor(private readonly d: MainLagDeps) {}
  start(): void {
    if (this.handle) return
    this.last = this.d.now()
    this.handle = this.d.setInterval(() => this.tick(), MAIN_TICK_MS)
  }
  stop(): void { if (this.handle) this.d.clearInterval(this.handle); this.handle = null }
  private tick(): void {
    const t = this.d.now()
    const late = t - this.last - MAIN_TICK_MS
    const from = this.last
    this.last = t
    this.d.beat?.(t)
    if (late < MAIN_STALL_MS) return
    this.d.report({ at_ms: from, lag_ms: late, ipc: this.d.tracker.overlapping(from, t), main_stack: this.d.mainStack(from, t) })
  }
}

// ---------------------------------------------------------------- lazy main-stack worker
export interface LazyWorkerDeps {
  now: () => number
  /** signals in the first N ms after construction (app start) do not start the worker; default 60 s (spec rev 1.8) */
  startupGraceMs?: number
  setTimeout: (fn: () => void, ms: number) => unknown
  clearTimeout: (h: unknown) => void
  /** creates the worker thread; the returned handle stops it */
  spawn: () => { stop: () => void }
  idleMs?: number
}
/** The main-stack worker thread is a whole V8 isolate: measured about +8 MB resident in main (RP2, 2026-11-05). So it does not exist until
 *  a stall signal (a main-lag record, a sync-IPC record, a renderer long frame) calls wake(), and it is stopped after 10 quiet minutes. The
 *  stall that starts it has no main stack (`unavailable:none-captured`); a recurring stall does. A failed start is swallowed. */
export class LazyStackWorker {
  private handle: { stop: () => void } | null = null
  private timer: unknown = null
  private readonly born: number
  constructor(private readonly d: LazyWorkerDeps) { this.born = d.now() }
  /** startup sync IPC and engine attach can look like a stall: no worker for the first minute (the records are still written) */
  inGrace(): boolean { return this.d.now() - this.born < (this.d.startupGraceMs ?? 60_000) }
  wake(): void {
    if (this.inGrace()) return
    if (!this.handle) { try { this.handle = this.d.spawn() } catch { return } }
    if (this.timer) this.d.clearTimeout(this.timer)
    this.timer = this.d.setTimeout(() => this.sleep(), this.d.idleMs ?? 10 * 60_000)
  }
  private sleep(): void {
    this.timer = null
    const h = this.handle
    this.handle = null
    try { h?.stop() } catch { /* already gone */ }
  }
}

// ---------------------------------------------------------------- renderer ping watchdog
export interface PingPort { postMessage(message: unknown): void }
export interface PingWindow {
  id: string
  org: boolean
  port: PingPort
  /** visible and not minimized: only then is a silent renderer a stall */
  visible: () => boolean
  /** the renderer's JS call stack, or a string explaining why not */
  collectStack: () => Promise<string>
  context?: () => unknown
}
export interface PingDeps {
  now: () => number
  setTimeout: (fn: () => void, ms: number) => unknown
  clearTimeout: (h: unknown) => void
  setInterval: (fn: () => void, ms: number) => unknown
  clearInterval: (h: unknown) => void
  tracker: IpcTracker
  report: (src: 'renderer-ping' | 'renderer-unresponsive', window: PingWindow, record: Record<string, unknown>) => void
}
interface Flight { seq: number; sent: number; timers: unknown[]; stacks: Array<Promise<string>> }
export class PingWatchdog {
  private windows = new Map<string, PingWindow>()
  private flights = new Map<string, Flight>()
  private seq = 0
  private handle: unknown = null
  constructor(private readonly d: PingDeps) {}
  add(w: PingWindow): void { this.windows.set(w.id, w) }
  remove(id: string): void { const f = this.flights.get(id); if (f) f.timers.forEach(t => this.d.clearTimeout(t)); this.flights.delete(id); this.windows.delete(id) }
  start(): void { if (!this.handle) this.handle = this.d.setInterval(() => this.round(), PING_EVERY_MS) }
  stop(): void { if (this.handle) this.d.clearInterval(this.handle); this.handle = null }
  private round(): void {
    for (const w of this.windows.values()) {
      if (this.flights.has(w.id)) continue          // one outstanding ping per window
      let shown = false
      try { shown = w.visible() } catch { shown = false }
      if (!shown) continue
      const flight: Flight = { seq: ++this.seq, sent: this.d.now(), timers: [], stacks: [] }
      this.flights.set(w.id, flight)
      const take = () => { flight.stacks.push(w.collectStack().catch(reason)) }
      flight.timers.push(this.d.setTimeout(take, PING_FIRST_STACK_MS), this.d.setTimeout(take, PING_SECOND_STACK_MS))
      try { w.port.postMessage({ ping: flight.seq }) } catch { this.settle(w.id) }
    }
  }
  private settle(id: string): Flight | undefined {
    const f = this.flights.get(id)
    if (!f) return undefined
    f.timers.forEach(t => this.d.clearTimeout(t))
    this.flights.delete(id)
    return f
  }
  /** the preload answered `pong{seq}` */
  pong(id: string, seq: number): void {
    const w = this.windows.get(id), f = this.flights.get(id)
    if (!w || !f || f.seq !== seq) return
    this.settle(id)
    const now = this.d.now(), blocked = now - f.sent
    if (blocked < PING_FIRST_STACK_MS) return       // it answered in time: nothing was wrong
    void Promise.all(f.stacks).then(stacks => this.d.report('renderer-ping', w, {
      at_ms: f.sent, ms: blocked, blocked_ms: blocked, stacks, ipc: this.d.tracker.overlapping(f.sent, now, id), ctx: w.context?.(),
    }))
  }
  /** Chromium's own `unresponsive` event: the same context as a ping stall, so the long freezes line up */
  unresponsive(id: string): void {
    const w = this.windows.get(id)
    if (!w) return
    const now = this.d.now()
    void w.collectStack().catch(reason).then(stack => this.d.report('renderer-unresponsive', w, {
      at_ms: now, ms: 0, blocked_ms: 0, stacks: [stack], ipc: this.d.tracker.overlapping(now - 5000, now, id), ctx: w.context?.(),
    }))
  }
}

// ---------------------------------------------------------------- main thread stack, from a worker
/** the slice of node:inspector's Session the capture uses (so tests need no inspector) */
export interface InspectorLike {
  connectToMainThread(): void
  post(method: string, params: unknown, cb: (err: Error | null, result?: unknown) => void): void
  on(event: string, cb: (message: { params: { callFrames: Array<{ functionName: string; url: string; lineNumber: number; columnNumber: number }> } }) => void): void
  disconnect(): void
}
/** One capture: pause the main thread, read the frames, resume. The debugger is NEVER left enabled, whatever fails. */
export function captureMainStack(session: InspectorLike): Promise<string[] | string> {
  return new Promise(resolve => {
    let enabled = false, done = false
    const finish = (value: string[] | string) => {
      if (done) return
      done = true
      const off = () => { try { session.disconnect() } catch { /* already gone */ } resolve(value) }
      if (!enabled) { off(); return }
      session.post('Debugger.resume', {}, () => session.post('Debugger.disable', {}, () => off()))
    }
    try {
      session.connectToMainThread()
      session.on('Debugger.paused', message => finish(message.params.callFrames.slice(0, 30).map(f =>
        `${f.functionName || '(anonymous)'} (${f.url}:${f.lineNumber + 1}:${f.columnNumber + 1})`)))
      session.post('Debugger.enable', {}, err => {
        if (err) { finish(reason(err)); return }
        enabled = true
        session.post('Debugger.pause', {}, e => { if (e) finish(reason(e)) })
      })
    } catch (e) { finish(reason(e)) }
  })
}
/** at most one capture per 60 s */
export class StackGate {
  private last = -Infinity
  constructor(private readonly every = MAIN_STACK_EVERY_MS) {}
  allow(now: number): boolean {
    if (now - this.last < this.every) return false
    this.last = now
    return true
  }
}

/** The latest main stack the worker posted, handed to a main-lag record when it was captured near that stall. */
export class MainStackStore {
  private latest: { at: number; stack: string[] | string } | null = null
  put(at: number, stack: string[] | string): void { this.latest = { at, stack } }
  near(from: number, to: number): string[] | string {
    const l = this.latest
    return l && l.at >= from - 1000 && l.at <= to + 1000 ? l.stack : 'unavailable:none-captured'
  }
}
