import { useEffect, useState } from 'react'
import { req } from './api'
import './credential-warning.css'

/** Persistent across org/window navigation; a failed read never clears a warning.
 * The identity route is cheap and works even without an organization loaded. */
export function CredentialWarning() {
  const [warning, setWarning] = useState<string | null>(null)
  const [bridged, setBridged] = useState(false)
  useEffect(() => {
    let live = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const read = async () => {
      try {
        const value = await req<{credentialContext?: {warning?: string | null; bridge_ready?: boolean; general_vault_isolated?: boolean}}>('/api/desktop/identity',
          {signal: AbortSignal.timeout(4000)})
        const next = value.credentialContext?.warning
        if (live && (next === null || typeof next === 'string')) {
          setWarning(next || null)
          setBridged(value.credentialContext?.bridge_ready === true && value.credentialContext?.general_vault_isolated === true)
        }
      } catch { /* retain the last confirmed warning during an engine outage */ }
      finally { if (live) timer = setTimeout(read, 30000) }
    }
    void read()
    return () => { live = false; if (timer) clearTimeout(timer) }
  }, [])
  return warning || bridged ? <aside className="credential-context-warning" role={warning ? "alert" : "status"}>
    <strong>{warning ? "Git/GitHub access needs Windows sign-in" : "Git/GitHub access restored"}</strong>
    <span>{warning || "Git HTTPS and gh use the signed-in desktop. Other applications still cannot use this engine’s Windows credential vault directly."}</span>
  </aside> : null
}
