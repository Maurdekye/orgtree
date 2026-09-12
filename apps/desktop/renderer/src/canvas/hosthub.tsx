// canvas/hosthub.tsx — App settings → Mail hub.
//
// One Orgtree installation hosts at most ONE mail hub, so everything about
// hosting it — whether it listens, where it listens, its certificate, and
// which organizations are allowed to connect to it — is a property of this
// installation, not of whichever organization happens to be open. These
// controls used to sit inside a single organization's Connections tab, which
// made installation-wide settings look organization-specific and made the
// grant controls look as though they applied to the remote hub named in the
// connect form above them. They do not; they always administered the hub
// embedded in THIS installation.
//
// What stays in an organization's Connections tab is that organization's own
// side: its address, and the hubs it connects OUT to. See canvas/connections.

import { useEffect, useRef, useState } from 'react'
import { req } from '../api'
import { AutorenewIcon } from '../icons'

interface HubConfig {
  version: 1; enabled: boolean; bind_host: '127.0.0.1' | '0.0.0.0'; port: number; advertise_host: string
  tls_configured?: boolean
  status?: { ready: boolean; port: number; address: string; public: boolean }
  warning?: string
}
const route = '/api/desktop/hub'
const readConfig = (value: HubConfig): HubConfig => {
  if (value.version !== 1 || typeof value.enabled !== 'boolean' || !['127.0.0.1', '0.0.0.0'].includes(value.bind_host)
    || !Number.isInteger(value.port) || typeof value.advertise_host !== 'string') throw Error('The mail hub configuration could not be read.')
  // Retain only the sanitized response. Credentials and certificate contents never belong in this view.
  return { version: 1, enabled: value.enabled, bind_host: value.bind_host, port: value.port,
    advertise_host: value.advertise_host, tls_configured: value.tls_configured, status: value.status, warning: value.warning }
}

/** Hosting settings and status for this installation's own hub.
 *
 *  `active` is false while another App settings tab is showing. Every panel in
 *  that modal stays mounted so a half-typed path survives a tab switch, so a
 *  tab that has never been LOOKED at must not fetch hub state nobody asked to
 *  see. It defaults to true for the standalone uses of this component. */
export function HostHub({ active = true }: { active?: boolean } = {}) {
  const [config, setConfig] = useState<HubConfig | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState('')
  const [certificate, setCertificate] = useState(''), [key, setKey] = useState(''), [ca, setCa] = useState('')
  const load = async () => {
    setBusy(true); setError('')
    try { setConfig(readConfig(await req<HubConfig>(route))) }
    catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  const opened = useRef(false)
  useEffect(() => {
    if (!active || opened.current) return
    opened.current = true
    void load()
  }, [active])
  const publicHost = config?.bind_host === '0.0.0.0'
  return <section className="connection-setup host-hub">
    <h4>Host this installation's mail hub</h4>
    <p className="dim">This installation hosts one mail hub. Every organization on this computer shares it, and other installations connect to it using its advertised address and a credential granted below.</p>
    {config?.status && <p role="status">{config.status.ready ? 'Running' : config.enabled ? 'Not ready' : 'Stopped'}
      {config.status.ready && <> at <span className="mono-sm">{config.status.address}</span></>}</p>}
    {error && <p role="alert" className="ask-warn">{error}</p>}
    {!config && <button disabled={busy} onClick={() => { void load() }}>{busy ? 'Loading hosting settings...' : 'Retry hosting settings'}</button>}
    {config && <form onSubmit={async e => {
      e.preventDefault(); setBusy(true); setError(''); setSaved('')
      try {
        const next = readConfig(await req<HubConfig>(route, { method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ version: 1, enabled: config.enabled, bind_host: config.bind_host,
            port: config.port, advertise_host: config.advertise_host.trim(),
            ...(certificate.trim() ? { tls_certfile: certificate.trim() } : {}),
            ...(key.trim() ? { tls_keyfile: key.trim() } : {}), ...(ca.trim() ? { tls_ca_file: ca.trim() } : {}) }) }))
        setConfig(next); setCertificate(''); setKey(''); setCa(''); setSaved('Hosting settings saved.')
      } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
    }}>
      <fieldset disabled={busy} style={{ border: 0, padding: 0, margin: 0 }}>
        <label className="checkline"><input aria-label="Enable mail hub" type="checkbox" checked={config.enabled}
          onChange={e => setConfig({ ...config, enabled: e.target.checked })} />Enable mail hub</label>
        <label>Listen on<select aria-label="Mail hub listen address" value={config.bind_host}
          onChange={e => setConfig({ ...config, bind_host: e.target.value as HubConfig['bind_host'] })}>
          <option value="127.0.0.1">This computer only</option><option value="0.0.0.0">Network interfaces</option>
        </select></label>
        <label>Port<input aria-label="Mail hub port" type="number" min="0" max="65535" required value={config.port}
          onChange={e => setConfig({ ...config, port: Number(e.target.value) })} /></label>
        <p className="dim">Port 0 selects an available port. Use a fixed port when configuring access from other computers.</p>
        <label>Advertised host<input aria-label="Advertised mail hub host" value={config.advertise_host}
          onChange={e => setConfig({ ...config, advertise_host: e.target.value })} placeholder="mail.example.com" /></label>
        {publicHost && <>
          <p className="ask-warn">Configure network access yourself and provide trusted TLS certificate files on this computer. This exposes mail transport; the desktop interface stays private.</p>
          <p className="dim">{config.tls_configured ? 'TLS files are configured. Leave paths blank to keep them.' : 'TLS certificate and private key paths are required.'}</p>
          <label>TLS certificate file<input aria-label="TLS certificate file" autoComplete="off" value={certificate} onChange={e => setCertificate(e.target.value)} /></label>
          <label>TLS private key file<input aria-label="TLS private key file" autoComplete="off" value={key} onChange={e => setKey(e.target.value)} /></label>
          <label>CA certificate file (optional)<input aria-label="CA certificate file" autoComplete="off" value={ca} onChange={e => setCa(e.target.value)} /></label>
        </>}
        {config.warning && <p className="ask-warn">{config.warning}</p>}
        <div className="row"><button type="submit" disabled={publicHost && config.enabled && !config.tls_configured && (!certificate.trim() || !key.trim())}>Save hosting settings</button>
          <button type="button" className="iconbtn" aria-label="Refresh hub status" title="Refresh hub status" onClick={() => { void load() }}><AutorenewIcon fontSize="inherit" /></button></div>
      </fieldset>
      {saved && <p role="status">{saved}</p>}
    </form>}
  </section>
}

interface HubPeer {
  peer_id: string; slug: string; created_at: string
  revoked_at: string | null; allowed: boolean
}
interface HubPeerList { version: 1; address: string; peers: HubPeer[] }
const peersRoute = '/api/desktop/hub/peers'
const readPeers = (value: HubPeerList): HubPeer[] => {
  if (!value || !Array.isArray(value.peers)) throw Error('The list of allowed organizations could not be read.')
  // A grant never carries secret material. Keep only the fields this view
  // shows, so a future field on the wire cannot leak into the DOM by accident.
  return value.peers.map(p => ({ peer_id: String(p.peer_id), slug: String(p.slug),
    created_at: String(p.created_at ?? ''), revoked_at: p.revoked_at ?? null, allowed: p.allowed !== false }))
}

/** Which organizations this installation's hub admits, and their credentials.
 *
 *  Revoke and Disconnect are different actions by different parties: this is
 *  the HOST withdrawing admission, while an organization's own Connections tab
 *  stops that organization using its own connection. Neither deletes mail. */
export function HubPeers({ active = true }: { active?: boolean } = {}) {
  const [peers, setPeers] = useState<HubPeer[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [issueId, setIssueId] = useState('')
  const [issueSlug, setIssueSlug] = useState('')
  const [issued, setIssued] = useState('')
  const [note, setNote] = useState('')
  const load = async () => {
    setBusy(true); setError('')
    try { setPeers(readPeers(await req<HubPeerList>(peersRoute))) }
    catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  const opened = useRef(false)
  useEffect(() => {
    if (!active || opened.current) return
    opened.current = true
    void load()
  }, [active])
  const act = async (run: () => Promise<unknown>, done: string) => {
    setBusy(true); setError(''); setNote('')
    try { await run(); setNote(done); await load() }
    catch (e) { setError((e as Error).message); setBusy(false) }
  }
  const copy = async () => {
    try { await navigator.clipboard.writeText(issued); setNote('Connection details copied.') }
    catch { setError('Copy is unavailable. Select and copy the connection details below.') }
  }
  return <section className="connection-setup hub-peers">
    <h4>Organizations allowed to connect</h4>
    <p className="dim">Access is granted by this installation to one organization's address at a time. Revoking stops that organization from authenticating again; it does not delete correspondence already delivered, and it is not the same as an organization disconnecting itself.</p>
    {error && <p role="alert" className="ask-warn">{error}</p>}
    {note && <p role="status">{note}</p>}
    {!peers && !error && <p className="dim">Loading allowed organizations…</p>}
    {peers && !peers.length && <p className="dim">No organization has been granted access.</p>}
    {peers?.map(peer => <div key={peer.peer_id} className="row hub-peer-row" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
      <span className={'oi-dot' + (peer.allowed ? ' ok' : '')} />
      <b className="mono-sm">{peer.slug}</b>
      <span className="dim" style={{ flex: 1 }}>{peer.allowed ? 'Allowed' : 'Revoked'} · credential {peer.peer_id}</span>
      <button type="button" disabled={busy}
        onClick={() => { void act(() => req(`${peersRoute}/${encodeURIComponent(peer.peer_id)}/replace`, { method: 'POST' })
          .then(v => setIssued(JSON.stringify(v, null, 2))), 'Replacement credential created. The previous one no longer works.') }}>Replace credential</button>
      <button type="button" disabled={busy || !peer.allowed}
        onClick={() => { void act(() => req(`${peersRoute}/${encodeURIComponent(peer.peer_id)}`, { method: 'DELETE' }), 'Access revoked.') }}>Revoke access</button>
    </div>)}
    <div className="field-label">Allow an organization</div>
    <p className="dim">Ask the connecting operator for their organization's address, then hand the connection details back through a channel you already trust. They contain a reusable secret; showing them once does not make them usable once.</p>
    <label>Credential ID<input aria-label="Credential ID" value={issueId} onChange={e => setIssueId(e.target.value)} /></label>
    <label>Connecting organization's address<input aria-label="Allowed organization address" value={issueSlug} onChange={e => setIssueSlug(e.target.value)} /></label>
    <button type="button" disabled={busy || !issueId.trim() || !issueSlug.trim()} onClick={() => {
      setIssued('')
      void act(() => req(peersRoute, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ peer_id: issueId.trim(), slug: issueSlug.trim() }) })
        .then(v => { setIssued(JSON.stringify(v, null, 2)); setIssueId(''); setIssueSlug('') }), 'Connection details created.')
    }}>Create credential</button>
    {issued && <><textarea aria-label="New connection credential" readOnly value={issued} />
      <button type="button" onClick={() => { void copy() }}>Copy credential</button>
      <button type="button" onClick={() => setIssued('')}>Hide credential</button></>}
  </section>
}

/** The whole App settings → Mail hub tab. */
export function MailHubSettings({ active = true }: { active?: boolean } = {}) {
  return <><HostHub active={active} /><HubPeers active={active} /></>
}
