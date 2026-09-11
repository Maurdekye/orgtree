// dedup.ts — THE RENDER-BOUNDARY DUPLICATE GUARD (user request 2026-09-11:
// "intermittent double messages persist ... a final guard preventing a second
// rendered event with the same ID, even if the upstream duplicate source is
// unknown").
//
// Everything else that keeps a message visible exactly once reasons about
// WHERE a message is (queued / arriving / sent) and hands off between those
// representations: the server's `_sweep_live`, `mergeCommitted`, the ask-answer
// handoff. Each of those is a rule about a lifecycle, and a rule about a
// lifecycle can be wrong. This is not one of those. It is the LAST thing
// between a list and the DOM, and it asserts one thing only:
//
//     within ONE view, one stable event id renders at most once.
//
// What it deliberately is NOT:
//   · NOT text matching. Two different events that happen to say the same
//     words are two events, and both render. (The server-side live sweep
//     matches by a 300-char text prefix; this does not, and must not, because
//     a text rule can hide a real repeated message.)
//   · NOT global. The set lives for one render of one view. Two desks showing
//     the same agent, or two different agents, each dedup their own list — a
//     shared set would let one window blank a row in another.
//   · NOT an identity guess. A row with NO id is NEVER collapsed. Missing is
//     "unknown", not "same as the last unknown"; collapsing those would drop
//     genuine messages from any legacy or id-less path.
//   · NOT a merge. The FIRST occurrence in render order wins and later ones
//     are dropped, so the row keeps its position and whatever the earlier list
//     holds — which is the richer copy by construction, because the durable
//     transcript renders above the live tail and the live copy is the one the
//     server truncates (LiveRow.truncated, capped at 2000 chars).
//
// Ids are compared as opaque strings and never parsed: transcript rows carry
// the server's `_stable_event_id` (a provider id, or a content hash), live
// rows carry `live:<boot>:<slug>:<node>:<n>`, transient rows carry a
// reply_events id. Those are different namespaces on purpose — see
// docs/dedup notes in the commit message for which overlaps this therefore
// can and cannot catch.

/** A single render pass's "already shown" set. Make one per render, feed every
 *  message list through it in the order those lists appear on screen. */
export interface EventDedup {
  /** May a row with this id render? Records the id when it may. */
  keep(id: unknown): boolean
  /** `rows` with every repeat of an already-shown id removed. */
  list<T>(rows: readonly T[], idOf: (row: T) => unknown): T[]
  /** how many rows this pass has suppressed — for tests and diagnostics */
  readonly dropped: number
}

export function eventDedup(): EventDedup {
  const seen = new Set<string>()
  let dropped = 0
  const guard = {
    keep(id: unknown): boolean {
      // An id we cannot read is not an identity. Render it.
      if (typeof id !== 'string' || !id) return true
      if (seen.has(id)) { dropped++; return false }
      seen.add(id)
      return true
    },
    list<T>(rows: readonly T[], idOf: (row: T) => unknown): T[] {
      // `filter` rather than a copy-on-write: the common case is no duplicate
      // at all, and returning the same-length array keeps the render cheap.
      return rows.filter((row) => guard.keep(idOf(row)))
    },
    get dropped() { return dropped },
  }
  return guard
}
