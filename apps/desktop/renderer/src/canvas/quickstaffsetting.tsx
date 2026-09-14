import { useEffect, useState } from 'react'
import { getRuntimeSettings, req } from '../api'
import type { RuntimeSettingsPayload } from '../types'
import { SetGroup, SetRow } from './settingskit'

export function QuickStaffSetting() {
  const [mode, setMode] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => { let live = true
    getRuntimeSettings().then(p => { if (live) setMode(p.quick_staff_behavior ?? 'request') })
      .catch((e: Error) => { if (live) setError(e.message) })
    return () => { live = false }
  }, [])
  return <SetGroup title="Docket">
    <SetRow label="Quick staff behavior" hint="Choose what Staff… does on a backlogged ticket.">
      <select aria-label="Quick staff behavior" value={mode ?? 'request'} disabled={mode === null || busy}
        onChange={e => { const value = e.target.value; setBusy(true)
          req<RuntimeSettingsPayload>('/api/app-settings/runtime', {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ quick_staff_behavior: value }),
          }).then(p => { setMode(p.quick_staff_behavior ?? 'request'); setError('') })
            .catch((err: Error) => setError(err.message)).finally(() => setBusy(false))
        }}>
        <option value="request">Request staffing</option>
        <option value="under_assignee">Staff immediately (under assignee)</option>
        <option value="top_level">Staff immediately (top level)</option>
      </select>
    </SetRow>
    {error && <p role="alert">{error}</p>}
  </SetGroup>
}
