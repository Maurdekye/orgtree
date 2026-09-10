import type { BrowserWindow } from 'electron'

export function configureTaskbar(window: BrowserWindow, executable: string, icon: string): void {
  window.setAppDetails({
    appId: 'com.maurdekye.orgtree', appIconPath: icon, appIconIndex: 0,
    relaunchCommand: `"${executable}"`, relaunchDisplayName: 'Orgtree',
  })
}
