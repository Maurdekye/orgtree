// shell/createorg.tsx — the Create view: one page, one organization, its own
// window.
//
// Creating always gets a separate window, including when it was started from a
// Homepage, and that window becomes the new organization's Canvas when the
// creation succeeds. Failure changes nothing about any window: the form keeps
// everything typed and shows what went wrong, because the one thing a creation
// form must never do is lose the details somebody just entered.
//
// ⚠ WHAT THIS PAGE OWNS, AND WHAT IT DOES NOT. It owns the FORM STATE and the
// TRUTH OF THE DIRTY FLAG. It does not own the confirmation: closing a window
// with unfinished details is confirmed natively, for every close route there
// is — the title-bar button, the app quitting, the app restarting — because a
// renderer-owned dialog cannot be reached by a Quit and cannot answer while
// the renderer is busy. This page publishes `setUnsavedCreation(dirty)` and
// clears it in exactly two places, both terminal for the form: a successful
// creation, and a confirmed discard. Cancelling the confirmation clears
// nothing and preserves everything.
//
// ⚠ AND CANCEL IS A WINDOW CLOSE, NOT A FORM RESET. Routing it through
// `closeWindow()` is what makes the button get the identical confirmation the
// title-bar X does. A Cancel that quietly wiped the form would be the one
// discard path with no confirmation in front of it.
//
// NO DRAFTS ARE PERSISTED and none are restored after a crash — settled, and
// the cheapest honest behaviour: a draft restored into a window the user did
// not ask for is a worse surprise than a lost one.
import { useEffect, useRef, useState } from 'react'
import { createOrg, probeHub } from '../api'
import { DirList } from '../forms'
import { CloseIcon } from '../icons'
import { AdvancedOrgModal } from './advancedorg'
import { desktop } from '../desktop'
import { beginFirstUse } from '../canvas/firstuse'

export interface CreateOrgViewProps {
  /** what to do when the creation succeeds — bind this window to the new
   *  organization. Anything it throws is shown on the form, which is why this
   *  page keeps its state until the binding has actually happened. */
  onCreated: (slug: string) => Promise<void> | void
  /** close this window. Goes through the native close so the unfinished-form
   *  confirmation is the same one every other close route gets. */
  onRequestClose: () => void
  /** first-run setup: wrap the create so the charter documents are populated
   *  and setup is recorded before the window binds. Identity by default. */
  wrapCreate?: <T>(create: () => Promise<T>) => Promise<T>
}

/** Is there anything here worth confirming before it is thrown away?
 *
 *  Exported because it is the whole definition of "dirty" and the native side
 *  acts on it: a name, a granted folder, a remote hub address, or turning the
 *  local hub connection OFF — which is a deliberate departure from the default
 *  and is exactly as much of a decision as typing something. */
export function creationDirty(form: {
  name: string; dirs: string[]; netAuto: boolean; netHubs: string[]
}): boolean {
  return form.name.trim() !== ''
    || form.dirs.some((d) => d.trim() !== '')
    || form.netHubs.some((h) => h.trim() !== '')
    || form.netAuto === false
}

export function CreateOrgView({ onCreated, onRequestClose, wrapCreate }: CreateOrgViewProps) {
  const [name, setName] = useState('')
  const [dirs, setDirs] = useState<string[]>([])
  // F-06: local-hub auto-connect defaults ON (ruled); detection is a HINT
  // beside the box, never a gate — a hub that is down still gets configured
  const [netAuto, setNetAuto] = useState(true)
  const [netHubs, setNetHubs] = useState<string[]>([])
  const [hubSeen, setHubSeen] = useState<{ ok: boolean; name?: string | null } | null>(null)
  const [advanced, setAdvanced] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const dirty = creationDirty({ name, dirs, netAuto, netHubs })
  // publish the flag on every change, and only when it actually flips — the
  // native side stores one boolean and a write per keystroke says nothing new.
  // ⚠ SEEDED `false`, NOT `null`: a fresh creation window holds nothing, so
  // mounting one must not announce that it holds nothing. Native's flag is
  // already false and the write would be a no-op that reads like an event.
  const published = useRef(false)
  useEffect(() => {
    if (published.current === dirty) return
    published.current = dirty
    void desktop()?.setUnsavedCreation?.(dirty)?.catch?.(() => {})
  }, [dirty])
  // and the window is never left claiming unfinished input it no longer holds
  useEffect(() => () => {
    if (published.current) void desktop()?.setUnsavedCreation?.(false)?.catch?.(() => {})
  }, [])

  useEffect(() => {
    if (advanced && hubSeen == null) {
      probeHub().then(setHubSeen).catch(() => setHubSeen({ ok: false }))
    }
  }, [advanced, hubSeen])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (busy) return
    setBusy(true); setError(null)
    try {
      const make = () => createOrg(name, dirs.map((s) => s.trim()).filter(Boolean),
        netAuto, netHubs.map((s) => s.trim()).filter(Boolean))
      const made = wrapCreate ? await wrapCreate(make) : await make()
      beginFirstUse(made.slug)
      // the flag is cleared BEFORE the bind, because a successful creation is
      // terminal for this form whatever the binding then does
      published.current = false
      await desktop()?.setUnsavedCreation?.(false)?.catch?.(() => {})
      await onCreated(made.slug)
    } catch (err) {
      // ⚠ NOTHING IS RESET HERE. An actionable error and every detail still
      // in place is the settled failure behaviour; a form that clears itself
      // on a name collision makes the user retype the folders too.
      setError(err instanceof Error ? err.message : String(err))
    } finally { setBusy(false) }
  }

  return (
    <div className="shell-page shell-create">
      <form className="shell-page-inner" onSubmit={submit}>
        <div className="shell-page-eyebrow">New organization</div>
        <h1 className="shell-page-title">Create an organization</h1>
        <p className="dim shell-create-lede">
          Give your organization a name. Your app-wide defaults provide its
          starting settings.
        </p>
        <label className="field-label" htmlFor="shell-create-name">Organization name</label>
        <input id="shell-create-name" autoFocus required value={name}
          className="shell-create-name"
          onChange={(e) => setName(e.target.value)} />
        <button type="button" className="disclosure" aria-expanded={advanced}
          onClick={() => setAdvanced(true)}>
          <span aria-hidden="true">▸</span> Advanced options
          {(dirs.length > 0 || netAuto || netHubs.length > 0) && (
            <span className="dim adv-sum"> · {[
              dirs.length ? `${dirs.length} folder${dirs.length > 1 ? 's' : ''}` : '',
              netAuto || netHubs.length ? 'hub' : '',
            ].filter(Boolean).join(' · ')}</span>)}
        </button>
        {advanced && (
          <AdvancedOrgModal title={name.trim() || 'new organization'}
            close={() => setAdvanced(false)}
            tabs={[
              { label: 'General', content: (
                <>
                  <div className="field-label">also grant existing folders</div>
                  <DirList dirs={dirs} onChange={setDirs} />
                </>
              ) },
              { label: 'Mail hub', content: (
                <>
                  <label className="row kiosk-sbx"
                    title="being listed means peers can mail this org (and thereby spend its credits) — refusable here, at creation">
                    <input type="checkbox" checked={netAuto}
                      onChange={(e) => setNetAuto(e.target.checked)} />
                    connect to this computer's mail hub
                  </label>
                  <div className="dim hub-hint">
                    {hubSeen == null ? 'checking for a local hub…'
                      : hubSeen.ok ? `detected: ${hubSeen.name || 'unnamed hub'}`
                        : 'not running right now — the org will connect when it starts'}
                  </div>
                  <div className="field-label adv-sep">remote mail hubs</div>
                  {netHubs.map((h, i) => (
                    <div className="row" key={i}>
                      <input style={{ flex: 1 }} placeholder="http://host:7370"
                        value={h} onChange={(e) => setNetHubs(
                          (l) => l.map((x, j) => (j === i ? e.target.value : x)))} />
                      <button type="button" onClick={() => setNetHubs(
                        (l) => l.filter((_, j) => j !== i))}>
                        <CloseIcon fontSize="inherit" /></button>
                    </div>
                  ))}
                  <button type="button" onClick={() => setNetHubs((l) => [...l, ''])}>
                    + add a remote mail hub address</button>
                  <div className="dim hub-hint">names are discovered on connect —
                    only the address is typed</div>
                </>
              ) },
            ]} />
        )}
        {error && <div className="ask-warn shell-create-error" role="alert">{error}</div>}
        <div className="row shell-create-actions">
          <button type="button" onClick={onRequestClose}>Cancel</button>
          <button type="submit" className="primary" disabled={busy || !name.trim()}>
            {busy ? 'Creating…' : 'Create organization'}</button>
        </div>
      </form>
    </div>
  )
}
