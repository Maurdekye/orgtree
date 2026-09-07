import type { DesktopBridge, DesktopPreferences } from '../../../../packages/contracts'

export interface NativeNotice {
  id: string; title: string; body: string; org: string; agent?: string; item?: string
  kind: 'question' | 'urgent-mail' | 'work-attention' | 'routine'
}
export type NativePreferences = DesktopPreferences & { routineNotifications?: boolean }
// The bridge belongs to the authoritative opener. React handlers retain this
// module's window when their existing DOM is adopted by an isolated popout.
export type NativeDesktop = Omit<DesktopBridge, 'getPreferences' | 'setPreferences'> & {
  getPreferences(): Promise<NativePreferences>
  setPreferences(patch: Partial<NativePreferences>): Promise<NativePreferences>
  notify?(notice: NativeNotice): Promise<boolean>
  getWindowState?(): Promise<{ visible: boolean; restoreWindows: boolean }>
}
export const desktop = (): NativeDesktop | undefined =>
  (window as Window & { orgtreeDesktop?: NativeDesktop }).orgtreeDesktop
