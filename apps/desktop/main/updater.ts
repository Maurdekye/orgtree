import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { ProcessFailureStage } from './process-failure'
import type { WindowLoadStage } from './window-load-recovery'

export type UpdateState = 'idle' | 'checking' | 'downloading' | 'pending-idle' | 'up-to-date' | 'unavailable' | 'failed'
/** `recheck` is the outcome of a check that ran WHILE an update was already
 *  prepared and left it in place. The state stays 'pending-idle', because the
 *  installer sitting on disk is still the thing that will run; the extra field
 *  is the only way to answer the user who just pressed Check for updates and
 *  would otherwise see no response at all. Never set with any other state. */
export interface UpdateStatus { state: UpdateState; version?: string; percent?: number; recheck?: 'up-to-date' | 'unavailable' }

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
  /** ⚠ THIS HANDOFF WENT TO THE HARMLESS FIXTURE, not to a downloaded
   *  installer. Recorded so a rehearsal can never be read afterwards as a real
   *  update: a log that cannot tell the two apart would make the next update
   *  incident harder to diagnose, not easier, which is the opposite of why the
   *  fixture exists. Only a build composed with the fixture can emit this. */
  | 'update-fixture-handoff'
  /** A fixture substitution was ASKED FOR and did not happen — this build was
   *  not composed to accept one, or the named executable is not there. The
   *  ordinary handoff ran unchanged. Recorded rather than ignored so a stray
   *  variable in an operator's environment changes nothing VISIBLY rather than
   *  changing nothing silently. */
  | 'update-fixture-refused'
  /** A selector was set on a build that is NOT composed for rehearsal, so it
   *  was ignored and the ordinary handoff ran unchanged. Recorded because a
   *  stray variable changing nothing must still be READABLE as having changed
   *  nothing; it is not a refusal, because the real update proceeded. */
  | 'update-fixture-ignored'
  /** This build is checking an ISOLATED LOOPBACK feed rather than the packaged
   *  release feed. Only a build composed for rehearsal can record this, and a
   *  log that did not say so would let a private rehearsal be mistaken for a
   *  real update check afterwards. */
  | 'update-feed-private'
  /** The confined update client tried to reach a host outside the isolated
   *  loopback feed and was stopped before any external connection. Recorded
   *  because a blocked escape nobody can read afterwards is a silent
   *  near-miss, and because it is the signal that a feed is misbehaving. */
  | 'update-feed-escape-blocked'
  /** The fixture RAN AND FINISHED. Distinct from 'installer-running' because
   *  nothing was installed, and distinct from 'installer-never-started'
   *  because it did run — a fixture that completes faster than one poll
   *  produces the same process-table reading as one that died on launch. */
  | 'update-fixture-completed'
  /** An installer process was OBSERVED RUNNING. This is the only stage that
   *  says an update is really under way: 'handoff' means a pid came back, which
   *  a process that died instantly also produces. Nothing may quit the app on
   *  the strength of 'handoff' alone. */
  | 'installer-running'
  /** Waiting on a Windows permission prompt. Recorded because an update that
   *  sits here for a minute is indistinguishable, in every earlier log, from
   *  one that wedged. */
  | 'installer-awaiting-elevation'
  /** No installer will start: the prompt was dismissed, the launch was blocked,
   *  or nothing ever appeared. The app must be put back, not quietly closed. */
  | 'installer-never-started'
  /** The installer could not be IDENTIFIED, so no proof was obtainable and the
   *  old unproven exit was taken. Distinct from 'installer-running': it records
   *  that nobody checked, which is exactly what a later reader needs to know. */
  | 'installer-proof-unavailable'
  /** A line copied out of the INSTALLER's own log. The application cannot see
   *  what happens after the handoff, and on the machine that failed nothing
   *  there survived at all; folding the installer's last stages in here means
   *  one file answers the whole question. */
  | 'installer-log'
  /** The failure report was PUT ON SCREEN by a later run. Written every time it
   *  is shown, so repeats are bounded — see FAILURE_REPORT_SHOWS. */
  | 'failure-report-shown'
  /** The user DISMISSED the failure report, so it has actually been delivered
   *  and is never shown again — see updateFailureToReport. */
  | 'failure-reported'
  | 'watchdog-exit'            /* preparation outlived its deadline */
  | 'updater'                  /* a line from electron-updater's own logger */
  | 'error'
  | 'not-installed'            /* a handoff happened but the version did not change */
  /** The one-run hold for a failed attempt has been applied. DISTINCT from
   *  'not-installed', which merely describes the outcome and can be written
   *  before the relaunch that leads to the very boot meant to be held. Reusing
   *  that one as the guard let a failure hold nothing and retry immediately. */
  | 'hold-consumed'
  /** The installer-requested shutdown, recorded from the application's side.
   *  The installer keeps its own log, but only the app can say whether it
   *  accepted the request, got as far as stopping its engine, or refused.
   *  When the installer's graceful close last failed, the application side had
   *  recorded none of that, so there was nothing to read but the installer's
   *  own message. */
  | 'installer-upgrade-requested'  /* the running app received the request */
  | 'installer-upgrade-deferred'   /* accepted, but held until the engine is ready */
  | 'installer-upgrade-began'      /* shutdown started: layout saved, engine stopping */
  | 'installer-upgrade-engine-stopped'
  | 'installer-upgrade-complete'   /* the app is quitting; the installer may proceed */
  | 'installer-upgrade-refused'    /* the engine would not stop; the app stays usable */
  | 'installer-upgrade-control'    /* a control invocation found no running app */
  /** How this run was started, when that is knowable from the command line.
   *  It is what connects an upgrade that closed the app to whatever started it
   *  again, which no log recorded before. */
  | 'startup'
  /** A Chromium process under this app went away, wedged, or was recovered —
   *  see process-failure.ts. These share this log rather than getting one of
   *  their own for the reason the comment on UpdateLog gives: it is already the
   *  durable, sanitised, rotating record that exists because "the 2.0.3
   *  failures left no trace at all", and a renderer being killed is the same
   *  problem. Every reader of this log is a `.some()` or an `entries[0]` over
   *  update stages, so foreign entries interleaved between them change no
   *  update decision. */
  | ProcessFailureStage
  /** The main window's DOCUMENT failed to load, was retried, or came back —
   *  see window-load-recovery.ts. Kept distinct from the `renderer-*` stages
   *  because the render process is alive for all of these: what failed is the
   *  navigation, not the process. Reading them in one file beside those is the
   *  point — the 2026-09-18 white window is only legible as a
   *  'renderer-recovered' immediately followed by a failed load. */
  | WindowLoadStage

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

/** Whether the last attempt ended without the running version changing, and
 *  whether its one-run hold has already been spent. Pure, so the decision is
 *  testable without a filesystem or an Electron app. */
export function pendingUpdateHold(entries: UpdateLogEntry[], runningVersion: string): boolean {
  if (!entries.length || entries[0]!.stage !== 'attempt') return false
  // Every way an attempt can end without installing. 'not-installed' counts
  // too: the spawn-failure path records it before relaunching, and that boot is
  // exactly the one that must be held.
  const ended = entries.some(e => e.stage === 'handoff' || e.stage === 'handoff-refused' || e.stage === 'not-installed')
  if (!ended) return false
  if (entries.some(e => e.stage === 'hold-consumed')) return false
  return entries[0]!.from === runningVersion
}

/** How many launches may show the same unacknowledged failure. Bounds the
 *  "keep telling them until they click" rule so an ignored message stops
 *  shouting, while still surviving an instance that dies with the dialog up. */
export const FAILURE_REPORT_SHOWS = 3

/** Whether a prepared update attempt ended without changing the running
 * version. This is deliberately independent of whether its failure report
 * was already dismissed or reached the display bound: a failed package must
 * remain eligible for replacement by a later release. */
export function updateAttemptFailed(entries: UpdateLogEntry[], runningVersion: string): boolean {
  if (!entries.length || entries[0]!.stage !== 'attempt') return false
  const ended = entries.some(e => e.stage === 'handoff' || e.stage === 'handoff-refused'
    || e.stage === 'not-installed' || e.stage === 'installer-running')
  return ended && entries[0]!.from === runningVersion
}

/** The official release page is a recovery route, not an in-app download.
 * Keeping this URL static means it remains available when the configured feed
 * cannot be reached, while the user still chooses whether to leave Orgtree. */
export const MANUAL_UPGRADE_URL = 'https://github.com/Maurdekye/orgtree/releases/latest'
export const MANUAL_UPGRADE_LABEL = 'Download manually'

export function updateFailureDialogOptions(message: string, detail: string, type: 'error' | 'warning' = 'error') {
  const recoveryDetail = detail.replace(/The update is still ready [^.?!]*try again from the tray\./,
    'Download the latest release manually if the in-app update could not be completed.')
  return {
    type,
    message,
    // A failed updater error can stringify to an empty value. Keep the dialog
    // visibly informative even then; an empty detail would make a test of the
    // recovery branch pass without proving the user can see its explanation.
    detail: recoveryDetail.trim() || 'No additional details were provided.',
    buttons: [MANUAL_UPGRADE_LABEL, 'Close'],
    defaultId: 1,
    cancelId: 1,
  }
}

/** A FAILED UPDATE THE USER HAS NOT BEEN TOLD ABOUT YET, or null.
 *
 *  ⚠ WHY THIS EXISTS AT ALL, because the obvious alternative is worse in a way
 *  that is easy to miss. The failure branch used to show a dialog and then call
 *  app.exit(0) on the next statement, which never presented it (measured: zero
 *  windows). Awaiting the dialog does present it — and then BLOCKS THE RELAUNCH
 *  until somebody clicks. On the automatic path that is an empty room at 3am:
 *  the app has shut down, a modal nobody can see is holding the restart, and
 *  Orgtree is gone until morning. That is the original complaint wearing a new
 *  hat, arriving through the fix for it.
 *
 *  So nothing waits. The exit records the failure and relaunches immediately,
 *  and the instance that comes back reports it — when there is a running app
 *  and, usually, a person. The record is the update log, which is already on
 *  disk and already bounded, so this survives the exit, a crash, and a reboot
 *  without any new state.
 *
 *  Pure, so exactly-once reporting is testable without a filesystem, an
 *  Electron app, or a human to dismiss anything. */
export function updateFailureToReport(entries: UpdateLogEntry[], runningVersion: string): { detail: string; to?: string } | null {
  if (!updateAttemptFailed(entries, runningVersion)) return null
  // ⚠ THE TRIGGER IS "THE VERSION DID NOT CHANGE", NOT "WE DETECTED A FAILURE",
  // and that difference is the whole point of this rule.
  //
  // The first version of this keyed on 'not-installed', which only the app's own
  // failed verdict writes. That misses the incident this ticket was reopened
  // for: on the machine that actually failed, the installer WAS launched, the
  // log recorded 'handoff', and the app came back as the old version having
  // installed nothing. No 'not-installed' was ever written, so a report keyed on
  // it would have said nothing — exactly the silence being complained about.
  //
  // It also misses the asymmetric elevation case. When the installer raises its
  // OWN prompt (isAdminRightsRequired false, which is what the failing machine's
  // update-info.json carried), the installer process appears BEFORE the user has
  // answered, the proof wait sees it and returns 'started', and the app quits
  // while the decline is still to come. No process that is still alive can write
  // that refusal down. THE INSTANCE THAT COMES BACK IS THE ONLY ONE THAT CAN,
  // and this is where it does it.
  //
  // So the condition is the same one the one-run hold uses: an attempt that
  // ENDED, and a running version that did not move.
  // ⚠ DELIVERED IS NOT THE SAME AS WRITTEN, and getting this backwards loses
  // the message outright. 'failure-reported' is written when the user DISMISSES
  // the dialog, so an instance that dies with it still on screen has not
  // reported anything and the next launch says it again.
  //
  // Writing it before showing would have been exactly-once on the WRITE and
  // zero-times on the DELIVERY — a record saying "reported" with nobody told.
  // There is no second surface to fall back on: the tray hold is set only in
  // the session where pendingUpdateHold fires, and that boot records
  // 'hold-consumed', so by the next launch the label is gone too. Making the
  // label persist instead is not available — `updateHold` is also the gate that
  // suppresses unattended retries, so keeping it set would permanently disable
  // automatic updates, which is a far worse trade than a second dialog.
  if (entries.some(e => e.stage === 'failure-reported')) return null
  // ...AND IT IS STILL BOUNDED, because "keep telling them until they click" is
  // a nag if they never do. Three launches is enough to survive a crash or an
  // unattended boot and few enough that an ignored message stops shouting.
  if (entries.filter(e => e.stage === 'failure-report-shown').length >= FAILURE_REPORT_SHOWS) return null
  // ⚠ AND IF THE VERSION MOVED ON, SAY NOTHING. The same log shape is what a
  // SUCCESSFUL update leaves behind — attempt, handoff, then a new version — so
  // without this the report would fire after every working upgrade, which is a
  // lie told at the worst possible moment.
  // The reason, most specific first: the verdict that named it, then the
  // generic line, then the bare fact — which is still worth saying, because on
  // the reported machine the bare fact was never said to anybody.
  const detail = entries.filter(e => e.stage === 'installer-never-started').at(-1)?.detail
    || entries.filter(e => e.stage === 'not-installed').at(-1)?.detail
    || 'the installer was started but the installed version did not change, and it left no reason behind'
  const result: { detail: string; to?: string } = { detail }
  if (entries[0]!.to) result.to = entries[0]!.to
  return result
}

/** How many of the installer's own final lines are folded into the application
 *  log. Enough to carry the last few stages and the exit; few enough that a
 *  large installer log cannot crowd out the application's own entries. */
export const INSTALLER_LOG_TAIL = 12

/** The last lines of the INSTALLER's log, ready to be recorded one per entry.
 *
 *  ⚠ ONE LINE PER ENTRY IS NOT A STYLE CHOICE. Every detail written to the
 *  application log is sanitized and length-capped, so a single blob would be
 *  truncated exactly at the interesting end — the stages nearest the failure.
 *  Splitting first keeps the end intact.
 *
 *  Pure, so the bound and the blank-line handling are testable without a
 *  filesystem or an installer. */
export function installerLogTail(text: string, limit = INSTALLER_LOG_TAIL): string[] {
  return text.split(/\r?\n/).map(line => line.trim()).filter(line => line.length > 0).slice(-limit)
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

/** Every deadline in the shutdown sequence, in one place, because the forced
 *  exit must be DERIVED from them rather than set beside them: a watchdog equal
 *  to the sum of the steps it covers can fire during the last one, killing the
 *  app in the very window it exists to protect. */
export const UPDATE_DEADLINES = {
  layoutMs: 5000,
  engineStopMs: 10000,
  /** Waiting for the engine process to be OBSERVED gone, which engine.stop()
   *  resolving does not establish - it returns straight after child.kill(). */
  engineConfirmMs: 5000,
  /** electron-updater reports a spawn failure asynchronously, after install()
   *  has already returned true. */
  spawnGraceMs: 3000,
  marginMs: 5000,
}

export function updateWatchdogMs(d: typeof UPDATE_DEADLINES = UPDATE_DEADLINES): number {
  return d.layoutMs + d.engineStopMs + d.engineConfirmMs + d.spawnGraceMs + d.marginMs
}

/** electron-builder registers the uninstaller under a key whose name is a
 *  UUIDv5 of the application id in its own namespace, in HKLM for an all-users
 *  installation and HKCU for a per-user one. Deriving the exact name is what
 *  makes the install SCOPE checkable: a writability probe cannot tell them
 *  apart, because an elevated process can write to an all-users directory.
 *  Verified against this machine's real registry entry in the tests. */
const ELECTRON_BUILDER_NS = '50e065bc-3134-11e6-9bab-38c9862bdaf3'

export function uninstallRegistryGuid(appId: string): string {
  const namespace = Buffer.from(ELECTRON_BUILDER_NS.replace(/-/g, ''), 'hex')
  const hash = crypto.createHash('sha1').update(namespace).update(Buffer.from(appId, 'utf8')).digest()
  const bytes = Buffer.from(hash.subarray(0, 16))
  bytes[6] = (bytes[6]! & 0x0f) | 0x50          // version 5
  bytes[8] = (bytes[8]! & 0x3f) | 0x80          // RFC 4122 variant
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
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

/** Whether a check or a download is in flight, either of which may be REPLACING
 *  the prepared package at this moment - see updateOfferIsNewer for what
 *  electron-updater does to the old one. Nothing may be handed to the installer
 *  while this is true. One definition, used by the tray, by the main process's
 *  install guards, and by the tests, so the three cannot drift. */
export function updateReplacementInFlight(status: UpdateStatus): boolean {
  return status.state === 'checking' || status.state === 'downloading'
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
  // A check or a download IS the current state even when a package is already
  // prepared, because a check can REPLACE that package: electron-updater empties
  // its own pending directory the moment the feed offers a different artifact.
  // Saying "ready to install" through that window names a file that may already
  // have been deleted.
  const busy = updateReplacementInFlight(status)
  const recheck = status.recheck === 'up-to-date' ? ' - no newer release'
    : status.recheck === 'unavailable' ? ' - the check could not reach the update feed' : ''
  // A held update is still installable BY HAND - that is the whole point of
  // holding it - so the install item stays enabled and only the status line
  // changes. Applying outranks the hold: it describes work already under way.
  const ready = downloaded && !busy ? (hold ? `Update${version}: ${hold}` : labels['pending-idle'] + recheck) : labels[status.state]
  return {
    label: applying ? 'Installing update...' : ready,
    // Visible throughout, so a check does not make the item flicker out of an
    // open menu and back; enabled only while there is something to install and
    // nothing in flight that could be replacing it.
    installVisible: downloaded, installEnabled: downloaded && !applying && !busy,
    // A prepared update no longer disables checking (user 2026-09-11): being
    // able to replace it with a newer release is the entire point.
    checkEnabled: !applying && !busy,
  }
}

/** Compare two update versions by semantic-version precedence: negative when
 *  `a` sorts before `b`, positive when after, 0 when equal, and null when
 *  either is not a version this can order.
 *
 *  Hand-written rather than taking a dependency on `semver` - which is present
 *  only as electron-updater's own transitive, dev-flagged package - and CHECKED
 *  AGAINST semver's compare() over every pair of a table that includes
 *  prereleases, because that is the ordering electron-updater itself uses
 *  (AppUpdater imports semver directly). Build metadata is ignored, as the
 *  specification requires. */
export function compareUpdateVersions(a: string, b: string): number | null {
  const read = (value: string) => {
    const parts = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value.trim())
    if (!parts) return null
    return { core: [Number(parts[1]), Number(parts[2]), Number(parts[3])], pre: parts[4] ? parts[4].split('.') : [] }
  }
  const left = read(a), right = read(b)
  if (!left || !right) return null
  for (let i = 0; i < 3; i++) if (left.core[i]! !== right.core[i]!) return left.core[i]! < right.core[i]! ? -1 : 1
  // A release outranks every prerelease of the same core version.
  if (!left.pre.length || !right.pre.length) return left.pre.length === right.pre.length ? 0 : (left.pre.length ? -1 : 1)
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i++) {
    const x = left.pre[i], y = right.pre[i]
    if (x === undefined) return -1                              // fewer identifiers sorts lower
    if (y === undefined) return 1
    const numericX = /^\d+$/.test(x), numericY = /^\d+$/.test(y)
    if (numericX && numericY) { if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1 }
    else if (numericX !== numericY) return numericX ? -1 : 1     // numeric identifiers sort below alphanumeric
    else if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

/** Whether an offered release should REPLACE one already prepared on disk.
 *
 *  ELECTRON-UPDATER CANNOT ANSWER THIS. Its isUpdateAvailable compares the offer
 *  against the RUNNING version, so with a package already prepared it answers
 *  "available" for the identical release, and for one OLDER than the prepared
 *  package after a rollback. Accepting either answer is what destroys the
 *  package already on disk: on its way into the download the library empties
 *  its own pending directory whenever the offered checksum differs from the
 *  cached one, and within the session that downloaded it, it goes on reporting
 *  the deleted path as its installerPath. Both behaviours are OBSERVED against
 *  the installed electron-updater in tests/updater-library.test.mjs, not read
 *  off its source - including the case that disproves the obvious shortcut,
 *  where the same version republished with different bytes deletes the cache
 *  too, so version equality never did prove the file had survived.
 *
 *  So the comparison that matters is against what is ALREADY PREPARED, and it
 *  has to happen before the download - which is why autoDownload is off and the
 *  download is started by this controller rather than by the library.
 *
 *  An unknown or unorderable version on either side takes the offer: what is
 *  prepared is then unidentified, and a known release is worth more than one
 *  nobody can name. */
export function updateOfferIsNewer(offered: string | undefined, prepared: string | undefined): boolean {
  if (!offered || !prepared) return true
  const order = compareUpdateVersions(offered, prepared)
  return order === null ? true : order > 0
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

/** Whether Windows will quote `/D=<directory>` on the way to the installer.
 *  DIAGNOSTIC ONLY — nothing branches on it. What it records and why is below,
 *  and the "why" is the opposite of what this comment used to say.
 *
 *  NSIS wants /D= LAST and UNQUOTED. Node's spawn quotes any argument
 *  containing whitespace, so `C:\Program Files\Orgtree` reaches the installer
 *  as `"/D=C:\Program Files\Orgtree"`, and app-builder-lib's GetDParameter
 *  (templates/nsis/multiUser.nsh) scans the RAW command line for `/D=` and
 *  copies everything after it — trailing quote included — INTO ITS OWN OUTPUT
 *  VARIABLE.
 *
 *  ⚠ NOT INTO $INSTDIR, WHICH IS WHERE THIS COMMENT WAS WRONG. The template
 *  then does `StrCpy $INSTDIR $R0`, and assignment to $INSTDIR SANITISES THE
 *  VALUE AS A FILENAME: every character Windows forbids is removed. Measured
 *  against the real parser and the real makensis — 76 characters parsed, 75 in
 *  $INSTDIR, and all six of " * ? < > | stripped from a poisoned control in
 *  one run (tests/disruptive/nsis-destination.test.mjs). Both forms therefore arrive at an
 *  identical destination and a directory created from it is the intended one.
 *
 *  ⚠ WHICH MAKES THE HANDOFF ACCIDENTALLY SAFE, NOT ROBUST. The quoting is
 *  harmless only because the single character it adds happens to be one
 *  $INSTDIR forbids. A corruption made of LEGAL characters would pass straight
 *  through. Nobody has shown such a shape is reachable from installDirectory()
 *  and nobody has shown it is not; this is recorded so the measurement is never
 *  read as a clean bill of health.
 *
 *  THE HISTORY, because the old belief is in the incident record and someone
 *  will re-derive it otherwise: this comment described the mechanism as real,
 *  the handoff log warned about it on every all-users update, and the incident
 *  report from the failed 2.1.3 → 2.1.4 machine named it as the strongest
 *  candidate cause. Measurement refuted it (decision 16), so the change built
 *  on it was withdrawn rather than shipped, and the field incident is
 *  unexplained again. */
export function installDirectoryIsSafeForNsis(directory: string): boolean {
  return directory.length > 0 && !/[\s"]/.test(directory)
}

/** ⚠ WHAT MEASURING THIS ACTUALLY SHOWED, recorded here because the comment
 *  above describes a hazard that turns out not to reach the destination, and
 *  the next reader will otherwise spend a day on it as I did.
 *
 *  Driven against the REAL parser — the shipped GetDParameter macro, compiled
 *  by the real makensis, launched through Node's own spawn (see
 *  tests/disruptive/nsis-destination.test.mjs):
 *
 *    /D= quoted   -> the macro's output variable ends with a stray `"` ...
 *                    ... and `StrCpy $INSTDIR $R0` REMOVES IT. Measured: 76
 *                    characters parsed, 75 in $INSTDIR, and a directory
 *                    created from it is the intended one.
 *    /D= unquoted -> identical $INSTDIR.
 *
 *  Both forms arrive at the same destination, and those two assignments are the
 *  only consumers of the parsed value in the templates. So the quoting is NOT
 *  what left the reported machine on its old version, and this function stays
 *  DIAGNOSTIC ONLY: nothing branches on it. What did break that machine is
 *  still unexplained — a declined elevation prompt and an internal installer
 *  exit are the surviving candidates, and neither is visible from out here,
 *  which is the case for durable installer-side diagnostics rather than for
 *  changing this argument. */

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
  /** The directory the installer is expected to install into. */
  directory?: string
  /** Windows will quote this /D= argument because the path contains whitespace.
   *  DIAGNOSTIC, and no longer a warning: the quote is stripped when NSIS
   *  assigns $INSTDIR, measured against the real parser. Kept so a log from a
   *  future incident still says which form was sent. */
  directoryQuotedByNode?: boolean
  /** ⚠ THIS HANDOFF WENT TO A FIXTURE, not to the downloaded installer, and
   *  this names which one. Present ONLY on a build packaged to permit a
   *  substitution (update-fixture.ts), and its whole job is to keep a rehearsal
   *  from reading afterwards as a real update. An update log that cannot tell
   *  the two apart is worse than one that records neither. */
  fixture?: string
  /** Where that fixture was told to write its receipt, carried through so the
   *  proof can tell a fixture that COMPLETED from one that never ran. */
  fixtureReceipt?: string
  /** A fixture was requested and could not be used, so the handoff was
   *  DECLINED rather than falling through to a real installation. */
  fixtureRefused?: string
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

/** The argument vector the NSIS handoff uses, in the order it uses it. Named
 *  here so the FIXTURE route is handed exactly what the real route is handed:
 *  a fixture reached with different arguments would compare two different
 *  things and quietly answer the wrong question. `/D=` stays LAST, which NSIS
 *  requires — see installDirectoryIsSafeForNsis for what Windows does to it on
 *  the way. Measured on two real machines: `--updated`, `/S`, `--force-run`,
 *  `/D=<directory>`. */
export function updateHandoffArgs(directory: string): string[] {
  return ['--updated', '/S', '--force-run', `/D=${directory}`]
}

/** Substitutes a harmless fixture for the downloaded installer. See
 *  update-fixture.ts for when a build is allowed to have one. `spawn` is
 *  injected so this seam is drivable without starting anything. */
export interface FixtureHandoff {
  installer: string
  /** Where the caller told the fixture to write its receipt. THE PROOF NEEDS
   *  THIS, which is why it belongs to the handoff rather than to the spawn: a
   *  fixture that completes faster than the process table is sampled looks
   *  exactly like one that died instantly, and only the receipt tells those
   *  two apart. See awaitInstallerProof's fixtureCompleted seam. */
  receipt: string
  spawn: (file: string, args: string[]) => { pid?: number }
}

/** A fixture substitution that could NOT be performed. Carried explicitly
 *  because the alternative is the defect a reviewer measured: a refused
 *  rehearsal fell through to the ordinary path and ran the REAL installer.
 *
 *  ⚠ ASKING FOR A REHEARSAL AND GETTING A REAL UPDATE IS THE WORST OUTCOME
 *  THIS CODE CAN PRODUCE. Someone who set the fixture variable is explicitly
 *  saying "do not really update"; if the fixture is missing or its receipt path
 *  is unusable, the honest answer is to decline the handoff, not to install for
 *  real instead. A decline is already a shape this system handles: the app is
 *  restored and the user is told, exactly as when electron-updater declines.
 *
 *  This is NOT the no-fixture case. When nothing was requested there is no
 *  attempt at all and the ordinary handoff runs untouched, which is what keeps
 *  production behaviour unchanged. */
export interface RefusedFixture { refused: string }

export type FixtureAttempt = FixtureHandoff | RefusedFixture

export function installDownloadedUpdate(
  updater: InstallableUpdater, directory: string, fixture?: FixtureAttempt): HandoffResult {
  // ⚠ THE FIXTURE ROUTE DOES NOT GO THROUGH electron-updater, AND IT SAYS SO IN
  // THE RESULT. The library spawns the file IT downloaded; there is no hook to
  // point that at something else, so a substitution has to own the spawn. What
  // is preserved is everything the comparison is about — the same argument
  // vector, the same detached shape, the same destination — and what is NOT
  // preserved is the library's own bookkeeping, which is why `fixture` is
  // reported: a fixture handoff must never be readable afterwards as a real
  // one. Contaminating the durable record with an indistinguishable rehearsal
  // is the one way this mechanism could make the incident evidence worse
  // instead of better.
  if (fixture && 'refused' in fixture) {
    // NOTHING IS LAUNCHED AND THE LIBRARY IS NEVER ASKED. The caller sees a
    // declined handoff and restores the app, which is the same safe shape a
    // refusal from electron-updater takes.
    return { accepted: false, directory, fixtureRefused: fixture.refused }
  }
  if (fixture) {
    const child = fixture.spawn(fixture.installer, updateHandoffArgs(directory))
    return {
      accepted: typeof child.pid === 'number',
      directory,
      fixture: fixture.installer,
      fixtureReceipt: fixture.receipt,
      ...(installDirectoryIsSafeForNsis(directory) ? {} : { directoryQuotedByNode: true }),
    }
  }
  // KEPT AS IT WAS, DELIBERATELY. A version of this rerouted whitespace-bearing
  // directories — omitting /D= so NSIS resolved its own registered location,
  // and refusing the silent handoff when the registry could not confirm it. The
  // fixture then showed there is nothing here to route around (see the note on
  // installDirectoryIsSafeForNsis), and that change would have removed tray
  // updating for an unenumerable population of users in exchange for defending
  // against a mechanism that does not occur. It was withdrawn rather than
  // shipped.
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
  return { accepted, directory, ...(installDirectoryIsSafeForNsis(directory) ? {} : { directoryQuotedByNode: true }) }
}

// ------------------------------------------------- proof that an installer LIVES
// `install()` returning true means electron-updater got a pid back, and a pid
// means a process OBJECT WAS CREATED — not that it survived, not that it is the
// installer, and not that it accepted anything (BaseUpdater.spawnLog resolves
// on `p.pid !== undefined`). The only failure it can ever report is a
// spawn-time 'error'. A process that STARTS AND THEN DIES emits nothing at all,
// so the app recorded a handoff, waited out a silent grace, and quit having
// installed nothing — the reported "shut down but never visibly proceeded".
//
// ⚠ THE DISCRIMINATOR IS THE INSTALLER'S OWN IMAGE, NEVER elevate.exe. When
// admin rights are required the library spawns resources/elevate.exe, which
// raises the UAC prompt and only then launches the installer. WHILE THAT PROMPT
// IS ON SCREEN elevate.exe IS ALIVE — so "something we spawned is running" is
// satisfied by the exact case this exists to catch. Only a process whose image
// is the downloaded installer proves the user approved.
//
// ⚠ AND THEREFORE NO DEADLINE WHILE THE ELEVATOR LIVES. A person can leave a
// UAC prompt up for as long as they like. Timing out mid-prompt would declare
// failure over an update that is still perfectly able to succeed, and would
// relaunch the app straight into a race with the installer it just disowned. So
// an elevator that is still running is `pending` for as long as it runs — the
// app holds, engine already stopped, saying what it is waiting for. The bound
// applies only where nothing human is involved.

/** One look at the process table, reduced to the facts the verdict needs.
 *  Gathering it is the caller's (it is platform work); deciding is here. */
export interface InstallerSighting {
  /** a process whose image is the DOWNLOADED INSTALLER is running now */
  installerRunning: boolean
  /** resources/elevate.exe — the UAC broker — is running now */
  elevatorRunning: boolean
  /** ⚠ DID THE LOOK ACTUALLY SUCCEED? Without this, a process listing that
   *  timed out is indistinguishable from one that came back empty, and the two
   *  mean opposite things: "nothing is running" versus "I could not see".
   *  An unreadable look must never decide anything — see below. */
  readable: boolean
  /** milliseconds since the handoff returned */
  elapsedMs: number
}

/** What survives between sightings.
 *
 *  `elevatorSeen` is the memory that turns "no installer yet" into a refusal.
 *  The other two exist so that an ABSENCE is only ever concluded from looks
 *  that actually happened: `readableLooks` counts successful ones, and
 *  `lastReadable` says whether the immediately preceding look succeeded. */
export interface InstallerProofMemory {
  elevatorSeen: boolean
  readableLooks: number
  lastReadable: boolean
}

export const NO_INSTALLER_SIGHTINGS: InstallerProofMemory = { elevatorSeen: false, readableLooks: 0, lastReadable: false }

export type InstallerVerdict =
  /** an installer process was OBSERVED running — the update is really under way */
  | { verdict: 'started'; detail: string }
  /** it will never start: the prompt was dismissed, or nothing ever appeared */
  | { verdict: 'failed'; detail: string }
  /** the process table could not be read, so nothing is known either way. NOT
   *  a failure: the caller must fall back to an unproven exit and say so,
   *  exactly as it does when the installer cannot be named at all. */
  | { verdict: 'unknown'; detail: string }
  /** no answer yet, and waiting is correct */
  | { verdict: 'pending' }

export const INSTALLER_PROOF = {
  /** How long an installer spawned with NO elevation may take to appear. It is
   *  a direct CreateProcess with no human in the path, so this is generous
   *  rather than tight — but it is bounded, because nothing will ever arrive to
   *  end the wait if the process died on the way up. */
  appearMs: 8000,
  /** How often to look. Cheap enough to be frequent; a short-lived installer
   *  that dies between two looks is still caught, because its absence at the
   *  next look is not what decides — the elevator rule and the appear bound
   *  are. */
  pollMs: 250,
  /** ⚠ THE APPEAR BOUND MAY NOT FIRE ON GUESSES. A healthy run gets about
   *  appearMs/pollMs = 32 successful looks before the bound is reached, so
   *  requiring a handful of them costs nothing there — and it stops a couple of
   *  hung process listings from burning the whole bound and manufacturing a
   *  failure against an installer that is running perfectly well. */
  minReadableLooks: 8,
  /** How long to keep trying when the process table cannot be read at all.
   *  Past this the answer is 'unknown', never 'failed': we did not observe an
   *  absent installer, we failed to observe anything. */
  unreadableMs: 20000,
}

/** Fold one sighting into a verdict. Pure, so every branch — approved,
 *  cancelled, blocked, died instantly, slow prompt, no elevation at all,
 *  and a process table that cannot be read — is testable without installing
 *  anything on the machine running the tests. */
export function installerProofStep(memory: InstallerProofMemory, seen: InstallerSighting,
  bounds: { appearMs: number; minReadableLooks?: number; unreadableMs?: number } = INSTALLER_PROOF): { memory: InstallerProofMemory; result: InstallerVerdict } {
  const minReadableLooks = bounds.minReadableLooks ?? INSTALLER_PROOF.minReadableLooks
  const unreadableMs = bounds.unreadableMs ?? INSTALLER_PROOF.unreadableMs
  // ⚠ AN UNREADABLE LOOK DECIDES NOTHING, AND IT IS HANDLED FIRST so that no
  // rule below can read its empty answer as an absence. Both of those rules —
  // the elevator having gone, and the appear bound — are conclusions ABOUT
  // SOMETHING NOT BEING THERE, and a listing that timed out reports exactly
  // the same thing as a listing that came back clean.
  if (!seen.readable) {
    const next: InstallerProofMemory = { ...memory, lastReadable: false }
    if (seen.elapsedMs >= unreadableMs) {
      return { memory: next, result: { verdict: 'unknown',
        detail: `the list of running processes could not be read for ${unreadableMs}ms, so whether the installer started is unknown` } }
    }
    return { memory: next, result: { verdict: 'pending' } }
  }
  // The one positive proof. Checked FIRST among the readable rules and
  // unconditionally: an installer that is running settles the question no
  // matter what the elevator is doing or how long it took to get here.
  if (seen.installerRunning) {
    // ⚠ "OBSERVED RUNNING" IS NOT "WILL SUCCEED", and the wording says so on
    // purpose. On the machine that actually failed, the installer ran — twice —
    // and replaced nothing; and where the installer raises its OWN elevation
    // prompt, its process exists BEFORE the user has answered, so this sighting
    // can precede a decline. This verdict releases the app to quit, which the
    // installer needs in order to replace files. WHETHER THE UPDATE HAPPENED IS
    // DECIDED AT THE NEXT BOOT, by comparing the running version against the
    // attempt — see updateFailureToReport. Nothing here may be read as success.
    return { memory, result: { verdict: 'started', detail: `installer process observed running after ${seen.elapsedMs}ms - this releases the app to exit and is NOT evidence the update completed` } }
  }
  const next: InstallerProofMemory = {
    elevatorSeen: memory.elevatorSeen || seen.elevatorRunning,
    readableLooks: memory.readableLooks + 1,
    lastReadable: true,
  }
  // The elevator is up: a Windows prompt is in front of the user, or it is
  // about to launch the installer. Waiting is the only correct answer, and it
  // is deliberately unbounded — see the note above.
  if (seen.elevatorRunning) return { memory: next, result: { verdict: 'pending' } }
  // ⚠ AN ABSENCE IS CONFIRMED TWICE. Neither failure rule may fire unless the
  // PREVIOUS look also succeeded, so a single readable look arriving after a
  // gap of blind ones cannot end the wait. Without it, listings that hang for
  // a few seconds and then recover would let a silent install that had already
  // finished read as one that never started.
  if (!memory.lastReadable) return { memory: next, result: { verdict: 'pending' } }
  // It WAS up and is now gone without an installer ever appearing. That is a
  // decision, and it was "no": the prompt was dismissed, or the launch was
  // refused by policy. This is the UAC-cancel case that previously read as
  // success.
  if (next.elevatorSeen) {
    return { memory: next, result: { verdict: 'failed',
      detail: 'the elevation helper exited without starting the installer - the Windows permission prompt was dismissed, or the launch was blocked' } }
  }
  // No elevation was ever involved, so the installer should have appeared
  // almost at once. Past the bound, it is not coming — but only if we have
  // actually been looking, hence the readable-look floor.
  if (seen.elapsedMs >= bounds.appearMs && next.readableLooks >= minReadableLooks) {
    return { memory: next, result: { verdict: 'failed',
      detail: `no installer process appeared within ${bounds.appearMs}ms of the handoff, across ${next.readableLooks} readings of the process list` } }
  }
  return { memory: next, result: { verdict: 'pending' } }
}

/** Everything the wait needs from the world, injected — a look at the process
 *  table, a clock, a sleep, the log, and whatever electron-updater has said.
 *  Gathering is the caller's because it is platform work; the WAITING, which is
 *  where every mistake lives, is here and is driven entirely by tests. */
export interface InstallerProofSeams {
  /** One look at the process table. `installerRunning` must match the
   *  DOWNLOADED INSTALLER's own image — see the note on installerProofStep for
   *  why elevate.exe is not a substitute. */
  sample: () => Promise<{ installerRunning: boolean; elevatorRunning: boolean; readable: boolean }>
  now: () => number
  sleep: (ms: number) => Promise<void>
  record: (stage: UpdateStage, detail?: unknown) => void
  /** A spawn error electron-updater reported. It ends the wait at once — it is
   *  the one failure the library CAN tell us about, and waiting out a bound
   *  after it would be waiting for something already known not to be coming. */
  reportedError?: () => unknown | undefined
  /** ⚠ A COMPLETED FIXTURE IS NOT A DEAD INSTALLER, and without this seam the
   *  two are the same observation. The harmless update fixture can finish
   *  before the process table is ever sampled: nothing is running, nothing was
   *  ever seen running, and the ordinary verdict for that is
   *  'installer-never-started' — correct for a real installer that died
   *  instantly, and exactly wrong for a rehearsal that succeeded. The fixture
   *  writes a receipt when it completes, so this answers 'did it finish?' at
   *  the one moment the answer changes the verdict.
   *
   *  Only a fixture handoff supplies it. A real installer never does, so the
   *  ordinary path cannot be softened by it — a downloaded installer that dies
   *  instantly still fails, which is the defect this whole wait exists for. */
  fixtureCompleted?: () => boolean
  bounds?: { appearMs: number; pollMs: number; minReadableLooks?: number; unreadableMs?: number }
}

/** Wait until the installer is either PROVEN to be running or known not to be
 *  coming, and say which.
 *
 *  ⚠ THE APP MUST NOT QUIT ON THE STRENGTH OF A HANDOFF. That is the whole
 *  defect: `install()` returning true means a pid came back, and the app then
 *  exited on three seconds of silence. Silence is not consent — a process that
 *  started and died emits nothing at all — so the exit now waits for a verdict.
 *
 *  ⚠ AND IT MAY WAIT A LONG TIME, deliberately, when a Windows permission
 *  prompt is up. 'installer-awaiting-elevation' is recorded ONCE when that
 *  starts, so a log showing a minute of nothing is readable afterwards as "a
 *  human was being asked" rather than as a wedge. */
export async function awaitInstallerProof(seams: InstallerProofSeams): Promise<InstallerVerdict> {
  const bounds = seams.bounds ?? INSTALLER_PROOF
  const began = seams.now()
  let memory: InstallerProofMemory = NO_INSTALLER_SIGHTINGS
  let announcedElevation = false
  for (;;) {
    const reported = seams.reportedError?.()
    if (reported !== undefined) {
      seams.record('installer-never-started', reported)
      return { verdict: 'failed', detail: sanitizeUpdateDetail(reported) }
    }
    const seen = await seams.sample()
    const step = installerProofStep(memory, { ...seen, elapsedMs: seams.now() - began }, bounds)
    memory = step.memory
    if (memory.elevatorSeen && !announcedElevation) {
      announcedElevation = true
      seams.record('installer-awaiting-elevation', 'a Windows permission prompt is open; waiting for the answer')
    }
    if (step.result.verdict === 'started') {
      seams.record('installer-running', step.result.detail)
      return step.result
    }
    if (step.result.verdict === 'failed') {
      // Ask the fixture whether it FINISHED before calling this a failure.
      // Ordering matters: the step already concluded nothing is running, and
      // for a fixture that is the expected end state rather than the failure.
      if (seams.fixtureCompleted?.()) {
        const detail = 'the update fixture completed and wrote its receipt; nothing was installed'
        seams.record('update-fixture-completed', detail)
        return { verdict: 'started', detail }
      }
      seams.record('installer-never-started', step.result.detail)
      return step.result
    }
    // ⚠ NOT A FAILURE, AND IT MUST NOT BE TREATED AS ONE. We never saw the
    // process table, so we never saw an absent installer. This is the same
    // state as being unable to name the installer at all, and the caller owes
    // it the same unproven exit rather than a "did not install" verdict.
    if (step.result.verdict === 'unknown') {
      seams.record('installer-proof-unavailable', step.result.detail)
      return step.result
    }
    await seams.sleep(bounds.pollMs)
  }
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
  /** Must answer true only when the engine process is OBSERVED to be gone.
   *  stopEngine() resolving is not that: Engine.stop returns immediately after
   *  child.kill(), without waiting for the exit it just requested. */
  confirmEngineStopped: () => Promise<boolean>
  /** Releases before-quit so the updater's own app.quit() can take effect. */
  markQuitComplete: () => void
  handOff: () => HandoffResult
  record: (stage: UpdateStage, detail?: unknown) => void
  layoutMs: number
  engineMs: number
  engineConfirmMs: number
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
  // INSTALLING OVER A LIVE ENGINE IS NEVER ACCEPTABLE, and neither half of this
  // is redundant: the stop can time out or throw, AND a stop that RESOLVES
  // still proves nothing, because Engine.stop returns straight after
  // child.kill() without waiting for the exit. Death must be observed.
  // bounded() reports HOW a promise ended, not what it resolved to, so the
  // answer is captured on the way through; all three facts are required.
  let observedGone = false
  const confirmed = await bounded(
    seams.confirmEngineStopped().then(value => { observedGone = value === true }),
    seams.engineConfirmMs)
  const gone = stopped === 'ok' && confirmed === 'ok' && observedGone
  if (!gone) {
    const detail = stopped === 'timeout' ? 'engine did not confirm shutdown in time; refusing to install over it'
      : stopped !== 'ok' ? 'engine shutdown failed; refusing to install over it'
      : 'engine process was not observed to exit; refusing to install over it'
    seams.record('engine-shutdown-timeout', detail)
    seams.cancelWatchdog()
    return { stage: 'engine-unconfirmed', detail }
  }
  seams.record('engine-shutdown', 'engine process observed gone')
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
  // ⚠ THE LINE THIS REPLACES IS IN THE INCIDENT RECORD, TWICE, AND IT WAS A
  // FALSE CLUE. It read "installer launched for C:\Program Files\Orgtree\Orgtree
  // (NOTE: this /D= argument will reach NSIS quoted)", printed on every
  // all-users update whether or not anything was wrong, and the incident report
  // cited it as corroboration for a hypothesis that measurement later refuted.
  // A warning that fires on every healthy update is worse than no line at all:
  // the next person investigating reads it as evidence.
  //
  // So what is recorded now is the FORM that was sent and nothing about
  // consequences. It stays because an incident log that cannot tell the two
  // forms apart cannot rule either of them in or out.
  seams.record('handoff', 'installer launched for ' + handoff.directory
    + (handoff.directoryQuotedByNode
      ? ' (/D= contains whitespace, so Windows quotes it on the command line)'
      : ' (/D= contains no whitespace and is passed through unquoted)'))
  return { stage: 'handed-off', handoff }
}

interface UpdateCallbacks {
  /** Wraps the real updater's checkForUpdates(). It does NOT download: autoDownload
   *  is off precisely so the offer can be judged against the prepared package
   *  before the library starts deleting things - see updateOfferIsNewer. */
  run: () => Promise<{ hasUpdate: boolean; version?: string }>
  /** Starts the download for the offer `run()` just reported, once it has been
   *  accepted. Wraps electron-updater's downloadUpdate(). */
  download: () => Promise<void>
  report: (status: UpdateStatus) => void
  now?: () => number
  /** Manual checks remain available when background updates are disabled. */
  automaticEnabled?: () => boolean
  /** A prepared package whose own handoff ended without changing the running
   * version must be replaceable by a later periodic check. */
  preparedInstallFailed?: () => boolean
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
  /** The package already prepared on disk, kept SEPARATELY from the live status
   *  because a check overwrites that status with 'checking' on its way to an
   *  answer. Without it, a check that finds nothing newer would leave the user
   *  looking at "up to date" with an installer sitting there ready to run. */
  private prepared: UpdateStatus | null = null
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
   *  only actually checks the network when due. A prepared package blocks polls
   *  until it has failed its own install, then a later release may replace it. */
  async tick(): Promise<void> {
    if (this.callbacks.automaticEnabled?.() === false) return
    if (this.inFlight) return
    const failedPreparedInstall = this.status.state === 'pending-idle'
      && this.callbacks.preparedInstallFailed?.() === true
    if (this.status.state === 'downloading' || (this.status.state === 'pending-idle' && !failedPreparedInstall)) return
    const now = this.now()
    // lastCheckAt is only set on success, so a failure must be judged solely by nextRetryAt -
    // otherwise "never succeeded yet" would keep looking like "never checked yet" and skip backoff entirely.
    const due = this.consecutiveFailures > 0
      ? now >= this.nextRetryAt
      : this.lastCheckAt === null || now - this.lastCheckAt >= this.periodicMs
    if (!due) return
    await this.runCheck()
  }

  /** The version of the package already prepared on disk, if one is: the record
   *  this controller judges the next offer against. Survives a check, which the
   *  live status does not - `current().version` is undefined for the whole of
   *  'checking'. Read by the tests; the product reads `current()` instead. */
  preparedVersion(): string | undefined { return this.prepared?.version }

  /** A user-triggered check. Coalesces with any in-flight check and bypasses backoff.
   *
   *  A PREPARED update no longer refuses one (user 2026-09-11): that left anyone
   *  holding a ready update with no way to pick up a newer release. A download
   *  already in progress still refuses, because a second check could not help -
   *  electron-updater's downloadUpdate() returns the SAME in-flight download
   *  rather than fetching what the new check found, so the only thing a check
   *  there can do is disturb the transfer. */
  async check(): Promise<UpdateStatus> {
    if (this.inFlight) return this.inFlight
    if (this.status.state === 'downloading') {
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
    this.prepared = { ...this.status }
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
        // If anything has already moved the state off 'checking', that terminal
        // event won and must not be overwritten back to downloading/up-to-date.
        // The specific race this was written for - a cached autoDownload firing
        // update-downloaded before run() settled - can no longer arise now that
        // autoDownload is off and the download is started below, after this
        // point. The guard stays because the controller must not assume the
        // order in which its caller delivers the library's events; the composed
        // tests drive exactly that order through the seams.
        if (this.status.state === 'checking') {
          // hasUpdate only means "newer than the RUNNING version", which with a
          // package already prepared is true of that very package and of any
          // rolled-back release below it. Judge the offer against what is
          // prepared before accepting it; accepting is what deletes it.
          if (result.hasUpdate && updateOfferIsNewer(result.version, this.prepared?.version)) {
            this.prepared = null
            this.setStatus({ state: 'downloading', version: result.version })
            // Not awaited: a download outlives the check that found it. Its
            // failure arrives on the library's own error event, and errored()
            // is a no-op the second time, so routing a rejection there too
            // cannot double-count the backoff.
            void this.callbacks.download().catch(() => this.errored())
          } else {
            // Nothing newer than what is already on disk. The prepared package
            // stays ready and installable, and the check is still ANSWERED,
            // which is what `recheck` is for.
            this.setStatus(this.prepared ? { ...this.prepared, recheck: 'up-to-date' } : { state: 'up-to-date' })
          }
        }
      } catch {
        if (this.status.state === 'checking') {
          this.scheduleBackoff()
          // A check that could not reach the feed likewise says nothing about
          // the package already on disk. Losing a ready update to a moment of
          // no network would be the worst possible answer to "check again".
          this.setStatus(this.prepared ? { ...this.prepared, recheck: 'unavailable' } : { state: 'unavailable' })
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
