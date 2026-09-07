import { useEffect, useState } from 'react'
import { desktop } from '../desktop'
import type { NativePreferences } from '../desktop'
import { SetGroup, SetToggle } from './settingskit'

export function DesktopSettings() {
  const bridge = desktop()
  const [prefs, setPrefs] = useState<NativePreferences | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!bridge) return
    let alive = true
    bridge.getPreferences().then(p => { if (alive) setPrefs(p) })
      .catch((e: Error) => { if (alive) setError(e.message) })
    const unsubscribe = bridge.onEvent(e => {
      if (e.type === 'preferences' && alive) setPrefs(e.data as NativePreferences)
    })
    return () => { alive = false; unsubscribe() }
  }, [bridge])
  if (!bridge) return null
  const put = (patch: Partial<NativePreferences>) => {
    setBusy(true)
    bridge.setPreferences(patch).then(p => { setPrefs(p); setError('') })
      .catch((e: Error) => setError(e.message)).finally(() => setBusy(false))
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
  </SetGroup>
}
