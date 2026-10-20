// canvas/deskdogs.tsx — a jump card on an agent's desk for each of its
// watchdogs (user request 2026-09-29, docket
// v3-desk-jump-cards-add-a-card-per-watchdog-that).
//
// The desk's bottom row already carries one card per direct report (NavChip in
// desk.tsx). A watchdog was only reachable from its satellite chip on the
// canvas — which is hidden at compact zoom, off screen from a pinned desk, and
// absent altogether from the Attention view. These cards sit in the same row,
// in the same chip style, and open the SAME detail modal the satellite chip
// opens: the canvas hands its existing route down (as AgentSurfaceRoutes does
// for the desk's tab modals), so there is no second way to open a watchdog.
import type { Watchdog } from '../types'
import type { ReactNode } from 'react'
import { useContextMenu } from './contextmenu'
import { agentNavElementAt } from './agentnav'
import { objectNavProps } from './objectnav'
import { WatchdogLink } from './watchdoglink'
import { useDogRoute } from './watchdogroute'
export { DeskDogsProvider, useDogRoute } from './watchdogroute'
export type { DeskDogs } from './watchdogroute'

/** Row whitespace borrows the dog menu; a nested agent link keeps its own menu. */
export function WatchdogRow({id,org,children,className,as:Tag='div'}:{id:string;org?:string;children:ReactNode;className?:string;as?:'div'|'tr'}){
 const route=useDogRoute(),menu=useContextMenu()
 return <Tag {...objectNavProps('watchdog',id,org??route?.org)} className={className}
   onContextMenu={e=>menu.open(e,[],agentNavElementAt(e.target,e.currentTarget)??e.currentTarget)}>{children}{menu.node}</Tag>
}

/** The watchdogs owned by `agentId`, in the tree's order. A one-shot dog that
 *  has already fired (`spent`) is a departing tombstone with nothing to open
 *  that means anything, so it gets no card. */
export function useDeskDogs(agentId: string): { dogs: Watchdog[]; total: number; org?: string; open: (id: string) => void } | null {
  const ctx = useDogRoute()
  if (!ctx) return null
  const dogs = ctx.dogs.filter((w) => w.owner === agentId && !w.spent)
  const total = ctx.counts?.[agentId]?.kept ?? dogs.length
  return total ? { dogs, total, org:ctx.org, open: ctx.open } : null
}

/** One watchdog's card: the canvas chip's glyph and name, in the desk's chip
 *  style, marked as a dog (not an agent) by its glyph and its class. */
export function DogChip({ dog, onOpen }: { dog: Watchdog; onOpen: (id: string) => void }) {
  return <WatchdogLink dog={dog} onOpen={onOpen} countdown/>
}
