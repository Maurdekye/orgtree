// timefmt.test.ts — assignment 19's frontend half: every timestamp the UI
// shows is rendered in the USER'S local timezone, and none of them is UTC.
//
// Run:  cd frontend && node tests/run.mjs timefmt
//
// These drive the REAL formatters the screen calls, through the real zone
// override, rather than a parallel copy that could agree with itself while
// disagreeing with the app. The zones are chosen for what they disagree
// about:
//   · Asia/Jerusalem   — the user's own zone, and it observes DST
//   · America/New_York — WEST of UTC, so its calendar DATE differs from UTC's
//                        every evening: the rollover case
//   · Asia/Kolkata     — a HALF-HOUR offset, which catches anything that
//                        quietly assumes whole hours
//
// ⚠ THE OLD CODE WOULD HAVE PASSED A WEAKER VERSION OF THIS FILE. Nine of the
// fourteen defects were `at.slice(5, 16).replace('T', ' ')` — which returns a
// perfectly plausible "09-05 01:11" and is UTC by construction. A test that
// only asserted "the output looks like a timestamp" was always going to be
// green. So every check below asserts the SPECIFIC local reading, and several
// assert that the UTC reading is absent.

import './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  browserZone, displayZone, fmtClock, fmtDay, fmtFull, fmtHm, fmtMonth,
  fmtShort, fmtStamp, fmtWhen, isToday, localizeFreezeUntil, localizeStamps,
  setDisplayZone,
} from '../src/timefmt'

const JERUSALEM = 'Asia/Jerusalem'
const NEW_YORK = 'America/New_York'
const KOLKATA = 'Asia/Kolkata'

// 2026-09-05T01:11:27.340Z — in the evening-UTC band where the local date and
// the UTC date come apart.
const INSTANT = '2026-09-05T01:11:27.340Z'
// the 4th in UTC, the 5th in Jerusalem, still the 4th in New York
const ROLLOVER = '2026-09-04T22:30:00.000Z'
// Israel's 2026 spring-forward: 02:00 IST becomes 03:00 IDT at 2026-03-27T00:00Z
const BEFORE_DST = '2026-03-26T23:30:00Z'
const AFTER_DST = '2026-03-27T00:30:00Z'

test.afterEach(() => { setDisplayZone(null) })

// ⚠ THE INERTNESS GATE. jsdom runs on node's own ICU. A build with only
// English-locale data still knows these zones, but a `--with-intl=none` node
// would not — and then every check below would pass vacuously by formatting
// everything in one zone. Ask the real question by doing the real thing.
const zonesWork = (() => {
  try {
    setDisplayZone(JERUSALEM)
    const a = fmtShort(INSTANT)
    setDisplayZone(NEW_YORK)
    const b = fmtShort(INSTANT)
    setDisplayZone(null)
    return a !== b
  } catch { setDisplayZone(null); return false }
})()

if (!zonesWork) {
  test('⚠ INERT — this node has no timezone data; zone checks cannot run', () => {
    assert.fail('Intl cannot distinguish two zones here. These checks are '
      + 'NOT passing, they are unable to run. Rebuild node with full ICU.')
  })
}

// ------------------------------------------------------------------ zones
test('one instant reads differently in each of three zones', () => {
  setDisplayZone(JERUSALEM)
  const jer = fmtStamp(INSTANT)
  setDisplayZone(NEW_YORK)
  const nyc = fmtStamp(INSTANT)
  setDisplayZone(KOLKATA)
  const kol = fmtStamp(INSTANT)
  assert.equal(jer, '2026-09-05 04:11')
  assert.equal(nyc, '2026-09-04 21:11')
  assert.equal(kol, '2026-09-05 06:41')     // the half-hour zone
  assert.equal(new Set([jer, nyc, kol]).size, 3)
  // fmtShort is the same reading without the year — the dense-row form that
  // replaced `at.slice(5, 16)`, so it must still carry the LOCAL month/day
  setDisplayZone(NEW_YORK)
  assert.equal(fmtShort(INSTANT), '09-04 21:11')
})

test('the DATE rolls over in the user\'s zone, not UTC\'s', () => {
  // ⚠ THE CASE A STRING SLICE CANNOT GET RIGHT. `ROLLOVER.slice(0, 10)` says
  // the 4th for everyone on earth; it is the 5th in Jerusalem.
  assert.equal(ROLLOVER.slice(0, 10), '2026-09-04')   // what the old code said
  setDisplayZone(JERUSALEM)
  assert.ok(fmtStamp(ROLLOVER).startsWith('2026-09-05'), fmtStamp(ROLLOVER))
  assert.equal(fmtDay(ROLLOVER), 'Sep 5')
  setDisplayZone(NEW_YORK)
  assert.ok(fmtStamp(ROLLOVER).startsWith('2026-09-04'), fmtStamp(ROLLOVER))
  assert.equal(fmtDay(ROLLOVER), 'Sep 4')
})

test('no formatter reproduces the UTC reading of the instant', () => {
  for (const tz of [JERUSALEM, NEW_YORK, KOLKATA]) {
    setDisplayZone(tz)
    for (const out of [fmtStamp(INSTANT), fmtShort(INSTANT), fmtFull(INSTANT),
                       fmtClock(INSTANT), fmtHm(INSTANT)]) {
      assert.ok(!out.includes('01:11'),
        `the UTC reading leaked into ${tz}: ${out}`)
      // ⚠ NOT a bare `includes('T')`: the zone label is allowed to contain
      // one ("IDT", "EDT", "IST"), and an assertion that forbids it would be
      // testing the alphabet rather than the timezone. What must be gone is
      // the ISO SHAPE — a `T` between date and time, and a trailing `Z`.
      assert.ok(!/\dT\d/.test(out), `ISO T separator survived: ${out}`)
      assert.ok(!/\dZ/.test(out), `trailing Z survived: ${out}`)
    }
  }
})

test('daylight saving is followed across the boundary', () => {
  setDisplayZone(JERUSALEM)
  // one hour of UTC produces TWO hours of local across a spring-forward
  assert.ok(fmtShort(BEFORE_DST).endsWith('01:30'), fmtShort(BEFORE_DST))
  assert.ok(fmtShort(AFTER_DST).endsWith('03:30'), fmtShort(AFTER_DST))
})

test('the zone label follows the DST state, not just the zone', () => {
  setDisplayZone(JERUSALEM)
  const winter = fmtFull('2026-01-15T12:00:00Z')
  const summer = fmtFull('2026-07-15T12:00:00Z')
  assert.notEqual(winter.split(' ').pop(), summer.split(' ').pop())
})

// ------------------------------------------------------------------ shapes
test('the shapes are stable regardless of locale', () => {
  // ⚠ `toLocaleString` would render "9/5/2026" or "05/09/2026" depending on
  // the browser's locale — ambiguous for the first nine days of a month.
  // These are assembled from parts so only the ZONE varies.
  setDisplayZone(JERUSALEM)
  assert.equal(fmtStamp(INSTANT), '2026-09-05 04:11')
  assert.equal(fmtShort(INSTANT), '09-05 04:11')   // no year, by design
  assert.equal(fmtHm(INSTANT), '04:11')
  assert.equal(fmtClock(INSTANT), '4:11 AM')   // the pre-existing shape
  assert.equal(fmtDay(INSTANT), 'Sep 5')
  assert.equal(fmtMonth(INSTANT), 'Sep 2026')
  assert.ok(fmtFull(INSTANT).startsWith('2026-09-05 04:11:27'), fmtFull(INSTANT))
})

test('epoch seconds and milliseconds both parse', () => {
  setDisplayZone(JERUSALEM)
  const secs = Date.parse(INSTANT) / 1000
  assert.equal(fmtStamp(secs), '2026-09-05 04:11')
  assert.equal(fmtStamp(Date.parse(INSTANT)), '2026-09-05 04:11')
})

test('an unreadable instant draws nothing rather than guessing', () => {
  setDisplayZone(JERUSALEM)
  for (const junk of [null, undefined, '', 'not a date', '2026-13-45T99:99Z']) {
    assert.equal(fmtStamp(junk), '', String(junk))
    assert.equal(fmtFull(junk), '', String(junk))
    assert.equal(fmtDay(junk), '', String(junk))
  }
  // ⚠ and NOT the raw field printed back, which is how a UTC string reached
  // the screen in the first place
  assert.equal(fmtStamp('2026-13-45T99:99Z'), '')
})

test('isToday is asked in the user\'s zone', () => {
  setDisplayZone(JERUSALEM)
  assert.equal(isToday(new Date().toISOString()), true)
  assert.equal(isToday('1999-01-01T00:00:00Z'), false)
  assert.equal(isToday(null), false)
})

test('fmtWhen drops the date only when it really is today', () => {
  setDisplayZone(JERUSALEM)
  // "clock-only" cannot be tested as "contains no space" — the clock itself
  // is "4:11 AM". The thing that must be absent is the DATE.
  assert.ok(!/[A-Z][a-z]{2} \d/.test(fmtWhen(new Date().toISOString())),
    `today should carry no date: ${fmtWhen(new Date().toISOString())}`)
  assert.ok(fmtWhen('1999-01-01T12:00:00Z').includes('Jan 1'),
    fmtWhen('1999-01-01T12:00:00Z'))
})

// ------------------------------------------- the degraded paths never UTC
test('an unusable zone override falls back to LOCAL, never to UTC', () => {
  // ⚠ The failure this guards is a `catch` that reaches for UTC because it is
  // the "neutral" choice. It is not neutral; it is the defect.
  setDisplayZone('Mars/Olympus')
  assert.equal(displayZone(), undefined,
    'an unloadable zone must be dropped, not honoured')
  const out = fmtStamp(INSTANT)
  const browserLocal = new Intl.DateTimeFormat('en-US', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(INSTANT))
  const p: Record<string, string> = {}
  for (const x of browserLocal) p[x.type] = x.value
  assert.equal(out, `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`,
    'a bad override must fall through to the browser\'s own zone')
})

test('browserZone reports something', () => {
  assert.equal(typeof browserZone(), 'string')
})


// ───────────────────────── server-written prose, localised at render ────
//
// The server writes `⟦t:<instant>|<style>⟧` into durable rows; `md()` runs
// these on every render. The point of doing it here rather than on the server
// is that the SAME stored row reads correctly in any zone, at any later time.

const TOK = (iso: string, style = 'stamp') => `⟦t:${iso}|${style}⟧`

test('a token becomes local text, and the same row differs by zone', () => {
  const row = `FROM peer (peer) · message · ${TOK(INSTANT, 'full')}`
  setDisplayZone(JERUSALEM)
  const jer = localizeStamps(row)
  setDisplayZone(NEW_YORK)
  const nyc = localizeStamps(row)
  assert.ok(jer.includes('2026-09-05 04:11:27'), jer)
  assert.ok(nyc.includes('2026-09-04 21:11:27'), nyc)
  assert.notEqual(jer, nyc)
  // ⭐ THE PROPERTY THIS ARCHITECTURE EXISTS FOR: the stored row never
  // changed. Both readings came from one durable string.
  assert.ok(!jer.includes('⟦t:') && !nyc.includes('⟦t:'))
})

test('⭐ a row written under one zone reads correctly under another', () => {
  // the server produced this months ago and has no idea where the reader is
  const stored = `· ${TOK('2026-01-15T12:00:00.000Z', 'full')}`
  setDisplayZone(JERUSALEM)
  const winter = localizeStamps(stored)
  // ⚠ INSTANT-SPECIFIC ABBREVIATION. A January instant must read IST even
  // though "now" is summer. Deriving the label from the current moment — the
  // defect in the earlier server-side draft — would stamp it IDT.
  assert.ok(/IST|GMT\+2/.test(winter), `winter instant: ${winter}`)
  const summer = localizeStamps(`· ${TOK('2026-07-15T12:00:00.000Z', 'full')}`)
  assert.ok(/IDT|GMT\+3/.test(summer), `summer instant: ${summer}`)
  assert.notEqual(winter.split(' ').pop(), summer.split(' ').pop())
})

test('each style renders its own shape', () => {
  setDisplayZone(JERUSALEM)
  assert.equal(localizeStamps(TOK(INSTANT, 'stamp')), '2026-09-05 04:11')
  assert.ok(localizeStamps(TOK(INSTANT, 'full')).includes('04:11:27'),
    localizeStamps(TOK(INSTANT, 'full')))
  // `clock` carries the date only when the instant is NOT today — which is
  // the shape `_reset_label` had before this change and the reason the style
  // exists. Both halves are checked, because "today" moves.
  const old = localizeStamps(TOK('2024-03-01T12:00:00.000Z', 'clock'))
  assert.ok(old.includes('Mar 1'), old)
  const now = localizeStamps(TOK(new Date().toISOString(), 'clock'))
  assert.ok(!/[A-Z][a-z]{2} \d/.test(now), `today needs no date: ${now}`)
})

test('text with no token is returned untouched', () => {
  setDisplayZone(JERUSALEM)
  const prose = 'I ran it at 2026-09-05T01:11:27Z and it failed'
  assert.equal(localizeStamps(prose), prose)
  assert.equal(localizeStamps(''), '')
})

test('an unparseable instant leaves the token visible, not a blank', () => {
  // silently deleting text somebody is reading is worse than showing
  // something obviously wrong that they can report
  setDisplayZone(JERUSALEM)
  const bad = '⟦t:not-a-date|full⟧'
  assert.equal(localizeStamps(bad), bad)
})

test('several tokens in one row all render', () => {
  setDisplayZone(JERUSALEM)
  const row = `${TOK(INSTANT)} and also ${TOK('2026-01-15T12:00:00.000Z')}`
  const out = localizeStamps(row)
  assert.ok(!out.includes('⟦t:'), out)
  assert.ok(out.includes('2026-09-05') && out.includes('2026-01-15'), out)
})

// ──────────────────── freeze records stored before assignment 19 ──────
//
// ⚠ Matching a clock spelling does NOT prove where it came from:
// `_parse_limit_reset` really returns '1:40pm' and 'Fri 4:11am' out of
// PROVIDER error text, identical to what `_reset_label` emits. The rule is
// not about origin — a label that is nothing but a clock carries no date and
// no zone, so it says strictly less than the authoritative `until_ts` and can
// be re-rendered without losing anything. A clock that is NOT alone is left
// exactly as it is.

const TS = Date.parse(INSTANT) / 1000

test('valid clock-only labels are re-rendered from until_ts', () => {
  setDisplayZone(NEW_YORK)
  const local = fmtWhen(TS)
  assert.ok(!local.includes('4:11am'), 'control: the zone really differs')
  for (const s of ['4:11am', '9pm', '9 PM', '9 pm', '1:40pm', '12:05am',
                   'Fri 4:11am', 'Fri 9pm', 'Sun 12:05am']) {
    assert.equal(localizeFreezeUntil(s, TS), local, s)
  }
  for (const s of ['capacity resets 4:11am', 'capacity resets Fri 9 PM']) {
    assert.equal(localizeFreezeUntil(s, TS), `capacity resets ${local}`, s)
  }
})

test('⭐ only REAL weekdays count — a three-letter word does not', () => {
  // `Pay 9pm` and `May 9pm` both matched a generic [A-Z][a-z]{2} weekday and
  // were rewritten. Neither is a weekday; both are ordinary text that happens
  // to precede a time.
  setDisplayZone(NEW_YORK)
  for (const s of ['Pay 9pm', 'May 9pm', 'Due 9pm', 'Sat9pm']) {
    assert.equal(localizeFreezeUntil(s, TS), s, s)
  }
  // …and the control that keeps this from passing by never converting
  assert.equal(localizeFreezeUntil('Fri 9pm', TS), fmtWhen(TS))
})

test('⭐ an impossible clock is not a clock', () => {
  setDisplayZone(NEW_YORK)
  for (const s of ['99:99pm', '13:00pm', '9:60pm', '0:30am', '24:00am']) {
    assert.equal(localizeFreezeUntil(s, TS), s, s)
  }
})

test('⭐ a clock that is not ALONE is left exactly as it is', () => {
  // THE DANGEROUS CASE. A substring replace turns these into a LOCAL time
  // still wearing the old zone — a wrong reading that looks authoritative.
  setDisplayZone(NEW_YORK)
  for (const s of ['9:00pm PST', '4:11am UTC', 'capacity resets 4:11am PST',
                   'resets 9pm', 'try again at 9 PM', '9pm tomorrow',
                   'the 9pm window']) {
    assert.equal(localizeFreezeUntil(s, TS), s, s)
  }
})

test('arbitrary descriptive provider text is untouched', () => {
  setDisplayZone(JERUSALEM)
  for (const s of ['credential rejected — replace it, then resume',
                   'network interruption — attempt 1/4',
                   'reset time unknown',
                   'capacity available — ▶ to resume',
                   'in about three hours, once the weekly window rolls',
                   'unknown — probing again shortly',
                   'the 9pm window']) {
    assert.equal(localizeFreezeUntil(s, TS), s, s)
  }
})

test('an absent or non-finite timestamp changes nothing', () => {
  // ⚠ nothing authoritative to render from; inventing a time from a string we
  // cannot place in a zone is how this whole class of bug started
  setDisplayZone(JERUSALEM)
  for (const ts of [null, undefined, 0, NaN, Infinity, -1]) {
    assert.equal(localizeFreezeUntil('capacity resets 4:11am', ts as number),
                 'capacity resets 4:11am', String(ts))
  }
  assert.equal(localizeFreezeUntil(null, TS), '')
  assert.equal(localizeFreezeUntil('', TS), '')
})

test('a tokenised freeze label goes through localizeStamps instead', () => {
  setDisplayZone(JERUSALEM)
  const out = localizeFreezeUntil(`capacity resets ⟦t:${INSTANT}|clock⟧`, 0)
  assert.ok(!out.includes('⟦t:'), out)
  assert.ok(out.startsWith('capacity resets '), out)
})
