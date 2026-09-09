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
import { THEMES } from '../themes'
import { SetGroup } from './settingskit'
import type { ToastFn } from '../types'

type Standing = {
  auth: string; state: string
  marks: Record<string, { until: number; provenance: string; window?: string }>
}
type AccountRow = {
  id: string; provider: string; harness: string; label: string
  credential: { kind: string; path?: string }
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
  const [addProvider, setAddProvider] = useState('claude')
  const [importPath, setImportPath] = useState('')

  const reload = useCallback(() => {
    req<{ accounts: AccountRow[] }>('/api/accounts')
      // tolerate an absent/older backend (or an unmocked fixture): an empty
      // registry renders its explanatory line, never an unmount
      .then((r) => setRows(Array.isArray(r?.accounts) ? r.accounts : []))
      .catch(() => setRows([]))
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
    {rows.length === 0 && <p className="dim">
      No accounts registered. The account system activates at cutover;
      until then every agent runs on the machine login.</p>}
    {rows.map((r) => {
      const marks = Object.entries(r.standing.marks)
      return <div key={r.id} className="account-row"
        style={{ display: 'flex', gap: 8, alignItems: 'baseline',
                 flexWrap: 'wrap', padding: '4px 0' }}>
        <span title={`tint ${r.tint_ordinal} — same provider, own shade`}
          style={{ width: 12, height: 12, borderRadius: 3,
                   display: 'inline-block', alignSelf: 'center',
                   background: accountTint(
                     PROVIDER_BASE[r.provider] ?? '#b6bdc8',
                     r.tint_ordinal) }} />
        <strong>{r.id}</strong>
        <span>{r.label}</span>
        <span className="dim">{r.credential.kind}
          {r.origin_org ? ` · restricted to ${r.origin_org}` : ''}</span>
        <span className="dim">
          {r.identity.email || r.identity.account_digest || 'no identity'}
          {' · '}{r.standing.auth}</span>
        {marks.length === 0
          ? <span className="dim">ready</span>
          : marks.map(([pool, m]) =>
            <span key={pool} className="badge frozen"
              title={m.provenance === 'inferred'
                ? 'inferred from the pooled limit, not measured for this tier'
                : 'measured limit'}>
              {markLine(pool, m)}</span>)}
        {r.bound.length > 0 &&
          <span className="dim"
            title={r.bound.map((b) => `${b.org}/${b.node}`).join(', ')}>
            {r.bound.length} agent(s)</span>}
        <button onClick={() => refreshIdentity(r.id)}>refresh</button>
        <button disabled={r.bound.length > 0}
          title={r.bound.length > 0
            ? 'reassign its agents explicitly first'
            : 'remove this account'}
          onClick={() => remove(r.id)}>remove</button>
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
