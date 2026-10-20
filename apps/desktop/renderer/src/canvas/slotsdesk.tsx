// canvas/slotsdesk.tsx — the project desk's SLOTS tab (Orgtree 4.4.0; docket
// `project-slots-first-come-permits-claimed-through`, mockup approved by the
// user 2026-10-18). Shown only while the project's slot count is at least 1.
// It leads with "k of N slots held" and the holders, then Holding, Line and
// Recently Held in one table, with shared column headers and value-only coloured
// times (user 2026-10-19 19:16-19:24Z). A Watchdog column before Action holds
// each row's claim dog, as the desk's other tables do (user 2026-10-20
// 06:22Z): a holder's spent claim kept by its lease, a waiting claim live; so
// the Lease column is the lease alone (2026-10-20 06:36Z). The lists come from the
// `slot_status` op, re-read whenever the tree's slots change; the buttons
// are the user's (the desktop's viewer), as the project's superior's
// through the tool.
//
// The user holds slots themselves too (docket
// let-the-user-manually-hold-a-number-of-a-project; USER 2026-10-20 13:03Z,
// 13:22Z "B": FIFO whole grants, holds that last until released): the desk
// header carries a number input (default 1) and a button "Hold 1 slot" /
// "Hold N slots" left of the pin / pop-out / modal buttons, and a click holds
// at once (`user_slot_hold`, no dialog; USER 16:35Z, docket
// slots-tab-header-hold-n-slots-button-with-number). The count runs from 1 to
// the total minus the slots the user already holds or has asked for (a request
// still waiting counts as held); the button is grey when none is left.
// Their hold is a Holding row and their wait a Line row, both naming the
// engine's "user" as the standard @user mention (13:50Z, never "you"), with
// the user's own release (plain, unconfirmed: it is their hold) and cancel
// request, where an agent's rows keep force release and remove from line.

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode, UIEvent } from 'react'
import { createPortal } from 'react-dom'
import type { ToastFn, Watchdog } from '../types'
import { ago } from './shared'
import type { CanvasNode, OpFn } from './shared'
import { ConfirmModal } from './modals'
import { MAX_SLOTS, ordinal, slotUnits } from './slots'
import { slotTimeStyle, slotEndedTimeStyle } from './slottime'
import { AgentLink, nodeTierOf } from './identity'
import { ageClockNow, subscribeAgeClock } from './desk'
import type { ProjectSlotState } from './slots'
import { WatchdogRow } from './deskdogs'
import { WatchdogLink } from './watchdoglink'
import { HistoryDog } from './historydog'
import type { DogIdentity } from './historydog'
import { UserMention, isUserName } from './usermention'
import type { RefRoutes } from './reflinks'
import { DeskCount, bringCount, countOf } from './deskcount'

interface Holder { lease: string; agent: string; slot?: number; slots?: number; reason?: string | null; queued?: string | null; since: string; reminders?: number; dog?: DogIdentity | null }
interface Waiter { position: number; agent: string; dog: string; slots?: number; since?: string | null }
interface Hold { lease: string; agent: string; slot?: number; slots?: number; reason?: string | null; queued?: string | null; since: string; ended?: string | null; how?: string | null; by?: string | null; dog?: DogIdentity | null }

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

/** A time in the shared slot colours: a span, or with `ended` how long ago
 *  (the Ended column; the listeners tab's Last fired reads it too). */
export function SlotTime({ from, to, ended = false }: { from: string; to?: string | null; ended?: boolean }) {
  const seconds = Math.max(0, ((to ? Date.parse(to) : Date.now()) - Date.parse(from)) / 1000)
  return <span className="slot-time" style={ended ? slotEndedTimeStyle(seconds) : slotTimeStyle(seconds)}>
    {ended ? `${ago(from)} ago` : span(from, to)}</span>
}

export function SlotsView({ node, state, map, onJump, op, toast, actions, refs }: {
  node: CanvasNode; state: ProjectSlotState; map: Map<string, CanvasNode>; onJump?: (id: string) => void; op: OpFn; toast: ToastFn
  actions?: ReactNode
  /** the surface's references: the user's chip opens their inbox */
  refs?: RefRoutes
}) {
  useSyncExternalStore(subscribeAgeClock, ageClockNow, ageClockNow)
  const [status, setStatus] = useState<SlotStatus | null>(null)
  const [asking, setAsking] = useState<Holder | null>(null)
  const [count, setCount] = useState('1')
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
  // the claim's name is its reason (the line lists its dog; the tree has its name); a claim is
  // told by its own id, since the user may wait with several requests at once
  const treeDog = (w: Waiter) => state.line.find((x) => x.dog === `${w.agent}/${w.dog}`) ?? state.line.find((x) => x.agent === w.agent)
  const nameOf = (w: Waiter) => treeDog(w)?.name
  const userDogOf = (w: Waiter): Watchdog => ({ id: treeDog(w)?.dog ?? `${w.agent}/${w.dog}`, owner: w.agent, name: nameOf(w) ?? w.dog,
    kind: 'slot', target: node.id, interval_s: 0, state: 'armed', at: w.since ?? '', fired: 0, once: true, spent: false } as Watchdog)
  const agentLink = (id: string) => isUserName(id) ? <UserMention refs={refs} /> : <AgentLink id={id} tier={nodeTierOf(map.get(id))} onFocus={onJump} />
  // the user's own hold or wait: ended by them, plainly
  const releaseOwn = (h: Holder) => {
    op({ op: 'slot_release', lease: h.lease })
      .then(() => { toast([`${slotUnits(h.slots)} concurrency slot(s) of ${node.id} released`]); reread() })
      .catch(() => {})
  }
  const cancelOwn = (w: Waiter) => {
    op({ op: 'user_slot_cancel', node: node.id, dog: w.dog })
      .then(() => { toast([`slot request for project ${node.id} cancelled`]); reread() })
      .catch(() => {})
  }
  // the header's Hold control (USER 2026-10-20 16:35Z): what the user may still ask for is the total minus
  // what they hold and what they wait for (a waiting request counts, USER 16:36Z "yes, thats fine"; an agent's
  // hold is not theirs); the tree's rows stand in until the first read lands
  const mineOf = (rows: { agent: string; slots?: number }[]) => rows.filter((r) => isUserName(r.agent)).reduce((n, r) => n + slotUnits(r.slots), 0)
  const mine = status ? mineOf(status.holders ?? []) + mineOf(status.line ?? []) : mineOf(state.held) + mineOf(state.line)
  const total = Math.min(state.total, MAX_SLOTS)
  const room = Math.max(0, total - mine)
  const shown = bringCount(count, 1, room)
  const slotsToHold = room >= 1 ? countOf(shown) : null
  const hold = (slots: number) => {
    op({ op: 'user_slot_hold', node: node.id, slots })
      .then(() => { toast([`asked for ${slots === 1 ? 'a concurrency slot' : `${slots} concurrency slots`} of ${node.id}: held when all are free`]); reread() })
      .catch(() => {})
    setCount('1')
  }
  const slotWords = (n: number) => n === 1 ? 'a concurrency slot' : `${n} concurrency slots`
  const holdControl = node.state === 'live' && state.total >= 1 && (
    <DeskCount className="slot-hold" groupLabel="Hold concurrency slots"
      value={shown} min={1} max={Math.max(room, 1)} inputDisabled={room < 1}
      onValue={(text) => setCount(bringCount(text, 1, room))}
      inputLabel="Slots to hold"
      inputTitle={room < 1 ? `the user already holds or waits for every concurrency slot of ${node.id}`
        : `how many concurrency slots to hold at once: 1 to ${room} (${node.id} has ${total}`
          + `${mine ? `, ${mine} of them already held or asked for by the user` : ''})`}
      action="hold-slots" disabled={slotsToHold === null}
      label={slotsToHold === null && room >= 1 ? 'Hold slots' : `Hold ${slotsToHold ?? 1} slot${(slotsToHold ?? 1) === 1 ? '' : 's'}`}
      title={room < 1 ? `every concurrency slot of ${node.id} is already held or asked for by the user: release a hold or cancel a waiting request first`
        : slotsToHold === null ? `choose 1 to ${room} slots`
        : `hold ${slotWords(slotsToHold)} of ${node.id} now. The request waits in its line first come first served, like an agent's claim, `
          + `and is granted whole: ${slotsToHold === 1 ? 'as soon as a slot is free' : `when all ${slotsToHold} are free together`}. `
          + 'The hold lasts until it is released, across a restart too.'}
      onAct={() => { if (slotsToHold !== null) hold(slotsToHold) }} />)
  return (
    <div className="desk-tabpanel project-slots" onScroll={scrollHistory}>
      {(holdControl || actions) && <div className="team-tab-toolbar" role="toolbar" aria-label="Slots view controls">{holdControl}{actions}</div>}
      <div className="slots-table-scroll" role="region" aria-label="Concurrency slot records" tabIndex={0} onScroll={scrollHistory}>
      <table className="slots-table">
        <colgroup><col className="slot-col-position"/><col className="slot-col-agent"/><col className="slot-col-time"/><col className="slot-col-time"/>
          <col className="slot-col-ended"/><col/><col className="slot-col-quantity"/><col className="listener-col-dog"/><col className="slot-col-action"/></colgroup>
        <thead><tr>{['Position', 'Agent', 'Waited', 'Held', 'Ended', 'Lease', 'Slots', 'Watchdog', 'Action'].map(label =>
          <th key={label} scope="col" className={label === 'Action' ? 'slot-action' : undefined}>{label}</th>)}</tr></thead>
      <tbody className="slots-holding">
        <tr className="slot-section"><th colSpan={9} scope="rowgroup"><h4>Holding</h4></th></tr>
        {holders.length === 0 && <tr><td colSpan={9} className="dim slot-empty">Nobody holds a concurrency slot. An agent above or below the project claims one
          with <code>orgtree_watchdog action=create kind=slot target={node.id}</code>; it is granted at once while a concurrency slot is free.</td></tr>}
        {holders.map((h) => (
          <tr key={h.lease} className="slot-row">
            <td className="slot-position"/>
            <th scope="row" className="slot-agent">{agentLink(h.agent)}</th>
            <td className="slot-wait" title={h.queued ? 'in line since ' + h.queued : undefined}>
              {h.queued ? <SlotTime from={h.queued} to={h.since}/> : ''}</td>
            <td className="slot-held" title={'since ' + h.since}><SlotTime from={h.since}/></td>
            <td className="slot-ended"/>
            <td className="slot-rest">{!h.dog && h.reason && <span className="slot-reason">{h.reason}</span>}
              <span className="dim mono slot-lease">{h.lease}</span>
              {(h.reminders ?? 0) > 0 && <span className="dim"> {h.reminders} reminder{h.reminders === 1 ? '' : 's'}</span>}</td>
            <td className="slot-quantity">{slotUnits(h.slots)}</td>
            <td className="listener-dog-cell"><HistoryDog dog={h.dog} className="slot-dog" /></td>
            <td className="slot-action">{isUserName(h.agent)
              ? <button type="button" data-action="release"
                  title={`release all ${slotUnits(h.slots)} slot(s) held: the next in line is granted when all it asks for are free`}
                  onClick={() => releaseOwn(h)}>release</button>
              : <button type="button" className="danger" data-action="force-release"
                  title={`take all ${slotUnits(h.slots)} reserved slot(s) back from ${h.agent}; check the FIFO queue`}
                  onClick={() => setAsking(h)}>force release</button>}</td>
          </tr>
        ))}
      </tbody>
      <tbody className="slots-line">
        <tr className="slot-section"><th colSpan={9} scope="rowgroup"><h4>Line</h4></th></tr>
        {line.length === 0 && <tr><td colSpan={9} className="dim slot-empty">Nobody is waiting.</td></tr>}
        {line.map((w) => {
          const mine = isUserName(w.agent)
          const cells = <>
            <td className="slot-position"><span className="slot-no">{ordinal(w.position)}</span></td>
            <th scope="row" className="slot-agent">{agentLink(w.agent)}</th>
            <td className="slot-wait" title={w.since ? 'in line since ' + w.since : undefined}>
              {w.since ? <SlotTime from={w.since}/> : ''}</td>
            <td className="slot-held" />
            <td className="slot-ended" />
            <td className="slot-rest"/>
            <td className="slot-quantity">{slotUnits(w.slots)}</td>
            <td className="listener-dog-cell">{mine
              // the user's own dog has no detail panel or menu to open: its chip only says what it is
              ? <WatchdogLink dog={userDogOf(w)} className="slot-dog" atDestination />
              : <WatchdogLink id={treeDog(w)?.dog ?? w.dog} owner={w.agent} name={nameOf(w) ?? w.dog} className="slot-dog"/>}</td>
            <td className="slot-action">{mine
              ? <button type="button" data-action="cancel-request" title="cancel this request: it leaves the line and is not granted"
                  onClick={() => cancelOwn(w)}>cancel request</button>
              : <button type="button" data-action="unqueue" title={`remove ${w.agent}'s claim: it leaves the line and is not granted`}
                  onClick={() => {
                    op({ op: 'slot_unqueue', node: node.id, agent: w.agent })
                      .then(() => { toast([`${w.agent} removed from project ${node.id}'s concurrency slot line`]); reread() })
                      .catch(() => {})
                  }}>remove from line</button>}</td>
          </>
          // a watchdog row: away from its links it opens the dog's menu; the
          // user's request has none (its owner is no agent)
          return mine
            ? <tr key={w.agent + w.dog} className="slot-row">{cells}</tr>
            : <WatchdogRow as="tr" key={w.agent + w.dog} id={treeDog(w)?.dog ?? w.dog} className="slot-row">{cells}</WatchdogRow>
        })}
      </tbody>
      <tbody className="slots-history">
        <tr className="slot-section"><th colSpan={9} scope="rowgroup"><h4>Recently Held</h4></th></tr>
        {history.length === 0 && <tr><td colSpan={9} className="dim slot-empty">No concurrency slot has been held yet.</td></tr>}
        {history.map((h) => (
          <tr key={h.lease} className="slot-row">
            <td className="slot-position"/>
            <th scope="row" className="slot-agent">{agentLink(h.agent)}</th>
            <td className="slot-wait" title={h.queued ? 'in line since ' + h.queued : undefined}>
              {h.queued ? <SlotTime from={h.queued} to={h.since}/> : ''}</td>
            <td className="slot-held" title={`held from ${h.since} to ${h.ended ?? '?'}`}><SlotTime from={h.since} to={h.ended}/></td>
            <td className="slot-ended">{h.ended ? <SlotTime from={h.ended} ended/> : ''}</td>
            <td className="slot-rest">{!h.dog && h.reason && <span className="slot-reason">{h.reason}</span>}<span className="dim mono slot-lease">{h.lease}</span></td>
            <td className="slot-quantity">{slotUnits(h.slots)}</td>
            <td className="listener-dog-cell"><HistoryDog dog={h.dog} className="slot-dog" /></td>
            <td className="slot-action slot-how" title={h.how ?? undefined}>{holdEndLabel(h.how)}</td>
          </tr>
        ))}
        {(historyLoading || historyError || status?.history_next) && <tr><td colSpan={9} className="slot-history-more" role="status">
          {historyLoading ? 'Loading older holds…' : historyError ? <>
            Could not load older holds. <button type="button" onClick={loadOlder}>Retry</button>
          </> : 'Scroll for older holds'}
        </td></tr>}
      </tbody>
      </table>
      </div>
      {asking && createPortal(
        <ConfirmModal title={`take ${slotUnits(asking.slots) === 1 ? 'the concurrency slot' : `${slotUnits(asking.slots)} concurrency slots`} of ${node.id} back from ${asking.agent}?`}
          body={`${asking.agent} has held this lease for ${span(asking.since)}${asking.reason ? ` (${asking.reason})` : ''}. `
            + `All ${slotUnits(asking.slots)} reserved slot(s) are released together and recorded as "released (forced by @user)". `
            + 'The FIFO queue is checked; its head is granted only when all requested slots are free.'}
          confirmLabel="force release" close={() => setAsking(null)}
          onConfirm={() => {
            const h = asking
            op({ op: 'slot_release', lease: h.lease, force: true })
              .then(() => { toast([`${slotUnits(h.slots)} concurrency slot(s) of ${node.id} taken back from ${h.agent}`]); reread() })
              .catch(() => {})
          }} />, document.body)}
    </div>
  )
}
