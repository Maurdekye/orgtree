import { useEffect, useRef, useState } from 'react'
import { desktop } from './desktop'
import { SetRow } from './canvas/settingskit'
import { CONTRAST_THEMES, DEFAULT_CONTRAST, isContrastTheme } from '../../../../packages/contracts/contrast-theme'
import type { ContrastTheme } from '../../../../packages/contracts/contrast-theme'

export const CONTRAST_LABELS: Record<ContrastTheme, string> = {
  charcoal: 'Charcoal', light: 'Light', 'solarized-light': 'Solarized Light', 'obsidian-black': 'Obsidian Black',
}
const STORAGE_KEY = 'orgtree-contrast-theme'
const STORED_EVENT = 'orgtree:contrast-stored'

export function applyContrast(value: unknown): void {
  const theme = isContrastTheme(value) ? value : DEFAULT_CONTRAST
  // Popouts already mirror root classes and CSS. Preserve mobile and any
  // other unrelated classes, as well as the separately managed accent tokens.
  for (const id of CONTRAST_THEMES) document.documentElement.classList.toggle(`contrast-${id}`, id === theme)
}

function preference(value: unknown): ContrastTheme {
  const theme = value && typeof value === 'object' ? (value as { contrastTheme?: unknown }).contrastTheme : null
  return isContrastTheme(theme) ? theme : DEFAULT_CONTRAST
}

/** Both startup and the setting subscribe to the same authoritative source.
 * A late initial read must never overwrite a newer preference broadcast. */
function watchContrast(accept: (theme: ContrastTheme) => void, failed: (error: unknown) => void = () => {}): () => void {
  const bridge = desktop()
  if (!bridge) {
    const read = () => {
      let value: unknown
      try { value = localStorage.getItem(STORAGE_KEY) } catch { /* private mode uses Charcoal */ }
      accept(isContrastTheme(value) ? value : DEFAULT_CONTRAST)
    }
    read()
    const onStorage = (e: StorageEvent) => { if (e.key === STORAGE_KEY || e.key === null) read() }
    window.addEventListener('storage', onStorage)
    window.addEventListener(STORED_EVENT, read)
    return () => { window.removeEventListener('storage', onStorage); window.removeEventListener(STORED_EVENT, read) }
  }
  let alive = true, revision = 0
  const stop = bridge.onEvent(e => {
    if (alive && e.type === 'preferences') { revision++; accept(preference(e.data)) }
  })
  const initial = revision
  void bridge.getPreferences().then(value => {
    if (alive && revision === initial) accept(preference(value))
  }).catch(error => { if (alive && revision === initial) failed(error) })
  return () => { alive = false; stop() }
}

export function startContrastSync(): () => void {
  applyContrast(DEFAULT_CONTRAST)
  return watchContrast(applyContrast)
}

export function ContrastSetting() {
  const [theme, setTheme] = useState<ContrastTheme>(DEFAULT_CONTRAST)
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const alive = useRef(false), revision = useRef(0)
  const accept = (value: ContrastTheme) => {
    revision.current++
    setTheme(value); applyContrast(value); setReady(true); setError('')
  }
  useEffect(() => {
    alive.current = true
    const stop = watchContrast(accept, e => setError(`Could not load contrast color: ${String(e instanceof Error ? e.message : e)}`))
    return () => { alive.current = false; stop() }
  }, [])
  const change = async (value: string) => {
    if (!isContrastTheme(value)) return
    const attempt = ++revision.current
    setBusy(true); setError('')
    try {
      const bridge = desktop()
      if (bridge) {
        const saved = await bridge.setPreferences({ contrastTheme: value })
        // The native broadcast normally arrives first. In particular, never
        // replace a later choice with an older IPC response or failed write.
        if (alive.current && attempt === revision.current) accept(preference(saved))
      } else {
        localStorage.setItem(STORAGE_KEY, value)
        window.dispatchEvent(new window.Event(STORED_EVENT))
      }
    } catch (e) {
      if (alive.current && attempt === revision.current) setError(`Could not save contrast color: ${String(e instanceof Error ? e.message : e)}`)
    } finally { if (alive.current) setBusy(false) }
  }
  return <>
    <SetRow label="contrast color" hint="Choose the brightness of backgrounds and text independently of the visual theme.">
      <select aria-label="Contrast color" value={theme} disabled={!ready || busy} onChange={e => void change(e.target.value)}>
        {CONTRAST_THEMES.map(id => <option key={id} value={id}>{CONTRAST_LABELS[id]}</option>)}
      </select>
    </SetRow>
    {error && <p role="alert">{error}</p>}
  </>
}
