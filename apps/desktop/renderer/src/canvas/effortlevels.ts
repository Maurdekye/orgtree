// canvas/effortlevels.ts — the supported effort levels, on their own so the effort bar
// (and its test) need none of effort.tsx's imports.

/** the levels orgtree offers, in order — mirrors `ledger.Org.EFFORTS` and is
 *  the one list the composer's five-dot effort control (desk.tsx) and these
 *  cards share, so the two can never offer or describe different levels.
 *  Typed `readonly string[]` rather than a literal tuple on purpose: every
 *  reader here compares it against a plain string coming off the payload. */
export const EFFORT_LEVELS: readonly string[] =
  ['low', 'medium', 'high', 'xhigh', 'max']
