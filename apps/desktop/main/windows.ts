import { BrowserWindow, type Session } from 'electron'
import { scopedHeaders, trustedUiUrl } from './policy'

/** Origin/token sources may be live getters: after a boot-engine recovery the
 *  desktop re-attaches with a NEW per-boot token (usually the same origin,
 *  since the engine port persists), and the session hooks must sign with the
 *  current credential rather than the one captured at configure time. Plain
 *  strings remain accepted for fixed-lifetime uses and existing probes. */
type Live = string | (() => string)
const live = (value: Live): string => typeof value === 'function' ? value() : value

export function assertNativeSender(event: Electron.IpcMainInvokeEvent, main: BrowserWindow | undefined, origin: string): void {
  if (!main || event.sender !== main.webContents || event.senderFrame !== main.webContents.mainFrame || !trustedUiUrl(event.senderFrame.url, origin)) throw new Error('Native operation refused for this document')
}

export function configureEngineSession(session: Session, liveOrigin: Live, liveToken: Live): (window: BrowserWindow, portal?: boolean) => void {
  const owners = new Map<number, { window: BrowserWindow; portal: boolean }>()
  session.webRequest.onBeforeRequest((details, callback) => {
    // srcdoc is not a network navigation. Foreign frame documents are never app UI.
    callback({ cancel: details.resourceType === 'subFrame' && !details.url.startsWith('about:') })
  })
  session.webRequest.onBeforeSendHeaders((details, callback) => {
    const origin = live(liveOrigin), token = live(liveToken)
    const owner = owners.get(details.webContentsId ?? -1)
    const top = owner && !owner.window.isDestroyed() ? owner.window.webContents.mainFrame : undefined
    const frame = details.frame
    const topRequest = !!top && frame === top
    const initialApp = owner && !owner.portal && details.resourceType === 'mainFrame' && trustedUiUrl(details.url, origin)
    const appRequest = owner && !owner.portal && topRequest && trustedUiUrl(frame!.url, origin)
    // Copied styles/images in a portal need authentication; API fetch runs in the owner App closure.
    const portalAsset = owner?.portal && topRequest && frame!.url === 'about:blank' && ['stylesheet', 'font', 'image'].includes(details.resourceType)
    const permitted = Boolean(initialApp || appRequest || portalAsset)
    callback({ requestHeaders: scopedHeaders(details.requestHeaders, details.url, permitted ? origin : '', token) })
  })
  session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  session.setPermissionCheckHandler(() => false)
  return (window, portal = false) => {
    owners.set(window.webContents.id, { window, portal })
    const id = window.webContents.id
    window.once('closed', () => owners.delete(id))
  }
}

/** Preserve one mounted portal; blank children never boot a second App. */
export function configureWindow(window: BrowserWindow, liveOrigin: Live, isMain: boolean, register?: (window: BrowserWindow, portal?: boolean) => void, openArtifact?: (url: string) => void): void {
  register?.(window, !isMain)
  if (!isMain) {
    // Chromium can leave an adopted about:blank document "hidden" even while
    // its native window is visible. Keep that visible portal's frames running.
    const throttle = () => window.webContents.setBackgroundThrottling(!window.isVisible() || window.isMinimized())
    window.on('show', throttle)
    window.on('hide', throttle)
    window.on('minimize', throttle)
    window.on('restore', throttle)
    throttle()
  }
  window.webContents.on('will-attach-webview', event => event.preventDefault())
  window.webContents.on('will-navigate', (event, url) => { if (!isMain || !trustedUiUrl(url, live(liveOrigin))) event.preventDefault() })
  window.webContents.on('will-redirect', (event, url) => { if (!isMain || !trustedUiUrl(url, live(liveOrigin))) event.preventDefault() })
  window.webContents.setWindowOpenHandler(({ url }) => {
    const origin = live(liveOrigin)
    if (artifactUrl(url, origin) && (isMain ? trustedUiUrl(window.webContents.getURL(), origin) : window.webContents.getURL() === 'about:blank')) {
      openArtifact?.(url)
      return { action: 'deny' }
    }
    if (!isMain || !trustedUiUrl(window.webContents.getURL(), origin) || url !== 'about:blank') return { action: 'deny' }
    return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true,
      webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false } } }
  })
  window.webContents.on('did-create-window', child => configureWindow(child, liveOrigin, false, register, openArtifact))
}

export function artifactUrl(value: string, origin: string): boolean {
  try { const url = new URL(value); return url.origin === origin && !url.username && !url.password && !url.search && /^\/api\/orgs\/[^/]+\/documents\/[^/]+\/mockup$/.test(url.pathname) } catch { return false }
}

/** An artifact gets a separate session and a single read capability, never app auth. */
export function configureArtifactSession(session: Session, artifact: string, origin: string, token: string): void {
  session.webRequest.onBeforeRequest((details, callback) => {
    const engineDestination = (() => { try { return new URL(details.url).host === new URL(origin).host } catch { return false } })()
    const initial = details.resourceType === 'mainFrame' && details.method === 'GET' && details.url === artifact
    callback({ cancel: (engineDestination && !initial) || details.resourceType === 'subFrame' })
  })
  session.webRequest.onBeforeSendHeaders((details, callback) => {
    const initial = details.resourceType === 'mainFrame' && details.method === 'GET' && details.url === artifact
    callback({ requestHeaders: scopedHeaders(details.requestHeaders, details.url, initial ? origin : '', token) })
  })
  session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  session.setPermissionCheckHandler(() => false)
}
