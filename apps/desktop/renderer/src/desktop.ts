import type { DesktopBridge, DesktopControlsState, DesktopNotification, DesktopPreferences, DesktopWindowState } from '../../../../packages/contracts'

export type NativeNotice = DesktopNotification
export type NativePreferences = DesktopPreferences & { routineNotifications?: boolean }
// The bridge belongs to the authoritative opener. React handlers retain this
// module's window when their existing DOM is adopted by an isolated popout.
export type NativeDesktop = Omit<DesktopBridge, 'getPreferences' | 'setPreferences'> & {
  getPreferences(): Promise<NativePreferences>
  setPreferences(patch: Partial<NativePreferences>): Promise<NativePreferences>
  notify?(notice: NativeNotice): Promise<boolean>
  getWindowState?(): Promise<DesktopWindowState>
  getWindowControlsState?(): Promise<DesktopControlsState>
}
export const desktop = (): NativeDesktop | undefined =>
  (window as Window & { orgtreeDesktop?: NativeDesktop }).orgtreeDesktop
