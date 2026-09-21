/** Desktop transport only. Python retains the authoritative /api domain. */
export const PROTOCOL_VERSION = 1 as const
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'
export interface EngineRequest { method: HttpMethod; path: string; body?: unknown }
export interface EngineReply { status: number; data: unknown }
export interface EngineReady {
  type: 'ready'; protocol: 1; port: number; pid: number; dataRootId: string
}
export type EngineStatus =
  | { state: 'starting' }
  | { state: 'ready' }
  | { state: 'unavailable' | 'stopped'; message: string }
import type { VisualTheme } from './visual-theme'
import type { ContrastTheme } from './contrast-theme'
import type { AgentColorSource } from './agent-colors'
import type { NotificationPreferences } from './notifications'

export interface DesktopPreferences extends NotificationPreferences {
  visualTheme: VisualTheme
  contrastTheme: ContrastTheme
  agentColorSource: AgentColorSource
  /** True when the user chose a theme; absent means use the detected default. */
  visualThemeExplicit?: boolean
  exitOnClose: boolean
  startAtLogin: boolean
  automaticUpdates: boolean
  routineNotifications: boolean
  onboarded: boolean
}
export interface DesktopNotification {
  id: string; title: string; body: string; org: string; agent?: string; item?: string
  /** The inbox row's source ID; the notification ID is an opaque dedup key. */
  source_id?: string
  generation?: number
  kind: 'question' | 'urgent-mail' | 'terminal-failure' | 'work-attention' | 'routine' | 'document' | 'agent-frozen'
}
export interface NotificationIdentity { id: string; org: string }
export interface ViewTarget { kind: 'organization' | 'agent' | 'docket' | 'documents'; org: string; agent?: string; generation?: number }
export interface WindowLease { key: string; epoch: number; owner: boolean }
export interface DesktopWindowState { visible: boolean; restoreWindows: boolean }
export interface DesktopControlsState extends DesktopWindowState { minimized: boolean; maximized: boolean }
import type { OrgOpenOutcome, OrgWindowIdentity } from './desktop-window'

export interface DesktopEvent { type: 'engine-status' | 'engine-event' | 'preferences' | 'ownership' | 'update' | 'maintenance' | 'notification-click' | 'notification-poll' | 'main-window-shown' | 'window-state' | 'popout-state' | 'open-org' | 'window-identity' | 'restore-skipped' | 'open-orgs'; data: unknown }
/** One popped-out desk or modal window, addressed by the frame name the
 *  renderer opened it under. A popout is frameless like the main window, so its
 *  own header draws the window controls and needs to know whether the window is
 *  maximized - which the user can also change by double-clicking the drag
 *  region, hence an event rather than a value read once. `present` is false
 *  once the window is gone. */
export interface PopoutWindowState {
  name: string; present: boolean; maximized: boolean
  /** WHY it went away, when it did. `parent-teardown` means its organization's
   *  main window closed and took it with it, which is NOT the user closing
   *  that panel — those panels come back when the organization is reopened,
   *  and recording them as deliberately closed is what would stop them. An
   *  absent value reads as `user`. */
  reason?: 'user' | 'parent-teardown'
}
export type UpdateState = 'idle' | 'checking' | 'downloading' | 'pending-idle' | 'up-to-date' | 'unavailable' | 'failed'
/** `recheck` is the outcome of a check that ran WHILE an update was already
 *  prepared and left it in place: the state stays 'pending-idle' because the
 *  installer on disk is still what will run, and this is the only way to answer
 *  the user who just pressed Check for updates. Never set with any other state.
 *  Mirrors apps/desktop/main/updater.ts, which owns the state machine. */
export interface UpdateStatus { state: UpdateState; version?: string; percent?: number; recheck?: 'up-to-date' | 'unavailable' }

/** What this installation can actually DO about an update, as opposed to what
 *  it has been asked to do. `unattendedInstall` is false when Orgtree cannot
 *  write to its own program directory, which makes a silent install impossible:
 *  the bundled installer needs an approval nobody is present to give. An
 *  all-users installation is the usual cause; a read-only volume or a
 *  restrictive ACL is indistinguishable from here, and the consequence is the
 *  same either way. */
export interface UpdateCapability { unattendedInstall: boolean; installDirectory: string }
/** Which provider CLIs an app-driven sign-in exists for (D-231). Native,
 *  not domain/HTTP: the actual child process MUST be spawned by this
 *  (always-interactive) main process, never by the engine, which may be a
 *  boot-host running under a non-interactive Windows S4U session with no
 *  desktop to open a browser into. See apps/desktop/main/providerlogin.ts. */
export type LoginProvider = 'claude' | 'codex' | 'antigravity'
/** One provider login attempt's state. `awaiting_code` only ever appears
 *  for a door that supports one (Claude); Codex's own local redirect
 *  server needs nothing typed anywhere and never reaches that phase.
 *  Antigravity has no scriptable door at all (user-approved UX,
 *  2026-09-09): it opens a visible terminal and resolves immediately with
 *  `ok: null` — never `true`/`false`, since nothing here verifies whether
 *  the user actually signed in. `null` is the renderer's cue to show a
 *  manual Refresh action instead of a pass/fail result. */
export interface ProviderLoginStatus {
  phase: 'idle' | 'starting' | 'awaiting_code' | 'done' | 'error'
  ok: boolean | null
  timedOut: boolean
  output: string
  ageMs: number
  started?: boolean
  error?: string
}
export interface DesktopBridge {
  getAppVersion(): Promise<string>
  installUpdate(): Promise<void>
  getStatus(): Promise<EngineStatus>
  getWindowState(): Promise<DesktopWindowState>
  getWindowControlsState(): Promise<DesktopControlsState>
  getPreferences(): Promise<DesktopPreferences>
  setPreferences(patch: Partial<DesktopPreferences>): Promise<DesktopPreferences>
  /** Updates the in-memory native icon theme; never persists a detected default. */
  setEffectiveTheme(theme: VisualTheme): Promise<void>
  // Domain transport stays relative HTTP/WebSocket; no arbitrary path IPC.
  showMainWindow(): Promise<void>
  quit(): Promise<void>
  minimizeWindow(): Promise<void>
  toggleMaximizeWindow(): Promise<void>
  closeWindow(): Promise<void>
  getHarnesses(): Promise<{ id: 'claude' | 'codex' | 'antigravity'; detected: boolean; url: string }[]>
  notify(notification: DesktopNotification): Promise<boolean>
  /** Close native alerts whose attention item no longer exists. */
  syncNotifications?(active: NotificationIdentity[]): Promise<void>
  /** Everything still waiting on the user, across organizations, as opaque
   *  identities. The taskbar pulses for a new arrival and stops when the list
   *  empties; an unchanged list is not an event. */
  setPendingAttention?(ids: string[], items?: { org: string; id: string }[]): Promise<void>
  openHarnessLink(harness: 'claude' | 'codex' | 'antigravity'): Promise<void>
  openCharterFolder?(): Promise<{ ok: boolean; path?: string; error?: string }>
  /** Reveal an absolute local file in the OS file manager — Explorer opens
   *  with the file SELECTED and nothing is launched. Deliberately not an
   *  "open" (user ruling, 2026-09-13): links come from agent-written markdown,
   *  so an open would be a one-click way to run a program. */
  revealFile?(path: string): Promise<{ ok: boolean; error?: string }>
  getUpdateStatus(): Promise<UpdateStatus>
  getUpdateCapability?(): Promise<UpdateCapability>
  /** Window commands for ONE popped-out desk or modal, named by the frame name
   *  the renderer opened it under. Separate from the window commands above,
   *  which always act on the main window: a popout's own header must never
   *  minimize or close the window it was popped out of. Optional because a
   *  plain browser has no native frame to command. */
  getPopoutState?(name: string): Promise<PopoutWindowState | null>
  minimizePopout?(name: string): Promise<void>
  toggleMaximizePopout?(name: string): Promise<void>
  closePopout?(name: string): Promise<void>
  /** Bring that window back into view — restore it if it is minimized, then
   *  raise and focus it. A renderer CANNOT do this for itself: calling
   *  `focus()` on the child Window it opened leaves a minimized native
   *  window minimized (measured 2026-09-11, which is why "Show desk" on a
   *  popped-out desk's placeholder appeared to do nothing). */
  focusPopout?(name: string): Promise<void>
  checkForUpdates(): Promise<UpdateStatus>
  onEvent(listener: (event: DesktopEvent) => void): () => void
  // --------------------------------------------- v3 multi-window (optional)
  // Optional like every bridge addition since getPopoutState, so a plain
  // browser and the v2 renderer both keep working untouched. See
  // packages/contracts/desktop-window.ts for the types and the rules.
  /** This window's identity, authoritatively. `windowIdentity` below is the
   *  same value resolved before the first paint; prefer that for the initial
   *  render and this for anything that must not be stale. */
  getWindowIdentity?(): Promise<OrgWindowIdentity | null>
  /** A new Homepage window, bound to nothing. */
  openHomepageWindow?(): Promise<OrgWindowIdentity | null>
  /** A new Create window. ALWAYS separate, including from a Homepage. */
  openCreateOrgWindow?(): Promise<OrgWindowIdentity | null>
  /** THE way an organization is opened. The native host has already finished
   *  the whole transaction by the time this resolves: `focused`, `opened` and
   *  `pending` all require nothing further of the caller. */
  requestOrg?(org: string): Promise<OrgOpenOutcome>
  /** A creation succeeded: bind THIS create window to the new organization. */
  bindCreatedOrg?(org: string): Promise<OrgOpenOutcome>
  /** Whether this window holds unfinished creation input, so a close, a quit
   *  or a restart confirms before discarding it. */
  setUnsavedCreation?(dirty: boolean): Promise<void>
  /** Which organizations currently hold a main window, so a Homepage can mark
   *  a row "already open" before it is clicked. The `open-orgs` event carries
   *  the same list whenever it changes. Organizations, not window ids: this
   *  hands out no way to address another window. */
  openOrgs?(): Promise<string[]>
  /** This window's identity, resolved SYNCHRONOUSLY before the bridge was
   *  exposed. Present before the first render, so the shell never paints the
   *  wrong view for a frame; null only where the bridge itself is refused. */
  windowIdentity?: OrgWindowIdentity | null
  // Provider sign-in (D-231): the ONE piece of "domain" surface on this
  // bridge, and deliberately so — see LoginProvider's own comment for why
  // the spawn cannot live on the engine side of the HTTP boundary.
  /** multi-account: `opts.profileDir` runs the SAME sign-in flow against an
   *  account's profile directory (sign-in-as-account); `accountId` makes the
   *  post-login verification read that account's own identity instead of
   *  the ambient provider status. Absent opts = ambient, unchanged. */
  startProviderLogin(provider: LoginProvider,
    opts?: { profileDir?: string; accountId?: string }): Promise<ProviderLoginStatus>
  getProviderLoginStatus(provider: LoginProvider): Promise<ProviderLoginStatus>
  submitProviderLoginCode(provider: LoginProvider, code: string): Promise<ProviderLoginStatus>
  cancelProviderLogin(provider: LoginProvider): Promise<ProviderLoginStatus>
}

export interface ReplyContext {
  org: string
  agent: string
  generation: number
  eventId: string
  quote: string
}
export interface ComposerDraft {
  text: string
  attachments: { id: string; name: string }[]
  replyTo?: ReplyContext
  sequence: number
}
