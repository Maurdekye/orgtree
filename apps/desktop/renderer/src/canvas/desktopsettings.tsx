import { useEffect, useState } from 'react'
import { desktop } from '../desktop'
import type { NativePreferences } from '../desktop'
import type { UpdateStatus } from '../../../../../packages/contracts'
import { describeUpdateStatus } from '../update-notice'
import { SetGroup, SetRow, SetToggle } from './settingskit'

export function DesktopSettings() {
  const bridge = desktop()
  const [prefs, setPrefs] = useState<NativePreferences | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null)
  const [checking, setChecking] = useState(false)
  useEffect(() => {
    if (!bridge) return
    let alive = true
    bridge.getPreferences().then(p => { if (alive) setPrefs(p) })
      .catch((e: Error) => { if (alive) setError(e.message) })
    if (bridge.getUpdateStatus) void bridge.getUpdateStatus().then(s => { if (alive) setUpdateStatus(s) }).catch(() => {})
    const unsubscribe = bridge.onEvent(e => {
      if (!alive) return
      if (e.type === 'preferences') setPrefs(e.data as NativePreferences)
      else if (e.type === 'update') setUpdateStatus(e.data as UpdateStatus)
    })
    return () => { alive = false; unsubscribe() }
  }, [bridge])
  if (!bridge) return null
  const put = (patch: Partial<NativePreferences>) => {
    setBusy(true)
    bridge.setPreferences(patch).then(p => { setPrefs(p); setError('') })
      .catch((e: Error) => setError(e.message)).finally(() => setBusy(false))
  }
  const checkForUpdates = () => {
    if (!bridge.checkForUpdates) return
    setChecking(true)
    bridge.checkForUpdates().then(setUpdateStatus).finally(() => setChecking(false))
  }
  return <SetGroup title="Desktop">
    {error && <p role="alert">{error}</p>}
    <SetToggle label="start at login" checked={prefs?.startAtLogin ?? true}
      disabled={!prefs || busy} onChange={startAtLogin => put({ startAtLogin })}
      hint="Start quietly in the system tray." />
    <SetToggle label="exit when the last window closes" checked={prefs?.exitOnClose ?? false}
      disabled={!prefs || busy} onChange={exitOnClose => put({ exitOnClose })}
      hint="Closing the main window keeps your other windows open." />
    <SetToggle label="notify about routine activity" checked={prefs?.routineNotifications ?? false}
      disabled={!prefs || busy} onChange={routineNotifications => put({ routineNotifications })}
      hint="Questions, urgent mail and work needing attention notify by default." />
    <SetToggle label="automatic updates" checked={prefs?.automaticUpdates ?? true}
      disabled={!prefs || busy} onChange={automaticUpdates => put({ automaticUpdates })}
      hint="Check, download and install updates when idle. Turn off to update manually; a download already started may finish." />
    <SetRow label="updates"
      hint={updateStatus ? describeUpdateStatus(updateStatus) ?? 'No update check has run yet.' : undefined}>
      <button type="button" onClick={checkForUpdates} disabled={checking || !bridge.checkForUpdates}>
        {checking ? 'Checking…' : 'Check for updates'}
      </button>
    </SetRow>
  </SetGroup>
}
