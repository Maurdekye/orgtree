import { useEffect, useRef, useState } from 'react'
import { desktop } from './desktop'
import { getProviders } from './api'
import { SetGroup, SetRow } from './canvas/settingskit'
import { ContrastSetting } from './contrast'
import { isVisualTheme, isCustomTheme, VISUAL_THEMES } from '../../../../packages/contracts/visual-theme'
import type { VisualTheme, PresetVisualTheme } from '../../../../packages/contracts/visual-theme'

type ProviderPayload = { providers?: Array<{ id?: unknown; status?: { installed?: unknown } }> }

export const THEMES = {
  // display names are the user's exact wording (2026-09-10 13:29) — labels
  // only; the ids these keys ARE stay the stored/wire vocabulary
  orgtree: { label: 'Orgtree Grey', accent: '#b6bdc8', hover: '#d0d5dd', soft: 'rgba(182,189,200,.16)' },
  claude: { label: 'Claude Terracotta', accent: '#d97757', hover: '#e99b81', soft: 'rgba(217,119,87,.16)' },
  codex: { label: 'Codex Teal', accent: '#22c4bd', hover: '#64ddd7', soft: 'rgba(34,196,189,.16)' },
  antigravity: { label: 'Antigravity Blue', accent: '#75a5ff', hover: '#a3c3ff', soft: 'rgba(117,165,255,.16)' },
  openrouter: { label: 'OpenRouter Lavender', accent: '#b69afa', hover: '#d0baff', soft: 'rgba(182,154,250,.16)' },
} satisfies Record<PresetVisualTheme, { label: string; accent: string; hover: string; soft: string }>

const STORAGE_KEY = 'orgtree-visual-theme'
const DEFAULT_THEME: VisualTheme = 'claude'

/** The first installed CLI provider supplies the initial appearance only.
 * Explicit choices never go through this mapping. Detection is deliberately
 * based on status.installed, not authentication or remote availability. */
export function defaultThemeForProviders(payload: ProviderPayload | null | undefined): VisualTheme {
  const installed = (id: string) => !!payload?.providers?.some(p => p.id === id && p.status?.installed === true)
  if (installed('claude')) return 'claude'
  if (installed('openai')) return 'codex'
  if (installed('google')) return 'antigravity'
  return DEFAULT_THEME
}

export function customTheme(color: string) {
  const rgb = [1,3,5].map(i => parseInt(color.slice(i,i+2),16))
  const hover = '#' + rgb.map(v => Math.round(v + (255-v)*0.25).toString(16).padStart(2,'0')).join('')
  const luminance = rgb.reduce((sum,v,i) => sum + v * [0.299,0.587,0.114][i]!,0)
  return {accent:color, hover, soft:`rgba(${rgb.join(',')},.16)`, ink:luminance > 140 ? '#17191d' : '#ffffff'}
}

export function applyTheme(value: unknown) {
  const selected = isVisualTheme(value) ? value : DEFAULT_THEME
  const theme = isCustomTheme(selected) ? customTheme(selected.slice(7)) : THEMES[selected]
  document.documentElement.dataset.visualTheme = selected
  window.dispatchEvent(new window.CustomEvent('orgtree:visual-theme-changed', { detail: selected }))
  // The existing native-popout observer copies this root style, including
  // subsequent updates. Semantic status and scoped provider colors stay intact.
  const style = document.documentElement.style
  style.setProperty('--accent', theme.accent)
  style.setProperty('--accent-hover', theme.hover)
  style.setProperty('--accent-soft', theme.soft)
  style.setProperty('--accent-ink', isCustomTheme(selected) ? customTheme(selected.slice(7)).ink : '#17191d')
}

function notifyNative(bridge: ReturnType<typeof desktop>, theme: VisualTheme): void {
  if (!bridge?.setEffectiveTheme) return
  try { void bridge.setEffectiveTheme(theme).catch(() => {}) } catch { /* old/unavailable bridge */ }
}

function explicitTheme(value: unknown): VisualTheme | null {
  if (!value || typeof value !== 'object') return null
  const p = value as { visualTheme?: unknown; visualThemeExplicit?: unknown }
  return p.visualThemeExplicit === true && isVisualTheme(p.visualTheme) ? p.visualTheme : null
}

function resolveDefault(apply: (theme: VisualTheme) => void, stillCurrent: () => boolean): void {
  void getProviders().then(payload => {
    if (stillCurrent()) apply(defaultThemeForProviders(payload))
  }).catch(() => {
    // Claude is the safe first-paint and no-provider fallback.
  })
}

/** Main process preferences persist independently of the engine's changing port. */
export function startThemeSync(): () => void {
  const bridge = desktop()
  if (!bridge) {
    let alive = true
    let stored: string | null = null
    try { stored = localStorage.getItem(STORAGE_KEY) } catch { /* private mode */ }
    if (isVisualTheme(stored)) applyTheme(stored)
    else {
      applyTheme(DEFAULT_THEME)
      resolveDefault(theme => {
        try { if (localStorage.getItem(STORAGE_KEY) === null) applyTheme(theme) } catch { applyTheme(theme) }
      }, () => alive)
    }
    const sync = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY) return
      if (isVisualTheme(e.newValue)) applyTheme(e.newValue)
      else {
        applyTheme(DEFAULT_THEME)
        resolveDefault(theme => {
          try { if (localStorage.getItem(STORAGE_KEY) === null) applyTheme(theme) } catch { applyTheme(theme) }
        }, () => alive)
      }
    }
    window.addEventListener('storage', sync)
    return () => { alive = false; window.removeEventListener('storage', sync) }
  }

  applyTheme(DEFAULT_THEME)
  notifyNative(bridge, DEFAULT_THEME)
  let alive = true, revision = 0, explicit: VisualTheme | null = null
  const detect = (generation: number) => resolveDefault(theme => {
    if (revision === generation && explicit === null) { applyTheme(theme); notifyNative(bridge, theme) }
  }, () => alive && revision === generation && explicit === null)
  const unsubscribe = bridge.onEvent(e => {
    if (alive && e.type === 'preferences') {
      revision++
      explicit = explicitTheme(e.data)
      if (explicit) { applyTheme(explicit); notifyNative(bridge, explicit) }
      else { applyTheme(DEFAULT_THEME); notifyNative(bridge, DEFAULT_THEME); detect(revision) }
    }
  })
  const initial = revision
  void bridge.getPreferences().then(p => {
    if (!alive || initial !== revision) return
    explicit = explicitTheme(p)
    if (explicit) { applyTheme(explicit); notifyNative(bridge, explicit) }
    else { applyTheme(DEFAULT_THEME); notifyNative(bridge, DEFAULT_THEME); detect(initial) }
  }).catch(() => {})
  return () => { alive = false; unsubscribe() }
}

export function ThemeSetting() {
  const [theme, setTheme] = useState<VisualTheme>(DEFAULT_THEME)
  const [customColor, setCustomColor] = useState('#b6bdc8')
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // Refs bridge the asynchronous provider probe and the event handlers. A
  // delayed probe must not be allowed to overwrite a choice made meanwhile.
  const revisionRef = useRef(0)
  const explicitRef = useRef<VisualTheme | null>(null)
  const currentRef = useRef<VisualTheme>(DEFAULT_THEME)
  useEffect(() => {
    let alive = true
    const bridge = desktop()
    const accept = (value: VisualTheme) => {
      if (alive) { currentRef.current = value; setTheme(value); applyTheme(value); notifyNative(bridge, value); setReady(true) }
    }
    const detect = (generation: number) => resolveDefault(value => {
      if (alive && revisionRef.current === generation && explicitRef.current === null) accept(value)
    }, () => alive && revisionRef.current === generation && explicitRef.current === null)
    if (!bridge) {
      let stored: string | null = null
      try { stored = localStorage.getItem(STORAGE_KEY) } catch { /* private mode */ }
      if (isVisualTheme(stored)) { explicitRef.current = stored; accept(stored) }
      else { accept(DEFAULT_THEME); detect(revisionRef.current) }
      return () => { alive = false }
    }
    const onPreferences = (value: unknown) => {
      revisionRef.current++
      explicitRef.current = explicitTheme(value)
      if (explicitRef.current) accept(explicitRef.current)
      else { accept(DEFAULT_THEME); detect(revisionRef.current) }
    }
    const unsubscribe = bridge.onEvent(e => { if (e.type === 'preferences') onPreferences(e.data) })
    const initial = revisionRef.current
    void bridge.getPreferences().then(p => {
      if (!alive || initial !== revisionRef.current) return
      explicitRef.current = explicitTheme(p)
      if (explicitRef.current) accept(explicitRef.current)
      else { accept(DEFAULT_THEME); detect(initial) }
    }).catch((e: Error) => { if (alive) setError(e.message) })
    return () => { alive = false; unsubscribe() }
  }, [])
  useEffect(() => { if (isCustomTheme(theme)) setCustomColor(theme.slice(7)) }, [theme])
  const change = async (value: string) => {
    if (!isVisualTheme(value)) return
    const previous = currentRef.current
    const previousExplicit = explicitRef.current
    const attempt = revisionRef.current + 1
    revisionRef.current = attempt
    explicitRef.current = value
    setBusy(true)
    try {
      const bridge = desktop()
      const saved = bridge
        ? (await bridge.setPreferences({ visualTheme: value, visualThemeExplicit: true })).visualTheme
        : value
      if (!bridge) localStorage.setItem(STORAGE_KEY, value)
      const next = isVisualTheme(saved) ? saved : value
      explicitRef.current = next
      currentRef.current = next
      setTheme(next); applyTheme(next); notifyNative(bridge, next); setError('')
    } catch (e) {
      if (revisionRef.current === attempt) {
        revisionRef.current++
        explicitRef.current = previousExplicit
        currentRef.current = previous
        setTheme(previous); applyTheme(previous); notifyNative(desktop(), previous)
      }
      setError(e instanceof Error ? e.message : String(e))
    } finally { setBusy(false) }
  }
  return <SetGroup title="Appearance" note="saved on this computer">
    <SetRow label="visual theme" hint="Choose an accent for the desk. Provider badges and work status keep their own colors.">
      <select aria-label="Visual theme" value={isCustomTheme(theme) ? 'custom' : theme} disabled={!ready || busy} onChange={e => void change(e.target.value === 'custom' ? `custom:${customColor}` : e.target.value)}>
        {VISUAL_THEMES.map(id => <option key={id} value={id}>{THEMES[id].label}</option>)}
        <option value="custom">Custom</option>
      </select>
    </SetRow>
    {isCustomTheme(theme) && <SetRow label="custom color">
      <input type="color" aria-label="Custom theme color" value={customColor}
        disabled={!ready || busy} onChange={e => {setCustomColor(e.target.value); void change(`custom:${e.target.value}`)}} />
      <span>{customColor}</span>
    </SetRow>}
    {error && <p role="alert">Could not save theme: {error}</p>}
    <ContrastSetting />
  </SetGroup>
}
