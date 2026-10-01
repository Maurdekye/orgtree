// polledstatus.test.tsx — `usePolledStatus` in canvas/shared.ts: the four
// states a polled surface can be in, and the two ordering rules that make them
// trustworthy.
//
// WHY IT EXISTS. `usePolled` returned a value or null and discarded the
// failure, so a caller could not tell "the first read has not come back" from
// "the first read failed", nor "just confirmed" from "retained after a failure".
// For most panels that is fine. For the Attention queue it is not: a list that
// last read successfully as EMPTY and then goes unreadable says "nothing is
// waiting" with total confidence, which reads as "nothing needs you" when the
// truth is "nothing could be read".
//
// ⚠ ONE IMPLEMENTATION, NOT TWO. `usePolled` is `usePolledStatus(...).value`,
// so every existing caller keeps its signature and its behaviour and there is
// still exactly one timer, one livebus subscription and one copy of each value.
// §5 pins that, because a second poller beside this one would put two fetches
// and two answers behind every panel that wanted to know it had failed.
//
// ⚠ AND ORDERING IS PART OF THE CONTRACT NOW. Two ticks are routinely in flight
// at once — the interval and a livebus bump land together — and the previous
// implementation wrote whichever RESOLVED last, so a slow earlier request could
// overwrite a newer answer with nothing saying otherwise. §3 and §4 are that
// rule, for the STATUS as much as for the value.
//
// Run:  node apps/desktop/renderer/tests/run.mjs polledstatus

import './harness'
import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { usePolled, usePolledStatus } from '../src/canvas/shared'
import type { PolledStatus } from '../src/canvas/shared'

/** a promise whose settlement this test decides, so two requests can be put in
 *  flight together and completed in whichever order the case is about */
function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

interface Seen { value: string | null; status: PolledStatus }
let seen: Seen

function Probe({ fetcher, id, ms = 100000, refreshKey = 0 }: {
  fetcher: () => Promise<string>; id: string; ms?: number; refreshKey?: number
}) {
  const r = usePolledStatus(fetcher, [id], ms, refreshKey)
  seen = r as Seen
  return <span>{r.value ?? ''}</span>
}

const read = (el: HTMLElement) => el.querySelector('span')?.textContent ?? ''
// a long interval keeps every case driven by its own explicit settlements —
// nothing here should depend on a timer firing
const MS = 100000

test('§1 loading, then current', async () => {
  const d = deferred<string>()
  const v = await mountView(<Probe id="a" fetcher={() => d.promise} ms={MS} />, read)
  assert.deepEqual(
    { l: seen.status.loading, f: seen.status.failed, s: seen.status.stale, u: seen.status.unavailable },
    { l: true, f: false, s: false, u: false }, 'the first read is in flight')
  assert.equal(seen.value, null)
  assert.equal(seen.status.at, null)

  await inAct(async () => { d.resolve('one'); await flush() })
  assert.equal(seen.value, 'one')
  assert.deepEqual(
    { l: seen.status.loading, f: seen.status.failed, s: seen.status.stale, u: seen.status.unavailable },
    { l: false, f: false, s: false, u: false }, 'current')
  assert.ok((seen.status.at ?? 0) > 0, 'and stamped, so a surface can say "as of"')
  await v.unmount()
})

test('§2 a FAILED first read is unavailable, not loading — and a later failure '
  + 'with a value is stale, with the value kept', async () => {
  let d = deferred<string>()
  const v = await mountView(<Probe id="a" fetcher={() => d.promise} ms={MS} />, read)
  await inAct(async () => { d.reject(new Error('down')); await flush() })

  assert.deepEqual(
    { l: seen.status.loading, f: seen.status.failed, s: seen.status.stale, u: seen.status.unavailable },
    { l: false, f: true, s: false, u: true },
    'UNAVAILABLE: no value and the attempt failed. Loading is false — the '
    + 'surface knows it could not read, and "loading forever" would be a lie')
  assert.equal(seen.status.error, 'down', 'with the reason, for a surface that shows it')

  // now succeed, then fail again with a value in hand
  d = deferred<string>()
  await inAct(async () => { await flush() })
  const withValue = deferred<string>()
  const v2 = await mountView(<Probe id="b" fetcher={() => withValue.promise} ms={MS} />, read)
  await inAct(async () => { withValue.resolve('rows'); await flush() })
  assert.equal(seen.value, 'rows')
  const at = seen.status.at

  const next = deferred<string>()
  await v2.render(<Probe id="b" fetcher={() => next.promise} ms={MS} refreshKey={1} />)
  await inAct(async () => { next.reject(new Error('gone')); await flush() })
  assert.deepEqual(
    { l: seen.status.loading, f: seen.status.failed, s: seen.status.stale, u: seen.status.unavailable },
    { l: false, f: true, s: true, u: false },
    'STALE: the value survives a failed refresh, and the status says it may '
    + 'have moved on — which is the distinction the Attention queue needs')
  assert.equal(seen.value, 'rows', 'a failed refresh does not erase what was last true')
  assert.equal(seen.status.at, at, 'the "as of" still points at the last SUCCESS')
  await v.unmount(); await v2.unmount()
})

// ⚠ §3 AND §3.1 DRIVE TWO TICKS INSIDE ONE EFFECT RUN, and that distinction is
// the whole test. A `refreshKey` change also produces two requests — but it
// RE-RUNS the effect, so the previous closure's `dead` flag drops the older
// completion and the sequence guard is never consulted. Written that way first,
// both cases passed with the guard deleted: vacuous, and I only found it by
// running the mutant. The interval is what overlaps ticks WITHIN one run, which
// is the race the guard exists for (the livebus bump does the same in the real
// app, routinely).

/** let the short interval fire, on the real clock */
const interval = (ms: number) => inAct(async () => {
  await new Promise((r) => { setTimeout(r, ms) })
  await flush()
})

test('§3 an older completion never overrides a newer accepted one', async () => {
  const first = deferred<string>()
  const second = deferred<string>()
  let call = 0
  const fetcher = () => (++call === 1 ? first.promise : second.promise)
  // a short interval so a SECOND tick is issued inside the same effect run
  const v = await mountView(<Probe id="a" fetcher={fetcher} ms={30} />, read)
  await interval(90)
  assert.ok(call >= 2, 'two requests are in flight in the same run')

  await inAct(async () => { second.resolve('newer'); await flush() })
  assert.equal(seen.value, 'newer')

  await inAct(async () => { first.resolve('older'); await flush() })
  assert.equal(seen.value, 'newer',
    'the slower earlier request must not overwrite the newer answer')
  await v.unmount()
})

test('§3.1 and an older FAILURE must not mark a newer success stale', async () => {
  const first = deferred<string>()
  const second = deferred<string>()
  let call = 0
  const fetcher = () => (++call === 1 ? first.promise : second.promise)
  const v = await mountView(<Probe id="a" fetcher={fetcher} ms={30} />, read)
  await interval(90)
  assert.ok(call >= 2)

  await inAct(async () => { second.resolve('fresh'); await flush() })
  await inAct(async () => { first.reject(new Error('slow failure')); await flush() })
  assert.equal(seen.value, 'fresh')
  assert.deepEqual(
    { f: seen.status.failed, s: seen.status.stale },
    { f: false, s: false },
    'ordering protects the STATUS too — a stale failure landing after a fresh '
    + 'success would otherwise mark good data as untrustworthy')
  await v.unmount()
})

test('§4 an answer for the PREVIOUS identity never leaks into the new one', async () => {
  const orgA = deferred<string>()
  const orgB = deferred<string>()
  const v = await mountView(<Probe id="orgA" fetcher={() => orgA.promise} ms={MS} />, read)
  // switch organizations before A has answered
  await v.render(<Probe id="orgB" fetcher={() => orgB.promise} ms={MS} />)
  assert.equal(seen.value, null, 'the new identity starts empty, not on A\'s data')
  assert.equal(seen.status.loading, true)

  await inAct(async () => { orgA.resolve('A rows'); await flush() })
  assert.equal(seen.value, null,
    'A\'s late answer is not a late answer about B — it is about something else')
  assert.equal(seen.status.loading, true, 'and it does not resolve B\'s first load either')

  await inAct(async () => { orgB.resolve('B rows'); await flush() })
  assert.equal(seen.value, 'B rows')
  await v.unmount()
})

test('§4.1 a late FAILURE from the previous identity does not mark the new one', async () => {
  const orgA = deferred<string>()
  const orgB = deferred<string>()
  const v = await mountView(<Probe id="orgA" fetcher={() => orgA.promise} ms={MS} />, read)
  await v.render(<Probe id="orgB" fetcher={() => orgB.promise} ms={MS} />)
  await inAct(async () => { orgB.resolve('B rows'); await flush() })
  await inAct(async () => { orgA.reject(new Error('A died')); await flush() })
  assert.deepEqual(
    { f: seen.status.failed, s: seen.status.stale, u: seen.status.unavailable },
    { f: false, s: false, u: false },
    'the organization the user left failing says nothing about the one they are in')
  assert.equal(seen.value, 'B rows')
  await v.unmount()
})

test('§5 usePolled is the same implementation with the status dropped', async () => {
  // the value-only signature every existing panel uses, unchanged
  const d = deferred<string>()
  let calls = 0
  function ValueOnly() {
    const value = usePolled(() => { calls++; return d.promise }, ['a'], MS)
    return <span>{value ?? ''}</span>
  }
  const v = await mountView(<ValueOnly />, read)
  assert.equal(v.last(), '')
  await inAct(async () => { d.resolve('one'); await flush() })
  assert.equal(v.last(), 'one')
  assert.equal(calls, 1,
    'ONE fetch, not two — a value-only reader must not cost a second poller')
  await v.unmount()
})

test('§5.1 a refreshKey change refetches WITHOUT blanking the value', async () => {
  // the read-ack bump: resetting there would blank the inbox on every
  // mark-read, which is why the reset is keyed on deps and not on refreshKey
  const first = deferred<string>()
  const second = deferred<string>()
  let call = 0
  const fetcher = () => (++call === 1 ? first.promise : second.promise)
  const v = await mountView(<Probe id="a" fetcher={fetcher} ms={MS} />, read)
  await inAct(async () => { first.resolve('one'); await flush() })
  assert.equal(seen.value, 'one')

  await v.render(<Probe id="a" fetcher={fetcher} ms={MS} refreshKey={1} />)
  assert.equal(seen.value, 'one', 'still on screen while the refetch is in flight')
  assert.equal(seen.status.loading, false, 'and not pretending to be a first load')

  await inAct(async () => { second.resolve('two'); await flush() })
  assert.equal(seen.value, 'two')
  await v.unmount()
})
