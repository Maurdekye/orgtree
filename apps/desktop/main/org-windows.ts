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

/** A reservation is an organization spoken for by a window that does not exist
 *  yet. It expires, and that is not tidiness: if the host throws between being
 *  told to open a window and adopting the ticket, an un-expiring reservation
 *  would make that organization unopenable for the rest of the session. */
const RESERVATION_TTL_MS = 15_000

export interface OrgWindowRegistryOptions {
  /** Injected so reservation expiry is deterministic in tests. */
  now?: () => number
  reservationTtlMs?: number
}

export function orgWindowRegistry<W extends MainWindowLike, Reveal = unknown>(options: OrgWindowRegistryOptions = {}) {
  const now = options.now ?? (() => Date.now())
  const ttl = options.reservationTtlMs ?? RESERVATION_TTL_MS
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
  const sweep = () => {
    const cutoff = now() - ttl
    for (const [ticket, held] of reservations) if (held.at <= cutoff) reservations.delete(ticket)
  }
  const live = () => { prune(); return [...entries.values()] }
  const identityOf = (entry: OrgWindowEntry<W>): OrgWindowIdentity =>
    entry.kind === 'org' ? { windowId: entry.id, kind: entry.kind, org: entry.org } : { windowId: entry.id, kind: entry.kind }
  const holderOf = (org: string) => live().find(entry => entry.kind === 'org' && entry.org === org)
  const reservedFor = (org: string) => { sweep(); return [...reservations.values()].some(held => held.org === org) }

  const register = (input: { id: string; senderId: number; window: W; kind: OrgWindowKind; org?: string }): OrgWindowIdentity => {
    prune()
    if (!input.id) throw new Error('A main window needs an id')
    if (entries.has(input.id)) throw new Error(`Window ${input.id} is already registered`)
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
    reservedOrgs: () => { sweep(); return [...reservations.values()].map(held => held.org) },

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
      prune(); sweep()
      const open = holderOf(org)
      if (open) return { action: 'focused', windowId: open.id, org }
      if (reservedFor(org)) return { action: 'pending', org }
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
    adoptReservation: (ticket: string, window: { id: string; senderId: number; window: W }): OrgWindowIdentity => {
      sweep()
      const held = reservations.get(ticket)
      if (!held) throw new Error(`Reservation ${ticket} is unknown or has expired`)
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
      if (holderOf(held.org) || reservedFor(held.org)) return []
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
      prune(); sweep()
      const caller = entries.get(callerId)
      if (!caller) return { action: 'refused', org, reason: 'unknown-window' }
      if (caller.kind === 'org') return { action: 'refused', org, reason: 'already-bound' }
      if (caller.kind !== 'create') return { action: 'refused', org, reason: 'not-a-creation-window' }
      if (holderOf(org) || reservedFor(org)) return { action: 'refused', org, reason: 'already-open' }
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
    notificationOwner: () => live().reduce<OrgWindowEntry<W> | undefined>((best, entry) => !best || entry.registered < best.registered ? entry : best, undefined),

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
   *  Throwing is a legitimate outcome and is handled. */
  create(org: string): Promise<{ id: string; senderId: number; window: W }>
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
    const stranded = registry.releaseReservation(decision.ticket)
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
  windows: { org?: string; popouts: string[] }[]
  /** Saved organizations that no longer exist. */
  skippedOrgs: string[]
  /** Saved panels that no longer exist, per surviving organization. */
  skippedPopouts: { org: string; names: string[] }[]
  /** True when nothing could be reopened and a Homepage stands in. */
  homepageFallback: boolean
  /** A short line for the user when something was skipped; undefined when
   *  everything was restored. Skipping SILENTLY is what the ruling forbids. */
  notice?: string
}

/** WHAT ORDINARY STARTUP RESTORES, and what it says about what it could not
 *  (ruling 2026-09-21: restore valid targets, skip missing org/panel targets
 *  with a short notice, Homepage if no organization can reopen).
 *
 *  `orgExists` is the host's knowledge of which organizations the engine still
 *  has. `panelExists` is optional and defaults to true, because a popout's
 *  target is renderer-owned: native knows a saved NAME and its geometry, not
 *  whether the panel behind it still means anything. Where the host can answer,
 *  it answers; where it cannot, the saved names pass through and the renderer
 *  remains the authority. */
export function planRestore(
  saved: readonly SavedOrgWindow[],
  orgExists: (org: string) => boolean,
  panelExists: (org: string, name: string) => boolean = () => true,
): RestorePlan {
  const windows: RestorePlan['windows'] = []
  const skippedOrgs: string[] = []
  const skippedPopouts: RestorePlan['skippedPopouts'] = []
  for (const record of saved) {
    if (record.org === undefined) { windows.push({ popouts: [] }); continue }
    if (!isOrgSlug(record.org) || !orgExists(record.org)) {
      // A corrupt slug is a missing target too: it names nothing that can be
      // opened, and inventing a window for it would be worse than saying so.
      if (typeof record.org === 'string' && record.org) skippedOrgs.push(record.org)
      continue
    }
    const org = record.org
    const names = (record.popouts ?? []).filter(name => typeof name === 'string' && name)
    const kept = names.filter(name => panelExists(org, name))
    const missing = names.filter(name => !panelExists(org, name))
    if (missing.length) skippedPopouts.push({ org, names: missing })
    windows.push({ org, popouts: kept })
  }
  const homepageFallback = !windows.some(window => window.org !== undefined)
  if (homepageFallback && !windows.length) windows.push({ popouts: [] })
  const parts: string[] = []
  if (skippedOrgs.length) parts.push(`${skippedOrgs.length === 1 ? 'an organization' : `${skippedOrgs.length} organizations`} (${skippedOrgs.join(', ')})`)
  const missingPanels = skippedPopouts.reduce((total, record) => total + record.names.length, 0)
  if (missingPanels) parts.push(`${missingPanels === 1 ? 'a panel' : `${missingPanels} panels`}`)
  const notice = parts.length
    ? `Orgtree could not reopen ${parts.join(' and ')} from the last session.`
      + (homepageFallback ? ' Showing the homepage instead.' : '')
    : undefined
  return { windows, skippedOrgs, skippedPopouts, homepageFallback, ...(notice ? { notice } : {}) }
}
