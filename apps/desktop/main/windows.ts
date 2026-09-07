import { BrowserWindow, type Session } from 'electron'
import { scopedHeaders, trustedUiUrl } from './policy'

export function assertNativeSender(event: Electron.IpcMainInvokeEvent, main: BrowserWindow | undefined, origin: string): void {
  if (!main || event.sender !== main.webContents || event.senderFrame !== main.webContents.mainFrame || !trustedUiUrl(event.senderFrame.url, origin)) throw new Error('Native operation refused for this document')
}

export function configureEngineSession(session: Session, origin: string, token: string): void {
  // ALL destinations: strip any retained header before selective injection.
  session.webRequest.onBeforeSendHeaders((details, callback) => callback({ requestHeaders: scopedHeaders(details.requestHeaders, details.url, origin, token) }))
  session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  session.setPermissionCheckHandler(() => false)
}

/** Preserve one mounted portal; blank children never boot a second App. */
export function configureWindow(window: BrowserWindow, origin: string, isMain: boolean): void {
  window.webContents.on('will-attach-webview', event => event.preventDefault())
  window.webContents.on('will-navigate', (event, url) => { if (!isMain || !trustedUiUrl(url, origin)) event.preventDefault() })
  window.webContents.on('will-redirect', (event, url) => { if (!isMain || !trustedUiUrl(url, origin)) event.preventDefault() })
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (!isMain || !trustedUiUrl(window.webContents.getURL(), origin) || url !== 'about:blank') return { action: 'deny' }
    return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true,
      webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false } } }
  })
  window.webContents.on('did-create-window', child => configureWindow(child, origin, false))
}
