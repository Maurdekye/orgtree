/** THE NATIVE IDENTITY OF ONE MAIN WINDOW, and the vocabulary every native
 *  window command is scoped by.
 *
 *  v2 had exactly one main BrowserWindow, so "the window" needed no name: the
 *  bridge's window commands, its events and its popout registry all meant that
 *  single window implicitly. v3 opens one main window per organization, plus
 *  unbound Homepage and Create windows, so every one of those implicit
 *  references has to name a window instead — and the name has to be something
 *  the renderer can be told before it makes its first call.
 *
 *  This file is the desktop-window portion of the contract: the identity a
 *  window carries, the outcome of asking to open an organization, and the slug
 *  rule both sides validate against. Nothing here is renderer policy — which
 *  view a bound window shows (Canvas or Attention) is the renderer's own mode
 *  and is deliberately absent. */

import { isAppPath } from './ui-route'

/** What a main window IS natively.
 *
 *  `homepage` and `create` are UNBOUND: they belong to no organization and may
 *  still become bound. `org` is BOUND and is terminal — a bound window never
 *  changes organization (settled behavior). Opening a different org from a
 *  bound window opens or focuses another window; it never repoints this one. */
export type OrgWindowKind = 'homepage' | 'create' | 'org'

/** One window's identity, handed to its renderer at startup and again whenever
 *  it changes. `windowId` is minted when the window is created and is stable
 *  for the window's whole life — a Homepage window that becomes org-bound keeps
 *  the same id, because it is the same window and the same document.
 *
 *  `org` is present exactly when `kind === 'org'`. */
export interface OrgWindowIdentity {
  windowId: string
  kind: OrgWindowKind
  org?: string
}

/** Why a request to bind or open an organization was refused. Structured
 *  rather than thrown, because a refusal is a state the renderer has to SHOW —
 *  a creation that could not bind must keep its form and explain itself — not
 *  an exception that unwinds a native handler. */
export type OrgOpenRefusal =
  /** The slug was not a well-formed organization name. */
  | 'invalid-org'
  /** Another live window already holds that organization. */
  | 'already-open'
  /** The calling window is already bound to an organization. */
  | 'already-bound'
  /** Binding a created organization was asked of a window that is not a
   *  Create window. */
  | 'not-a-creation-window'
  /** The calling window is not a registered main window. */
  | 'unknown-window'

/** What the native side DID about a request to open an organization.
 *
 *  ⚠ THIS IS A DECISION ALREADY TAKEN AND ALREADY CARRIED OUT, not advice and
 *  not a job handed back. By the time the renderer sees one of these, the
 *  native host has finished the whole transaction — it has focused the
 *  existing window, bound the caller, or created the new window itself. The
 *  renderer is never given a reservation ticket to adopt and never has to
 *  complete a native step; reservations are a native-internal coordination
 *  device and do not appear on this contract at all. */
export type OrgOpenOutcome =
  /** That organization is already open in `windowId`; the caller was left
   *  exactly as it was and that window has been restored and focused. */
  | { action: 'focused'; windowId: string; org: string }
  /** The CALLING window is now bound to that organization and should navigate
   *  itself to the organization's Canvas. No window was created or destroyed. */
  | { action: 'bound'; windowId: string; org: string }
  /** The native host created a new org-bound window, which is `windowId`. The
   *  calling window is unchanged. */
  | { action: 'opened'; windowId: string; org: string }
  /** A window for that organization was already being opened when this
   *  request arrived. The correct response is to do nothing: the window on its
   *  way will appear, and any pending reveal for it is delivered when it is
   *  ready. */
  | { action: 'pending'; org: string }
  | { action: 'refused'; org: string; reason: OrgOpenRefusal }

/** What a window with an unfinished Create form should do when something tries
 *  to close it.
 *
 *  `close` — nothing unsaved, or the user already confirmed; proceed.
 *  `confirm` — raise the window-parented confirmation and act on the answer.
 *  `awaiting` — a confirmation for THIS window is already on screen. Raising a
 *    second one is the duplicate prompt the ruling forbids: the close is
 *    refused and the existing prompt remains the only question asked. */
export type CreationCloseDecision = 'close' | 'confirm' | 'awaiting'

/** A saved main window from a previous run, as startup restoration reads it.
 *  `org` is absent for a Homepage window; a Create window is never saved,
 *  because creation drafts are deliberately not persisted. */
export interface SavedOrgWindow {
  org?: string
  popouts?: string[]
}

/** Which organization names the native side accepts.
 *
 *  ⚠ THE CANONICAL EXISTING CONSTRAINT AND NOTHING ELSE. This is exactly the
 *  slug `isAppPath` already admits in `/o/<org>` (ui-route.ts), deliberately
 *  derived from that function rather than restated, so the two cannot drift
 *  and so no rule invented here can refuse an organization the product
 *  already has. In particular there is NO length cap: ui-route imposes none,
 *  and adding one would reject existing organizations on a boundary nothing
 *  else in the product enforces. */
export function isOrgSlug(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && isAppPath(`/o/${value}`)
}
