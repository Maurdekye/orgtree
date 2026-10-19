// canvas/listenersdesk.tsx — the project desk's LISTENERS tab (Orgtree
// 4.4.0; docket `project-event-listeners-sync-monitor-watchdogs-l`, user
// 2026-10-19). On every project desk, empty or not (user 21:19:48Z: a tab
// that comes and goes with the dogs keeps turning off and on). It lists the
// event listeners and listener watches from the tree's watchdogs, and
// carries the fire control: the same `fire_project_event` op the agents'
// `orgtree_project action=fire_event` runs, with an optional message for
// the listeners.
//
// The list is ONE table like the slots tab's and the inbox's mail listeners
// (user 2026-10-19 21:08Z-21:11Z): a header row, the two kinds as section
// rows, values only, and only the columns that carry data. The watchdog
// column is the shared watchdog chip, whose outline tells one-shot from
// continuous (its tooltip and detail name the mode, so the table writes no
// mode words). Fired and Last fired stay empty for one-shot dogs, which go
// once they fire; Last fired is the slots table's Ended time, or a dash.
// Armed (a watch's armed listeners over its count) shows while a watch is
// listed, On fire (the tool calls a dog runs) while any dog has them.

import { useState, useSyncExternalStore } from 'react'
import type { ToastFn, Watchdog } from '../types'
import type { CanvasNode, OpFn } from './shared'
import { AgentLink, nodeTierOf } from './identity'
import { WatchdogRow } from './deskdogs'
import { WatchdogLink } from './watchdoglink'
import { ageClockNow, subscribeAgeClock } from './desk'
import { fireActionTools, projectListenerState } from './listeners'
import { SlotTime } from './slotsdesk'
import { fmtFull } from '../timefmt'

export function ListenersView({ node, dogs, map, onJump, op, toast }: {
  node: CanvasNode; dogs: Watchdog[]; map: Map<string, CanvasNode>
  onJump?: (id: string) => void; op: OpFn; toast: ToastFn
}) {
  useSyncExternalStore(subscribeAgeClock, ageClockNow, ageClockNow)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const state = projectListenerState(node.id, dogs)
  const live = node.state === 'live'
  const watching = state.watches.length > 0
  const firing = [...state.listeners, ...state.watches].some((w) => fireActionTools(w).length > 0)
  const cols = ['Agent', 'Watchdog', ...(watching ? ['Armed'] : []), 'Fired', 'Last fired', ...(firing ? ['On fire'] : [])]
  const fire = () => {
    if (busy || !live) return
    setBusy(true)
    op({ op: 'fire_project_event', node: node.id, ...(text.trim() ? { body: text.trim() } : {}) })
      .then((r) => {
        const n = (r as { listeners_armed?: number }).listeners_armed ?? state.armed.length
        toast([`fired project ${node.id}'s event to ${n} listener${n === 1 ? '' : 's'}`])
        setText('')
      })
      .catch(() => {})   // `op` toasts the refusal
      .finally(() => setBusy(false))
  }
  const row = (w: Watchdog, watch: boolean) => {
    const tools = fireActionTools(w)
    return (
      // a watchdog row: away from its links it opens the dog's menu, as the
      // slots line and the mail listeners do; the agent link and chip keep theirs
      <WatchdogRow as="tr" key={w.id} id={w.id} className={'slot-row listener-row' + (w.state === 'paused' ? ' out' : '')}>
        <th scope="row" className="slot-agent">
          <AgentLink id={w.owner} tier={nodeTierOf(map.get(w.owner))} onFocus={onJump} /></th>
        <td className="listener-dog-cell"><WatchdogLink dog={w} className="listener-dog" />
          {w.state === 'paused' && <span className="dim"> paused</span>}{w.notice && <span className="dim"> passive</span>}</td>
        {watching && <td className="listener-count"
          title={watch ? `${state.armed.length} of ${w.count ?? '?'} event listeners armed; the watch fires when ${w.count ?? '?'} are` : undefined}>
          {watch ? `${state.armed.length}/${w.count ?? '?'}` : null}</td>}
        <td className="listener-fired">{w.once ? null : w.fired}</td>
        <td className="slot-ended listener-last" title={!w.once && w.last_fired ? `last fired ${fmtFull(w.last_fired)}` : undefined}>
          {w.once ? null : w.last_fired ? <SlotTime from={w.last_fired} ended /> : <span className="dim">—</span>}</td>
        {firing && <td className="listener-actions"
          title={tools.length ? 'tool calls this watchdog runs as its owner when it fires; results ride its fire mail' : undefined}>
          {tools.join(', ')}</td>}
      </WatchdogRow>
    )
  }
  return (
    <div className="desk-tabpanel project-listeners">
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
      <div className="slots-table-scroll" role="region" aria-label={`Event listeners of project ${node.id}`} tabIndex={0}>
        <table className="slots-table listeners-table">
          <colgroup><col className="slot-col-agent"/><col className="listener-col-dog"/>
            {watching && <col className="listener-col-count"/>}<col className="listener-col-fired"/><col className="slot-col-ended"/>
            {firing && <col className="listener-col-actions"/>}</colgroup>
          <thead><tr>{cols.map((label) => <th key={label} scope="col">{label}</th>)}</tr></thead>
          <tbody className="listeners-events">
            <tr className="slot-section"><th colSpan={cols.length} scope="rowgroup"><h4>Event listeners</h4></th></tr>
            {state.listeners.length === 0 && <tr><td colSpan={cols.length} className="dim slot-empty">No agent listens on this
              project. An agent above or below it arms one
              with <code>orgtree_watchdog action=create kind=project_listener target={node.id} once=true</code> and
              is woken when the event fires.</td></tr>}
            {state.listeners.map((w) => row(w, false))}
          </tbody>
          <tbody className="listeners-watches">
            <tr className="slot-section"><th colSpan={cols.length} scope="rowgroup"><h4>Listener watches</h4></th></tr>
            {state.watches.length === 0 && <tr><td colSpan={cols.length} className="dim slot-empty">No listener watch is armed.
              A watch fires when a set number of listeners are armed — with a fire action it releases the whole group at once:
              <code> orgtree_watchdog action=create kind=listener_watch target={node.id} count=N once=true</code>.</td></tr>}
            {state.watches.map((w) => row(w, true))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
