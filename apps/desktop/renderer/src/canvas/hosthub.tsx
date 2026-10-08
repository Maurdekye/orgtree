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

import { useEffect, useRef, useState } from 'react'
import { SetBlock, SetGroup, SetRow, SetToggle } from './settingskit'
import { req } from '../api'
import { AutorenewIcon } from '../icons'

export interface HubHosting {
  version: 2
  port: number
  bind: '127.0.0.1' | '0.0.0.0'
  name: string
  retention_days: number | null
  org_retention_days: number
  max_attachment_bytes?: number
  public_listener: boolean
  public_listener_port: number
  status: { running: boolean; healthy: boolean; address: string; exposed: boolean;
    hub_name?: string | null; hub_version?: string | null; orgs?: number | null; queued?: number | null }
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
    public_listener: value.public_listener, public_listener_port: value.public_listener_port,
    status: value.status, error: value.error, migrated: value.migrated,
    data_migration: value.data_migration, v2_import: value.v2_import,
  }
}

/** Hosting settings and live status for this installation's own hub.
 *
 *  `active` is false while another App settings tab is showing. Every panel in
 *  that modal stays mounted so half-typed values survive a tab switch, so a
 *  tab that has never been LOOKED at must not fetch hub state nobody asked to
 *  see. It defaults to true for the standalone uses of this component. */
export function HostHub({ active = true }: { active?: boolean } = {}) {
  const [config, setConfig] = useState<HubHosting | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState('')
  // retention is presented as a choice, not a magic number: the integrated
  // hub defaults to keeping mail forever (user ruling 2026-09-15)
  const [keepDays, setKeepDays] = useState(30)
  const load = async () => {
    setBusy(true); setError('')
    try {
      const next = readHosting(await req<HubHosting>(route))
      setConfig(next)
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
      <SetBlock hint="This computer's mail hub carries correspondence between organizations here and on other machines. Organizations connect to it from their own Connections tab." />
      {config && <SetBlock><p role="status">
        {running ? <>Running at <span className="mono-sm">{config.status.address}</span>
          {' '}· hub version {config.status.hub_version || 'unknown'}
          {typeof config.status.orgs === 'number' && <> · {config.status.orgs} registered, {config.status.queued ?? 0} queued</>}</>
          : config.status.running ? 'Starting…' : 'Stopped'}
      </p></SetBlock>}
      {config?.error && <SetBlock><p role="alert" className="ask-warn">The hub could not start: {config.error}</p></SetBlock>}
      {config?.migrated?.notes?.length ? <SetBlock><div role="note" className="ask-warn">
        {config.migrated.notes.map((n, i) => <p key={i}>Carried over from the previous version: {n}</p>)}
      </div></SetBlock> : null}
      {config?.data_migration && <SetBlock hint={`Mail from the previous hub was migrated: ${config.data_migration.messages} message(s), ${config.data_migration.attachments} attachment(s). The old store is kept untouched as a backup.`} />}
      {config?.v2_import && <SetBlock hint={`The hub's earlier mail was moved into its new database: ${config.v2_import.orgs} address(es), ${config.v2_import.messages} message(s), ${config.v2_import.attachments} attachment(s). The old store (hub.sqlite3) is kept untouched as a backup.`} />}
      {error && <SetBlock><p role="alert" className="ask-warn">{error}</p></SetBlock>}
      {!config && <SetBlock><div className="row"><button disabled={busy} onClick={() => { void load() }}>{busy ? 'Loading hosting settings...' : 'Retry hosting settings'}</button></div></SetBlock>}
    </SetGroup>
    {config && <form onSubmit={async e => {
      e.preventDefault(); setBusy(true); setError(''); setSaved('')
      try {
        const next = readHosting(await req<HubHosting>(route, { method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ version: 2, port: config.port, bind: config.bind,
            name: config.name.trim(), retention_days: config.retention_days,
            max_attachment_bytes: config.max_attachment_bytes,
            public_listener: config.public_listener }) }))
        setConfig(next); setSaved('Hosting settings saved.')
      } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
    }}>
      <fieldset disabled={busy} style={{ border: 0, padding: 0, margin: 0 }}>
        <SetGroup title="Hosting">
          <SetRow label="Hub name" hint="Shown to everyone who connects, and on the hub's own mail page.">
            <input aria-label="Mail hub name" value={config.name} placeholder="this computer's name"
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
          {exposed && <SetBlock><p className="ask-warn">Anyone who can reach the hub can read ALL mail on its page — that page is the operator view and has no login. Share it only on a network where every machine is trusted. The hub does not provide TLS; put a reverse proxy in front if you need encryption.</p></SetBlock>}
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
            hint="For peers outside your network: it carries mail only — no mail page — and every caller must present its own organization's secret. Tunnel or forward that port, never the main one." />
        </SetGroup>
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

/** The whole App settings → Mail hub tab. */
export function MailHubSettings({ active = true }: { active?: boolean } = {}) {
  return <HostHub active={active} />
}
