export type UpdateState = 'idle' | 'checking' | 'downloading' | 'pending-idle' | 'up-to-date' | 'unavailable' | 'failed'
export interface UpdateStatus { state: UpdateState; version?: string; percent?: number }

interface UpdateCallbacks {
  /** Wraps the real updater's checkForUpdates(); autoDownload happens on its own once resolved. */
  run: () => Promise<{ hasUpdate: boolean; version?: string }>
  report: (status: UpdateStatus) => void
  now?: () => number
}

interface UpdateOptions {
  /** Interval between unprompted background checks while nothing is known to be pending. Default 6h. */
  periodicMs?: number
  /** Base delay before retrying after a failed check; doubles per consecutive failure, capped at periodicMs. */
  backoffBaseMs?: number
}

/** Owns WHEN to check and how failures back off; the real electron-updater call and its
 *  download/error events are wired in by the caller through run()/progress()/downloaded()/errored(). */
export class UpdateController {
  private status: UpdateStatus = { state: 'idle' }
  private inFlight: Promise<UpdateStatus> | null = null
  private lastCheckAt: number | null = null
  private consecutiveFailures = 0
  private nextRetryAt = 0
  private readonly now: () => number
  private readonly periodicMs: number
  private readonly backoffBaseMs: number

  constructor(private callbacks: UpdateCallbacks, options: UpdateOptions = {}) {
    this.now = callbacks.now ?? Date.now
    this.periodicMs = options.periodicMs ?? 6 * 60 * 60 * 1000
    this.backoffBaseMs = options.backoffBaseMs ?? 5 * 60 * 1000
  }

  current() { return this.status }

  /** Drive from a periodic poll (e.g. every 5s, matching the existing engine poll cadence);
   *  only actually checks the network when due, and never while a real update is already known. */
  async tick(): Promise<void> {
    if (this.inFlight) return
    if (this.status.state === 'downloading' || this.status.state === 'pending-idle') return
    const now = this.now()
    // lastCheckAt is only set on success, so a failure must be judged solely by nextRetryAt -
    // otherwise "never succeeded yet" would keep looking like "never checked yet" and skip backoff entirely.
    const due = this.consecutiveFailures > 0
      ? now >= this.nextRetryAt
      : this.lastCheckAt === null || now - this.lastCheckAt >= this.periodicMs
    if (!due) return
    await this.runCheck()
  }

  /** A user-triggered check. Coalesces with any in-flight check and bypasses backoff, but a
   *  known-pending update is reported as-is rather than redundantly re-checked. */
  async check(): Promise<UpdateStatus> {
    if (this.inFlight) return this.inFlight
    if (this.status.state === 'downloading' || this.status.state === 'pending-idle') {
      this.callbacks.report(this.status)
      return this.status
    }
    return this.runCheck()
  }

  /** Forwards electron-updater's download-progress event; ignored outside an active download. */
  progress(percent: number) {
    if (this.status.state !== 'downloading') return
    this.setStatus({ state: 'downloading', version: this.status.version, percent })
  }

  /** Forwards electron-updater's update-downloaded event. */
  downloaded(version?: string) {
    this.consecutiveFailures = 0
    this.setStatus({ state: 'pending-idle', version: version ?? this.status.version })
  }

  /** Forwards electron-updater's error event, which can fire mid-download after a successful check. */
  errored() {
    this.consecutiveFailures++
    this.nextRetryAt = this.now() + Math.min(this.periodicMs, this.backoffBaseMs * 2 ** (this.consecutiveFailures - 1))
    this.setStatus({ state: 'failed' })
  }

  private setStatus(status: UpdateStatus) {
    this.status = status
    this.callbacks.report(status)
  }

  private async runCheck(): Promise<UpdateStatus> {
    this.setStatus({ state: 'checking' })
    const promise = (async () => {
      try {
        const result = await this.callbacks.run()
        this.consecutiveFailures = 0
        this.lastCheckAt = this.now()
        this.setStatus(result.hasUpdate ? { state: 'downloading', version: result.version } : { state: 'up-to-date' })
      } catch {
        this.consecutiveFailures++
        this.nextRetryAt = this.now() + Math.min(this.periodicMs, this.backoffBaseMs * 2 ** (this.consecutiveFailures - 1))
        this.setStatus({ state: 'unavailable' })
      } finally { this.inFlight = null }
      return this.status
    })()
    this.inFlight = promise
    return promise
  }
}
