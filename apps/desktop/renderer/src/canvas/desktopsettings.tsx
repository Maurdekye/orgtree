import { useEffect, useRef, useState } from 'react'
import { desktop } from '../desktop'
import type { NativePreferences } from '../desktop'
import type {
  DataLocationLastMoveReport, DataLocationPreflight, DataLocationProgress,
  DataLocationState, DataLocationUnreadableEntry,
  RunAsAdministratorState, StartupKind, UpdateCapability,
} from '../../../../../packages/contracts'
import { initiatingDocument, popoutNameForDocument } from '../windowlife'
import { PinFrame } from './modalpin'
import { SetGroup, SetRow, SetToggle } from './settingskit'
import { NOTIFICATION_OPTIONS, notificationPreferences } from '../../../../../packages/contracts/notifications'

/** "Run on boot" (the user, 2026-10-16 09:38Z; it was "Run on startup", and it
 *  is stored as startAtLogin): one switch for everything of Orgtree that
 *  starts without the user opening it (docket
 *  start-at-login-off-means-nothing-of-orgtree-star). The engine starts at
 *  boot, and while the user is signed in its agents run in their session
 *  (docket option-to-run-the-background-engine-in-the-user-s). Where Orgtree
 *  cannot start at boot (a per-user installation, macOS, Linux) it reads "run
 *  on sign-in" (coordinator ruling A). */
export const startupLabel = (kind: StartupKind) => (kind === 'boot' ? 'Run on boot' : 'Run on sign-in')
export const startupHint = (kind: StartupKind) => (kind === 'boot'
  ? "Start Orgtree's background engine when the computer starts, before anyone signs in. While you are signed in, "
    + 'agents run in your session, with your desktop and apps. Off: nothing of Orgtree runs until you open it. '
    + 'Windows asks for permission to change this.'
  : 'Start Orgtree quietly in the system tray when you sign in, with its background engine. '
    + 'Off: nothing of Orgtree runs until you open it.')

/** What the startup switch is here: "run on boot" until the desktop says. */
export function useStartupKind(): StartupKind {
  const bridge = desktop()
  const [kind, setKind] = useState<StartupKind>('boot')
  useEffect(() => {
    if (!bridge?.getStartupKind) return
    let alive = true
    // anything but the two names keeps the default
    bridge.getStartupKind().then(k => { if (alive && (k === 'boot' || k === 'signin')) setKind(k) }).catch(() => {})
    return () => { alive = false }
  }, [bridge])
  return kind
}

export function DesktopSettings() {
  const bridge = desktop()
  const kind = useStartupKind()
  const [prefs, setPrefs] = useState<NativePreferences | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [capability, setCapability] = useState<UpdateCapability | null>(null)
  useEffect(() => {
    if (!bridge) return
    let alive = true, changed = false
    // ⚠ SUBSCRIBE BEFORE READING. The app-wide broadcasts are not held, so an
    // event that fires while an initial read is in flight is the NEWER truth;
    // attaching first is what lets the flags below notice it at all.
    const unsubscribe = bridge.onEvent(e => {
      if (!alive) return
      if (e.type === 'preferences') { changed = true; setPrefs(e.data as NativePreferences) }
    })
    bridge.getPreferences().then(p => { if (alive && !changed) setPrefs(p) })
      // ⚠ THE ERROR COMPLETION IS GUARDED TOO. A read that failed after an
      // event already delivered good state would otherwise replace a working
      // panel with an error about a request whose answer is no longer wanted.
      .catch((e: Error) => { if (alive && !changed) setError(e.message) })
    // Where this copy is installed cannot change while it runs, so this is
    // fetched once rather than pushed.
    if (bridge.getUpdateCapability) void bridge.getUpdateCapability().then(c => { if (alive) setCapability(c) }).catch(() => {})
    return () => { alive = false; unsubscribe() }
  }, [bridge])
  if (!bridge) return null
  const put = (patch: Partial<NativePreferences>) => {
    setBusy(true)
    bridge.setPreferences(patch).then(p => { setPrefs(p); setError('') })
      .catch((e: Error) => setError(e.message)).finally(() => setBusy(false))
  }
  const currentPrefs = notificationPreferences(prefs ?? {})
  const masterOn = currentPrefs.notificationsEnabled
  return <><SetGroup title="Desktop">
    {error && <p role="alert">{error}</p>}
    <SetToggle label={startupLabel(kind)} checked={prefs?.startAtLogin ?? true}
      disabled={!prefs || busy} onChange={startAtLogin => put({ startAtLogin })}
      hint={startupHint(kind)} />
    <SetToggle label="Exit when the last window closes" checked={prefs?.exitOnClose ?? false}
      disabled={!prefs || busy} onChange={exitOnClose => put({ exitOnClose })}
      hint="Closing the main window keeps your other windows open." />
    {/* Disabled where it cannot do anything: if Orgtree cannot write to its own
      * program directory, the installer needs an approval nobody is present to
      * give, so no update will ever install unattended and the switch is just
      * misleading. "Update now" still works, which is what the hint points at. */}
    <SetToggle label="Automatic updates" checked={prefs?.automaticUpdates ?? true}
      disabled={!prefs || busy || capability?.unattendedInstall === false}
      onChange={automaticUpdates => put({ automaticUpdates })}
      title={capability?.unattendedInstall === false ? 'Unattended installation is unavailable for this installation.' : undefined}
      hint={capability?.unattendedInstall === false
        ? `Unavailable: Orgtree cannot write to ${capability.installDirectory}, so it can never install an update on its own. Use "Update now" and approve the Windows prompt.`
        : 'Check, download and install updates when idle. Turn off to update manually; a download already started may finish.'} />
  </SetGroup>
  <SetGroup title="Notifications">
    <SetRow label="Open questions" hint="Choose what a question in the taskbar menu opens. An existing pinned or popped-out desk is brought to the front.">
      <select aria-label="Open questions" value={prefs?.questionTarget ?? 'desk'} disabled={!prefs || busy}
        onChange={e => put({ questionTarget: e.target.value === 'mail' ? 'mail' : 'desk' })}>
        <option value="desk">focus the agent desk</option>
        <option value="mail">open questions as mail</option>
      </select>
    </SetRow>
    <SetToggle label="Notifications"
      checked={masterOn} disabled={!prefs || busy}
      onChange={notificationsEnabled => put({ notificationsEnabled })}
      hint="When off, all desktop notifications are suspended." />
    {NOTIFICATION_OPTIONS.map(({ key, label }) => <SetToggle key={key} label={label}
      checked={currentPrefs[key]} disabled={!prefs || busy || !masterOn}
      onChange={value => put({ [key]: value })}
      hint={key === 'notifyWhileFocused' ? 'When off, notifications pause while any Orgtree window has focus.' : undefined} />)}
  </SetGroup></>
}

/** "Run as admin" — whether the Session 0 engine and the sign-in helper, and
 *  so every agent they start, keep administrator rights: both or neither
 *  (the user, 2026-10-21 15:27Z and 2026-10-22 07:29Z). Off by default. The
 *  value lives in HKLM, so a change asks Windows for permission once, and it
 *  applies at once: the engine restarts in Session 0 and the helper follows
 *  (coordinator Q1, 2026-10-22). Restarts, updates, reboots and sign-ins
 *  then ask nothing. */
export function RunAsAdministratorSetting() {
  const bridge = desktop()
  const [state, setState] = useState<RunAsAdministratorState | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!bridge?.getRunAsAdministrator) return
    let alive = true
    bridge.getRunAsAdministrator().then(s => { if (alive) setState(s) })
      .catch((e: Error) => { if (alive) setError(e.message) })
    return () => { alive = false }
  }, [bridge])
  if (!bridge?.getRunAsAdministrator || !bridge.setRunAsAdministrator) return null
  const set = bridge.setRunAsAdministrator
  const change = (enabled: boolean) => {
    setBusy(true)
    set(enabled).then(s => { setState(s); setError('') })
      .catch((e: Error) => setError(e.message)).finally(() => setBusy(false))
  }
  return <SetGroup title="Administrator rights">
    {error && <p role="alert">{error}</p>}
    <SetToggle label="Run as admin" checked={state?.enabled ?? false}
      disabled={!state || busy || !state.available}
      title={state && !state.available ? state.reason : undefined}
      onChange={enabled => change(enabled)}
      hint={state && !state.available ? state.reason
        : 'Every agent runs with full administrator rights on this PC: the engine in Session 0 and the sign-in helper in your session, '
          + 'always together. Windows asks once per change, and both restart at once, which interrupts running turns; boot, sign-in, '
          + 'restarts and updates then need no further prompts.'} />
  </SetGroup>
}

export function formatDataBytes(bytes: number | null | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return ''
  if (bytes < 1024) return `${Math.round(bytes)} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  if (bytes < 1024 ** 4) return `${(bytes / 1024 ** 3).toFixed(2)} GB`
  return `${(bytes / 1024 ** 4).toFixed(2)} TB`
}

function unreadableCountLabel(entries: readonly DataLocationUnreadableEntry[] | readonly string[]): string {
  const count = entries.length
  const anyFile = entries.some(e => typeof e !== 'string' && e.kind === 'file')
  if (anyFile) return count === 1 ? '1 file' : `${count} folders or files`
  return count === 1 ? '1 folder' : `${count} folders`
}

export function DataLocationMoveResultModal({ report, close }: {
  report: DataLocationLastMoveReport
  close: () => void
}) {
  const bridge = desktop()
  const [openingLog, setOpeningLog] = useState(false)
  const [logError, setLogError] = useState('')
  const pathsToShow = report.remainingPaths.length > 0
    ? report.remainingPaths
    : report.skippedEntries.map(e => e.path)
  const countLabel = unreadableCountLabel(
    report.remainingPaths.length > 0 ? report.remainingPaths : report.skippedEntries,
  )

  const handleOpenLog = async () => {
    if (!bridge?.openDataLocationMoveLog || openingLog) return
    setOpeningLog(true)
    setLogError('')
    try {
      const res = await bridge.openDataLocationMoveLog()
      if (!res.ok) setLogError(res.error || 'Could not open the data move log.')
    } catch (e) {
      setLogError(e instanceof Error ? e.message : String(e))
    } finally {
      setOpeningLog(false)
    }
  }

  return (
    <PinFrame kind="data-location-move-result" title="Data folder moved"
      panel="settings move-data-dialog"
      close={close} onEsc={close} closable pinnable={false}
      dialogLabel="Data folder moved">
      <h3>Data folder moved</h3>
      <div className="dataloc-report">
        <p>
          Moved; {countLabel} could not be read and stayed in{' '}
          <code data-streamer-field="path">{report.fromRoot}</code>
          {report.deletePreviousRequested && !report.oldFolderDeleted
            ? ' (everything else in the previous folder was deleted; parent folders holding these stayed):'
            : ':'}
        </p>
        {pathsToShow.length > 0 && (
          <ul className="dataloc-unreadable-list">
            {pathsToShow.map(p => (
              <li key={p}><code data-streamer-field="path">{p}</code></li>
            ))}
          </ul>
        )}
      </div>
      {logError && <p className="ask-warn" role="alert">{logError}</p>}
      <div className="dataloc-actions">
        {bridge?.openDataLocationMoveLog && (
          <button type="button" disabled={openingLog} onClick={() => { void handleOpenLog() }}>
            {openingLog ? 'Opening…' : 'Open move log'}
          </button>
        )}
        <button type="button" className="primary" onClick={close}>OK</button>
      </div>
    </PinFrame>
  )
}

/** "Data location" — where Orgtree keeps its organizations, PostgreSQL cluster,
 *  transcripts, diagnostics and managed CLI profiles on this computer (4.6.0,
 *  docket settings-choose-where-orgtree-keeps-its-data-dat). The pointer file
 *  itself stays in `<userData>/data-location.json`; moving copies and verifies
 *  every readable file before switching over, keeps the old folder read-only
 *  unless the user ticks the unticked-by-default delete box or clicks "Delete
 *  previous folder (<size>)", and rolls back cleanly on Cancel or any startup failure. */
export function DataLocationSetting({ onDialogChange }: {
  onDialogChange?: (open: boolean) => void
} = {}) {
  const bridge = desktop()
  const [state, setState] = useState<DataLocationState | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [choosing, setChoosing] = useState(false)
  const [checking, setChecking] = useState(false)
  const [opening, setOpening] = useState<'current' | 'previous' | null>(null)
  const [openingLog, setOpeningLog] = useState(false)
  const [preflight, setPreflight] = useState<DataLocationPreflight | null>(null)
  const [deletePrevious, setDeletePrevious] = useState(false)
  const [moving, setMoving] = useState(false)
  const [progress, setProgress] = useState<DataLocationProgress | null>(null)
  const [dialogError, setDialogError] = useState('')
  const [confirmDeletePrevious, setConfirmDeletePrevious] = useState(false)
  const [deletingPrevious, setDeletingPrevious] = useState(false)
  const preflightSeqRef = useRef(0)

  const dialogOpen = preflight !== null || confirmDeletePrevious
  useEffect(() => {
    onDialogChange?.(dialogOpen)
    return () => { onDialogChange?.(false) }
  }, [dialogOpen, onDialogChange])

  useEffect(() => {
    if (!bridge?.getDataLocationState) return
    let alive = true
    const unsubscribe = bridge.onEvent
      ? bridge.onEvent(e => {
          if (!alive) return
          if (e.type === 'data-location-progress') {
            setProgress(e.data as DataLocationProgress)
          }
        })
      : () => {}
    const triggerBackgroundMeasure = (s: DataLocationState) => {
      const needsMeasure = s.currentBytes === null || (s.previousRoot !== null && s.previousBytes === null)
      if (!needsMeasure || !bridge.measureDataLocationSizes) return
      void bridge.measureDataLocationSizes()
        .then(measured => {
          if (!alive) return
          setState(prev => {
            if (!prev || prev.currentRoot !== measured.currentRoot) return prev
            return {
              ...prev,
              currentBytes: measured.currentBytes,
              previousBytes: prev.previousRoot === measured.previousRoot ? measured.previousBytes : prev.previousBytes,
            }
          })
        })
        .catch(() => {})
    }
    bridge.getDataLocationState()
      .then(s => {
        if (!alive) return
        setState(s)
        setError('')
        triggerBackgroundMeasure(s)
      })
      .catch((e: Error) => { if (alive) setError(e.message) })
    return () => { alive = false; unsubscribe() }
  }, [bridge])

  if (!bridge?.getDataLocationState) return null

  const refreshState = async () => {
    if (!bridge.getDataLocationState) return
    const next = await bridge.getDataLocationState()
    setState(next)
    const needsMeasure = next.currentBytes === null || (next.previousRoot !== null && next.previousBytes === null)
    if (needsMeasure && bridge.measureDataLocationSizes) {
      void bridge.measureDataLocationSizes()
        .then(measured => {
          setState(prev => {
            if (!prev || prev.currentRoot !== measured.currentRoot) return prev
            return {
              ...prev,
              currentBytes: measured.currentBytes,
              previousBytes: prev.previousRoot === measured.previousRoot ? measured.previousBytes : prev.previousBytes,
            }
          })
        })
        .catch(() => {})
    }
  }

  const openFolder = async (which: 'current' | 'previous') => {
    if (!bridge.openDataLocationFolder) return
    setOpening(which)
    setError('')
    try {
      const res = await bridge.openDataLocationFolder(which)
      if (!res.ok) setError(`Could not open folder: ${res.error || 'unknown error'}`)
    } catch (e) {
      setError(`Could not open folder: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setOpening(null)
    }
  }

  const openMoveLog = async () => {
    if (!bridge.openDataLocationMoveLog || openingLog) return
    setOpeningLog(true)
    setError('')
    try {
      const res = await bridge.openDataLocationMoveLog()
      if (!res.ok) setError(`Could not open move log: ${res.error || 'unknown error'}`)
    } catch (e) {
      setError(`Could not open move log: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setOpeningLog(false)
    }
  }

  const cancelPreflight = async () => {
    preflightSeqRef.current += 1
    setChecking(false)
    setProgress(prev => (prev?.phase === 'checking' ? null : prev))
    setNotice('Folder check cancelled.')
    try {
      await bridge.cancelDataLocationPreflight?.()
    } catch {
      // Best-effort cancellation.
    }
  }

  const inspectCandidate = async (candidatePath: string) => {
    if (!bridge.preflightDataLocation) return
    const seq = ++preflightSeqRef.current
    setChecking(true)
    setError('')
    setNotice('')
    setProgress(null)
    try {
      const pf = await bridge.preflightDataLocation(candidatePath)
      if (preflightSeqRef.current !== seq) return
      if (!pf.ok) {
        if (pf.cancelled) {
          setNotice('Folder check cancelled.')
          return
        }
        setError(pf.error || 'That folder cannot be used as the Orgtree data location.')
        return
      }
      // Always unticked by default on every move dialog open (user ruling Q4).
      setDeletePrevious(false)
      setDialogError('')
      setProgress(null)
      setPreflight(pf)
    } catch (e) {
      if (preflightSeqRef.current !== seq) return
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (preflightSeqRef.current === seq) {
        setChecking(false)
        setProgress(prev => (prev?.phase === 'checking' ? null : prev))
      }
    }
  }

  const chooseFolder = async () => {
    if (!bridge.chooseDataLocation || !state) return
    setChoosing(true)
    setError('')
    setNotice('')
    try {
      const doc = initiatingDocument()
      const picked = await bridge.chooseDataLocation(state.currentRoot, popoutNameForDocument(doc))
      setChoosing(false)
      if (!picked) return
      await inspectCandidate(picked)
    } catch (e) {
      setChoosing(false)
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const dismissMoveDialog = () => {
    if (moving) return
    setPreflight(null)
    setDialogError('')
    setProgress(null)
  }

  const confirmMove = async () => {
    if (!preflight || !bridge.moveDataLocation || moving) return
    setMoving(true)
    setDialogError('')
    try {
      const skipPaths = (preflight.unreadableEntries ?? []).map(e => e.path)
      const res = await bridge.moveDataLocation({
        targetPath: preflight.pickedPath,
        deletePrevious,
        ...(skipPaths.length > 0 ? { skipUnreadablePaths: skipPaths } : {}),
      })
      if (!res.ok) {
        if (res.cancelled) {
          setPreflight(null)
          setNotice('Data folder move cancelled. Orgtree stayed on your current data folder.')
        } else {
          setDialogError(res.error || 'Could not move the data folder.')
        }
        await refreshState().catch(() => {})
        return
      }
      setPreflight(null)
      if (!res.relaunching) {
        await refreshState().catch(() => {})
      }
    } catch (e) {
      setDialogError(e instanceof Error ? e.message : String(e))
      await refreshState().catch(() => {})
    } finally {
      setMoving(false)
      setProgress(null)
    }
  }

  const runDeletePrevious = async () => {
    if (!bridge.deletePreviousDataLocation || deletingPrevious) return
    setDeletingPrevious(true)
    setError('')
    try {
      const res = await bridge.deletePreviousDataLocation()
      if (!res.ok) {
        setError(res.error || 'Could not delete the previous data folder.')
        return
      }
      setConfirmDeletePrevious(false)
      if (res.deletedAll === false) {
        const rem = res.remainingPaths ?? []
        const remLabel = unreadableCountLabel(rem)
        setNotice(
          `Deleted everything readable in the previous data folder; ${remLabel} could not be removed and stayed in place.`,
        )
      } else {
        setNotice('Previous data folder deleted.')
      }
      await refreshState()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setDeletingPrevious(false)
    }
  }

  const busy = choosing || checking || moving || deletingPrevious || Boolean(state?.moving)
  const currentSize = formatDataBytes(state?.currentBytes)
  const currentSizeLabel = state ? (state.currentBytes === null ? 'Measuring size…' : currentSize) : ''
  const prevSize = formatDataBytes(state?.previousBytes)
  const prevSizeHint = state?.previousRoot
    ? state.previousBytes === null
      ? ' · Measuring size…'
      : prevSize
        ? ` · ${prevSize}`
        : ''
    : ''
  const statusText = !state
    ? ''
    : state.envOverride
      ? ` · Controlled by the ORGTREE_V2_DATA environment variable for this session${currentSizeLabel ? ` · ${currentSizeLabel}` : ''}`
      : state.isCustom
        ? ` · Custom location${currentSizeLabel ? ` · ${currentSizeLabel}` : ''}`
        : ` · Default location${currentSizeLabel ? ` · ${currentSizeLabel}` : ''}`
  const checkingDetail = checking
    ? progress?.phase === 'checking' && progress.detail
      ? progress.detail
      : 'Checking folder and measuring current data size…'
    : ''

  const activeReport = state?.lastMoveReport ?? null
  const reportPaths = activeReport
    ? activeReport.remainingPaths.length > 0
      ? activeReport.remainingPaths
      : activeReport.skippedEntries.map(e => e.path)
    : []
  const showMoveReport = activeReport !== null && reportPaths.length > 0
  const preflightUnreadable = preflight?.unreadableEntries ?? []
  const preflightUnreadableCount = preflightUnreadable.length

  return <>
    <SetGroup title="Data location">
      {error && <p className="ask-warn" role="alert">{error}</p>}
      {checkingDetail && <p className="dim" role="status">{checkingDetail}</p>}
      {notice && !error && !checkingDetail && <p className="dim" role="status">{notice}</p>}
      {showMoveReport && activeReport && (
        <div className="dataloc-report" role="status">
          <p>
            Moved; {unreadableCountLabel(activeReport.remainingPaths.length > 0 ? activeReport.remainingPaths : activeReport.skippedEntries)}{' '}
            could not be read and stayed in{' '}
            <code data-streamer-field="path">{activeReport.fromRoot}</code>
            {activeReport.deletePreviousRequested && !activeReport.oldFolderDeleted
              ? ' (everything else in the previous folder was deleted; parent folders holding these stayed):'
              : ':'}
          </p>
          <ul className="dataloc-unreadable-list">
            {reportPaths.map(p => (
              <li key={p}><code data-streamer-field="path">{p}</code></li>
            ))}
          </ul>
          {bridge.openDataLocationMoveLog && (
            <div className="dataloc-report-actions">
              <button type="button" disabled={openingLog || moving}
                onClick={() => { void openMoveLog() }}>
                {openingLog ? 'Opening…' : 'Open move log'}
              </button>
            </div>
          )}
        </div>
      )}
      <SetRow label="Current folder" field="data-location"
        hint={state
          ? <><span className="mono" data-streamer-field="path">{state.currentRoot}</span>{statusText}{statusText.endsWith('…') ? ' ·' : '.'} Stores organizations, the PostgreSQL database, transcripts, diagnostics and managed CLI profiles on this computer.</>
          : 'Loading current data folder…'}>
        <button type="button" disabled={!state || opening !== null || moving}
          onClick={() => { void openFolder('current') }}>
          {opening === 'current' ? 'Opening…' : 'Open folder'}
        </button>
        <button type="button"
          disabled={!state || busy || state.envOverride}
          title={state?.envOverride ? 'Unset ORGTREE_V2_DATA to change the saved data location.' : undefined}
          onClick={() => { void chooseFolder() }}>
          {checking ? 'Checking…' : 'Change location…'}
        </button>
        {checking && (
          <button type="button" onClick={() => { void cancelPreflight() }}>
            Cancel
          </button>
        )}
        {state?.isCustom && !state.envOverride && (
          <button type="button" disabled={busy}
            onClick={() => { void inspectCandidate(state.defaultRoot) }}>
            Use default location…
          </button>
        )}
        {!showMoveReport && state?.moveLogExists && bridge.openDataLocationMoveLog && (
          <button type="button" disabled={openingLog || moving}
            onClick={() => { void openMoveLog() }}>
            {openingLog ? 'Opening…' : 'Open move log'}
          </button>
        )}
      </SetRow>
      {state?.previousRoot && (
        <SetRow label="Previous folder" field="data-location-previous"
          hint={<><span className="mono" data-streamer-field="path">{state.previousRoot}</span>{prevSizeHint} · {activeReport?.deletePreviousRequested && !activeReport.oldFolderDeleted
            ? 'Holds the unreadable entries that stayed behind (and their parent folders); delete it once those entries are unlocked or removed.'
            : 'Kept untouched from your last move until you delete it.'}</>}>
          <button type="button" disabled={opening !== null || busy}
            onClick={() => { void openFolder('previous') }}>
            {opening === 'previous' ? 'Opening…' : 'Open folder'}
          </button>
          <button type="button" disabled={busy}
            onClick={() => { setError(''); setNotice(''); setConfirmDeletePrevious(true) }}>
            {prevSize ? `Delete previous folder (${prevSize})` : 'Delete previous folder'}
          </button>
        </SetRow>
      )}
    </SetGroup>

    {preflight && state && (
      <PinFrame kind="move-data-location" title="Move data folder" panel="settings move-data-dialog"
        close={dismissMoveDialog} onEsc={dismissMoveDialog} closable={!moving} pinnable={false}
        dialogLabel="Move data folder">
        <h3>Move data folder</h3>
        <div className="dataloc-summary">
          <div className="dataloc-kv">
            <span className="dim">From</span>
            <code data-streamer-field="path">{state.currentRoot}</code>
          </div>
          <div className="dataloc-kv">
            <span className="dim">To</span>
            <code data-streamer-field="path">{preflight.resolvedRoot}</code>
          </div>
          {preflight.usedSubfolder && (
            <p className="dim dataloc-subfolder-note">
              Because <span className="mono" data-streamer-field="path">{preflight.pickedPath}</span> is not empty, Orgtree will create and use <span className="mono" data-streamer-field="path">{preflight.resolvedRoot}</span> inside it.
            </p>
          )}
          <div className="dataloc-kv">
            <span className="dim">Data to copy</span>
            <span>{formatDataBytes(preflight.sourceBytes) || '0 B'}</span>
          </div>
          <div className="dataloc-kv">
            <span className="dim">Available on destination</span>
            <span>{formatDataBytes(preflight.freeBytes) || 'Unknown'}</span>
          </div>
        </div>
        {preflightUnreadableCount > 0 && (
          <div className="dataloc-unreadable" role="region" aria-label="Unreadable entries">
            <p className="ask-warn">
              {unreadableCountLabel(preflightUnreadable)} in the current data folder could not be read and will stay in{' '}
              <code data-streamer-field="path">{state.currentRoot}</code> if you continue:
            </p>
            <ul className="dataloc-unreadable-list">
              {preflightUnreadable.map(entry => (
                <li key={entry.path}>
                  <code data-streamer-field="path">{entry.path}</code>
                  {entry.code ? <span className="dim"> ({entry.code})</span> : null}
                </li>
              ))}
            </ul>
          </div>
        )}
        <p className="dim">
          {preflightUnreadableCount > 0
            ? 'Orgtree will close its windows, stop the background engine, copy and verify every readable file into the new folder while leaving the unreadable entries above in your original folder, start the engine at the new location, and reopen your windows.'
            : 'Orgtree will close its windows, stop the background engine, copy and verify every file into the new folder, start the engine there, and reopen your windows. If copying is cancelled or the new folder fails to start, Orgtree leaves your current folder untouched and reopens there.'}
        </p>
        {preflight.activeAgents > 0 && (
          <p className="ask-warn" role="alert">
            {preflight.activeAgents === 1
              ? '1 agent turn is running and will be stopped before copying.'
              : `${preflight.activeAgents} agent turns are running and will be stopped before copying.`}
          </p>
        )}
        <label className="dataloc-check">
          <input type="checkbox" checked={deletePrevious} disabled={moving}
            onChange={e => setDeletePrevious(e.target.checked)} />
          <span>Delete the old folder once the new location starts cleanly</span>
        </label>
        {preflightUnreadableCount > 0 && (
          <p className="dim dataloc-check-hint">
            Deletes everything readable in the old folder once the new location starts cleanly; the unreadable entries above and the parent folders holding them stay in place.
          </p>
        )}
        {moving && progress && (
          <p className="dim" role="status">{progress.detail}</p>
        )}
        {dialogError && <p className="ask-warn" role="alert">{dialogError}</p>}
        <div className="dataloc-actions">
          <button type="button" disabled={moving} onClick={dismissMoveDialog}>Cancel</button>
          <button type="button" className="primary" disabled={moving}
            onClick={() => { void confirmMove() }}>
            {moving
              ? 'Moving…'
              : preflightUnreadableCount > 0
                ? 'Move without them'
                : preflight.activeAgents > 0
                  ? 'Stop turns and move'
                  : 'Move data'}
          </button>
        </div>
      </PinFrame>
    )}

    {confirmDeletePrevious && state?.previousRoot && (
      <PinFrame kind="delete-previous-data-location" title="Delete previous data folder"
        panel="settings move-data-dialog"
        close={() => { if (!deletingPrevious) setConfirmDeletePrevious(false) }}
        onEsc={() => { if (!deletingPrevious) setConfirmDeletePrevious(false) }}
        closable={!deletingPrevious} pinnable={false}
        dialogLabel="Delete previous data folder">
        <h3>Delete previous data folder</h3>
        <p className="dim">
          Permanently delete the previous data folder at{' '}
          <span className="mono" data-streamer-field="path">{state.previousRoot}</span>
          {prevSize ? ` (${prevSize})` : ''}? Orgtree is currently running from{' '}
          <span className="mono" data-streamer-field="path">{state.currentRoot}</span>.
          {reportPaths.length > 0
            ? ' Any entries that are still unreadable (and the parent folders holding them) will stay in place while everything else is deleted.'
            : ''}
        </p>
        <div className="dataloc-actions">
          <button type="button" disabled={deletingPrevious}
            onClick={() => setConfirmDeletePrevious(false)}>Cancel</button>
          <button type="button" className="primary" disabled={deletingPrevious}
            onClick={() => { void runDeletePrevious() }}>
            {deletingPrevious
              ? 'Deleting…'
              : prevSize
                ? `Delete previous folder (${prevSize})`
                : 'Delete previous folder'}
          </button>
        </div>
      </PinFrame>
    )}
  </>
}
