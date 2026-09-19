/** Revisioned base+patch convergence for the org tree (2026-09-19).
 *
 *  THE PROBLEM THIS RETIRES. Narrow ws frames (cache forecast, MCP counts,
 *  MCP readiness) patch the rendered tree in place, and every such frame
 *  invalidated the conditional tree cache so a fetch racing it was DISCARDED
 *  as superseded (api.ts getTree resolved null after bounded retries). Under
 *  continuous patch traffic from a working swarm, every bounded attempt
 *  raced some invalidation, refreshes starved indefinitely, and lifecycle
 *  state (halted chips, live badges) sat visibly stale for over a minute
 *  while the backend was already correct — measured on beta.1, wave 2
 *  (backend active 21:01:50Z, UI stale until 21:02:43Z), and identified
 *  independently by the swarm-astra investigation.
 *
 *  THE CONTRACT. The server stamps every state-bearing frame with a per-org
 *  monotonically increasing `rev`, and every full tree payload with
 *  `sync_rev` — the rev current when its snapshot was acquired (stamped
 *  before acquisition, so a payload may carry NEWER content than its stamp,
 *  never older). Convergence is then arithmetic:
 *    - a patch frame with rev >  base.sync_rev applies ON TOP of the base;
 *    - a patch frame with rev <= base.sync_rev is already inside it;
 *    - a skipped frame rev means frames were missed — one full fetch
 *      catches up.
 *  Fetched bodies are ALWAYS applied (never discarded): any patches newer
 *  than the body replay on top of it, in rev order. Replaying a frame whose
 *  values the body already contains overwrites equal values — idempotent by
 *  construction, which is what makes the stamp-before-acquire order safe.
 *
 *  This module holds the pure bookkeeping (what to buffer, what to replay,
 *  when a gap happened) so the reorder/gap behavior is unit-testable without
 *  mounting the app. Applying a frame to a tree stays in App.tsx beside the
 *  existing patchers.
 */

/** The minimal frame shape this module reads. */
export interface SyncFrame { type: string; kind?: string; rev?: number }

const PATCH_KINDS = new Set(['cache_forecast', 'mcp_tool_count', 'mcp_readiness'])
/** Frames whose values patch the rendered tree in place. */
export const isPatchFrame = (f: SyncFrame): boolean =>
  f.type === 'node_stream' && typeof f.kind === 'string' && PATCH_KINDS.has(f.kind)

/** Bound on buffered patch frames. 128 covers minutes of the busiest
 *  observed patch traffic; overflow drops OLDEST first, and anything
 *  dropped is recovered by the next full fetch (whose payload includes
 *  every value the dropped frames carried). */
const BUFFER_CAP = 128

export interface SyncState {
  /** rev of the last rev-carrying frame seen on this connection */
  lastFrameRev: number | null
  /** sync_rev of the last applied full payload */
  baseRev: number
  /** patch frames newer than baseRev, arrival order */
  buffer: SyncFrame[]
}

export const newSync = (): SyncState =>
  ({ lastFrameRev: null, baseRev: 0, buffer: [] })

/** A new connection (or org switch) starts from nothing: the connect path
 *  does a full fetch, which establishes the base. */
export const resetSync = (s: SyncState): void => {
  s.lastFrameRev = null
  s.baseRev = 0
  s.buffer = []
}

/** Record an incoming frame. Returns whether a rev GAP was detected —
 *  the caller answers a gap with one full fetch. Frames without a rev
 *  (animation sparks; an older server) take no part in ordering and are
 *  never buffered: with no revisions the behavior degrades exactly to
 *  apply-every-fetched-body, which is strictly better than discarding. */
export function onFrame(s: SyncState, f: SyncFrame): { gap: boolean } {
  const rev = typeof f.rev === 'number' && Number.isFinite(f.rev) ? f.rev : null
  if (rev === null) return { gap: false }
  const gap = s.lastFrameRev !== null && rev !== s.lastFrameRev + 1
  if (s.lastFrameRev === null || rev > s.lastFrameRev) s.lastFrameRev = rev
  if (isPatchFrame(f)) {
    s.buffer.push(f)
    if (s.buffer.length > BUFFER_CAP) s.buffer.splice(0, s.buffer.length - BUFFER_CAP)
  }
  return { gap }
}

/** A full payload arrived (fetch or 304-revalidated cache). Returns the
 *  buffered patch frames the caller must replay on top of it, in rev
 *  order, and prunes everything the payload already covers. A payload
 *  without a sync_rev (older server) replays nothing — see onFrame. */
export function onBase(s: SyncState, syncRev: number | undefined): SyncFrame[] {
  const base = typeof syncRev === 'number' && Number.isFinite(syncRev)
    ? syncRev : (s.lastFrameRev ?? 0)
  s.baseRev = base
  s.buffer = s.buffer.filter((f) => (f.rev ?? 0) > base)
  return [...s.buffer].sort((a, b) => (a.rev ?? 0) - (b.rev ?? 0))
}
