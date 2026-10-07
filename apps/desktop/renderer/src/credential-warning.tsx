import { useEffect, useRef, useState } from 'react'
import { req } from './api'
import './credential-warning.css'

const STORAGE_KEY = 'orgtree.credential-warning.v1'
type Dismissal = { state: string; dismissed: boolean }
const readDismissal = (): Dismissal | null => {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null') }
  catch { return null }
}
const saveDismissal = (value: Dismissal) => {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(value)) } catch { /* memory-only if storage is unavailable */ }
}

/** In shell layout flow, never over controls. Only a real warning renders;
 * a registered bridge alone is not proof that credentials work. */
export function CredentialWarning() {
  const [warning, setWarning] = useState<string | null>(null)
  const [dismissed, setDismissed] = useState(false)
  const current = useRef<Dismissal | null>(null)
  useEffect(() => {
    let live = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const read = async () => {
      try {
        const value = await req<{credentialContext?: {warning?: string | null; bridge_ready?: boolean}}>('/api/desktop/identity',
          {signal: AbortSignal.timeout(4000)})
        const next = value.credentialContext?.warning
        if (live && (next === null || typeof next === 'string')) {
          const state = JSON.stringify([next || null, value.credentialContext?.bridge_ready === true])
          if (current.current?.state !== state) {
            const saved = readDismissal()
            const record = { state, dismissed: saved?.state === state && saved.dismissed === true }
            current.current = record
            saveDismissal(record)
            setDismissed(record.dismissed)
          }
          setWarning(next || null)
        }
      } catch { /* retain the last confirmed warning during an engine outage */ }
      finally { if (live) timer = setTimeout(read, 30000) }
    }
    const sync = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEY) return
      const saved = readDismissal()
      if (saved && saved.state === current.current?.state) {
        current.current = saved
        setDismissed(saved.dismissed === true)
      }
    }
    window.addEventListener('storage', sync)
    void read()
    return () => { live = false; if (timer) clearTimeout(timer); window.removeEventListener('storage', sync) }
  }, [])
  const dismiss = () => {
    if (current.current) {
      current.current = { ...current.current, dismissed: true }
      saveDismissal(current.current)
    }
    setDismissed(true)
  }
  return warning && !dismissed ? <aside className="credential-context-warning" role="alert">
    <span><strong>Git/GitHub sign-in warning. </strong>{warning}</span>
    <button type="button" className="iconbtn" aria-label="Dismiss Git/GitHub sign-in warning"
      title="Dismiss until this warning changes" onClick={dismiss}>×</button>
  </aside> : null
}
