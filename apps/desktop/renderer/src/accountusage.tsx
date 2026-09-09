/** Reusable per-account usage reader (multi-account D3) — fetches
 * GET /api/accounts/{id}/usage and renders the provider-native windows for
 * that account's OWN lane, the standing (provenance shown), and honest
 * unavailability text. Mountable anywhere (registry rows, selected-agent
 * panels); no coupling to the registry section.
 *
 * API shape consumed: { account, provider, standing: {auth, state, marks},
 *   available: boolean, limits?: [{name, percent, severity, resets_at,
 *   is_active, model}], error?, unsupported? } — the `limits[]` half is the
 * exact shape UsageBars already renders. */
import { useCallback, useEffect, useState } from 'react'
import { req } from './api'
import { UsageBars } from './canvas/accounts'
import type { AccountUsage } from './types'

type PerAccountUsage = AccountUsage & {
  standing?: { auth: string; state: string
               marks: Record<string, { until: number; provenance: string }> }
  unsupported?: boolean
  error?: string
}

export function AccountUsagePanel({ accountId }: { accountId: string }) {
  const [u, setU] = useState<PerAccountUsage | null>(null)
  const [error, setError] = useState('')
  const reload = useCallback(() => {
    req<PerAccountUsage>(`/api/accounts/${accountId}/usage`)
      .then((r) => { setU(r); setError('') })
      .catch((e: Error) => setError(e.message))
  }, [accountId])
  useEffect(() => { reload() }, [reload])
  if (error) return <p className="dim">usage: {error}</p>
  if (!u) return <p className="dim">reading usage…</p>
  return <div className="account-usage">
    {u.available
      ? <UsageBars u={u} />
      : <p className="dim">{u.unsupported
          ? `${u.provider}: no usage surface`
          : (u.error ?? 'usage unavailable')}</p>}
    {u.standing && Object.entries(u.standing.marks).map(([pool, m]) =>
      <p key={pool} className="dim">
        {pool} limited until {new Date(m.until * 1000).toLocaleString()}
        {m.provenance === 'inferred' ? ' (inferred)' : ''}
      </p>)}
    <button onClick={reload}>refresh usage</button>
  </div>
}
