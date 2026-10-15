import { useEffect, useState } from 'react'
import { desktop } from '../desktop'
import type { NativePreferences } from '../desktop'
import type { RunAsAdministratorState, EngineStartMode, EngineStartState, UpdateCapability } from '../../../../../packages/contracts'
import { SetGroup, SetRow, SetToggle } from './settingskit'
import { NOTIFICATION_OPTIONS, notificationPreferences } from '../../../../../packages/contracts/notifications'

/** "Run on startup" (stored as startAtLogin): one switch for everything of
 *  Orgtree that starts without the user opening it (docket
 *  start-at-login-off-means-nothing-of-orgtree-star). */
export const RUN_ON_STARTUP_HINT = 'Start Orgtree quietly in the system tray when you sign in, with its background engine. '
  + 'Off: nothing of Orgtree runs until you open it. On an installation for all users, Windows asks for permission to change this.'

export function DesktopSettings() {
  const bridge = desktop()
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
    <SetToggle label="run on startup" checked={prefs?.startAtLogin ?? true}
      disabled={!prefs || busy} onChange={startAtLogin => put({ startAtLogin })}
      hint={RUN_ON_STARTUP_HINT} />
    <EngineStartSetting runOnStartup={prefs?.startAtLogin} />
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
  </SetGroup>
  <SetGroup title="Notifications">
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

/** Where the background engine starts while "run on startup" is on (docket
 *  option-to-run-the-background-engine-in-the-user-s, user 2026-10-15): at
 *  boot, before sign-in (the default), or at sign-in, in the user's own
 *  session. Shown only on an installation for all users on Windows, and
 *  disabled while "run on startup" is off (coordinator rulings 2026-10-15).
 *  Changing it asks Windows for permission; the engine running now keeps
 *  running until "Restart now" (offered for an engine a task started) or the
 *  next sign-in or boot. */
export const ENGINE_START_HINT = 'At boot, agents keep working before you sign in and while you are signed out, '
  + 'but in Windows Session 0: no desktop, real cursor or your own sign-ins. At sign-in, they run in your session '
  + 'with your desktop and sign-ins, only while you are signed in. Windows asks for permission to change this.'
export const ENGINE_STARTS: { value: EngineStartMode; label: string }[] = [
  { value: 'boot', label: 'At boot, before sign-in' },
  { value: 'signin', label: 'At sign-in, in my session' },
]

export function EngineStartSetting({ runOnStartup }: { runOnStartup: boolean | undefined }) {
  const bridge = desktop()
  const [state, setState] = useState<EngineStartState | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // Changed in this session and not yet applied to the running engine.
  const [pending, setPending] = useState(false)
  // Read again whenever "run on startup" changes: the choice depends on it.
  useEffect(() => {
    if (!bridge?.getEngineStart) return
    let alive = true
    bridge.getEngineStart().then(s => { if (alive) setState(s) })
      .catch((e: Error) => { if (alive) setError(e.message) })
    return () => { alive = false }
  }, [bridge, runOnStartup])
  if (!bridge?.getEngineStart || !bridge.setEngineStart || !state?.installed) return null
  const set = bridge.setEngineStart
  const change = (mode: EngineStartMode, restartNow: boolean) => {
    setBusy(true)
    set(mode, restartNow).then(s => { setState(s); setError(''); setPending(!restartNow && s.restartable) })
      .catch((e: Error) => setError(e.message)).finally(() => setBusy(false))
  }
  return <>
    {error && <p role="alert">{error}</p>}
    <SetRow label="engine starts" hint={state.available ? ENGINE_START_HINT : state.reason}>
      <select aria-label="Where the background engine starts" value={state.mode}
        disabled={busy || !state.available}
        onChange={e => change(e.target.value === 'signin' ? 'signin' : 'boot', false)}>
        {ENGINE_STARTS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
      </select>
    </SetRow>
    {pending && <SetRow label="apply the change" hint="Running agent turns are interrupted.">
      <button type="button" disabled={busy} onClick={() => change(state.mode, true)}>
        {busy ? 'Restarting…' : 'Restart the background engine now'}
      </button>
    </SetRow>}
  </>
}

/** "Run Orgtree as administrator" — whether the background engine and the
 *  agents it starts keep administrator rights. Off by default. The value
 *  lives in HKLM, so changing it asks Windows for permission; it applies
 *  when the background engine next starts, which "Restart now" does at once. */
export function RunAsAdministratorSetting() {
  const bridge = desktop()
  const [state, setState] = useState<RunAsAdministratorState | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // Changed in this session and not yet applied to the running engine.
  const [pending, setPending] = useState(false)
  useEffect(() => {
    if (!bridge?.getRunAsAdministrator) return
    let alive = true
    bridge.getRunAsAdministrator().then(s => { if (alive) setState(s) })
      .catch((e: Error) => { if (alive) setError(e.message) })
    return () => { alive = false }
  }, [bridge])
  if (!bridge?.getRunAsAdministrator || !bridge.setRunAsAdministrator) return null
  const set = bridge.setRunAsAdministrator
  const change = (enabled: boolean, restartNow: boolean) => {
    setBusy(true)
    set(enabled, restartNow).then(s => { setState(s); setError(''); setPending(!restartNow) })
      .catch((e: Error) => setError(e.message)).finally(() => setBusy(false))
  }
  return <SetGroup title="Administrator rights">
    {error && <p role="alert">{error}</p>}
    <SetToggle label="run Orgtree as administrator" checked={state?.enabled ?? false}
      disabled={!state || busy || !state.available}
      title={state && !state.available ? state.reason : undefined}
      onChange={enabled => change(enabled, false)}
      hint={state && !state.available ? state.reason
        : 'Agents get full control of this PC. Windows asks for permission to change this, and it applies when the background engine restarts.'} />
    {pending && <SetRow label="apply the change" hint="Running agent turns are interrupted.">
      <button type="button" disabled={busy || !state} onClick={() => state && change(state.enabled, true)}>
        {busy ? 'Restarting…' : 'Restart the background engine now'}
      </button>
    </SetRow>}
  </SetGroup>
}
