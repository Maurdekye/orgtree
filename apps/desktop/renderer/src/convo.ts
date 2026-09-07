// convo.ts — ONE conversation model per node, owned outside React.
//
// Why this exists (user bug 2026-08-02: "the switchboard desk going out of sync
// with the individual agent desks"). A node's chat is rendered by up to two
// DeskChat instances — its own card and its switchboard panel — and each one
// used to keep a PRIVATE copy: its own fetch, its own live rows, its own
// draft/thinking buffers, its own busy-gated poller. Two independent models of
// one conversation diverge by construction; per-node event routing (22cc281)
// fixed which desk got an event, not the fact that each desk was accumulating
// its own answer. Whichever view happened to miss an event stayed wrong until
// it remounted.
//
// So the model moves here and the views become renderers of it. Both instances
// read the same object, so they cannot disagree — not "usually agree", cannot.
// This is the user's "store less, derive more" direction applied at the level
// where it pays: one store, one poller, one reconciliation, N views.
//
// It also costs LESS than what it replaces: one fetch per node instead of one
// per mounted view.

import { BASE, getChat } from './api'
import { decodeEventRow, record } from './events/decode'
import { segmentMailIds } from './events/wire'
import type { ChatPayload } from './types'
import type { LiveRow, PulseEvent, StreamEvent } from './canvas/shared'
import { useCallback, useSyncExternalStore } from 'react'

/** Only the newest CHAT_WINDOW rows are fetched and rendered; scrolling to the
 *  top pages another window in. The cost that bites is DOM size — every row
 *  carries markdown and tool chips — so this is deliberately small. */
export const CHAT_WINDOW = 120
export const MAX_WINDOW = 1000        // the API's own cap
const BUSY_POLL_MS = 2500      // heartbeat while the payload says busy
const IDLE_POLL_MS = 7000      // heartbeat otherwise — slower, never off
const NUDGE_MS = 200           // burst coalescing for the post-event refetch
/** How long an unsettled fetch may hold the refresh gate before a later tick
 *  is allowed past it. Comfortably above the request ceiling api.ts imposes,
 *  so in ordinary operation this never fires — it exists for the case where
 *  that ceiling is itself unavailable (no AbortSignal.timeout) or is somehow
 *  not honoured, because a frozen desk must not be reachable by ANY route. */
export const STALL_MS = 60_000

/** An optimistic ghost, plus HOW MANY copies of its text the server already
 *  showed when it was created.
 *
 *  Graduation used to be "does any of the last 20 user messages contain this
 *  text" — with no regard for WHEN. Send "continue" twice and the second ghost
 *  matched the FIRST message and vanished in 30 ms, so the preview never
 *  appeared (user report 2026-08-03, measured: 2.92 s of ghost on the first
 *  send, 0.03 s on the second). Short repeated messages are the common case,
 *  not an edge one.
 *
 *  Counting rather than timestamping is deliberate: it needs no clock
 *  comparison between browser and server, so no skew can retire a ghost early.
 *  A stale baseline can only over-count what was already there, which keeps a
 *  ghost a moment longer — erring toward showing the message, which is the
 *  direction this whole class of bug wants. */
export interface PendingGhost {
  /** client-minted identity — the render key. Ghosts retire from the MIDDLE
   *  of the list (dropOne), where an index key renames every ghost below the
   *  one that left. */
  id: number
  /** Returned by the server for a typed send; never inferred from its body. */
  mailId?: string
  text: string
  seen: number
  /** the newest transcript `seq` the payload showed when this ghost was made.
   *  It is what makes the ghost's retirement REACHABLE: see `scrolledPast`.
   *  UNKNOWN_SEQ when no payload had loaded yet — see addPending. */
  seq0: number
  /** when this ghost was made (Date.now). The floor under the idle rule —
   *  see CMD_GRACE. */
  at: number
  /** the server answered `command: true` for this send, and it was neither
   *  `immediate` nor `compacting` (desk.tsx marks it — see markGhostCommand).
   *  A command files NO durable copy, so `pending_mail` never covers it and
   *  its only graduation is the transcript row it becomes. That makes it the
   *  one ghost that can outlive its own turn. */
  cmd?: boolean
  /** the turn ended and nothing was ever written: this ghost is not waiting,
   *  it FAILED. Rendered as a visible failure the user can dismiss, never
   *  silently dropped — a message that disappears is worse than one that
   *  hangs, because the user cannot tell whether it went. */
  failed?: boolean
}

/** How long a command ghost is given before an idle server counts as proof
 *  that nothing is coming (user bug 2026-09-03).
 *
 *  ⚠ This is a FLOOR, not the rule. The rule is evidence — `busy: false` from
 *  a fetch issued after the send — and this exists only to survive the gap
 *  where the optimistic `markBusy` has been corrected by a payload the turn
 *  has not started filling yet: the CLI can take seconds to boot, and during
 *  that window the server truthfully says "no turn is running" about a
 *  command that is about to run perfectly well. Killing a ghost there would
 *  turn a working command into a phantom failure, which is the same defect
 *  wearing the other face. */
export const CMD_GRACE = 20000

/** A ghost made before the first payload loaded has no seq baseline. It used
 *  to get `-1` ("my message will be row 0") — but the composer is enabled
 *  before the first load, and on a node whose transcript is already long the
 *  first payload's window starts far past row 0, so `scrolledPast` retired the
 *  ghost on a payload that might not yet carry the mail (POST racing GET): the
 *  message was on screen NOWHERE for a poll interval. Unknown must mean
 *  "cannot scroll past me yet"; the first payload re-baselines it
 *  (see refreshConvo). */
const UNKNOWN_SEQ = Number.MAX_SAFE_INTEGER

/** ghost identity mint — see PendingGhost.id */
let GHOST_ID = 0

/** Has the fetched window moved entirely PAST where this ghost's message would
 *  sit?
 *
 *  The count baseline can otherwise become unreachable, which is the fourth
 *  costume of this bug (D-53 lead 3 → D-55 flagged it → D-57 ④ raised
 *  COPIES_WINDOW to 200 against a measured maximum burial of 138 rows). The
 *  raise did nothing, because `read_chat` only ever returns CHAT_WINDOW = 120
 *  rows: the newest-200 slice IS the whole payload, so the effective window
 *  stayed at 120 — under the measured maximum. Bury the message deeper than
 *  that and the server can never show a copy again; the ghost sits at the
 *  bottom of the desk for the rest of the session, presenting a message that
 *  was answered ten minutes ago as though it were still queued.
 *
 *  The test is evidence, not a guess: if the OLDEST row now in the window is
 *  newer than the NEWEST row that existed when the message was sent, the
 *  message cannot be in the window — it is behind it. The only other place it
 *  could be is the mailbox, and `serverCopies` counts that, so a message still
 *  waiting is still covered. (It also cannot fire early: the window has to
 *  turn over completely — 120 rows — and the CLI's echo of the message is the
 *  FIRST of those rows, so the transcript has long since taken over.) */
function scrolledPast(c: ChatPayload, g: PendingGhost): boolean {
  const oldest = c.messages[0]?.seq
  // `seq0 + 1` is the earliest row the message could occupy, so this is the
  // strict form: the window must start after the message's own place, not
  // merely after the last row that preceded it.
  return oldest != null && oldest > g.seq0 + 1
}

export interface Convo {
  chat: ChatPayload | null
  /** the server's live tail (chat.live), mirrored here so a render need not
   *  reach through a nullable payload. NOT accumulated locally — P2: the
   *  server owns it, sweeps it against the transcript, and hands back the
   *  survivors, so every view shows the same list by construction. */
  live: LiveRow[]
  /** optimistic sent-message ghosts, until the server copy lands */
  pending: PendingGhost[]
  draft: string
  thinking: string
  /** elapsed seconds while thinking is in progress; null = not thinking */
  thinkSecs: number | null
  win: number
  loadingOlder: boolean
  /** a fetch has completed at least once — the first load always sticks */
  loaded: boolean
}

const BLANK: Convo = {
  chat: null, live: [], pending: [], draft: '', thinking: '',
  thinkSecs: null, win: CHAT_WINDOW, loadingOlder: false, loaded: false,
}

interface Entry {
  /** canonical map key owning this Entry; callbacks verify it before
   * publishing after a rename or removal. */
  ownerKey: string
  /** increments when the Entry changes identity, invalidating responses that
   * were requested under its former node id. */
  ownerVersion: number
  s: Convo
  subs: Set<() => void>
  thinkT0: number          // 0 = not thinking (the single is-thinking truth)
  clock: ReturnType<typeof setInterval> | null
  /** The live scaffolding is SUPERSEDED but not yet replaced. Set when the
   *  durable event arrives, cleared by the fetch that carries the durable row
   *  — never before it, which is the whole point (see ingestStream). */
  staleDraft: boolean
  staleThink: boolean
  /** when the scaffolding was superseded. A fetch may only retire it if that
   *  fetch STARTED after this moment — one already in flight when the event
   *  fired returns a payload from before the durable row existed, and honouring
   *  it would reopen the very gap this closes. */
  staleAt: number
  /** when a delta/thinking last extended the scaffolding. A payload may only
   *  declare that scaffolding stale if the request went out AFTER it — one
   *  already in flight describes a world from before the stream started. */
  streamAt: number
  /** THE EPOCH THE CURRENT DRAFT BEGAN IN — the payload token that was on
   *  screen when the first delta of this draft arrived (`draft_epoch`).
   *
   *  This is the draft's retirement carried as STATE rather than as an event.
   *  `staleDraft` only ever becomes true because a `text` frame or a
   *  `turn_done` pulse ARRIVED, so a dropped frame left the reply on screen
   *  twice until the turn ended — for every provider, and permanently for the
   *  antigravity lane, which emitted no frame at all until 2026-09-04. The
   *  server advances this token whenever a turn's streamed text becomes
   *  durable, so an ordinary poll now carries the same news.
   *
   *  null = no baseline yet (no payload had loaded when the draft started), so
   *  the epoch cannot retire it and the frame path stands alone until the next
   *  fetch sets one — the same "unknown means cannot retire yet" rule
   *  UNKNOWN_SEQ uses for ghosts. */
  /** HOW MANY HANDOVERS THIS DESK HAS SEEN, against how many the server has
   *  made. The server counts every time a turn's streamed text becomes durable
   *  (`supervisor._text_became_durable`); this counts the `text` frames that
   *  announced them. If the server's count is ahead while a draft is on
   *  screen, this desk MISSED a handover — the draft is superseded, frame or
   *  no frame, and retires on the next ordinary poll.
   *
   *  Counting the same events on both sides is what makes this immune to poll
   *  timing, and two simpler rules were tried and are wrong:
   *    · capturing the epoch when the draft STARTS reads a payload that may be
   *      a poll old, so a message that went durable just before would look like
   *      news about this draft and blank a reply still being typed;
   *    · re-syncing on the first payload after the draft starts adopts the very
   *      handover it needed to notice, and never retires anything.
   *  A GAP is worse than the double (D-50), and only the count avoids both. */
  textSeen: number
  /** the server process the count belongs to. It counts in memory, so a
   *  restart puts it back to 0 — comparing across that would compare two
   *  different sequences. A changed boot half re-syncs instead of deciding. */
  epochBoot: string | null
  /** debounce for the post-event refetch */
  nudge: ReturnType<typeof setTimeout> | null
  poll: ReturnType<typeof setTimeout> | null
  inflight: boolean
  /** monotonically identifies the request currently allowed to mutate this
   *  Entry; rename/drop invalidate the prior request before its promise lands. */
  requestSerial: number
  /** when the in-flight fetch STARTED. `inflight` alone cannot be trusted as
   *  a gate: it is cleared by the fetch settling, so a request that never
   *  settles latches it forever (see refreshConvo). */
  inflightAt: number
  /** when the last fetch COMPLETED — a live row may only expire after a fetch
   *  has had the chance to cover it (otherwise the timer races the fetch and
   *  the row vanishes into a gap) */
  fetchedAt: number
  /** `startedAt` of the request whose payload is currently installed. A forced
   *  fetch can overlap the heartbeat's, and whichever RESPONSE landed last used
   *  to win — a slow stale payload regressing `busy`/`live`/the transcript until
   *  the next tick. Now the payload from the latest-STARTED request wins, and a
   *  late straggler from an earlier one is discarded. */
  installed: number
  /** an event wanted a refetch while nobody was subscribed. The fetch is
   *  deferred to the next subscribe instead of run blind — a busy 20-agent org
   *  otherwise pays one full `read_chat` per node per event burst with nobody
   *  looking (the poll was mount-gated; the event path wasn't). */
  dirty: boolean
}

const M = new Map<string, Entry>()
// '/' cannot appear in a slug or node id (both are slugify()'d to [a-z0-9-]),
// so the key is unambiguous — and greppable in a debug dump, which a
// lookalike separator would not be.
const key = (slug: string, nid: string) => `${slug}/${nid}`

/** Preserve the in-memory conversation while a node's full identity is
 * renamed. Views may remount because their React key follows the node id;
 * moving the existing entry keeps fetched detail, pending rows and the
 * thinking state attached to the renamed agent. */
export function renameConvo(slug: string, from: string, to: string): void {
  if (!from || !to || from === to) return
  const oldKey = key(slug, from), newKey = key(slug, to)
  const old = M.get(oldKey)
  if (!old) return
  // Existing callbacks capture this Entry, so moving it is safe without a
  // name-based alias. Cancel callbacks that only captured the old key; a new
  // subscription will arm the same Entry under its canonical key.
  if (old.poll) { clearTimeout(old.poll); old.poll = null }
  if (old.nudge) { clearTimeout(old.nudge); old.nudge = null }
  stopClock(old)
  old.inflight = false
  old.requestSerial++
  const replaced = M.get(newKey)
  if (replaced && replaced !== old) {
    // A live/loaded destination is a distinct identity (for example, a new
    // A hired after A→B). Preserve it and invalidate the old callbacks rather
    // than allowing a later B→A event to overwrite that new conversation.
    // Pulse-created placeholders have no subscribers and are still safe to
    // replace below.
    if (replaced.subs.size || replaced.s.loaded || replaced.inflight) {
      M.delete(oldKey)
      return
    }
    if (replaced.poll) { clearTimeout(replaced.poll); replaced.poll = null }
    if (replaced.nudge) { clearTimeout(replaced.nudge); replaced.nudge = null }
    stopClock(replaced)
  }
  old.ownerKey = newKey
  old.ownerVersion++
  M.set(newKey, old)
  M.delete(oldKey)
}

/** Forget a genuinely removed node and stop callbacks owned by its Entry. */
export function dropConvo(slug: string, nid: string): void {
  const target = key(slug, nid)
  const old = M.get(target)
  if (!old) return
  if (old.poll) { clearTimeout(old.poll); old.poll = null }
  if (old.nudge) { clearTimeout(old.nudge); old.nudge = null }
  stopClock(old)
  old.inflight = false
  old.requestSerial++
  M.delete(target)
}

function entry(k: string): Entry {
  let e = M.get(k)
  if (!e) {
    e = { ownerKey: k, ownerVersion: 0, s: BLANK, subs: new Set(), thinkT0: 0, clock: null, nudge: null,
          textSeen: 0, epochBoot: null,
          staleDraft: false, staleThink: false, staleAt: 0, streamAt: 0,
          poll: null, inflight: false, requestSerial: 0, inflightAt: 0, fetchedAt: 0,
          installed: 0, dirty: false }
    M.set(k, e)
  }
  return e
}

/** Patch and notify. The snapshot identity changes ONLY on a real change, which
 *  is what useSyncExternalStore requires to avoid an infinite render loop. */
function patchEntry(e: Entry, p: Partial<Convo>, ownerVersion = e.ownerVersion): void {
  if (M.get(e.ownerKey) !== e || ownerVersion !== e.ownerVersion) return
  let changed = false
  for (const [f, v] of Object.entries(p)) {
    if (e.s[f as keyof Convo] !== v) { changed = true; break }
  }
  if (!changed) return
  e.s = { ...e.s, ...p }
  e.subs.forEach((cb) => cb())
}

function patch(k: string, p: Partial<Convo>): void {
  patchEntry(entry(k), p)
}

// ------------------------------------------------------------------ the hook
export function useConvo(slug: string, nid: string): Convo {
  const k = key(slug, nid)
  const sub = useCallback((cb: () => void) => {
    const e = entry(k)
    e.subs.add(cb)
    beat(k, slug, nid)          // someone is watching -> keep it fresh
    // an event marked this node stale while nobody was looking — settle the
    // deferred refetch now, immediately, not on the next heartbeat tick
    if (e.dirty) { e.dirty = false; void refreshConvo(slug, nid, { force: true }) }
    // the thinking clock parks while unwatched (see startClock) — resume it
    if (e.thinkT0) startClock(k, e)
    return () => {
      e.subs.delete(cb)
      if (!e.subs.size) {
        if (e.poll) { clearTimeout(e.poll); e.poll = null }
        // nobody is rendering thinkSecs — stop patching it at 1 Hz. thinkT0
        // stays set, so a resubscribe resumes with the true elapsed time.
        stopClock(e)
      }
    }
  }, [k, slug, nid])
  const snap = useCallback(() => entry(k).s, [k])
  return useSyncExternalStore(sub, snap, snap)
}

/** The newest N transcript rows `serverCopies` counts within.
 *
 *  It is a NEWEST-n slice rather than the whole payload on purpose: paging
 *  older messages in (`loadOlder`) prepends rows, and a window measured from
 *  the end is immune to that, while counting the whole payload would let an
 *  ancient identical message drift into view and graduate a live ghost early —
 *  a GAP, the failure direction this system refuses.
 *
 *  ⚠ It was 20, which is smaller than a real turn. Measured over 94 real
 *  transcripts (2026-08-04): consecutive user messages are typically 5
 *  rendered rows apart, but the p90 is 14 and the maximum 138 — a tool-heavy
 *  turn buries the user's own message deeper than 20 rows in one go. Once the
 *  copy is out of the window the count can never rise again, so the ghost is
 *  stranded FOREVER and the message renders twice for the rest of the session.
 *  200 covers the measured maximum with room to spare. */
const COPIES_WINDOW = 200
/** How much of a ghost's text has to be found. Bounded because the server
 *  TRUNCATES pending bodies (`node_chat` shrinks them in tiers as the queue
 *  grows: 2000 / 800 / 250 chars) — a full-length needle can never occur in a
 *  truncated haystack, so
 *  a long message's ghost never graduated against `pending_mail` and sat on
 *  screen beside its own pending bubble until the transcript caught up, or for
 *  ever if the agent was frozen/archived/queued (measured 2026-08-04 on a
 *  ~10 kB message). Must stay well under the server's smallest body cap. */
const COPIES_NEEDLE = 200

/** how many copies of `text` the server is currently showing — the mailbox and
 *  the transcript both count, since a message passes through them in order */
function serverCopies(c: ChatPayload | null, text: string): number {
  if (!c) return 0
  const needle = text.slice(0, COPIES_NEEDLE)
  return c.messages.slice(-COPIES_WINDOW)
    .filter((m) => m.role === 'user' && m.segments === undefined && (m.text || '').includes(needle)).length
    + (c.pending_mail ?? []).filter((m) => decodeEventRow(m, BASE ? 'public' : 'operator').kind === 'legacy' && (m.body || '').includes(needle)).length
}

/** A single current payload can carry a mail in the queue, transcript or live log. */
function serverMailIds(c: ChatPayload | null): Set<string> {
  const ids = new Set<string>()
  if (!c) return ids
  const profile = BASE ? 'public' : 'operator'
  for (const row of [...c.messages, ...(c.live ?? [])]) {
    for (const id of segmentMailIds(row.segments, profile)) ids.add(id)
  }
  for (const row of c.pending_mail ?? []) {
    if (row.id && decodeEventRow(row, profile).kind === 'known') ids.add(row.id)
  }
  return ids
}

// -------------------------------------------------------------------- fetch
/** Refresh a node's transcript. Concurrent calls collapse into the in-flight
 *  one — several views, several triggers, ONE request. */
export function refreshConvo(slug: string, nid: string,
                              opts: { force?: boolean } = {}): Promise<void> {
  const k = key(slug, nid)
  const e = entry(k)
  const ownerVersion = e.ownerVersion
  // ⚠ `inflight` is a LATCH, and a latch needs a way out that does not depend
  // on the thing it is waiting for. It is cleared only by the fetch settling,
  // so a request that never settles — the backend accepting the connection and
  // then going quiet — used to hold it true for the life of the tab: every
  // later beat() tick called this, took the early return, and the desk stopped
  // updating entirely while a just-sent message sat unconfirmed at the bottom,
  // unable to graduate (no payload) or retire (no error). Recovering needed a
  // page reload (user report 2026-08-10). api.ts now bounds the request, which
  // is the real fix; this is the belt to that pair of braces, because "the
  // request always settles" is exactly the assumption that just failed.
  const now = Date.now()
  if (e.inflight && !opts.force && now - e.inflightAt < STALL_MS) {
    return Promise.resolve()
  }
  e.inflight = true
  const requestSerial = ++e.requestSerial
  e.inflightAt = now
  const startedAt = now
  const ownsRequest = (): boolean =>
    M.get(e.ownerKey) === e && e.ownerVersion === ownerVersion
      && e.requestSerial === requestSerial
  return getChat(slug, nid, e.s.win).then((c) => {
    if (!ownsRequest()) return
    e.inflight = false
    e.fetchedAt = Date.now()
    // latest-STARTED request wins, not latest-landed — see Entry.installed
    if (startedAt < e.installed) return
    e.installed = startedAt
    // A pending ghost graduates once the SERVER'S OWN copy is visible — by
    // CONTAINMENT, not equality, since the turn text is a mail envelope by
    // then. Two things count as visible, and both must, because the message
    // passes through them in order: first it sits in the node's mailbox
    // (`pending_mail`, which the desk renders as a durable pending bubble),
    // then a turn drains it into the transcript. Checking only the transcript
    // left a hole for the whole of CLI startup — the mail was on the server,
    // the ghost had been dropped, and nothing was on screen (user bug
    // 2026-08-03: "the queued preview never shows up while the agent is
    // starting"). Same rule as everywhere else: retire on evidence.
    // a ghost graduates when the server shows MORE copies of its text than it
    // did when the ghost was made — never merely "a copy exists", which an
    // earlier identical message already satisfies
    // AND A COMMAND GHOST RESOLVES ON THE TURN'S END (user bug 2026-09-03:
    // "i sent an invalid command and it got stuck as a permanently
    // undelivered message that i cant cancel").
    //
    // Both graduation routes above are things the SERVER shows. A command
    // shows up in neither unless it ran: it files no `pending_mail` (the
    // command path persists no copy) and it writes no transcript row unless
    // the CLI actually knew the word. orgtree recognises four of its own —
    // /compact and IMMEDIATE_CMDS {context, cost, todos} — and forwards
    // everything else verbatim on the chance that the CLI or the user's own
    // project skills know it. When nothing does, the ghost had no exit at
    // all, and desk.tsx was keeping it deliberately, reasoning "a row IS
    // coming". For a mistyped command no row is ever coming.
    //
    // The third route is the turn ENDING. `busy: false` on a fetch issued
    // after the send is the server saying no turn is running — so whatever
    // that command was going to write, it has already not written. Note this
    // marks rather than drops: a ghost that vanishes is worse than one that
    // hangs, because the user cannot tell whether it went.
    //
    // Deliberately NOT a validator against a list of known commands: the
    // vocabulary belongs to the CLI and to the user's own skills, both of
    // which change without us, so a list here would rot into a guard that
    // silently stops catching things.
    // this payload says no turn is running. Ordering against the send is
    // carried by CMD_GRACE, which is longer than any round trip — so this
    // needs no `startedAt` comparison of its own.
    const idleNow = !c.busy
    const cmdDead = (g: PendingGhost): boolean =>
      !!g.cmd && !g.failed && idleNow && Date.now() - g.at >= CMD_GRACE
    const mailIds = serverMailIds(c)
    const pending = e.s.pending
      .map((g) => (cmdDead(g) ? { ...g, failed: true } : g))
      // a FAILED ghost is no longer waiting for evidence — it survives every
      // filter below and leaves only when the user dismisses it
      .filter((g) => g.failed
        || (g.mailId ? !mailIds.has(g.mailId)
          : serverCopies(c, g.text) <= g.seen && !scrolledPast(c, g)))
      // a ghost made before the first payload has no seq baseline (see
      // addPending). This survivor's message is NOT in this payload — its
      // eventual row must come after everything the payload shows — so the
      // payload's newest seq is a sound baseline, and scrolledPast becomes
      // reachable for it from here on.
      .map((g) => g.seq0 === UNKNOWN_SEQ
        ? { ...g, seq0: c.messages.length ? (c.messages[c.messages.length - 1]?.seq ?? -1) : -1 }
        : g)
    // superseded scaffolding retires HERE, with its replacement in hand — one
    // atomic patch, so the draft never blinks out ahead of the durable row
    const retire: Partial<Convo> = {}
    const fresh = startedAt >= e.staleAt      // this fetch can SEE the new row
    // THE PAYLOAD IS EVIDENCE TOO. Until now the scaffolding retired only on a
    // websocket event, so losing the one frame that ends a turn left the grey
    // streamed text and the thinking clock on screen FOREVER — beside the
    // durable row that replaced them (the reply rendered twice) and across
    // every later turn (`thinking… for 3100s`). That is a violation of the one
    // rule this app is built on: nothing on screen may depend on having caught
    // an event. `busy:false` is the server saying no turn is running, so
    // nothing can be streaming, and the payload carrying that statement also
    // carries the durable rows — the same atomic handover D-50 requires.
    //
    // ⚠ Only if this request went out AFTER the newest token, though. One
    // issued before the stream began describes a world in which nothing was
    // being typed, and honouring it would blank a draft that is still growing
    // — the same mistake this rule exists to fix, in a new place.
    //
    // Residual, stated rather than hidden: a `text` frame lost MID-turn still
    // leaves that draft up until the turn ends, because no server fact
    // distinguishes "this draft was superseded" from "this draft is still
    // being typed" without going back to the string matching P2 deleted.
    const idle = !c.busy && startedAt >= e.streamAt
    // THE EPOCH: the server says a turn's streamed text became durable since
    // this draft began, so the draft is superseded — whether or not the frame
    // that would have said so ever arrived. This is what makes the retirement
    // survive a dropped websocket frame, which the `staleDraft` path cannot.
    //
    // DIFFERS, not "is greater". The token is opaque and the client does no
    // ordering on it, so it cannot reach a wrong conclusion from a value that
    // moved unexpectedly — and a backend restart (which resets the count but
    // changes the boot half) retires the draft rather than stranding it. That
    // is also the safe direction: retiring shows the durable transcript row,
    // while sticking shows the reply twice.
    // "<boot>:<n>" — see supervisor.draft_epoch
    const cut = (c.draft_epoch ?? '').lastIndexOf(':')
    const boot = cut < 0 ? null : c.draft_epoch!.slice(0, cut)
    const made = cut < 0 ? null : Number(c.draft_epoch!.slice(cut + 1))
    const sameBoot = boot !== null && boot === e.epochBoot
    const missed = sameBoot && made !== null && Number.isFinite(made)
      && made > e.textSeen && !!e.s.draft
    if ((fresh && e.staleDraft) || idle || missed) {
      retire.draft = ''
      e.staleDraft = false
    }
    // Re-sync when there is nothing on screen to protect, or when the count
    // belongs to a different server process than the one we were counting
    // against. Deliberately AFTER the decision above.
    if (boot !== null && made !== null && Number.isFinite(made)
        && (!sameBoot || retire.draft !== undefined || !e.s.draft)) {
      // Residual, stated rather than hidden: a message that goes durable in
      // the gap between the last poll and a draft starting is not accounted
      // for here, so a dropped frame in that same window leaves the epoch
      // looking moved once. It retires the new draft a beat early; the next
      // delta redraws it. That is a flicker, not a gap, and it needs BOTH a
      // dropped frame and that exact window.
      e.epochBoot = boot
      e.textSeen = made
    }
    if ((fresh && e.staleThink) || idle) {
      retire.thinking = ''
      retire.thinkSecs = null
      e.staleThink = false
    }
    if (idle && e.thinkT0) { e.thinkT0 = 0; stopClock(e) }
    // normalize, don't cast: LiveRowPayload.text is optional on the wire,
    // LiveRow.text is not — a cast would silently re-open the type hole the
    // typing wave closed
    const live: LiveRow[] = (c.live ?? []).map((r) => ({ ...r, text: r.text ?? '' }))
    patchEntry(e, { chat: c, loaded: true, loadingOlder: false, pending, live, ...retire }, ownerVersion)
  }).catch(() => {
    if (!ownsRequest()) return
    e.inflight = false
    patchEntry(e, { loadingOlder: false }, ownerVersion)
  })
}

// (the live/durable reconciliation that used to live here is gone — it moved
// into supervisor._sweep_live, which can see BOTH the live rows and the
// transcript. This file no longer decides what to retire; it renders what the
// server retired.)

export function loadOlder(slug: string, nid: string): boolean {
  const k = key(slug, nid)
  const e = entry(k)
  if (e.s.loadingOlder || e.s.win >= MAX_WINDOW) return false
  patch(k, { loadingOlder: true, win: Math.min(MAX_WINDOW, e.s.win + CHAT_WINDOW) })
  void refreshConvo(slug, nid, { force: true })
  return true
}

export function addPending(slug: string, nid: string, text: string): number {
  const k = key(slug, nid)
  const e = entry(k)
  // Baseline: everything already ACCOUNTED FOR is not this send. That is the
  // payload's copies PLUS the ghosts already standing in for earlier sends of
  // the same text — send "continue" twice before a refresh lands and both
  // ghosts used to carry `seen: 0`, so the server showing ONE copy retired
  // BOTH and the second message went off screen. (D-52 fixed the same-text
  // case across turns; this is the same-instant case its baseline missed.)
  const msgs = e.s.chat?.messages ?? []
  const ghostId = ++GHOST_ID
  patch(k, {
    pending: [...e.s.pending, {
      id: ghostId,
      text,
      seen: serverCopies(e.s.chat, text)
        + e.s.pending.filter((g) => g.text === text).length,
      // −1 on a LOADED-and-empty transcript: the message will be row 0, so
      // the window has moved past it once row 0 is no longer in it. Before
      // the first load the length is unknowable — see UNKNOWN_SEQ.
      seq0: !e.s.loaded ? UNKNOWN_SEQ
        : msgs.length ? (msgs[msgs.length - 1]?.seq ?? -1) : -1,
      at: Date.now(),
    }],
  })
  return ghostId
}

/** Bind only a validated typed response. Old servers retain the legacy path. */
export function bindPendingMail(slug: string, nid: string, ghostId: number, response: unknown): void {
  if (!record(response) || typeof response.id !== 'string'
      || decodeEventRow(response, BASE ? 'public' : 'operator').kind !== 'known') return
  const k = key(slug, nid), e = entry(k), mailId = response.id
  const visible = serverMailIds(e.s.chat).has(mailId)
  patch(k, { pending: e.s.pending.flatMap(g => g.id !== ghostId ? [g]
    : visible ? [] : [{ ...g, mailId }]) })
}

/** Mark the ghost for THIS send as a command (desk.tsx, on the response).
 *
 *  It cannot be known at `addPending` time — the ghost is painted before the
 *  POST answers, which is the entire point of it — so the shape arrives one
 *  round trip later and lands on the oldest ghost with this text, exactly as
 *  `dropPending` retires the oldest. */
export function markGhostCommand(slug: string, nid: string, text: string): void {
  const k = key(slug, nid)
  const list = entry(k).s.pending
  const i = list.findIndex((g) => g.text === text && !g.cmd)
  if (i < 0) return
  patch(k, { pending: list.map((g, j) => (j === i ? { ...g, cmd: true } : g)) })
}

/** Dismiss ONE ghost the user has given up on (the ✕ on a pending bubble).
 *
 *  This is screen-only and says so in the UI: a ghost has no durable copy to
 *  retract — `retractMail` is for rows the server owns. What it ends is the
 *  bubble, which for a failed command is the only thing left of it. */
export function dismissPending(slug: string, nid: string, id: number): void {
  const k = key(slug, nid)
  patch(k, { pending: dropOne(entry(k).s.pending, (g) => g.id === id) })
}

/** Retire ONE ghost — the oldest with this text.
 *
 *  It used to filter by text, which retires every send of the same words: a
 *  failed second "yes" took the first one's preview down with it. One call,
 *  one send, one ghost. */
export function dropPending(slug: string, nid: string, text: string): void {
  const k = key(slug, nid)
  patch(k, { pending: dropOne(entry(k).s.pending, (g) => g.text === text) })
}

/** the same list minus the first match — or the same array if nothing matched,
 *  so `patch` can tell that nothing changed */
function dropOne(list: PendingGhost[], hit: (g: PendingGhost) => boolean): PendingGhost[] {
  const i = list.findIndex(hit)
  return i < 0 ? list : [...list.slice(0, i), ...list.slice(i + 1)]
}

/** the composer's optimistic "it is working now", corrected by the next fetch */
export function markBusy(slug: string, nid: string): void {
  const k = key(slug, nid)
  const c = entry(k).s.chat
  if (c && !c.busy) {
    // Optimistic send starts a NEW turn. Do not carry the previous turn's
    // activity latch across the interval before the server's first refresh.
    patch(k, { chat: { ...c, busy: true, turn_activity: false } })
  }
}

// ------------------------------------------------------------------ ingest
/** Called ONCE per websocket frame, at the app level — not per mounted view.
 *
 *  Since P2 this does NOT assemble a conversation. Anything a view must still
 *  see after the moment passes is a server-owned live row, so an event of that
 *  kind just schedules a (debounced) refetch. What stays here is the
 *  sub-second scaffolding that would be stale before any fetch returned: the
 *  token-by-token draft, and the thinking clock. */
export function ingestStream(slug: string, ev: StreamEvent): void {
  const k = key(slug, ev.node)
  const e = entry(k)
  if (ev.kind === 'thinking_start') {
    // the block OPENED — the only marker that survives sealing, and the only
    // one that is early (a sealed think's deltas can all arrive at the end,
    // which would start the clock as it stops)
    e.thinkT0 = Date.now()
    e.streamAt = e.thinkT0
    startClock(k, e)
    e.staleThink = false
    patch(k, { thinking: '', thinkSecs: 0 })
    return
  }
  if (ev.kind === 'thinking') {
    e.streamAt = Date.now()
    if (!e.thinkT0) { e.thinkT0 = Date.now(); startClock(k, e); patch(k, { thinkSecs: 0 }) }
    // a fresh thought must not continue a superseded one
    const base = e.staleThink ? '' : e.s.thinking
    e.staleThink = false
    patch(k, { thinking: (base + ev.text).slice(-2000) })
    return
  }
  if (ev.kind === 'delta') {
    e.streamAt = Date.now()
    const base = e.staleDraft ? '' : entry(k).s.draft
    // a draft that is STARTING (nothing on screen, or what was there has been
    // superseded) records the epoch it began in — everything the server marks
    // durable from here on supersedes it. A draft that is merely GROWING keeps
    // its original baseline, or each new token would move the goalposts and
    // the draft could never be retired by state at all.
    e.staleDraft = false
    patch(k, { draft: (base + ev.text).slice(-12000) })
    return
  }
  // A durable row landed (text / tool / sticky output): the thinking phase is
  // over and the draft has been superseded by the real message.
  //
  // SUPERSEDED IS NOT REPLACED. These used to be blanked right here, but the
  // row that replaces them only arrives with the refetch `nudge()` schedules
  // below — 200 ms of debounce plus a round-trip later. In between, the grey
  // live text vanished and nothing stood in its place: the message, tool call
  // or response simply went missing for a moment and then came back (user bug
  // 2026-08-03). So mark them stale and let the FETCH clear them, in the same
  // patch that installs the payload carrying their replacement — atomic, so
  // there is neither a gap nor a frame where both are on screen.
  //
  // The clock stops immediately, because that is a fact about the world rather
  // than something being rendered: it is no longer thinking.
  e.thinkT0 = 0
  stopClock(e)
  e.staleThink = true
  e.staleAt = Date.now()
  if (ev.kind === 'text') { e.staleDraft = true; e.textSeen += 1 }
  if (ev.kind === 'steered') {
    // one steered delivery retires one ghost — see dropPending. Matched on a
    // bounded needle for the same reason as serverCopies: the server caps the
    // event text (api `m[:2000]`), so a full-length needle from a longer steer
    // can never occur in it.
    if (ev.segments !== undefined) {
      const ids = segmentMailIds(ev.segments, BASE ? 'public' : 'operator')
      patch(k, { pending: e.s.pending.filter(g => !g.mailId || !ids.has(g.mailId)) })
    } else {
      patch(k, { pending: dropOne(e.s.pending,
        (g) => !g.mailId && ev.text.includes(g.text.slice(0, COPIES_NEEDLE))) })
    }
  }
  nudge(slug, ev.node)
}

/** Coalesce a burst of events into ONE refetch. A turn emits several rows in
 *  quick succession and every one of them wants the same payload. */
function nudge(slug: string, nid: string): void {
  const e = entry(key(slug, nid))
  // The poll is mount-gated; the event path must be too, or a busy org pays
  // one read_chat per node per event burst with nobody looking. Deferred, not
  // dropped: the next subscribe settles it immediately (see useConvo).
  if (!e.subs.size) { e.dirty = true; return }
  if (e.nudge) return
  e.nudge = setTimeout(() => {
    e.nudge = null
    void refreshConvo(slug, nid, { force: true })
  }, NUDGE_MS)
}

export function ingestPulse(slug: string, ev: PulseEvent): void {
  const k = key(slug, ev.node)
  const e = entry(k)
  if (ev.event === 'turn_done') {
    // the live tail is cleared server-side (sticky rows survive there); here
    // only the sub-second scaffolding needs resetting — and by the same rule as
    // ingestStream, it retires on the FETCH below rather than right now, or the
    // final message blinks out between the turn ending and the payload landing
    e.thinkT0 = 0
    stopClock(e)
    e.staleDraft = true
    e.staleThink = true
    e.staleAt = Date.now()
  }
  // same mount gate as nudge(): defer, don't fetch blind
  if (!e.subs.size) { e.dirty = true; return }
  void refreshConvo(slug, ev.node, { force: true })
}

// ------------------------------------------------------------------- timers
function startClock(k: string, e: Entry): void {
  if (e.clock) return
  // no subscribers, no ticking — an unwatched node whose end-of-turn frame is
  // lost would otherwise patch thinkSecs at 1 Hz forever. thinkT0 keeps the
  // truth; the next subscribe resumes the clock (see useConvo).
  if (!e.subs.size) return
  e.clock = setInterval(() => {
    if (!e.thinkT0) return stopClock(e)
    patch(k, { thinkSecs: Math.round((Date.now() - e.thinkT0) / 1000) })
  }, 1000)
}

function stopClock(e: Entry): void {
  if (e.clock) { clearInterval(e.clock); e.clock = null }
}

/** THE HEARTBEAT. If anything is watching this node, refetch it — full stop.
 *
 *  This used to be `pollWhileBusy(..., !!chat?.busy)`, and that was a
 *  bootstrap trap: the refresh loop was gated on a field that ARRIVES IN THE
 *  PAYLOAD THE LOOP FETCHES. Open a desk whose last payload said `busy:false`
 *  while the node was in fact working — a turn that began during a websocket
 *  gap, an event that never arrived, a view mounted at the wrong moment — and
 *  the poll never starts, so nothing can ever correct the belief that made it
 *  not start. The view then sits frozen until it is unmounted (zoom out) or
 *  the page is reloaded, which is exactly what the user reported, twice.
 *
 *  Liveness must never depend on state that could itself be stale. "Is anyone
 *  looking at this node" is known LOCALLY and cannot be wrong, so that is the
 *  gate. Cadence still adapts — fast while the payload says busy, slow
 *  otherwise — but the difference is only how often, never whether. */
function beat(k: string, slug: string, nid: string): void {
  const e = entry(k)
  if (e.poll || !e.subs.size) return
  const tick = () => {
    const cur = entry(k)
    if (!cur.subs.size) { cur.poll = null; return }
    void refreshConvo(slug, nid)
    cur.poll = setTimeout(tick, cur.s.chat?.busy ? BUSY_POLL_MS : IDLE_POLL_MS)
  }
  e.poll = setTimeout(tick, BUSY_POLL_MS)
}

/** Drop the CONTENT for every node — used when the viewer switches orgs, so a
 *  stale conversation can never be shown under a different tree.
 *
 *  ⚠ It resets entries IN PLACE and deliberately does not `M.clear()`. A
 *  mounted view has already handed its re-render callback to a specific Entry
 *  object; discarding the map would leave that callback attached to an
 *  orphan, and every later patch would notify a set nobody is listening to —
 *  a permanently deaf view that looks exactly like the staleness this whole
 *  file exists to prevent. Identity of the Entry is load-bearing. */
export function resetConvos(): void {
  M.forEach((e) => {
    stopClock(e)
    // ⚠ Only unwatched entries lose their poll. React runs child effects
    // before parent effects, so on an org switch the new desks have ALREADY
    // subscribed (and beat() armed their polls) by the time App's reset effect
    // runs — clearing those polls left every surviving view heartbeat-less,
    // which is verbatim the frozen-desk failure beat() exists to abolish.
    // Entries with subscribers ARE the new org's; their poll stands.
    if (e.poll && !e.subs.size) { clearTimeout(e.poll); e.poll = null }
    if (e.nudge) { clearTimeout(e.nudge); e.nudge = null }
    e.thinkT0 = 0
    e.staleDraft = false
    e.staleThink = false
    e.textSeen = 0
    e.epochBoot = null
    e.staleAt = 0
    e.streamAt = 0
    e.inflight = false
    e.inflightAt = 0
    e.fetchedAt = 0
    e.installed = 0
    e.dirty = false
    e.s = BLANK
    e.subs.forEach((cb) => cb())
  })
}
