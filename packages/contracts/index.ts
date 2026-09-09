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
export interface DesktopEvent { type: 'engine-status' | 'engine-event' | 'preferences' | 'ownership' | 'update' | 'notification-click' | 'main-window-shown' | 'window-state'; data: unknown }
export type UpdateState = 'idle' | 'checking' | 'downloading' | 'pending-idle' | 'up-to-date' | 'unavailable' | 'failed'
export interface UpdateStatus { state: UpdateState; version?: string; percent?: number }
export interface DesktopBridge {
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
