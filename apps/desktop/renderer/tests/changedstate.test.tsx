// changedstate.test.tsx — the contract of `useChangedState`.
//
// It exists because of a SECOND React #185 on the ↑-you chip, a fortnight after
// the first (see pinloop.test.tsx for that one). The first was geometric: the
// chip sat in flow, so mounting it moved the row whose position decided whether
// it mounted. That was fixed by taking the chip out of flow, and the predicate
// has been stable ever since.
//
// This one is not geometric at all. The user crashed on 2026-09-15 21:08Z
// expanding a question answer on an agent's desk while that agent was mid-turn,
// and the measured loop ran with the geometry FROZEN: same scroll position,
// same scroll height, same row count, same pin target (`null` throughout, the
// reader being at the tail). What kept it going was the dispatch itself:
//
//     setPinSeq((s) => (s === v ? s : v))   // only re-render on a real flip
//
// Returning the previous value stops the RE-RENDER, not the UPDATE BEING
// SCHEDULED. React drops the dispatch only when its eager-state bailout
// applies, and that needs the hook's fiber to have no work pending already. A
// streaming desk always has some, so the no-op was scheduled like any other
// update — and the effect that scheduled it has no dependency list, so it ran
// again, and scheduled again. Fifty rounds, then #185, then the boundary takes
// the desk down.
//
// ⚠ WHY THE CRASH ITSELF IS NOT PINNED HERE, and it is worth knowing before
// somebody tries to add it. Under `act()` React does not refuse the bailout,
// so BOTH idioms settle in three renders in jsdom — measured, both ways, on
// the exact component shape of the desk, before writing this. A jsdom "control"
// for this defect would pass before the fix as happily as after it, which is
// worse than no control at all. The crash is held by a real-browser probe
// instead: apps/desktop/renderer/tests/answerexpand-probe.tsx, run through
// tools/run-probe.mjs, which reproduces it on 2.1.5 and on main-without-fix and
// comes back clean with it. What this file pins is the guard's CONTRACT — that
// it still delivers real changes, and that a repeat costs no commit — because
// a guard that quietly stopped updating the chip would be the other failure.
//
// Run:  node apps/desktop/renderer/tests/run.mjs changedstate

import './harness'
import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { Profiler, useLayoutEffect } from 'react'
import type { ReactNode } from 'react'
import { useChangedState } from '../src/changedstate'

/** commits, counted by React's own Profiler — the measure that tells a settled
 *  component from one that is re-rendering for nothing */
let commits = 0
const Count = ({ children }: { children: ReactNode }) =>
  <Profiler id="t" onRender={() => { commits++ }}>{children}</Profiler>

test('§1 a real change reaches the render, and can go back again', async () => {
  let set: (n: number | null) => void = () => {}
  let seen: number | null = null
  function Pin() {
    const [v, s] = useChangedState<number | null>(null)
    seen = v; set = s
    return <span>{String(v)}</span>
  }
  const view = await mountView(<Pin />, (el) => el.querySelector('span')?.textContent ?? '')
  assert.equal(seen, null)
  await inAct(() => { set(7) })
  assert.equal(seen, 7, 'a real change must reach the render')
  assert.equal(view.last(), '7')
  await inAct(() => { set(null) })
  assert.equal(seen, null, 'and it must be able to return to a previous value')
  assert.equal(view.last(), 'null')
  await view.unmount()
})

test('§2 a repeat costs no commit; the change either side of it does', async () => {
  let set: (n: number) => void = () => {}
  function Pin() {
    const [v, s] = useChangedState(0)
    set = s
    return <span>{v}</span>
  }
  commits = 0
  const view = await mountView(<Count><Pin /></Count>,
    (el) => el.querySelector('span')?.textContent ?? '')
  const mounted = commits
  // ANTI-VACUITY: the setter is live and a real change does commit, so §2's
  // "no further commits" cannot pass by nothing having been delivered.
  await inAct(() => { set(3) })
  const afterChange = commits
  assert.ok(afterChange > mounted, 'a real change must commit')
  assert.equal(view.last(), '3')
  for (let i = 0; i < 10; i++) await inAct(() => { set(3) })
  await flush()
  assert.equal(commits, afterChange,
    `ten repeats must cost nothing — ${afterChange} -> ${commits}`)
  assert.equal(view.last(), '3')
  await view.unmount()
})

test('§3 two calls in one commit: the second sees what the first dispatched', async () => {
  // THE CASE A PLAIN `useState` CLOSURE GETS WRONG. `calcPin` writes twice in
  // one layout effect, and the second write reads state from the render it was
  // closed over — which is why the guard remembers what it DISPATCHED rather
  // than what is rendered.
  let renders = 0
  let final: number | null = null
  function Pin() {
    const [v, set] = useChangedState<number | null>(null)
    renders++
    final = v
    useLayoutEffect(() => { set(1); set(1) }, [set])
    return <span>{String(v)}</span>
  }
  const view = await mountView(<Pin />, (el) => el.querySelector('span')?.textContent ?? '')
  await flush()
  assert.equal(final, 1, 'the value must land')
  assert.ok(renders <= 3, `and land once, not repeatedly — ${renders} renders`)
  assert.equal(view.last(), '1')
  await view.unmount()
})

test('§4 the setter identity is stable, so an observer may hold it', async () => {
  // DeskChat parks `calcPin` in a ref for a ResizeObserver that outlives the
  // render that made it. A setter that changed identity every render would put
  // that back on the pile of things a call site has to remember.
  const setters: unknown[] = []
  let bump: (n: number) => void = () => {}
  function Pin() {
    const [v, set] = useChangedState(0)
    setters.push(set)
    bump = set
    return <span>{v}</span>
  }
  const view = await mountView(<Pin />, (el) => el.querySelector('span')?.textContent ?? '')
  await inAct(() => { bump(1) })
  await inAct(() => { bump(2) })
  assert.ok(setters.length >= 3, 'the component really re-rendered')
  assert.equal(new Set(setters).size, 1, 'the setter must keep one identity')
  await view.unmount()
})
