// events/heldbus.ts — THE RENDERER SIDE OF "HELD UNTIL SOMEBODY IS LISTENING".
//
// ⚠ THE DEFECT THIS EXISTS TO CLOSE, stated first because everything below is
// shaped by it.
//
// Native holds four event types that a renderer cannot rediscover by asking —
// `open-org`, `notification-click`, `window-identity`, `restore-skipped` — and
// releases the hold on EVIDENCE OF A CONSUMER rather than on a timer. That
// design is right, and `main/window-outbox.ts` says plainly what it does not
// promise:
//
//   "It cannot guarantee that the listener which exists is the one that CARES
//    about that event — `onEvent` is a single channel every consumer shares."
//
// In this renderer that caveat is not theoretical, it is the normal case. The
// preload sends `desktop:events-listening` from INSIDE `onEvent`, so the FIRST
// `onEvent` anywhere in the document ends the holding — and the first one is
// `startThemeSync()` on line 1 of main.tsx, which cares about `preferences`
// and nothing else. The four held events are then delivered, correctly and on
// time, to a document whose open-org, notification-click, window-identity and
// restore-skipped consumers are all React effects that have not run yet. They
// are delivered into a void, and native has every right to believe they were
// received.
//
// The user-visible failure is the exact one the outbox was built to prevent: a
// notification clicked while the app is cold opens a window that then does
// nothing.
//
// ⚠ WHY THE FIX IS HERE AND NOT IN THE PRELOAD. The ack is unconditional and
// belongs to the native owner's file. Renderer-side, the only reliable move is
// to make the FIRST listener in the document one that keeps what it is given:
// this module attaches before anything else can, buffers the held types, and
// hands each one to its real consumer the moment that consumer registers —
// however much later that is.
//
// So the guarantee is completed rather than replaced:
//
//   native   an event is not DISCARDED before a listener exists
//   here     an event is not DROPPED before its own consumer exists
//
// ⚠ WHAT THIS IS NOT. It is not a second event system and it is not a router
// for the twenty other event types. Live, unheld events keep flowing through
// the ordinary `bridge.onEvent` subscriptions exactly as before; only the four
// held types come through here, and only because only those four are
// unrecoverable if missed.

import { desktop } from '../desktop'

/** ⚠ THE SAME FOUR AS `HELD_EVENT_TYPES` in apps/desktop/main/index.ts, and
 *  they must stay the same four. A type native holds but this module does not
 *  buffer is a type discharged into the gap this module exists to close; a
 *  type buffered here but not held by native is harmless but misleading. The
 *  set is small and stable, and the test pins it against main's source rather
 *  than trusting this comment. */
export const HELD_TYPES = [
  'open-org', 'notification-click', 'window-identity', 'restore-skipped',
] as const
export type HeldType = (typeof HELD_TYPES)[number]

const isHeld = (t: unknown): t is HeldType =>
  (HELD_TYPES as readonly unknown[]).includes(t)

/** One delivered event, kept in the shape the consumers already read. */
export interface HeldEvent {
  type: HeldType
  data: unknown
}

export type HeldConsumer = (event: HeldEvent) => void

/** ⚠ A BOUND, FOR THE SAME REASON NATIVE HAS ONE. A held type whose consumer
 *  never mounts would otherwise accumulate for the life of the document. 64
 *  matches `window-outbox.ts`'s default so the two sides cannot disagree about
 *  how much is survivable, and the OLDEST is dropped rather than the newest,
 *  because a superseded navigation is the one worth losing. */
const LIMIT = 64

const waiting = new Map<HeldType, HeldEvent[]>()
const consumers = new Map<HeldType, Set<HeldConsumer>>()
let dropped = 0
let detach: (() => void) | null = null
/** how many events this module has handed to a real consumer — the number a
 *  fixture asserts on, since "it did not throw" proves nothing here */
let delivered = 0

const queueOf = (type: HeldType): HeldEvent[] => {
  const q = waiting.get(type) ?? []
  if (!waiting.has(type)) waiting.set(type, q)
  return q
}

/** ⚠ ARRIVALS HELD WHILE `takePendingWindowEvents` IS IN FLIGHT, and this is
 *  an ORDERING guard rather than a delivery one.
 *
 *  Both drain routes are ASYNCHRONOUS. `ipcRenderer.send` is async IPC, so the
 *  listening ack reaches the main process on its own turn; the take is a
 *  promise. Which of the two reaches the outbox first is not ours to decide,
 *  and when the TAKE wins the race the held events come back to us through a
 *  promise that resolves a tick later — while the queue is already unheld, so
 *  a NEWER live event can arrive at the listener before that promise settles.
 *  Dispatching as they arrive would then hand the consumer the new event
 *  before the older one it supersedes: an `open-org` for the organization the
 *  user just left, arriving after the one they went to.
 *
 *  So while a take is outstanding, live arrivals wait here and are released
 *  AFTER whatever the take returns. Nothing is dropped and nothing is
 *  reordered; the window is one promise turn and it closes even if the take
 *  rejects. (multi-window-design, 2026-09-21: "exercise queued older events
 *  versus subsequent live events across ack/take promise timing rather than
 *  relying on the comment calling the ack synchronous".) */
let takeInFlight = false
let duringTake: HeldEvent[] = []

function dispatch(event: HeldEvent): void {
  if (takeInFlight) { duringTake.push(event); return }
  const subs = consumers.get(event.type)
  if (subs && subs.size) {
    delivered += 1
    // a copy, so a consumer that unsubscribes itself while handling cannot
    // mutate the set being iterated
    for (const fn of [...subs]) {
      try { fn(event) } catch { /* one bad consumer must not eat the event for the rest */ }
    }
    return
  }
  // ⚠ NOBODY CARES YET, SO IT WAITS. This is the whole module: the alternative
  // is to drop it, which is exactly what happens today.
  const q = queueOf(event.type)
  q.push(event)
  while (q.length > LIMIT) { q.shift(); dropped += 1 }
}

/**
 * ATTACH THE DOCUMENT'S FIRST LISTENER.
 *
 * ⚠ CALL THIS BEFORE ANY OTHER `onEvent` SUBSCRIPTION IN THE DOCUMENT — it is
 * the first statement of main.tsx for that reason, ahead of `startThemeSync`,
 * and a test pins the ordering because nothing at runtime can. Attaching
 * second is not a smaller version of the same protection: it is none of it,
 * because the ack the FIRST subscription sends is what releases native's hold,
 * and whatever arrives on the back of that ack reaches only the listeners that
 * already exist.
 *
 * ⚠ AND IT ALSO TAKES EXPLICITLY. `takePendingWindowEvents` is the route
 * `window-outbox.ts` names for a renderer that wants certainty rather than
 * relying on the host's signal. Both routes drain the SAME queue and the drain
 * is idempotent per document, so calling both cannot deliver anything twice —
 * whichever gets there first returns the events and the other returns nothing.
 *
 * ⚠ NEITHER ROUTE IS SYNCHRONOUS, and an earlier version of this comment said
 * the ack was, which is wrong and is the sort of wrong that hides a race.
 * `ipcRenderer.send` is asynchronous IPC: the preload's ack reaches the main
 * process on its own turn, and the events it releases come back as ordinary
 * sends. The take is a promise. They are worth having BOTH because they fail
 * differently — the ack depends on this module really being first, and the
 * take is ours to make unconditionally — not because one of them is prompt.
 * The consequence of them racing is handled by `takeInFlight` above.
 *
 * Idempotent: a second call is a no-op, so a test harness and main.tsx can
 * both call it.
 */
export function startHeldEvents(): () => void {
  if (detach) return detach
  const bridge = desktop()
  if (!bridge?.onEvent) {
    // a browser, or a window the sender gate refused. There is no native hold
    // to complete, so there is nothing to do and nothing to pretend.
    detach = () => {}
    return detach
  }
  const off = bridge.onEvent((event) => {
    const e = event as { type?: unknown; data?: unknown }
    if (!isHeld(e.type)) return
    dispatch({ type: e.type, data: e.data })
  })
  // the explicit route, taken unconditionally — see above for why both
  if (bridge.takePendingWindowEvents) {
    // ⚠ ARMED BEFORE THE CALL, NOT AFTER. The window this guards is "a take is
    // outstanding", and that window opens the moment the request leaves — not
    // the moment we get a promise object back. Arming afterwards leaves a gap
    // that is empty in production (real IPC cannot deliver inside a
    // synchronous call) and is exactly the gap a test that models the race
    // deliberately aims at, which is a good reason to close it rather than to
    // argue it cannot be hit.
    takeInFlight = true
    // ⚠ THE RELEASE IS IN ONE PLACE AND RUNS ON BOTH OUTCOMES. If the take
    // rejects — an older host with no such channel — everything staged while
    // it was outstanding must still go out, or the guard against reordering
    // becomes a way to lose events outright.
    const settle = (held: unknown[]) => {
      takeInFlight = false
      const staged = duringTake
      duringTake = []
      for (const raw of held) {
        const e = raw as { type?: unknown; data?: unknown }
        if (isHeld(e?.type)) dispatch({ type: e.type, data: e.data })
      }
      // …and only then whatever arrived live while we were waiting
      for (const event of staged) dispatch(event)
    }
    let take: Promise<unknown[]> | undefined
    try { take = bridge.takePendingWindowEvents() } catch { /* settled below */ }
    if (take) void take.then((held) => settle(held ?? [])).catch(() => { settle([]) })
    else settle([])   // a host that threw outright must not leave this armed
  }
  detach = () => { off(); detach = null }
  return detach
}

/**
 * REGISTER THE REAL CONSUMER OF ONE HELD TYPE.
 *
 * Anything of that type that arrived before now is handed over IMMEDIATELY and
 * SYNCHRONOUSLY, in arrival order, before this function returns — so a
 * consumer mounting in a React effect sees a cold-open event in the same
 * commit it subscribes in, not a frame later.
 *
 * ⚠ ONCE HANDED OVER, IT IS GONE. Unsubscribing does not put the event back in
 * the queue, and a remount does not replay it. A redelivering bus would turn
 * one notification click into one per remount, which is a worse bug than the
 * one being fixed and a much harder one to see.
 *
 * ⚠ AND THE BUFFERED FLUSH GOES TO EVERY CONSUMER REGISTERED AT THAT MOMENT,
 * not only to the one whose registration triggered it (review finding f1).
 * The live path fans out to the whole set, and a flush that went to one
 * consumer would work perfectly for every live event and deliver NOTHING to a
 * second consumer on a cold start — render-order dependent, invisible to a
 * suite whose multi-consumer tests are all live-event tests, and surfacing
 * only in the notification-clicked-while-cold case this module exists for.
 * Today every held type has exactly one consumer, so this changes no
 * behaviour; it removes the trap rather than documenting it.
 *
 * ⚠ WHAT IS STILL TRUE, AND IS INHERENT RATHER THAN AN OVERSIGHT: a consumer
 * registering AFTER the queue has been flushed gets nothing, because the
 * no-replay rule above is deliberate. Fanning out at flush time makes
 * same-commit consumers equal; it cannot make a later one retroactive without
 * reintroducing replay.
 */
export function onHeldEvent(type: HeldType, consumer: HeldConsumer): () => void {
  const subs = consumers.get(type) ?? new Set<HeldConsumer>()
  if (!consumers.has(type)) consumers.set(type, subs)
  subs.add(consumer)
  const q = waiting.get(type)
  if (q && q.length) {
    waiting.set(type, [])
    // a copy, for the same reason dispatch takes one: a consumer that
    // unsubscribes itself while handling must not mutate the set being walked
    const fanout = [...subs]
    for (const event of q) {
      delivered += 1
      for (const fn of fanout) {
        try { fn(event) } catch { /* one bad consumer must not eat it for the rest */ }
      }
    }
  }
  return () => {
    subs.delete(consumer)
    if (!subs.size) consumers.delete(type)
  }
}

/** What is still waiting, and what could not be kept. Exported for the fixture
 *  and for diagnosis — a window sitting on a held event with no consumer is a
 *  fact worth being able to see, exactly as native's `dropped()` is. */
export const heldEventStats = (): {
  waiting: number; dropped: number; delivered: number; types: HeldType[]
} => ({
  waiting: [...waiting.values()].reduce((n, q) => n + q.length, 0),
  dropped,
  delivered,
  types: [...waiting.entries()].filter(([, q]) => q.length).map(([t]) => t),
})

/** TEST ONLY — forget everything, including the subscription. The module holds
 *  document-scoped state on purpose (it must exist before any component does),
 *  so a suite that runs several scenarios in one document needs a way back to
 *  the start. */
export function resetHeldEvents(): void {
  detach?.()
  detach = null
  waiting.clear()
  consumers.clear()
  duringTake = []
  takeInFlight = false
  dropped = 0
  delivered = 0
}
