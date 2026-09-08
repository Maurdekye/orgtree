// First-run setup (docket onboard-theme-startup-and-first-organization):
// choose the visual theme and startup behavior, then create the first
// organization — one card on the welcome screen, shown exactly while a fresh
// installation has no organizations and setup was never completed or skipped.
// Existing installations never see it: any organization (created or imported)
// hides it, and finishing or skipping persists `onboarded` in the desktop
// preferences so it stays gone even with zero organizations later.
//
// Completing setup also populates ~/.orgtree/charters from the bundled
// charter presets (docket populate-charter-documents-during-onboarding);
// that call never overwrites a user file, and a failure never blocks setup —
// the hire form falls back to the bundled presets either way.
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { desktop } from '../desktop'
import type { NativePreferences } from '../desktop'
import { populateCharters } from '../api'
import { applyTheme, THEMES } from '../themes'
import { isVisualTheme, VISUAL_THEMES } from '../../../../../packages/contracts/visual-theme'
import type { VisualTheme } from '../../../../../packages/contracts/visual-theme'
import { SetToggle } from './settingskit'

/** The gate, pure for testing: show setup only when the desktop preferences
 *  are actually loaded (null = still unknown — never flash setup at someone
 *  who already finished it), setup was never completed, and the ENGINE's
 *  organization list is known to be empty. `orgsKnown` distinguishes "none"
 *  from "not fetched yet" for the same no-flash reason. */
export function showOnboarding(prefs: NativePreferences | null,
                               orgCount: number, orgsKnown: boolean): boolean {
  return prefs !== null && prefs.onboarded !== true && orgsKnown && orgCount === 0
}

export function Onboarding({ orgCount, children }: {
  orgCount: number
  /** the real organization-creation form (App's NewOrg), embedded as step 3 */
  children: ReactNode
}) {
  const bridge = desktop()
  const [prefs, setPrefs] = useState<NativePreferences | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const finished = useRef(false)
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

  const put = (patch: Partial<NativePreferences>) => {
    if (!bridge) return
    setBusy(true)
    bridge.setPreferences(patch).then(p => { setPrefs(p); setError('') })
      .catch((e: Error) => setError(e.message)).finally(() => setBusy(false))
  }

  const complete = () => {
    if (!bridge || finished.current) return
    finished.current = true
    // Charter documents first, completion flag second: if the engine call
    // fails the card stays up and the button can be pressed again, instead
    // of marking setup done with the documented location never populated.
    // populate is idempotent and never overwrites, so a retry is safe.
    setBusy(true)
    populateCharters()
      .catch(() => { /* an old engine without the route must not trap setup */ })
      .then(() => bridge.setPreferences({ onboarded: true }))
      .then(p => { setPrefs(p); setError('') })
      .catch((e: Error) => { finished.current = false; setError(e.message) })
      .finally(() => setBusy(false))
  }

  // Creating the first organization through the embedded form IS finishing
  // setup: the welcome screen swaps to the new organization, so complete
  // now rather than leaving the flag unset for a second first run.
  useEffect(() => { if (orgCount > 0) complete() },
    [orgCount])  // eslint-disable-line react-hooks/exhaustive-deps

  if (!bridge) return null
  const theme = prefs && isVisualTheme(prefs.visualTheme) ? prefs.visualTheme : 'orgtree'
  return (
    <div className="welcome-card onboarding">
      <h2>Welcome to Orgtree</h2>
      <p className="dim">A minute of setup — everything here can be changed
        later in Settings.</p>
      {error && <p role="alert" className="error">{error}</p>}

      <div className="field-label">Visual theme</div>
      <div className="onboard-themes" role="radiogroup" aria-label="Visual theme">
        {VISUAL_THEMES.map(id => (
          <button key={id} type="button" role="radio" aria-checked={theme === id}
            className={'onboard-theme' + (theme === id ? ' selected' : '')}
            disabled={!prefs || busy}
            onClick={() => { applyTheme(id); put({ visualTheme: id as VisualTheme }) }}>
            <span className="onboard-swatch" style={{ background: THEMES[id].accent }} />
            {THEMES[id].label}
          </button>
        ))}
      </div>

      <div className="field-label">Startup</div>
      <SetToggle label="start at login" checked={prefs?.startAtLogin ?? true}
        disabled={!prefs || busy} onChange={startAtLogin => put({ startAtLogin })}
        hint="Start quietly in the system tray." />
      <SetToggle label="exit when the last window closes" checked={prefs?.exitOnClose ?? false}
        disabled={!prefs || busy} onChange={exitOnClose => put({ exitOnClose })}
        hint="Off keeps agents running in the tray when the window closes." />

      <div className="field-label">Your first organization</div>
      <p className="dim">An organization is a team of agents around one
        project. You can also import existing organizations later from
        Settings.</p>
      {children}

      <div className="onboard-actions">
        <button type="button" className="dim" disabled={busy}
          onClick={complete}>skip setup for now</button>
        <button type="button" className="primary" disabled={busy}
          onClick={complete}>finish setup</button>
      </div>
    </div>
  )
}
