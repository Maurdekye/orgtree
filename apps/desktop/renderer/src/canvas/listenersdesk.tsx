// canvas/listenersdesk.tsx — the project desk's LISTENERS tab (Orgtree
// 4.4.0; docket `project-event-listeners-sync-monitor-watchdogs-l`, user
// 2026-10-19; rebuilt for `project-desk-mail-event-listeners-and-slots-tabs`,
// user 2026-10-20 06:22Z-06:42Z). The tab shows from the first time any
// listener or watch registers on the project, for good (`listeners_seen`).
// It lists the event listeners and listener watches from the tree's
// watchdogs, carries the fire control (the same `fire_project_event` op the
// agents' `orgtree_project action=fire_event` runs, with an optional message
// for the listeners), and keeps the project's Recently Fired history.
//
// ONE table like the slots tab's and the Mail tab's listeners (user
// 2026-10-19 21:08Z-21:11Z, 2026-10-20 06:22Z): a header row, the sections
// as section rows, values only, in the desk tables' one column order
// (Position · Agent · Waited · Last fired · Mail · Armed · Fired · On fire ·
// Watchdog) with the slots table's widths. The watchdog chip, last, carries
// one-shot or continuous (its tooltip and detail name the mode); Fired and
// Last fired stay empty for one-shot dogs, which go once they fire. Waited
// counts since a listener's arming or its last event. Recently Fired (the
// engine's `listener_history`, older pages as you scroll) holds two kinds
// of row: a fired event (who fired it, how long ago, its message on one
// line until clicked) with a sub-row per listener it reached, linking that
// listener's fire mail in its own Mail tab; and, tinted, a listener watch
// reaching its count, with the listeners armed then. Each sub-row says how
// long that listener had listened.

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { UIEvent } from 'react'
import type { ToastFn, Watchdog } from '../types'
import type { CanvasNode, OpFn } from './shared'
import { AgentLink, nodeTierOf } from './identity'
import { WatchdogRow } from './deskdogs'
import { WatchdogLink } from './watchdoglink'
import { ageClockNow, subscribeAgeClock } from './desk'
import { fireActionTools, listeningSince, projectListenerState } from './listeners'
import { span, SlotTime } from './slotsdesk'
import { slotTimeStyle } from './slottime'
import { HistoryDog } from './historydog'
import { useLoadWhenSeen } from './loadmore'
import { resolveRef } from './reflinks'
import type { RefRoutes } from './reflinks'
import { fmtFull } from '../timefmt'

/** One listener a kept fire names (engine `listeners::heard_entry`). */
export interface FiredListener {
  agent: string; dog?: string; name?: string; once?: boolean; since?: string
  /** an event's fire mail, in the listener's own mailbox */
  mail?: string
  /** that mail is no longer there: its link is not offered */
  mail_gone?: boolean
}
/** One kept fire: an event, or a listener watch reaching its count. */
export interface FiredRow {
  id: number; at: string; kind: 'event' | 'watch'; by?: string | null; message?: string | null
  watch?: { agent: string; dog: string; name?: string; count: number; armed: number; since?: string }
  listeners: FiredListener[]
}
interface FireHistory { history: FiredRow[]; history_next?: string | null }

function uniqueFires(rows: FiredRow[]): FiredRow[] {
  const seen = new Set<number>()
  return rows.filter((r) => !seen.has(r.id) && !!seen.add(r.id))
}

/** a closed or open stretch in the shared slot time colours */
function Waited({ from, to }: { from?: string | null; to?: string | null }) {
  if (!from) return null
  const seconds = Math.max(0, ((to ? Date.parse(to) : Date.now()) - Date.parse(from)) / 1000)
  return <span className={'slot-time' + (to ? '' : ' live')} style={slotTimeStyle(seconds)}
    title={to ? `listened from ${fmtFull(from)} to ${fmtFull(to)}` : `listening since ${fmtFull(from)}`}>{span(from, to)}</span>
}

/** A listener's fire mail (user 2026-10-20 06:42Z): it lives in the
 *  LISTENER's mailbox, so the link opens that agent's desk Mail tab, the way
 *  every mail reference opens; never the project's. A mail no longer there,
 *  or a mailbox this surface cannot open, shows as unavailable. */
function FireMail({ agent, mail, gone, refs }: { agent: string; mail?: string; gone?: boolean; refs?: RefRoutes }) {
  if (!mail) return null
  const r = refs ? resolveRef({ kind: 'mail', org: refs.world.org, box: 'node', node: agent, id: mail }, refs.world) : null
  if (!gone && r && r.outcome === 'ready' && refs?.onOpen) {
    return <button type="button" className="listener-mail-link fire-mail" data-mail={mail}
      title={`open the fire mail ${agent} got, in ${agent}'s Mail tab`}
      onClick={(e) => { e.stopPropagation(); refs.onOpen(r) }}>fire mail</button>
  }
  return <span className="listener-mail-link fire-mail unavailable" data-mail={mail} aria-disabled="true"
    title={gone ? `this fire mail is no longer in ${agent}'s mailbox` : r ? r.why : 'mail is not opened from here'}>fire mail · unavailable</span>
}

export function ListenersView({ node, dogs, map, onJump, op, toast, refs }: {
  node: CanvasNode; dogs: Watchdog[]; map: Map<string, CanvasNode>
  onJump?: (id: string) => void; op: OpFn; toast: ToastFn
  /** the surface's references: a fire mail opens in its listener's Mail tab */
  refs?: RefRoutes
}) {
  useSyncExternalStore(subscribeAgeClock, ageClockNow, ageClockNow)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [hist, setHist] = useState<FireHistory | null>(null)
  const [bump, setBump] = useState(0)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const [open, setOpen] = useState<Set<number>>(() => new Set())
  const generation = useRef(0), paging = useRef(false)
  // the host may hand a new `op` each render: read through a ref
  const opRef = useRef(op); opRef.current = op
  const state = projectListenerState(node.id, dogs)
  const live = node.state === 'live'
  // re-read when a fire is kept (the tree's newest fire moves)
  useEffect(() => {
    let alive = true
    generation.current++; paging.current = false
    setLoading(false); setFailed(false)
    opRef.current({ op: 'listener_history', node: node.id })
      .then((r) => { if (alive) setHist((previous) => {
        const next = (r ?? null) as unknown as FireHistory | null
        if (!next || !Array.isArray(next.history)) return { history: [] }
        if (!previous) return next
        const overlap = next.history.some((h) => previous.history.some((o) => o.id === h.id))
        return overlap ? { history: uniqueFires([...next.history, ...previous.history]), history_next: previous.history_next } : next
      }) })
      .catch(() => {})   // `op` toasts the refusal
    return () => { alive = false; generation.current++ }
  }, [node.id, node.last_fire, bump])
  const loadOlder = () => {
    const before = hist?.history_next
    if (!before || paging.current) return
    const epoch = generation.current
    paging.current = true; setLoading(true); setFailed(false)
    opRef.current({ op: 'listener_history', node: node.id, history_before: before })
      .then((r) => {
        if (generation.current !== epoch) return
        const page = (r ?? {}) as unknown as Partial<FireHistory>
        setHist((previous) => previous?.history_next === before
          ? { history: uniqueFires([...previous.history, ...(page.history ?? [])]), history_next: page.history_next ?? null }
          : previous)
      })
      .catch(() => { if (generation.current === epoch) setFailed(true) })
      .finally(() => { if (generation.current === epoch) { paging.current = false; setLoading(false) } })
  }
  const onScroll = (event: UIEvent<HTMLDivElement>) => {
    const el = event.target as HTMLElement
    if (el.scrollHeight > el.clientHeight && el.scrollHeight - el.clientHeight - el.scrollTop < 160) loadOlder()
  }
  const moreRef = useRef<HTMLTableRowElement>(null)
  useLoadWhenSeen(moreRef, hist?.history_next, loadOlder)
  const fires = hist?.history ?? []
  const watching = state.watches.length > 0 || fires.some((f) => f.kind === 'watch')
  const mailing = fires.some((f) => f.listeners.some((l) => l.mail))
  const firing = [...state.listeners, ...state.watches].some((w) => fireActionTools(w).length > 0)
  const cols = ['Position', 'Agent', 'Waited', 'Last fired', ...(mailing ? ['Mail'] : []), ...(watching ? ['Armed'] : []), 'Fired',
    ...(firing ? ['On fire'] : []), 'Watchdog']
  const n = cols.length
  const afterLast = n - 4   // the columns after Last fired
  const fire = () => {
    if (busy || !live) return
    setBusy(true)
    op({ op: 'fire_project_event', node: node.id, ...(text.trim() ? { body: text.trim() } : {}) })
      .then((r) => {
        const count = (r as { listeners_armed?: number }).listeners_armed ?? state.armed.length
        toast([`fired project ${node.id}'s event to ${count} listener${count === 1 ? '' : 's'}`])
        setText('')
        setBump((b) => b + 1)
      })
      .catch(() => {})   // `op` toasts the refusal
      .finally(() => setBusy(false))
  }
  const agentLink = (id: string) => <AgentLink id={id} tier={nodeTierOf(map.get(id))} onFocus={onJump} />
  // who fired an event: an agent of the tree, else the label as kept ("@user")
  const firer = (by?: string | null) => !by ? null : map.has(by.replace(/^@/, '')) ? agentLink(by.replace(/^@/, ''))
    : <span className="dim fired-by" title={by}>{by}</span>
  const row = (w: Watchdog, watch: boolean) => {
    const tools = fireActionTools(w)
    return (
      // a watchdog row: away from its links it opens the dog's menu, as the
      // slots line and the mail listeners do; the agent link and chip keep theirs
      <WatchdogRow as="tr" key={w.id} id={w.id} className={'slot-row listener-row' + (w.state === 'paused' ? ' out' : '')}>
        <td className="slot-position" title={w.state === 'paused' ? 'its watchdog is paused: it listens for nothing until resumed' : undefined}>
          {w.state === 'paused' ? <span className="dim">paused</span> : null}</td>
        <th scope="row" className="slot-agent">{agentLink(w.owner)}</th>
        <td className="slot-wait">{w.state === 'armed' && <Waited from={listeningSince(w)} />}</td>
        <td className="slot-ended listener-last" title={!w.once && w.last_fired ? `last fired ${fmtFull(w.last_fired)}` : undefined}>
          {w.once ? null : w.last_fired ? <SlotTime from={w.last_fired} ended /> : <span className="dim">—</span>}</td>
        {mailing && <td className="listener-mail"/>}
        {watching && <td className="listener-count"
          title={watch ? `${state.armed.length} of ${w.count ?? '?'} event listeners armed; the watch fires when ${w.count ?? '?'} are` : undefined}>
          {watch ? `${state.armed.length}/${w.count ?? '?'}` : null}</td>}
        <td className="listener-fired">{w.once ? null : w.fired}</td>
        {firing && <td className="listener-actions"
          title={tools.length ? 'tool calls this watchdog runs as its owner when it fires; results ride its fire mail' : undefined}>
          {tools.join(', ')}</td>}
        <td className="listener-dog-cell"><WatchdogLink dog={w} className="listener-dog" />
          {w.notice && <span className="dim"> passive</span>}</td>
      </WatchdogRow>
    )
  }
  // a listener a kept fire names: its chip from the tree while it is still there
  const keptDog = (l: FiredListener, kind: Watchdog['kind']) => l.dog
    ? <HistoryDog dog={{ id: `${l.agent}/${l.dog}`, owner: l.agent, name: l.name ?? l.dog, kind, once: l.once,
        gone: !dogs.some((w) => w.id === `${l.agent}/${l.dog}` && !w.spent && (w.state === 'armed' || w.state === 'paused')) }} className="listener-dog" />
    : null
  const subRow = (f: FiredRow, l: FiredListener, i: number) => (
    <tr key={`${f.id}:${i}`} className={'slot-row listener-row fired-listener' + (f.kind === 'watch' ? ' watch' : '')}>
      <td className="slot-position fired-branch" aria-hidden="true">└</td>
      <th scope="row" className="slot-agent">{agentLink(l.agent)}</th>
      <td className="slot-wait">{l.since && <Waited from={l.since} to={f.at} />}</td>
      <td className="slot-ended"/>
      {mailing && <td className="listener-mail">{f.kind === 'event'
        && <FireMail agent={l.agent} mail={l.mail} gone={l.mail_gone} refs={refs} />}</td>}
      {watching && <td className="listener-count"/>}
      <td className="listener-fired"/>
      {firing && <td className="listener-actions"/>}
      <td className="listener-dog-cell">{keptDog(l, 'project_listener')}</td>
    </tr>
  )
  const fireRows = (f: FiredRow) => {
    const expanded = open.has(f.id)
    const toggle = () => setOpen((s) => { const t = new Set(s); if (t.has(f.id)) t.delete(f.id); else t.add(f.id); return t })
    const head = f.kind === 'watch' && f.watch ? (
      <tr key={f.id} className="slot-row listener-row fired-row watch" data-fire={f.id}>
        <td className="slot-position"><span className="dim">watch</span></td>
        <th scope="row" className="slot-agent">{agentLink(f.watch.agent)}</th>
        <td className="slot-wait">{f.watch.since && <Waited from={f.watch.since} to={f.at} />}</td>
        <td className="slot-ended" title={`its count was reached ${fmtFull(f.at)}`}><SlotTime from={f.at} ended /></td>
        {mailing && <td className="listener-mail"/>}
        {watching && <td className="listener-count" title={`${f.watch.armed} event listeners were armed when this watch, waiting for ${f.watch.count}, fired`}>
          {`${f.watch.armed}/${f.watch.count}`}</td>}
        <td className="listener-fired"/>
        {firing && <td className="listener-actions"/>}
        <td className="listener-dog-cell">{keptDog({ agent: f.watch.agent, dog: f.watch.dog, name: f.watch.name }, 'listener_watch')}</td>
      </tr>
    ) : (
      <tr key={f.id} className="slot-row listener-row fired-row event" data-fire={f.id}>
        <td className="slot-position"><span className="dim">event</span></td>
        <th scope="row" className="slot-agent">{firer(f.by)}</th>
        <td className="slot-wait"/>
        <td className="slot-ended" title={`fired ${fmtFull(f.at)}`}><SlotTime from={f.at} ended /></td>
        <td colSpan={afterLast} className={'fired-message' + (expanded ? ' open' : '')}>
          {f.message
            ? <button type="button" className="fired-message-text" aria-expanded={expanded}
                title={expanded ? 'click to fold the message' : 'click to read the whole message'} onClick={toggle}>{f.message}</button>
            : <span className="dim">no message</span>}
          {f.listeners.length === 0 && <span className="dim fired-count"> · nobody was listening</span>}
        </td>
      </tr>
    )
    return [head, ...f.listeners.map((l, i) => subRow(f, l, i))]
  }
  return (
    <div className="desk-tabpanel project-listeners" onScroll={onScroll}>
      <div className="listener-fire">
        <input type="text" value={text} disabled={!live || busy}
          placeholder={`message for ${node.id}'s listeners (optional)`}
          aria-label={`message for project ${node.id}'s event listeners`}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); fire() } }} />
        <button type="button" className="primary" data-action="fire-event" disabled={!live || busy}
          title={`fire project ${node.id}'s event now: every armed project_listener on it receives it at once`}
          onClick={fire}>fire event</button>
      </div>
      <div className="slots-table-scroll" role="region" aria-label={`Event listeners of project ${node.id}`} tabIndex={0} onScroll={onScroll}>
        <table className="slots-table listeners-table">
          <colgroup><col className="slot-col-position"/><col className="slot-col-agent"/><col className="slot-col-time"/><col className="slot-col-ended"/>
            {mailing && <col className="listener-col-mail"/>}{watching && <col className="listener-col-count"/>}<col className="listener-col-fired"/>
            {firing && <col className="listener-col-actions"/>}<col className="listener-col-dog"/></colgroup>
          <thead><tr>{cols.map((label) => <th key={label} scope="col">{label}</th>)}</tr></thead>
          <tbody className="listeners-events">
            <tr className="slot-section"><th colSpan={n} scope="rowgroup"><h4>Event listeners</h4></th></tr>
            {state.listeners.length === 0 && <tr><td colSpan={n} className="dim slot-empty">No agent listens on this
              project. An agent above or below it arms one
              with <code>orgtree_watchdog action=create kind=project_listener target={node.id} once=true</code> and
              is woken when the event fires.</td></tr>}
            {state.listeners.map((w) => row(w, false))}
          </tbody>
          <tbody className="listeners-watches">
            <tr className="slot-section"><th colSpan={n} scope="rowgroup"><h4>Listener watches</h4></th></tr>
            {state.watches.length === 0 && <tr><td colSpan={n} className="dim slot-empty">No listener watch is armed.
              A watch fires when a set number of listeners are armed — with a fire action it releases the whole group at once:
              <code> orgtree_watchdog action=create kind=listener_watch target={node.id} count=N once=true</code>.</td></tr>}
            {state.watches.map((w) => row(w, true))}
          </tbody>
          <tbody className="listeners-fired">
            <tr className="slot-section"><th colSpan={n} scope="rowgroup"><h4>Recently Fired</h4></th></tr>
            {fires.length === 0 && <tr><td colSpan={n} className="dim slot-empty">No event has been fired on this project yet.</td></tr>}
            {fires.flatMap(fireRows)}
            {(loading || failed || hist?.history_next) && <tr ref={moreRef}><td colSpan={n} className="slot-history-more" role="status">
              {loading ? 'Loading older fires…' : failed ? <>
                Could not load older fires. <button type="button" onClick={loadOlder}>Retry</button>
              </> : 'Scroll for older fires'}
            </td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  )
}
