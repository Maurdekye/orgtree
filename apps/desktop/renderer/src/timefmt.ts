// frontend/src/timefmt.ts — THE ONE PLACE A STORED INSTANT BECOMES A TIME A
// PERSON READS.
//
// The rule (user ruling 2026-09-04, assignment 19): every timestamp this
// application generates and then shows the user is rendered in the USER'S
// LOCAL TIMEZONE. There are no visible UTC timestamps.
//
// ⚠ WHAT THIS FILE IS NOT. It is not a change to what we store. Every instant
// on the wire and on disk stays UTC ISO-8601 with a trailing `Z` — that is
// what makes ordering, comparison and interop work, and nothing here touches
// it. This module is the DISPLAY BOUNDARY: canonical instant in, local text
// out. If you find yourself wanting to store what these functions return, you
// have crossed the boundary the wrong way.
//
// ⚠ WHAT THE OLD CODE DID. It never called a date library — it sliced the
// string: `(at ?? '').slice(5, 16).replace('T', ' ')`. That never throws and
// looks exactly like a time, and it is UTC, because slicing a UTC ISO string
// can only yield UTC. Nine sites did it. If you are reaching for `.slice(` on
// a timestamp, use this file instead.
//
// No branch here formats in UTC. A zone the browser cannot load falls through
// to the browser's own zone (`Intl`'s default), which is still local.

/** The IANA zone the user is actually in, as the browser reports it —
 *  `Intl.DateTimeFormat().resolvedOptions().timeZone`, e.g. "Asia/Jerusalem".
 *
 *  The browser is the only authority on this. Nothing is persisted anywhere:
 *  server-written prose carries the instant and is rendered here on read. */
export const browserZone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || ''
  } catch {
    return ''
  }
}

/** Test-only zone override. Production never sets this; the suites set it to
 *  drive Asia/Jerusalem, a DST boundary and a date rollover through the very
 *  same functions the screen uses, rather than through a parallel copy that
 *  could agree with itself while disagreeing with the app. */
let override: string | null = null
export const setDisplayZone = (tz: string | null): void => { override = tz }

/** The zone every formatter below resolves against.
 *
 *  An override the browser cannot load is dropped, not honoured. `undefined`
 *  hands `Intl` its own default — the browser's local zone. Still local. */
export const displayZone = (): string | undefined => {
  const tz = override ?? browserZone()
  if (!tz) return undefined
  try {
    // does this browser actually know the zone? constructing is the only
    // honest test — a name check would accept "Mars/Olympus" and throw later
    new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(0)
    return tz
  } catch {
    return undefined
  }
}

/** Parse a canonical instant. Accepts the ISO strings the API serves and the
 *  epoch-seconds/-milliseconds numbers a few payloads use.
 *
 *  Null for anything unparseable; every caller turns that into "". A stamp we
 *  cannot read is one we must not draw — printing the raw field back is how a
 *  UTC string reached the screen before. */
const parse = (at: string | number | null | undefined): Date | null => {
  if (at == null || at === '') return null
  const d = typeof at === 'number'
    // seconds vs milliseconds: anything below ~1e11 is seconds (1e11 ms is
    // 1973; 1e11 s is the year 5138) — the same split the payloads use
    ? new Date(Math.abs(at) < 1e11 ? at * 1000 : at)
    : new Date(at)
  return Number.isFinite(d.getTime()) ? d : null
}

type Parts = Record<string, string>
const partsOf = (d: Date, opts: Intl.DateTimeFormatOptions): Parts => {
  const fmt = new Intl.DateTimeFormat('en-US',
    { ...opts, timeZone: displayZone() })
  const out: Parts = {}
  for (const p of fmt.formatToParts(d)) out[p.type] = p.value
  return out
}

// ⚠ WHY `formatToParts` AND NOT A LOCALE STRING. `toLocaleString` renders in
// the user's LOCALE as well as their zone, so the same instant is "9/5/2026"
// in one browser and "05/09/2026" in another — ambiguous for exactly the
// leading nine days of a month where it matters most. The shapes below are
// assembled by hand from parts so the zone varies and the layout does not.
const NUM: Intl.DateTimeFormatOptions = {
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
}

/** `2026-09-05 04:11` — the everyday absolute stamp, local.
 *  Replaces `at.slice(0, 16).replace('T', ' ')`. */
export const fmtStamp = (at: string | number | null | undefined): string => {
  const d = parse(at)
  if (!d) return ''
  const p = partsOf(d, NUM)
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`
}

/** `09-05 04:11` — the same thing without the year, for dense rows.
 *  Replaces `at.slice(5, 16).replace('T', ' ')`. */
export const fmtShort = (at: string | number | null | undefined): string => {
  const d = parse(at)
  if (!d) return ''
  const p = partsOf(d, NUM)
  return `${p.month}-${p.day} ${p.hour}:${p.minute}`
}

/** `2026-09-05 04:11:27 IDT` — the full form, with the zone said out loud.
 *
 *  This replaces the sites that printed a raw ISO string ending in `Z`. The
 *  `Z` at least said which zone it meant, so the label keeps the trade
 *  positive rather than swapping one ambiguity for another.
 *
 *  ⚠ The label comes from `Intl` for THIS instant, so a winter instant reads
 *  IST and a summer one IDT. Deriving it from "now" would stamp every
 *  historical instant with the current season's abbreviation. */
export const fmtFull = (at: string | number | null | undefined): string => {
  const d = parse(at)
  if (!d) return ''
  const p = partsOf(d, { ...NUM, second: '2-digit', timeZoneName: 'short' })
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`
    + `${p.timeZoneName ? ` ${p.timeZoneName}` : ''}`
}

/** `4:11 AM` — wall-clock only, for a row that already says which day it is.
 *
 *  ⚠ The spacing and case are deliberately the OLD ones — `accounts.tsx` and
 *  `App.tsx` already rendered "4:11 AM" via `toLocaleTimeString`. Restyling
 *  surfaces that were already local is a visible change nobody asked for.
 *  `acctstate.test.tsx` §1.3 pins it. */
export const fmtClock = (at: string | number | null | undefined): string => {
  const d = parse(at)
  if (!d) return ''
  const p = partsOf(d, { hour: 'numeric', minute: '2-digit', hour12: true })
  return `${p.hour}:${p.minute}${p.dayPeriod ? ` ${p.dayPeriod}` : ''}`
}

/** `Sep 5` — a calendar day in the user's zone.
 *
 *  ⚠ The rollover is why this is done in the zone, not on the string:
 *  2026-09-04T22:30Z is the 4th in UTC, the 5th in Jerusalem and the 4th in
 *  New York. A slice gets that wrong every evening east of Greenwich. */
export const fmtDay = (at: string | number | null | undefined): string => {
  const d = parse(at)
  if (!d) return ''
  const p = partsOf(d, { month: 'short', day: 'numeric' })
  return `${p.month} ${p.day}`
}

/** "today in the user's zone?" — `toDateString()` reads the browser's zone,
 *  which ignores an override (including in the tests).
 *
 *  ⚠ Its answer CHANGES AT LOCAL MIDNIGHT, which is why anything caching a
 *  `clock` rendering must key on the rendered text (see `md()`). */
export const isToday = (at: string | number | null | undefined): boolean => {
  const d = parse(at)
  if (!d) return false
  const day = (x: Date) => {
    const p = partsOf(x, { year: 'numeric', month: '2-digit', day: '2-digit' })
    return `${p.year}-${p.month}-${p.day}`
  }
  return day(d) === day(new Date())
}

/** `04:11` — 24-hour wall clock, for a row where the day is already implied. */
export const fmtHm = (at: string | number | null | undefined): string => {
  const d = parse(at)
  if (!d) return ''
  const p = partsOf(d, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  return `${p.hour}:${p.minute}`
}

/** `Sep 2026` — a month, in the user's zone. */
export const fmtMonth = (at: string | number | null | undefined): string => {
  const d = parse(at)
  if (!d) return ''
  const p = partsOf(d, { year: 'numeric', month: 'short' })
  return `${p.month} ${p.year}`
}

/** `4:11 AM`, or `Sep 5 4:11 AM` once it is not today — a reset row's
 *  "until when". */
export const fmtWhen = (at: string | number | null | undefined): string => {
  const d = parse(at)
  if (!d) return ''
  return isToday(d.toISOString()) ? fmtClock(at) : `${fmtDay(at)} ${fmtClock(at)}`
}

/* ── SERVER-WRITTEN PROSE ────────────────────────────────────────────────
 *
 * Some user-visible text is written by the SERVER and stored as a durable row
 * — the mail header replayed in an agent's chat, a freeze's reset label, a
 * crash-report body. The server cannot format those: it does not know the
 * user's zone, and a zone recorded once would be wrong later if the user
 * moved or the row were reread elsewhere.
 *
 * So the server writes the canonical instant inside a token and this turns it
 * into local text at render. `md()` applies it to every rendered surface, so
 * a durable row relocalises on every read rather than freezing what was true
 * when it was written.
 *
 * ⚠ Ordinary prose containing the literal token would be rewritten too. The
 * delimiters are chosen to make that vanishingly unlikely, not impossible.
 */
const TOKEN = /⟦t:([^|⟧]+)\|([a-z]+)⟧/g

export const localizeStamps = (text: string): string =>
  (!text || !text.includes('⟦t:')) ? text
    : text.replace(TOKEN, (whole, iso: string, style: string) => {
      const out = style === 'clock' ? fmtWhen(iso)
        : style === 'full' ? fmtFull(iso)
          : fmtStamp(iso)
      // an unparseable instant leaves the token alone rather than blanking
      // text somebody is reading — visible and reportable beats silent
      return out || whole
    })

/** A freeze's `until` label, re-rendered from the authoritative `until_ts`
 *  when — and only when — the WHOLE string is a valid clock-only label.
 *
 *  A label that is nothing but a clock carries no date and no zone, so it
 *  says strictly less than `until_ts`, which is the authoritative instant for
 *  the same freeze. Re-rendering it locally therefore loses nothing. This is
 *  deliberately not a claim about origin: `_parse_limit_reset` lifts clock
 *  spellings out of provider errors that are identical to the ones
 *  `supervisor._reset_label` emits, and no pattern separates the two.
 *
 *  Recognised, whole string only — hours 1-12, real minutes, spacing and case
 *  optional, an optional real weekday, and `api.py`'s optional prefix:
 *    `9pm` · `9 PM` · `1:40pm` · `Fri 4:11am` · `capacity resets Fri 4:11am`
 *
 *  ⚠ EVERYTHING ELSE IS RETURNED BYTE FOR BYTE, and the case that matters is
 *  a clock that is NOT alone: `'9:00pm PST'` names a zone this cannot honour,
 *  so a substring replace would leave a LOCAL time still wearing `PST` — a
 *  wrong reading that looks authoritative. Same for `'resets 9pm'`, `'Pay
 *  9pm'` and any descriptive prose. Records written after assignment 19 carry
 *  a `⟦t:…⟧` token and go to `localizeStamps` instead.
 *
 *  With no usable `until_ts` the label is returned untouched — there is
 *  nothing authoritative to render from. */
//   optional prefix · optional REAL weekday · hours 1-12 · real minutes
const CLOCK_ONLY_LABEL =
  /^(capacity resets )?(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) )?(?:1[0-2]|0?[1-9])(?::[0-5]\d)?\s?[AaPp][Mm]$/
export const localizeFreezeUntil = (
  until: string | null | undefined, untilTs: number | null | undefined,
): string => {
  const text = until ?? ''
  if (!text) return ''
  if (text.includes('⟦t:')) return localizeStamps(text)
  if (untilTs == null || !Number.isFinite(untilTs) || untilTs <= 0) return text
  const m = CLOCK_ONLY_LABEL.exec(text)
  if (!m) return text
  const local = fmtWhen(untilTs)
  return local ? `${m[1] ?? ''}${local}` : text
}
