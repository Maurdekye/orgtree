/** §4.8 — archived seats arrive as a summary; this puts them back together.
 *
 *  MEASURED 2026-09-11 on the operator's org: the tree payload was 1,281,721
 *  bytes, and 242 archived seats accounted for 1,232,054 of it while the two
 *  live ones took 18,478 — for a screen that draws those 242 as one collapsed
 *  pile badge. The app refetches the whole thing on every lifecycle operation
 *  and every 6 s heartbeat, about 11 MB per 30 idle seconds.
 *
 *  So `org_tree` now leaves two groups off an archived node. This module is the
 *  one place that knows it:
 *
 *    hydrateTree   refills the supervisor-derived RUNTIME fields — busy, what
 *                  it is doing, whether a process is warm. Every one is a
 *                  constant for a seat with no turn and no process, and the
 *                  values come from `archived_defaults` ON THE PAYLOAD rather
 *                  than from a copy written here. The backend owns the rule;
 *                  a second copy is a second thing to disagree.
 *
 *    the readers   `charterLine`, `lineageCount`, `readOnlyAgent` — each
 *                  answers one question a CARD asks while it is being drawn,
 *                  from whichever of the full field or its summary marker is
 *                  present. See the warning on `lineageCount`.
 *
 *    nodeDetail    fetches the per-seat DETAIL — full charter, scope, lineage
 *                  — for a seat someone has actually opened.
 *
 *  ⚠ EVERY TREE GOES THROUGH `hydrateTree`, which is why it lives in `getTree`
 *  rather than at a call site: ~33 places read `node.busy` and friends without
 *  caring whether the seat is live, and they must keep working untouched.
 */
import type { TreeNode, TreePayload } from './types'

/** The shape these helpers actually need. Deliberately structural rather than
 *  `TreeNode`: the canvas passes `CanvasNode`, which also covers drafts and
 *  the eye root, and neither of those is ever a summary. */
export interface Summarisable {
  id: string
  generation?: number
  detail?: boolean
  /** the backend's token for this seat's omitted detail — see `nodeDetail` */
  detail_rev?: string | null
}

/** A node the tree carried whole needs nothing; one marked `detail:false` is a
 *  summary. The marker is the backend's, so an older engine (no marker) reads
 *  as complete — which it is. */
export const isSummary = (n: Summarisable): boolean => n.detail === false

export function hydrateTree(tree: TreePayload): TreePayload {
  const defaults = (tree as { archived_defaults?: Partial<TreeNode> })
    .archived_defaults
  if (!defaults) return tree            // older engine: nothing was omitted
  const walk = (n: TreeNode): TreeNode => {
    const children = (n.children || []).map(walk)
    // ⚠ the summary's own values win over the defaults: `frozen`, `last_status`
    // and the rest are REAL on an archived card and are not omitted.
    return isSummary(n)
      ? { ...defaults, ...n, children } as TreeNode
      : (children === n.children ? n : { ...n, children })
  }
  return { ...tree, roots: (tree.roots || []).map(walk) }
}

/* ── what a card asks while it is being drawn ────────────────────────────────
 *
 *  ⚠ A CARD CANNOT AWAIT A FETCH. `NodeSquare` renders straight off its tree
 *  entry, so a decision it makes THERE — which context-menu entries exist,
 *  which border it wears — has to be answerable from the summary alone. The
 *  first cut of §4.8 got this wrong: `documents` and `lineage` went to the
 *  detail endpoint, and a retired agent silently lost its "Open presentations"
 *  and "Show lineage" entries and its stacked-card look, because the tests for
 *  the omission all asked whether the FIELD could be recovered and none asked
 *  what was already reading it.
 *
 *  Two answers, per field. Small ones (`documents`, `session_id`: 1.2% of the
 *  archived payload between them) simply stay on the summary. Expensive ones
 *  send a marker instead, and each reader below takes whichever form it is
 *  handed.
 */

/** The charter's FIRST LINE, which is all any tooltip shows.
 *
 *  ⚠ USE THIS IN THE TRAY AND ON CARDS, never `(n.charter || '').split('\n')[0]`
 *  — an archived seat carries `charter_line` and no `charter`, so the raw
 *  expression silently yields '' and the row loses its tooltip. Anywhere the
 *  WHOLE charter is shown (the desk, the config panel) must resolve the node
 *  through `useNodeDetail` instead. */
export const charterLine = (
  n: { charter?: string | null; charter_line?: string | null },
): string => (n.charter_line ?? n.charter ?? '').split('\n')[0]

/** How many prior generations this seat has.
 *
 *  ⚠ USE THIS ON CARDS, never `(n.lineage ?? []).length` — an archived seat
 *  carries `lineage_count` and no `lineage`, so the raw expression yields 0
 *  and the card quietly loses both its "Show lineage" entry and the stacked
 *  look that says it has a past. A surface that walks the generations
 *  THEMSELVES (the lineage panel, the config modal) must sit behind
 *  `NodeDetailGate` instead — a count cannot substitute for the rows. */
export const lineageCount = (
  n: { lineage?: unknown[] | null; lineage_count?: number | null },
): number => (n.lineage ? n.lineage.length : (n.lineage_count ?? 0))

/** Whether this seat was denied the edit tool — the dashed `ro-agent` border.
 *
 *  ⚠ Same rule: an archived seat carries `read_only` and no `scope`. */
export const readOnlyAgent = (
  n: { scope?: { tools?: { edit?: boolean } } | null; read_only?: boolean | null },
): boolean => (n.scope ? n.scope.tools?.edit === false : n.read_only === true)

/* ── the detail fetch and its cache ───────────────────────────────────────── */

/** The fields a summary does not carry. Fetched when a seat is opened. */
export type NodeDetail = Partial<TreeNode>

interface Entry {
  slug: string; id: string; p: Promise<NodeDetail>; settled: boolean; bytes: number
}
const cache = new Map<string, Entry>()
// Only reconstructible, unused answers belong to the LRU. Open panels and
// requests in flight are active work, not inactive history. Serialized UTF-16
// size is a retention budget, not a measurement of the JavaScript heap.
const idle = new Map<string, Entry>()
const retained = new Map<string, number>()
const seats = new Map<string, string>()
const MAX_IDLE = 64
const MAX_IDLE_BYTES = 16 * 1024 * 1024
let idleBytes = 0
const seatKey = (slug: string, id: string) => JSON.stringify([slug, id])

function removeIdle(k: string): void {
  const e = idle.get(k)
  if (e) { idleBytes -= e.bytes; idle.delete(k) }
}

function removeEntry(k: string): void {
  removeIdle(k)
  const e = cache.get(k)
  if (!e) return
  cache.delete(k)
  const seat = seatKey(e.slug, e.id)
  if (seats.get(seat) === k) seats.delete(seat)
}

function touch(k: string, e: Entry): void {
  removeIdle(k)
  if (cache.get(k) !== e || !e.settled || retained.has(k)) return
  idle.set(k, e)
  idleBytes += e.bytes
  while (idle.size > MAX_IDLE || idleBytes > MAX_IDLE_BYTES) {
    removeEntry(idle.keys().next().value!)
  }
}

/** ⚠ A JSON ARRAY, NOT A JOINED STRING. The first version joined the parts on
 *  a literal NUL, which made Git read this TypeScript file as BINARY — no
 *  diff, no review, no blame. `JSON.stringify` escapes its own separators, so
 *  the key stays unambiguous while the source stays printable ASCII, and
 *  `tests/archivedsummary.test.tsx` fails if a NUL ever returns to `src/`.
 *
 *  THREE PARTS, EACH EARNING ITS PLACE:
 *    generation  rehiring a retired agent mints a new one, and a charter
 *                cached from the seat's previous life is the kind of stale
 *                that looks perfectly correct on screen;
 *    detail_rev  the backend's hash of the omitted fields. WITHOUT IT the key
 *                does not move when somebody edits an archived agent from
 *                ANOTHER window, or an agent retools one: the tree refreshes,
 *                the summary is identical, and the open panel goes on showing
 *                what it cached. Clearing on this tab's own writes — which is
 *                all the first version did — cannot see those at all. */
const key = (slug: string, n: Summarisable) =>
  JSON.stringify([slug, n.id, n.generation ?? null, n.detail_rev ?? null])

/** Keep an open consumer's answer reusable until its last consumer closes.
 * Invalidating or superseding an answer still wins over this retention. */
export function retainNodeDetail(slug: string, node: Summarisable): () => void {
  if (!isSummary(node)) return () => {}
  const k = key(slug, node)
  retained.set(k, (retained.get(k) ?? 0) + 1)
  removeIdle(k)
  let released = false
  return () => {
    if (released) return
    released = true
    const n = retained.get(k)! - 1
    if (n) retained.set(k, n)
    else {
      retained.delete(k)
      const e = cache.get(k)
      if (e) touch(k, e)
    }
  }
}

export function nodeDetail(
  slug: string, node: Summarisable,
  fetcher: (slug: string, id: string) => Promise<NodeDetail>,
): Promise<NodeDetail> {
  if (!isSummary(node)) return Promise.resolve(node as NodeDetail)
  const k = key(slug, node)
  const hit = cache.get(k)
  if (hit) { touch(k, hit); return hit.p }
  // a NEW revision supersedes what we held for this seat rather than joining
  // it: without this the map keeps one entry per revision per seat forever,
  // and every one of them but the newest is already known to be stale
  const seat = seatKey(slug, node.id)
  const previous = seats.get(seat)
  if (previous) removeEntry(previous)
  // a failed fetch must not be cached: the seat may have been deleted between
  // the tree that listed it and this click, and the next open of a DIFFERENT
  // seat would otherwise inherit the rejection. Only drop OUR OWN entry — a
  // newer revision may have replaced it while the fetch was in the air.
  const entry: Entry = {
    slug, id: node.id, settled: false, bytes: 0,
    p: fetcher(slug, node.id).then((detail) => {
      if (cache.get(k) === entry) {
        entry.settled = true
        entry.bytes = JSON.stringify(detail).length * 2
        touch(k, entry)
      }
      return detail
    }).catch((e: Error) => {
      if (cache.get(k) === entry) removeEntry(k)
      throw e
    }),
  }
  cache.set(k, entry)
  seats.set(seat, k)
  return entry.p
}

/** Retiring, rehiring or editing a seat invalidates what we cached for it.
 *
 *  This is the LOCAL half — it fires on this tab's own writes, which is the
 *  one case a revision token cannot improve on because it beats the refresh
 *  that would carry the new token. Remote writes are handled by `detail_rev`
 *  moving in the next tree payload; the two overlap on purpose. */
export function forgetNodeDetail(slug?: string, id?: string): void {
  if (!slug) { cache.clear(); seats.clear(); idle.clear(); idleBytes = 0; return }
  if (id) {
    const k = seats.get(seatKey(slug, id))
    if (k) removeEntry(k)
    return
  }
  for (const [k, e] of cache) {
    if (e.slug === slug) removeEntry(k)
  }
}
