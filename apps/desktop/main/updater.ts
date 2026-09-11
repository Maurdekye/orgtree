import fs from 'node:fs'
import path from 'node:path'

export type UpdateState = 'idle' | 'checking' | 'downloading' | 'pending-idle' | 'up-to-date' | 'unavailable' | 'failed'
export interface UpdateStatus { state: UpdateState; version?: string; percent?: number }

// ------------------------------------------------------------ diagnostics
// 2.0.3 failed twice and left NOTHING behind: electron-updater's logger
// defaults to `console`, which a packaged Windows GUI process discards, and
// the only 'error' listener threw its argument away. Every stage of an
// application attempt is now written to disk, sanitized, so the next launch
// (and the operator) can say what actually happened.

export type UpdateStage =
  | 'attempt'                  /* an application attempt began */
  | 'engine-stopped'           /* the attached boot engine was verifiably stopped */
  | 'held'                     /* the attempt was refused before anything was disturbed */
  | 'layout' | 'layout-timeout'
  | 'engine-shutdown' | 'engine-shutdown-timeout'
  | 'handoff'                  /* electron-updater accepted the install request */
  | 'handoff-refused'          /* it declined, and will therefore never quit the app */
  | 'watchdog-exit'            /* preparation outlived its deadline */
  | 'updater'                  /* a line from electron-updater's own logger */
  | 'error'
  | 'not-installed'            /* a handoff happened but the version did not change */

export interface UpdateLogEntry { at: string; stage: UpdateStage; detail?: string; from?: string; to?: string }

// A feed URL can carry signed query credentials and our own errors can carry
// the engine token; neither belongs in a file the operator may send on.
const REDACTIONS: { pattern: RegExp; keepPrefix: boolean }[] = [
  { pattern: /([?&](?:token|access_token|refresh_token|signature|sig|key|password|credential|x-amz-[a-z0-9-]+)=)[^&\s"']*/gi, keepPrefix: true },
  { pattern: /\b[0-9a-f]{32,}\b/gi, keepPrefix: false },
]

export function sanitizeUpdateDetail(value: unknown, limit = 400): string {
  let text = value instanceof Error ? (value.message || String(value))
    : typeof value === 'string' ? value
    : (() => { try { return JSON.stringify(value) ?? String(value) } catch { return String(value) } })()
  text = text.replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim()
  for (const { pattern, keepPrefix } of REDACTIONS) {
    text = text.replace(pattern, (_match, prefix: string | undefined) => (keepPrefix && prefix ? prefix : '') + '[redacted]')
  }
  return text.length > limit ? text.slice(0, limit) + '...' : text
}

const isLogEntry = (value: unknown): value is UpdateLogEntry => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  return typeof row.at === 'string' && typeof row.stage === 'string'
}

/** A bounded, append-only record of update attempts, kept beside the other
 *  desktop state files. Never throws: losing the log must never be able to
 *  break the update it is describing. */
export class UpdateLog {
  private entries: UpdateLogEntry[] = []
  private readonly now: () => number
  constructor(private readonly file?: string, private readonly limit = 200, now?: () => number) {
    this.now = now ?? Date.now
    if (file) {
      try {
        const saved: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
        if (Array.isArray(saved)) this.entries = saved.filter(isLogEntry).slice(-limit)
      } catch { /* first launch, or an unreadable log: start a new one */ }
    }
  }

  all(): UpdateLogEntry[] { return [...this.entries] }

  record(stage: UpdateStage, detail?: unknown, versions?: { from?: string; to?: string }): UpdateLogEntry {
    const entry: UpdateLogEntry = { at: new Date(this.now()).toISOString(), stage }
    if (detail !== undefined) entry.detail = sanitizeUpdateDetail(detail)
    if (versions?.from) entry.from = versions.from
    if (versions?.to) entry.to = versions.to
    this.entries.push(entry)
    if (this.entries.length > this.limit) this.entries = this.entries.slice(-this.limit)
    this.save()
    return entry
  }

  /** Every entry since the most recent attempt, oldest first; empty if none. */
  lastAttempt(): UpdateLogEntry[] {
    for (let i = this.entries.length - 1; i >= 0; i--) if (this.entries[i]!.stage === 'attempt') return this.entries.slice(i)
    return []
  }

  private save() {
    if (!this.file) return
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.entries), { mode: 0o600 })
      fs.renameSync(this.file + '.tmp', this.file)
    } catch { /* diagnostics are never worth failing an update over */ }
  }
}

/** electron-updater's Logger shape. Its own info lines name the installer, its
 *  arguments and the exact spawn failure - the single most useful record there
 *  is, and previously thrown away. */
export function updateLogger(log: UpdateLog) {
  return {
    info: (message?: unknown) => { log.record('updater', message) },
    warn: (message?: unknown) => { log.record('updater', message) },
    error: (message?: unknown) => { log.record('error', message) },
  }
}

/** Resolve a promise that may never settle. Returns 'timeout' instead of
 *  hanging, and 'error' instead of throwing, so a caller mid-shutdown always
 *  gets to its next step. Measured need: webContents.executeJavaScript does
 *  NOT settle on a busy renderer, and does not settle even when that renderer
 *  is destroyed or force-crashed. */
export function bounded<T>(work: Promise<T>, ms: number): Promise<'ok' | 'timeout' | { error: unknown }> {
  return new Promise(resolve => {
    let settled = false
    const deadline = setTimeout(() => finish('timeout'), ms)
    function finish(outcome: 'ok' | 'timeout' | { error: unknown }) {
      if (settled) return
      settled = true
      // Cleared so work that DID finish does not hold the event loop open for
      // the rest of its deadline, and so a late settle cannot resolve twice.
      clearTimeout(deadline)
      resolve(outcome)
    }
    work.then(() => finish('ok'), error => finish({ error }))
  })
}

/** Update controls stay in one native menu, so progress also changes while open. */
export function trayUpdateState(status: UpdateStatus, downloaded: boolean, applying: boolean, hold?: string) {
  const version = status.version ? ` ${status.version}` : ''
  const labels: Record<UpdateState, string> = {
    idle: 'Updates have not been checked', checking: 'Checking for updates...',
    downloading: `Downloading update${version}${Number.isFinite(status.percent) ? ` - ${Math.max(0, Math.min(100, Math.round(status.percent!)))}%` : '...'}`,
    'pending-idle': `Update${version} ready to install`,
    'up-to-date': 'Orgtree is up to date', unavailable: 'Updates are unavailable',
    failed: 'Update failed - check again',
  }
  // A held update is still installable BY HAND - that is the whole point of
  // holding it - so the install item stays enabled and only the status line
  // changes. Applying outranks the hold: it describes work already under way.
  const ready = downloaded ? (hold ? `Update${version}: ${hold}` : labels['pending-idle']) : labels[status.state]
  return {
    label: applying ? 'Installing update...' : ready,
    installVisible: downloaded, installEnabled: downloaded && !applying,
    checkEnabled: !applying && !downloaded && status.state !== 'checking' && status.state !== 'downloading',
  }
}

export function refreshTrayUpdateMenu(menu: { getMenuItemById(id: string): {
  label: string; enabled: boolean; visible: boolean
} | null }, status: UpdateStatus, downloaded: boolean, applying: boolean, hold?: string): void {
  const view = trayUpdateState(status, downloaded, applying, hold)
  const label = menu.getMenuItemById('update-status')
  const install = menu.getMenuItemById('update-install')
  const check = menu.getMenuItemById('update-check')
  if (label) label.label = view.label
  if (install) { install.visible = view.installVisible; install.enabled = view.installEnabled }
  if (check) check.enabled = view.checkEnabled
}

/** NSIS requires /D= to be the LAST argument and UNQUOTED, even when the path
 *  contains spaces. Node's spawn quotes any argument containing whitespace, so
 *  a directory like `C:\Program Files\Orgtree` reaches the installer as
 *  `"/D=C:\Program Files\Orgtree"` — measured on the real Win32 command
 *  line — and app-builder-lib's own GetDParameter scans the raw command line
 *  for `/D=` and copies everything after it, trailing quote included.
 *
 *  This is REPORTED, NOT ACTED ON. Withholding the argument would change where
 *  the installer lands and which scope it picks, and that cannot be verified
 *  without running the real installer. The existing behaviour is kept and the
 *  hazard is written to the update log so a later, verified change has evidence
 *  to work from. */
export function installDirectoryIsSafeForNsis(directory: string): boolean {
  return directory.length > 0 && !/[\s"]/.test(directory)
}

/** Whether this process can actually write into the installed application's
 *  own directory, decided by WRITING — `fs.access(W_OK)` on Windows reports the
 *  read-only attribute, not the ACL, so it would pass on a directory this user
 *  cannot touch. A per-machine install under Program Files fails here, and an
 *  unelevated silent installer cannot replace it: the bundled preflight calls
 *  UAC_RunElevated and quits. */
export function installDirectoryWritable(directory: string, io: Pick<typeof fs, 'writeFileSync' | 'unlinkSync'> = fs): boolean {
  if (!directory) return false
  const probe = path.join(directory, `.orgtree-update-probe-${process.pid}`)
  try {
    io.writeFileSync(probe, '', { flag: 'w', mode: 0o600 })
    return true
  } catch { return false }
  finally { try { io.unlinkSync(probe) } catch { /* nothing was created */ } }
}

export interface HandoffResult {
  /** electron-updater accepted the request and WILL quit the app. False means
   *  it declined — BaseUpdater then resets its own latch and never calls
   *  app.quit(), so a caller that has already begun shutting down would sit
   *  wedged until something kills it. Note that `true` only means the installer
   *  was launched: a spawn that fails afterwards is reported out of band
   *  through the 'error' event, never through this value. */
  accepted: boolean
  /** The /D= directory passed to the installer. */
  directory?: string
  /** Diagnostic only: Windows will quote this argument and NSIS will mis-parse
   *  it. Recorded, not corrected — see installDirectoryIsSafeForNsis. */
  directoryWillBeQuoted?: boolean
}

/** NSIS already supports --updated /S --force-run. Keep the running install's
 * directory; the bundled installer reads its previous scope from the registry. */
/** The surface installDownloadedUpdate uses. electron-updater exports
 *  `autoUpdater` typed as the abstract AppUpdater, but on every platform it is
 *  really a BaseUpdater, whose synchronous install() is public. */
export interface InstallableUpdater {
  installDirectory?: string
  quitAndInstallCalled?: boolean
  install(silent: boolean, runAfter: boolean): boolean
}

export function installDownloadedUpdate(updater: InstallableUpdater, directory: string): HandoffResult {
  updater.installDirectory = directory
  // install(), not quitAndInstall(). quitAndInstall schedules app.quit() in a
  // setImmediate the moment the spawn is LAUNCHED, and the spawn's own failure
  // only surfaces later on the 'error' event — measured: a failing spawn
  // still quits the app, which is the reported disappearance. Owning the quit
  // ourselves is the only way to put a decision point in between.
  const accepted = updater.install(true, true) === true
  // A refusal must not leave the library's latch set, or every later attempt is
  // silently ignored as a duplicate.
  if (!accepted) updater.quitAndInstallCalled = false
  return { accepted, directory, ...(installDirectoryIsSafeForNsis(directory) ? {} : { directoryWillBeQuoted: true }) }
}

export type PreparationOutcome =
  /** The installer was launched. Whether it SUCCEEDS is still unknown here. */
  | { stage: 'handed-off'; handoff: HandoffResult }
  /** electron-updater declined outright, so no quit is coming from it. */
  | { stage: 'refused' }
  /** The engine did not confirm shutdown. NOTHING was handed off. */
  | { stage: 'engine-unconfirmed'; detail: string }

export interface PreparationSeams {
  /** Bounds the whole window below. Armed FIRST: in 2.0.3 the equivalent timer
   *  was the last statement before the handoff, so a preparation step that
   *  never settled meant it was never armed at all. */
  armWatchdog: () => void
  cancelWatchdog: () => void
  /** Best effort: gives the renderer a chance to flush drafts. */
  saveLayout: () => Promise<void>
  stopEngine: () => Promise<void>
  /** Releases before-quit so the updater's own app.quit() can take effect. */
  markQuitComplete: () => void
  handOff: () => HandoffResult
  record: (stage: UpdateStage, detail?: unknown) => void
  layoutMs: number
  engineMs: number
}

/** Everything between "this process is now committed to shutting down" and the
 *  installer handoff. Extracted so it can be driven end to end by a test,
 *  because this is the exact window in which 2.0.3 wedged: once `quitting` is
 *  latched, before-quit refuses every app.quit(), so an await in here that
 *  never settles leaves the app with no way out but Task Manager. Every step is
 *  therefore bounded and recorded, and the handoff is always reached. */
export async function prepareAndHandOff(seams: PreparationSeams): Promise<PreparationOutcome> {
  seams.armWatchdog()
  const layout = await bounded(seams.saveLayout(), seams.layoutMs)
  seams.record(layout === 'ok' ? 'layout' : 'layout-timeout',
    layout === 'ok' ? undefined : 'renderer did not flush its drafts in time')
  const stopped = await bounded(seams.stopEngine(), seams.engineMs)
  if (stopped !== 'ok') {
    // INSTALLING OVER A LIVE ENGINE IS NEVER ACCEPTABLE. A stop that timed out
    // or threw has NOT established that the engine is down, so the installer is
    // not launched at all. The watchdog is released so the caller can put the
    // app back rather than be force-exited, and the update simply stays pending.
    const detail = stopped === 'timeout'
      ? 'engine did not confirm shutdown in time; refusing to install over it'
      : 'engine shutdown failed; refusing to install over it'
    seams.record('engine-shutdown-timeout', detail)
    seams.cancelWatchdog()
    return { stage: 'engine-unconfirmed', detail }
  }
  seams.record('engine-shutdown')
  seams.markQuitComplete()
  // A throw here means the same thing a refusal does - no quit is coming - so
  // it must not escape into a state only the watchdog can end.
  let handoff: HandoffResult
  try { handoff = seams.handOff() }
  catch (error) { seams.record('error', error); handoff = { accepted: false } }
  if (!handoff.accepted) {
    seams.cancelWatchdog()
    seams.record('handoff-refused', 'electron-updater declined the install request')
    return { stage: 'refused' }
  }
  seams.record('handoff', 'installer launched for ' + handoff.directory
    + (handoff.directoryWillBeQuoted ? ' (NOTE: this /D= argument will reach NSIS quoted)' : ''))
  return { stage: 'handed-off', handoff }
}

interface UpdateCallbacks {
  /** Wraps the real updater's checkForUpdates(); autoDownload happens on its own once resolved. */
  run: () => Promise<{ hasUpdate: boolean; version?: string }>
  report: (status: UpdateStatus) => void
  now?: () => number
  /** Manual checks remain available when background updates are disabled. */
  automaticEnabled?: () => boolean
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
    if (this.callbacks.automaticEnabled?.() === false) return
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
