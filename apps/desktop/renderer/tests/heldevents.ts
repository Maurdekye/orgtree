// heldevents.ts — a test bridge that delivers events the way the real one does.
//
// ⚠ WHY THIS EXISTS. Several suites faked `onEvent` as a SINGLE SLOT —
// `onEvent: (fn) => { fire = fn; ... }` — and drove the component by calling
// `fire(...)`. That was faithful enough while each component subscribed
// directly and alone. It stopped being faithful the moment a document has more
// than one subscriber, which it now always does: `events/heldbus.ts` attaches
// first (it must, or native's hold is released to nobody), and the component
// under test attaches second. A single slot silently keeps only the last
// subscriber, so the event reaches one of them and the test measures whichever
// one the fake happened to keep.
//
// So this is a multicast fake plus the bus, started in the order main.tsx
// starts it. Using it means a test drives the PRODUCT's delivery path — bridge
// → bus → consumer — rather than a shortcut into the consumer.

import { resetHeldEvents, startHeldEvents } from '../src/events/heldbus'

export interface NativeEvent { type: string; data?: unknown }

export interface EventBridge {
  /** drop into a fake bridge object: `{ ...rest, onEvent: fan.onEvent }` */
  onEvent: (fn: (event: NativeEvent) => void) => () => void
  /** deliver to every attached listener, as `webContents.send` does */
  emit: (event: NativeEvent) => void
  /** how many listeners are attached — one per real subscriber */
  size: () => number
}

export function eventFanout(): EventBridge {
  const listeners = new Set<(event: NativeEvent) => void>()
  return {
    onEvent(fn) {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    },
    emit(event) { for (const fn of [...listeners]) fn(event) },
    size: () => listeners.size,
  }
}

/** Start the held bus against whatever bridge is currently installed, exactly
 *  as main.tsx does before React mounts. Returns the teardown a test's
 *  `finally` should call, so state does not leak into the next scenario. */
export function startBus(): () => void {
  startHeldEvents()
  return resetHeldEvents
}
