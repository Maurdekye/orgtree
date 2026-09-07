import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { parseReady, TOKEN_HEADER, validateDataRoot } from './policy'
import type { EngineStatus } from '../../../packages/contracts/index'
import { maintenanceRequest, type MaintenanceRequest } from './maintenance'

export interface EngineOptions { python: string; directory: string; dataRoot: string; forbiddenRoot: string; uiDirectory: string; timeoutMs?: number }
export interface RuntimeStats { activeAgents: number; totalAgents: number; idle: boolean; maintenance?: MaintenanceRequest }

/** One fresh managed child. Never discovers or attaches by a .port file. */
export class Engine extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams
  private credential = randomBytes(32).toString('hex')
  private endpoint = ''
  private stopping = false
  status: EngineStatus = { state: 'starting' }
  get origin(): string { return this.endpoint }
  // Main-process only; never include this field in bridge responses or logs.
  get token(): string { return this.credential }
  private state(status: EngineStatus) { this.status = status; this.emit('status', status) }

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
    child.on('exit', () => { this.endpoint = ''; this.state({ state: 'stopped', message: this.stopping ? 'Engine stopped' : 'Engine exited. Restart Orgtree to recover.' }) })
    await new Promise<void>((resolve, reject) => {
      let buffered = '', settled = false
      const finish = (error?: Error) => {
        if (settled) return
        settled = true; clearTimeout(timer); child.stdout.off('data', onData)
        child.stdout.resume()
        if (error) { child.kill(); this.state({ state: 'unavailable', message: error.message }); reject(error) } else resolve()
      }
      const onData = (chunk: Buffer) => {
        buffered += chunk.toString('utf8')
        if (buffered.length > 65536) return finish(new Error('Engine readiness exceeded size limit'))
        while (buffered.includes('\n')) {
          const at = buffered.indexOf('\n'), line = buffered.slice(0, at).trim(); buffered = buffered.slice(at + 1)
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

  async acknowledgeMaintenance(id: string): Promise<boolean> {
    if (!this.endpoint) return false
    try {
      const response = await fetch(this.endpoint + '/api/desktop/maintenance/ack', { method: 'POST',
        headers: { [TOKEN_HEADER]: this.credential, 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }), signal: AbortSignal.timeout(4000), redirect: 'error' })
      if (!response.ok) return false
      const result = await response.json() as { accepted?: boolean }
      return result.accepted === true
    } catch { return false }
  }

  async stop(): Promise<void> {
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
