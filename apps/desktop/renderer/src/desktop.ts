import type { DesktopBridge, DesktopControlsState, DesktopNotification, DesktopPreferences, DesktopWindowState } from '../../../../packages/contracts'

export type NativeNotice = DesktopNotification
export type NativePreferences = DesktopPreferences & {
  routineNotifications?: boolean
  /** v3 startup choice, agreed with the native owner (contract v2 §N4):
   *  reopen the previous organization windows in their saved positions, or
   *  start with one fresh Homepage. Optional here because an older shell does
   *  not have it; absent reads as `'restore'`, which is the default. */
  startupMode?: OrgStartupMode
}

// ------------------------------------------------------- v3 window identity
//
// ⚠ A RENDERER-LOCAL MIRROR OF THE NATIVE CONTRACT, NOT A SECOND AUTHORITY.
// `packages/contracts` is the native side's file to declare and this branch may
// not edit it, so these shapes are written here structurally — exactly the way
// `getAppVersion` was added as an optional probe with the same note. When
// `packages/contracts/desktop-window.ts` lands, these definitions are deleted
// and re-exported from there; nothing else in the renderer has to change,
// because everything downstream already speaks these names.
//
// EVERY MEMBER IS OPTIONAL. That is not defensive style: the shell must keep
// working against today's preload, which has none of them, and in a plain
// browser, which has no bridge at all. A missing member means "this is not a
// v3 native window", never "the feature failed".

export type OrgWindowKind = 'homepage' | 'create' | 'org'
export type OrgStartupMode = 'restore' | 'homepage'

export interface OrgWindowIdentity {
  /** minted at window creation and stable for the window's life — a Homepage
   *  that binds itself to an organization keeps its id */
  windowId: string
  kind: OrgWindowKind
  /** present exactly when kind === 'org' */
  org?: string
  /** whether THIS window carries the app-wide notification duties: the
   *  cross-organization projection read, the native cleanup reconciliation and
   *  the taskbar aggregate. Exactly one live window has it; it transfers when
   *  that window closes. Handling a notification CLICK is not part of it —
   *  every window does that for its own target. */
  notificationOwner?: boolean
}

/** What asking to open an organization did. `bound` is the only outcome that
 *  changes the calling window; `focused`, `opened` and `pending` all mean the
 *  native side has it in hand and the caller does nothing. */
export type OrgOpenOutcome =
  | { action: 'focused'; windowId?: string; org: string }
  | { action: 'bound'; windowId?: string; org: string }
  | { action: 'opened'; org: string }
  | { action: 'pending'; org: string }
  | { action: 'refused'; org: string; reason: string }

/** Restoration skipped something. NATIVE ORIGINATES ONLY THE ORGANIZATIONS.
 *
 *  ⚠ `panels` IS ALWAYS EMPTY and is kept only so the payload shape does not
 *  change under anyone. Contract v2 had native validating panel targets too;
 *  v3 removed that after multi-window-design pointed out it was a second
 *  panel store wearing a different hat. The renderer holds the saved open-set
 *  and is the only side that can resolve a panel's target against the
 *  organization tree, so the panel half is originated here — see
 *  `shell/restorenotice.ts`. */
export interface RestoreSkipped {
  orgs: string[]
  panels: never[]
}

/** The v3 additions, as optional probes. */
export interface NativeWindowBridge {
  /** synchronous and already current at first paint, so a window cannot flash
   *  the wrong view for a frame. `null` when the sender gate refused, which is
   *  the same condition under which there is no bridge at all. */
  windowIdentity?: OrgWindowIdentity | null
  getWindowIdentity?(): Promise<OrgWindowIdentity>
  openHomepageWindow?(): Promise<OrgWindowIdentity>
  openCreateOrgWindow?(): Promise<OrgWindowIdentity>
  /** THE way an organization is opened. Never falls back to switching a bound
   *  window's organization. */
  requestOrg?(org: string): Promise<OrgOpenOutcome>
  /** creation succeeded — bind THIS create window to the new organization */
  bindCreatedOrg?(org: string): Promise<OrgOpenOutcome>
  /** which organizations currently hold a main window.
   *
   *  ⚠ ORGANIZATIONS, NOT WINDOW IDS, deliberately: the list hands out no way
   *  to address another window, so knowing what is open does not become a
   *  route into it. The renderer uses it for one thing — marking a Homepage
   *  row "Already open" BEFORE it is clicked. The behaviour never depended on
   *  it: `requestOrg` answers `focused` and brings that window forward without
   *  rebinding the caller either way. Kept live by the app-wide `open-orgs`
   *  event rather than by polling. */
  openOrgs?(): Promise<string[]>
  /** publish whether this window holds unfinished creation input. Native owns
   *  the confirmation for every close route, including app Quit and restart;
   *  the renderer only owns the truth of the flag. */
  setUnsavedCreation?(dirty: boolean): Promise<void>
  /** window-scoped events held until the renderer is listening, so a
   *  notification click that arrives before React mounts is not lost */
  takePendingWindowEvents?(): Promise<unknown[]>
  /** The taskbar aggregate, WIDENED — the user ruled (2026-09-21) that the
   *  pulse flashes the affected item's own organization window, falling back
   *  to the last-used main window when that organization has none open, and
   *  never every main window indiscriminately. Native needs the organization
   *  per row to do that.
   *
   *  ⚠ THE SECOND ARGUMENT IS ADDITIVE AND OPTIONAL, deliberately. `ids` is
   *  unchanged in meaning and order, so a shell that ignores `items` behaves
   *  exactly as it does today; `items` says the same rows in a shape native
   *  may rely on, rather than making it parse `ids`, whose
   *  `JSON.stringify([org, id])` form is the renderer's dedup ENCODING and not
   *  a contract. Both halves come out of the one projection pass — no second
   *  fetch, no parallel state (see pending-attention.ts). */
  setPendingAttention?(ids: string[], items?: { org: string; id: string }[]): Promise<void>
}

// The bridge belongs to the authoritative opener. React handlers retain this
// module's window when their existing DOM is adopted by an isolated popout.
export type NativeDesktop = Omit<DesktopBridge,
  'getPreferences' | 'setPreferences' | 'setPendingAttention'> & {
  getPreferences(): Promise<NativePreferences>
  setPreferences(patch: Partial<NativePreferences>): Promise<NativePreferences>
  notify?(notice: NativeNotice): Promise<boolean>
  getWindowState?(): Promise<DesktopWindowState>
  getWindowControlsState?(): Promise<DesktopControlsState>
  getAppVersion?(): Promise<unknown>
} & NativeWindowBridge

export const desktop = (): NativeDesktop | undefined =>
  (window as Window & { orgtreeDesktop?: NativeDesktop }).orgtreeDesktop

/** True only in a shell that actually implements the v3 window model.
 *
 *  ⚠ THE PROBE IS `requestOrg`, NOT `desktop()`. Today's shipped preload
 *  exposes a bridge and knows nothing about window identity, so asking "is
 *  there a bridge?" would turn the v3 shell on inside a shell that cannot
 *  route any of it. One capability, checked at the one place that decides
 *  which shell renders. */
export const nativeWindows = (bridge = desktop()): boolean =>
  typeof bridge?.requestOrg === 'function'

/** This window's identity as of RIGHT NOW, synchronously, with no promise to
 *  await and no frame of the wrong view. `null` in a browser, in an older
 *  shell, and when the sender gate refused. */
export const windowIdentity = (bridge = desktop()): OrgWindowIdentity | null =>
  bridge?.windowIdentity ?? null

/** The startup choice, with the agreed default applied in ONE place so no
 *  caller invents a second answer for an older shell that has no such
 *  preference. */
export const startupMode = (prefs: NativePreferences | null | undefined): OrgStartupMode =>
  prefs?.startupMode === 'homepage' ? 'homepage' : 'restore'
