// canvas/slotchips.tsx — an agent's project-slot chips (Orgtree 4.4.0; user
// 2026-10-18 10:52Z-10:52:50Z): a held slot's filled "⬢ build" and a
// waiting claim's "⏳ build 2nd". The agent card wears them in its chip row
// (.sq-badges), never on the status row; the agent desk's header right after
// the estimated-cost chip. On the canvas a waiting claim is already its own
// satellite chip, so the card passes no dogs.

import type { Watchdog } from '../types'
import { ordinal, slotHoldsOf, slotPlace } from './slots'
import type { SlotLease } from './slots'

export function AgentSlotChips({ agent, leases, dogs }: { agent: string; leases: SlotLease[]; dogs?: Watchdog[] }) {
  const holds = slotHoldsOf(agent, leases)
  const waits = (dogs ?? []).filter((w) => w.owner === agent)
    .map((w) => ({ w, place: slotPlace(w, dogs!) })).filter((x) => x.place != null)
  if (!holds.length && !waits.length) return null
  return <>
    {holds.map((l) => (
      <span key={l.lease} className="chip slot-hold"
        title={`holds a concurrency slot of project ${l.project} since ${l.since} (lease ${l.lease})${l.reason ? ': ' + l.reason : ''}`}>
        ⬢ {l.project}</span>
    ))}
    {waits.map(({ w, place }) => (
      <span key={w.id} className="chip slot-wait"
        title={`concurrency slot claim "${w.name}": ${ordinal(place!)} in line for project ${w.target.replace(/^@/, '')}`}>
        ⏳ {w.target.replace(/^@/, '')} {ordinal(place!)}</span>
    ))}
  </>
}
