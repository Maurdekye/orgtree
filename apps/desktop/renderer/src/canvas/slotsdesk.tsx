// canvas/slotsdesk.tsx — the project desk's SLOTS tab (Orgtree 4.4.0; docket
// `project-slots-first-come-permits-claimed-through`, mockup approved by the
// user 2026-10-18). Shown only while the project's slot count is at least 1.
// It leads with "k of N slots held" and the holders, then Holding, Line and
// Recent holds in one table, with shared column headers and value-only coloured
// times (user 2026-10-19 19:16-19:24Z). The lists come from the
// `slot_status` op, re-read whenever the tree's slots change; the buttons
// are the user's (the desktop's viewer), as the project's superior's
// through the tool.

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode, UIEvent } from 'react'
import { createPortal } from 'react-dom'
import type { ToastFn } from '../types'
import { ago } from './shared'
import type { CanvasNode, OpFn } from './shared'
import { ConfirmModal } from './modals'
import { ordinal } from './slots'
import { slotTimeStyle, slotEndedTimeStyle } from './slottime'
import { AgentLink, nodeTierOf } from './identity'
import { ageClockNow, subscribeAgeClock } from './desk'
import type { ProjectSlotState } from './slots'
import { WatchdogRow } from './deskdogs'

interface Holder { lease: string; agent: string; slot: number; reason?: string | null; queued?: string | null; since: string; reminders?: number }
interface Waiter { position: number; agent: string; dog: string; since?: string | null }
interface Hold { lease: string; agent: string; slot: number; reason?: string | null; queued?: string | null; since: string; ended?: string | null; how?: string | null; by?: string | null }

/** A recent hold's ending label: nothing for an ordinary release, a short
 *  word for the unusual endings (user 2026-10-19 17:23Z). Unknown endings
 *  show verbatim rather than vanish. */
export function holdEndLabel(how?: string | null): string {
  if (!how || how === 'released') return ''
  if (how.startsWith('released (forced')) return 'forced'
  if (how.startsWith('idle:')) return 'timed out'
  return how
}
export interface SlotStatus { project: string; slots: number; held: number; holders: Holder[]; line: Waiter[]; history: Hold[]; history_next?: string | null }

function uniqueHolds(rows: Hold[]): Hold[] {
  const seen = new Set<string>()
  return rows.filter(row => !seen.has(row.lease) && !!seen.add(row.lease))
}

/** How long between two times: "45s", "12m", "1h 4m". */
export function span(from: string, to?: string | null): string {
  const s = Math.max(0, ((to ? Date.parse(to) : Date.now()) - Date.parse(from)) / 1000)
  if (s < 90) return `${Math.round(s)}s`
  if (s < 3600) return `${Math.round(s / 60)}m`
  const m = Math.round(s / 60)
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

function SlotTime({ from, to, ended = false }: { from: string; to?: string | null; ended?: boolean }) {
  const seconds = Math.max(0, ((to ? Date.parse(to) : Date.now()) - Date.parse(from)) / 1000)
  return <span className="slot-time" style={ended ? slotEndedTimeStyle(seconds) : slotTimeStyle(seconds)}>
    {ended ? `${ago(from)} ago` : span(from, to)}</span>
}

export function SlotsView({ node, state, map, onJump, op, toast, actions }: {
  node: CanvasNode; state: ProjectSlotState; map: Map<string, CanvasNode>; onJump?: (id: string) => void; op: OpFn; toast: ToastFn
  actions?: ReactNode
}) {
  useSyncExternalStore(subscribeAgeClock, ageClockNow, ageClockNow)
  const [status, setStatus] = useState<SlotStatus | null>(null)
  const [asking, setAsking] = useState<Holder | null>(null)
  const [bump, setBump] = useState(0)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState(false)
  const generation = useRef(0), historyBusy = useRef(false)
  // re-read when the tree's holders or line change (a grant, release or claim)
  const sig = state.total + '|' + state.held.map((l) => l.lease).join(',') + '|' + state.line.map((w) => w.dog).join(',')
  useEffect(() => {
    let live = true
    generation.current++; historyBusy.current = false
    setHistoryLoading(false); setHistoryError(false)
    op({ op: 'slot_status', node: node.id })
      .then((r) => { if (live) setStatus(previous => {
        // a body without the lists (an error page, an older engine) shows the
        // empty sections rather than crash the desk (coordinator 2026-10-19)
        const next = (r ?? null) as unknown as SlotStatus | null
        if (!next || !previous || previous.project !== next.project) return next
        const head = next.history ?? [], older = previous.history ?? []
        const overlap = head.some(row => older.some(old => old.lease === row.lease))
        // Preserve pages under an overlapping live head update. If the whole
        // head moved past our window, restart at its cursor rather than leave a gap.
        return overlap ? {...next, history:uniqueHolds([...head,...older]), history_next:previous.history_next} : next
      }) })
      .catch(() => {})   // `op` toasts the refusal
    return () => { live = false; generation.current++ }
  }, [node.id, sig, bump])
  const reread = () => setBump((n) => n + 1)
  const holders = status?.holders ?? []
  const line = status?.line ?? []
  const history = status?.history ?? []
  const loadOlder = () => {
    const before = status?.history_next
    if (!before || historyBusy.current) return
    const epoch = generation.current
    historyBusy.current = true; setHistoryLoading(true); setHistoryError(false)
    op({op:'slot_history',node:node.id,history_before:before})
      .then(result => {
        if (generation.current !== epoch) return
        const page = (result ?? {}) as unknown as Partial<Pick<SlotStatus,'history'|'history_next'>>
        setStatus(previous => previous?.history_next === before ? {
          ...previous, history:uniqueHolds([...(previous.history ?? []),...(page.history ?? [])]), history_next:page.history_next??null,
        } : previous)
      })
      .catch(() => { if (generation.current === epoch) setHistoryError(true) })
      .finally(() => { if (generation.current === epoch) { historyBusy.current=false; setHistoryLoading(false) } })
  }
  const scrollHistory = (event: UIEvent<HTMLDivElement>) => {
    const el = event.target as HTMLElement
    if (el.scrollHeight > el.clientHeight && el.scrollHeight-el.clientHeight-el.scrollTop < 160) loadOlder()
  }
  // the claim's name is its reason (the line lists its dog; the tree has its name)
  const nameOf = (w: Waiter) => state.line.find((x) => x.agent === w.agent)?.name
  const agentLink = (id: string) => <AgentLink id={id} tier={nodeTierOf(map.get(id))} onFocus={onJump} />
  return (
    <div className="desk-tabpanel project-slots" onScroll={scrollHistory}>
      {actions && <div className="team-tab-toolbar" role="toolbar" aria-label="Slots view controls">{actions}</div>}
      <div className="slots-table-scroll" role="region" aria-label="Concurrency slot records" tabIndex={0} onScroll={scrollHistory}>
      <table className="slots-table">
        <colgroup><col className="slot-col-position"/><col className="slot-col-agent"/><col className="slot-col-time"/><col className="slot-col-time"/>
          <col className="slot-col-ended"/><col/><col className="slot-col-action"/></colgroup>
        <thead><tr>{['Position', 'Agent', 'Waited', 'Held', 'Ended', 'Claim / lease', 'Action'].map(label =>
          <th key={label} scope="col" className={label === 'Action' ? 'slot-action' : undefined}>{label}</th>)}</tr></thead>
      <tbody className="slots-holding">
        <tr className="slot-section"><th colSpan={7} scope="rowgroup"><h4>Holding</h4></th></tr>
        {holders.length === 0 && <tr><td colSpan={7} className="dim slot-empty">Nobody holds a concurrency slot. An agent above or below the project claims one
          with <code>orgtree_watchdog action=create kind=slot target={node.id}</code>; it is granted at once while a concurrency slot is free.</td></tr>}
        {holders.map((h) => (
          <tr key={h.lease} className="slot-row">
            <td className="slot-position"/>
            <th scope="row" className="slot-agent">{agentLink(h.agent)}</th>
            <td className="slot-wait" title={h.queued ? 'in line since ' + h.queued : undefined}>
              {h.queued ? <SlotTime from={h.queued} to={h.since}/> : ''}</td>
            <td className="slot-held" title={'since ' + h.since}><SlotTime from={h.since}/></td>
            <td className="slot-ended"/>
            <td className="slot-rest">{h.reason && <span className="slot-reason">{h.reason}</span>}
              <span className="dim mono slot-lease">{h.lease}</span>
              {(h.reminders ?? 0) > 0 && <span className="dim"> {h.reminders} reminder{h.reminders === 1 ? '' : 's'}</span>}</td>
            <td className="slot-action"><button type="button" className="danger" data-action="force-release"
              title={`take the concurrency slot back from ${h.agent}; the next in line gets it at once`}
              onClick={() => setAsking(h)}>force release</button></td>
          </tr>
        ))}
      </tbody>
      <tbody className="slots-line">
        <tr className="slot-section"><th colSpan={7} scope="rowgroup"><h4>Line</h4></th></tr>
        {line.length === 0 && <tr><td colSpan={7} className="dim slot-empty">Nobody is waiting.</td></tr>}
        {line.map((w) => (
          <WatchdogRow as="tr" key={w.agent + w.dog} id={state.line.find(x=>x.agent===w.agent)?.dog??w.dog} className="slot-row">
            <td className="slot-position"><span className="slot-no">{ordinal(w.position)}</span></td>
            <th scope="row" className="slot-agent">{agentLink(w.agent)}</th>
            <td className="slot-wait" title={w.since ? 'in line since ' + w.since : undefined}>
              {w.since ? <SlotTime from={w.since}/> : ''}</td>
            <td className="slot-held" />
            <td className="slot-ended" />
            <td className="slot-rest">{nameOf(w) && <span className="slot-reason">{nameOf(w)}</span>}</td>
            <td className="slot-action"><button type="button" data-action="unqueue" title={`remove ${w.agent}'s claim: it leaves the line and is not granted`}
              onClick={() => {
                op({ op: 'slot_unqueue', node: node.id, agent: w.agent })
                  .then(() => { toast([`${w.agent} removed from project ${node.id}'s concurrency slot line`]); reread() })
                  .catch(() => {})
              }}>remove from line</button></td>
          </WatchdogRow>
        ))}
      </tbody>
      <tbody className="slots-history">
        <tr className="slot-section"><th colSpan={7} scope="rowgroup"><h4>Recent holds</h4></th></tr>
        {history.length === 0 && <tr><td colSpan={7} className="dim slot-empty">No concurrency slot has been held yet.</td></tr>}
        {history.map((h) => (
          <tr key={h.lease} className="slot-row">
            <td className="slot-position"/>
            <th scope="row" className="slot-agent">{agentLink(h.agent)}</th>
            <td className="slot-wait" title={h.queued ? 'in line since ' + h.queued : undefined}>
              {h.queued ? <SlotTime from={h.queued} to={h.since}/> : ''}</td>
            <td className="slot-held" title={`held from ${h.since} to ${h.ended ?? '?'}`}><SlotTime from={h.since} to={h.ended}/></td>
            <td className="slot-ended">{h.ended ? <SlotTime from={h.ended} ended/> : ''}</td>
            <td className="slot-rest">{h.reason && <span className="slot-reason">{h.reason}</span>}<span className="dim mono slot-lease">{h.lease}</span></td>
            <td className="slot-action slot-how" title={h.how ?? undefined}>{holdEndLabel(h.how)}</td>
          </tr>
        ))}
        {(historyLoading || historyError || status?.history_next) && <tr><td colSpan={7} className="slot-history-more" role="status">
          {historyLoading ? 'Loading older holds…' : historyError ? <>
            Could not load older holds. <button type="button" onClick={loadOlder}>Retry</button>
          </> : 'Scroll for older holds'}
        </td></tr>}
      </tbody>
      </table>
      </div>
      {asking && createPortal(
        <ConfirmModal title={`take the concurrency slot of ${node.id} back from ${asking.agent}?`}
          body={`${asking.agent} has held it for ${span(asking.since)}${asking.reason ? ` (${asking.reason})` : ''}. `
            + `It is recorded as "released (forced by @user)", ${asking.agent} is told, and `
            + (line[0] ? `the next in line, ${line[0].agent}, gets it at once.` : 'the concurrency slot is free again.')}
          confirmLabel="force release" close={() => setAsking(null)}
          onConfirm={() => {
            const h = asking
            op({ op: 'slot_release', lease: h.lease, force: true })
              .then(() => { toast([`concurrency slot of ${node.id} taken back from ${h.agent}`]); reread() })
              .catch(() => {})
          }} />, document.body)}
    </div>
  )
}
