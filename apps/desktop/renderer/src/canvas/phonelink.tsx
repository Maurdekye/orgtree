// canvas/phonelink.tsx — "Chat from your phone" (Orgtree 4.1, docket item
// orgtree-4-1-chat-from-your-phone-linking-flow-or): the card (org window and
// Home, one shared dismissal), the panel, and the App settings › Mail hub
// group. Texts are the approved mockup v2's (hubchat-linking-mockup-v2.html,
// hubchat-ux-flow.md §3a): one QR code at a time — the download code, then
// "I have Hubchat on my phone → Next" swaps in the setup code.
//
// The engine knows the state (GET /api/desktop/phone): Tailscale on this PC,
// the hub's relay-only door, the link record, the live setup code and the
// slow facts behind the warnings. The firewall rule for the door is added by
// the desktop's main process behind one UAC prompt (addPhoneFirewallRule);
// a renderer without that bridge member (a plain browser, the rig) skips it.
import { useCallback, useEffect, useRef, useState } from 'react'
import { req } from '../api'
import { desktop as desktopBridge } from '../desktop'
import { onHeldEvent } from '../events/heldbus'
import './phonelink.css'

export const SETUP_GUIDE_URL = 'https://github.com/Maurdekye/orgtree-hubchat/blob/main/docs/setup.md'
const TAILSCALE_DOWNLOAD = 'https://tailscale.com/download'
const KEY_EXPIRY_HELP = 'https://login.tailscale.com/admin/machines'
const UNATTENDED_HELP = 'https://tailscale.com/kb/1088/run-unattended'

export interface PhonePerson { address: string; name?: string | null; online?: boolean; last_seen?: string | null }
export interface PhoneState {
  download_url: string
  download_qr?: string | null
  link: { org: string; address: string; name: string; at: string; via: string } | null
  org: null | {
    slug: string; name: string; address?: string | null; on_local_hub: boolean
    persons: PhonePerson[]
    code: null | { code: string; expires_at: string; url: string; qr?: string | null; waiting: boolean }
  }
  tailscale: { state: 'T0' | 'T1' | 'T2'; backend?: string; account?: string; pc?: string; ipv4?: string; key_expiry?: string; error?: string }
  access: { state: 'A0' | 'A1' | 'A2'; scope: 'tailnet' | 'lan' | 'all'; port: number; door?: string | null; door_waiting?: boolean
    firewall?: string | null; firewall_wanted?: string }
  hub: { running: boolean; healthy: boolean; error?: string | null }
  keep_awake: boolean
  card: { show: boolean; dismissed: boolean; org: string | null }
  warnings: { sleep_minutes?: number | null; key_expiry?: string | null; unattended?: boolean | null }
  hubchat_pc: boolean
}

const CHANGED_EVENT = 'orgtree:phone-changed'
const route = (org: string | null) => '/api/desktop/phone' + (org ? `?org=${encodeURIComponent(org)}` : '')
const post = <T,>(path: string, body: unknown = {}) =>
  req<T>(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
const openExternal = (url: string) => { window.open(url, '_blank', 'noopener') }
/** A phone read whose answer lacks the named objects (an older engine, an
 *  error page) throws: the caller treats it as "nothing to show", never as a
 *  state to render. */
async function readPhone<T>(path: string, keys: string[]): Promise<T> {
  const v = await req<T>(path) as unknown as Record<string, unknown> | null
  if (!v || typeof v !== 'object' || keys.some(k => !v[k] || typeof v[k] !== 'object')) throw Error('Phone linking is not available from this engine.')
  return v as unknown as T
}

/** The panel's state, read now and then every `everyMs` while `active`. */
export function usePhoneState(org: string | null, active = true, everyMs = 3000) {
  const [state, setState] = useState<PhoneState | null>(null)
  const [error, setError] = useState('')
  const load = useCallback(async () => {
    try { setState(await readPhone<PhoneState>(route(org), ['card', 'access'])); setError('') } catch (e) { setError((e as Error).message) }
  }, [org])
  useEffect(() => {
    if (!active) return
    let alive = true
    void load()
    const t = setInterval(() => { if (alive) void load() }, everyMs)
    // the panel says when a phone was linked or unlinked: the cards react now,
    // not at their next slow read
    const on = () => { if (alive) void load() }
    window.addEventListener(CHANGED_EVENT, on)
    return () => { alive = false; clearInterval(t); window.removeEventListener(CHANGED_EVENT, on) }
  }, [active, everyMs, load])
  return { state, setState, error, reload: load }
}

/** Phone access was turned off: remove the door's firewall rule if there is
 *  one (one administrator prompt). Returns a note for the user, or ''. */
export async function removePhoneRuleAfterOff(): Promise<string> {
  const bridge = desktopBridge()
  if (!bridge?.removePhoneFirewallRule) return ''
  try {
    const s = await readPhone<PhoneState>(route(null), ['card', 'access'])
    if (!s.access.firewall) return ''
    const r = await bridge.removePhoneFirewallRule()
    return r.ok ? 'The firewall rule for phone access was removed.'
      : r.declined ? 'The firewall rule for phone access stays (nothing listens on its port now).' : r.error
  } catch { return '' }
}

// ------------------------------------------------------------ opening the panel

const OPEN_EVENT = 'orgtree:phone-panel'
/** Open the panel for `org` (the org that will trust the phone, D3) from anywhere. */
export function openPhonePanel(org: string | null) {
  window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: { org } }))
}

/** Mounted once per window: shows the panel when something opens it. */
export function PhonePanelHost({ defaultOrg }: { defaultOrg: string | null }) {
  const [open, setOpen] = useState<{ org: string | null } | null>(null)
  useEffect(() => {
    const on = (e: Event) => setOpen({ org: (e as CustomEvent<{ org: string | null }>).detail?.org ?? defaultOrg })
    window.addEventListener(OPEN_EVENT, on)
    // the tray's "Connect your phone…" (held by main until a window takes it)
    const stop = onHeldEvent('phone-panel', () => setOpen({ org: defaultOrg }))
    return () => { window.removeEventListener(OPEN_EVENT, on); stop?.() }
  }, [defaultOrg])
  if (!open) return null
  return <PhonePanel org={open.org} onClose={() => { setOpen(null); window.dispatchEvent(new Event(CHANGED_EVENT)) }} />
}

function Qr({ svg, caption, big }: { svg?: string | null; caption: string; big?: boolean }) {
  return <div className={'phone-qr' + (big ? ' big' : '')}>
    {svg ? <div className="phone-qrbox" role="img" aria-label={caption} dangerouslySetInnerHTML={{ __html: svg }} />
      : <div className="phone-qrbox empty" aria-label={caption}>…</div>}
    <div className="phone-qrcap">{caption}</div>
  </div>
}

// ------------------------------------------------------------ the card

type CardState = {
  card: PhoneState['card'] & { linked?: boolean }
  link: PhoneState['link']
  download_url: string
  download_qr?: string | null
}

/** The cards' cheap read (no Tailscale, firewall or roster reads): every
 *  `everyMs` while the card could still show, never once it is dismissed or
 *  a phone is linked; the panel's change event re-reads at once. */
export function usePhoneCard(org: string | null, everyMs = 60000) {
  const [state, setState] = useState<CardState | null>(null)
  const load = useCallback(async () => {
    try { setState(await readPhone<CardState>('/api/desktop/phone/card' + (org ? `?org=${encodeURIComponent(org)}` : ''), ['card'])) } catch { /* the card keeps what it had */ }
  }, [org])
  const quiet = !!state && (state.card.dismissed || !!state.link)
  useEffect(() => {
    let alive = true
    const on = () => { if (alive) void load() }
    on()
    window.addEventListener(CHANGED_EVENT, on)
    const t = quiet || !everyMs ? undefined : setInterval(on, everyMs)
    return () => { alive = false; window.removeEventListener(CHANGED_EVENT, on); if (t) clearInterval(t) }
  }, [load, quiet, everyMs])
  return { state, setState }
}

/** The "Chat from your phone" card: the org window's (at the end of the
 *  first-use guide) and Home's. One dismissal hides both. */
export function PhoneCard({ org, where }: { org: string | null; where: 'org' | 'home' }) {
  const { state, setState } = usePhoneCard(org)
  const [hidden, setHidden] = useState(false)
  if (hidden) return <div className="phone-card-note" role="status">Hidden. It’s always in App settings › Mail hub.</div>
  if (!state?.card.show) return null
  // the org window's canvas captures every pointerdown for panning, which
  // would swallow the click on these buttons
  return <section className={'phone-card in-' + where} aria-label="Chat from your phone" onPointerDown={e => e.stopPropagation()}>
    <button type="button" className="phone-x" aria-label="Dismiss" title="Dismiss" onClick={async () => {
      try { setState(await post<CardState>('/api/desktop/phone/dismiss')) } catch { /* the card stays */ return }
      // the other window's card hides too
      window.dispatchEvent(new Event(CHANGED_EVENT))
      setHidden(true)
      setTimeout(() => setHidden(false), 6000)
    }}>✕</button>
    <div className="phone-card-l">
      <div className="phone-card-t">Chat from your phone</div>
      <p>Message your agents from your Android phone, wherever you are, with the free Hubchat app.</p>
      <div className="phone-acts">
        <button type="button" className="primary" onClick={() => openPhonePanel(state.card.org ?? org)}>Connect your phone</button>
        <button type="button" className="linkish" onClick={() => openExternal(SETUP_GUIDE_URL)}>Setup guide ↗</button>
      </div>
    </div>
    <Qr svg={state.download_qr} caption="Scan to get Hubchat for Android" />
  </section>
}

// ------------------------------------------------------------ App settings › Mail hub

/** App settings › Mail hub › Chat from your phone (always shown). */
export function PhoneSettingsGroup({ org }: { org: string | null; active?: boolean }) {
  // read when shown and when the panel links or unlinks: no polling
  const { state } = usePhoneCard(null, 0)
  const target = org ?? state?.card.org ?? state?.link?.org ?? null
  return <section className="phone-settings" aria-label="Chat from your phone">
    <div className="phone-settings-head">Chat from your phone</div>
    {state?.link
      ? <div className="phone-settings-row"><span>Linked: <b>{state.link.name}</b> · <span className="mono-sm">{state.link.address}</span></span>
        <button type="button" onClick={() => openPhonePanel(state.link!.org)}>Manage</button></div>
      : <div className="phone-settings-row"><span>Not set up.</span>
        <button type="button" className="primary" onClick={() => openPhonePanel(target)}>Connect your phone</button></div>}
  </section>
}

// ------------------------------------------------------------ the panel

const fmtDay = (iso?: string | null) => {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

function Ok({ children }: { children: React.ReactNode }) {
  return <div className="phone-done"><span className="phone-tick" aria-hidden="true">✓</span><div>{children}</div></div>
}

export function PhonePanel({ org: opened, onClose }: { org: string | null; onClose: () => void }) {
  // opened from Home or the tray: the org the card would link, else the
  // linked one, else the first organization
  const [org, setOrg] = useState<string | null>(opened)
  useEffect(() => {
    if (org) return
    let alive = true
    void (async () => {
      try {
        const s = await readPhone<PhoneState>(route(null), ['card', 'access'])
        let pick = s.card.org ?? s.link?.org ?? null
        if (!pick) pick = (await req<{ slug: string }[] | { orgs: { slug: string }[] }>('/api/orgs').then(v => Array.isArray(v) ? v : v.orgs))[0]?.slug ?? null
        if (alive && pick) setOrg(pick)
      } catch { /* the panel shows what it has */ }
    })()
    return () => { alive = false }
  }, [org])
  const { state, setState, error, reload } = usePhoneState(org)
  const [wifiChosen, setWifiChosen] = useState(false)
  const [phoneStep, setPhoneStep] = useState<'download' | 'setup'>('download')
  const [justLinked, setJustLinked] = useState(false)
  const [notYou, setNotYou] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const [bootEngine, setBootEngine] = useState(false)
  const minting = useRef(false)
  const wasLinked = useRef<boolean | null>(null)

  useEffect(() => {
    const bridge = desktopBridge()
    bridge?.getRunAsAdministrator?.().then(s => setBootEngine(!!s.available)).catch(() => {})
  }, [])
  // a link that appears while the panel is open is the moment to say so
  useEffect(() => {
    if (!state) return
    const linked = !!state.link
    if (wasLinked.current === false && linked) setJustLinked(true)
    if (wasLinked.current !== null && wasLinked.current !== linked) window.dispatchEvent(new Event(CHANGED_EVENT))
    wasLinked.current = linked
  }, [state])

  const ts = state?.tailscale
  const access = state?.access
  const wifi = wifiChosen || access?.scope === 'lan'
  const step1done = wifi || ts?.state === 'T2'
  const pcReady = !!state && step1done && access?.state !== 'A0' && !!access?.door
  const code = state?.org?.code ?? null

  // the setup code is minted when it is first shown, and again when it ran out
  useEffect(() => {
    if (!state || !org || state.link || phoneStep !== 'setup' || !pcReady || code || minting.current) return
    minting.current = true
    void (async () => {
      try { await post('/api/desktop/phone/code', { org }); await reload() }
      catch (e) {
        const msg = (e as Error).message
        // the org is not on this computer's hub: the panel turns its switch on
        if (/isn't connected to this computer's mail hub/.test(msg)) {
          await post(`/api/orgs/${encodeURIComponent(org)}/settings`, { net_autoconnect: true }).catch(() => {})
          setNote('Connecting this organization to this computer’s mail hub…')
        } else setNote(msg)
      } finally { setTimeout(() => { minting.current = false }, 2000) }
    })()
  }, [state, org, phoneStep, pcReady, code, reload])

  const act = async (f: () => Promise<void>) => {
    setBusy(true); setNote('')
    try { await f() } catch (e) { setNote((e as Error).message) } finally { setBusy(false) }
  }
  const turnOn = (scope: 'tailnet' | 'lan') => act(async () => {
    const bridge = desktopBridge()
    if (bridge?.addPhoneFirewallRule) {
      const r = await bridge.addPhoneFirewallRule(scope)
      if (!r.ok) { setNote(r.error); return }
    }
    setState(await post<PhoneState>('/api/desktop/phone/access', { scope, keep_awake: state?.keep_awake ?? true }))
    await reload()
  })
  const setKeepAwake = (k: boolean) => act(async () => { setState(await post<PhoneState>('/api/desktop/phone/settings', { keep_awake: k })); await reload() })
  const unlink = () => act(async () => { await post('/api/desktop/phone/unlink'); setJustLinked(false); setNotYou([]); await reload() })
  const isMe = (address: string) => act(async () => { await post('/api/desktop/phone/link', { org, address }); await reload() })
  const newCode = () => act(async () => { await post('/api/desktop/phone/code', { org }); await reload() })
  const signIn = () => act(async () => { const r = await post<{ url: string }>('/api/desktop/phone/tailscale-login'); openExternal(r.url) })

  const orgName = state?.org?.name ?? org ?? 'This organization'
  const lead = wifi
    ? 'Message your agents from Hubchat on your Android phone. Your phone reaches this PC over your home Wi-Fi.'
    : 'Message your agents from Hubchat on your Android phone, from anywhere. Your phone reaches this PC through Tailscale, a free private network.'

  // ---- left: this PC
  const left: React.ReactNode[] = []
  if (state && ts && access) {
    if (wifi) left.push(<Ok key="t">Using your home Wi-Fi instead of Tailscale.{' '}
      {access.scope !== 'lan' && <button type="button" className="linkish" onClick={() => setWifiChosen(false)}>Use Tailscale instead</button>}</Ok>)
    else if (ts.state === 'T2') left.push(<Ok key="t">This PC is <b>{ts.pc}</b> on <b>{ts.account}</b>’s Tailscale network.</Ok>)
    else if (ts.state === 'T1') left.push(<div key="t" className="phone-step"><div className="phone-n">1 · Tailscale</div>
      <p><b>Sign in to Tailscale on this PC.</b> Use an account you can also use on your phone.</p>
      <div className="phone-acts"><button type="button" className="primary" disabled={busy} onClick={signIn}>Sign in</button></div></div>)
    else left.push(<div key="t" className="phone-step"><div className="phone-n">1 · Tailscale</div>
      <p><b>Install Tailscale on this PC.</b> It’s free. Sign in with Google, Microsoft, GitHub or Apple when it asks. This page updates when it’s done.</p>
      <div className="phone-acts"><button type="button" className="primary" onClick={() => openExternal(TAILSCALE_DOWNLOAD)}>Get Tailscale</button>
        <button type="button" className="linkish" onClick={() => setWifiChosen(true)}>Use my home Wi-Fi instead</button></div></div>)
    if (step1done) {
      if (access.state === 'A0') left.push(<div key="a" className="phone-step"><div className="phone-n">2 · Phone access</div>
        <p>{wifi
          ? <><b>Let your phone reach this PC.</b> Anyone on your Wi-Fi can reach the hub’s door: they can sign up and message your organizations, but can’t read anyone else’s mail. Windows asks for permission once.</>
          : <><b>Let your phone reach this PC.</b> Only devices on your Tailscale network can connect. Windows asks for permission once.</>}</p>
        <label className="phone-cbx"><input type="checkbox" checked={state.keep_awake} disabled={busy}
          onChange={e => { void setKeepAwake(e.target.checked) }} />Keep this PC awake while it’s plugged in</label>
        <div className="phone-acts"><button type="button" className="primary" disabled={busy} onClick={() => { void turnOn(wifi ? 'lan' : 'tailnet') }}>Turn on phone access</button></div></div>)
      else if (access.state === 'A2') left.push(<Ok key="a">Phone access is on, for every network this PC is on.{' '}
        <button type="button" className="linkish" disabled={busy || ts.state !== 'T2'} onClick={() => { void turnOn('tailnet') }}>Limit it to Tailscale</button></Ok>)
      else left.push(<Ok key="a">{access.scope === 'lan' ? 'Phone access is on, for your home network.' : 'Phone access is on, for your Tailscale network only.'}</Ok>)
    } else left.push(<div key="a" className="phone-done dim"><span className="phone-tick" />2 · Phone access (after step 1)</div>)
    if (step1done && access.state !== 'A0') {
      const w = state.warnings
      if (!state.keep_awake && w.sleep_minutes && state.link) left.push(<div key="ws" className="phone-warn">
        This PC goes to sleep after {w.sleep_minutes} minutes, and your phone can’t reach it then.{' '}
        <button type="button" className="linkish" onClick={() => { void setKeepAwake(true) }}>Keep awake while plugged in</button></div>)
      if (!wifi && w.key_expiry) left.push(<div key="wk" className="phone-warn">
        Tailscale will sign this PC out on {fmtDay(w.key_expiry)}.{' '}
        <button type="button" className="linkish" onClick={() => openExternal(KEY_EXPIRY_HELP)}>Turn off key expiry ↗</button></div>)
      if (!wifi && bootEngine && w.unattended === false) left.push(<div key="wu" className="phone-warn">
        Tailscale stops when you sign out of Windows.{' '}
        <button type="button" className="linkish" onClick={() => openExternal(UNATTENDED_HELP)}>Fix ↗</button></div>)
    }
  }

  // ---- right: your phone
  let right: React.ReactNode = null
  const persons = (state?.org?.persons ?? []).filter(p => !notYou.includes(p.address))
  if (state) {
    if (justLinked && state.link) right = <div className="phone-linked">✓ <b>Linked: {state.link.name}</b> ({state.link.address}). <b>{orgName}</b>’s charter now says this address is you and carries your authority.
      <div className="phone-acts"><button type="button" className="linkish" disabled={busy} onClick={unlink}>Undo</button>
        <button type="button" className="primary" onClick={onClose}>Done</button></div></div>
    else if (state.link) right = <>
      <div className="phone-linked"><b>Your phone:</b> {state.link.name} · {state.link.address} · linked {fmtDay(state.link.at)}.
        <div className="phone-acts"><button type="button" className="linkish" disabled={busy} onClick={unlink}>Unlink</button></div></div>
      <div className="phone-step"><p><b>Add another device:</b> install Tailscale and Hubchat on it, choose <b>I already use Hubchat › Scan the QR code from your other device</b> (on a PC: <b>Link through a hub</b>), and show the code from Hubchat on your phone (<b>Settings › Devices › Link a device</b>).</p></div>
    </>
    else if (!code && persons.length && state.hubchat_pc) right = <div className="phone-step">
      <p><b>You already use Hubchat on this PC.</b> Bring that identity to your phone: on the phone choose <b>I already use Hubchat › Scan the QR code from your other device</b>. Then scan the code from the <b>QR button</b> at the bottom of Hubchat’s chat list on this PC.</p>
      <div className="phone-acts"><button type="button" className="primary" disabled={busy} onClick={() => { void isMe(persons[0].address) }}>Is {persons[0].address} you? Yes</button>
        {/* a separate identity on the phone: the download and setup-code steps */}
        <button type="button" disabled={busy} onClick={() => setNotYou(n => [...n, ...persons.map(p => p.address)])}>Set up my phone with a code instead</button></div></div>
    else if (!code && persons.length) right = <div className="phone-step">
      <p><b>Is this you?</b> Hubchat <b className="mono-sm">{persons[0].address}</b> already uses this PC’s hub.</p>
      <div className="phone-acts"><button type="button" className="primary" disabled={busy} onClick={() => { void isMe(persons[0].address) }}>Yes, that’s me</button>
        <button type="button" disabled={busy} onClick={() => setNotYou(n => [...n, persons[0].address])}>No</button></div></div>
    else {
      const back = <div className="phone-back"><button type="button" className="linkish sm" onClick={() => setPhoneStep('download')}>← Back to the download code</button></div>
      right = <div className="phone-needs"><p><b>On your phone</b> (skip what you already have):</p><ol>
        {wifi ? <li>Connect to the <b>same Wi-Fi</b> as this PC.</li>
          : <li><b>Tailscale</b> from Google Play, signed in as <b>{ts?.account ?? 'the same account as this PC'}</b>.</li>}
        <li>{phoneStep === 'download' ? <>
          <div className="phone-li-row"><div><b>Hubchat:</b> scan this with the camera.</div><Qr svg={state.download_qr} caption="Scan to get Hubchat" big /></div>
          <div className="phone-next"><button type="button" className="primary" onClick={() => setPhoneStep('setup')}>I have Hubchat on my phone → Next</button></div>
        </> : !pcReady ? <><span className="dim">The setup code appears here once the steps on the left are done.</span>{back}</>
          : code?.waiting ? <div className="phone-wait" role="status"><span className="phone-spin" aria-hidden="true" />Waiting for your phone…</div>
            : <><div className="phone-li-row"><div>In Hubchat, tap <b>Scan setup code</b> and scan this.
              <div className="dim phone-small">It works once, for 10 minutes.<br />
                <button type="button" className="linkish" disabled={busy} onClick={newCode}>New code</button></div></div>
              <Qr svg={code?.qr} caption="Setup code" big /></div>{back}</>}
        </li></ol></div>
    }
  }

  return <div className="phone-scrim" role="presentation" onPointerDown={e => { e.stopPropagation(); if (e.target === e.currentTarget) onClose() }}>
    <div className="phone-panel" role="dialog" aria-modal="true" aria-label="Chat from your phone">
      <div className="phone-head">
        <div className="phone-title">Chat from your phone</div>
        <div className="phone-lead">{lead}</div>
        <button type="button" className="phone-x" aria-label="Close" onClick={onClose}>✕</button>
      </div>
      {!state && <div className="phone-body dim">{error || 'Loading…'}</div>}
      {state && <div className="phone-cols">
        <div className="phone-col"><div className="phone-col-h">This PC</div>{left}</div>
        <div className="phone-col"><div className="phone-col-h">Your phone</div>{right}</div>
      </div>}
      {note && <p className="phone-note" role="alert">{note}</p>}
      {state?.hub.error && <p className="phone-note" role="alert">The mail hub could not start: {state.hub.error}</p>}
    </div>
  </div>
}
