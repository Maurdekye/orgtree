// canvas/remoteaccess.tsx — org settings → Connections → Remote access:
// this desktop lets other computers open this organization
// (docs/rust-engine/remote-org.md, "A desktop as host").
//
// Built from the Connections tab's own group, rows and switch, the provider
// dialogs' frame and the shared confirmation. It is shown only where this
// computer can share: an organization of its own, on a desktop's own engine.
// An organization that is itself on a remote engine has no block (no chains),
// and neither has a standalone engine's page (it has client tokens for this).
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { SetBlock, SetGroup, SetRow, SetToggle } from './settingskit'
import { ConfirmModal } from './modals'
import { ProviderDialog } from './providerdialog'
import { ageTitle } from './listage'
import { RemoteIcon } from '../icons'
import { remoteOfOrg, useRemotes } from '../remotes'
import { addressAndCode, addressNote, allowDoor, changeListening, listenOf, computerSeen, computersWord, connectedChip, doorTrouble, doorWord,
  getOrgAccess, getRemoteAccess, giveComputer, makeCode, removeDoorRules, revokeComputer, stopAllAccess, switchOrgAccess,
  turnOnOrgAccess, useRemoteAccess, validPort, type CodeView, type ComputerView, type DoorView, type ListenPatch, type OrgAccessView } from '../remoteaccess'
import type { ToastFn } from '../types'

const message = (e: unknown): string => e instanceof Error ? e.message : String(e)
const time = (iso: string): string => {
  const at = new Date(iso)
  return Number.isNaN(at.getTime()) ? iso : at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}
const day = (iso: string): string => {
  const at = new Date(iso)
  return Number.isNaN(at.getTime()) ? iso : at.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' })
}

/** One computer in a list: the name others see, what it calls itself, and
 *  when it was here. Its own name is a host field, masked like an address. */
function Computer({ computer, children }: { computer: ComputerView; children: ReactNode }) {
  return <li>
    <span className="remote-computer-text">
      <span data-streamer-field="external">{computer.label}</span>
      {computer.name !== computer.label && <span className="dim"> · <span data-streamer-field="ip">{computer.name}</span></span>}
      <span className="dim" title={ageTitle(computer.created_at)}> · added {day(computer.created_at)}</span>
      <span className="dim" title={ageTitle(computer.connected ? computer.connected_since : computer.last_seen_at)}> · {computerSeen(computer, time, day)}</span>
    </span>
    {children}
  </li>
}

/** The Remote access block of one organization. Nothing where this computer
 *  cannot share it. */
export function RemoteAccess({ slug, name, toast }: { slug: string; name: string; toast: ToastFn }) {
  const overview = useRemoteAccess()
  const remote = remoteOfOrg(useRemotes(), slug)
  const shared = overview?.orgs.find((o) => o.slug === slug)
  const [view, setView] = useState<OrgAccessView | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const [adding, setAdding] = useState(false)
  const [revoking, setRevoking] = useState<ComputerView | null>(null)
  const offered = !!overview && !!shared && !remote
  // the list is read again when anything it shows moved: the switch, who has
  // the organization, who is connected, the door, the firewall
  const moved = offered ? JSON.stringify([shared?.on, shared?.computers, shared?.connected_now.map((c) => c.id),
    overview?.door.state, overview?.door.addresses.map((a) => a.url), overview?.door.firewall?.state]) : ''
  useEffect(() => {
    if (!offered) return
    let alive = true
    getOrgAccess(slug).then((v) => { if (alive) setView(v) }, () => { /* keep what is shown */ })
    return () => { alive = false }
  }, [slug, offered, moved])
  if (!overview || !shared || remote) return null
  const door = overview.door
  const on = shared.on
  const act = async (what: () => Promise<void>) => {
    if (busy) return
    setBusy(true); setNote('')
    try { await what() } catch (e) { setNote(message(e)) } finally { setBusy(false) }
  }
  const turn = (next: boolean) => act(async () => {
    if (next) {
      const result = await turnOnOrgAccess(slug)
      if ('refused' in result) { setNote(result.refused); return }
      setView(result.view)
      toast(['Computers you add can now open this organization'])
      return
    }
    // a destructive action states its scope first: people may be working through this
    if (shared.connected > 0 && !window.confirm(`Stop letting other computers open ${name}? `
      + `${shared.connected === 1 ? 'The computer that is connected loses' : `The ${shared.connected} computers that are connected lose`} it at once. `
      + 'The list of computers stays, so turning this on again lets them back in.')) return
    setView(await switchOrgAccess(slug, false))
    toast(['Other computers can no longer open this organization'])
  })
  const allow = () => act(async () => {
    const refused = await allowDoor(door)
    if (refused) { setNote(refused); return }
    setView(await getOrgAccess(slug, true))
  })
  const revoke = (computer: ComputerView) => act(async () => {
    await revokeComputer(computer.id)
    setView(await getOrgAccess(slug))
    toast([`${computer.label} was revoked`])
  })
  const copy = (value: string, said: string) => {
    navigator.clipboard.writeText(value)
      .then(() => toast([said]))
      .catch(() => toast(['error: copy is unavailable; select the text and copy it']))
  }
  const trouble = on ? doorTrouble(door) : null
  const computers = view?.computers ?? []
  return <SetGroup title="Remote access">
    <SetToggle label="Let other computers open this organization" checked={on} disabled={busy}
      onChange={(next) => { void turn(next) }}
      hint="A computer you add can use this organization as you do. Through its agents it can run commands and read or change files on this computer with your account's rights, as if it had signed in over SSH: add only computers you would trust with this whole computer." />
    {note && <SetBlock><p className="ask-warn remote-access-note" role="alert">{note}</p></SetBlock>}
    {trouble && <SetBlock><p className="ask-warn remote-access-door" role="status">{trouble}</p></SetBlock>}
    {on && door.firewall?.state === 'missing' && <SetRow label="Windows Firewall is blocking this"
      hint="Other computers cannot reach this one until Windows Firewall lets them in. Windows asks for an administrator's permission.">
      <button type="button" disabled={busy} onClick={() => { void allow() }}>Allow</button>
    </SetRow>}
    {on && door.addresses.map((address) => <SetRow key={address.url}
      label={address.kind === 'lan' ? 'Address on this private network' : 'Address'} hint={addressNote(address)}>
      <span className="chip mono" data-streamer-field="ip">{address.url}</span>
      <button type="button" onClick={() => copy(address.url, 'Address copied')}>Copy</button>
    </SetRow>)}
    {on && <SetBlock label="Computers" hint={computers.length ? undefined : 'No computer has this organization yet.'}>
      {computers.length > 0 && <ul className="remote-people remote-computers" aria-label="Computers that can open this organization">
        {computers.map((computer) => <Computer key={computer.id} computer={computer}>
          <button type="button" disabled={busy} onClick={() => setRevoking(computer)}>Revoke</button>
        </Computer>)}
      </ul>}
    </SetBlock>}
    {on && <SetRow label="Let another computer in" hint="It needs this computer's address and a one-time code.">
      <button type="button" className="primary" disabled={busy || !view} onClick={() => setAdding(true)}>Add a computer...</button>
    </SetRow>}
    {adding && view && <AddComputerDialog slug={slug} view={view} door={door} toast={toast}
      close={() => setAdding(false)} changed={setView} />}
    {revoking && <ConfirmModal title={`Revoke ${revoking.label}?`}
      body={<p>It is disconnected at once and can no longer open {revoking.orgs.length > 1
        ? `any of the ${revoking.orgs.length} organizations it has on this computer` : 'this organization'}.
        To let it back in, add it again with a new code.</p>}
      confirmLabel="Revoke" close={() => setRevoking(null)}
      onConfirm={() => { const computer = revoking; setRevoking(null); void revoke(computer) }} />}
  </SetGroup>
}

/** Add a computer: this computer's address and a one-time code for the other
 *  computer's "Add a remote engine" dialog; or, for a computer that already
 *  has another organization here, this one at once and with no code. */
export function AddComputerDialog({ slug, view, door, toast, close, changed }: {
  slug: string; view: OrgAccessView; door: DoorView; toast: ToastFn; close: () => void; changed: (view: OrgAccessView) => void
}) {
  const [code, setCode] = useState<CodeView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [known, setKnown] = useState(view.known)
  // one code for one opening of the dialog (a second mount of the same dialog asks for none)
  const asked = useRef(false)
  useEffect(() => {
    if (asked.current) return
    asked.current = true
    makeCode(slug).then(setCode, (e) => setError(message(e)))
  }, [slug])
  const url = door.addresses[0]?.url ?? ''
  const copy = (value: string, said: string) => {
    navigator.clipboard.writeText(value)
      .then(() => toast([said]))
      .catch(() => toast(['error: copy is unavailable; select the text and copy it']))
  }
  const give = async (computer: ComputerView) => {
    if (busy) return
    setBusy(true); setError(null)
    try {
      const next = await giveComputer(slug, computer.id)
      changed(next)
      setKnown(next.known)
      toast([`${computer.label} can now open this organization`])
    } catch (e) { setError(message(e)) } finally { setBusy(false) }
  }
  return (
    <ProviderDialog title="Add a computer" busy={busy} close={close}>
      <div className="ls-add remote-add" role="group" aria-label="Add a computer">
        <SetRow label="Address" hint="On the other computer: Add a remote engine, then this address.">
          {url ? <>
            <span className="chip mono" data-streamer-field="ip">{url}</span>
            <button type="button" onClick={() => copy(url, 'Address copied')}>Copy</button>
          </> : <span className="dim">{doorTrouble(door) ?? 'This computer is not listening yet.'}</span>}
        </SetRow>
        <SetRow label="One-time code" hint={`It goes into the Token field there. Valid for ${view.limits.minutes} minutes, for one computer.`}>
          {code ? <>
            <span className="chip mono" data-streamer-field="secret">{code.code}</span>
            <button type="button" onClick={() => copy(code.code, 'Code copied')}>Copy</button>
          </> : !error && <span className="dim" role="status">Making a code...</span>}
        </SetRow>
        {code && url && <SetRow label="Both in one line" hint="To send to whoever sits at the other computer.">
          <span className="chip mono" data-streamer-field="secret">{addressAndCode(url, code.code)}</span>
          <button type="button" onClick={() => copy(addressAndCode(url, code.code), 'Address and code copied')}>Copy both</button>
        </SetRow>}
        {known.length > 0 && <SetBlock label="Or a computer you already added"
          hint="It has another organization of this computer. It gets this one at once, with no code.">
          <ul className="remote-people remote-computers" aria-label="Computers you already added">
            {known.map((computer) => <Computer key={computer.id} computer={computer}>
              <button type="button" disabled={busy} onClick={() => { void give(computer) }}>Give access</button>
            </Computer>)}
          </ul>
        </SetBlock>}
        {error && <p className="ask-warn remote-add-error" role="alert">{error}</p>}
        <div className="ls-actions">
          <button type="button" className="acct-secondary-btn" disabled={busy} onClick={close}>Done</button>
        </div>
      </div>
    </ProviderDialog>
  )
}

/** App settings -> Remote access: where this computer listens for the
 *  computers it let in, the organizations they can open, and the one button
 *  that ends all of it. The switches themselves are each organization's. */
export function RemoteAccessSettings({ toast }: { toast: ToastFn }) {
  const overview = useRemoteAccess()
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const [port, setPort] = useState('')
  const current = overview?.port
  useEffect(() => { if (current !== undefined) setPort(String(current)) }, [current])
  // the owner looks: what is known of Windows Firewall is read again behind this
  const offered = !!overview
  useEffect(() => { if (offered) void getRemoteAccess().catch(() => { /* the pushed value stays */ }) }, [offered])
  if (!overview) return null
  const door = overview.door
  const shared = overview.orgs.filter((org) => org.on)
  const act = async (what: () => Promise<void>) => {
    if (busy) return
    setBusy(true); setNote('')
    try { await what() } catch (e) { setNote(message(e)) } finally { setBusy(false) }
  }
  const change = (patch: ListenPatch) => act(async () => {
    const result = await changeListening(overview, patch)
    if ('refused' in result) { setNote(result.refused); setPort(String(overview.port)); return }
    toast(['Remote access changed'])
  })
  const stop = () => act(async () => {
    const connected = shared.reduce((sum, org) => sum + org.connected, 0)
    if (!window.confirm(`Stop all remote access? Other computers can no longer open ${shared.length === 1 ? shared[0]!.name : `any of ${shared.length} organizations`}`
      + `${connected ? `, and ${connected === 1 ? 'the computer that is connected loses' : `the ${connected} computers that are connected lose`} it at once` : ''}. `
      + 'The lists of computers stay.')) return
    await stopAllAccess()
    toast(['Remote access is off for every organization'])
  })
  const allow = () => act(async () => {
    const refused = await allowDoor(door)
    if (refused) setNote(refused)
    else await getRemoteAccess(true)
  })
  const removeRules = () => act(async () => {
    const refused = await removeDoorRules()
    if (refused) { setNote(refused); return }
    await getRemoteAccess(true)
    toast(['The firewall rules for remote access were removed'])
  })
  const wanted = Number(port)
  const trouble = doorTrouble(door)
  const listen = listenOf(overview)
  return <>
    <SetGroup title="Remote access"
      subtitle={<>Other computers open the organizations you switch on, one by one, in each organization's settings under Connections.
        This is where <span data-streamer-field="ip">{overview.computer}</span> listens for them.</>}>
      <SetBlock label="Where it listens" hint="Choose one or more. Each is switched by itself." />
      <SetToggle label="Tailscale" checked={listen.tailscale} disabled={busy}
        onChange={(next) => { void change({ tailscale: next }) }}
        hint="Tailscale encrypts what travels. Both computers are signed in to the same tailnet." />
      <SetToggle label="This private network" checked={listen.lan} disabled={busy}
        onChange={(next) => { void change({ lan: next }) }}
        hint="Plain http, which is not encrypted: anyone on the network can read what travels, the token included. For a home network or a VPN you trust." />
      <SetToggle label="This computer only" checked={listen.local} disabled={busy}
        onChange={(next) => { void change({ local: next }) }}
        hint="For an SSH tunnel or a local https proxy (Caddy, cloudflared, ngrok) that hands connections on to 127.0.0.1. Nothing else can reach it, and it needs no firewall rule." />
      <SetRow label="Port" hint={`A number from 1024 to 65535. It is ${overview.default_port} unless another program has that one.`}>
        <input type="number" aria-label="Remote access port" min={1024} max={65535} value={port} disabled={busy}
          onChange={(e) => setPort(e.target.value)} />
        <button type="button" disabled={busy || !validPort(wanted) || wanted === overview.port}
          onClick={() => { void change({ port: wanted }) }}>Change</button>
      </SetRow>
      <SetRow label="Now">
        <span className={'chip' + (door.state === 'open' ? ' ok' : door.state === 'closed' ? '' : ' bad')}>{doorWord(door)}</span>
        {door.addresses.map((address) => <span key={address.url} className="chip mono" data-streamer-field="ip"
          title={addressNote(address)}>{address.url}</span>)}
      </SetRow>
      {trouble && <SetBlock><p className="ask-warn remote-access-door" role="status">{trouble}</p></SetBlock>}
      {shared.length > 0 && door.firewall?.state === 'missing' && <SetRow label="Windows Firewall is blocking this"
        hint="Other computers cannot reach this one until Windows Firewall lets them in. Windows asks for an administrator's permission.">
        <button type="button" disabled={busy} onClick={() => { void allow() }}>Allow</button>
      </SetRow>}
      {shared.length === 0 && door.firewall?.present && <SetRow label="Windows Firewall still has the rules for remote access"
        hint="Nothing listens while no organization is shared. The rules can go; they are asked for again when you turn remote access on.">
        <button type="button" disabled={busy} onClick={() => { void removeRules() }}>Remove the rules</button>
      </SetRow>}
      {note && <SetBlock><p className="ask-warn remote-access-note" role="alert">{note}</p></SetBlock>}
    </SetGroup>
    <SetGroup title="Organizations other computers can open">
      {shared.length === 0 && <SetBlock hint="None. The switch is in an organization's settings, under Connections." />}
      {shared.map((org) => <SetRow key={org.slug} label={org.name} hint="Its switch and its computers are in its settings, under Connections.">
        <span>{computersWord(org)}</span>
      </SetRow>)}
      <SetRow label="Stop all remote access" hint="Turns every organization's switch off and stops listening. The lists of computers stay.">
        <button type="button" className="danger" disabled={busy || shared.length === 0} onClick={() => { void stop() }}>Stop all remote access</button>
      </SetRow>
    </SetGroup>
  </>
}

/** The status strip's chip on the hosting desktop while other computers are
 *  connected to this organization: how many, who in the tooltip, and a click
 *  to the Remote access block. Nothing while nobody is. */
export function SharedChip({ slug, onOpen }: { slug: string; onOpen: () => void }) {
  const chip = connectedChip(useRemoteAccess()?.orgs.find((org) => org.slug === slug))
  if (!chip) return null
  return <span role="button" tabIndex={0} className="chip remote-chip shared-chip ok" style={{ cursor: 'pointer' }}
    title={`Connected to this organization from another computer: ${chip.title} — click for Remote access`}
    onClick={onOpen}
    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen() } }}>
    <RemoteIcon fontSize="inherit" /> {chip.text}
  </span>
}
