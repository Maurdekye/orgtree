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
export interface DesktopPreferences { exitOnClose: boolean; startAtLogin: boolean }
export interface ViewTarget { kind: 'organization' | 'agent' | 'docket' | 'documents'; org: string; agent?: string; generation?: number }
export interface WindowLease { key: string; epoch: number; owner: boolean }
export interface DesktopEvent { type: 'engine-status' | 'engine-event' | 'preferences' | 'ownership'; data: unknown }
export interface DesktopBridge {
  getStatus(): Promise<EngineStatus>
  request(request: EngineRequest): Promise<EngineReply>
  getPreferences(): Promise<DesktopPreferences>
  setPreferences(patch: Partial<DesktopPreferences>): Promise<DesktopPreferences>
  openView(target: ViewTarget): Promise<WindowLease>
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
