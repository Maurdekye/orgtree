export type UpdateState = 'idle' | 'checking' | 'downloading' | 'pending-idle' | 'up-to-date' | 'unavailable' | 'failed'
export interface UpdateStatus { state: UpdateState; version?: string; percent?: number }

/** Update controls stay in one native menu, so progress also changes while open. */
export function trayUpdateState(status: UpdateStatus, downloaded: boolean, applying: boolean) {
  const version = status.version ? ` ${status.version}` : ''
  const labels: Record<UpdateState, string> = {
    idle: 'Updates have not been checked', checking: 'Checking for updates...',
    downloading: `Downloading update${version}${Number.isFinite(status.percent) ? ` - ${Math.max(0, Math.min(100, Math.round(status.percent!)))}%` : '...'}`,
    'pending-idle': `Update${version} ready to install`,
    'up-to-date': 'Orgtree is up to date', unavailable: 'Updates are unavailable',
    failed: 'Update failed - check again',
  }
  return {
    label: applying ? 'Installing update...' : downloaded ? labels['pending-idle'] : labels[status.state],
    installVisible: downloaded, installEnabled: downloaded && !applying,
    checkEnabled: !applying && !downloaded && status.state !== 'checking' && status.state !== 'downloading',
  }
}

export function refreshTrayUpdateMenu(menu: { getMenuItemById(id: string): {
  label: string; enabled: boolean; visible: boolean
} | null }, status: UpdateStatus, downloaded: boolean, applying: boolean): void {
  const view = trayUpdateState(status, downloaded, applying)
  const label = menu.getMenuItemById('update-status')
  const install = menu.getMenuItemById('update-install')
  const check = menu.getMenuItemById('update-check')
  if (label) label.label = view.label
  if (install) { install.visible = view.installVisible; install.enabled = view.installEnabled }
  if (check) check.enabled = view.checkEnabled
}

/** NSIS already supports --updated /S --force-run. Keep the running install's
 * directory; the bundled installer reads its previous scope from the registry. */
export function installDownloadedUpdate(updater: {
  installDirectory?: string
  quitAndInstall(silent: boolean, runAfter: boolean): void
}, directory: string): void {
  updater.installDirectory = directory
  updater.quitAndInstall(true, true)
}

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

  /** Forwards electron-updater's 'error' event. That event ALSO fires for a check-time failure
   *  that run()'s own rejection already reports through runCheck()'s catch below - Node calls
   *  every listener on an emitter, so without this guard the same single failure would double-
   *  increment the backoff and the final displayed state would race between two independent
   *  writers. A genuine download-stage failure only exists once state is already 'downloading'
   *  (i.e. run() already resolved hasUpdate:true for this cycle); anything else is that same
   *  check-time failure arriving a second time, and is a no-op here. */
  errored() {
    if (this.status.state !== 'downloading') return
    this.scheduleBackoff()
    this.setStatus({ state: 'failed' })
  }

  private setStatus(status: UpdateStatus) {
    this.status = status
    this.callbacks.report(status)
  }

  private scheduleBackoff() {
    this.consecutiveFailures++
    this.nextRetryAt = this.now() + Math.min(this.periodicMs, this.backoffBaseMs * 2 ** (this.consecutiveFailures - 1))
  }

  private async runCheck(): Promise<UpdateStatus> {
    this.setStatus({ state: 'checking' })
    const promise = (async () => {
      try {
        const result = await this.callbacks.run()
        this.consecutiveFailures = 0
        this.lastCheckAt = this.now()
        // A fast/cached autoDownload can fire downloaded() (or errored(), once
        // state reaches 'downloading') BEFORE run()'s own promise settles -
        // Node dispatches 'update-available' and 'update-downloaded' as separate
        // synchronous events, and this continuation only resumes on the next
        // microtask after the first. Once state has moved past 'checking' the
        // terminal event already won; overwriting it back to downloading/up-to-
        // date here would regress a real pending-idle/failed result.
        if (this.status.state === 'checking') {
          this.setStatus(result.hasUpdate ? { state: 'downloading', version: result.version } : { state: 'up-to-date' })
        }
      } catch {
        if (this.status.state === 'checking') {
          this.scheduleBackoff()
          this.setStatus({ state: 'unavailable' })
        }
      } finally { this.inFlight = null }
      return this.status
    })()
    this.inFlight = promise
    return promise
  }
}

/** The actual "is there a newer release" answer belongs to electron-updater's own
 *  update-available/update-not-available events, not to comparing version strings here -
 *  it already knows the channel/prerelease/downgrade rules a naive `!==` would get wrong
 *  (an older or disallowed release could differ from the running version too). */
export interface UpdaterEvents {
  checkForUpdates: () => Promise<unknown>
  once: (event: 'update-available' | 'update-not-available' | 'error', listener: (arg?: unknown) => void) => void
  removeListener: (event: 'update-available' | 'update-not-available' | 'error', listener: (arg?: unknown) => void) => void
}

export function checkForUpdatesViaEvents(updater: UpdaterEvents): Promise<{ hasUpdate: boolean; version?: string }> {
  return new Promise((resolve, reject) => {
    let settled = false
    const cleanup = () => {
      updater.removeListener('update-available', onAvailable)
      updater.removeListener('update-not-available', onNotAvailable)
      updater.removeListener('error', onError)
    }
    const settle = (fn: () => void) => { if (settled) return; settled = true; cleanup(); fn() }
    const onAvailable = (info?: unknown) => settle(() => resolve({
      hasUpdate: true,
      version: info && typeof info === 'object' && 'version' in info && typeof (info as { version: unknown }).version === 'string'
        ? (info as { version: string }).version : undefined,
    }))
    const onNotAvailable = () => settle(() => resolve({ hasUpdate: false }))
    const onError = (err?: unknown) => settle(() => reject(err instanceof Error ? err : new Error(String(err))))
    updater.once('update-available', onAvailable)
    updater.once('update-not-available', onNotAvailable)
    updater.once('error', onError)
    // A falsy/undefined result (no feed configured, dev-mode short-circuit inside
    // electron-updater) never emits either event - without this the promise would hang.
    updater.checkForUpdates().then(result => { if (!result) settle(() => resolve({ hasUpdate: false })) }).catch(onError)
  })
}
