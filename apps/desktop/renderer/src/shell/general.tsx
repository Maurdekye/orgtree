// shell/general.tsx — the App settings "General" tab: what happens at
// startup, and what this actually is.
//
// Both halves used to live somewhere the v3 shell removes. The running app
// version was a badge beside the sidebar's Orgtree title and the GitHub link
// sat next to it; the sidebar is gone, so the settled layout gives the version
// to the compact menu's About entry and this tab keeps the fuller detail —
// the engine build and its start time, which is how a person confirms which
// deploy is actually serving.
//
// The startup choice is NEW and is a native preference, not a renderer one.
// It has to be, because the thing it decides — whether the app reopens your
// previous organization windows or starts with one fresh Homepage — happens
// before any renderer exists to hold an opinion.
import { useEffect, useState } from 'react'
import { desktop, nativeWindows, startupMode } from '../desktop'
import type { NativePreferences, OrgStartupMode } from '../desktop'
import { getHost } from '../api'
import type { HostPayload } from '../types'
import { fmtFull } from '../timefmt'
import { SetGroup } from '../canvas/settingskit'

/** The app-wide native preferences, live in every window.
 *
 *  ⚠ THIS IS WHAT MAKES APP SETTINGS A SHARED VALUE RATHER THAN A PER-WINDOW
 *  ONE. Each window owns its own modal — opening settings must never drag you
 *  to another window — but they all read and write the same document, and the
 *  native `preferences` event is broadcast to every main window, so a save in
 *  one is on screen in the others without anybody polling. */
export function useNativePreferences(): {
  prefs: NativePreferences | null
  save: (patch: Partial<NativePreferences>) => Promise<void>
} {
  const [prefs, setPrefs] = useState<NativePreferences | null>(null)
  useEffect(() => {
    const bridge = desktop()
    if (!bridge) return
    let alive = true
    // ⚠ A NEWER BROADCAST MUST WIN OVER AN OLDER READ. `getPreferences()` is
    // a promise; a `preferences` broadcast that arrives while it is in flight
    // carries the NEWER value, and without this guard the older read lands on
    // top and the window silently shows a preference the user has just
    // changed elsewhere. Same revision idiom as agentcolors/contrast/themes.
    let revision = 0
    const off = bridge.onEvent((e) => {
      if (e.type === 'preferences' && alive) { revision++; setPrefs(e.data as NativePreferences) }
    })
    const initial = revision
    bridge.getPreferences()
      .then((p) => { if (alive && initial === revision) setPrefs(p) })
      .catch(() => {})
    return () => { alive = false; off() }
  }, [])
  const save = async (patch: Partial<NativePreferences>) => {
    const bridge = desktop()
    if (!bridge) return
    // paint the choice immediately; the authoritative answer and the broadcast
    // to the other windows both arrive from the bridge
    setPrefs((p) => (p ? { ...p, ...patch } : p))
    const next = await bridge.setPreferences(patch)
    setPrefs(next)
  }
  return { prefs, save }
}

/** The RUNNING APP VERSION, from the desktop shell's own bridge — packaging
 *  is what has a version, not the backend's git state. A plain browser and an
 *  older shell simply do not have it and are given no invented one. */
export function useAppVersion(): string | null {
  const [version, setVersion] = useState<string | null>(null)
  useEffect(() => {
    const bridge = desktop()
    let alive = true
    bridge?.getAppVersion?.().then((v: unknown) => {
      if (alive && typeof v === 'string' && v) setVersion(v)
    }).catch(() => {})
    return () => { alive = false }
  }, [])
  return version
}

const STARTUP_CHOICES: { id: OrgStartupMode; label: string; hint: string }[] = [
  { id: 'restore', label: 'Restore previous windows',
    hint: 'Reopen your previous organization windows in their saved positions.' },
  { id: 'homepage', label: 'Start at homepage',
    hint: 'Open a fresh homepage window when you launch Orgtree.' },
]

/** On startup: restore the previous organization windows, or open one fresh
 *  Homepage. Restoring is the default.
 *
 *  ⚠ ABSENT, NOT DISABLED, IN A SHELL THAT CANNOT HONOUR IT. A plain browser
 *  and the pre-v3 desktop shell have no multi-window startup to choose
 *  between, and a control that stores a preference nothing reads is a
 *  capability claim the app cannot meet. */
export function StartupWindowsSetting() {
  const { prefs, save } = useNativePreferences()
  if (!nativeWindows()) return null
  const mode = startupMode(prefs)
  return (
    <SetGroup title="On startup">
      <div className="shell-startup" role="radiogroup" aria-label="On startup">
        {STARTUP_CHOICES.map((choice) => (
          <label key={choice.id}
            className={'shell-startup-choice' + (mode === choice.id ? ' current' : '')}>
            <input type="radio" name="orgtree-startup" value={choice.id}
              checked={mode === choice.id}
              onChange={() => { void save({ startupMode: choice.id }) }} />
            <span className="shell-startup-label">
              {choice.label}
              {choice.id === 'restore' && <span className="dim"> Default</span>}
            </span>
            <span className="dim shell-startup-hint">{choice.hint}</span>
          </label>
        ))}
      </div>
    </SetGroup>
  )
}

/** What is running, in words rather than a badge. The app version is the
 *  packaged one from the native shell; the engine line is the backend's own
 *  git state and start time. A plain browser has no app version and is not
 *  given an invented one. */
export function AboutSection({ appVersion }: { appVersion: string | null }) {
  const [build, setBuild] = useState<HostPayload['build'] | null>(null)
  useEffect(() => {
    let alive = true
    getHost().then((h) => { if (alive) setBuild(h.build) }).catch(() => {})
    return () => { alive = false }
  }, [])
  const engine = build && build.commit !== 'unknown'
    ? (build.branch ? `${build.branch}@${build.commit}` : build.commit) : null
  return (
    <SetGroup title="About">
      <div className="shell-about">
        {appVersion && <div className="shell-about-row">
          <span className="dim">Orgtree</span> <b>{appVersion}</b></div>}
        {engine && <div className="shell-about-row">
          <span className="dim">engine</span> <span className="mono">{engine}</span>
          <span className="dim"> — started {fmtFull(build!.started_at)}</span>
        </div>}
        {!appVersion && !engine &&
          <div className="dim shell-about-row">version unknown</div>}
        <div className="shell-about-row">
          <a className="gh-link" href="https://github.com/Maurdekye/orgtree"
            target="_blank" rel="noreferrer">Orgtree on GitHub</a>
        </div>
      </div>
    </SetGroup>
  )
}
