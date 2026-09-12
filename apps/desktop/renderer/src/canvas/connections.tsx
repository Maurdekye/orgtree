// canvas/connections.tsx — org settings → Connections.
//
// THIS ORGANIZATION's side of mail only: its address, and the hubs it
// connects out to. Hosting a hub and deciding which organizations may connect
// to it are properties of the INSTALLATION — one installation hosts at most
// one hub — and now live in App settings → Mail hub (canvas/hosthub.tsx).
// They used to be rendered here, which made an installation-wide setting look
// per-organization and made the grant controls read as though they applied to
// the remote hub named in the connect form beside them.

import { useState } from 'react'
import { req, saveSettings } from '../api'
import type { TreePayload, ToastFn } from '../types'
import { CloseIcon } from '../icons'
import { PinFrame } from './modalpin'

export function ConnectionsPanel({ tree, toast, close }: {
  tree: TreePayload; toast: ToastFn; close: () => void
}) {
  const [adding, setAdding] = useState('')
  return <PinFrame kind="connections" title="Connections" panel="settings wide" close={close}>
    <h3>Connections</h3>
    <Connections tree={tree} toast={toast} adding={adding} setAdding={setAdding} />
    <button onClick={close}>close</button>
  </PinFrame>
}

export function Connections({ tree, toast, adding, setAdding }: {
  tree: TreePayload; toast: ToastFn; adding: string; setAdding: (value: string) => void
}) {
  const hubs = tree.net?.hubs ?? []
  const [busy, setBusy] = useState(false)
  const address = tree.net?.slug ?? ''
  const apply = async (patch: Parameters<typeof saveSettings>[1], note: string) => {
    setBusy(true)
    try {
      const result = await saveSettings(tree.slug, patch)
      toast(result.warnings?.length ? result.warnings : [note])
      return true
    } catch (e) { toast([`error: ${(e as Error).message}`]); return false }
    finally { setBusy(false) }
  }
  const settings = hubs.filter(h => h.id !== 'local').map(h => ({ id: h.id, address: h.address, enabled: h.enabled }))
  return <>
    <div className="field-label">This organization's address</div>
    <div className="row" style={{ alignItems: 'center' }}>
      <p className="mono-sm">{address || 'Not connected'}</p>
      {address && <button type="button" onClick={() => {
        navigator.clipboard.writeText(address)
          .then(() => toast(['Organization address copied']))
          .catch(() => toast(['error: copy is unavailable; select the address and copy it']))
      }}>Copy address</button>}
    </div>
    <p className="dim">Give this address to the operator hosting a hub. They grant it access in their App settings, under Mail hub.</p>
    <label className="checkline"><input type="checkbox" disabled={busy}
      checked={hubs.some(h => h.id === 'local')}
      onChange={e => { void apply({ net_autoconnect: e.target.checked }, e.target.checked ? 'Local connection enabled' : 'Local connection disabled') }} />
      connect to organizations on this computer</label>
    <p className="dim">Read and send correspondence in Mail.</p>
    <div className="field-label">This organization's connections</div>
    {!hubs.length && <p className="dim">No connections configured.</p>}
    {hubs.map(h => <section key={h.id} className="connection-row">
      <div className="row" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
        <span className={'oi-dot' + (h.connected ? ' ok' : '')} />
        <b>{h.name || (h.id === 'local' ? 'This computer' : h.address)}</b>
        <span className="dim" style={{ flex: 1 }}>{h.connected ? 'Connected' : h.enabled ? h.error || 'Connecting…' : 'Disabled'}</span>
        {h.queued > 0 && <span>{h.queued} queued</span>}
        {h.id !== 'local' && <>
          <label className="checkline"><input type="checkbox" checked={h.enabled} disabled={busy}
            onChange={e => { void apply({ net_hubs: settings.map(x => x.id === h.id ? { ...x, enabled: e.target.checked } : x) }, 'Connection updated') }} />on</label>
          <button title="Remove connection" disabled={busy} onClick={() => { void apply({ net_hubs: settings.filter(x => x.id !== h.id) }, 'Connection removed') }}><CloseIcon fontSize="inherit" /></button>
        </>}
      </div>
      <div className="dim mono-sm">{h.address}</div>
      {h.roster?.length ? <ul className="connection-peers">{h.roster.map(p => <li key={p.slug}>
        <b>{p.org_name || p.slug}</b> <span className="mono-sm">{p.slug}</span> · {p.online ? 'Online' : 'Offline'}
        {p.blurb && <span className="dim"> · {p.blurb}</span>}
      </li>)}</ul> : <p className="dim">No peers reported.</p>}
    </section>)}
    <ConnectHub slug={tree.slug} address={adding} setAddress={setAdding} identity={address} toast={toast} />
  </>
}

export function ConnectHub({ slug, address, setAddress, identity, toast }: {
  slug: string; address: string; setAddress: (address: string) => void; identity: string; toast: ToastFn
}) {
  const [peerId, setPeerId] = useState('')
  const [peerSlug, setPeerSlug] = useState(identity)
  const [credential, setCredential] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [invitation, setInvitation] = useState('')
  return <section className="connection-setup connect-hub">
    <h4>Connect this organization to a hub</h4>
    <p className="dim">Enter the hub's address and the connection details its owner supplied. Hosting a hub of your own is in App settings, under Mail hub.</p>
    {error && <p role="alert" className="ask-warn">{error}</p>}
    <form onSubmit={async e => {
      e.preventDefault(); setBusy(true); setError('')
      try {
        await req(`/api/orgs/${encodeURIComponent(slug)}/net/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ address: address.trim(), peer_id: peerId.trim(), peer_slug: peerSlug.trim(), peer_token: credential.trim() }) })
        setCredential(''); setInvitation(''); setAddress(''); toast(['Hub connected'])
      } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
    }}>
      <label>Hub address<input type="url" required value={address} onChange={e => setAddress(e.target.value)} placeholder="https://hub.example" /></label>
      <label>Credential ID<input required value={peerId} onChange={e => setPeerId(e.target.value)} /></label>
      <label>Authorized organization address<input required value={peerSlug} onChange={e => setPeerSlug(e.target.value)} /></label>
      <label>Scoped credential<input type="password" autoComplete="off" required value={credential} onChange={e => setCredential(e.target.value)} /></label>
      <button type="submit" disabled={busy}>Connect</button>
    </form>
    <details><summary>Paste a connection invitation</summary>
      <textarea aria-label="Connection invitation" value={invitation} onChange={e => setInvitation(e.target.value)} />
      <button disabled={!invitation.trim() || busy} onClick={() => {
        try {
          const data = JSON.parse(invitation)
          if (data.version !== 1 || !['address', 'peer_id', 'peer_slug', 'peer_token'].every(k => typeof data[k] === 'string' && data[k])) throw Error('Invalid invitation')
          setAddress(data.address); setPeerId(data.peer_id); setPeerSlug(data.peer_slug); setCredential(data.peer_token); setInvitation(''); setError('')
        } catch { setError('This invitation could not be read. Paste its complete JSON text.') }
      }}>Use invitation</button>
    </details>
  </section>
}
