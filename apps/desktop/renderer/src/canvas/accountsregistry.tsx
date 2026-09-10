/** The symmetric account registry section (multi-account D5): every
 * registered account across all providers together — no main/secondary —
 * with identity, auth, marks-derived standing (provenance shown, an
 * inferred park never reads as a measured one), placements, tint swatch,
 * add imported/managed, guarded removal, and per-account identity refresh
 * through the harness-side read. Sign-in itself stays the provider login
 * flow (providerlogin, per-profile) — no credential ever passes here. */
import { useCallback, useEffect, useState } from 'react'
import { req } from '../api'
import { accountTint } from '../accounttint'
import { AccountUsagePanel } from '../accountusage'
import { THEMES } from '../themes'
import { ProviderSignIn } from './accounts'
import { SetGroup } from './settingskit'
import type { LoginProvider } from '../../../../../packages/contracts'
import type { ToastFn } from '../types'

type Standing = {
  auth: string; state: string
  marks: Record<string, { until: number; provenance: string; window?: string }>
}
type AccountRow = {
  id: string; provider: string; harness: string; label: string
  credential: { kind: string; path?: string; default_config?: boolean }
  identity: Record<string, string>
  auth: string; tint_ordinal: number; origin_org?: string
  standing: Standing
  bound: { org: string; node: string; state: string }[]
}

const PROVIDER_BASE: Record<string, string> = {
  claude: THEMES.claude.accent, openai: THEMES.codex.accent,
  google: THEMES.antigravity.accent,
}

function markLine(pool: string,
                  m: { until: number; provenance: string }): string {
  const until = new Date(m.until * 1000).toLocaleString()
  return `${pool}: limited until ${until}`
    + (m.provenance === 'inferred' ? ' (inferred)' : '')
}

export function AccountRegistrySection({ toast }: { toast: ToastFn }) {
  const [rows, setRows] = useState<AccountRow[]>([])
  const [busy, setBusy] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [usageOpen, setUsageOpen] = useState<Record<string, boolean>>({})
  const [addProvider, setAddProvider] = useState('claude')
  const [importPath, setImportPath] = useState('')

  const reload = useCallback(() => {
    req<{ accounts: AccountRow[] }>('/api/accounts')
      // a failed or alien-shaped list must SAY so, never masquerade as an
      // empty registry — the silent setRows([]) here is what turned the
      // route-shadowing defect into "Create managed does nothing" (user
      // report 2026-09-10). The section stays mounted either way.
      .then((r) => {
        if (Array.isArray(r?.accounts)) { setRows(r.accounts); setLoadError(null) }
        else { setRows([]); setLoadError('the backend answered without an account list (older backend?)') }
      })
      .catch((e: Error) => { setRows([]); setLoadError(e.message || 'request failed') })
  }, [])
  useEffect(() => { reload() }, [reload])

  const create = (kind: 'imported' | 'managed') => {
    setBusy(true)
    req('/api/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: addProvider, kind,
        path: kind === 'imported' ? importPath : undefined,
      }),
    }).then(() => { setImportPath(''); reload() })
      .catch((e: Error) => toast([`add account: ${e.message}`]))
      .finally(() => setBusy(false))
  }
  const remove = (id: string) => {
    req(`/api/accounts/${id}`, { method: 'DELETE' })
      .then(() => reload())
      .catch((e: Error) => toast([`remove: ${e.message}`]))
  }
  const refreshIdentity = (id: string) => {
    req<{ auth: string }>(`/api/accounts/${id}/identity`)
      .then((r) => { toast([`${id}: ${r.auth}`]); reload() })
      .catch((e: Error) => toast([`identity: ${e.message}`]))
  }

  return <SetGroup title="Accounts"
    note="symmetric across providers — every registered account is available to every organization (org-restricted legacy keys excepted)">
    {loadError && <p className="ask-warn">
      Could not load the account list: {loadError}{' '}
      <button onClick={reload}>retry</button></p>}
    {rows.length === 0 && !loadError && <p className="dim">
      No accounts yet. Import an existing profile directory or create a
      managed one below, sign in through the provider's own flow, then
      assign agents to it from their settings.</p>}
    {rows.map((r) => {
      const marks = Object.entries(r.standing.marks)
      // readiness comes from standing.state AND auth together: empty marks
      // on an unauthenticated/unobserved account must not read as ready
      const ready = r.standing.state === 'ready'
        && r.standing.auth === 'authenticated'
      const loginProvider: LoginProvider | null =
        r.credential.kind !== 'token'
          ? (r.provider === 'claude' ? 'claude'
            : r.provider === 'openai' ? 'codex' : null)
          : null
      return <div key={r.id} className="account-row"
        style={{ display: 'flex', gap: 8, alignItems: 'baseline',
                 flexWrap: 'wrap', padding: '4px 0' }}>
        <span title={`tint ${r.tint_ordinal} — same provider, own shade`}
          style={{ width: 12, height: 12, borderRadius: 3,
                   display: 'inline-block', alignSelf: 'center',
                   background: accountTint(
                     PROVIDER_BASE[r.provider] ?? '#b6bdc8',
                     r.tint_ordinal) }} />
        <strong title={`Account ID: ${r.id}`}>{r.label || r.id}</strong>
        <span className="dim">{r.credential.kind}
          {r.origin_org ? ` · restricted to ${r.origin_org}` : ''}</span>
        <span className="dim">
          {r.identity.email || r.identity.account_digest || 'no identity'}
          {' · '}{r.standing.auth}</span>
        {ready
          ? <span className="dim">ready</span>
          : marks.length > 0
            ? marks.map(([pool, m]) =>
              <span key={pool} className="badge frozen"
                title={m.provenance === 'inferred'
                  ? 'inferred from the pooled limit, not measured for this tier'
                  : 'measured limit'}>
                {markLine(pool, m)}</span>)
            : <span className="badge dim"
                title="the account has no sign-in yet (or it was not observed) — agents bound to it wait until it authenticates">
                {r.standing.auth}</span>}
        {r.bound.length > 0 &&
          <span className="dim"
            title={r.bound.map((b) => `${b.org}/${b.node}`).join(', ')}>
            {r.bound.length} agent(s)</span>}
        {loginProvider &&
          <ProviderSignIn provider={loginProvider}
            connected={r.standing.auth === 'authenticated'}
            toast={toast} profileDir={r.credential.default_config ? undefined : r.credential.path}
            accountId={r.id}
            onRefresh={() => refreshIdentity(r.id)} />}
        <button onClick={() => refreshIdentity(r.id)}>refresh</button>
        <button disabled={r.bound.length > 0}
          title={r.bound.length > 0
            ? 'reassign its agents explicitly first'
            : 'remove this account'}
          onClick={() => remove(r.id)}>remove</button>
        <details style={{ flexBasis: '100%' }}
          onToggle={(e) => { const open = e.currentTarget.open; setUsageOpen(old => ({ ...old, [r.id]: open })) }}>
          <summary>Usage</summary>
          {usageOpen[r.id] && <AccountUsagePanel accountId={r.id} />}
        </details>
      </div>
    })}
    <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
      <select aria-label="Provider" value={addProvider}
        onChange={(e) => setAddProvider(e.target.value)}>
        <option value="claude">Claude</option>
        <option value="openai">Codex</option>
        <option value="google">Antigravity</option>
      </select>
      <input placeholder="existing profile directory (import)"
        value={importPath} style={{ minWidth: 240 }}
        onChange={(e) => setImportPath(e.target.value)} />
      <button disabled={busy || !importPath}
        onClick={() => create('imported')}>import directory</button>
      <button disabled={busy} title="mint a fresh managed profile directory; sign in through the provider's own flow afterwards"
        onClick={() => create('managed')}>create managed</button>
    </div>
  </SetGroup>
}
