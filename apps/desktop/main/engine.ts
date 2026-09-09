import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { canonicalPath, parseAttach, parseReady, parseRefusal, TOKEN_HEADER, validateDataRoot } from './policy'

export const ENGINE_REFUSED = 'Engine start refused: '
import type { EngineStatus } from '../../../packages/contracts/index'
import { maintenanceRequest, type MaintenanceRequest } from './maintenance'

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
  /** Why the last attach attempt was declined; empty when no descriptor existed. */
  attachDiagnostic = ''
  status: EngineStatus = { state: 'starting' }
  get origin(): string { return this.endpoint }
  // Main-process only; never include this field in bridge responses or logs.
  get token(): string { return this.credential }
  private state(status: EngineStatus) { this.status = status; this.emit('status', status) }

  /** Adopt a boot-host engine when a verifiable descriptor exists. Returns
   *  false (and records why) on any doubt so the caller falls back to a
   *  fresh managed spawn; the engine-side root lock arbitrates races. */
  /** Keep trying to attach for a bounded window. A missing descriptor only
   *  means no host has FINISHED starting — during the boot race the host may
   *  need most of its readiness budget before the file exists. */
  async attachWithRetry(options: Pick<EngineOptions, 'dataRoot' | 'forbiddenRoot'>, deadlineMs = 90000, intervalMs = 1000): Promise<boolean> {
    const deadline = Date.now() + deadlineMs
    for (;;) {
      if (await this.attach(options)) return true
      if (Date.now() >= deadline) return false
      await new Promise(resolve => setTimeout(resolve, intervalMs))
    }
  }

  async attach(options: Pick<EngineOptions, 'dataRoot' | 'forbiddenRoot'>): Promise<boolean> {
    // A child that already EXITED (a spawn that lost the boot race) does not
    // block attachment; a live child or an existing attachment does.
    if ((this.child && this.child.exitCode === null) || !this.managed) throw new Error('Engine already started')
    const root = validateDataRoot(options.dataRoot, options.forbiddenRoot)
    if (!fs.existsSync(root)) return false
    const realRoot = fs.realpathSync.native(root)
    const file = path.join(realRoot, 'engine-attach.json')
    let raw: string
    try { raw = fs.readFileSync(file, 'utf8') } catch { return false }
    try {
      const attach = parseAttach(raw, realRoot)
      const origin = `http://127.0.0.1:${attach.port}`
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
    child.on('exit', () => {
      // A child disowned by a failed spawn must not clobber a later attach.
      if (this.child !== child) return
      this.endpoint = ''; this.state({ state: 'stopped', message: this.stopping ? 'Engine stopped' : 'Engine exited. Restart Orgtree to recover.' })
    })
    await new Promise<void>((resolve, reject) => {
      let buffered = '', settled = false
      const finish = (error?: Error) => {
        if (settled) return
        settled = true; clearTimeout(timer); child.stdout.off('data', onData)
        child.stdout.resume()
        // A failed spawn no longer occupies this engine: the boot-race path
        // retries attach() on the same instance after a structured refusal.
        if (error) { child.kill(); this.child = undefined; this.state({ state: 'unavailable', message: error.message }); reject(error) } else resolve()
      }
      const onData = (chunk: Buffer) => {
        buffered += chunk.toString('utf8')
        if (buffered.length > 65536) return finish(new Error('Engine readiness exceeded size limit'))
        while (buffered.includes('\n')) {
          const at = buffered.indexOf('\n'), line = buffered.slice(0, at).trim(); buffered = buffered.slice(at + 1)
          const refusal = parseRefusal(line)
          if (refusal) return finish(new Error(ENGINE_REFUSED + refusal))
          try {
            const ready = parseReady(line, realRoot, child.pid ?? -1)
            if (ready) { this.endpoint = `http://127.0.0.1:${ready.port}`; this.state({ state: 'ready' }); finish(); return }
          } catch (error) { finish(error as Error); return }
        }
      }
      const timer = setTimeout(() => finish(new Error('Engine did not become ready in time')), options.timeoutMs ?? 60000)
      child.stdout.on('data', onData)
      child.once('error', () => finish(new Error('Python engine could not start')))
      child.once('exit', () => finish(new Error('Python engine exited before readiness')))
    })
  }

  /** Attached engines have no child to observe: probe identity when stats
   *  fail so a boot engine stopped underneath us reads as stopped, not as a
   *  forever-'ready' UI pointed at a dead port. */
  async verifyAttached(): Promise<void> {
    if (this.managed || !this.endpoint || this.status.state !== 'ready') return
    try {
      const response = await fetch(this.endpoint + '/api/desktop/identity',
        { headers: { [TOKEN_HEADER]: this.credential }, signal: AbortSignal.timeout(4000), redirect: 'error' })
      if (!response.ok) throw new Error(String(response.status))
    } catch {
      this.endpoint = ''
      this.state({ state: 'stopped', message: 'Background engine stopped. Restart Orgtree to reconnect.' })
    }
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
