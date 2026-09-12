import { useEffect, useState } from 'react'
import { desktop } from '../desktop'
import type { NativePreferences } from '../desktop'
import type { UpdateCapability, UpdateStatus } from '../../../../../packages/contracts'
import { describeUpdateStatus } from '../update-notice'
import { SetGroup, SetRow, SetToggle } from './settingskit'
import { NOTIFICATION_OPTIONS, notificationPreferences } from '../../../../../packages/contracts/notifications'

export function DesktopSettings() {
  const bridge = desktop()
  const [prefs, setPrefs] = useState<NativePreferences | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null)
  const [checking, setChecking] = useState(false)
  const [capability, setCapability] = useState<UpdateCapability | null>(null)
  useEffect(() => {
    if (!bridge) return
    let alive = true, changed = false
    bridge.getPreferences().then(p => { if (alive && !changed) setPrefs(p) })
      .catch((e: Error) => { if (alive) setError(e.message) })
    if (bridge.getUpdateStatus) void bridge.getUpdateStatus().then(s => { if (alive) setUpdateStatus(s) }).catch(() => {})
    // Where this copy is installed cannot change while it runs, so this is
    // fetched once rather than pushed.
    if (bridge.getUpdateCapability) void bridge.getUpdateCapability().then(c => { if (alive) setCapability(c) }).catch(() => {})
    const unsubscribe = bridge.onEvent(e => {
      if (!alive) return
      if (e.type === 'preferences') { changed = true; setPrefs(e.data as NativePreferences) }
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
  return <><SetGroup title="Desktop">
    {error && <p role="alert">{error}</p>}
    <SetToggle label="start at login" checked={prefs?.startAtLogin ?? true}
      disabled={!prefs || busy} onChange={startAtLogin => put({ startAtLogin })}
      hint="Start quietly in the system tray." />
    <SetToggle label="exit when the last window closes" checked={prefs?.exitOnClose ?? false}
      disabled={!prefs || busy} onChange={exitOnClose => put({ exitOnClose })}
      hint="Closing the main window keeps your other windows open." />
    {/* Disabled where it cannot do anything: if Orgtree cannot write to its own
      * program directory, the installer needs an approval nobody is present to
      * give, so no update will ever install unattended and the switch is just
      * misleading. "Update now" still works, which is what the hint points at. */}
    <SetToggle label="automatic updates" checked={prefs?.automaticUpdates ?? true}
      disabled={!prefs || busy || capability?.unattendedInstall === false}
      onChange={automaticUpdates => put({ automaticUpdates })}
      title={capability?.unattendedInstall === false ? 'Unattended installation is unavailable for this installation.' : undefined}
      hint={capability?.unattendedInstall === false
        ? `Unavailable: Orgtree cannot write to ${capability.installDirectory}, so it can never install an update on its own. Use "Update now" and approve the Windows prompt.`
        : 'Check, download and install updates when idle. Turn off to update manually; a download already started may finish.'} />
    <SetRow label="updates"
      hint={updateStatus ? describeUpdateStatus(updateStatus) ?? 'No update check has run yet.' : undefined}>
      <button type="button" onClick={checkForUpdates} disabled={checking || !bridge.checkForUpdates}>
        {checking ? 'Checking…' : 'Check for updates'}
      </button>
    </SetRow>
  </SetGroup>
  <SetGroup title="Notifications">
    {NOTIFICATION_OPTIONS.map(({ key, label }) => <SetToggle key={key} label={label}
      checked={notificationPreferences(prefs ?? {})[key]} disabled={!prefs || busy}
      onChange={value => put({ [key]: value })}
      hint={key === 'notifyWhileFocused' ? 'When off, notifications pause while any Orgtree window has focus.' : undefined} />)}
  </SetGroup></>
}
