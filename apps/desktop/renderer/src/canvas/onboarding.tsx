// First-run setup (docket onboard-theme-startup-and-first-organization):
// choose the visual theme and startup behavior, then create the first
// organization — one card on the welcome screen, shown exactly while a fresh
// installation has no organizations and setup was never completed or skipped.
// Existing installations never see it: any organization (created or imported)
// hides it, and finishing or skipping persists `onboarded` in the desktop
// preferences so it stays gone even with zero organizations later.
//
// Completing setup populates ~/.orgtree/charters from the bundled charter
// presets FIRST and records `onboarded` only after that succeeds (docket
// populate-charter-documents-during-onboarding): the user explicitly asked
// for populated charter locations, so a failed seed is shown and retryable
// rather than silently skipped. The bundled presets still serve the hire
// form regardless, so nothing else degrades while a retry is pending.
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { desktop } from '../desktop'
import type { NativeDesktop, NativePreferences } from '../desktop'
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

/** Populate the charter documents, then record setup as complete — in that
 *  order, atomically from the caller's point of view: a populate failure
 *  rejects WITHOUT writing the flag, so setup stays visibly incomplete and
 *  can be retried. */
export async function completeOnboarding(bridge: NativeDesktop): Promise<NativePreferences> {
  await populateCharters()
  return bridge.setPreferences({ onboarded: true })
}

/** The creation path App uses while the setup card is showing. The card
 *  unmounts the moment the first organization exists (the welcome gate flips
 *  on orgCount and on the selected slug), so completion cannot live in a
 *  child effect — it runs HERE, after the create succeeds and before the
 *  caller refreshes the organization list. A populate failure is surfaced
 *  through `onError` and leaves `onboarded` unset: the organization still
 *  opens, and setup returns to offer the seed again only if the install is
 *  ever back to zero organizations. */
export async function onboardingCreate<T>(
  create: () => Promise<T>, onError: (message: string) => void,
): Promise<T> {
  const made = await create()
  const bridge = desktop()
  if (bridge) {
    try { await completeOnboarding(bridge) }
    catch (e) { onError(e instanceof Error ? e.message : String(e)) }
  }
  return made
}

export function Onboarding({ children, windowControls }: {
  /** the real organization-creation form (App's NewOrg), embedded as step 3,
   *  with its onCreate already wrapped in `onboardingCreate` by the caller */
  children: ReactNode
  windowControls?: ReactNode
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
    // Charter documents first, completion flag second: a populate failure is
    // SHOWN and the button works again — setup is never marked done with the
    // documented location unpopulated (populate is idempotent and never
    // overwrites, so retrying is always safe).
    setBusy(true)
    completeOnboarding(bridge)
      .then(p => { setPrefs(p); setError('') })
      .catch((e: Error) => {
        finished.current = false
        setError(`Charter documents were not populated: ${e.message} — press again to retry.`)
      })
      .finally(() => setBusy(false))
  }

  if (!bridge) return null
  const theme = prefs && isVisualTheme(prefs.visualTheme) ? prefs.visualTheme : 'orgtree'
  return (
    <div className="welcome-card onboarding">
      <h2 className="onboarding-head">Welcome to Orgtree{windowControls}</h2>
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
