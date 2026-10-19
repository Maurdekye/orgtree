import { useEffect, useState } from 'react'
import { desktop } from '../desktop'
import type { NativePreferences } from '../desktop'
import type { RunAsAdministratorState, StartupKind, UpdateCapability } from '../../../../../packages/contracts'
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
export const startupLabel = (kind: StartupKind) => (kind === 'boot' ? 'run on boot' : 'run on sign-in')
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
    <SetRow label="open questions" hint="Choose what a question in the taskbar menu opens. An existing pinned or popped-out desk is brought to the front.">
      <select aria-label="open questions" value={prefs?.questionTarget ?? 'desk'} disabled={!prefs || busy}
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
