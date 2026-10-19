// canvas/slotchips.tsx — an agent's project-slot chips (Orgtree 4.4.0; user
// 2026-10-18 10:52Z-10:52:50Z): a held slot's filled "⬢ build" and a
// waiting claim's "⏳ build 2nd". The agent card wears them in its chip row
// (.sq-badges), never on the status row; the agent desk's header right after
// the estimated-cost chip. On the canvas a waiting claim is already its own
// satellite chip, so the card passes no dogs.
//
// Clicking a chip opens that project's slots surface (user 2026-10-19
// 17:18Z), through the same surface route as the project menu's Slots
// entry; without shell routes (tests, surfaces outside OrgCanvas) the
// chip stays a plain span — no dead button. The tooltip is the user's
// short form (2026-10-19 17:20Z): "held since 20:14 from project
// build-slot" / "waiting since 20:14 for project build-slot", local time,
// no lease or reason.

import type { MouseEvent } from 'react'
import type { Watchdog } from '../types'
import { ordinal, slotHoldsOf, slotPlace } from './slots'
import type { SlotLease } from './slots'
import { useAgentSurfaceRoutes } from './panelcorner'

/** "20:14" — the short local time the chip tooltip uses. */
const at = (iso: string): string => {
  const d = new Date(iso)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function AgentSlotChips({ agent, leases, dogs }: { agent: string; leases: SlotLease[]; dogs?: Watchdog[] }) {
  const routes = useAgentSurfaceRoutes()
  const holds = slotHoldsOf(agent, leases)
  const waits = (dogs ?? []).filter((w) => w.owner === agent)
    .map((w) => ({ w, place: slotPlace(w, dogs!) })).filter((x) => x.place != null)
  if (!holds.length && !waits.length) return null
  const open = (project: string) => routes
    ? (e: MouseEvent) => { e.stopPropagation(); routes.open('project-slots', project) }
    : undefined
  return <>
    {holds.map((l) => {
      const title = `held since ${at(l.since)} from project ${l.project}`
      return open(l.project)
        ? <button key={l.lease} type="button" className="chip slot-hold" title={title}
            onClick={open(l.project)}>⬢ {l.project}</button>
        : <span key={l.lease} className="chip slot-hold" title={title}>⬢ {l.project}</span>
    })}
    {waits.map(({ w, place }) => {
      const project = w.target.replace(/^@/, '')
      const title = `waiting since ${at(w.queued_at ?? w.at)} for project ${project}`
      return open(project)
        ? <button key={w.id} type="button" className="chip slot-wait" title={title}
            onClick={open(project)}>⏳ {project} {ordinal(place!)}</button>
        : <span key={w.id} className="chip slot-wait" title={title}>⏳ {project} {ordinal(place!)}</span>
    })}
  </>
}
