// canvas/maillisteners.tsx — the project inbox's LISTENERS folder (Orgtree
// 4.4.0; docket `project-desk-inbox-new-listeners-sub-tab-next-to`, user
// 2026-10-19 19:05Z-19:33Z): the agents that take the project's mail with a
// `fair_queue` dog, in the order the next mail goes to them, as the slots
// view's table (one aligned table, column headers, values only, times in the
// shared slot time colours).
//
// Everything is the engine's: the tree's watchdogs (state, `at` = created,
// `last_fired`, `fired` = the mails the dog was handed: domain/projects.rs
// bumps it in the hand-out's own transaction) and the project mailbox's rows
// (who holds a job, since when, when it was acked). Not the desk's
// "listeners" tab (listenersdesk.tsx), which lists the EVENT listeners.

import { useSyncExternalStore } from 'react'
import type { Watchdog } from '../types'
import type { CanvasNode, MailRow } from './shared'
import { AgentLink, nodeTierOf } from './identity'
import { useDogRoute } from './deskdogs'
import { ageClockNow, subscribeAgeClock } from './desk'
import type { MailListenerState } from './listeners'
import { ordinal } from './slots'
import { span } from './slotsdesk'
import { slotTimeStyle } from './slottime'
import { fmtFull } from '../timefmt'

/** A stretch of time: open (`to` absent) while it is still going on. */
export interface Stretch { from: string; to?: string }

export interface MailListenerRow {
  dog: Watchdog
  /** its place in the order the next mails go out, 1-based; null while it
   *  takes none */
  position: number | null
  /** why it takes no mail now: paused, its agent is not live, it holds a
   *  job (ack mode) or its agent is halted (ack mode) */
  out: 'paused' | 'gone' | 'holding' | 'halted' | null
  /** the job it holds (ack mode): the project mailbox's copy */
  held: MailRow | null
  /** its most recent wait for mail */
  waited: Stretch | null
  /** its most recent job, hand-out to ack (ack mode only) */
  worked: Stretch | null
}

const time = (at?: string | null) => (at ? Date.parse(at) : NaN)
const later = (a: string, b?: string | null) => (b && time(b) > time(a) ? b : a)

/** handed out, neither acked nor given back (QueueChip's "awaiting ack") */
const awaitingAck = (m: MailRow, owner: string) => {
  const q = m.queue
  return !!q && q.held_by === owner && !!q.ack && !q.acked_at && !q.released && !q.dead_letter && !q.purged
}

/** The engine's own order (`pick` in domain/projects.rs): the least recently
 *  woken first, a dog never fired before any that has, then the oldest dog,
 *  then the lower row; the tree lists dogs by row and this sort is stable.
 *  Its eligibility too: an armed dog of a live agent, and in ack mode one
 *  neither halted nor holding an un-acked job of the project. Those come
 *  first and are numbered; then (ack mode) the holders, then the rest. */
export function mailListenerRows(state: MailListenerState, map: Map<string, CanvasNode>, rows: MailRow[], ack: boolean): MailListenerRow[] {
  const listed = state.listeners.map((w): MailListenerRow => {
    const owner = map.get(w.owner)
    const jobs = rows.filter((m) => m.queue?.held_by === w.owner && m.queue.held_at)
    const held = ack ? jobs.find((m) => awaitingAck(m, w.owner)) ?? null : null
    const acked = jobs.filter((m) => m.queue!.acked_at)
      .sort((a, b) => time(b.queue!.acked_at) - time(a.queue!.acked_at))
    const out = w.state === 'paused' ? 'paused' as const
      : !owner || owner.state !== 'live' ? 'gone' as const
        : held ? 'holding' as const
          : ack && owner.halt ? 'halted' as const : null
    let waited: Stretch | null = null
    let worked: Stretch | null = null
    if (ack) {
      if (held) {
        // its wait ended when this job was handed to it
        const to = held.queue!.held_at!
        const from = later(w.at, acked.find((m) => time(m.queue!.acked_at) <= time(to))?.queue!.acked_at)
        if (time(from) <= time(to)) waited = { from, to }
        worked = { from: to }
      } else {
        const last = acked[0]
        if (out !== 'paused' && out !== 'gone') waited = { from: later(w.at, last?.queue!.acked_at) }
        if (last) worked = { from: last.queue!.held_at!, to: last.queue!.acked_at! }
      }
    } else if (out === null) {
      // round robin: it waits again from its last hand-out
      waited = { from: later(w.at, w.last_fired) }
    }
    return { dog: w, position: null, out, held, waited, worked }
  })
  const rank = (r: MailListenerRow) => (r.out === null ? 0 : r.out === 'holding' ? 1 : 2)
  const key = (w: Watchdog) => [w.last_fired ? time(w.last_fired) : -Infinity, time(w.at)]
  const ordered = [...listed].sort((a, b) => {
    const ka = key(a.dog), kb = key(b.dog)
    return rank(a) - rank(b) || ka[0]! - kb[0]! || ka[1]! - kb[1]!
  })
  let n = 0
  for (const r of ordered) if (r.out === null) r.position = ++n
  return ordered
}

const OUT_LABEL: Record<NonNullable<MailListenerRow['out']>, string> = {
  paused: 'paused', gone: 'not live', holding: '', halted: 'halted',
}
const OUT_TITLE: Record<NonNullable<MailListenerRow['out']>, string> = {
  paused: 'its fair_queue watchdog is paused: it takes no mail until resumed',
  gone: 'its agent is not live: it takes no mail',
  holding: '',
  halted: 'its agent is halted: in ack mode a halted listener is handed nothing',
}

/** a stretch, coloured by its length on the shared slot time scale; an open
 *  one counts up with the shared second clock */
function ListenerTime({ from, to }: Stretch) {
  const seconds = Math.max(0, ((to ? Date.parse(to) : Date.now()) - Date.parse(from)) / 1000)
  return <span className={'slot-time' + (to ? '' : ' live')} style={slotTimeStyle(seconds)}
    title={to ? `${fmtFull(from)} to ${fmtFull(to)}` : `since ${fmtFull(from)}, still going`}>{span(from, to)}</span>
}

export function MailListenersView({ node, state, map, onJump, rows, ack, onOpenMail }: {
  node: CanvasNode
  state: MailListenerState
  map: Map<string, CanvasNode>
  onJump?: (id: string) => void
  /** the project mailbox's loaded rows, waiting and delivered */
  rows: MailRow[]
  /** the project's mail queue is in ack mode */
  ack: boolean
  /** open one of the project's mails in its inbox */
  onOpenMail?: (id: string) => void
}) {
  useSyncExternalStore(subscribeAgeClock, ageClockNow, ageClockNow)
  const route = useDogRoute()
  const list = mailListenerRows(state, map, rows, ack)
  const cols = ['Position', 'Agent', 'Waited', ...(ack ? ['Worked', 'Mail'] : []), 'Handed', 'Watchdog']
  const dogName = (w: Watchdog) => route
    ? <button type="button" className="listener-dog" title={`watchdog "${w.name}" (${w.kind}) — ${w.state}; click for detail`}
        onClick={() => route.open(w.id)}>{w.name}</button>
    : <span className="listener-dog">{w.name}</span>
  return (
    <div className="project-mail-listeners">
      <div className="slots-table-scroll" role="region" aria-label={`Mail listeners of project ${node.id}`} tabIndex={0}>
        <table className="slots-table mail-listeners-table">
          <colgroup><col className="slot-col-position"/><col className="slot-col-agent"/><col className="slot-col-time"/>
            {ack && <><col className="slot-col-time"/><col className="listener-col-mail"/></>}
            <col className="listener-col-handed"/><col className="listener-col-dog"/></colgroup>
          <thead><tr>{cols.map((label) => <th key={label} scope="col">{label}</th>)}</tr></thead>
          <tbody>
            {list.length === 0 && <tr><td colSpan={cols.length} className="dim slot-empty">Nobody listens for {node.id}'s mail,
              so it waits in the inbox. An agent above or below the project starts listening
              with <code>orgtree_watchdog action=create kind=fair_queue target={node.id}</code>; each waiting mail then
              goes to one listener, the least recently woken first.</td></tr>}
            {list.map((r) => (
              <tr key={r.dog.id} className={'slot-row listener-row' + (r.out === 'holding' ? ' holding' : r.out ? ' out' : '')}>
                <td className="slot-position" title={r.out ? OUT_TITLE[r.out] || undefined : undefined}>
                  {r.position ? <span className="slot-no">{ordinal(r.position)}</span>
                    : r.out ? <span className="dim">{OUT_LABEL[r.out]}</span> : null}</td>
                <th scope="row" className="slot-agent">
                  <AgentLink id={r.dog.owner} tier={nodeTierOf(map.get(r.dog.owner))} onFocus={onJump} /></th>
                <td className="slot-wait">{r.waited && <ListenerTime {...r.waited} />}</td>
                {ack && <td className="slot-held">{r.worked && <ListenerTime {...r.worked} />}</td>}
                {ack && <td className="listener-mail">{r.held && (
                  <button type="button" className="listener-mail-link" data-mail={r.held.id}
                    title={`${r.dog.owner} holds this job until it acks it (from ${r.held.from}); click to read it in the inbox`}
                    onClick={() => onOpenMail?.(r.held!.id)}>{r.held.body.split('\n')[0] || r.held.id}</button>)}</td>}
                <td className="listener-handed" title="mails this listener's watchdog has been handed (engine count)">{r.dog.fired}</td>
                <td className="listener-dog-cell">{dogName(r.dog)}
                  {r.dog.once && <span className="dim"> one-shot</span>}{r.dog.notice && <span className="dim"> passive</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
