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
import { SetBlock, SetGroup, SetRow, SetToggle } from './settingskit'
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
  h.connected ? `Connected · ${hubVersionText(h)}`
    : !h.enabled ? 'Disabled'
      : h.error ? `Retrying — ${h.error}` : 'Connecting…'

/** The version a connected hub reports (user request 2026-10-08); a hub that
 *  reports none (mail hub v1) reads as unknown. */
export const hubVersionText = (h: NetHub): string => `hub version ${h.version || 'unknown'}`

/** A roster entry's client kind, when it is not an organization. */
export const peerKindText = (kind?: string): string =>
  kind === 'chat' ? ' (chat)' : kind === 'person' ? ' (person)' : ''

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
    <SetGroup title="This organization's address">
      <SetRow label={<span className="mono-sm">{address || 'Not connected'}</span>}
        hint="Peers on any hub reach this organization at this address. It never changes.">
        {address && <button type="button" onClick={() => copy(address, 'Organization address copied')}>Copy address</button>}
      </SetRow>
      <SetRow label={secret ? <span className="mono-sm">{secret}</span> : 'Secret'}
        hint="The secret IS the address's ownership — losing it loses the address; nobody can restore it. It never reaches an agent. Keep a copy somewhere safe if this organization's address matters to you.">
        {!secret && <button type="button" disabled={!address} onClick={() => {
          getOrgNet(tree.slug)
            .then(r => setSecret(r.identity?.secret || '(none)'))
            .catch(e => toast([`error: ${(e as Error).message}`]))
        }}>Reveal secret…</button>}
        {secret && <>
          <button type="button" onClick={() => copy(secret, 'Secret copied')}>Copy</button>
          <button type="button" onClick={() => setSecret('')}>Hide</button>
        </>}
      </SetRow>
    </SetGroup>
    <SetGroup title="This computer's mail hub">
      <SetToggle label="connect to this computer's mail hub" disabled={busy}
        checked={hubs.some(h => h.id === 'local')}
        onChange={next => { void apply({ net_autoconnect: next }, next ? "Connected to this computer's mail hub" : "Disconnected from this computer's mail hub") }}
        hint="Being connected means peers can mail this organization (and thereby start its agents). Read and send correspondence in Mail." />
    </SetGroup>
    <SetGroup title="This organization's connections">
      {!hubs.length && <SetBlock hint="No connections configured." />}
      {hubs.map(h => <section key={h.id} className="connection-row">
        <SetRow label={<><span className={'oi-dot' + (h.connected ? ' ok' : '')} />{' '}
          <b>{h.name || (h.id === 'local' ? 'This computer' : h.address)}</b></>}
          hint={<>{hubStatusText(h)}{h.id === 'local' && h.hidden ? ' · not seen yet' : ''}
            {h.id !== 'local' && <> · <span className="mono-sm">{h.address}</span></>}</>}>
          {h.queued > 0 && <span>{h.queued} queued</span>}
          {h.id !== 'local' && <button title="Remove connection" disabled={busy} onClick={() => remove(h)}><CloseIcon fontSize="inherit" /></button>}
        </SetRow>
        {h.id !== 'local' && <SetToggle label="connection enabled" checked={h.enabled} disabled={busy}
          hint="Connect to this hub to send and receive mail."
          onChange={next => { void apply({ net_hubs: settings.map(x => x.id === h.id ? { ...x, enabled: next } : x) }, 'Connection updated') }} />}
        {(h.stuck ?? 0) > 0 && <SetBlock><p className="oi-stuck" title={h.stuck_err}>⚠ {h.stuck} failing — {h.stuck_err}</p></SetBlock>}
        {h.roster?.length ? <SetBlock><ul className="connection-peers">{h.roster.map(p => <li key={p.slug}>
          <b>{p.org_name || p.slug.split('.')[0]}</b>{peerKindText(p.kind) && <span className="dim">{peerKindText(p.kind)}</span>}
          {' '}<span className="mono-sm">{p.slug}</span> · {p.online ? 'Online' : 'Offline'}
          {p.blurb && <span className="dim"> · {p.blurb}</span>}
        </li>)}</ul></SetBlock> : h.connected ? <SetBlock hint="No other organizations on this hub yet." /> : null}
      </section>)}
    </SetGroup>
    <AddHub slug={tree.slug} address={adding} setAddress={setAdding} toast={toast}
      current={settings} busy={busy} apply={apply} />
    <p className="dim set-foot">Connection changes apply immediately; hub names are discovered on connect.</p>
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
  return <SetGroup title="Add a mail hub">
    <form className="connection-setup connect-hub" onSubmit={async e => {
      e.preventDefault()
      const trimmed = address.trim()
      if (!trimmed) return
      if (await apply({ net_hubs: [...current, { address: trimmed, enabled: true }] }, 'Hub added — connecting')) {
        setAddress(''); setProbe('')
      }
    }}>
      <SetBlock label="Hub address"
        hint="A bare host works — http and the standard port 7370 are assumed. A tunneled hub keeps its https address.">
        <div className="row" style={{ alignItems: 'center' }}>
          <input style={{ flex: 1 }} required value={address} aria-label="Hub address" onChange={e => { setAddress(e.target.value); setProbe('') }}
            placeholder="http://host:7370 or https://hub.example" />
          <button type="button" disabled={probing || !address.trim()} onClick={() => { void test() }}>{probing ? 'Testing…' : 'Test'}</button>
          <button type="submit" disabled={busy || !address.trim()}>Add</button>
        </div>
      </SetBlock>
      {probe && <SetBlock hint={<span role="status">{probe}</span>} />}
    </form>
  </SetGroup>
}
