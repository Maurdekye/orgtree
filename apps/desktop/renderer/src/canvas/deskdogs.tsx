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
import { createContext, useContext } from 'react'
import type { Watchdog } from '../types'

export interface DeskDogs {
  /** the organization's watchdogs, as the tree carries them */
  dogs: Watchdog[]
  /** exactly what the canvas satellite chip's click does */
  open: (id: string) => void
}

const Ctx = createContext<DeskDogs | null>(null)
export const DeskDogsProvider = Ctx.Provider

/** The watchdogs owned by `agentId`, in the tree's order. A one-shot dog that
 *  has already fired (`spent`) is a departing tombstone with nothing to open
 *  that means anything, so it gets no card. */
export function useDeskDogs(agentId: string): { dogs: Watchdog[]; open: (id: string) => void } | null {
  const ctx = useContext(Ctx)
  if (!ctx) return null
  const dogs = ctx.dogs.filter((w) => w.owner === agentId && !w.spent)
  return dogs.length ? { dogs, open: ctx.open } : null
}

const glyph = (w: Watchdog) => w.state === 'armed' ? '◉' : w.state === 'paused' ? '◫' : '✕'

/** One watchdog's card: the canvas chip's glyph and name, in the desk's chip
 *  style, marked as a dog (not an agent) by its glyph and its class. */
export function DogChip({ dog, onOpen }: { dog: Watchdog; onOpen: (id: string) => void }) {
  return (
    <button type="button" className={'desk-nav-chip desk-dog-chip ' + dog.state}
      title={`${dog.once ? 'one-shot dog' : 'watchdog'} "${dog.name}" (${dog.kind}) — `
        + `${dog.state}; click for detail`}
      aria-label={`watchdog ${dog.name}, ${dog.state}`}
      onClick={() => onOpen(dog.id)}>
      <span className="wd-glyph" aria-hidden="true">{glyph(dog)}</span>
      {dog.once && <span className="wd-once" aria-hidden="true">1×</span>}
      {dog.name}
    </button>
  )
}
