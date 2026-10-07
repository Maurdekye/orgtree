import { useEffect, useState } from 'react'
import { req } from './api'
import './credential-warning.css'

/** Persistent across org/window navigation; a failed read never clears a warning.
 * The identity route is cheap and works even without an organization loaded. */
export function CredentialWarning() {
  const [warning, setWarning] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const read = async () => {
      try {
        const value = await req<{credentialContext?: {warning?: string | null}}>('/api/desktop/identity',
          {signal: AbortSignal.timeout(4000)})
        const next = value.credentialContext?.warning
        if (live && (next === null || typeof next === 'string')) setWarning(next || null)
      } catch { /* retain the last confirmed warning during an engine outage */ }
      finally { if (live) timer = setTimeout(read, 30000) }
    }
    void read()
    return () => { live = false; if (timer) clearTimeout(timer) }
  }, [])
  return warning ? <aside className="credential-context-warning" role="alert">
    <strong>Windows credentials unavailable</strong>
    <span>{warning}</span>
  </aside> : null
}
