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
  now?: () => number
}

/** Engine owns authorization and durable requests; Electron owns its updater. */
export class MaintenanceController {
  private running = false
  private consumed = new Set<string>()
  private checked = new Map<string, number>()
  private currentVersion = new Set<string>()
  constructor(private callbacks: Callbacks) {}

  async tick(status: { idle: boolean; maintenance?: MaintenanceRequest } | null, userIdle: number, downloaded: boolean) {
    if (this.running || !status?.idle || userIdle < 60) return
    const request = status.maintenance
    if (!request || this.consumed.has(request.id)) return
    this.running = true
    try {
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
      if (!await this.callbacks.ack(request.id, outcome)) return
      this.consumed.add(request.id)
      if (this.consumed.size > 1000) this.consumed.delete(this.consumed.values().next().value!)
      this.checked.delete(request.id)
      this.currentVersion.delete(request.id)
      if (request.action === 'restart') await this.callbacks.restart()
      else if (downloaded) await this.callbacks.apply()
      else this.callbacks.report('up-to-date')
    } finally { this.running = false }
  }
}
