// changedstate.ts — STATE THAT ONLY DISPATCHES WHEN IT REALLY CHANGED.
//
// USER CRASH 2026-09-15 21:08Z: expanding a question answer on a working
// agent's desk killed the whole desk panel instantly — React error #185,
// "Maximum update depth exceeded", filed twice by the crash reporter with the
// click on the answer as the last breadcrumb.
//
// THE IDIOM THAT CAUSED IT looks like it already solves this problem:
//
//     setPinSeq((s) => (s === v ? s : v))   // only re-render on a real flip
//
// It does not. Returning the previous value from an updater tells React not to
// RE-RENDER; it does not stop the update being SCHEDULED. React only skips
// scheduling when its eager-state bailout applies, and that bailout is allowed
// only while the hook's fiber has no work pending already:
//
//     if (fiber.lanes === NoLanes && (alternate === null || alternate.lanes === NoLanes))
//
// On a quiet desk that holds, the update is dropped, and the comment reads as
// true for years. On a desk whose agent is MID-TURN it does not: the live tail
// is streaming, so there is always other pending work, the bailout is refused
// and the no-op is scheduled like any other update.
//
// That is enough to make a loop out of an effect that has no dependency list
// and therefore runs after every render. DeskChat's layout effect measures the
// transcript and calls the setter above; the setter schedules a synchronous
// re-render even though the value did not move; the re-render runs the layout
// effect; it schedules again. Nothing in the desk changes between rounds — not
// the pin, not the scroll, not the payload — and it still spins, because the
// dispatch alone is the engine. React counts fifty nested updates and throws,
// and the error boundary takes the desk down with it. Measured on the user's
// own transcript in a real browser: 50 renders in 86 ms, all identical.
//
// SO THE COMPARISON HAS TO HAPPEN BEFORE THE DISPATCH, not inside the updater,
// and it has to live somewhere a call site cannot forget it — the same reason
// `foldlines.measureInto` exists. `useChangedState` keeps the last value it
// dispatched in a ref and returns early when the new one matches, so a setter
// called on every render of a busy desk costs exactly nothing.
//
// WHEN NOT TO USE IT. This is for state DERIVED FROM A MEASUREMENT — something
// recomputed on a schedule the component does not control (a layout effect, an
// observer, a scroll handler) where "unchanged" is the common case. Ordinary
// state driven by user actions wants plain `useState`: there the dispatch is
// the point, and an equality guard would only hide a re-render someone meant.

import { useCallback, useRef, useState } from 'react'

/** `[value, setIfChanged]`.
 *
 *  `setIfChanged(next)` dispatches only when `next` differs from the last
 *  value this hook dispatched, compared with `Object.is` — so it is for
 *  primitives and for values with a stable identity, not for freshly built
 *  objects (those never compare equal and every call would dispatch). A
 *  measurement that produces a new object each time should be compared by the
 *  measurement's own rule first; see `foldlines.measureInto`. */
export function useChangedState<T>(initial: T): [T, (next: T) => void] {
  const [value, setValue] = useState<T>(initial)
  // what was last DISPATCHED, which is not the same as what is rendered: two
  // calls in one commit must not both dispatch, and the second would still see
  // the old `value` from this render's closure.
  const dispatched = useRef<T>(initial)
  const setIfChanged = useCallback((next: T) => {
    if (Object.is(dispatched.current, next)) return
    dispatched.current = next
    setValue(next)
  }, [])
  return [value, setIfChanged]
}
