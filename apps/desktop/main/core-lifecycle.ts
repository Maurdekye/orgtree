/** Main-process only. The native probe checks stamped process identities; an
 * HTTP timeout alone never becomes proof that a component died. */
import {execFile} from 'node:child_process'
import type {CredentialBridge} from './credential-bridge'

/** A failed native lifecycle command as the desktop records it: fixed words
 * and numbers only. Stderr is read solely as the refusal line `core-control
 * begin` prints, and only its allowed fields are kept; never raw text. */
export type CoreControlFailure = {
  event: 'core-control-failed'; command: 'core-control' | 'core-recovery'; action: string; ms: number
  exit: number | null; errno: string | null; signal: string | null; timedOut: boolean
  refusal: {refused: string; members?: {role: string; life: string; stage?: string; os?: number}[]} | null
}

const ROLES = ['engine', 'host', 'desktop', 'helper'], LIVES = ['alive', 'unknown'], STAGES = ['open', 'wait', 'times']

function refusalOf(stderr: unknown): CoreControlFailure['refusal'] {
  if (typeof stderr !== 'string') return null
  let line: unknown
  try { line = JSON.parse(stderr.split(/\r?\n/, 1)[0]) } catch { return null }
  if (!line || typeof line !== 'object') return null
  const {refused, members} = line as {refused?: unknown; members?: unknown}
  if (refused === 'session' || refused === 'quit') return {refused}
  if (refused !== 'members' || !Array.isArray(members) || members.length > 4) return null
  const kept: {role: string; life: string; stage?: string; os?: number}[] = []
  for (const m of members as unknown[]) {
    const {role, life, stage, os} = (m && typeof m === 'object' ? m : {}) as Record<string, unknown>
    if (typeof role !== 'string' || !ROLES.includes(role) || typeof life !== 'string' || !LIVES.includes(life)) return null
    if (stage === undefined && os === undefined) { kept.push({role, life}); continue }
    if (typeof stage !== 'string' || !STAGES.includes(stage) || typeof os !== 'number'
      || !Number.isInteger(os) || os < 0 || os > 0xFFFFFFFF) return null
    kept.push({role, life, stage, os})
  }
  return {refused, members: kept}
}

export function controlFailure(command: CoreControlFailure['command'], action: string, ms: number,
  error: {code?: unknown; signal?: unknown; killed?: unknown}, stderr: unknown): CoreControlFailure {
  const errno = typeof error.code === 'string' && /^E[A-Z0-9_]{1,40}$/.test(error.code) ? error.code : null
  return {event: 'core-control-failed', command, action, ms: Math.max(0, Math.round(ms)),
    exit: typeof error.code === 'number' && Number.isInteger(error.code) ? error.code : null, errno,
    signal: typeof error.signal === 'string' && /^SIG[A-Z0-9]{1,12}$/.test(error.signal) ? error.signal : null,
    // execFile also kills a child for an overfull buffer; that is not a timeout
    timedOut: error.killed === true && errno !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
    refusal: command === 'core-control' && action === 'begin' ? refusalOf(stderr) : null}
}

export class CoreLifecycle {
  private busy = false
  private timer?: ReturnType<typeof setInterval>
  private cancelled = false
  private recovery?: (allowSpawn: boolean) => Promise<void>
  private attachedGeneration?: string
  private watchDesktop = false
  private armed = false
  private armedAt = 0
  private armedGeneration?: string
  private failure?: {generation: string; since: number; attempted: boolean}
  private noted?: {key: string; at: number}
  configureRecovery(recover: (allowSpawn: boolean) => Promise<void>, watchDesktop: boolean): void {
    this.recovery = recover; this.watchDesktop = watchDesktop
  }
  /** Diagnosis never changes a decision. The 2-second tick repeats a status
   *  failure: the same failure is recorded at most once a minute. */
  private note(command: CoreControlFailure['command'], action: string, started: number, error: unknown, stderr: unknown): void {
    try {
      if (!this.record) return
      const failure = controlFailure(command, action, Date.now() - started, error as {code?: unknown}, stderr)
      const key = JSON.stringify({...failure, ms: 0}), now = Date.now()
      if (this.noted?.key === key && now - this.noted.at < 60000) return
      this.noted = {key, at: now}
      this.record(failure)
    } catch { /* never obstruct the lifecycle it describes */ }
  }
  private command(action: 'arm' | 'quit' | 'engine'): Promise<{armed?: boolean; admitted?: boolean}> {
    const started = Date.now()
    return new Promise((resolve, reject) => execFile(this.binary,
      ['core-recovery', action, this.root, String(process.pid)],
      {windowsHide: true, timeout: 5000, maxBuffer: 8192}, (error, stdout, stderr) => {
        if (error) { this.note('core-recovery', action, started, error, stderr); reject(new Error('Native recovery control failed')); return }
        try { resolve(JSON.parse(stdout)) } catch { reject(new Error('Invalid recovery reply')) }
      }))
  }
  async cancelRecovery(): Promise<void> {
    this.cancelled = true; this.stop()
    try { await this.command('quit') }
    catch (error) { this.cancelled = false; this.start(); throw error }
  }
  constructor(private readonly binary: string, private readonly root: string,
    private readonly bridge: CredentialBridge,
    private readonly endpoint: () => {origin: string; token: string},
    private readonly shutdown: () => void,
    private readonly record?: (failure: CoreControlFailure) => void) {}

  private native(action: 'begin' | 'status'): Promise<{stopped?: boolean; generation?: string; engineGone?: boolean; transitioning?: boolean}> {
    const started = Date.now()
    return new Promise((resolve, reject) => {
      execFile(this.binary, ['core-control', action, this.root], {windowsHide: true, timeout: 5000, maxBuffer: 8192},
        (error, stdout, stderr) => {
          if (error) {
            this.note('core-control', action, started, error, stderr)
            reject(new Error('The previous Orgtree session has not finished stopping. Wait, then reopen Orgtree.')); return
          }
          try { resolve(action === 'begin' ? {} : JSON.parse(stdout)) } catch { reject(new Error('Invalid lifecycle reply')) }
        })
    })
  }
  async begin(automatic = false): Promise<boolean> {
    // A late login launch is another automatic retry, not the user's explicit
    // request to open a fresh application after a failed cohort.
    if (automatic) return (await this.native('status')).stopped === true
    await this.native('begin'); return false
  }
  async transition(installing = false): Promise<void> {
    const e = this.endpoint()
    if (await this.bridge.core(e.origin, e.token, installing ? 'install' : 'transition')) {
      this.shutdown(); throw new Error('Orgtree is stopping because a required process exited.')
    }
  }
  async restart(restartHealthy: () => Promise<void>): Promise<void> {
    if (this.cancelled || this.busy) throw new Error('Orgtree recovery is already running or stopping. Try again when it finishes.')
    this.busy = true
    try {
      const state = await this.native('status')
      if (this.cancelled || state.stopped) throw new Error('Orgtree is stopping; engine restart was cancelled.')
      // An explicit retry after exhaustion cannot ask a dead HTTP endpoint to
      // enter a transition. Only stamped native death permits that exception.
      // Reuse the configured recovery path, including root/task rights checks
      // and window reattachment, without resetting the automatic retry budget.
      if (state.generation && state.engineGone === true && !state.transitioning && this.recovery) {
        await this.recovery(true)
      } else {
        await this.transition()
        if (this.cancelled) throw new Error('Orgtree is stopping; engine restart was cancelled.')
        await restartHealthy()
        if (!this.cancelled) await this.complete()
      }
    } finally { this.busy = false }
  }
  async complete(): Promise<void> {
    const e = this.endpoint()
    if (await this.bridge.core(e.origin, e.token) || await this.bridge.core(e.origin, e.token, 'complete')) { this.shutdown(); return }
    this.attachedGeneration = (await this.native('status')).generation
  }
  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => { void this.tick() }, 2000)
    this.timer.unref()
    void this.tick()
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined }
  async tick(): Promise<void> {
    if (this.busy || this.cancelled) return
    this.busy = true
    try {
      // The local journal also covers the engine disappearing before the HTTP
      // registration can answer. No retry is allowed to clear its stop record.
      const state = await this.native('status')
      if (state.stopped) { this.shutdown(); return }
      if (state.generation !== this.armedGeneration || Date.now() - this.armedAt >= 60000) this.armed = false
      if (this.watchDesktop && !this.armed && !state.engineGone) {
        this.armed = (await this.command('arm')).armed === true
        this.armedAt = Date.now(); this.armedGeneration = state.generation
      }
      if (!state.engineGone && state.generation && this.attachedGeneration
        && state.generation !== this.attachedGeneration && this.recovery && !this.cancelled) {
        // The boot supervisor may win the race. Adopt its healthy replacement
        // rather than waiting forever for a death which has already recovered.
        await this.recovery(false)
        if (!this.cancelled) this.attachedGeneration = state.generation
      }
      if (state.engineGone && !state.transitioning && state.generation && this.recovery) {
        if (this.failure?.generation !== state.generation) this.failure = {generation: state.generation, since: Date.now(), attempted: false}
        const elapsed = Date.now() - this.failure.since
        if (!this.failure.attempted && elapsed >= 5000 && elapsed < 120000 && !this.cancelled
          && (await this.command('engine')).admitted && !this.cancelled) {
          this.failure.attempted = true
          await this.recovery(true)
        }
        return
      }
      if (!state.engineGone) this.failure = undefined
      const e = this.endpoint()
      if (e.origin && await this.bridge.core(e.origin, e.token)) this.shutdown()
    } catch { /* uncertain probes retry; they do not declare process death */ }
    finally { this.busy = false }
  }
}
