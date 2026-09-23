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
  standing: { auth: string; state?: string }
  bound: { org: string; node: string; state: string }[]
}

/** One stored capacity mark, as GET /api/accounts/{id}/marks reports it.
 *  `account` and `source` are what a clear must name; `expected` is the
 *  exact mark the dialog showed, so a mark rewritten since is refused. */
export type MarkEntry = {
  account: string; source: 'registry' | 'legacy-roster'; pool: string
  state: 'active' | 'expired'; until: number; remaining_s: number
  observed_at: number | null; age_s: number | null
  provenance: string; window: string; expected: Record<string, unknown>
  companion?: { pool: string; cleared_with_this: boolean; expected: Record<string, unknown> }
}
type MarkClearResult = {
  result: 'cleared' | 'changed' | 'missing' | 'expired'
  kept?: Record<string, unknown>
}

const POOL_LABELS: Record<string, string> = {
  pooled: 'Haiku/Sonnet/Opus', fable: 'Fable',
  'openai:plan': 'Codex plan', 'openai:reserve': 'Codex reserve',
}
const poolLabel = (pool: string) => POOL_LABELS[pool] ?? pool

/** "2h 10m" — a plain duration for "in …" and "… ago". */
export function spanText(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60)
  if (d) return `${d}d ${h}h`
  if (h) return `${h}h ${m}m`
  return m ? `${m}m` : `${s}s`
}

const provenanceText = (m: MarkEntry) =>
  m.provenance === 'observed' ? 'measured from the provider'
    : m.provenance === 'inferred' ? 'inferred, not measured'
      : 'how it was recorded is not stored'

/** A row may carry marks in the registry (a live `limited` standing) or,
 *  for the default Claude login and old setup-token keys, in the older
 *  account list the standing does not show. Only those rows are read. */
const mayHaveMarks = (row: AccountRow) => row.standing.state === 'limited'
  || (row.provider === 'claude' && (!!row.ambient || row.credential.kind === 'token'))

function AccountMarks({ row, toast }: { row: AccountRow; toast: ToastFn }) {
  const [marks, setMarks] = useState<MarkEntry[]>([])
  const [confirm, setConfirm] = useState<MarkEntry | null>(null)
  const want = mayHaveMarks(row)
  const load = useCallback(async () => {
    if (!want) { setMarks([]); return [] }
    try {
      const data = await req<{ marks?: MarkEntry[] }>(`/api/accounts/${encodeURIComponent(row.id)}/marks`)
      const active = Array.isArray(data?.marks) ? data.marks.filter(m => m.state === 'active') : []
      setMarks(active)
      return active
    } catch { setMarks([]); return [] }
  }, [row.id, want])
  useEffect(() => { void load() }, [load, row.standing.state])
  if (!marks.length) return null
  return <div className="account-marks">
    {marks.map(m => <p key={m.source + m.pool} className="dim account-mark">
      {poolLabel(m.pool)} limited until {new Date(m.until * 1000).toLocaleString()} (in {spanText(m.remaining_s)})
      {' · '}{m.provenance === 'inferred' ? 'inferred' : m.provenance === 'observed' ? 'observed' : 'provenance not recorded'}
      {m.age_s !== null ? ` · recorded ${spanText(m.age_s)} ago` : ''}
      {' '}<button onClick={() => setConfirm(m)}>clear…</button>
    </p>)}
    {confirm && <ClearMarkDialog row={row} mark={confirm} toast={toast} reload={load}
      close={() => setConfirm(null)} />}
  </div>
}

/** THE DELIBERATE CONFIRMATION. It names the exact account, pool, reset
 *  time and provenance, what else goes with it, and what clearing does NOT
 *  do. The request carries the mark exactly as shown; if it changed in the
 *  meantime nothing is cleared and the dialog shows the new state instead,
 *  asking again. */
export function ClearMarkDialog({ row, mark, toast, reload, close }: {
  row: AccountRow; mark: MarkEntry; toast: ToastFn
  reload: () => Promise<MarkEntry[]>; close: () => void
}) {
  const [shown, setShown] = useState<MarkEntry | null>(mark)
  const [notice, setNotice] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const who = accountIdentity(accountDisplayId(row), row.identity?.email)
  const submit = async () => {
    if (!shown || busy) return
    setBusy(true); setNotice('')
    try {
      const out = await req<MarkClearResult>(
        `/api/accounts/${encodeURIComponent(shown.account)}/marks/clear`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ source: shown.source, pool: shown.pool, expected: shown.expected,
            ...(shown.companion ? { companion_expected: shown.companion.expected } : {}),
            reason: reason.trim() }) })
      if (out.result === 'cleared') {
        toast([`${who}: ${poolLabel(shown.pool)} mark cleared. Frozen agents still need to be resumed.`])
        await reload()
        close()
        return
      }
      const fresh = (await reload()).find(m => m.source === shown.source && m.pool === shown.pool) ?? null
      setShown(fresh)
      setNotice(fresh
        ? 'This mark changed since you opened this dialog. Nothing was cleared. Check the new details and confirm again.'
        : 'This mark is no longer active. Nothing was cleared.')
    } catch (e) { setNotice(e instanceof Error ? e.message : 'Could not clear the mark') }
    finally { setBusy(false) }
  }
  const companion = shown?.companion
  return <PinFrame kind="clear-account-mark" title="Clear capacity mark" panel="settings clear-mark-dialog"
    close={close} onEsc={close} pinnable={false} dialogLabel="Clear capacity mark">
    <h3>Clear capacity mark</h3>
    {notice && <p className="clear-mark-notice" role="status">{notice}</p>}
    {shown && <>
      <dl className="clear-mark-details">
        <dt>Account</dt><dd>{who}</dd>
        <dt>Pool</dt><dd>{poolLabel(shown.pool)}</dd>
        <dt>Limited until</dt><dd>{new Date(shown.until * 1000).toLocaleString()} (in {spanText(shown.remaining_s)})</dd>
        <dt>Recorded</dt><dd>{provenanceText(shown)}{shown.age_s !== null ? `, ${spanText(shown.age_s)} ago` : ''}</dd>
        <dt>Stored in</dt><dd>{shown.source === 'registry' ? 'account list' : 'older account list (default Claude login)'}</dd>
      </dl>
      {companion && (companion.cleared_with_this
        ? <p>This also clears the inferred Fable mark that was added with it (same reset time).</p>
        : <p>The Fable mark on this account stays; it was recorded separately.</p>)}
      {shown.source === 'legacy-roster' && shown.pool === 'pooled'
        && <p>Any Fable mark on this account stays; clear it separately if needed.</p>}
      <p className="clear-mark-warning">Clearing does not add capacity. If the provider still refuses, the account is marked again. Frozen agents stay frozen until you resume them.</p>
      <label>Reason (optional, kept in the audit record)
        <input value={reason} maxLength={500} onChange={e => setReason(e.target.value)} /></label>
    </>}
    <div className="dialog-actions">
      <button onClick={close} disabled={busy}>{shown ? 'Cancel' : 'Close'}</button>
      {shown && <button className="danger" disabled={busy} onClick={() => { void submit() }}>
        Clear {poolLabel(shown.pool)} mark on {accountDisplayId(row)}</button>}
    </div>
  </PinFrame>
}
const LABELS: Record<AccountProvider, string> = { claude: 'Claude', openai: 'Codex', google: 'Antigravity' }
const ANTIGRAVITY_ACCOUNT_PROFILE_ISSUE =
  'https://github.com/google-antigravity/antigravity-cli/issues/381'
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
  /** Removing an account MOVES ITS AGENTS: the backend rebinds every stored
   *  binding — live, halted, frozen and archived alike — to the provider's
   *  primary account and only then removes the row. The reload is what makes
   *  the removed account disappear and the moved agents show `default`; the
   *  toast says how many moved, because a button that silently relocates
   *  agents would be a worse surprise than the refusal it replaces. */
  const remove = async (row: AccountRow) => {
    setBusy(row.id)
    try {
      const out = await req<{ removed: string; rebound?: { org: string; node: string }[] }>(
        `/api/accounts/${row.id}`, { method: 'DELETE' })
      await registry.reload()
      const moved = out?.rebound?.length ?? 0
      toast([moved > 0
        ? `${accountIdentity(accountDisplayId(row), row.identity?.email)} removed — ${moved} agent(s) moved to ${LABELS[provider]} default`
        : `${accountIdentity(accountDisplayId(row), row.identity?.email)} removed`])
    }
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
          {/* ⚠ NO LONGER DISABLED BY ITS BINDINGS (user ticket 2026-09-21).
              Requiring every agent to be reassigned by hand first made this
              control unusable — the bindings to clear included archived
              agents no surface lists. The primary account itself stays
              unremovable: it is what everything else is moved back to. */}
          <button disabled={busy !== null || !!row.ambient}
            title={row.ambient ? `The ${LABELS[provider]} default account cannot be removed`
              : row.bound.length > 0
                ? `Remove this account and move its ${row.bound.length} agent(s) to the ${LABELS[provider]} default account`
                : 'Remove this account'}
            onClick={() => { void remove(row) }}>remove</button>
        </div>
        <AccountMarks row={row} toast={toast} />
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
    {provider === 'google' ? (
      <section className="account-add-option account-upstream-note">
        <h4>Secondary subscription accounts unavailable</h4>
        <p className="dim">Native secondary subscription-account setup is waiting on upstream Antigravity CLI support.</p>
        <a className="account-upstream-link" href={ANTIGRAVITY_ACCOUNT_PROFILE_ISSUE}
          target="_blank" rel="noopener noreferrer">
          Track Antigravity CLI account-profile support (issue #381)
        </a>
      </section>
    ) : <>
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
    </>}
    {/* ⚠ OFFERED WHETHER OR NOT THE PROVIDER'S SUBSCRIPTION IS SIGNED IN
        (ticket requirement): an API-key account is an ordinary account, not a
        spare bolted onto a subscription, and Orgtree can run on keys alone.
 */}
    <section className="account-add-option">
      <h4>Use an API key</h4>
      <p className="dim">Bill this account directly to {provider === 'google' ? 'Gemini' : LABELS[provider]} API
        credit. It shows total spend instead of subscription limits, and is
        never used for fallback unless you turn that on.</p>
      <label>API key<input aria-label="API key" type="password" value={key}
        disabled={busy} placeholder={provider === 'google' ? 'Gemini API key' : 'API key'}
        onChange={e => setKey(e.target.value)} /></label>
      <p className="dim">Stored on this machine and never shown again.</p>
      {provider === 'google' && <p className="dim">Uses Gemini API billing and Gemini models.</p>}
      <button disabled={busy || !key.trim()}
        onClick={() => { void create('apikey') }}>Add API-key account</button>
    </section>
    {provider === 'google' && <p className="dim">Secondary Antigravity sign-in is not supported yet. Importing a folder does not verify its sign-in.</p>}
    {error && <p className="ask-warn" role="alert">{error}</p>}
    <button disabled={busy} onClick={dismiss}>Cancel</button>
  </PinFrame>
}
