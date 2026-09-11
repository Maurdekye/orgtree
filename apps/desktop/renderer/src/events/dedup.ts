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
// ⚠ SUPPRESSING A ROW MUST NEVER SUPPRESS ITS CONTENT, which decides two
// rules (coordinator-astra review, 2026-09-11 — an earlier draft kept the
// first copy outright and pinned a stale scrollback snapshot ahead of a
// fresher one):
//   · WITHIN one list the LAST copy's content renders at the FIRST copy's
//     POSITION. Two entries in one list are two SNAPSHOTS of one row and the
//     later one is the newer read (`refreshConvo` joins retained scrollback
//     ahead of the fresh window), so the newer content wins where the reader
//     already expects it.
//   · ACROSS lists the earlier list wins OUTRIGHT. Lists are different
//     SOURCES with a known precedence: the durable transcript is drawn above
//     the live tail, whose copy the server truncates, so taking the later
//     source would trade whole text for cut.
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
//   · NOT stateful across renders. Nothing is cached between passes, so a row
//     that grows — streaming text, a tool result landing — keeps growing.
//
// ⚠ DEDUPLICATE ON THE MOST DURABLE ID A ROW HAS, and claim the others
// (coordinator-astra review, 2026-09-11). A row can arrive under more than one
// name, and picking the wrong one makes this guard miss the very duplicate it
// exists for:
//   · `native_event_id` is the CLI/journal RECORD uuid. It identifies the
//     EVENT, never changes, and is the same string on a transcript row and on
//     its live twin.
//   · `event_id` is what reply_events._annotate put on the wire: a snapshot id
//     hashed over the incarnation, the source AND THE QUOTED TEXT. Two reads
//     of one row whose text moved on therefore arrive under DIFFERENT
//     event_ids while their native_event_id is identical — deduplicating on
//     event_id alone renders both, which is the doubled message reported.
//   · a `tool` row answers to the CLI's tool_use_id, a DIFFERENT id space.
//     The caller tags BOTH domains before handing an id here — tagging only
//     one would leave the other raw, and an opaque event id that happened to
//     read `tool:abc` would then collide with the tool whose id is `abc`.
// So the durable id decides, the others are claimed alongside it, a row with
// only one of them uses that one, and every id is an opaque string here —
// nothing in this file parses one.

/** A single render pass's "already shown" set. Make one per render, feed every
 *  message list through it in the order those lists appear on screen. */
export interface EventDedup {
  /** May a row with this id render? Records the id when it may. */
  keep(id: unknown): boolean
  /** Record a SECOND identity the row being rendered also owns, so a later
   *  list cannot draw the same event under that other name. Deliberately
   *  returns nothing: the answer to "may it render" was already decided by
   *  the identity it was deduplicated on, and a discarded boolean here reads
   *  like a forgotten check (coordinator-astra review, 2026-09-11 — where an
   *  earlier draft really had forgotten one). */
  claim(id: unknown): void
  /** `rows` with each id rendered once: at its FIRST position in this list,
   *  carrying the content of its LAST copy in this list, and omitted entirely
   *  if an earlier list already drew it. */
  list<T>(rows: readonly T[], idOf: (row: T) => unknown): T[]
  /** how many rows this pass has suppressed — for tests and diagnostics */
  readonly dropped: number
}

/** a readable id, or null for anything that is not an identity */
function ident(id: unknown): string | null {
  return typeof id === 'string' && id ? id : null
}

export function eventDedup(): EventDedup {
  const seen = new Set<string>()
  let dropped = 0
  const guard: EventDedup = {
    keep(id: unknown): boolean {
      // An id we cannot read is not an identity. Render it.
      const key = ident(id)
      if (key === null) return true
      if (seen.has(key)) { dropped++; return false }
      seen.add(key)
      return true
    },
    claim(id: unknown): void {
      const key = ident(id)
      if (key !== null) seen.add(key)
    },
    list<T>(rows: readonly T[], idOf: (row: T) => unknown): T[] {
      // Index the repeats FIRST, so the copy that renders is the freshest
      // snapshot this list holds rather than whichever one came first. The map
      // is allocated only when a repeat actually exists — the ordinary render
      // has none, and must not pay for the rare one.
      let newest: Map<string, T> | null = null
      const within = new Set<string>()
      for (const row of rows) {
        const key = ident(idOf(row))
        if (key === null) continue
        if (within.has(key)) (newest ??= new Map()).set(key, row)
        else within.add(key)
      }
      const out: T[] = []
      for (const row of rows) {
        const key = ident(idOf(row))
        if (key === null) { out.push(row); continue }   // no id, never collapsed
        if (!guard.keep(key)) continue                  // an earlier list drew it
        out.push(newest?.get(key) ?? row)               // first place, newest content
      }
      return out
    },
    get dropped() { return dropped },
  }
  return guard
}
