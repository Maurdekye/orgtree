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
export interface DesktopPreferences { exitOnClose: boolean; startAtLogin: boolean; routineNotifications: boolean }
export interface DesktopNotification {
  id: string; title: string; body: string; org: string; agent?: string; item?: string
  kind: 'question' | 'urgent-mail' | 'work-attention' | 'routine'
}
export interface ViewTarget { kind: 'organization' | 'agent' | 'docket' | 'documents'; org: string; agent?: string; generation?: number }
export interface WindowLease { key: string; epoch: number; owner: boolean }
export interface DesktopEvent { type: 'engine-status' | 'engine-event' | 'preferences' | 'ownership' | 'update' | 'notification-click' | 'main-window-shown'; data: unknown }
export interface DesktopBridge {
  getStatus(): Promise<EngineStatus>
  getWindowState(): Promise<{ visible: boolean; restoreWindows: boolean }>
  getPreferences(): Promise<DesktopPreferences>
  setPreferences(patch: Partial<DesktopPreferences>): Promise<DesktopPreferences>
  // Domain transport stays relative HTTP/WebSocket; no arbitrary path IPC.
  showMainWindow(): Promise<void>
  quit(): Promise<void>
  getHarnesses(): Promise<{ id: 'claude' | 'codex' | 'antigravity'; detected: boolean; url: string }[]>
  notify(notification: DesktopNotification): Promise<boolean>
  openHarnessLink(harness: 'claude' | 'codex' | 'antigravity'): Promise<void>
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
