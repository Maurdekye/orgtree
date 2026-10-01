/** EVENTS A WINDOW'S RENDERER COULD NOT HAVE RECEIVED YET.
 *
 *  ⚠ THE PROBLEM. A window exists before its renderer does. Native can have an
 *  organization to open or an item to reveal in hand while the document is
 *  still loading, and `webContents.send` to a window with no listener attached
 *  delivers to nobody — silently, because Electron has nobody to tell. The user
 *  sees a notification click that did nothing.
 *
 *  ⚠ AND THE FIX FOR IT HAS A TRAP, which this module exists to make
 *  impossible. The obvious shape is "hold briefly, then send anyway" — but
 *  sending anyway is not delivery. If nobody is listening when the timer fires,
 *  the events go into the same void, and the outbox now believes it has
 *  discharged them, so nothing will ever send them again. That is the original
 *  bug with a delay in front of it. A LONGER timer is not a better guess; it is
 *  a later one.
 *
 *  So this queue has NO timer and nothing marks an event delivered on its own.
 *  It stops holding only when the host says there is somewhere to send — a
 *  renderer has attached a listener, or has asked for what was held. Both are
 *  evidence. Until then the events wait, and the only bound on waiting is the
 *  size cap, which drops the OLDEST rather than pretending the newest was seen.
 *
 *  ⚠ WHAT THIS DOES NOT PROMISE, stated because it is easy to over-read. It
 *  guarantees a held event is not discarded before a listener exists. It cannot
 *  guarantee that the listener which exists is the one that CARES about that
 *  event — `onEvent` is a single channel every consumer shares, so which
 *  component handles which type is a composition question inside the renderer,
 *  and it is exactly as true of live delivery as of a flush. A renderer that
 *  wants certainty calls `drain` itself, at the moment its own consumers are
 *  mounted, instead of relying on the host's signal. */

export interface OutboxOptions {
  /** Which event types are worth holding. The rest are sent immediately: an
   *  event a renderer can simply re-read costs nothing when missed, and
   *  holding it would only risk handing over a stale duplicate. */
  hold: (type: string) => boolean
  /** How many held events to keep before dropping the oldest. A bound is
   *  needed because a window whose renderer never arrives would otherwise
   *  accumulate for the life of the process. Dropping the oldest is the right
   *  end: a superseded navigation is the one worth losing. */
  limit?: number
}

const DEFAULT_LIMIT = 64

export function windowOutbox<E extends { type: string }>(options: OutboxOptions) {
  const limit = options.limit ?? DEFAULT_LIMIT
  let holding = true
  let navigating = false
  let queue: E[] = []
  let dropped = 0
  return {
    /** Offer an event. `true` means send it now; `false` means it is held and
     *  the host must do nothing — it will come back from `drain`. */
    offer(event: E): boolean {
      if ((!holding && !navigating) || !options.hold(event.type)) return true
      queue.push(event)
      while (queue.length > limit) { queue.shift(); dropped += 1 }
      return false
    },
    /** ⚠ THE DOCUMENT WENT AWAY, SO THE EVIDENCE WENT WITH IT. Start holding
     *  again.
     *
     *  The proof that somebody is listening is a listener, and a listener
     *  belongs to a DOCUMENT: navigate the window and the document, its preload
     *  instance and its listener are all destroyed and rebuilt. This queue
     *  lives on the WINDOW, which outlives all of them - so without this, a
     *  window that drained once would send live into every subsequent
     *  navigation gap, and the events would be lost exactly as they were
     *  before any of this existed.
     *
     *  A reload suspends delivery before commit. Commit discards the old
     *  readiness; cancellation instead resumes that existing listener.
     *
     *  Idempotent, and safe to call on a queue that is already holding. */
    rearm(): void { holding = true },
    /** Hold across provisional navigation without forgetting an existing
     * listener. If navigation is canceled, that same listener can resume. */
    suspend(): void { navigating = true },
    resume(): E[] {
      navigating = false
      if (holding) return []
      const held = queue
      queue = []
      return held
    },
    /** There is somewhere to send now. Stops holding UNTIL THE DOCUMENT THAT
     *  proved it goes away - see `rearm`. Hands back
     *  everything that was waiting, in arrival order. Idempotent: a second
     *  call returns nothing, so a listener signal and an explicit request
     *  cannot deliver the same event twice. */
    drain(): E[] {
      holding = false
      // An acknowledgement proves a listener exists, not that its document
      // will survive the navigation. Remember it for cancellation only.
      if (navigating) return []
      const held = queue
      queue = []
      return held
    },
    /** Delivery is held until both listener readiness and navigation allow it. */
    holding(): boolean { return holding || navigating },
    pending(): number { return queue.length },
    /** How many were dropped to stay inside the bound. Reported rather than
     *  silent: a window that overflowed this is a window whose renderer never
     *  arrived, and that is worth being able to see. */
    dropped(): number { return dropped },
  }
}

export type WindowOutbox<E extends { type: string }> = ReturnType<typeof windowOutbox<E>>
