// canvas/lockdownpanel.tsx — the org mailbox lockdown (Mail hub 2.6.0) as ONE section, shown in the org mailbox's
// mailservers tab and under the Lockdown dropdown in org settings.
//
// The lockdown (USER 2026-11-25 13:26Z m0388b64a9372; setting On / Off / Org decides 14:10:49Z m405b44961ff5): the
// user always edits it; set-aside letters are opened one at a time (13:37Z Q5).
// THE LIST (USER 2026-11-25 21:48:05Z m6f4d40461dde "make it a list you edit under lockdown that appears only when
// lockdown is enabled ... should look like the connected list underneath mailhubs"; 21:51:09Z md60a3e7803d1 "the
// allowlist add opens a dropdown with searchable names"): while it is on, the listed addresses show under their hub in
// the shared ConnectionList, each with the list's × to take it off; Add opens a searchable dropdown of the connected
// contacts not listed yet, and a choice adds it at once. No address box: agents add any address with orgtree_lockdown.
// IN SETTINGS TOO (USER 2026-11-26 10:45:12Z m6717cf33b536 "i do not see an searchable contact list for lockdown next
// to the dropdown to enable it"), and TIDY (10:46:43Z md10751788f2e "this ui is ugly, clean it up"): a header line with
// a state chip and the action inline, plain-word hub lines, "Allowed addresses" with Add beside it, the empty state
// inside the list frame, set-aside as a settings toggle, and "Show set-aside mail (N)" only when there is some.
import { useEffect, useRef, useState } from 'react'
import { getSetAside, readSetAside, type NetLockdownChange } from '../api'
import { LockIcon } from '../icons'
import type { NetHub, NetLockdown, NetPeer, SetAsideLetter, SetAsidePage } from '../types'
import { fmtShort } from '../timefmt'
import { HubContactChip } from './agentmentions'
import { ConnectionList, NO_RECENCY, PresenceDot, connectionName, rowPresence } from './connectionlist'
import { contactStatus, type OrgBlocks } from './orgblocks'
import { SetToggle } from './settingskit'

type Change = (c: NetLockdownChange) => Promise<void>

const who = (by?: string | null) => !by ? '' : by === '@user' ? 'you' : '@' + by

/** A hub's enforcement in plain words, and whether its dot is green. */
const HUB_WORD: Record<NetLockdown['hubs'][number]['state'], string> = {
  enforced: 'enforcing', pending: 'waiting for the hub', failed: 'the hub refused it', unsupported: 'hub too old: route suspended',
}

/** The state chip: "On · Org decides · set by you". */
export function lockdownChip(l: NetLockdown): string {
  const whose = l.setting === 'org' ? 'Org decides' : l.setting === 'on' ? 'forced on by you' : 'forced off by you'
  return [l.on ? 'On' : 'Off', whose, l.set_by ? `set by ${who(l.set_by)}` : ''].filter(Boolean).join(' · ')
}

export function LockdownPanel({ slug, lockdown, change, hubs, blocks }: {
  slug: string; lockdown: NetLockdown; change: Change; hubs: NetHub[]; blocks: Pick<OrgBlocks, 'mine' | 'by'>
}) {
  const [page, setPage] = useState<SetAsidePage | null>(null)
  const [shown, setShown] = useState(false)
  const [open, setOpen] = useState<SetAsideLetter | null>(null)
  // the first page tells how many are set aside; the button shows only when some are
  useEffect(() => {
    let live = true
    getSetAside(slug).then((p) => { if (live && p && Array.isArray(p.set_aside)) setPage(p) }).catch(() => {})
    return () => { live = false }
  }, [slug, lockdown.rev, lockdown.set_aside])
  const more = (before: string) => getSetAside(slug, before)
    .then((p) => setPage((old) => old ? { ...p, set_aside: [...old.set_aside, ...p.set_aside] } : p)).catch(() => {})
  // the list, by hub: a listed address the hub still lists keeps its roster row (its presence), one no longer
  // connected still shows, so it can be taken off
  const byHub = new Map<string, { name: string; rows: NetPeer[] }>()
  for (const a of lockdown.allow) {
    const g = byHub.get(a.hub) ?? { name: a.hub_name, rows: [] }
    g.rows.push(hubs.find((h) => h.id === a.hub)?.roster.find((r) => r.slug === a.address) ?? { slug: a.address, online: false })
    byHub.set(a.hub, g)
  }
  const total = page?.total ?? 0
  return (
    <div className="oi-lockdown lk-card">
      <div className="lk-head">
        <LockIcon fontSize="inherit" className="lk-icon" /> <b>Lockdown</b>
        <span className={'lk-chip' + (lockdown.on ? ' on' : '')}>{lockdownChip(lockdown)}</span>
        {lockdown.refused > 0 && <span className="dim">{lockdown.refused} refused</span>}
        {lockdown.setting === 'org' && <button type="button" className="lk-action" onClick={() => void change({ on: !lockdown.on })}>
          {lockdown.on ? 'Lift lockdown' : 'Lock down now'}</button>}
      </div>
      {lockdown.on && lockdown.hubs.map((h) => (
        <div key={h.hub} className="lk-hub" title={h.detail ?? undefined}>
          <span className={'oi-dot' + (h.state === 'enforced' ? ' ok' : h.state === 'pending' ? ' mix' : ' bad')} />
          <span>{h.hub_name}</span><span className="dim">{HUB_WORD[h.state] ?? h.state}</span>
        </div>
      ))}
      {lockdown.on && <div className="oi-lock-list">
        <div className="oi-lock-list-head"><span className="lk-sub">Allowed addresses</span>
          <LockdownAdd hubs={hubs} lockdown={lockdown} change={change} />
        </div>
        <div className="lk-frame">
          {lockdown.allow.length === 0
            ? <div className="dim lk-empty">Nobody outside yet; organizations on this computer can still reach the org</div>
            : [...byHub.entries()].map(([hub, g]) => (
              <div key={hub} className="oi-lock-hub">
                <div className="oi-origin">{g.name}</div>
                <ConnectionList rows={g.rows} recent={NO_RECENCY} label={`On the lockdown list on ${g.name}`}
                  status={(p) => contactStatus(hubs.find((h) => h.id === hub), p, blocks)}
                  x={(p) => ({ title: `Take @net:${p.slug} off the lockdown list`, onClick: () => void change({ remove: [{ hub, address: p.slug }] }) })} />
              </div>
            ))}
        </div>
      </div>}
      <SetToggle label="Set aside mail from unlisted addresses" checked={lockdown.set_aside}
        onChange={(on) => void change({ set_aside: on })}
        hint="Kept out of the agents' mail to read one at a time; otherwise it is refused." />
      {total > 0 && <div className="lk-setaside">
        {!shown
          ? <button type="button" className="lk-link" onClick={() => setShown(true)}>Show set-aside mail ({total})</button>
          : <>
            <div className="dim">{total} set aside · {page!.unread} unread
              {page!.top_senders.length > 0 && ' · most from ' + page!.top_senders.slice(0, 3).map((s) => `${s.from} (${s.letters})`).join(', ')}
              {' '}<button type="button" className="lk-link" onClick={() => { setShown(false); setOpen(null) }}>Hide</button></div>
            {page!.set_aside.map((l) => (
              <div key={l.id} className="oi-peer">
                <HubContactChip address={l.from} />
                <span className="dim"> {fmtShort(l.at)} · {l.chars} chars{l.read_by ? ` · read by ${who(l.read_by)}` : ''}</span>
                <button type="button" className="lk-link" onClick={() => readSetAside(slug, l.id).then(setOpen).catch(() => {})}>Read</button>
              </div>
            ))}
            {page!.next_before && <button type="button" className="lk-link" onClick={() => void more(page!.next_before!)}>More</button>}
          </>}
        {open && <div className="oi-setaside-letter" role="region" aria-label={'set-aside letter from ' + open.from}>
          <div className="dim">{open.from} · {fmtShort(open.at)} · {open.note}</div>
          <pre className="oi-setaside-body">{open.body}</pre>
          <button type="button" className="lk-link" onClick={() => setOpen(null)}>Close</button>
        </div>}
      </div>}
    </div>
  )
}

/** The lockdown list's Add: a dropdown of the connected contacts across the org's hubs that are not listed there
 *  yet, filtered by name or address as you type; a choice adds it at once and closes the dropdown. */
export function LockdownAdd({ hubs, lockdown, change }: { hubs: NetHub[]; lockdown: NetLockdown; change: Change }) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const box = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!open) return
    const doc = box.current?.ownerDocument
    const away = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false) }
    doc?.addEventListener('pointerdown', away)
    return () => doc?.removeEventListener('pointerdown', away)
  }, [open])
  const shown = hubs.filter((h) => !h.hidden)
  const several = shown.length > 1
  const needle = q.trim().toLowerCase()
  const candidates = shown.flatMap((h) => h.roster
    .filter((r) => !lockdown.allow.some((a) => a.hub === h.id && a.address === r.slug))
    .map((r) => ({ hub: h, r, name: connectionName(r) })))
    .filter(({ r, name }) => !needle || name.toLowerCase().includes(needle) || r.slug.toLowerCase().includes(needle))
    .sort((a, b) => a.name.localeCompare(b.name) || a.r.slug.localeCompare(b.r.slug))
  const pick = (hub: string, address: string) => { setOpen(false); setQ(''); void change({ add: [{ hub, address }] }) }
  return (
    <span className="oi-lock-addwrap" ref={box}>
      <button type="button" className="lk-action" aria-expanded={open} onClick={() => { setOpen(!open); setQ('') }}>Add</button>
      {open && <div className="oi-lock-add">
        <input autoFocus aria-label="Search contacts" placeholder="Search contacts" value={q} onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') { e.stopPropagation(); setOpen(false) }
            if (e.key === 'Enter' && candidates.length) { e.preventDefault(); pick(candidates[0].hub.id, candidates[0].r.slug) }
          }} />
        <div role="listbox" aria-label="Connected contacts not on the list">
          {candidates.map(({ hub, r, name }) => (
            <div key={hub.id + ':' + r.slug} role="option" aria-selected={false} tabIndex={0} data-address={r.slug}
              className="oi-lock-option" onClick={() => pick(hub.id, r.slug)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(hub.id, r.slug) } }}>
              <PresenceDot state={rowPresence(r)} />
              <span className="oi-lock-option-name">{name}</span>
              <span className="dim mono-sm">@net:{r.slug}</span>
              {several && <span className="dim"> · {hub.name || hub.address}</span>}
            </div>
          ))}
          {!candidates.length && <div className="dim oi-lock-none">{needle ? 'no connected contact matches' : 'every connected contact is on the list'}</div>}
        </div>
      </div>}
    </span>
  )
}
