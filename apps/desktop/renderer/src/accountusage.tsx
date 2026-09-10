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
import type { AccountStanding, RegisteredAccountUsage } from './types'

type PerAccountUsage = RegisteredAccountUsage

/** an account's per-pool "limited until" lines — shared by this panel and
 *  the header usage modal's registered-account sections, so the two render
 *  a mark (and its observed/inferred provenance) identically */
export function StandingMarks({ standing }: { standing?: AccountStanding }) {
  if (!standing) return null
  return <>
    {Object.entries(standing.marks).map(([pool, m]) =>
      <p key={pool} className="dim">
        {pool} limited until {new Date(m.until * 1000).toLocaleString()}
        {m.provenance === 'inferred' ? ' (inferred)' : ''}
      </p>)}
  </>
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
  if (error) return <div className="dim">usage: {error} <button onClick={reload}>retry</button></div>
  if (!u) return <p className="dim">reading usage…</p>
  // Accounts omits Codex reserve usage; other usage surfaces retain it.
  const codex = ['openai', 'codex'].includes((u.provider ?? '').toLowerCase())
  const displayed = codex
    ? { ...u, limits: u.limits?.filter(l => l.model !== 'gpt-reserve') }
    : u
  return <div className="account-usage">
    {u.available
      ? <UsageBars u={displayed} />
      : <p className="dim">{u.unsupported
          ? `${u.provider}: no usage surface`
          : (u.error ?? 'usage unavailable')}</p>}
    <StandingMarks standing={u.standing} />
    <button onClick={reload}>refresh usage</button>
  </div>
}
