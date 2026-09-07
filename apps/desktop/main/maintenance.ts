import fs from 'node:fs'
import path from 'node:path'

export interface MaintenanceRequest { id: string; action: 'restart' | 'update'; target: 'org' | 'mailhub' | 'both'; reason: string }

export function maintenanceRequest(value: unknown): MaintenanceRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  if (typeof row.id !== 'string' || !row.id || row.id.length > 200
    || !['restart', 'update'].includes(String(row.action))
    || !['org', 'mailhub', 'both'].includes(String(row.target))
    || typeof row.reason !== 'string' || row.reason.length > 4000) return null
  return { id: row.id, action: row.action as MaintenanceRequest['action'], target: row.target as MaintenanceRequest['target'], reason: row.reason }
}

interface Callbacks {
  ack: (id: string, outcome: 'execute' | 'up-to-date') => Promise<boolean>
  restart: () => Promise<void>
  apply: () => Promise<void>
  check: () => Promise<'pending' | 'up-to-date' | 'unavailable'>
  report: (state: string) => void
  failure: (id: string) => Promise<boolean>
  now?: () => number
}

/** Engine owns authorization and durable requests; Electron owns its updater. */
export class MaintenanceController {
  private running = false
  private consumed = new Set<string>()
  private checked = new Map<string, number>()
  private currentVersion = new Set<string>()
  private failures = new Set<string>()
  private automaticBlocked = false
  constructor(private callbacks: Callbacks, private failureFile?: string) {
    if (failureFile) {
      try {
        const saved = JSON.parse(fs.readFileSync(failureFile, 'utf8'))
        const pending = Array.isArray(saved) ? saved : saved?.pending
        this.automaticBlocked = saved?.automaticBlocked === true
        if (Array.isArray(pending)) for (const id of pending.slice(0, 1000)) {
          if (typeof id === 'string' && id.length > 0 && id.length <= 200) {
            this.failures.add(id); this.consumed.add(id)
          }
        }
      } catch { /* First launch has no pending failure acknowledgments. */ }
    }
  }
  hasFailures() { return this.failures.size > 0 }
  automaticUpdatesAllowed() { return !this.automaticBlocked }

  private saveFailures() {
    if (!this.failureFile) return
    try {
      fs.mkdirSync(path.dirname(this.failureFile), { recursive: true })
      fs.writeFileSync(this.failureFile + '.tmp', JSON.stringify({ pending: [...this.failures], automaticBlocked: this.automaticBlocked }), { mode: 0o600 })
      fs.renameSync(this.failureFile + '.tmp', this.failureFile)
    } catch { this.callbacks.report('failure-record-unavailable') }
  }

  private async recover(id: string) {
    try {
      if (await this.callbacks.failure(id)) { this.failures.delete(id); this.saveFailures() }
    } catch { /* Retry only the failure report, never uncertain native execution. */ }
  }

  private async failed(id: string) {
    this.consumed.add(id); this.failures.add(id); this.automaticBlocked = true; this.saveFailures()
    this.callbacks.report('failed')
    await this.recover(id)
  }

  async tick(status: { idle: boolean; maintenance?: MaintenanceRequest } | null, userIdle: number, downloaded: boolean) {
    if (this.running) return
    this.running = true
    try {
      for (const id of this.failures) await this.recover(id)
      if (!status?.idle || userIdle < 60) return
      const request = status.maintenance
      if (!request || this.consumed.has(request.id)) return
      if (request.action === 'update' && !downloaded && !this.currentVersion.has(request.id)) {
        const now = (this.callbacks.now ?? Date.now)(), previous = this.checked.get(request.id)
        if (previous !== undefined && now - previous < 60000) return
        this.checked.set(request.id, now)
        const state = await this.callbacks.check()
        if (state === 'up-to-date') this.currentVersion.add(request.id)
        this.callbacks.report(state)
        // An asynchronous update check may outlive the idle observation.
        // Consumption/application needs a fresh engine+OS idle sample next tick.
        return
      }
      const outcome = request.action === 'update' && !downloaded ? 'up-to-date' : 'execute'
      try {
        if (!await this.callbacks.ack(request.id, outcome)) return
      } catch {
        // The engine may have accepted an acknowledgment whose response was lost.
        // Resolve it as a failed request; do not guess that execution is safe.
        await this.failed(request.id); return
      }
      this.consumed.add(request.id)
      if (this.consumed.size > 1000) this.consumed.delete(this.consumed.values().next().value!)
      this.checked.delete(request.id)
      this.currentVersion.delete(request.id)
      if (request.action === 'update') { this.automaticBlocked = false; this.saveFailures() }
      try {
        if (request.action === 'restart') await this.callbacks.restart()
        else if (downloaded) await this.callbacks.apply()
        else this.callbacks.report('up-to-date')
      } catch { await this.failed(request.id) }
    } finally { this.running = false }
  }
}
