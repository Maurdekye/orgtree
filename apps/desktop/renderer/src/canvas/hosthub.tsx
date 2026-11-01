// canvas/hosthub.tsx — App settings → Mail hub.
//
// One Orgtree installation hosts at most ONE mail hub, so everything about
// hosting it — the port, where it listens, its name, how long mail is kept —
// is a property of this installation, not of whichever organization happens
// to be open. What stays in an organization's Connections tab is that
// organization's own side: its address, and the hubs it connects OUT to.
//
// The hub itself is the pinned orgtree-mailhub product run natively by the
// engine (never Docker inside Orgtree — user ruling 2026-09-15), and these
// controls are exactly its own configuration surface in plain language:
// port / listen interface / display name / retention / the relay-only
// public listener. The settings model matches engine/mailhub_runtime.py.
//
// The tab opens on the hub's status line and everyone registered on it (USER
// 2026-10-29 m12a433749fda "remove the extra text surrounding the mailhub
// running status and replace it with a similar list for the local orgtree
// mailhub and its current connections"): the intro and the two migration
// reports are gone from view (their files and the old store stay as they
// were), and Chat from your phone comes after the list (m6b0d9089462e "and
// move all this stuff lower down").

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { SetBlock, SetGroup, SetRow, SetToggle } from './settingskit'
import { getHubConnections, req } from '../api'
import type { NetPeer } from '../types'
import { AutorenewIcon } from '../icons'
import { PhoneSettingsGroup, removePhoneRuleAfterOff } from './phonelink'
import { windowIdentity } from '../desktop'
import { ConnectionList, toRecency, type Recency } from './connectionlist'
import { setLocalHubRoster } from './netmentions'
import { LANGUAGES, languageName } from './languages'

/** Mail hub 2.4.0 translation between people, as the hub takes it (its
 *  runtime file's `translation`; the key goes through its own route). */
export interface HubTranslation {
  enabled: boolean
  default_language: string
  model: string
  monthly_limit_usd: number
}
const TRANSLATION_DEFAULT: HubTranslation = { enabled: false, default_language: 'en', model: 'claude-haiku-5-5', monthly_limit_usd: 5 }
const readTranslation = (t: any): HubTranslation => t && typeof t === 'object'
  ? { enabled: t.enabled === true,
      default_language: typeof t.default_language === 'string' && t.default_language ? t.default_language : 'en',
      model: typeof t.model === 'string' && t.model ? t.model : TRANSLATION_DEFAULT.model,
      monthly_limit_usd: typeof t.monthly_limit_usd === 'number' ? t.monthly_limit_usd : TRANSLATION_DEFAULT.monthly_limit_usd }
  : { ...TRANSLATION_DEFAULT }
/** The hub's own count, from its /healthz (main port only). */
export interface HubTranslationStatus {
  enabled?: boolean
  state?: 'off' | 'ok' | 'no_key' | 'key_refused'
  month?: string
  spent_usd?: number
  messages?: number
  limit_usd?: number | null
}
const usd = (n: number) => `$${n.toFixed(2)}`

export interface HubHosting {
  version: 2
  port: number
  bind: '127.0.0.1' | '0.0.0.0'
  name: string
  retention_days: number | null
  org_retention_days: number
  max_attachment_bytes?: number
  translation?: HubTranslation
  /** whether an Anthropic API key is stored (the key itself never comes back) */
  translation_key_set?: boolean
  public_listener: boolean
  public_listener_port: number
  /** who may reach the door: set by Connect your phone (tailnet / lan) */
  public_scope?: 'tailnet' | 'lan' | 'all'
  status: { running: boolean; healthy: boolean; address: string; exposed: boolean;
    hub_name?: string | null; hub_version?: string | null; orgs?: number | null; queued?: number | null
    translation?: HubTranslationStatus | null }
  error?: string
  migrated?: { from: string; at: string; notes: string[] }
  data_migration?: { messages: number; attachments: number; orgs_copied: number; orgs_skipped: string[] }
  /** mail hub v2's first start: the earlier hub's store (hub.sqlite3, kept)
   *  imported into the hub's own database */
  v2_import?: { orgs: number; messages: number; attachments: number; imported_at?: string; source?: string }
}
const route = '/api/desktop/hub'
export const readHosting = (value: HubHosting): HubHosting => {
  if (value.version !== 2 || !Number.isInteger(value.port)
    || !['127.0.0.1', '0.0.0.0'].includes(value.bind) || typeof value.name !== 'string'
    || (value.retention_days !== null && !Number.isInteger(value.retention_days))
    || typeof value.public_listener !== 'boolean' || !value.status
    || typeof value.status.running !== 'boolean') throw Error('The mail hub configuration could not be read.')
  return {
    version: 2, port: value.port, bind: value.bind, name: value.name,
    retention_days: value.retention_days, org_retention_days: value.org_retention_days,
    max_attachment_bytes: value.max_attachment_bytes ?? 1024 ** 3,
    translation: readTranslation(value.translation), translation_key_set: value.translation_key_set === true,
    public_listener: value.public_listener, public_listener_port: value.public_listener_port, public_scope: value.public_scope,
    status: value.status, error: value.error, migrated: value.migrated,
    data_migration: value.data_migration, v2_import: value.v2_import,
  }
}

/** Everyone registered on this computer's hub, as the Connections tab's rows:
 *  read through the engine from the hub's own read-only operator view, with
 *  presence. Online first, then the newest mail an org here that uses the hub
 *  exchanged with each address. Read with the hub's status (the tab's first
 *  look, Refresh, a save). While shown, its rows describe their chips
 *  (netmentions.setLocalHubRoster), also where no org is on screen. */
function LocalHubConnections({ revision }: { revision: number }) {
  const [list, setList] = useState<{ rows: NetPeer[]; recent: Recency } | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let alive = true
    getHubConnections().then(r => {
      if (!alive) return
      const rows = (Array.isArray(r?.connections) ? r.connections : []).filter(p => typeof p?.slug === 'string' && p.slug !== '')
      setLocalHubRoster(rows)
      setList({ rows, recent: toRecency(r?.recent) })
      setError(r?.error ? String(r.error) : '')
    }, e => { if (alive) setError((e as Error).message) })
    return () => { alive = false }
  }, [revision])
  useEffect(() => () => setLocalHubRoster(null), [])
  return <>
    {error && <SetBlock><p role="alert" className="ask-warn">The hub's connections could not be read: {error}</p></SetBlock>}
    {list && (list.rows.length
      ? <SetBlock><ConnectionList rows={list.rows} recent={list.recent} label="Connections on this computer's mail hub" /></SetBlock>
      : !error && <SetBlock hint="Nothing is registered on this hub yet." />)}
  </>
}

/** Hosting settings and live status for this installation's own hub.
 *
 *  `active` is false while another App settings tab is showing. Every panel in
 *  that modal stays mounted so half-typed values survive a tab switch, so a
 *  tab that has never been LOOKED at must not fetch hub state nobody asked to
 *  see. It defaults to true for the standalone uses of this component.
 *  `phone` (App settings' Chat from your phone) goes under the hub's status
 *  and connections, above the hosting settings. */
export function HostHub({ active = true, phone }: { active?: boolean; phone?: ReactNode } = {}) {
  const [config, setConfig] = useState<HubHosting | null>(null)
  // each read of the hub's status reads its connections again
  const [reads, setReads] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState('')
  // retention is presented as a choice, not a magic number: the integrated
  // hub defaults to keeping mail forever (user ruling 2026-09-15)
  const [keepDays, setKeepDays] = useState(30)
  // the door as last loaded or saved (turning it off removes the firewall rule)
  const doorWas = useRef(false)
  // the translation key as typed (never read back), or Forget it
  const [keyDraft, setKeyDraft] = useState('')
  const [forgetKey, setForgetKey] = useState(false)
  const load = async () => {
    setBusy(true); setError('')
    try {
      const next = readHosting(await req<HubHosting>(route))
      setConfig(next)
      setReads(n => n + 1)
      doorWas.current = next.public_listener
      if (next.retention_days !== null) setKeepDays(next.retention_days)
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  const opened = useRef(false)
  useEffect(() => {
    if (!active || opened.current) return
    opened.current = true
    void load()
  }, [active])
  const exposed = config?.bind === '0.0.0.0'
  const running = config?.status.running && config.status.healthy
  return <section className="host-hub">
    <SetGroup title="Mail hub">
      {config && <SetBlock><p role="status">
        {running ? <>Running at <span className="mono-sm">{config.status.address}</span>
          {' '}· hub version {config.status.hub_version || 'unknown'}
          {typeof config.status.orgs === 'number' && <> · {config.status.orgs} registered, {config.status.queued ?? 0} queued</>}</>
          : config.status.running ? 'Starting…' : 'Stopped'}
      </p></SetBlock>}
      {running && <LocalHubConnections revision={reads} />}
      {config?.error && <SetBlock><p role="alert" className="ask-warn">The hub could not start: {config.error}</p></SetBlock>}
      {config?.migrated?.notes?.length ? <SetBlock><div role="note" className="ask-warn">
        {config.migrated.notes.map((n, i) => <p key={i}>Carried over from the previous version: {n}</p>)}
      </div></SetBlock> : null}
      {error && <SetBlock><p role="alert" className="ask-warn">{error}</p></SetBlock>}
      {!config && <SetBlock><div className="row"><button disabled={busy} onClick={() => { void load() }}>{busy ? 'Loading hosting settings...' : 'Retry hosting settings'}</button></div></SetBlock>}
    </SetGroup>
    {phone}
    {config && <form onSubmit={async e => {
      e.preventDefault(); setBusy(true); setError(''); setSaved('')
      try {
        const next = readHosting(await req<HubHosting>(route, { method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ version: 2, port: config.port, bind: config.bind,
            name: config.name.trim(), retention_days: config.retention_days,
            max_attachment_bytes: config.max_attachment_bytes,
            public_listener: config.public_listener,
            translation: config.translation ?? TRANSLATION_DEFAULT }) }))
        // the key alone, through its own route (its body is never logged)
        const key = forgetKey ? '' : keyDraft.trim()
        const stored = key || forgetKey
          ? readHosting(await req<HubHosting>(`${route}/translation-key`, { method: 'PUT', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ key }) }))
          : next
        setKeyDraft(''); setForgetKey(false)
        setConfig(stored); setReads(n => n + 1); setSaved('Hosting settings saved.')
        // the door just closed: its firewall rule goes too (one admin prompt)
        if (doorWas.current && !next.public_listener) {
          const note = await removePhoneRuleAfterOff()
          if (note) setSaved(`Hosting settings saved. ${note}`)
        }
        doorWas.current = next.public_listener
      } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
    }}>
      <fieldset disabled={busy} style={{ border: 0, padding: 0, margin: 0 }}>
        <SetGroup title="Hosting">
          <SetRow label="Hub name" hint="Shown to everyone who connects, and on the hub's own mail page.">
            <input aria-label="Mail hub name" value={config.name} placeholder="This computer's name"
              onChange={e => setConfig({ ...config, name: e.target.value })} />
          </SetRow>
          <SetRow label="Maximum attachment size (MiB)"
            hint="Defaults to 1024 MiB (1 GB). Changing only this limit applies to new uploads immediately, without restarting the hub.">
            <input aria-label="Maximum attachment size (MiB)" type="number" min="1" step="1" required
              value={(config.max_attachment_bytes ?? 1024 ** 3) / 1024 ** 2}
              onChange={e => setConfig({ ...config, max_attachment_bytes: Number(e.target.value) * 1024 ** 2 })} />
          </SetRow>
          <SetRow label="Port">
            <input aria-label="Mail hub port" type="number" min="1" max="65535" required value={config.port}
              onChange={e => setConfig({ ...config, port: Number(e.target.value) })} />
          </SetRow>
          <SetRow label="Listen on">
            <select aria-label="Mail hub listen interface" value={config.bind}
              onChange={e => setConfig({ ...config, bind: e.target.value as HubHosting['bind'] })}>
              <option value="127.0.0.1">This computer only</option>
              <option value="0.0.0.0">This computer and the local network</option>
            </select>
          </SetRow>
          {exposed && <SetBlock><p className="ask-warn">Anyone who can reach the hub can read all mail on its page — that page is the operator view and has no login. Share it only on a network where every machine is trusted. The hub does not provide TLS; put a reverse proxy in front if you need encryption.</p></SetBlock>}
        </SetGroup>
        <SetGroup title="Retention">
          <SetRow label="Keep mail"
            hint={config.retention_days === null ? undefined
              : 'Mail and attachments older than this are deleted hourly — read or not. Without a number of days, the hub keeps mail until the people and organizations it belongs to delete it.'}>
            <select aria-label="Mail retention" value={config.retention_days === null ? 'forever' : 'days'}
              onChange={e => setConfig({ ...config, retention_days: e.target.value === 'forever' ? null : keepDays })}>
              <option value="forever">Until it is deleted</option>
              <option value="days">A limited number of days</option>
            </select>
          </SetRow>
          {config.retention_days !== null && <SetRow label="Days to keep mail">
            <input aria-label="Days to keep mail" type="number" min="1" max="36500" required
              value={config.retention_days}
              onChange={e => { const d = Number(e.target.value); setKeepDays(d); setConfig({ ...config, retention_days: d }) }} />
          </SetRow>}
        </SetGroup>
        <SetGroup title="Public access">
          <SetToggle label={`Also serve a relay-only door on port ${config.public_listener_port || 7371}`}
            checked={config.public_listener}
            onChange={next => setConfig({ ...config, public_listener: next })}
            hint={config.public_listener && config.public_scope === 'tailnet'
              ? 'On — turned on by Connect your phone, for your Tailscale network only.'
              : config.public_listener && config.public_scope === 'lan'
                ? 'On — turned on by Connect your phone, for your home network.'
                : "For peers outside your network: it carries mail only — no mail page — and every caller must present its own organization's secret. Tunnel or forward that port, never the main one."} />
        </SetGroup>
        <TranslationGroup config={config} setConfig={setConfig} running={!!running}
          keyDraft={keyDraft} setKeyDraft={setKeyDraft} forgetKey={forgetKey} setForgetKey={setForgetKey} />
        <div className="row">
          <button type="submit">Save hosting settings</button>
          <button type="button" className="iconbtn" aria-label="Refresh hub status" title="Refresh hub status" onClick={() => { void load() }}><AutorenewIcon fontSize="inherit" /></button>
        </div>
      </fieldset>
      {saved && <p role="status">{saved}</p>}
      {running && <p className="dim">The hub's own mail page (the operator view of every message it carries): <a href={config.status.address} target="_blank" rel="noreferrer">{config.status.address}</a></p>}
    </form>}
  </section>
}

/** Translation between people on this hub (Mail hub 2.4.0; docket
 *  mail-hub-hubchat-automatic-translation-between-u, USER 2026-11-01 12:15Z
 *  answers): on or off, the language taken for senders who set none, the
 *  model, the month's limit and the Anthropic API key (write-only, as a
 *  language server's key). All of it applies without restarting the hub. */
function TranslationGroup({ config, setConfig, running, keyDraft, setKeyDraft, forgetKey, setForgetKey }: {
  config: HubHosting
  setConfig: (c: HubHosting) => void
  running: boolean
  keyDraft: string
  setKeyDraft: (k: string) => void
  forgetKey: boolean
  setForgetKey: (f: boolean) => void
}) {
  const t = config.translation ?? TRANSLATION_DEFAULT
  const edit = (patch: Partial<HubTranslation>) => setConfig({ ...config, translation: { ...t, ...patch } })
  const keySet = !!config.translation_key_set && !forgetKey
  const count = running ? config.status.translation : null
  const spent = typeof count?.spent_usd === 'number' ? count.spent_usd : null
  const limit = typeof count?.limit_usd === 'number' ? count.limit_usd : null
  const share = spent !== null && limit ? spent / limit : null
  const known = LANGUAGES.some(([tag]) => tag === t.default_language)
  return <SetGroup title="Translation">
    <SetToggle label="Translate messages between people" checked={t.enabled} onChange={enabled => edit({ enabled })}
      hint="Mail between people on this hub who read in different languages is translated for its reader by Anthropic's Claude, after it is delivered. Message text leaves this computer to be translated. Agents and organizations always get the original. Changes here apply without restarting the hub." />
    <SetRow label="Default language" hint="Taken as the language of agents, organizations and people who haven't chosen one.">
      <select aria-label="Default language" value={t.default_language} onChange={e => edit({ default_language: e.target.value })}>
        {!known && <option value={t.default_language}>{languageName(t.default_language)}</option>}
        {LANGUAGES.map(([tag, name]) => <option key={tag} value={tag}>{name}</option>)}
      </select>
    </SetRow>
    <SetRow label="Model" hint="Claude Haiku 5.5 by default.">
      <input aria-label="Translation model" value={t.model} required spellCheck={false}
        onChange={e => edit({ model: e.target.value.trim() })} />
    </SetRow>
    <SetRow label="Monthly limit (USD)" hint="Past it, mail is delivered untranslated until the month ends (UTC) or the limit is raised.">
      <input aria-label="Monthly translation limit (USD)" type="number" min="0" max="100000" step="0.01" required
        value={t.monthly_limit_usd} onChange={e => edit({ monthly_limit_usd: Number(e.target.value) })} />
    </SetRow>
    <SetRow label="Anthropic API key"
      hint={keySet ? 'A key is stored (never shown). Paste a new one to replace it.' : 'Needed to translate. Stored on this computer and never shown again.'}>
      <input type="password" aria-label="Anthropic API key" autoComplete="off" spellCheck={false} value={keyDraft}
        placeholder={keySet ? 'Stored' : 'None'} disabled={forgetKey}
        onChange={e => setKeyDraft(e.target.value)} />
      {config.translation_key_set && <label className="ls-check">
        <input type="checkbox" aria-label="Forget the Anthropic API key" checked={forgetKey}
          onChange={e => { setForgetKey(e.target.checked); setKeyDraft('') }} /> Forget it</label>}
    </SetRow>
    {t.enabled && !keySet && !keyDraft.trim() && <SetBlock><p className="ask-warn">Add an Anthropic API key to start translating.</p></SetBlock>}
    {t.enabled && count?.state === 'key_refused' && <SetBlock><p role="alert" className="ask-warn">Translation stopped: Anthropic refused the API key. Paste a working key.</p></SetBlock>}
    {t.enabled && spent !== null && limit !== null && <SetBlock><p role="status">
      {usd(spent)} of {usd(limit)} this month · {(count?.messages ?? 0).toLocaleString('en-US')} messages translated
    </p></SetBlock>}
    {t.enabled && share !== null && share >= 1 && <SetBlock><p className="ask-warn">This month's limit is reached: mail is delivered untranslated until next month or a higher limit.</p></SetBlock>}
    {t.enabled && share !== null && share >= 0.8 && share < 1 && <SetBlock><p className="ask-warn">This month's translation spend is at {Math.floor(share * 100)}% of its limit.</p></SetBlock>}
  </SetGroup>
}

/** The whole App settings → Mail hub tab: the hub's status and connections,
 *  Chat from your phone, then the hosting settings. */
export function MailHubSettings({ active = true }: { active?: boolean } = {}) {
  // the org whose window opened App settings is the one that would trust the phone (D3)
  const org = windowIdentity()?.org ?? null
  // the phone panel itself opens in the window's own host (the canvas or Home)
  return <HostHub active={active} phone={<PhoneSettingsGroup org={org} active={active} />} />
}
