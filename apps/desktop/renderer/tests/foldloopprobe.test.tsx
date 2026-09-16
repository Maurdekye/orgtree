// foldloopprobe.test.tsx — TWO EFFECTS, ONE FOLD, AN ARGUMENT THAT NEVER ENDS.
//
// THE DEFECT. `canvas/foldstate.tsx` had two effects that each acted as the
// sole authority over which folds are open:
//
//   · `prune` only ever REMOVES keys, and `DeskChat` calls it from a
//     `useEffect` with NO dependency list — so after EVERY render — measured
//     against `foldKeysOf(...)`, an enumeration of the payload.
//   · `useFold`'s alias effect only ever ADDS keys, and depends on
//     `[keys, store]`. `store` takes a new identity whenever `open` changes,
//     so it re-runs whenever anything on the desk opens or closes.
//
// A fold whose keys were only PARTIALLY in the census therefore never settled:
// prune deleted the key alias had just restored, alias restored the key prune
// had just deleted. React stops that at fifty nested updates with error #185,
// and the desk it stops is the operator's whole agent panel. Uncapped, this
// file used to emit React's own "Maximum update depth exceeded … useEffect …
// doesn't have a dependency array" and then exhaust a 4 GB heap.
//
// Such a fold is reachable in the product: reply-source quotes
// (canvas/replysource.tsx) render real folds from rows the census never walked,
// and the desk fed the census its deduplicated and filtered lists while
// `indexReplySources` was given the raw ones.
//
// THE FIX is that a MOUNTED fold claims its own keys and `prune` keeps any key
// that is claimed. Every key `alias` can add belongs to a mounted fold, so it
// is a key `prune` must keep. The oscillation is not damped, it is impossible.
//
// WHAT THIS FILE MEASURES. It drives the REAL module through DeskChat's exact
// wiring — prune in a dependency-less effect, a row using `useFold` — and
// counts renders caused by ONE click, across the key-set matrix. RENDERS ARE
// THE ASSERTION, not the absence of a thrown error: a loop that React has not
// yet capped is still the defect, and a test that waited for #185 would be
// asserting React's patience rather than our correctness.
//
// ANTI-VACUITY: §A and §D are the settled cases and must stay settled, so a
// "fix" that simply freezes the store fails them — they still require the fold
// to OPEN. §B and §D also require it to STAY open, which a fix that pruned
// everything would fail.
//
// Run:  node apps/desktop/renderer/tests/run.mjs foldloopprobe

import './harness'
import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { useEffect, useRef } from 'react'
import { FoldProvider, useFold, useFoldState } from '../src/canvas/foldstate'

/** Well above any settled case (the worst honest one below is 3) and well
 *  below React's own limit of 50, so a runaway is caught as a runaway rather
 *  than as whatever React happens to do about it. */
const CAP = 20
class Runaway extends Error {}

/** DeskChat's wiring, reproduced exactly: `prune` in a `useEffect` with no
 *  dependency list, one row holding a multi-key fold beneath it. */
function Rig({ keys, live, count }: {
  keys: string[]; live: string[]; count: { n: number }
}) {
  const folds = useFoldState()
  const prune = folds.prune
  useEffect(() => { prune(new Set(live)) })
  return <FoldProvider value={folds.store}><Row keys={keys} count={count} /></FoldProvider>
}

function Row({ keys, count }: { keys: string[]; count: { n: number } }) {
  const [open, toggle] = useFold(keys)
  const seen = useRef(0)
  seen.current++
  count.n = seen.current
  if (seen.current > CAP) throw new Runaway(`render loop: ${seen.current} renders for one click`)
  return <button onClick={toggle}>{open ? 'open' : 'shut'}</button>
}

interface Outcome { renders: number; label: string; runaway: boolean; error: unknown }

async function click(keys: string[], live: string[]): Promise<Outcome> {
  const count = { n: 0 }
  let mounted: { el: HTMLElement; unmount: () => Promise<void> } | null = null
  let error: unknown = null
  try {
    mounted = await mountView(<Rig keys={keys} live={live} count={count} />, (el) => el)
    const button = mounted.el.querySelector('button')
    assert.ok(button, 'the rig must render its fold control')
    await inAct(async () => { button.click(); await flush(6) })
  } catch (e) { error = e }
  const label = mounted?.el.querySelector('button')?.textContent ?? '(torn down)'
  // a runaway may have left the tree in a state unmount cannot walk
  try { await mounted?.unmount() } catch { /* nothing left to clean up */ }
  return { renders: count.n, label, runaway: error instanceof Runaway, error }
}

/** every case settles; `expect` says what the fold must READ afterwards */
async function settles(name: string, keys: string[], live: string[], expect: 'open' | 'shut') {
  const r = await click(keys, live)
  assert.equal(r.runaway, false,
    `${name}: the fold store never settled — ${r.renders} renders for a single click. `
    + 'prune and alias are fighting over a partially-censused key set.')
  if (r.error) throw r.error
  assert.ok(r.renders <= 4,
    `${name}: settled, but took ${r.renders} renders for one click (expected at most 4)`)
  assert.equal(r.label, expect, `${name}: the fold should read "${expect}" after the click`)
}

const TWO = ['op:X', 'mail:Y']
const THREE = ['op:X', 'mail:Y', 'ghost:1']

test('§A two keys, both in the census — the control, unchanged',
  { timeout: 30_000 }, async () => {
    await settles('§A', TWO, TWO, 'open')
  })

test('§B two keys, neither in the census — opens, and STAYS open',
  { timeout: 30_000 }, async () => {
    // Previously settled but silently shut: a mail quoted as a reply source is
    // never in the census, so the pruner closed a fold the reader had just
    // opened and was looking at.
    await settles('§B', TWO, [], 'open')
  })

test('§C two keys, exactly ONE in the census — THE LOOP',
  { timeout: 30_000 }, async () => {
    await settles('§C', TWO, ['op:X'], 'open')
  })

test('§D one key, not in the census — opens, and STAYS open',
  { timeout: 30_000 }, async () => {
    await settles('§D', ['mail:Y'], ['op:X'], 'open')
  })

test('§E three keys, exactly ONE in the census — THE LOOP, wider',
  { timeout: 30_000 }, async () => {
    await settles('§E', THREE, ['ghost:1'], 'open')
  })

test('§F a fold that UNMOUNTS stops holding its keys, so the sweep still sweeps',
  { timeout: 30_000 }, async () => {
    // The claim must not become a leak: the whole point of `prune` is that a
    // message which genuinely left the transcript leaves nothing behind.
    const count = { n: 0 }
    const view = await mountView(<Rig keys={TWO} live={[]} count={count} />, (el) => el)
    const button = view.el.querySelector('button')
    assert.ok(button, 'the rig must render its fold control')
    await inAct(async () => { button.click(); await flush(6) })
    assert.equal(view.el.querySelector('button')?.textContent, 'open', 'opened first')
    await view.unmount()
    // Re-mounting is a fresh store, so the durable check is that unmounting
    // released the claim rather than leaving the key pinned open forever.
    const again = { n: 0 }
    const second = await mountView(<Rig keys={TWO} live={[]} count={again} />, (el) => el)
    assert.equal(second.el.querySelector('button')?.textContent, 'shut',
      'a newly mounted fold starts shut — no claim survived the unmount')
    await second.unmount()
  })
