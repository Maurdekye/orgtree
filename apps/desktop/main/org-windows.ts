/** THE NATIVE WINDOW REGISTRY — who every main window is, and which one a
 *  native command, an event or an organization request actually means.
 *
 *  ⚠ WHY THIS EXISTS AT ALL. v2 kept ONE main BrowserWindow in a module-scoped
 *  `main` variable, and that single window was the unstated subject of every
 *  native sentence: `assertNativeSender(event, main, origin)` gated every IPC
 *  call against it, `broadcast()` sent every event to it, the window commands
 *  minimized and closed it, and the popout registry was app-wide because there
 *  was only one window to own popouts. v3 opens one main window per
 *  organization plus unbound Homepage and Create windows, which turns each of
 *  those unstated subjects into a question that has to be answered explicitly.
 *  This module answers them, and it is deliberately PURE: no electron import,
 *  no filesystem, no timers. Every rule below is therefore driven by a test
 *  without an Electron window, the same way popoutRegistry in windows.ts is.
 *
 *  ⚠ THE ROUTING DECISIONS MUTATE AS THEY ANSWER. `requestOrg` is not a query
 *  whose answer the caller then acts on — between a query and its action two
 *  Homepage windows asking for the same organization in the same tick would
 *  both be told to open it, and the "exactly one window per organization"
 *  invariant would be decided by a race. So the decision and the state change
 *  are one step: it binds, or it takes out a reservation nobody else can
 *  duplicate. See `requestOrg` and `pending`. */
import { isOrgSlug, type CreationCloseDecision, type OrgOpenOutcome, type OrgOpenRefusal, type OrgWindowIdentity, type OrgWindowKind, type SavedOrgWindow } from '../../../packages/contracts/desktop-window'
import { isHoldingUrl, trustedUiUrl } from './policy'

/** THE NATIVE-INTERNAL ROUTING DECISION, which is NOT the contract the
 *  renderer sees.
 *
 *  The difference is the `open` case and its reservation ticket. A ticket is a
 *  half-finished native transaction: the organization is claimed but no window
 *  exists yet, and it has to be adopted or released. That obligation belongs to
 *  the host — handing it across the bridge would make the renderer responsible
 *  for completing a native step it cannot be trusted or relied upon to finish,
 *  and a renderer that crashed between the two would leak the claim. So the
 *  host consumes this decision, creates the window, adopts the ticket, and only
 *  then answers the renderer with an `OrgOpenOutcome` whose work is already
 *  done. See `openOrg`. */
export type OrgRoutingDecision =
  | { action: 'focused'; windowId: string; org: string }
  | { action: 'bound'; windowId: string; org: string }
  | { action: 'open'; ticket: string; org: string }
  | { action: 'pending'; org: string }
  | { action: 'refused'; org: string; reason: OrgOpenRefusal }

/** The narrow slice of a native window this registry needs, so its rules can
 *  be driven by a test without an Electron window. Mirrors the shape
 *  PopoutWindowLike takes in windows.ts and for the same reason. */
export interface MainWindowLike {
  isDestroyed(): boolean
}

export interface OrgWindowEntry<W extends MainWindowLike> {
  readonly id: string
  kind: OrgWindowKind
  org?: string
  readonly window: W
  /** The webContents id this window's bridge calls arrive from. */
  readonly senderId: number
  /** Monotonic registration order. The LOWEST live value owns the app-wide
   *  notification duties; see `notificationOwner`. */
  readonly registered: number
  /** Monotonic; the highest live value is the last-used main window. */
  activated: number
  /** The renderer has reported unfinished Create input in this window. */
  unsavedCreation: boolean
  /** A discard confirmation for THIS window is on screen right now. */
  confirming: boolean
}

/** How long a reservation BLOCKS OTHER CALLERS. Not how long the ticket is
 *  valid — see `adoptReservation`, and review finding f1 for why the two came
 *  apart. If the host dies between being told to open a window and adopting
 *  the ticket, an un-expiring claim would make that organization unopenable
 *  for the rest of the session; this bounds that. It does NOT invalidate the
 *  ticket, because the host that is still holding one and has a finished
 *  window to present is not the case this recovers from. */
const RESERVATION_BLOCK_MS = 15_000

/** A bound on tickets a buggy host never adopted or released. Blocking is
 *  already time-bounded, so an abandoned ticket costs nothing but a map entry;
 *  this stops an unbounded number of them accumulating. */
const RESERVATION_LIMIT = 64

export interface OrgWindowRegistryOptions {
  /** Injected so reservation expiry is deterministic in tests. */
  now?: () => number
  reservationTtlMs?: number
}

export function orgWindowRegistry<W extends MainWindowLike, Reveal = unknown>(options: OrgWindowRegistryOptions = {}) {
  const now = options.now ?? (() => Date.now())
  const blockFor = options.reservationTtlMs ?? RESERVATION_BLOCK_MS
  const entries = new Map<string, OrgWindowEntry<W>>()
  const reservations = new Map<string, { org: string; at: number }>()
  /** Targeted reveals whose destination window does not exist YET. See
   *  `queueReveal`: a notification's reveal is never dropped on the floor
   *  because the window it names is still being opened. */
  const waitingReveals = new Map<string, Reveal[]>()
  let registrations = 0, activations = 0, tickets = 0

  /** A destroyed window is not a window. Dropping its entry here rather than
   *  relying on a 'closed' listener means a missed or late teardown cannot
   *  leave an organization permanently claimed by something that is gone. */
  const prune = () => {
    for (const [id, entry] of entries) if (entry.window.isDestroyed()) entries.delete(id)
  }
  /** ⚠ THIS DOES NOT EXPIRE TICKETS, and that distinction is review finding
   *  f1. Trimming only bounds how many abandoned claims may accumulate; a
   *  ticket stays adoptable however old it is, because the host still holding
   *  one and presenting a finished window is not the dead-host case the time
   *  bound exists for. Oldest-first, since Map preserves insertion order, and
   *  only claims that no longer block anybody. */
  const trimReservations = () => {
    if (reservations.size <= RESERVATION_LIMIT) return
    const cutoff = now() - blockFor
    for (const [ticket, held] of reservations) {
      if (reservations.size <= RESERVATION_LIMIT) return
      if (held.at <= cutoff) reservations.delete(ticket)
    }
  }
  const live = () => { prune(); return [...entries.values()] }

  // ------------------------------------------------- notification ownership
  /** Who currently holds the app-wide notification duties, and a counter that
   *  advances on every transfer. The counter exists so an ownership
   *  announcement can be recognized as stale: identity events are delivered
   *  asynchronously, and a window must never act on an older one that arrives
   *  after a newer one. */
  let ownerId: string | undefined, ownerEpoch = 0
  const earliest = () => live().reduce<OrgWindowEntry<W> | undefined>((best, entry) => !best || entry.registered < best.registered ? entry : best, undefined)
  /** Recompute the owner and say whether it moved. Idempotent, so anything may
   *  call it before reading ownership; the host calls it after a window is
   *  registered or lost so it can announce a transfer. */
  const reconcileOwnership = (): { changed: boolean; owner?: string; previous?: string; epoch: number } => {
    const next = earliest()?.id
    if (next === ownerId) return { changed: false, owner: ownerId, previous: ownerId, epoch: ownerEpoch }
    const previous = ownerId
    ownerId = next
    ownerEpoch += 1
    return { changed: true, owner: ownerId, previous, epoch: ownerEpoch }
  }
  const currentOwner = () => { reconcileOwnership(); return ownerId }

  const identityOf = (entry: OrgWindowEntry<W>): OrgWindowIdentity => ({
    windowId: entry.id,
    kind: entry.kind,
    ...(entry.kind === 'org' ? { org: entry.org } : {}),
    notificationOwner: currentOwner() === entry.id,
  })
  const holderOf = (org: string) => live().find(entry => entry.kind === 'org' && entry.org === org)
  /** Whether a claim on that organization should stop ANOTHER caller opening
   *  it. Time-bounded: a host that died holding a ticket must not wedge the
   *  organization shut for the session. Adoption asks a different question. */
  const blockedFor = (org: string) => {
    const cutoff = now() - blockFor
    return [...reservations.values()].some(held => held.org === org && held.at > cutoff)
  }

  const register = (input: { id: string; senderId: number; window: W; kind: OrgWindowKind; org?: string }): OrgWindowIdentity => {
    prune()
    if (!input.id) throw new Error('A main window needs an id')
    if (entries.has(input.id)) throw new Error(`Window ${input.id} is already registered`)
    // ⚠ THE SENDER ID MUST BE THIS WINDOW'S OWN (review, stage 1). Sender
    // resolution matches an incoming call by this recorded integer and then
    // backstops it with a main-frame identity comparison, so a wrong id cannot
    // OPEN the gate — but it would quietly reduce a two-condition check to
    // one, and a wiring bug that passed the wrong webContents id would never
    // announce itself. Checked here, where the window is in hand, for any
    // window that exposes its webContents.
    const actual = (input.window as { webContents?: { id?: unknown } }).webContents?.id
    if (typeof actual === 'number' && actual !== input.senderId) {
      throw new Error(`Window ${input.id} was registered with sender ${input.senderId} but its webContents is ${actual}`)
    }
    if (input.kind === 'org') {
      if (!isOrgSlug(input.org)) throw new Error('An org-bound window needs a valid organization')
      if (holderOf(input.org)) throw new Error(`Organization ${input.org} is already open`)
    } else if (input.org !== undefined) throw new Error('Only an org-bound window carries an organization')
    const entry: OrgWindowEntry<W> = {
      id: input.id, kind: input.kind, org: input.kind === 'org' ? input.org : undefined,
      window: input.window, senderId: input.senderId,
      registered: ++registrations, activated: ++activations, unsavedCreation: false, confirming: false,
    }
    entries.set(entry.id, entry)
    return identityOf(entry)
  }

  /** BIND, the one transition a window's kind may ever make, and only in this
   *  direction. An org-bound window is terminal by settled behavior, so the
   *  guard is the invariant rather than a convenience. */
  const bind = (entry: OrgWindowEntry<W>, org: string): OrgWindowIdentity => {
    entry.kind = 'org'
    entry.org = org
    // A window that just became an organization is no longer a form in
    // progress; leaving the flag set would confirm a discard on its close.
    entry.unsavedCreation = false
    return identityOf(entry)
  }

  return {
    register,
    forget: (id: string) => { entries.delete(id) },
    get: (id: string) => { prune(); return entries.get(id) },
    identity: (id: string) => { prune(); const entry = entries.get(id); return entry && identityOf(entry) },
    /** Which window a bridge call came from. See resolveNativeSender, which is
     *  what actually decides whether to trust it. */
    bySender: (senderId: number) => { prune(); return [...entries.values()].find(entry => entry.senderId === senderId) },
    byOrg: (org: unknown) => isOrgSlug(org) ? holderOf(org) : undefined,
    list: live,
    /** Organizations currently claimed by a ticket that still blocks other
     *  callers. An abandoned claim drops out of this once it stops blocking,
     *  even though its ticket remains adoptable. */
    reservedOrgs: () => [...new Set([...reservations.values()].filter(held => held.at > now() - blockFor).map(held => held.org))],

    /** THE ONE WAY AN ORGANIZATION IS OPENED — homepage selection, tray
     *  selection and notification targeting all arrive here.
     *
     *  `callerId` is the window that asked, or null for the tray and for
     *  notifications, which belong to no window. The decision table:
     *
     *    already open        -> focused (the caller is left exactly as it was)
     *    already reserved    -> pending (someone else's window is on its way)
     *    caller is homepage  -> bound   (that same window, per settled behavior)
     *    anything else       -> open    (a new window, under a reservation)
     *
     *  A Create window is deliberately in "anything else": its binding comes
     *  only from a successful creation, through bindCreated. */
    requestOrg: (org: unknown, callerId?: string | null): OrgRoutingDecision => {
      if (!isOrgSlug(org)) return { action: 'refused', org: typeof org === 'string' ? org : '', reason: 'invalid-org' }
      prune(); trimReservations()
      const open = holderOf(org)
      if (open) return { action: 'focused', windowId: open.id, org }
      if (blockedFor(org)) return { action: 'pending', org }
      const caller = callerId ? entries.get(callerId) : undefined
      if (callerId && !caller) return { action: 'refused', org, reason: 'unknown-window' }
      if (caller && caller.kind === 'homepage') {
        bind(caller, org)
        return { action: 'bound', windowId: caller.id, org }
      }
      const ticket = `reservation-${++tickets}`
      reservations.set(ticket, { org, at: now() })
      return { action: 'open', ticket, org }
    },

    /** The host created the window it was told to create. Adopting the ticket
     *  registers it and releases the reservation in one step, so there is no
     *  instant where the organization is neither reserved nor held. */
    /** ⚠ A TICKET DOES NOT EXPIRE (review finding f1). An earlier revision
     *  swept the reservation on a timer and then refused to adopt it, which
     *  stranded the window the host had just finished building: unregistered,
     *  so every bridge call from it is refused, and frameless, so it has no OS
     *  chrome to fall back on either. The time bound exists to stop a DEAD
     *  host wedging an organization shut, and a live host presenting a
     *  finished window is not that case.
     *
     *  What adoption still refuses is the case that is genuinely unsafe: the
     *  organization was taken while this window was being built. `register`
     *  raises it, and `openOrg` turns it into a focus of the window that won
     *  plus a discard of the surplus one. */
    adoptReservation: (ticket: string, window: { id: string; senderId: number; window: W }): OrgWindowIdentity => {
      const held = reservations.get(ticket)
      if (!held) throw new Error(`Reservation ${ticket} is unknown`)
      reservations.delete(ticket)
      return register({ ...window, kind: 'org', org: held.org })
    },
    /** The window could not be created.
     *
     *  ⚠ RELEASING IS THE HOST'S OBLIGATION AND IT IS IMMEDIATE — the TTL is
     *  recovery from a host that died before it could, never the ordinary way
     *  a failed open is cleaned up. Waiting out fifteen seconds for a failure
     *  that is already known would leave the organization unopenable for that
     *  whole window, which reads to the user as the app ignoring them.
     *
     *  Any reveals that were waiting on this open are RETURNED rather than
     *  discarded: they were queued because a notification had somewhere to go,
     *  and the caller decides whether to retry or report — this function will
     *  not silently drop them. */
    releaseReservation: (ticket: string): Reveal[] => {
      const held = reservations.get(ticket)
      reservations.delete(ticket)
      if (!held) return []
      // Only if nothing else can still deliver them: another window for the
      // same organization may have arrived while this one was failing.
      if (holderOf(held.org) || blockedFor(held.org)) return []
      const waiting = waitingReveals.get(held.org) ?? []
      waitingReveals.delete(held.org)
      return waiting
    },

    /** A TARGETED REVEAL WHOSE WINDOW MAY NOT EXIST YET.
     *
     *  An org-scoped notification click has to reach that organization's own
     *  window and nothing else. When the window is already there this is just
     *  a lookup — but the interesting case is the race the click itself
     *  starts: the notification opens the organization, and the reveal is
     *  ready before the window is. Dropping it there is the failure mode the
     *  user sees as "clicking the notification did nothing", so it is held
     *  here and handed over by `takeReveals` the moment the window registers.
     *
     *  Returns the window to deliver to immediately, or undefined when the
     *  reveal was queued instead. */
    queueReveal: (org: unknown, reveal: Reveal): OrgWindowEntry<W> | undefined => {
      if (!isOrgSlug(org)) return undefined
      prune()
      const open = holderOf(org)
      if (open) return open
      waitingReveals.set(org, [...(waitingReveals.get(org) ?? []), reveal])
      return undefined
    },
    /** Everything queued for that organization, removed as it is handed over.
     *  Called when an org-bound window becomes ready. */
    takeReveals: (org: unknown): Reveal[] => {
      if (!isOrgSlug(org)) return []
      const waiting = waitingReveals.get(org) ?? []
      waitingReveals.delete(org)
      return waiting
    },
    pendingReveals: (org: unknown): number => isOrgSlug(org) ? (waitingReveals.get(org) ?? []).length : 0,

    /** A creation succeeded: bind the Create window that performed it.
     *
     *  Refused, never thrown, for both failure shapes — the renderer has to
     *  keep its form and show the error, which an exception unwinding the
     *  native handler does not let it do. */
    bindCreated: (callerId: string, org: unknown): OrgRoutingDecision => {
      if (!isOrgSlug(org)) return { action: 'refused', org: typeof org === 'string' ? org : '', reason: 'invalid-org' }
      prune()
      const caller = entries.get(callerId)
      if (!caller) return { action: 'refused', org, reason: 'unknown-window' }
      if (caller.kind === 'org') return { action: 'refused', org, reason: 'already-bound' }
      if (caller.kind !== 'create') return { action: 'refused', org, reason: 'not-a-creation-window' }
      if (holderOf(org) || blockedFor(org)) return { action: 'refused', org, reason: 'already-open' }
      bind(caller, org)
      return { action: 'bound', windowId: caller.id, org }
    },

    /** ⚠ THE ONE WINDOW THAT OWNS THE APP-WIDE NOTIFICATION DUTIES, and the
     *  reason this is not simply "every window".
     *
     *  notifications.ts reads notices across ALL organizations, reconciles
     *  native alerts against what is still live, and publishes ONE aggregate
     *  taskbar-attention projection. Those are global, single-writer jobs. In
     *  v2 the `notification-poll` wake went to the only window there was, so
     *  that was true by construction; sending it to every main window in v3
     *  would put N renderers on the same global read, racing each other's
     *  reconciliation and each pushing its own aggregate — the taskbar would
     *  be written by whichever finished last and native alerts would be closed
     *  and reopened by competing passes.
     *
     *  So exactly one window holds it, chosen NATIVELY rather than negotiated
     *  between renderers: the earliest-registered live window. That rule is
     *  stable (an unrelated window opening never moves it) and transfers by
     *  itself when the owner closes, because the next-earliest simply becomes
     *  the lowest. When every window is gone there is no owner and the tray
     *  and last-window behavior are unchanged — native notification delivery
     *  does not depend on a renderer being present.
     *
     *  ⚠ WINDOW-LOCAL REVEAL IS A SEPARATE THING AND STAYS SEPARATE. Owning
     *  the global poll says nothing about who a targeted org reveal goes to;
     *  that is `queueReveal`, and it always addresses the organization's own
     *  window. */
    notificationOwner: () => { const id = currentOwner(); return id ? entries.get(id) : undefined },

    /** ⚠ THE WRITE GATE, and the reason routing an event is not enough.
     *
     *  The renderer polls the cross-organization projection on mount, on a
     *  preference change and on a live bump — not only when native wakes it —
     *  so native cannot enforce single ownership by choosing who receives
     *  `notification-poll`. What native CAN enforce is who is allowed to
     *  WRITE: the taskbar aggregate (`setPendingAttention`), the native alert
     *  reconciliation (`syncNotifications`) and the dispatch (`notify`) are
     *  refused from any window that is not the current owner.
     *
     *  ⚠ THIS IS ALSO THE STALE-WRITER GUARD, and it works because it asks
     *  the question at the moment of the write rather than at the moment the
     *  duty was handed out. An aggregate an old owner computed before the
     *  transfer, arriving after it, is written by a window that is no longer
     *  the owner — so it is refused on the same test, with no epoch to
     *  compare and no window of time in which both answers are yes. */
    isNotificationOwner: (id: string) => currentOwner() === id,

    /** Recompute ownership and report a transfer, so the host can emit
     *  `window-identity` to the window that GAINED the duty. Idempotent. */
    reconcileOwnership,
    ownershipEpoch: () => { reconcileOwnership(); return ownerEpoch },

    activate: (id: string) => { const entry = entries.get(id); if (entry) entry.activated = ++activations },
    /** The last-used main window — what a tray double-click and a second
     *  instance should restore. Undefined when every window is gone, which is
     *  the caller's cue to open a Homepage window instead. */
    lastActivated: () => live().reduce<OrgWindowEntry<W> | undefined>((best, entry) => !best || entry.activated > best.activated ? entry : best, undefined),

    /** The renderer publishes whether its Create form holds unfinished input.
     *  Native owns the confirmation (authorized 2026-09-21) but never the
     *  form, so this flag is the whole of what it knows about the draft. */
    setUnsavedCreation: (id: string, dirty: boolean) => { const entry = entries.get(id); if (entry) entry.unsavedCreation = !!dirty && entry.kind !== 'org' },

    /** What a close attempt on this window should do. `awaiting` is the
     *  duplicate-prompt guard: a second confirmation for a window that already
     *  has one on screen asks the same question twice and lets two answers
     *  race, so the close is refused and the standing prompt stays the only
     *  question. */
    beginClose: (id: string): CreationCloseDecision => {
      prune()
      const entry = entries.get(id)
      if (!entry || !entry.unsavedCreation) return 'close'
      if (entry.confirming) return 'awaiting'
      entry.confirming = true
      return 'confirm'
    },
    /** The user answered. `discard` clears the draft so the close that follows
     *  proceeds; Cancel leaves the flag set and the window exactly as it was. */
    settleClose: (id: string, discard: boolean) => {
      const entry = entries.get(id)
      if (!entry) return
      entry.confirming = false
      if (discard) entry.unsavedCreation = false
    },

    /** WHAT A GRACEFUL QUIT OR RESTART OWES AN UNFINISHED FORM (ruling
     *  2026-09-21): it must confirm the discard, and Cancel aborts the quit
     *  rather than merely sparing that one window.
     *
     *  `busy` is the same duplicate-prompt guard as above, applied to the
     *  quit: a window whose own close confirmation is already on screen must
     *  not be asked a second time by the shutdown, so the shutdown aborts and
     *  leaves the standing prompt to be answered. Nothing is discarded. */
    quitCreationGate: (): { action: 'proceed' } | { action: 'confirm'; windowIds: string[] } | { action: 'busy'; windowIds: string[] } => {
      const dirty = live().filter(entry => entry.unsavedCreation)
      const busy = dirty.filter(entry => entry.confirming)
      if (busy.length) return { action: 'busy', windowIds: busy.map(entry => entry.id) }
      if (!dirty.length) return { action: 'proceed' }
      return { action: 'confirm', windowIds: dirty.map(entry => entry.id) }
    },
  }
}

export type OrgWindowRegistry<W extends MainWindowLike, Reveal = unknown> = ReturnType<typeof orgWindowRegistry<W, Reveal>>

/** What the host must be able to do for `openOrg` to finish a transaction. */
export interface OrgOpenHost<W extends MainWindowLike, Reveal> {
  /** Restore and raise an existing window. See revealPopout in windows.ts for
   *  why the order inside this matters. */
  focus(entry: OrgWindowEntry<W>): void
  /** Create a new org-bound main window and return its registration details.
   *  Throwing is a legitimate outcome and is handled.
   *
   *  ⚠ WHAT THIS MAY AWAIT, because the question is load-bearing and nothing
   *  used to answer it (review finding f1). It must resolve as soon as the
   *  native window object exists and its webContents id is known. It must NOT
   *  await ready-to-show, first paint, or the renderer reporting its identity
   *  — the last of those cannot work at all, since the preload resolves its
   *  identity synchronously through sender lookup and the window is not
   *  addressable until it is REGISTERED, which is the step this returns to.
   *  So: construct, return, register, then load the document. */
  create(org: string): Promise<{ id: string; senderId: number; window: W }>
  /** ⚠ DISPOSE OF A WINDOW THAT COULD NOT BE ADOPTED. Required, not
   *  optional: `create` has already put a real window on the user's screen by
   *  the time adoption can fail, and a host with no way to take it back leaves
   *  it there unregistered — dead controls on a frameless window, and the
   *  organization still unclaimed so the next request opens a second one. That
   *  is review finding f1, and making this member optional is how it would
   *  come back. */
  discard(created: { id: string; senderId: number; window: W }): void
  /** Hand the window everything that was waiting for it. */
  deliverReveals?(entry: OrgWindowEntry<W>, reveals: Reveal[]): void
  /** The open failed and these reveals had nowhere to go. Reported rather
   *  than dropped, so a notification click that led nowhere is at least
   *  recorded. */
  undeliverable?(org: string, reveals: Reveal[]): void
}

/** OPEN AN ORGANIZATION, END TO END, INSIDE THE NATIVE HOST.
 *
 *  ⚠ THE WHOLE POINT IS THAT NOTHING HALF-DONE CROSSES THE BRIDGE. The
 *  registry's own decision can be `open` with a reservation ticket, which is
 *  an obligation: adopt it or release it. This function is where that
 *  obligation is discharged — it creates the window, adopts the ticket, and
 *  releases it IMMEDIATELY if creation throws rather than leaving the
 *  organization claimed until the TTL expires. What the caller gets back is an
 *  `OrgOpenOutcome` whose work has already happened, which is the only shape
 *  the renderer ever sees.
 *
 *  Reveals waiting on this organization are delivered as part of the same
 *  step, so a notification that opened the window is not dropped in the gap
 *  between the window existing and the renderer asking for anything. */
export async function openOrg<W extends MainWindowLike, Reveal>(
  registry: OrgWindowRegistry<W, Reveal>, org: unknown, callerId: string | null, host: OrgOpenHost<W, Reveal>,
): Promise<OrgOpenOutcome> {
  const deliver = (entry: OrgWindowEntry<W>) => {
    const waiting = registry.takeReveals(entry.org)
    if (waiting.length) host.deliverReveals?.(entry, waiting)
  }
  const decision = registry.requestOrg(org, callerId)
  if (decision.action === 'focused') {
    const entry = registry.get(decision.windowId)
    if (entry) { host.focus(entry); deliver(entry) }
    return { action: 'focused', windowId: decision.windowId, org: decision.org }
  }
  if (decision.action === 'bound') {
    const entry = registry.get(decision.windowId)
    if (entry) deliver(entry)
    return { action: 'bound', windowId: decision.windowId, org: decision.org }
  }
  // Left queued on purpose: the window already on its way delivers them.
  if (decision.action === 'pending') return { action: 'pending', org: decision.org }
  if (decision.action === 'refused') return decision
  let created: { id: string; senderId: number; window: W }
  try {
    created = await host.create(decision.org)
  } catch (error) {
    // Nothing was built, so there is nothing to take back. Release at once
    // rather than waiting out the block window, and report any reveal that
    // was waiting on this open rather than dropping it.
    const stranded = registry.releaseReservation(decision.ticket)
    if (stranded.length) host.undeliverable?.(decision.org, stranded)
    throw error
  }
  try {
    const identity = registry.adoptReservation(decision.ticket, created)
    const entry = registry.get(identity.windowId)
    if (entry) deliver(entry)
    return { action: 'opened', windowId: identity.windowId, org: decision.org }
  } catch (error) {
    // ⚠ THE WINDOW EXISTS. It is on the user's screen right now, and it is
    // not registered — so `resolveNativeSender` refuses its every bridge
    // call, and it is frameless, so its minimize, maximize and close are
    // dead with no OS chrome behind them. Handing it back is not optional
    // (review finding f1); leaving it is the worst outcome in this file.
    host.discard(created)
    registry.releaseReservation(decision.ticket)
    // The realistic way to get here is that another window took the
    // organization while this one was being built. That is not a failure
    // from the user's point of view — they asked for that organization and
    // it is open — so surface the window that won and let the surplus one go.
    const holder = registry.byOrg(decision.org)
    if (holder) {
      host.focus(holder)
      deliver(holder)
      return { action: 'focused', windowId: holder.id, org: decision.org }
    }
    const stranded = registry.takeReveals(decision.org)
    if (stranded.length) host.undeliverable?.(decision.org, stranded)
    throw error
  }
}

// --------------------------------------------------------------- sender trust

/** The structural shape of an IpcMainInvokeEvent this module needs, so the
 *  refusal rules can be tested without Electron. `senderFrame` is compared by
 *  IDENTITY against the window's own main frame, exactly as assertNativeSender
 *  does today, which is why it is typed as an opaque value that also has a
 *  url rather than as a frame class. */
export interface NativeSenderEvent {
  sender: { id: number }
  senderFrame: ({ url: string } & object) | null
}
export interface NativeSenderWindow extends MainWindowLike {
  webContents: { id: number; mainFrame: unknown }
}

/** WHICH REGISTERED MAIN WINDOW SENT THIS, or a refusal.
 *
 *  ⚠ THIS IS assertNativeSender GENERALIZED, NOT RELAXED. All three of the
 *  original refusals are kept verbatim — the sender must be a main window's
 *  own webContents, the frame must be that window's MAIN frame (so an embedded
 *  or popped-out document can never issue a native command), and its document
 *  must be a trusted app URL or the internal holding page. One refusal is
 *  ADDED: a sender that is not a registered main window at all, which in v2
 *  was implied by there being only one window to compare against.
 *
 *  It returns the caller rather than asserting, because in v3 every window
 *  command needs to know WHICH window to act on, and resolving the sender is
 *  the only trustworthy answer to that: a window id passed as an argument is
 *  chosen by the renderer and would let one organization's bridge command
 *  another organization's window. */
export function resolveNativeSender<W extends NativeSenderWindow>(
  event: NativeSenderEvent, registry: { bySender(senderId: number): OrgWindowEntry<W> | undefined }, origin: string,
): OrgWindowEntry<W> {
  const refuse = () => new Error('Native operation refused for this document')
  const entry = registry.bySender(event.sender?.id ?? -1)
  if (!entry || entry.window.isDestroyed()) throw refuse()
  const frame = event.senderFrame
  if (!frame || (frame as unknown) !== entry.window.webContents.mainFrame) throw refuse()
  if (!trustedUiUrl(frame.url, origin) && !isHoldingUrl(frame.url)) throw refuse()
  return entry
}

// ------------------------------------------------------- startup restoration

export interface RestorePlan {
  /** The windows to open, in order. An entry without `org` is a Homepage. */
  windows: { org?: string }[]
  /** Saved organizations that no longer exist. */
  skippedOrgs: string[]
  /** True when nothing could be reopened and a Homepage stands in. */
  homepageFallback: boolean
  /** A short line for the user when an ORGANIZATION was skipped; undefined
   *  when every saved window was restored. Skipping SILENTLY is what the
   *  ruling forbids. Panels are not mentioned here because native does not
   *  know about them — see below. */
  notice?: string
}

/** WHAT ORDINARY STARTUP RESTORES, and what it says about what it could not
 *  (ruling 2026-09-21: restore valid targets, skip missing targets with a
 *  short notice, Homepage if no organization can reopen).
 *
 *  ⚠ ORGANIZATIONS ONLY. An earlier revision also took a `panelExists`
 *  predicate and filtered saved popout names with it. That was a second panel
 *  store wearing a different hat: which panels an organization had open is the
 *  RENDERER's record, and a native copy of it is guaranteed to drift from the
 *  real one. Native restores the WINDOW and nothing inside it; the renderer
 *  validates its own targets and reports what it could not reopen, and native
 *  may FORWARD that report to the window that should show it — never
 *  reconstruct it.
 *
 *  ⚠ SKIPPING IS NOT DELETING. `orgExists` answering false removes the
 *  window from THIS startup and says so. It does not discard the
 *  organization's saved geometry and must never be treated as proof the
 *  organization is gone: an engine that has not finished starting, or a
 *  backend outage, answers false for organizations that are perfectly fine.
 *  Only a real deletion may forget geometry — see
 *  OrgPlacement.forgetDeletedOrg. */
export function planRestore(
  saved: readonly SavedOrgWindow[],
  orgExists: (org: string) => boolean,
): RestorePlan {
  const windows: RestorePlan['windows'] = []
  const skippedOrgs: string[] = []
  for (const record of saved) {
    if (record.org === undefined) { windows.push({}); continue }
    if (!isOrgSlug(record.org) || !orgExists(record.org)) {
      // A corrupt slug is a missing target too: it names nothing that can be
      // opened, and inventing a window for it would be worse than saying so.
      if (typeof record.org === 'string' && record.org) skippedOrgs.push(record.org)
      continue
    }
    windows.push({ org: record.org })
  }
  // ⚠ A FALLBACK IS A HOMEPAGE THAT STOOD IN FOR SOMETHING, not merely the
  // absence of an organization (review, stage 1). A session that genuinely
  // saved only a Homepage window restored exactly what it saved, and calling
  // that a fallback tells the renderer something untrue.
  const homepageFallback = !windows.length
  if (homepageFallback) windows.push({})
  const notice = skippedOrgs.length
    ? `Orgtree could not reopen ${skippedOrgs.length === 1 ? 'an organization' : `${skippedOrgs.length} organizations`}`
      + ` (${skippedOrgs.join(', ')}) from the last session.`
      + (homepageFallback ? ' Showing the homepage instead.' : '')
    : undefined
  return { windows, skippedOrgs, homepageFallback, ...(notice ? { notice } : {}) }
}
