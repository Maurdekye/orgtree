// mdlocaltime.test.ts — the `md()` CACHE, which is where assignment 19's
// render-time localisation can silently stop working.
//
// Run:  cd frontend && node tests/run.mjs mdlocaltime
//
// ⚠ WHY THIS FILE EXISTS SEPARATELY FROM timefmt.test.ts. Those checks drive
// the formatters directly, and they all passed while this was broken. `md()`
// memoises by key, so localisation ran only on a cache MISS: the first render
// of a row won, and every later render of the same source text replayed it.
// A formatter can be perfectly correct and still never be called.
//
// Both checks below are positive controls in the strict sense — each one FAILS
// against the previous implementation (key = raw text) and passes against the
// current one (key = localised text). A test here that cannot distinguish
// those two is not testing the cache.

import './harness'
import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import { md } from '../src/canvas/shared'
import { fmtWhen, setDisplayZone } from '../src/timefmt'

const JERUSALEM = 'Asia/Jerusalem'
const NEW_YORK = 'America/New_York'
const INSTANT = '2026-09-05T01:11:27.340Z'
const tok = (iso: string, style = 'full') => `⟦t:${iso}|${style}⟧`

test.afterEach(() => { setDisplayZone(null) })

test('⭐ the SAME source text re-renders when the zone changes', () => {
  // one durable row, exactly as the server stored it, rendered twice
  const row = `FROM peer (peer) · message · ${tok(INSTANT)}`

  setDisplayZone(JERUSALEM)
  const a = md(row).__html
  setDisplayZone(NEW_YORK)
  const b = md(row).__html

  assert.ok(a.includes('2026-09-05 04:11:27'), `Jerusalem: ${a}`)
  assert.ok(b.includes('2026-09-04 21:11:27'), `New York: ${b}`)
  // ⚠ THE ASSERTION THAT CATCHES THE BUG. With the old key the second call
  // was a cache HIT and `b` came back byte-identical to `a` — Jerusalem's
  // time, on a New York screen, for as long as the tab stayed open.
  assert.notEqual(a, b, 'the cache served a stale zone rendering')
  assert.ok(!b.includes('04:11:27'), `Jerusalem's reading leaked: ${b}`)
})

test('⭐ a clock token re-renders across local midnight', () => {
  // `clock` drops the date when the instant is today and carries it when it
  // is not, so its rendering changes at local midnight with NO input change.
  // The cache has to notice that; nothing else will.
  //
  // This is the one check here that needs real time travel: for the current
  // instant `isToday` is true in every zone at once (it compares against
  // "now" in the same zone), so no choice of zone can stand in for a midnight.
  mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-09-05T09:00:00Z') })
  try {
    setDisplayZone(JERUSALEM)
    const at = '2026-09-05T09:00:00.000Z'          // 12:00 local, today
    const row = `resumes ${tok(at, 'clock')}`

    const today = md(row).__html
    assert.ok(!/[A-Z][a-z]{2} \d/.test(today), `today needs no date: ${today}`)

    // ⚠ NOTHING ABOUT THE ROW CHANGES — only the wall clock, past local
    // midnight. The instant is now yesterday, so it must gain a date.
    mock.timers.setTime(Date.parse('2026-09-06T09:00:00Z'))
    const tomorrow = md(row).__html
    assert.ok(/Sep 5/.test(tomorrow), `should be dated now: ${tomorrow}`)
    // THE ASSERTION THAT CATCHES THE BUG: with the old key this was a cache
    // hit and yesterday's undated rendering came back for the life of the tab.
    assert.notEqual(tomorrow, today,
      'the cache served a rendering from the wrong calendar day')
  } finally {
    mock.timers.reset()
  }
})

test('the cache still works — an unchanged render is not recomputed', () => {
  // ⚠ THE CONTROL ON THE CONTROL. If the fix had been "never cache", both
  // checks above would pass and the cache would be gone. Identity here proves
  // it is still a cache: same zone, same text, same object back.
  setDisplayZone(JERUSALEM)
  const row = `FROM peer (peer) · message · ${tok(INSTANT)}`
  assert.strictEqual(md(row), md(row))
  const plain = 'no timestamps here at all'
  assert.strictEqual(md(plain), md(plain))
})

test('prose with no token is unaffected by the zone', () => {
  const prose = 'I ran it at 2026-09-05T01:11:27Z and it failed'
  setDisplayZone(JERUSALEM)
  const a = md(prose).__html
  setDisplayZone(NEW_YORK)
  assert.equal(md(prose).__html, a)
  // authored text keeps its own timestamp verbatim — no regex sweeps content
  assert.ok(a.includes('2026-09-05T01:11:27Z'), a)
})

test('imgBase still separates entries', () => {
  setDisplayZone(JERUSALEM)
  const row = `![](x.png) · ${tok(INSTANT)}`
  assert.notEqual(md(row, 'a/').__html, md(row, 'b/').__html)
})

test('fmtWhen is what `clock` renders — the two agree', () => {
  setDisplayZone(NEW_YORK)
  assert.ok(md(tok(INSTANT, 'clock')).__html.includes(fmtWhen(INSTANT)))
})
