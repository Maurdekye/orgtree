/** Account management belongs to each provider; usage belongs to Usage. */
import { useCallback, useEffect, useRef, useState } from 'react'
import { req } from '../api'
import { accountTint } from '../accounttint'
import { accountDisplayId, accountIdentity } from '../accountidentity'
import { THEMES } from '../themes'
import { pickFolder } from '../picker'
import { ProviderSignIn } from './accounts'
import { PinFrame } from './modalpin'
import type { LoginProvider } from '../../../../../packages/contracts'
import type { ToastFn } from '../types'

export type AccountProvider = 'claude' | 'openai' | 'google'
type AccountRow = {
  id: string; provider: string; label: string; name?: string; ambient?: boolean
  credential: { kind: string; path?: string; default_config?: boolean }
  /** 'apikey' = a metered API-key account (absent = subscription) */
  mode?: string; enabled?: boolean
  identity: Record<string, string>; tint_ordinal: number; origin_org?: string
  standing: { auth: string }
  bound: { org: string; node: string; state: string }[]
}
const LABELS: Record<AccountProvider, string> = { claude: 'Claude', openai: 'Codex', google: 'Antigravity' }
const COLORS: Record<AccountProvider, string> = {
  claude: THEMES.claude.accent, openai: THEMES.codex.accent, google: THEMES.antigravity.accent,
}

export function useAccountRegistry() {
  const [rows, setRows] = useState<AccountRow[]>([])
  const [error, setError] = useState<string | null>(null)
  const serial = useRef(0)
  const reload = useCallback(async () => {
    const request = ++serial.current
    try {
      const data = await req<{ accounts: AccountRow[] }>('/api/accounts')
      if (!Array.isArray(data?.accounts)) throw new Error('the backend answered without an account list')
      if (request === serial.current) { setRows(data.accounts); setError(null) }
    } catch (e) {
      if (request === serial.current) setError(e instanceof Error ? e.message : 'request failed')
    }
  }, [])
  useEffect(() => { void reload(); return () => { serial.current++ } }, [reload])
  return { rows, error, reload }
}
export type AccountRegistry = ReturnType<typeof useAccountRegistry>

export function AccountRegistrySection({ provider, registry, toast }: {
  provider: AccountProvider; registry: AccountRegistry; toast: ToastFn
}) {
  const [busy, setBusy] = useState<string | null>(null)
  const refresh = async (row: AccountRow) => {
    setBusy(row.id)
    try {
      const result = await req<{ auth: string }>(`/api/accounts/${row.id}/identity`)
      toast([`${accountIdentity(accountDisplayId(row), row.identity?.email)}: ${result.auth}`])
      await registry.reload()
    } catch (e) { toast([e instanceof Error ? e.message : 'Could not refresh account']) }
    finally { setBusy(null) }
  }
  const remove = async (row: AccountRow) => {
    setBusy(row.id)
    try { await req(`/api/accounts/${row.id}`, { method: 'DELETE' }); await registry.reload() }
    catch (e) { toast([e instanceof Error ? e.message : 'Could not remove account']) }
    finally { setBusy(null) }
  }
  return <div className="provider-accounts" aria-label={`${LABELS[provider]} accounts`}>
    {registry.rows.filter(row => row.provider === provider).map(row => {
      const login: LoginProvider | null = row.credential.kind === 'token' ? null
        : provider === 'claude' ? 'claude' : provider === 'openai' ? 'codex' : null
      return <div key={row.id} className="account-row">
        <div className="account-identity">
          <span className="account-swatch" aria-hidden="true" style={{ background: accountTint(COLORS[provider], row.tint_ordinal) }} />
          <strong>{accountIdentity(accountDisplayId(row), row.identity?.email)}</strong>
          <span className="dim">{row.standing.auth === 'authenticated' ? 'Signed in' : row.standing.auth === 'unauthenticated' ? 'Sign-in required' : 'Sign-in not verified'}</span>
        </div>
        <div className="account-management">
          {row.bound.length > 0 && <span className="dim" title={row.bound.map(b => `${b.org}/${b.node}`).join(', ')}>{row.bound.length} agent(s)</span>}
          {login && <ProviderSignIn provider={login} connected={row.standing.auth === 'authenticated'} toast={toast}
            profileDir={row.credential.default_config ? undefined : row.credential.path} accountId={row.id}
            onRefresh={() => { void refresh(row) }} />}
          <button disabled={busy !== null} onClick={() => { void refresh(row) }}>refresh</button>
          <button disabled={busy !== null || row.bound.length > 0}
            title={row.bound.length > 0 ? 'Reassign its agents before removing this account' : 'Remove this account'}
            onClick={() => { void remove(row) }}>remove</button>
        </div>
        {row.origin_org && <div className="dim">Available only to {row.origin_org}</div>}
        {provider === 'google' && <div className="dim account-note">Secondary Antigravity sign-in is not supported yet.</div>}
      </div>
    })}
  </div>
}

export function AddAccountDialog({ provider, onAdded, close }: {
  provider: AccountProvider; onAdded: () => Promise<void>; close: () => void
}) {
  const [path, setPath] = useState('')
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const lock = useRef(false)
  const dismiss = () => { if (!lock.current) close() }
  const create = async (kind: 'managed' | 'imported' | 'apikey') => {
    if (lock.current || (kind === 'imported' && !path.trim())
      || (kind === 'apikey' && !key.trim())) return
    lock.current = true; setBusy(true); setError('')
    try {
      await req('/api/accounts', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, kind,
          ...(kind === 'imported' ? { path: path.trim() } : {}),
          ...(kind === 'apikey' ? { key: key.trim() } : {}) }) })
      // ⚠ THE KEY LEAVES THE RENDERER'S HANDS HERE and is never read back:
      // the server stores it and echoes only a reference. Clearing the field
      // keeps the one copy we held from sitting in component state after the
      // dialog has done its job.
      setKey('')
      await onAdded()
      close()
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not add account') }
    finally { lock.current = false; setBusy(false) }
  }
  const browse = async () => {
    if (lock.current) return
    lock.current = true; setBusy(true)
    try { const folder = await pickFolder(); if (folder.path) setPath(folder.path) }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not open folder picker') }
    finally { lock.current = false; setBusy(false) }
  }
  return <PinFrame kind="add-secondary-account" title={`Add ${LABELS[provider]} account`} panel="settings add-account-dialog"
    close={dismiss} onEsc={dismiss} pinnable={false} dialogLabel={`Add secondary ${LABELS[provider]} account`}>
    <h3>Add secondary {LABELS[provider]} account</h3>
    <section className="account-add-option">
      <h4>Create a managed account</h4>
      <p className="dim">Create a separate profile for this account, then sign in.</p>
      <button disabled={busy} onClick={() => { void create('managed') }}>Create managed account</button>
    </section>
    <section className="account-add-option">
      <h4>Import a folder</h4>
      <p className="dim">Use an existing {LABELS[provider]} profile folder.</p>
      <label>Profile folder<input aria-label="Profile folder" value={path} disabled={busy} onChange={e => setPath(e.target.value)} /></label>
      <div className="account-management">
        <button disabled={busy} onClick={() => { void browse() }}>Browse...</button>
        <button disabled={busy || !path.trim()} onClick={() => { void create('imported') }}>Import folder</button>
      </div>
    </section>
    {/* ⚠ OFFERED WHETHER OR NOT THE PROVIDER'S SUBSCRIPTION IS SIGNED IN
        (ticket requirement): an API-key account is an ordinary account, not a
        spare bolted onto a subscription, and Orgtree can run on keys alone.
        Google is excluded because it has no API-key login at all (measured
        1.1.24) — the note below already says so. */}
    {provider !== 'google' && <section className="account-add-option">
      <h4>Use an API key</h4>
      <p className="dim">Bill this account directly to {LABELS[provider]} API
        credit. It shows total spend instead of subscription limits, and is
        never used for fallback unless you turn that on.</p>
      <label>API key<input aria-label="API key" type="password" value={key}
        disabled={busy} placeholder={provider === 'claude' ? 'sk-ant-…' : 'sk-…'}
        onChange={e => setKey(e.target.value)} /></label>
      <p className="dim">Stored on this machine and never shown again.</p>
      <button disabled={busy || !key.trim()}
        onClick={() => { void create('apikey') }}>Add API-key account</button>
    </section>}
    {provider === 'google' && <p className="dim">Secondary Antigravity sign-in is not supported yet. Importing a folder does not verify its sign-in.</p>}
    {error && <p className="ask-warn" role="alert">{error}</p>}
    <button disabled={busy} onClick={dismiss}>Cancel</button>
  </PinFrame>
}
