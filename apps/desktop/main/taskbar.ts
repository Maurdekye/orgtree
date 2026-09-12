import type { BrowserWindow } from 'electron'

export function appUserModelId(packaged: boolean): string {
  return packaged ? 'com.maurdekye.orgtree' : 'com.maurdekye.orgtree.dev'
}

export function configureTaskbar(window: BrowserWindow, executable: string, icon: string,
                                 appId = appUserModelId(true), displayName = 'Orgtree'): void {
  window.setAppDetails({
    appId, appIconPath: icon, appIconIndex: 0,
    relaunchCommand: `"${executable}"`, relaunchDisplayName: displayName,
  })
}
