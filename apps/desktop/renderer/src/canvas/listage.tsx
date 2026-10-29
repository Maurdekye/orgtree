// canvas/listage.tsx — the one time cell of a list row: how long ago, with the
// full local date and time as its hover and its accessible name (UX symmetry
// audit #7; USER 2026-10-29 m019c9500d23a, verbatim: "A7 use time ago in list,
// full date and time in header of detail tab"). Mail rows (and Attention's,
// which reuse them), Attention's mention rows, presentation rows and ticket
// rows all draw this cell, so a row's time reads the same in every list. The
// open message, presentation or ticket shows the full date and time in its
// header instead.
//
// A ticket's age reads the clock its list is sorted by (user 2026-09-07, the
// docket's rowAge), so its hover names that clock: "updated 2026-10-29
// 14:05:27 IST". The other lists have one clock and name none.
import { fmtAge, fmtFull } from '../timefmt'
import type { TurnStat } from '../types'

/** The hover and accessible name of a row's age: the full instant, after the
 *  clock's name when the list has more than one. */
export const ageTitle = (at: string | number | null | undefined, clock?: string): string => {
  const full = fmtFull(at)
  return full && clock ? `${clock} ${full}` : full
}

/** The hover and accessible name of a completed turn's age: "last turn ended"
 *  and the full instant, with "(killed)" when the turn was cut off. One text for
 *  the card badge, the zoom card, the tray, the map, the desk header and a pile
 *  row, so every surface that shows the age of a turn says it the same way. */
export const turnEndedTitle = (turn: TurnStat): string =>
  ageTitle(turn.at, 'last turn ended') + (turn.killed ? ' (killed)' : '')

export function ListAge({ at, clock }: { at: string | number | null | undefined; clock?: string }) {
  const title = ageTitle(at, clock)
  return <span className="mtime" title={title || undefined} aria-label={title || undefined}>{fmtAge(at)}</span>
}
