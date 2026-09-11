import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { canonicalPath, parseAttach, parseReady, parseRefusal, parseProgress, TOKEN_HEADER, validateDataRoot, verifyDescriptorTrust, type DescriptorOwner } from './policy'

export const ENGINE_REFUSED = 'Engine start refused: '
// Attachment retries remain bounded independently of the child protocol.
// This covers the host's initial 120s silence budget plus cleanup/attachment.
export const ATTACH_RETRY_BUDGET_MS = 150000

/** EVERY PHASE A QUIT CAN SPEND, and nothing else spends any. `stopForQuit`
 *  apportions ONE budget across these and never exceeds it, and the desktop
 *  bounds the call by the same sum — so the bound and the path it bounds are
 *  the same number.
 *
 *  ⚠ THEY WERE NOT (coordinator review). The outer bound was
 *  engineStop + forcedRelease + margin while the inner path could spend the
 *  shutdown request, the release wait, the termination AND its proof on top
 *  of each other. An outer bound shorter than its path means the BOUND is
 *  what ends the quit: the app exits with a termination still in flight and
 *  its proof never read, which is the one thing this whole change exists to
 *  stop being possible. */
export const QUIT_DEADLINES = {
  /** `stop()`'s own worst case for a MANAGED child, by its own constants:
   *  a 3 s shutdown POST plus the 5 s it waits for the exit before killing. */
  managedStopMs: 8000,
  /** the authenticated shutdown request to an ATTACHED engine */
  requestMs: 4000,
  /** waiting for the three-fact proof after asking nicely */
  releaseMs: 8000,
  /** TerminateProcess across the tree — taskkill answers in well under a
   *  second; this is the ceiling, not the expectation */
  killMs: 5000,
  /** and the proof AFTER it, which is third-party: the boot host has to
   *  notice its child and remove the descriptor, and Windows has to finish
   *  tearing the job down. This waits for those two, never for the kill. */
  provenMs: 5000,
}
/** The worst case of either path — managed (`stop` → confirm → kill →
 *  confirm) or attached (request → release → kill → proof) — which is the
 *  larger first phase plus the three they share. */
export const QUIT_STOP_BUDGET_MS = Math.max(QUIT_DEADLINES.managedStopMs, QUIT_DEADLINES.requestMs)
  + QUIT_DEADLINES.releaseMs + QUIT_DEADLINES.killMs + QUIT_DEADLINES.provenMs
import type { EngineStatus } from '../../../packages/contracts/index'
import { maintenanceRequest, type MaintenanceRequest } from './maintenance'
import { orgActivityRows, type OrgActivityRow } from './traylist'

export interface EngineOptions { python: string; directory: string; dataRoot: string; forbiddenRoot: string; uiDirectory: string; timeoutMs?: number }
export interface RuntimeStats { activeAgents: number; totalAgents: number; idle: boolean; maintenance?: MaintenanceRequest }

/** One fresh managed child, or an authenticated attachment to the boot
 *  host's engine. Never discovers or attaches by a bare .port file: attaching
 *  requires the descriptor's token AND an /api/desktop/identity proof of
 *  root and process, because a persisted port can move between boots. */
export class Engine extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams
  private credential = randomBytes(32).toString('hex')
  private endpoint = ''
  private stopping = false
  /** False when attached to a boot-host engine this process must not stop. */
  managed = true
  /** Resolved data root of the current attachment; '' when managed. */
  private attachedRoot = ''
  /** The engine PID this attachment authenticated, and the exact descriptor
   *  bytes it was read from. Only `stopForQuit`'s forced path uses them, and
   *  only together: a PID is not an identity, but a PID whose descriptor is
   *  still on disk unchanged, under a root lock still held, is. */
  private attachedEnginePid = 0
  private attachedDescriptor = ''
  /** Why the last attach attempt was declined; empty when no descriptor existed. */
  attachDiagnostic = ''
  status: EngineStatus = { state: 'starting' }
  get origin(): string { return this.endpoint }
  // Main-process only; never include this field in bridge responses or logs.
  get token(): string { return this.credential }
  private state(status: EngineStatus) { this.status = status; this.emit('status', status) }

  /** Injectable for tests; the default is the real NTFS owner + exclusive
   *  write-boundary query (file and parent directory). */
  trustCheck: (file: string) => Promise<DescriptorOwner> = verifyDescriptorTrust

  /** Keep trying to attach for a bounded window. A missing descriptor only
   *  means no host has FINISHED starting — during the boot race the host may
   *  need most of its readiness budget before the file exists. */
  async attachWithRetry(options: Pick<EngineOptions, 'dataRoot' | 'forbiddenRoot'>, deadlineMs = ATTACH_RETRY_BUDGET_MS, intervalMs = 1000): Promise<boolean> {
    // The wait is long and windowless (opus N5): flip back to 'starting' so
    // the tray — the only surface that exists yet — reads as waiting rather
    // than carrying the failed spawn's 'unavailable'. (The contract's
    // starting state carries no message; a fuller waiting UI is a renderer
    // follow-up outside this scope.)
    this.state({ state: 'starting' })
    const deadline = Date.now() + deadlineMs
    for (;;) {
      if (await this.attach(options)) return true
      if (Date.now() >= deadline) return false
      await new Promise(resolve => setTimeout(resolve, intervalMs))
    }
  }

  /** A method (not an inline closure) so tests can FORCE the ordering the
   *  real race only sometimes produces: a child disowned by a failed spawn
   *  can deliver its 'exit' after a later attach reached ready, and must not
   *  clobber it (opus N3 — the guard was real but untestable inline). */
  childExited(child: ChildProcessWithoutNullStreams): void {
    if (this.child !== child) return
    this.endpoint = ''
    this.state({ state: 'stopped', message: this.stopping ? 'Engine stopped' : 'Engine exited. Restart Orgtree to recover.' })
  }

  async attach(options: Pick<EngineOptions, 'dataRoot' | 'forbiddenRoot'>): Promise<boolean> {
    // A child that already EXITED (a spawn that lost the boot race) does not
    // block attachment; a live child or an existing attachment does.
    if ((this.child && this.child.exitCode === null) || !this.managed) throw new Error('Engine already started')
    // Diagnostics describe this attempt, not a descriptor removed since the last one.
    this.attachDiagnostic = ''
    const root = validateDataRoot(options.dataRoot, options.forbiddenRoot)
    if (!fs.existsSync(root)) return false
    const realRoot = fs.realpathSync.native(root)
    const file = path.join(realRoot, 'engine-attach.json')
    if (!fs.existsSync(file)) return false
    try {
      // AUTHENTICATION FIRST, before a single descriptor byte is trusted:
      // everything in the file is authored by whoever can WRITE it, so trust
      // is the write boundary — current-user ownership AND no foreign
      // write/replace access on the file, its directory, or any ancestor
      // (root ruling; covers a custom ORGTREE_V2_DATA in an unsafe
      // location). Only after the boundary holds are the bytes read, so
      // nothing parsed predates the trust decision.
      const trust = await this.trustCheck(file)
      if (!trust.ok) throw new Error('descriptor trust rejected: ' + trust.detail)
      const raw = fs.readFileSync(file, 'utf8')
      const attach = parseAttach(raw, realRoot)
      const origin = `http://127.0.0.1:${attach.port}`
      // STALENESS CHECK, not peer authentication: it proves the endpoint
      // echoes this boot's descriptor (catching a recycled port), nothing
      // about who is listening — the owner check above carries that weight.
      const response = await fetch(origin + '/api/desktop/identity',
        { headers: { [TOKEN_HEADER]: attach.token }, signal: AbortSignal.timeout(4000), redirect: 'error' })
      if (!response.ok) throw new Error(`identity check returned ${response.status}`)
      const identity = await response.json() as { protocol?: unknown; pid?: unknown; dataRootId?: unknown }
      if (identity.protocol !== 1) throw new Error('identity protocol mismatch')
      if (identity.pid !== attach.enginePid) throw new Error('identity process mismatch')
      if (typeof identity.dataRootId !== 'string' || canonicalPath(identity.dataRootId) !== canonicalPath(realRoot)) throw new Error('identity root mismatch')
      this.credential = attach.token
      this.endpoint = origin
      this.managed = false
      this.attachedRoot = realRoot
      this.attachedEnginePid = attach.enginePid
      this.attachedDescriptor = raw
      this.attachProbeFailures = 0
      this.state({ state: 'ready' })
      return true
    } catch (error) {
      // A descriptor existed but did not verify: stale after a crash or a
      // port move, or foreign. Say so; never trust, never delete blindly.
      this.attachDiagnostic = error instanceof Error ? error.message : 'attach descriptor rejected'
      return false
    }
  }

  async start(options: EngineOptions): Promise<void> {
    if (this.child) throw new Error('Engine already started')
    const root = validateDataRoot(options.dataRoot, options.forbiddenRoot)
    if (!path.isAbsolute(options.python) || !fs.existsSync(options.python)) throw new Error('Python runtime is missing. Configure ORGTREE_V2_PYTHON for development.')
    if (!fs.existsSync(path.join(options.directory, 'launch.py'))) throw new Error('Python engine has not been packaged')
    fs.mkdirSync(root, { recursive: true })
    const realRoot = fs.realpathSync.native(root)
    validateDataRoot(realRoot, options.forbiddenRoot)
    this.state({ state: 'starting' })
    const env = { ...process.env, ORGTREE_DATA: realRoot, ORGTREE_V2_TOKEN: this.credential,
      ORGTREE_V2_UI_DIR: options.uiDirectory, ORGTREE_V2_PARENT_PID: String(process.pid), PYTHONUNBUFFERED: '1' }
    // Never inherit a v1 backend port or root selector.
    delete env['ORGTREE_PORT' as keyof typeof env]
    const child = spawn(options.python, [path.join(options.directory, 'launch.py')], { cwd: options.directory, env, windowsHide: true, stdio: 'pipe' })
    this.child = child
    child.stderr.on('data', () => { /* Engine owns on-disk diagnostics; avoid reflecting arbitrary secrets. */ })
    child.on('exit', () => this.childExited(child))
    await new Promise<void>((resolve, reject) => {
      let buffered = '', settled = false, progress = 0, refused = false
      let timer: ReturnType<typeof setTimeout>
      const resetDeadline = () => {
        clearTimeout(timer)
        timer = setTimeout(() => { void finish(new Error('Engine did not become ready in time')) }, options.timeoutMs ?? 60000)
      }
      const finish = async (error?: Error) => {
        if (settled) return
        settled = true; clearTimeout(timer); child.stdout.off('data', onData)
        child.stdout.resume()
        // A failed spawn no longer occupies this engine: the boot-race path
        // retries attach() on the same instance after a structured refusal.
        if (!error) { resolve(); return }
        // Detach state notifications before killing, but keep the child locally
        // until its exit AND its guardian's root release have been observed.
        this.child = undefined
        this.endpoint = ''
        if (child.pid && child.exitCode === null && child.signalCode === null) await this.forceKillTree(child.pid)
        const deadline = Date.now() + QUIT_DEADLINES.provenMs
        while (child.pid && child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 25))
        }
        const exited = !child.pid || child.exitCode !== null || child.signalCode !== null
        // A structured root-owned refusal never owned the other engine's lock.
        // It is the attach race, not a tree we may kill or wait to release.
        const lockFile = path.join(realRoot, '.desktop-engine.lock')
        const released = refused || (!progress && !fs.existsSync(lockFile)) ||
          (await this.awaitAttachedRelease('', '', lockFile, QUIT_DEADLINES.provenMs)).released
        if (!exited || !released) {
          error = new Error(error.message + '; engine tree release could not be verified (guardian lock still held or unavailable)')
          this.child = child // forbid another managed start over unverified cleanup
        }
        this.state({ state: 'unavailable', message: error.message })
        reject(error)
      }
      const onData = (chunk: Buffer) => {
        buffered += chunk.toString('utf8')
        if (buffered.length > 65536) return finish(new Error('Engine readiness exceeded size limit'))
        while (buffered.includes('\n')) {
          const at = buffered.indexOf('\n'), line = buffered.slice(0, at).trim(); buffered = buffered.slice(at + 1)
          const refusal = parseRefusal(line)
          if (refusal) { refused = true; void finish(new Error(ENGINE_REFUSED + refusal)); return }
          const next = parseProgress(line, realRoot, child.pid ?? -1, progress)
          if (next > progress) { progress = next; resetDeadline(); continue }
          try {
            const ready = parseReady(line, realRoot, child.pid ?? -1)
            if (ready) { this.endpoint = `http://127.0.0.1:${ready.port}`; this.state({ state: 'ready' }); finish(); return }
          } catch (error) { finish(error as Error); return }
        }
      }
      resetDeadline()
      child.stdout.on('data', onData)
      child.once('error', () => finish(new Error('Python engine could not start')))
      child.once('exit', () => finish(new Error('Python engine exited before readiness')))
    })
  }

  /** Consecutive identity-probe failures; one blip on a busy engine is not
   *  evidence of death (opus N2 — a single-sample verdict was effectively
   *  terminal for the session before recovery existed, and even with
   *  recovery it forces a needless window reload). */
  private attachProbeFailures = 0

  /** Attached engines have no child to observe: probe identity when stats
   *  fail so a boot engine stopped underneath us reads as stopped, not as a
   *  forever-'ready' UI pointed at a dead port. Declares death only on TWO
   *  consecutive probe failures; recovery then re-attaches or spawns. */
  async verifyAttached(): Promise<void> {
    if (this.managed || !this.endpoint || this.status.state !== 'ready') return
    try {
      const response = await fetch(this.endpoint + '/api/desktop/identity',
        { headers: { [TOKEN_HEADER]: this.credential }, signal: AbortSignal.timeout(4000), redirect: 'error' })
      if (!response.ok) throw new Error(String(response.status))
      this.attachProbeFailures = 0
    } catch {
      this.attachProbeFailures += 1
      if (this.attachProbeFailures < 2) return
      // HTTP can only prove the engine ALIVE — a busy engine times out
      // exactly like a dead one. The death VERDICT is the guardian's root
      // lock releasing, the ONE signal held through the whole tree's
      // termination (opus measured it; descriptor absence proves only that
      // the host observed the engine exit, so it is not the verdict).
      const lockFile = this.attachedRoot ? path.join(this.attachedRoot, '.desktop-engine.lock') : ''
      this.attachProbeFailures = 0
      if (!this.guardianReleased(lockFile)) return // busy or terminating, not gone: keep the attachment
      this.endpoint = ''
      this.state({ state: 'stopped', message: 'Background engine stopped. Reconnecting…' })
    }
  }

  /** Autonomous recovery of a lost attachment (opus F2): re-attach if the
   *  host republished (its port persists, so usually the same origin with a
   *  NEW token), else spawn a managed engine, else — if the spawn was
   *  refused because a host mid-restart owns the root — wait it out briefly.
   *  Stays recoverable on failure: the poll loop simply tries again. */
  async recoverAttached(options: EngineOptions): Promise<'attached' | 'spawned' | 'failed'> {
    if (this.managed) return 'failed'
    this.endpoint = ''
    this.managed = true
    if (await this.attach(options)) return 'attached'
    try { await this.start(options); return 'spawned' }
    catch (error) {
      if (error instanceof Error && error.message.startsWith(ENGINE_REFUSED) && await this.attachWithRetry(options, 30000)) return 'attached'
      this.managed = false
      this.state({ state: 'stopped', message: 'Background engine stopped. Reconnecting…' })
      return 'failed'
    }
  }

  /** Can THIS process write byte 0 of the guardian's lock file? The
   *  guardian holds an exclusive byte-range lock there until the WHOLE
   *  engine tree is terminated, so a successful write (of the same byte the
   *  lock file always contains) proves the tree released the root — the
   *  proof root required beyond mere process exit. An absent or unknown file
   *  refuses release; any denied write counts as held. */
  private guardianReleased(lockFile: string): boolean {
    // FAIL CLOSED (opus): this is the one strong signal in the stop
    // conjunction, so "I could not look" — no path, no file — must refuse,
    // never pass. The guardian's lock FILE survives release (only the
    // byte-range lock is dropped), so a genuinely released root still has
    // the file and answers yes through the write probe.
    if (!lockFile || !fs.existsSync(lockFile)) return false
    try {
      const fd = fs.openSync(lockFile, 'r+')
      try { fs.writeSync(fd, Buffer.from('0'), 0, 1, 0) } finally { fs.closeSync(fd) }
      return true
    } catch { return false }
  }

  private attachedFile(name: string): string { return this.attachedRoot ? path.join(this.attachedRoot, name) : '' }

  /** Ask the attached engine to shut itself down, over its authenticated
   *  route. Nothing is concluded from the answer: a refusal and a timeout are
   *  equally uninformative about whether the process is going away, and
   *  `awaitAttachedRelease` is what decides. */
  private async requestAttachedShutdown(endpoint: string, timeoutMs = 5000): Promise<void> {
    if (timeoutMs <= 0) return
    try {
      await fetch(endpoint + '/api/desktop/shutdown', { method: 'POST', headers: { [TOKEN_HEADER]: this.credential }, signal: AbortSignal.timeout(timeoutMs), redirect: 'error' })
    } catch { /* liveness decides below */ }
  }

  /** Whether the attached engine's TREE has released this root, by three
   *  layered facts: the endpoint stops answering with a CONNECTION failure
   *  (a timeout is a busy engine, not a dead one), the attach descriptor
   *  disappears (the host deletes it only after the engine PROCESS exited),
   *  and the guardian's root lock releases (held until the whole tree is
   *  terminated).
   *
   *  ⚠ ONE BODY, TWO CALLERS, DELIBERATELY. The update REFUSES when a proof
   *  is missing and the quit FORCES, and those are the only two things that
   *  ever stop somebody else's engine. Written twice they would drift, and
   *  the day they disagree is the day one of them installs over a live
   *  engine. `endpointDead` rides out so each caller can name what it lacked. */
  private async awaitAttachedRelease(endpoint: string, descriptorFile: string, lockFile: string, deadlineMs: number): Promise<{ released: boolean; endpointDead: boolean }> {
    // A spent budget buys nothing: the probe below costs 2 s whatever the
    // deadline says, so a caller with nothing left must not be charged one.
    if (deadlineMs <= 0) return { released: false, endpointDead: false }
    const deadline = Date.now() + deadlineMs
    let endpointDead = !endpoint // startup failure has no announced endpoint
    for (;;) {
      if (!endpointDead) {
        try {
          await fetch(endpoint + '/api/desktop/identity', { headers: { [TOKEN_HEADER]: this.credential }, signal: AbortSignal.timeout(2000), redirect: 'error' })
        } catch (error) {
          // A TIMEOUT is a busy engine, not a dead one (root finding): only
          // a connection-level failure counts as the port closing.
          const name = error instanceof Error ? error.name : ''
          if (name !== 'TimeoutError' && name !== 'AbortError') endpointDead = true
        }
      }
      if (endpointDead && (!descriptorFile || !fs.existsSync(descriptorFile)) && this.guardianReleased(lockFile)) return { released: true, endpointDead }
      if (Date.now() >= deadline) return { released: false, endpointDead }
      await new Promise(resolve => setTimeout(resolve, 500))
    }
  }

  /** Graceful authenticated stop of the boot engine so an update can replace
   *  its files; the installer restarts the task afterwards. Throws — with no
   *  state disturbed — when any of the three proofs above is missing at the
   *  deadline, naming the missing one. */
  async stopAttachedForUpdate(deadlineMs = 15000): Promise<void> {
    if (this.managed || !this.endpoint) return
    const endpoint = this.endpoint
    const descriptorFile = this.attachedFile('engine-attach.json')
    const lockFile = this.attachedFile('.desktop-engine.lock')
    await this.requestAttachedShutdown(endpoint)
    const outcome = await this.awaitAttachedRelease(endpoint, descriptorFile, lockFile, deadlineMs)
    if (outcome.released) {
      this.endpoint = ''
      this.state({ state: 'stopped', message: 'Engine stopped' })
      return
    }
    if (!outcome.endpointDead) throw new Error('Background engine did not stop for the update')
    if (descriptorFile && fs.existsSync(descriptorFile)) throw new Error('Background engine port closed but its host has not confirmed process exit; refusing the update')
    throw new Error('Background engine tree release could not be established (guardian lock still held or unverifiable); refusing the update')
  }

  /** Terminate `pid` and every descendant, and wait for the request to be
   *  issued. On Windows that is taskkill /T /F: the engine's own death also
   *  drops the guardian's job object, so the two cover each other — /T walks
   *  the parent links and the job covers anything that has since reparented. */
  private forceKillTree(pid: number, timeoutMs = QUIT_DEADLINES.killMs): Promise<void> {
    return new Promise(resolve => {
      if (process.platform !== 'win32') { try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ } return resolve() }
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: Math.max(1, timeoutMs), windowsHide: true }, () => resolve())
    })
  }

  /** Whether the descriptor on disk is still byte-for-byte the one this
   *  attachment authenticated. A newer boot host publishes a NEW file, so a
   *  changed (or absent) descriptor says the root has moved on and the PID
   *  recorded here is not its engine — possibly not anyone's. */
  private descriptorUnchanged(descriptorFile: string): boolean {
    if (!descriptorFile || !this.attachedDescriptor) return false
    try { return fs.readFileSync(descriptorFile, 'utf8') === this.attachedDescriptor } catch { return false }
  }

  /** THE QUIT PATH — what an intentional "Quit Orgtree" must leave behind:
   *  nothing. `stop()` refuses an ATTACHED engine on purpose, because a
   *  window closing is not a reason to end a headless engine; measured on
   *  this machine, that same refusal is what let a tray-menu Quit leave the
   *  boot host, its engine, its guardian and every provider child running
   *  until the PC was rebooted, and what turned a maintenance RESTART into a
   *  restart of the window only.
   *
   *  Graceful first, then PROVEN by `awaitAttachedRelease`, then FORCED: a
   *  quit has nowhere to refuse to, so where the update path throws, this
   *  terminates the engine PID the descriptor names. Killing the engine is
   *  what takes the descendants: the guardian owns the only handle to their
   *  job and terminates it the moment the engine exits, and the boot host
   *  then observes its child gone and leaves on its own.
   *
   *  ⚠ THE FORCE IS GUARDED BY IDENTITY, NEVER BY A BARE PID, and neither
   *  guard is redundant. A RELEASED guardian lock means the tree is already
   *  gone — there is nothing to kill, and that PID may since have been handed
   *  to anything. A CHANGED descriptor means a newer host owns this root, so
   *  the PID recorded here is not its engine. Only what can still be shown to
   *  be the tree this window authenticated is ever terminated. */
  async stopForQuit(deadlineMs = QUIT_STOP_BUDGET_MS): Promise<'stopped' | 'forced' | 'unverified'> {
    // ONE budget, apportioned. Every wait below takes what is left of it, and
    // the graceful half always leaves the forced half its share — otherwise a
    // slow engine would eat the whole budget on asking nicely and the
    // termination that the asking failed to achieve would never be attempted.
    const until = Date.now() + deadlineMs
    const left = (): number => Math.max(0, until - Date.now())
    // What the graceful half must leave behind. Capped at HALF the budget so
    // a caller with less than the full sum still gets to ask nicely — the
    // reserve exists to stop the asking eating everything, not to make a
    // short budget skip it altogether.
    const reserve = Math.min(QUIT_DEADLINES.killMs + QUIT_DEADLINES.provenMs, Math.floor(deadlineMs / 2))
    const graceful = (want: number): number => Math.max(0, Math.min(want, left() - reserve))
    if (this.managed) {
      // Our own child: stop() already asks, waits and kills, and the guardian
      // takes the tree with it. Only the CONFIRMATION is new — stop()
      // resolving is not death — and the force covers a child that ignored
      // the signal (a kill() is a request, exactly as it is for the update).
      await this.stop()
      if (await this.stoppedConfirmed(graceful(QUIT_DEADLINES.releaseMs))) return 'stopped'
      const pid = this.child?.pid
      if (!pid) return 'unverified'
      await this.forceKillTree(pid, Math.min(QUIT_DEADLINES.killMs, left()))
      return await this.stoppedConfirmed(Math.min(QUIT_DEADLINES.provenMs, left())) ? 'forced' : 'unverified'
    }
    if (!this.endpoint) return 'stopped'
    const endpoint = this.endpoint
    const descriptorFile = this.attachedFile('engine-attach.json')
    const lockFile = this.attachedFile('.desktop-engine.lock')
    const settled = (): void => { this.endpoint = ''; this.state({ state: 'stopped', message: 'Engine stopped' }) }
    this.stopping = true
    await this.requestAttachedShutdown(endpoint, graceful(QUIT_DEADLINES.requestMs))
    if ((await this.awaitAttachedRelease(endpoint, descriptorFile, lockFile, graceful(QUIT_DEADLINES.releaseMs))).released) { settled(); return 'stopped' }
    if (this.attachedEnginePid <= 0 || !this.descriptorUnchanged(descriptorFile) || this.guardianReleased(lockFile)) return 'unverified'
    await this.forceKillTree(this.attachedEnginePid, Math.min(QUIT_DEADLINES.killMs, left()))
    if ((await this.awaitAttachedRelease(endpoint, descriptorFile, lockFile, Math.min(QUIT_DEADLINES.provenMs, left()))).released) { settled(); return 'forced' }
    return 'unverified'
  }

  async stats(): Promise<RuntimeStats | null> {
    if (!this.endpoint) return null
    try {
      const r = await fetch(this.endpoint + '/api/desktop/status', { headers: { [TOKEN_HEADER]: this.credential }, signal: AbortSignal.timeout(4000), redirect: 'error' })
      if (!r.ok) return null
      const value = await r.json() as RuntimeStats
      if (!Number.isInteger(value.activeAgents) || !Number.isInteger(value.totalAgents) || value.activeAgents < 0 || value.totalAgents < value.activeAgents || typeof value.idle !== 'boolean' || (value.idle && value.activeAgents > 0)) return null
      const maintenance = maintenanceRequest(value.maintenance)
      return { activeAgents: value.activeAgents, totalAgents: value.totalAgents, idle: value.idle, ...(maintenance ? { maintenance } : {}) }
    } catch { return null }
  }

  /** The per-org rows behind the tray's primary-click list, fetched on
   *  demand (a click), never on the poll — GET /api/orgs parses every org
   *  document server-side, which is fine per click and waste per 5 s tick. */
  async orgActivity(): Promise<OrgActivityRow[] | null> {
    if (!this.endpoint) return null
    try {
      const r = await fetch(this.endpoint + '/api/orgs', { headers: { [TOKEN_HEADER]: this.credential }, signal: AbortSignal.timeout(4000), redirect: 'error' })
      if (!r.ok) return null
      return orgActivityRows(await r.json())
    } catch { return null }
  }

  async acknowledgeMaintenance(id: string, outcome: 'execute' | 'up-to-date'): Promise<boolean> {
    if (!this.endpoint) return false
    try {
      const response = await fetch(this.endpoint + '/api/desktop/maintenance/ack', { method: 'POST',
        headers: { [TOKEN_HEADER]: this.credential, 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, outcome }), signal: AbortSignal.timeout(4000), redirect: 'error' })
      if (!response.ok) return false
      const result = await response.json() as { accepted?: boolean }
      return result.accepted === true
    } catch { throw new Error('Maintenance acknowledgment could not be confirmed') }
  }

  async reportMaintenanceFailure(id: string): Promise<boolean> {
    if (!this.endpoint) return false
    try {
      const response = await fetch(this.endpoint + '/api/desktop/maintenance/failure', { method: 'POST',
        headers: { [TOKEN_HEADER]: this.credential, 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }), signal: AbortSignal.timeout(4000), redirect: 'error' })
      if (!response.ok) return false
      return (await response.json() as { released?: boolean }).released === true
    } catch { return false }
  }

  /** Whether the engine process is OBSERVED to be gone. stop() resolving is
   *  NOT that: it returns immediately after child.kill(), which only REQUESTS
   *  termination. An attached boot engine is excluded because it is never this
   *  process's to stop - stopAttachedForUpdate proves that one separately, by
   *  its own three-fact conjunction. */
  async stoppedConfirmed(deadlineMs = 5000): Promise<boolean> {
    if (!this.managed) return !this.endpoint
    const deadline = Date.now() + deadlineMs
    for (;;) {
      if (!this.child || this.child.exitCode !== null || this.child.signalCode !== null) return true
      if (Date.now() >= deadline) return false
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }

  async stop(): Promise<void> {
    // An attached boot-host engine outlives this window by design; only the
    // host (or the operator's task controls) stops it.
    if (!this.managed) return
    this.stopping = true
    const child = this.child
    if (!child || child.exitCode !== null) return
    if (this.endpoint) {
      try { await fetch(this.endpoint + '/api/desktop/shutdown', { method: 'POST', headers: { [TOKEN_HEADER]: this.credential }, signal: AbortSignal.timeout(3000), redirect: 'error' }) } catch { /* bounded fallback for our child below */ }
    }
    if (child.exitCode !== null) return
    await new Promise<void>(resolve => { const timer = setTimeout(resolve, 5000); child.once('exit', () => { clearTimeout(timer); resolve() }) })
    if (child.exitCode === null) child.kill()
  }
}
