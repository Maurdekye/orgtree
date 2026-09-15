// canvas/connections.tsx — org settings → Connections.
//
// THIS ORGANIZATION's side of mail only: its network identity, and the hubs
// it connects out to. Hosting a hub is a property of the INSTALLATION — one
// installation hosts at most one hub — and lives in App settings → Mail hub
// (canvas/hosthub.tsx).
//
// The model here is the mail hub's own (orgtree-mailhub): the organization
// holds a self-issued SECRET; its address ends in the secret's fingerprint;
// hubs are joined by address alone (joining is open, ADDRESSES are owned);
// the client daemon keeps retrying forever, so "not reachable right now" is
// a status, never an error that blocks configuration. Changes apply
// immediately — hub membership is operational state, not a form draft.

import { useState } from 'react'
import { getOrgNet, probeHub, saveSettings } from '../api'
import type { NetHub, TreePayload, ToastFn } from '../types'
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

/** One hub row's status, in words. The ladder is the V1 hub's own:
 *  connected / retrying — why / connecting… / disabled. */
export const hubStatusText = (h: NetHub): string =>
  h.connected ? 'Connected'
    : !h.enabled ? 'Disabled'
      : h.error ? `Retrying — ${h.error}` : 'Connecting…'

export function Connections({ tree, toast, adding, setAdding }: {
  tree: TreePayload; toast: ToastFn; adding: string; setAdding: (value: string) => void
}) {
  const hubs = tree.net?.hubs ?? []
  const [busy, setBusy] = useState(false)
  const [secret, setSecret] = useState('')
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
  const copy = (value: string, note: string) => {
    navigator.clipboard.writeText(value)
      .then(() => toast([note]))
      .catch(() => toast(['error: copy is unavailable; select the text and copy it']))
  }
  const remove = (h: NetHub) => {
    // destructive actions state their scope first (a working connection or
    // queued mail is real state, not a form value)
    if (h.connected || h.queued > 0) {
      const scope = [
        h.connected ? 'a WORKING connection' : '',
        h.queued > 0 ? `${h.queued} queued outgoing message(s), which move to another enabled connection or wait with nowhere to go` : '',
      ].filter(Boolean).join(' and ')
      if (!window.confirm(`Remove ${h.name || h.address}? This removes ${scope}. The organization's address and identity are not affected.`)) return
    }
    void apply({ net_hubs: settings.filter(x => x.id !== h.id) }, 'Connection removed')
  }
  return <>
    <div className="field-label">This organization's address</div>
    <div className="row" style={{ alignItems: 'center' }}>
      <p className="mono-sm">{address || 'Not connected'}</p>
      {address && <button type="button" onClick={() => copy(address, 'Organization address copied')}>Copy address</button>}
    </div>
    <p className="dim">Peers on any hub reach this organization at this address. It never changes.</p>
    <div className="row" style={{ alignItems: 'center' }}>
      {!secret && <button type="button" disabled={!address} onClick={() => {
        getOrgNet(tree.slug)
          .then(r => setSecret(r.identity?.secret || '(none)'))
          .catch(e => toast([`error: ${(e as Error).message}`]))
      }}>Reveal secret…</button>}
      {secret && <>
        <p className="mono-sm">{secret}</p>
        <button type="button" onClick={() => copy(secret, 'Secret copied')}>Copy</button>
        <button type="button" onClick={() => setSecret('')}>Hide</button>
      </>}
    </div>
    <p className="dim">The secret IS the address's ownership — losing it loses the address; nobody can restore it. It never reaches an agent. Keep a copy somewhere safe if this organization's address matters to you.</p>
    <label className="checkline"><input type="checkbox" disabled={busy}
      checked={hubs.some(h => h.id === 'local')}
      onChange={e => { void apply({ net_autoconnect: e.target.checked }, e.target.checked ? 'Connected to this computer\'s mail hub' : 'Disconnected from this computer\'s mail hub') }} />
      connect to this computer's mail hub</label>
    <p className="dim">Being connected means peers can mail this organization (and thereby start its agents). Read and send correspondence in Mail.</p>
    <div className="field-label">This organization's connections</div>
    {!hubs.length && <p className="dim">No connections configured.</p>}
    {hubs.map(h => <section key={h.id} className="connection-row">
      <div className="row" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
        <span className={'oi-dot' + (h.connected ? ' ok' : '')} />
        <b>{h.name || (h.id === 'local' ? 'This computer' : h.address)}</b>
        <span className="dim" style={{ flex: 1 }}>{hubStatusText(h)}{h.id === 'local' && h.hidden ? ' · not seen yet' : ''}</span>
        {h.queued > 0 && <span>{h.queued} queued</span>}
        {h.id !== 'local' && <>
          <label className="checkline"><input type="checkbox" checked={h.enabled} disabled={busy}
            onChange={e => { void apply({ net_hubs: settings.map(x => x.id === h.id ? { ...x, enabled: e.target.checked } : x) }, 'Connection updated') }} />on</label>
          <button title="Remove connection" disabled={busy} onClick={() => remove(h)}><CloseIcon fontSize="inherit" /></button>
        </>}
      </div>
      <div className="dim mono-sm">{h.address}</div>
      {(h.stuck ?? 0) > 0 && <p className="oi-stuck" title={h.stuck_err}>⚠ {h.stuck} failing — {h.stuck_err}</p>}
      {h.roster?.length ? <ul className="connection-peers">{h.roster.map(p => <li key={p.slug}>
        <b>{p.org_name || p.slug.split('.')[0]}</b>{p.kind === 'chat' && <span className="dim"> (chat)</span>}
        {' '}<span className="mono-sm">{p.slug}</span> · {p.online ? 'Online' : 'Offline'}
        {p.blurb && <span className="dim"> · {p.blurb}</span>}
      </li>)}</ul> : h.connected ? <p className="dim">No other organizations on this hub yet.</p> : null}
    </section>)}
    <AddHub slug={tree.slug} address={adding} setAddress={setAdding} toast={toast}
      current={settings} busy={busy} apply={apply} />
    <p className="dim">Connection changes apply immediately; hub names are discovered on connect.</p>
  </>
}

/** Add a hub by address — with a TEST that never gates. The daemon retries
 *  forever, so an unreachable hub is still addable (mail queues until it
 *  answers); the test exists so a typo is caught while the field is still
 *  on screen, and its failure names the stage that failed. */
export function AddHub({ slug: _slug, address, setAddress, toast, current, busy, apply }: {
  slug: string; address: string; setAddress: (address: string) => void; toast: ToastFn
  current: { id: string; address: string; enabled: boolean }[]
  busy: boolean
  apply: (patch: { net_hubs: { address: string; enabled: boolean }[] }, note: string) => Promise<boolean>
}) {
  const [probing, setProbing] = useState(false)
  const [probe, setProbe] = useState('')
  const test = async () => {
    setProbing(true); setProbe('')
    try {
      const r = await probeHub(address.trim())
      setProbe(r.ok ? `Reachable — ${r.name || 'unnamed hub'} answered.`
        : 'Not answering right now. You can still add it: mail queues and delivery starts when it comes up.')
    } catch (e) {
      setProbe(`The test itself failed (${(e as Error).message}) — the address was not changed.`)
    } finally { setProbing(false) }
  }
  return <section className="connection-setup connect-hub">
    <h4>Add a mail hub</h4>
    <p className="dim">A bare host works — http and the standard port 7370 are assumed. A tunneled hub keeps its https address.</p>
    <form onSubmit={async e => {
      e.preventDefault()
      const trimmed = address.trim()
      if (!trimmed) return
      if (await apply({ net_hubs: [...current, { address: trimmed, enabled: true }] }, 'Hub added — connecting')) {
        setAddress(''); setProbe('')
      }
    }}>
      <div className="row" style={{ alignItems: 'center' }}>
        <label style={{ flex: 1 }}>Hub address<input required value={address} onChange={e => { setAddress(e.target.value); setProbe('') }}
          placeholder="http://host:7370 or https://hub.example" /></label>
        <button type="button" disabled={probing || !address.trim()} onClick={() => { void test() }}>{probing ? 'Testing…' : 'Test'}</button>
        <button type="submit" disabled={busy || !address.trim()}>Add</button>
      </div>
      {probe && <p role="status" className="dim">{probe}</p>}
    </form>
  </section>
}
