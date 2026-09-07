import { useEffect, useState } from 'react'
import { desktop } from './desktop'
import { SetGroup, SetRow } from './canvas/settingskit'
import { isVisualTheme, VISUAL_THEMES } from '../../../../packages/contracts/visual-theme'
import type { VisualTheme } from '../../../../packages/contracts/visual-theme'

export const THEMES = {
  orgtree: { label: 'Orgtree (neutral)', accent: '#b6bdc8', hover: '#d0d5dd', soft: 'rgba(182,189,200,.16)' },
  claude: { label: 'Claude', accent: '#d97757', hover: '#e99b81', soft: 'rgba(217,119,87,.16)' },
  codex: { label: 'Codex', accent: '#22c4bd', hover: '#64ddd7', soft: 'rgba(34,196,189,.16)' },
  antigravity: { label: 'Antigravity', accent: '#75a5ff', hover: '#a3c3ff', soft: 'rgba(117,165,255,.16)' },
  openrouter: { label: 'OpenRouter', accent: '#b69afa', hover: '#d0baff', soft: 'rgba(182,154,250,.16)' },
} satisfies Record<VisualTheme, { label: string; accent: string; hover: string; soft: string }>

const STORAGE_KEY = 'orgtree-visual-theme'
export function applyTheme(value: unknown) {
  const theme = THEMES[isVisualTheme(value) ? value : 'orgtree']
  // The existing native-popout observer copies this root style, including
  // subsequent updates. Semantic status and scoped provider colors stay intact.
  const style = document.documentElement.style
  style.setProperty('--accent', theme.accent)
  style.setProperty('--accent-hover', theme.hover)
  style.setProperty('--accent-soft', theme.soft)
  style.setProperty('--accent-ink', '#17191d')
}

/** Main process preferences persist independently of the engine's changing port. */
export function startThemeSync(): () => void {
  const bridge = desktop()
  if (!bridge) {
    try { applyTheme(localStorage.getItem(STORAGE_KEY)) } catch { applyTheme('orgtree') }
    const sync = (e: StorageEvent) => { if (e.key === STORAGE_KEY) applyTheme(e.newValue) }
    window.addEventListener('storage', sync)
    return () => window.removeEventListener('storage', sync)
  }
  applyTheme('orgtree')
  let alive = true, revision = 0
  const unsubscribe = bridge.onEvent(e => {
    if (alive && e.type === 'preferences') {
      revision++
      applyTheme((e.data as { visualTheme?: unknown }).visualTheme)
    }
  })
  const initial = revision
  void bridge.getPreferences().then(p => { if (alive && initial === revision) applyTheme(p.visualTheme) }).catch(() => {})
  return () => { alive = false; unsubscribe() }
}

export function ThemeSetting() {
  const [theme, setTheme] = useState<VisualTheme>('orgtree')
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let alive = true, revision = 0
    const accept = (value: unknown) => { if (alive) { setTheme(isVisualTheme(value) ? value : 'orgtree'); setReady(true) } }
    const bridge = desktop()
    if (!bridge) {
      try { accept(localStorage.getItem(STORAGE_KEY)) } catch { accept('orgtree') }
      return () => { alive = false }
    }
    const unsubscribe = bridge.onEvent(e => { if (e.type === 'preferences') { revision++; accept((e.data as { visualTheme?: unknown }).visualTheme) } })
    const initial = revision
    void bridge.getPreferences().then(p => { if (initial === revision) accept(p.visualTheme) })
      .catch((e: Error) => { if (alive) setError(e.message) })
    return () => { alive = false; unsubscribe() }
  }, [])
  const change = async (value: string) => {
    if (!isVisualTheme(value)) return
    setBusy(true)
    try {
      const bridge = desktop()
      const saved = bridge ? (await bridge.setPreferences({ visualTheme: value })).visualTheme : value
      if (!bridge) localStorage.setItem(STORAGE_KEY, value)
      const next = isVisualTheme(saved) ? saved : 'orgtree'
      setTheme(next); applyTheme(next); setError('')
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }
  return <SetGroup title="Appearance" note="saved on this computer">
    <SetRow label="visual theme" hint="Choose an accent for the desk. Provider badges and work status keep their own colors.">
      <select aria-label="Visual theme" value={theme} disabled={!ready || busy} onChange={e => void change(e.target.value)}>
        {VISUAL_THEMES.map(id => <option key={id} value={id}>{THEMES[id].label}</option>)}
      </select>
    </SetRow>
    {error && <p role="alert">Could not save theme: {error}</p>}
  </SetGroup>
}
