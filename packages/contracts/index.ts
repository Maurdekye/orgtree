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

export interface DesktopPreferences {
  visualTheme: VisualTheme
  /** True when the user chose a theme; absent means use the detected default. */
  visualThemeExplicit?: boolean
  exitOnClose: boolean
  startAtLogin: boolean
  routineNotifications: boolean
  onboarded: boolean
}
export interface DesktopNotification {
  id: string; title: string; body: string; org: string; agent?: string; item?: string
  kind: 'question' | 'urgent-mail' | 'work-attention' | 'routine'
}
export interface ViewTarget { kind: 'organization' | 'agent' | 'docket' | 'documents'; org: string; agent?: string; generation?: number }
export interface WindowLease { key: string; epoch: number; owner: boolean }
export interface DesktopWindowState { visible: boolean; restoreWindows: boolean }
export interface DesktopControlsState extends DesktopWindowState { minimized: boolean; maximized: boolean }
export interface DesktopEvent { type: 'engine-status' | 'engine-event' | 'preferences' | 'ownership' | 'update' | 'maintenance' | 'notification-click' | 'main-window-shown' | 'window-state' | 'open-org'; data: unknown }
export type UpdateState = 'idle' | 'checking' | 'downloading' | 'pending-idle' | 'up-to-date' | 'unavailable' | 'failed'
export interface UpdateStatus { state: UpdateState; version?: string; percent?: number }
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
  openHarnessLink(harness: 'claude' | 'codex' | 'antigravity'): Promise<void>
  getUpdateStatus(): Promise<UpdateStatus>
  checkForUpdates(): Promise<UpdateStatus>
  onEvent(listener: (event: DesktopEvent) => void): () => void
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
