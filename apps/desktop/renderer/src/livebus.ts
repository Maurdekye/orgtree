// The client's G2. The server already has one central liveness hook —
// `store.save_org` fires the 'changed' broadcast, so no endpoint has to
// remember to announce itself. The CLIENT had no such hook: the ws handler
// refreshed the TREE, and every other surface (audiences, inboxes, events,
// history, scratch) sat on its own 5 s poll — so a mutation's effect was
// instant on the canvas and up to a poll interval late everywhere else
// (user bug 2026-08-14: rescinding an audience grant left the holder listed
// in the inbox modal for seconds).
//
// This bus closes the loop in exactly two central places, so no future
// surface or endpoint can be forgotten:
//   · api.ts `req()` bumps after every successful NON-GET — the mutation
//     THIS tab just made refreshes everything mounted, immediately;
//   · App.tsx's ws 'changed' handler bumps — mutations made anywhere else
//     (agents, other tabs, the supervisor) arrive within the server's own
//     0.4 s coalesce window.
// `usePolled` subscribes every polled surface to the bus; the interval it
// keeps is only the fallback for a dropped ws.
//
// Deliberately dependency-free: imported by api.ts and canvas/shared.ts,
// which must not import each other.

type Fn = () => void
const subs = new Set<Fn>()

/** Subscribe; returns the unsubscribe. */
export const onLiveBump = (fn: Fn): (() => void) => {
  subs.add(fn)
  return () => { subs.delete(fn) }
}

let timer: ReturnType<typeof setTimeout> | null = null

const deliverLive = (): void => {
  timer = null
  for (const fn of [...subs]) fn()
}

/** Deliver a pending bump next task, cancelling its delayed duplicate.
 * A confirmed local move uses this after its response is parsed. Other
 * events still coalesce; a later event schedules a fresh refresh. */
export const flushLive = (): void => {
  if (timer === null) return
  clearTimeout(timer)
  // Keep subscriber work outside the mutation promise, as on the normal bus.
  timer = setTimeout(deliverLive, 0)
}

/** Wake every subscribed surface. Bursts share one refresh after 120 ms. */
export const bumpLive = (): void => {
  if (timer) return
  timer = setTimeout(deliverLive, 120)
}
