import { BrowserWindow, shell, type Session } from 'electron'
import { externalHttpUrl, scopedHeaders, trustedUiUrl } from './policy'

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
  // Copy gestures belong to trusted app documents and registered portals only.
  // Clipboard reads and every unrelated permission remain denied.
  const canCopy = (contents: Electron.WebContents | null, permission: string,
    details: { isMainFrame: boolean; requestingUrl?: string }) => {
    if (!contents || permission !== 'clipboard-sanitized-write' || !details.isMainFrame) return false
    const owner = owners.get(contents.id)
    if (!owner || owner.window.isDestroyed()) return false
    const topUrl = contents.mainFrame.url
    return owner.portal
      ? topUrl === 'about:blank' && details.requestingUrl === 'about:blank'
      : trustedUiUrl(topUrl, live(liveOrigin)) && trustedUiUrl(details.requestingUrl ?? '', live(liveOrigin))
  }
  session.setPermissionRequestHandler((contents, permission, callback, details) => callback(canCopy(contents, permission, details)))
  session.setPermissionCheckHandler((contents, permission, _origin, details) => canCopy(contents, permission, details))
  return (window, portal = false) => {
    owners.set(window.webContents.id, { window, portal })
    const id = window.webContents.id
    window.once('closed', () => owners.delete(id))
  }
}

/** Preserve one mounted portal; blank children never boot a second App. */
type OpenExternal = (url: string) => void | Promise<void>

type TrackPopout = (name: string, window: BrowserWindow) => void

/** The narrow slice of a native window the registry below needs, so its rules
 *  can be driven by a test without an Electron window. */
export interface PopoutWindowLike {
  isDestroyed(): boolean
  isMaximized(): boolean
  on(event: 'maximize' | 'unmaximize' | 'minimize' | 'restore', listener: () => void): unknown
  once(event: 'closed', listener: () => void): unknown
}

/** Which native window a popout's window command means.
 *
 *  THE INVARIANT, and the reason this exists: a popout is a frameless window
 *  whose document is an about:blank portal adopted by the main window, so its
 *  React handlers run in the MAIN window's realm and its commands arrive from
 *  the main window's bridge - the only sender the native side accepts. The
 *  command therefore has to name its window, and this turns that name back into
 *  the window. An unknown name, a non-string, or a window that has since gone
 *  resolves to nothing and the command does nothing: where the alternative is
 *  acting on the wrong window, refusing is always right. */
export function popoutRegistry<W extends PopoutWindowLike>(publish: (state: { name: string; present: boolean; maximized: boolean }) => void) {
  const windows = new Map<string, W>()
  const live = (name: unknown): W | undefined => {
    const window = typeof name === 'string' ? windows.get(name) : undefined
    return window && !window.isDestroyed() ? window : undefined
  }
  const state = (name: string) => {
    const window = live(name)
    return { name, present: !!window, maximized: !!window && window.isMaximized() }
  }
  return {
    state,
    window: live,
    track: (name: string, window: W) => {
      // An empty frame name is any window opened as '_blank' - not one of ours,
      // and never addressable.
      if (!name) return
      windows.set(name, window)
      const report = () => { if (!window.isDestroyed()) publish(state(name)) }
      // A double-click on the drag region maximizes too, which no click handler
      // of ours ever sees; hence events rather than a value read once.
      window.on('maximize', report)
      window.on('unmaximize', report)
      window.on('minimize', report)
      window.on('restore', report)
      // Only if it is still THIS window: a later popout may have taken the name
      // back, and dropping its entry would silently disable its controls.
      window.once('closed', () => { if (windows.get(name) === window) windows.delete(name) })
    },
  }
}

export function configureWindow(window: BrowserWindow, liveOrigin: Live, isMain: boolean, register?: (window: BrowserWindow, portal?: boolean) => void, openArtifact?: (url: string) => void, openExternal: OpenExternal = url => shell.openExternal(url), trackPopout?: TrackPopout): void {
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
  const routeExternal = (url: string): boolean => {
    const origin = live(liveOrigin), current = window.webContents.getURL()
    const trustedDocument = trustedUiUrl(current, origin) || (!isMain && current === 'about:blank')
    if (!trustedDocument || trustedUiUrl(url, origin) || artifactUrl(url, origin) || !externalHttpUrl(url)) return false
    try { void Promise.resolve(openExternal(url)).catch(() => {}) } catch { /* browser launch failure must not break the renderer */ }
    return true
  }
  window.webContents.on('will-navigate', (event, url) => {
    if (routeExternal(url)) { event.preventDefault(); return }
    if (!isMain || !trustedUiUrl(url, live(liveOrigin))) event.preventDefault()
  })
  window.webContents.on('will-redirect', (event, url) => {
    if (routeExternal(url)) { event.preventDefault(); return }
    if (!isMain || !trustedUiUrl(url, live(liveOrigin))) event.preventDefault()
  })
  window.webContents.setWindowOpenHandler(({ url }) => {
    const origin = live(liveOrigin)
    if (artifactUrl(url, origin) && (isMain ? trustedUiUrl(window.webContents.getURL(), origin) : window.webContents.getURL() === 'about:blank')) {
      openArtifact?.(url)
      return { action: 'deny' }
    }
    const current = window.webContents.getURL()
    const trustedDocument = trustedUiUrl(current, origin) || (!isMain && current === 'about:blank')
    if (trustedDocument && !trustedUiUrl(url, origin) && !artifactUrl(url, origin) && externalHttpUrl(url)) {
      try { void Promise.resolve(openExternal(url)).catch(() => {}) } catch { /* browser launch failure must not break the renderer */ }
      return { action: 'deny' }
    }
    if (!isMain || !trustedUiUrl(window.webContents.getURL(), origin) || url !== 'about:blank') return { action: 'deny' }
    // Frameless like the main window: the surface's own header is the title
    // bar. That header must therefore carry the drag region — see .popout-mount
    // in styles.css, without which the window cannot be moved at all.
    return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, frame: false,
      webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false } } }
  })
  window.webContents.on('did-create-window', (child, details) => {
    trackPopout?.(details.frameName, child)
    configureWindow(child, liveOrigin, false, register, openArtifact, openExternal, trackPopout)
  })
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
