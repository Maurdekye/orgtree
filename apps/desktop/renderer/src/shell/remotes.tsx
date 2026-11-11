// shell/remotes.tsx — what the desktop shows about remote engines
// (docs/rust-engine/remote-org.md): the Add dialog, a list group's heading,
// the organization window's chip, banner and Connection details.
//
// Everything here reuses a sibling's piece: the provider dialogs' frame and
// rows (the language model server form), the status strip's chip, the shared
// confirmation and context menu. One glyph, RemoteIcon, marks whatever is on a
// remote engine.
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { ConfirmModal } from '../canvas/modals'
import { ProviderDialog } from '../canvas/providerdialog'
import { SetRow } from '../canvas/settingskit'
import { useContextMenu } from '../canvas/contextmenu'
import { ageTitle } from '../canvas/listage'
import { RemoteIcon } from '../icons'
import { addRemote, patchRemote, remoteBanner, remoteOfOrg, removeRemote, retryRemote, stateWord, transportLabel, useRemotes,
  type RemoteView } from '../remotes'

const clock = (iso: string): string => {
  const at = new Date(iso)
  return Number.isNaN(at.getTime()) ? iso : at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}
const message = (e: unknown): string => e instanceof Error ? e.message : String(e)

/** Add a remote engine, or (with `replace`) give a connection a new token.
 *  The engine checks everything before it saves; a refusal's sentence is shown
 *  under the fields, which keep what was typed. */
export function RemoteEngineDialog({ close, replace }: { close: () => void; replace?: RemoteView }) {
  const [url, setUrl] = useState('')
  const [token, setToken] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ready = !!token.trim() && (!!replace || !!url.trim())
  const submit = async () => {
    if (busy || !ready) return
    setBusy(true)
    setError(null)
    try {
      if (replace) await patchRemote(replace.id, { token: token.trim() })
      else await addRemote(url.trim(), token.trim(), name)
      close()
    } catch (e) { setError(message(e)); setBusy(false) }
  }
  const onEnter = (e: KeyboardEvent) => { if (e.key === 'Enter') { e.preventDefault(); void submit() } }
  return (
    <ProviderDialog title={replace ? `Replace the token of ${replace.name}` : 'Add a remote engine'} busy={busy} close={close}>
      <div className="ls-add remote-add" role="group" aria-label={replace ? 'Replace a remote engine token' : 'Add a remote engine'}>
        {!replace && <SetRow label="Address" hint="Where the standalone engine listens, as this computer reaches it.">
          <input data-streamer-field="ip" type="text" aria-label="Engine address" spellCheck={false} value={url}
            placeholder="http://100.x.y.z:7430" disabled={busy} onKeyDown={onEnter}
            onChange={(e) => setUrl(e.target.value)} />
        </SetRow>}
        <SetRow label="Token"
          hint="Paste the engine's startup token or a client token. Orgtree makes its own token on that engine and keeps only that.">
          <input data-streamer-field="secret" type="password" aria-label="Engine token" autoComplete="off" spellCheck={false}
            value={token} disabled={busy} onKeyDown={onEnter} onChange={(e) => setToken(e.target.value)} />
        </SetRow>
        {!replace && <SetRow label="Name" hint="How this engine is named in the list (optional).">
          <input type="text" aria-label="Engine name" value={name} disabled={busy} onKeyDown={onEnter}
            onChange={(e) => setName(e.target.value)} />
        </SetRow>}
        {busy && <p className="dim remote-add-status" role="status">Connecting...</p>}
        {error && <p className="ask-warn remote-add-error" role="alert">{error}</p>}
        <div className="ls-actions">
          <button type="button" className="acct-secondary-btn" disabled={busy || !ready}
            onClick={() => { void submit() }}>Connect</button>
          <button type="button" className="acct-secondary-btn" disabled={busy} onClick={close}>Cancel</button>
        </div>
      </div>
    </ProviderDialog>
  )
}

/** The button under an organization list that opens the Add dialog. */
export function AddRemoteEngine() {
  const [open, setOpen] = useState(false)
  return <>
    <button type="button" className="org-remote-add dim" onClick={() => setOpen(true)}>
      <RemoteIcon fontSize="inherit" /> Add a remote engine...
    </button>
    {open && <RemoteEngineDialog close={() => setOpen(false)} />}
  </>
}

/** What can be done with a connection, wherever it is named: the details'
 *  buttons, a list heading's menu and the banner's action all come here. */
export function useRemoteActions(remote: RemoteView | null) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dialog, setDialog] = useState<'details' | 'token' | 'remove' | null>(null)
  const run = async (what: () => Promise<unknown>) => {
    if (busy) return
    setBusy(true)
    setError(null)
    try { await what() } catch (e) { setError(message(e)) } finally { setBusy(false) }
  }
  const id = remote?.id ?? ''
  const actions = {
    busy, error,
    retry: () => { void run(() => retryRemote(id)) },
    connect: () => { void run(() => patchRemote(id, { enabled: true })) },
    disconnect: () => { void run(() => patchRemote(id, { enabled: false })) },
    rename: (name: string) => { void run(() => patchRemote(id, { name })) },
    details: () => setDialog('details'),
    token: () => setDialog('token'),
    remove: () => setDialog('remove'),
  }
  const node = remote && <>
    {dialog === 'details' && <RemoteDetails remote={remote} actions={actions} close={() => setDialog(null)} />}
    {dialog === 'token' && <RemoteEngineDialog replace={remote} close={() => setDialog(null)} />}
    {dialog === 'remove' && <ConfirmModal title={`Remove ${remote.name}?`}
      body={<p>Its organizations leave this list. Nothing on that engine is deleted.</p>}
      confirmLabel="Remove" close={() => setDialog(null)}
      onConfirm={() => { setDialog(null); void run(() => removeRemote(id)) }} />}
  </>
  return { actions, node }
}
type RemoteActions = ReturnType<typeof useRemoteActions>['actions']

/** A remote engine's heading in an organization list: its mark and name, and
 *  the state word when it is not connected. Its menu holds the connection's
 *  actions. */
export function RemoteGroupHead({ remote }: { remote: RemoteView }) {
  const menu = useContextMenu()
  const { actions, node } = useRemoteActions(remote)
  const word = stateWord(remote.state)
  const entries = () => [
    { label: 'Connection details', onSelect: actions.details },
    remote.state === 'paused' ? { label: 'Connect', onSelect: actions.connect }
      : remote.state === 'connected' ? { label: 'Disconnect', onSelect: actions.disconnect }
        : { label: 'Retry now', onSelect: actions.retry },
    ...(remote.state !== 'paused' && remote.state !== 'connected' ? [{ label: 'Disconnect', onSelect: actions.disconnect }] : []),
    'sep' as const,
    { label: 'Remove...', onSelect: actions.remove },
  ]
  return <>
    {menu.node}
    {node}
    <div className={'org-remote-head' + (word ? ' off' : '')} role="button" tabIndex={0}
      title={`Remote engine ${remote.name} · ${remote.url}` + (word ? ` · ${word}` : '') + ' — click for connection details'}
      onClick={actions.details}
      onKeyDown={(e) => { if (e.key === 'Enter') actions.details() }}
      onContextMenu={(e) => menu.open(e, entries())}>
      <RemoteIcon fontSize="inherit" />
      <span className="org-remote-head-name">{remote.name}</span>
      {word && <span className="org-remote-head-state">{word}</span>}
      {actions.error && <span className="ask-warn" role="alert">{actions.error}</span>}
    </div>
  </>
}

/** Connection details: what the connection is, where it stands, and its
 *  actions. Opened from the window's chip and from a list heading. */
export function RemoteDetails({ remote, actions, close }: { remote: RemoteView; actions: RemoteActions; close: () => void }) {
  const [name, setName] = useState(remote.name)
  useEffect(() => { setName(remote.name) }, [remote.name])
  const word = stateWord(remote.state)
  const live = remote.orgs.filter((o) => !o.gone)
  return (
    <ProviderDialog title={`Connection details: ${remote.name}`} busy={actions.busy} close={close}>
      <div className="ls-add remote-details" role="group" aria-label="Remote engine connection">
        <SetRow label="Name">
          <input type="text" aria-label="Engine name" value={name} disabled={actions.busy}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => { if (name.trim() && name.trim() !== remote.name) actions.rename(name.trim()) }} />
        </SetRow>
        <SetRow label="Address"><span className="chip mono" data-streamer-field="ip">{remote.url}</span></SetRow>
        <SetRow label="State">
          <span className={'chip' + (remote.state === 'connected' ? ' ok' : ' bad')} title={ageTitle(remote.since)}>
            {word ?? 'connected'} since {clock(remote.since)}</span>
        </SetRow>
        <SetRow label="Transport"><span>{transportLabel(remote.state === 'connected' ? remote.transport : null)}</span></SetRow>
        <SetRow label="Remote engine version"
          hint={remote.version_differs
            ? `This app is ${remote.app_version}; some things may not work until both run the same version.` : undefined}>
          <span>{remote.version ?? 'unknown'}</span>
        </SetRow>
        <SetRow label="Signed in as"
          hint={remote.own_token ? 'Full control. This computer has its own token there, which can be revoked alone.'
            : 'Full control, with the token you pasted (that engine could not make one for this computer).'}>
          <span>{remote.client_name ?? 'the pasted token'}</span>
        </SetRow>
        {remote.last_error && <SetRow label="Last error"><span className="ask-warn" role="status">{remote.last_error}</span></SetRow>}
        <SetRow label="Organizations">
          <span>{live.length ? live.map((o) => o.name).join(', ') : 'none yet'}</span>
        </SetRow>
        {actions.error && <p className="ask-warn" role="alert">{actions.error}</p>}
        <div className="ls-actions">
          {remote.state === 'paused'
            ? <button type="button" className="acct-secondary-btn" disabled={actions.busy} onClick={actions.connect}>Connect</button>
            : <>
              <button type="button" className="acct-secondary-btn" disabled={actions.busy || remote.state === 'connected'}
                onClick={actions.retry}>Retry now</button>
              <button type="button" className="acct-secondary-btn" disabled={actions.busy} onClick={actions.disconnect}>Disconnect</button>
            </>}
          <button type="button" className="acct-secondary-btn" disabled={actions.busy} onClick={() => { close(); actions.token() }}>Replace token...</button>
          <button type="button" className="acct-secondary-btn" disabled={actions.busy} onClick={() => { close(); actions.remove() }}>Remove...</button>
          <button type="button" className="acct-secondary-btn" disabled={actions.busy} onClick={close}>Close</button>
        </div>
      </div>
    </ProviderDialog>
  )
}

/** The status strip's first chip in a remote organization's window: the
 *  connection, and a click to its details. Nothing for a local organization. */
export function RemoteChip({ slug }: { slug: string }) {
  const remote = remoteOfOrg(useRemotes(), slug)
  const { actions, node } = useRemoteActions(remote)
  if (!remote) return null
  const word = stateWord(remote.state)
  const tone = remote.state === 'connected' ? (remote.version_differs ? ' warn' : ' ok') : ' bad'
  const title = `Remote engine ${remote.name} · ${remote.url} · `
    + (remote.state === 'connected' ? `connected since ${clock(remote.since)}` : `${word} since ${clock(remote.since)}`)
    + (remote.state === 'connected' && remote.version_differs ? ` · runs Orgtree ${remote.version}, this app is ${remote.app_version}` : '')
    + ' — click for connection details'
  return <>
    {node}
    <span role="button" tabIndex={0} className={'chip remote-chip' + tone} style={{ cursor: 'pointer' }} title={title}
      onClick={actions.details}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); actions.details() } }}>
      <RemoteIcon fontSize="inherit" /> <span data-streamer-field="external">{remote.name}</span>{word ? `: ${word}` : ''}
    </span>
  </>
}

/** The strip across the top of a remote organization's window while its
 *  engine is not connected: what is the matter, and the one thing to do.
 *  For ten seconds after a reconnect it says so. */
export function RemoteBanner({ slug }: { slug: string }) {
  const remote = remoteOfOrg(useRemotes(), slug)
  const { actions, node } = useRemoteActions(remote)
  const [now, setNow] = useState(() => Date.now())
  const [back, setBack] = useState(false)
  const state = remote?.state
  // the countdown ticks only while there is one to show
  useEffect(() => {
    if (state !== 'offline') return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [state])
  // "Reconnected" follows a state that was not connected, never the first sight of the window
  const previous = useRef(state)
  useEffect(() => {
    const was = previous.current
    previous.current = state
    if (state !== 'connected' || was === undefined || was === 'connected') return
    setBack(true)
    const timer = setTimeout(() => setBack(false), 10000)
    return () => clearTimeout(timer)
  }, [state])
  if (!remote) return null
  const banner = remoteBanner(remote, now, clock)
  if (!banner) return back ? <div className="remote-banner ok" role="status">Reconnected to {remote.name}.</div> : null
  const act = banner.action === 'retry' ? actions.retry : banner.action === 'token' ? actions.token
    : banner.action === 'details' ? actions.details : banner.action === 'connect' ? actions.connect : null
  return <>
    {node}
    <div className={'remote-banner' + (remote.state === 'connecting' ? ' quiet' : '')} role="status" title={ageTitle(remote.since)}>
      <RemoteIcon fontSize="inherit" />
      <span className="remote-banner-text">{banner.text}</span>
      {act && <button type="button" className="acct-secondary-btn" disabled={actions.busy} onClick={act}>{banner.label}</button>}
      {actions.error && <span className="ask-warn" role="alert">{actions.error}</span>}
    </div>
  </>
}

/** Is this organization's remote engine away? The shell dims the canvas then:
 *  what it shows is the last known state, not a live one. */
export function useRemoteAway(slug: string | null): boolean {
  const remote = remoteOfOrg(useRemotes(), slug)
  return !!remote && remote.state !== 'connected'
}
