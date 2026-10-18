// canvas/slotsdesk.tsx — the project desk's SLOTS tab (Orgtree 4.4.0; docket
// `project-slots-first-come-permits-claimed-through`, mockup approved by the
// user 2026-10-18). Shown only while the project's slot count is at least 1.
// It leads with "k of N slots held" and the holders, then Holding (slot,
// agent, reason, held for, lease, force release), Line (place, agent, reason,
// waiting for, remove from line) and Recent holds (how each ended). The lists
// come from the `slot_status` op, re-read whenever the tree's slots change;
// the buttons are the user's (the desktop's viewer), as the project's
// superior's through the tool.

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ToastFn } from '../types'
import { ago } from './shared'
import type { CanvasNode, OpFn } from './shared'
import { ConfirmModal } from './modals'
import { ordinal, slotLeadText } from './slots'
import type { ProjectSlotState } from './slots'

interface Holder { lease: string; agent: string; slot: number; reason?: string | null; since: string; reminders?: number }
interface Waiter { position: number; agent: string; dog: string; since?: string | null }
interface Hold { lease: string; agent: string; slot: number; reason?: string | null; since: string; ended?: string | null; how?: string | null; by?: string | null }
export interface SlotStatus { project: string; slots: number; held: number; holders: Holder[]; line: Waiter[]; history: Hold[] }

/** How long between two times: "45s", "12m", "1h 4m". */
export function span(from: string, to?: string | null): string {
  const s = Math.max(0, ((to ? Date.parse(to) : Date.now()) - Date.parse(from)) / 1000)
  if (s < 90) return `${Math.round(s)}s`
  if (s < 3600) return `${Math.round(s / 60)}m`
  const m = Math.round(s / 60)
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

export function SlotsView({ node, state, op, toast }: {
  node: CanvasNode; state: ProjectSlotState; op: OpFn; toast: ToastFn
}) {
  const [status, setStatus] = useState<SlotStatus | null>(null)
  const [asking, setAsking] = useState<Holder | null>(null)
  const [bump, setBump] = useState(0)
  // re-read when the tree's holders or line change (a grant, release or claim)
  const sig = state.total + '|' + state.held.map((l) => l.lease).join(',') + '|' + state.line.map((w) => w.dog).join(',')
  useEffect(() => {
    let live = true
    op({ op: 'slot_status', node: node.id })
      .then((r) => { if (live) setStatus(r as unknown as SlotStatus) })
      .catch(() => {})   // `op` toasts the refusal
    return () => { live = false }
  }, [node.id, sig, bump])
  const reread = () => setBump((n) => n + 1)
  const holders = status?.holders ?? []
  const line = status?.line ?? []
  const history = status?.history ?? []
  const total = status?.slots ?? state.total
  // the claim's name is its reason (the line lists its dog; the tree has its name)
  const nameOf = (w: Waiter) => state.line.find((x) => x.agent === w.agent)?.name
  const lead = slotLeadText({ total, held: holders as ProjectSlotState['held'], line: [] })
  return (
    <div className="desk-tabpanel project-slots">
      <div className="slots-lead">{lead}{holders.length > 0 && <>
        {holders.map((h) => <span key={h.lease} className="chip slot-holder">{h.agent}</span>)}</>}
      </div>
      <h4>Holding</h4>
      <div className="slots-holding">
        {holders.length === 0 && <div className="dim">Nobody holds a slot. An agent above or below the project claims one
          with <code>orgtree_watchdog action=create kind=slot target={node.id}</code>; it is granted at once while a slot is free.</div>}
        {holders.map((h) => (
          <div key={h.lease} className="slot-row">
            <span className="slot-no">#{h.slot}</span>
            <span className="slot-agent">{h.agent}</span>
            {h.reason && <span className="slot-reason">{h.reason}</span>}
            <span className="dim" title={'since ' + h.since}>held {span(h.since)}</span>
            <span className="dim mono">lease {h.lease}</span>
            {(h.reminders ?? 0) > 0 && <span className="dim">{h.reminders} reminder{h.reminders === 1 ? '' : 's'}</span>}
            <span className="spacer" />
            <button type="button" className="danger" data-action="force-release"
              title={`take slot ${h.slot} back from ${h.agent}; the next in line gets it at once`}
              onClick={() => setAsking(h)}>force release</button>
          </div>
        ))}
      </div>
      <h4>Line</h4>
      <div className="slots-line">
        {line.length === 0 && <div className="dim">Nobody is waiting.</div>}
        {line.map((w) => (
          <div key={w.agent + w.dog} className="slot-row">
            <span className="slot-no">{ordinal(w.position)}</span>
            <span className="slot-agent">{w.agent}</span>
            {nameOf(w) && <span className="slot-reason">{nameOf(w)}</span>}
            {w.since && <span className="dim" title={'in line since ' + w.since}>waiting {span(w.since)}</span>}
            <span className="spacer" />
            <button type="button" data-action="unqueue" title={`remove ${w.agent}'s claim: it leaves the line and is not granted`}
              onClick={() => {
                op({ op: 'slot_unqueue', node: node.id, agent: w.agent })
                  .then(() => { toast([`${w.agent} removed from project ${node.id}'s slot line`]); reread() })
                  .catch(() => {})
              }}>remove from line</button>
          </div>
        ))}
      </div>
      <h4>Recent holds</h4>
      <div className="slots-history">
        {history.length === 0 && <div className="dim">No slot has been held yet.</div>}
        {history.map((h) => (
          <div key={h.lease} className="slot-row">
            <span className="slot-no">#{h.slot}</span>
            <span className="slot-agent">{h.agent}</span>
            <span className="slot-how">{h.how ?? 'ended'}</span>
            <span className="dim" title={`held from ${h.since} to ${h.ended ?? '?'}`}>
              {span(h.since, h.ended)}{h.ended ? ` · ended ${ago(h.ended)} ago` : ''}</span>
          </div>
        ))}
      </div>
      {asking && createPortal(
        <ConfirmModal title={`take slot ${asking.slot} of ${node.id} back from ${asking.agent}?`}
          body={`${asking.agent} has held it for ${span(asking.since)}${asking.reason ? ` (${asking.reason})` : ''}. `
            + `It is recorded as "released (forced by @user)", ${asking.agent} is told, and `
            + (line[0] ? `the next in line, ${line[0].agent}, gets it at once.` : 'the slot is free again.')}
          confirmLabel="force release" close={() => setAsking(null)}
          onConfirm={() => {
            const h = asking
            op({ op: 'slot_release', lease: h.lease, force: true })
              .then(() => { toast([`slot ${h.slot} of ${node.id} taken back from ${h.agent}`]); reread() })
              .catch(() => {})
          }} />, document.body)}
    </div>
  )
}
