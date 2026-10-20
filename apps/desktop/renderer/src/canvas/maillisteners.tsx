// canvas/maillisteners.tsx — the project Mail tab's LISTENERS folder (Orgtree
// 4.4.0; docket `project-desk-inbox-new-listeners-sub-tab-next-to`, user
// 2026-10-19 19:05Z-19:33Z; rebuilt for
// `project-desk-mail-event-listeners-and-slots-tabs`, user 2026-10-20
// 06:22Z-06:42Z): the agents that take the project's mail with a
// `fair_queue` dog, as consecutive sections of one aligned table, like the
// Slots tab:
//
//   ack mode     Working (one row per held job, with its take back), Line,
//                Dead Letter Line (while a dead-letter listener reaches the
//                project), Recently Finished (acked, failed, taken back and
//                dead-lettered jobs, each ending marked by kind)
//   round-robin  Line, Dead Letter Line, Recently Delivered
//
// The columns keep the desk tables' one order (Position · Agent · Waited ·
// Held · Acked/Delivered · Mail · Ack · Batch · Handed · Watchdog · Action)
// and the slots table's widths; times wear the shared slot time colours.
// The table fits the desk at its normal widths, and a name, gist or ending
// word it shortens keeps its whole text in a tooltip (user 2026-10-20
// 09:00Z; styles.css, desktablelayout.test.tsx).
// Working and the history are the engine's `mail_queue_history` (older
// pages load as you scroll, as the Slots tab's Recently Held); the Line is
// the tree's fair_queue dogs in the engine's pick order, each waiting since
// its arming, last hand-out or freed job. Not the desk's Listeners tab
// (listenersdesk.tsx), which lists the EVENT listeners.

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode, UIEvent } from 'react'
import { createPortal } from 'react-dom'
import type { ToastFn, Watchdog } from '../types'
import type { CanvasNode, MailRow, OpFn } from './shared'
import { AgentLink, nodeTierOf } from './identity'
import { useDogRoute, WatchdogRow } from './deskdogs'
import { WatchdogLink } from './watchdoglink'
import { ageClockNow, subscribeAgeClock } from './desk'
import { deadLetterListeners } from './listeners'
import type { MailListenerState } from './listeners'
import { ordinal } from './slots'
import { span, SlotTime } from './slotsdesk'
import { slotTimeStyle } from './slottime'
import { ConfirmModal } from './modals'
import { HistoryDog } from './historydog'
import { useLoadWhenSeen } from './loadmore'
import type { DogIdentity } from './historydog'
import { fmtFull } from '../timefmt'

/** A stretch of time: open (`to` absent) while it is still going on. */
export interface Stretch { from: string; to?: string }

/** A job a listener holds now (ack mode's Working; engine `queue_history`). */
export interface WorkingJob {
  mail: string; gist?: string; copy?: string | null; agent: string; dog?: DogIdentity | null
  attempts?: number; waited_from?: string | null; held_at?: string | null
}
/** A handed job that ended (Recently Finished). */
export interface FinishedJob {
  id: number; mail: string; gist?: string | null; copy?: string | null; agent: string; dog?: DogIdentity | null
  how: 'acked' | 'failed' | 'taken_back' | 'dead_letter' | string; why?: string | null; attempt?: number | null
  waited_from?: string | null; held_at?: string | null; ended_at: string; ack?: string | null; ack_gist?: string | null
}
/** A hand-out (Recently Delivered, round-robin). */
export interface DeliveredJob {
  id: number; copy: string; agent: string; mail: string; gist?: string; dog?: DogIdentity | null
  held_at: string; waited_from?: string | null
}
export interface MailHistory {
  project: string; ack: boolean; max_attempts?: number; dead_letters?: boolean
  working?: WorkingJob[]; history: (FinishedJob | DeliveredJob)[]; history_next?: string | null
  /** with the first page: the Dead Letter Line, in dog order (the tree's
   *  generic watchdogs are an eight-per-owner preview) */
  dead_letter_listeners?: Watchdog[]
}

export interface MailListenerRow {
  dog: Watchdog
  /** its place in the order the next mails go out, 1-based; null while it
   *  takes none */
  position: number | null
  /** why it takes no mail now: paused, its agent is not live, it holds as
   *  many jobs as its batch (ack mode; it is in Working) or its agent is
   *  halted (ack mode) */
  out: 'paused' | 'gone' | 'holding' | 'halted' | null
  /** the jobs it holds now (ack mode) */
  holding: number
  /** its open wait for mail, from its arming, last hand-out or freed job */
  waited: Stretch | null
}

const time = (at?: string | null) => (at ? Date.parse(at) : NaN)
const latest = (...at: (string | null | undefined)[]) =>
  at.filter((t): t is string => !!t && !Number.isNaN(time(t))).sort((a, b) => time(b) - time(a))[0]

/** The last ack among the loaded mailbox rows: where a listener armed before
 *  the engine kept `freed_at` began waiting again. */
function lastAck(rows: MailRow[], owner: string): string | undefined {
  return latest(...rows.filter((m) => m.queue?.held_by === owner).map((m) => m.queue!.acked_at))
}

/** The Line, in the engine's own order (`pick` in domain/projects.rs): the
 *  least recently woken first, a dog never fired before any that has, then
 *  the oldest dog, then the lower row; the tree lists dogs by row and this
 *  sort is stable. Its eligibility too: an armed dog of a live agent, and in
 *  ack mode one neither halted nor holding its batch. Those come first and
 *  are numbered; then (ack mode) the holders, then the rest. `working` is
 *  the engine's held jobs. */
export function mailListenerRows(state: MailListenerState, map: Map<string, CanvasNode>, working: WorkingJob[], ack: boolean,
  rows: MailRow[] = []): MailListenerRow[] {
  const listed = state.listeners.map((w): MailListenerRow => {
    const owner = map.get(w.owner)
    const holding = ack ? working.filter((j) => j.agent === w.owner).length : 0
    const out = w.state === 'paused' ? 'paused' as const
      : !owner || owner.state !== 'live' ? 'gone' as const
        : ack && holding >= (w.batch ?? 1) ? 'holding' as const
          : ack && owner.halt ? 'halted' as const : null
    const since = latest(w.at, w.last_fired, w.freed_at, ack ? lastAck(rows, w.owner) : undefined) ?? w.at
    const waited = out === null || out === 'halted' ? { from: since } : null
    return { dog: w, position: null, out, holding, waited }
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

/** How a Recently Finished job ended, in a word (none for an ack) and in
 *  its highlight class. */
export const ENDING_WORD: Record<string, string> = { acked: '', failed: 'failed', taken_back: 'taken back', dead_letter: 'dead letter' }
/** an ending's tooltip: its word first, so a word a narrow desk shortens
 *  stays readable (user 2026-10-20 09:00Z) */
const endingTitle = (h: FinishedJob, maxAttempts: number) => `${ENDING_WORD[h.how] ?? h.how}: `
  + `${h.agent} ${h.why ?? ''}${h.attempt ? ` (attempt ${h.attempt} of ${maxAttempts})` : ''}`.trim()
const endingClass = (how: string) => how === 'dead_letter' ? ' ending-dead' : how === 'acked' ? '' : ' ending-failed'

/** a stretch, coloured by its length on the shared slot time scale; an open
 *  one counts up with the shared second clock */
function ListenerTime({ from, to }: Stretch) {
  const seconds = Math.max(0, ((to ? Date.parse(to) : Date.now()) - Date.parse(from)) / 1000)
  return <span className={'slot-time' + (to ? '' : ' live')} style={slotTimeStyle(seconds)}
    title={to ? `${fmtFull(from)} to ${fmtFull(to)}` : `since ${fmtFull(from)}, still going`}>{span(from, to)}</span>
}

/** how long ago, as the slots table's Ended */
function Ago({ at, what }: { at: string; what: string }) {
  return <span title={`${what} ${fmtFull(at)}`}><SlotTime from={at} ended /></span>
}

function uniqueRows<T extends { id: number }>(rows: T[]): T[] {
  const seen = new Set<number>()
  return rows.filter((r) => !seen.has(r.id) && !!seen.add(r.id))
}

export function MailListenersView({ node, state, map, onJump, rows, ack, onOpenMail, op, toast, dogs }: {
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
  /** the engine's history reads and the take back */
  op?: OpFn
  toast?: ToastFn
  /** the tree's watchdogs, for the Dead Letter Line (else the desk's dogs) */
  dogs?: Watchdog[]
}) {
  useSyncExternalStore(subscribeAgeClock, ageClockNow, ageClockNow)
  const route = useDogRoute()
  const [hist, setHist] = useState<MailHistory | null>(null)
  const [bump, setBump] = useState(0)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const [asking, setAsking] = useState<WorkingJob | null>(null)
  const generation = useRef(0), busy = useRef(false)
  // the host may hand a new `op` each render: read through a ref, so only
  // the queue's own moves re-read
  const opRef = useRef(op); opRef.current = op
  // the tree's own dead-letter listeners: the Dead Letter Line from an
  // engine that sends none, and a sign to re-read one that does
  const treeDogs = dogs ?? route?.dogs ?? []
  const treeDead = deadLetterListeners(node.id, treeDogs, map)
  // re-read when a hand-out, an ack, a failure or the mode moves the queue,
  // or a dead-letter listener may have come or gone (one past its owner's
  // tree preview moves only the owner's count)
  const sig = [ack, node.mail_pending ?? 0, node.mail_held ?? 0, node.dead_letters ?? 0,
    ...state.listeners.map((w) => `${w.id}:${w.fired}:${w.freed_at ?? ''}:${w.state}`),
    ...treeDead.map((w) => `${w.id}:${w.state}`),
    ...Object.entries(route?.counts ?? {}).map(([owner, c]) => `${owner}:${c.total}`)].join('|')
  useEffect(() => {
    const op = opRef.current
    if (!op) return
    let live = true
    generation.current++; busy.current = false
    setLoading(false); setFailed(false)
    op({ op: 'mail_queue_history', node: node.id })
      .then((r) => { if (live) setHist((previous) => {
        const next = (r ?? null) as unknown as MailHistory | null
        if (!next || !Array.isArray(next.history)) return next ? { ...next, history: [] } : null
        // keep the pages already read under a live head that overlaps them
        if (!previous || previous.ack !== next.ack) return next
        const overlap = next.history.some((h) => previous.history.some((o) => o.id === h.id))
        return overlap ? { ...next, history: uniqueRows([...next.history, ...previous.history]) as MailHistory['history'],
          history_next: previous.history_next } : next
      }) })
      .catch(() => {})   // `op` toasts the refusal
    return () => { live = false; generation.current++ }
  }, [node.id, sig, bump])
  const loadOlder = () => {
    const before = hist?.history_next
    const op = opRef.current
    if (!op || !before || busy.current) return
    const epoch = generation.current
    busy.current = true; setLoading(true); setFailed(false)
    op({ op: 'mail_queue_history', node: node.id, history_before: before })
      .then((r) => {
        if (generation.current !== epoch) return
        const page = (r ?? {}) as unknown as Partial<MailHistory>
        setHist((previous) => previous?.history_next === before ? {
          ...previous, history: uniqueRows([...previous.history, ...(page.history ?? [])]) as MailHistory['history'],
          history_next: page.history_next ?? null,
        } : previous)
      })
      .catch(() => { if (generation.current === epoch) setFailed(true) })
      .finally(() => { if (generation.current === epoch) { busy.current = false; setLoading(false) } })
  }
  const onScroll = (event: UIEvent<HTMLDivElement>) => {
    const el = event.target as HTMLElement
    if (el.scrollHeight > el.clientHeight && el.scrollHeight - el.clientHeight - el.scrollTop < 160) loadOlder()
  }
  const moreRef = useRef<HTMLTableRowElement>(null)
  useLoadWhenSeen(moreRef, hist?.history_next, loadOlder)
  const working = ack ? hist?.working ?? [] : []
  const list = mailListenerRows(state, map, working, ack, rows)
  const line = list.filter((r) => r.out !== 'holding')
  // the engine's Dead Letter Line, each dog drawn from the tree while it has it
  const deadListeners = hist?.dead_letter_listeners
    ? hist.dead_letter_listeners.map((w) => treeDogs.find((d) => d.id === w.id && !d.metadata_only) ?? w)
    : treeDead
  const history = hist && hist.ack === ack ? hist.history : []
  const cols = ['Position', 'Agent', 'Waited', ...(ack ? ['Held', 'Acked'] : ['Delivered']), 'Mail', ...(ack ? ['Ack'] : []),
    'Batch', 'Handed', 'Watchdog', ...(ack ? ['Action'] : [])]
  const n = cols.length
  const dogOf = (agent: string) => state.listeners.find((w) => w.owner === agent)
  const agentLink = (id: string) => <AgentLink id={id} tier={nodeTierOf(map.get(id))} onFocus={onJump} />
  const mailLink = (id: string | null | undefined, text: string | null | undefined, title: string) => id
    ? <button type="button" className="listener-mail-link" data-mail={id} title={text ? `“${text}” — ${title}` : title}
        onClick={() => onOpenMail?.(id)}>{text || id}</button>
    : null
  const listenerDog = (w: Watchdog) => <WatchdogLink dog={w} className="listener-dog" onOpen={route?.open} />
  const section = (title: string, cls: string, body: ReactNode) => (
    <tbody className={cls}>
      <tr className="slot-section"><th colSpan={n} scope="rowgroup"><h4>{title}</h4></th></tr>
      {body}
    </tbody>
  )
  const empty = (text: ReactNode) => <tr><td colSpan={n} className="dim slot-empty">{text}</td></tr>
  const takeBack = (job: WorkingJob) => {
    if (!op) return
    op({ op: 'mail_take_back', node: node.id, mail: job.mail })
      .then((r) => {
        const dead = (r as { dead_letter?: boolean }).dead_letter
        toast?.([dead ? `took ${job.mail} back from ${job.agent}: it used its last attempt and went to project ${node.id}'s dead letters`
          : `took ${job.mail} back from ${job.agent}: it is first in project ${node.id}'s queue, for another listener first`])
        setBump((b) => b + 1)
      })
      .catch(() => {})
  }
  const maxAttempts = hist?.max_attempts ?? 3
  return (
    <div className="project-mail-listeners" onScroll={onScroll}>
      <div className="slots-table-scroll" role="region" aria-label={`Mail listeners of project ${node.id}`} tabIndex={0} onScroll={onScroll}>
        <table className={'slots-table mail-listeners-table' + (ack ? ' ack' : ' round-robin')}>
          <colgroup><col className="slot-col-position"/><col className="slot-col-agent"/><col className="slot-col-time"/>
            {ack && <col className="slot-col-time"/>}<col className="slot-col-ended"/>
            <col className="listener-col-mail"/>{ack && <col className="listener-col-mail"/>}
            <col className="slot-col-quantity"/><col className="listener-col-fired"/><col className="listener-col-dog"/>
            {ack && <col className="slot-col-action"/>}</colgroup>
          <thead><tr>{cols.map((label) => <th key={label} scope="col" className={label === 'Action' ? 'slot-action' : undefined}>{label}</th>)}</tr></thead>
          {ack && section('Working', 'mail-working', <>
            {working.length === 0 && empty('Nobody is working on a mail of this project.')}
            {working.map((j) => {
              const w = dogOf(j.agent)
              return (
                <tr key={j.mail} className="slot-row listener-row held-job">
                  <td className="slot-position"/>
                  <th scope="row" className="slot-agent">{agentLink(j.agent)}</th>
                  <td className="slot-wait">{j.waited_from && j.held_at && <ListenerTime from={j.waited_from} to={j.held_at} />}</td>
                  <td className="slot-held">{j.held_at && <ListenerTime from={j.held_at} />}</td>
                  <td className="slot-ended"/>
                  <td className="listener-mail">{mailLink(j.mail, j.gist,
                    `${j.agent} holds this job until it acks it; click to read it in the inbox`)}</td>
                  <td className="listener-ack"/>
                  <td className="listener-batch" title="maximum messages per batch and unacked mails in ACK mode">{w ? w.batch ?? 1 : ''}</td>
                  <td className="listener-handed" title="mails this listener's watchdog has been handed (engine count)">{w?.fired ?? ''}</td>
                  <td className="listener-dog-cell">{w ? listenerDog(w) : <HistoryDog dog={j.dog} className="listener-dog" />}</td>
                  <td className="slot-action"><button type="button" className="danger" data-action="take-back"
                    title={`take this job back from ${j.agent}: it goes to the front of the queue, for another listener first`}
                    onClick={() => setAsking(j)}>take back</button></td>
                </tr>
              )
            })}
          </>)}
          {section('Line', 'mail-line', <>
            {state.listeners.length === 0 && empty(<>Nobody listens for {node.id}'s mail,
              so it waits in the inbox. An agent above or below the project starts listening
              with <code>orgtree_watchdog action=create kind=fair_queue target={node.id}</code>; each waiting mail then
              goes to one listener, the least recently woken first.</>)}
            {state.listeners.length > 0 && line.length === 0 && empty('Every listener is working on its batch.')}
            {line.map((r) => (
              // a watchdog row: away from its links it opens the dog's menu, as the
              // listeners and slots rows do; the agent link keeps its own
              <WatchdogRow as="tr" key={r.dog.id} id={r.dog.id} className={'slot-row listener-row' + (r.out ? ' out' : '')}>
                <td className="slot-position" title={r.out ? OUT_TITLE[r.out] || undefined : undefined}>
                  {r.position ? <span className="slot-no">{ordinal(r.position)}</span>
                    : r.out ? <span className="dim">{OUT_LABEL[r.out]}</span> : null}</td>
                <th scope="row" className="slot-agent">{agentLink(r.dog.owner)}</th>
                <td className="slot-wait">{r.waited && <ListenerTime {...r.waited} />}</td>
                {ack && <td className="slot-held"/>}
                <td className="slot-ended"/>
                <td className="listener-mail"/>
                {ack && <td className="listener-ack"/>}
                <td className="listener-batch" title="maximum messages per batch and unacked mails in ACK mode">{r.dog.batch ?? 1}</td>
                <td className="listener-handed" title="mails this listener's watchdog has been handed (engine count)">{r.dog.fired}</td>
                <td className="listener-dog-cell">{listenerDog(r.dog)}{r.dog.notice && <span className="dim"> passive</span>}</td>
                {ack && <td className="slot-action"/>}
              </WatchdogRow>
            ))}
          </>)}
          {deadListeners.length > 0 && section('Dead Letter Line', 'mail-dead-line', deadListeners.map((w) => (
            <WatchdogRow as="tr" key={w.id} id={w.id} className={'slot-row listener-row dead-listener' + (w.state === 'paused' ? ' out' : '')}>
              <td className="slot-position" title={w.state === 'paused' ? 'its dead-letter watchdog is paused: it is told of nothing until resumed' : undefined}>
                {w.state === 'paused' ? <span className="dim">paused</span> : null}</td>
              <th scope="row" className="slot-agent">{agentLink(w.owner)}</th>
              <td className="slot-wait">{w.state === 'armed' && <ListenerTime from={latest(w.at, w.last_fired) ?? w.at} />}</td>
              {ack && <td className="slot-held"/>}
              <td className="slot-ended" title={!w.once && w.last_fired ? `last told of a dead letter ${fmtFull(w.last_fired)}` : undefined}>
                {w.once ? null : w.last_fired ? <SlotTime from={w.last_fired} ended /> : <span className="dim">—</span>}</td>
              <td className="listener-mail"/>
              {ack && <td className="listener-ack"/>}
              <td className="listener-batch"/>
              <td className="listener-handed" title="times this dead-letter watchdog has fired">{w.once ? null : w.fired}</td>
              <td className="listener-dog-cell">{listenerDog(w)}{w.notice && <span className="dim"> passive</span>}</td>
              {ack && <td className="slot-action"/>}
            </WatchdogRow>
          )))}
          {section(ack ? 'Recently Finished' : 'Recently Delivered', 'mail-history', <>
            {history.length === 0 && empty(ack ? 'No mail of this project has finished yet.' : 'No mail of this project has been delivered yet.')}
            {ack ? (history as FinishedJob[]).map((h) => (
              <tr key={h.id} className={'slot-row listener-row finished' + endingClass(h.how)} data-ending={h.how}>
                <td className="slot-position"/>
                <th scope="row" className="slot-agent">{agentLink(h.agent)}</th>
                <td className="slot-wait">{h.waited_from && h.held_at && <ListenerTime from={h.waited_from} to={h.held_at} />}</td>
                <td className="slot-held">{h.held_at && <ListenerTime from={h.held_at} to={h.ended_at} />}</td>
                <td className="slot-ended"><Ago at={h.ended_at} what={h.how === 'acked' ? 'acked' : 'ended'} /></td>
                <td className="listener-mail">{mailLink(h.mail, h.gist, `the job ${h.agent} was handed; click to read it in the inbox`)}</td>
                <td className="listener-ack">{h.how === 'acked'
                  ? mailLink(h.ack, h.ack_gist, `${h.agent}'s ack of it; click to read it in the inbox`)
                  : <span className={'ending-word ending-' + h.how} title={endingTitle(h, maxAttempts)}>
                      {ENDING_WORD[h.how] ?? h.how}</span>}</td>
                <td className="listener-batch"/>
                <td className="listener-handed"/>
                <td className="listener-dog-cell"><HistoryDog dog={h.dog} className="listener-dog" /></td>
                <td className="slot-action"/>
              </tr>
            )) : (history as DeliveredJob[]).map((h) => (
              <tr key={h.id} className="slot-row listener-row delivered">
                <td className="slot-position"/>
                <th scope="row" className="slot-agent">{agentLink(h.agent)}</th>
                <td className="slot-wait">{h.waited_from && <ListenerTime from={h.waited_from} to={h.held_at} />}</td>
                <td className="slot-ended"><Ago at={h.held_at} what="delivered" /></td>
                <td className="listener-mail">{mailLink(h.mail, h.gist, `the mail ${h.agent} was handed; click to read it in the inbox`)}</td>
                <td className="listener-batch"/>
                <td className="listener-handed"/>
                <td className="listener-dog-cell"><HistoryDog dog={h.dog} className="listener-dog" /></td>
              </tr>
            ))}
            {(loading || failed || hist?.history_next) && <tr ref={moreRef}><td colSpan={n} className="slot-history-more" role="status">
              {loading ? 'Loading older mail…' : failed ? <>
                Could not load older mail. <button type="button" onClick={loadOlder}>Retry</button>
              </> : 'Scroll for older mail'}
            </td></tr>}
          </>)}
        </table>
      </div>
      {asking && createPortal(
        <ConfirmModal title={`take this job back from ${asking.agent}?`}
          body={`${asking.agent} has held it for ${asking.held_at ? span(asking.held_at) : 'a while'}${asking.gist ? ` (“${asking.gist}”)` : ''}. `
            + `It goes back to the front of project ${node.id}'s queue, and another listener takes it first`
            + `${(asking.attempts ?? 0) >= maxAttempts && hist?.dead_letters !== false ? '; it has used its last attempt, so it goes to the dead letters instead' : ''}. `
            + `${asking.agent} is told to stop; its ack of it is refused.`}
          confirmLabel="take back" close={() => setAsking(null)}
          onConfirm={() => takeBack(asking)} />, document.body)}
    </div>
  )
}
