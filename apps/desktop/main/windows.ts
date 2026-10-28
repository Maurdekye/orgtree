import { BrowserWindow, screen, shell, type Session } from 'electron'
import { createServer, type AddressInfo } from 'node:net'
import { attachEditMenu } from './editmenu'
import { externalHttpUrl, hubchatChatUrl, isHoldingUrl, scopedHeaders, trustedUiUrl } from './policy'

/** Origin/token sources may be live getters: after a boot-engine recovery the
 *  desktop re-attaches with a NEW per-boot token (usually the same origin,
 *  since the engine port persists), and the session hooks must sign with the
 *  current credential rather than the one captured at configure time. Plain
 *  strings remain accepted for fixed-lifetime uses and existing probes. */
type Live = string | (() => string)
const live = (value: Live): string => typeof value === 'function' ? value() : value

/** NO NETWORK FOR SANDBOXED AGENT HTML, WEBRTC INCLUDED (measured 2026-10-26,
 *  Electron 44.2.0). CSP connect-src 'none' does not govern WebRTC, and WebRTC
 *  asks no permission: app panel frames, chat HTML replies and the HTML
 *  presentation viewer each reached a host:port of their own choosing through
 *  STUN and ICE over UDP and TURN and ICE over TCP. Chromium 152 ignores a CSP
 *  `webrtc` directive and Electron has no switch that turns WebRTC off, so two
 *  layers close it, and each alone left one transport open:
 *  - every webContents gets the `disable_non_proxied_udp` IP handling policy
 *    (sealWebRtc, from the app-wide web-contents-created hook): no UDP at all,
 *    because no proxy here carries UDP;
 *  - every session that renders agent HTML sends all its traffic to a dead
 *    proxy (sealSessionNetwork, awaited before that session loads anything),
 *    so the TCP that WebRTC must route through the session's proxy never
 *    connects, with no fallback to a direct connection. The dead proxy is a
 *    listener this process holds on 127.0.0.1, at a port the OS picks, that
 *    closes every connection unanswered. A port that is only vacant (it was
 *    127.0.0.1:1, 4.5.0 review B6) can be taken by a local proxy that relays.
 *    `<-loopback>` drops Chromium's implicit loopback bypass, and only the
 *    engine's own current host:port stays direct: a bypass of all of
 *    127.0.0.1 (review B7) let WebRTC reach a local TURN server or relay on
 *    any port. Every sealed session follows the engine's origin: when the
 *    engine is lost nothing stays direct, and once it is back only its new
 *    port does (resealSandboxedSessions, from the Engine's 'origin' event).
 *    An open presentation viewer kept a lost engine's port direct before
 *    (review of 7924322), and a local relay could take that freed port. A
 *    session whose seal fails is shut: main closes everything that renders
 *    in it, and nothing reloads or opens into the sealed sessions until a
 *    seal of it applies (sandboxSealed; review of f6e8a6c).
 *  Orgtree's own renderer talks only to that engine, so its UI is unaffected.
 *  What remains: TCP to the engine's own port, never off the machine. */
export const SANDBOXED_WEBRTC_POLICY = 'disable_non_proxied_udp'
export function sealWebRtc(contents: Pick<Electron.WebContents, 'setWebRTCIPHandlingPolicy'>): void {
  contents.setWebRTCIPHandlingPolicy(SANDBOXED_WEBRTC_POLICY)
}
let deadProxy: Promise<number> | undefined
/** The dead proxy's port. Made on first use, then held for the life of the
 *  process and never closed, so no other program can listen there. A failed
 *  listen fails that seal, and the next seal tries again. */
function deadProxyPort(): Promise<number> {
  deadProxy ??= new Promise<number>((resolve, reject) => {
    const server = createServer(socket => socket.destroy())
    const failed = (error: Error) => { deadProxy = undefined; reject(error) }
    server.once('error', failed)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', failed)
      server.on('error', () => {})
      server.unref()
      resolve((server.address() as AddressInfo).port)
    })
  })
  return deadProxy
}
/** The engine's port, from its origin `http://127.0.0.1:<port>`. Any other
 *  origin names nothing to bypass. */
function enginePort(origin: string): number | undefined {
  const port = Number(/^http:\/\/127\.0\.0\.1:(\d{1,5})$/.exec(origin)?.[1])
  return port >= 1 && port <= 65535 ? port : undefined
}
type Sealable = Pick<Session, 'setProxy'>
/** Every sealed session, with what shuts it, so a change of engine moves all
 *  their direct ports together. */
const sealed = new Map<Sealable, () => void>()
/** Sessions shut because their last seal failed. */
const unsealed = new Set<Sealable>()
let sealing: Promise<void> = Promise.resolve()
/** An update that has not settled by then counts as failed, and its session
 *  is shut; the queue still waits for it. setProxy settles at once in
 *  practice, so this only bounds a hang. */
const SEAL_DEADLINE_MS = 10_000
/** One step of the seal queue: seals `sessions` for `engineOrigin` once the
 *  step before it has finished. A step finishes only when every update it
 *  started has settled, so two steps never update a session at once and the
 *  last seal asked for is the one in force (review of f6e8a6c, F2: with
 *  Promise.all the next step began at the first failure, and a slow update
 *  could land after it). A session whose update fails, or has not settled by
 *  the deadline, is shut at once from its own update, without waiting for
 *  the other sessions' (review of 7cf4a3e), and stays unsealed until a seal
 *  of it applies (F1). */
function sealStep(sessions: Sealable[], engineOrigin: string): Promise<void> {
  const step = sealing.then(async () => {
    let failure: { reason: unknown } | undefined
    const fail = (session: Sealable, reason: unknown) => {
      failure ??= { reason }
      if (!sealed.has(session)) return
      unsealed.add(session)
      try { sealed.get(session)?.() } catch (error) { console.warn('sandbox: could not shut a session whose seal failed:', error) }
    }
    await Promise.allSettled(sessions.map(session => {
      const deadline = setTimeout(() => fail(session, new Error(`sandbox seal not applied within ${SEAL_DEADLINE_MS / 1000} s`)), SEAL_DEADLINE_MS)
      deadline.unref?.()
      return applySeal(session, engineOrigin).then(
        () => { clearTimeout(deadline); unsealed.delete(session) },
        error => { clearTimeout(deadline); fail(session, error) })
    }))
    if (failure) throw failure.reason
  })
  sealing = step.catch(() => {})
  return step
}
async function applySeal(session: Sealable, engineOrigin: string): Promise<void> {
  const port = enginePort(engineOrigin)
  await session.setProxy({ mode: 'fixed_servers', proxyRules: `127.0.0.1:${await deadProxyPort()}`,
    proxyBypassRules: ['<-loopback>', ...port ? [`127.0.0.1:${port}`] : []].join(';') })
}
/** Seals `session` for the engine's origin. `shut` closes everything that
 *  renders in it; it runs whenever a seal of the session fails, this one or
 *  a later one. */
export function sealSessionNetwork(session: Sealable, engineOrigin: string, shut: () => void): Promise<void> {
  sealed.set(session, shut)
  return sealStep([session], engineOrigin)
}
/** The engine's origin changed: '' when it is lost, its new origin once it is
 *  back. Every sealed session, the window session and each open presentation
 *  viewer alike, is sealed again for it. */
export function resealSandboxedSessions(engineOrigin: string): Promise<void> {
  return sealStep([...sealed.keys()], engineOrigin)
}
/** True once every seal asked for so far has applied. False while a session
 *  whose seal failed is still shut: nothing may reload or open into the
 *  sealed sessions then. */
export async function sandboxSealed(): Promise<boolean> {
  await sealing
  return unsealed.size === 0
}
/** A closed presentation viewer's session needs no more seals. */
export function forgetSealedSession(session: Sealable): void {
  sealed.delete(session)
  unsealed.delete(session)
}

export function assertNativeSender(event: Electron.IpcMainInvokeEvent, main: BrowserWindow | undefined, origin: string): void {
  if (!main || event.sender !== main.webContents || event.senderFrame !== main.webContents.mainFrame || (!trustedUiUrl(event.senderFrame.url, origin) && !isHoldingUrl(event.senderFrame.url))) throw new Error('Native operation refused for this document')
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
  /** The window's own content box in screen DIPs, where it can tell. */
  getContentBounds?(): Electron.Rectangle
  on(event: 'maximize' | 'unmaximize' | 'minimize' | 'restore' | 'move' | 'moved' | 'resize' | 'resized', listener: () => void): unknown
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
export function popoutRegistry<W extends PopoutWindowLike>(publish: (state: { name: string; present: boolean; maximized: boolean; bounds?: Electron.Rectangle }) => void) {
  const windows = new Map<string, W>()
  const live = (name: unknown): W | undefined => {
    const window = typeof name === 'string' ? windows.get(name) : undefined
    return window && !window.isDestroyed() ? window : undefined
  }
  const state = (name: string) => {
    const window = live(name)
    const bounds = window?.getContentBounds?.()
    return { name, present: !!window, maximized: !!window && window.isMaximized(), ...(bounds ? { bounds } : {}) }
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
      // ⚠ ITS OWN BOX IS ITS SAVED PLACE (docket
      // 4-5-0-a-saved-pop-out-window-reopens-8-px-off-an). The renderer's
      // screenX/outerWidth include Windows' invisible frame, so a place saved
      // from them reopened 8 px left and 16x8 px larger each time. Published
      // once now, at the end of a move or resize gesture at once, and after any
      // other move or resize (setBounds, snapping, a display change) settles.
      let settle: ReturnType<typeof setTimeout> | undefined
      if (window.getContentBounds) {
        const later = () => { if (settle) clearTimeout(settle); settle = setTimeout(() => { settle = undefined; report() }, 100) }
        window.on('moved', report)
        window.on('resized', report)
        window.on('move', later)
        window.on('resize', later)
        report()
      }
      // Only if it is still THIS window: a later popout may have taken the name
      // back, and dropping its entry would silently disable its controls.
      window.once('closed', () => { if (settle) clearTimeout(settle); if (windows.get(name) === window) windows.delete(name) })
    },
  }
}

/** What "bring this popout to the front" has to do natively.
 *
 *  ORDER IS THE WHOLE CONTENT OF THIS FUNCTION. A MINIMIZED window must be
 *  restored FIRST: `show()` on a minimized window leaves it in the taskbar,
 *  and `focus()` then focuses something the user cannot see. The renderer's own
 *  `child.focus()` does nothing at all here — a renderer cannot restore or
 *  raise the native window it opened (user report 2026-09-11) — so this is the
 *  only path that actually surfaces the window.
 *
 *  Returns whether a window was acted on, so a caller can tell "surfaced it"
 *  from "there was no such window" instead of assuming the first. */
export function revealPopout(window: {
  isMinimized(): boolean; restore(): void; show(): void; focus(): void
} | undefined | null): boolean {
  if (!window) return false
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
  return true
}

export function parsePopoutFeatures(features?: string): { minWidth?: number; minHeight?: number } {
  if (!features || typeof features !== 'string') return {}
  const minWidth = /(?:^|,)\s*minWidth=(\d+)/i.exec(features)?.[1]
  const minHeight = /(?:^|,)\s*minHeight=(\d+)/i.exec(features)?.[1]
  const w = minWidth ? Number(minWidth) : undefined
  const h = minHeight ? Number(minHeight) : undefined
  return {
    ...(w && Number.isFinite(w) && w > 0 ? { minWidth: w } : {}),
    ...(h && Number.isFinite(h) && h > 0 ? { minHeight: h } : {}),
  }
}

/** An explicit desk placement overrides native initial bounds.
 * Windows can add several DIPs to window.open's requested frameless size at
 * fractional DPI. Apply content bounds so invisible frame allowances cannot
 * shrink the visible desk. */
export function exactPopoutBounds(features?: string,
  owner?: Pick<BrowserWindow, 'getContentBounds' | 'webContents'>): Electron.Rectangle | null {
  const values = new Map((features ?? '').split(',').map(part => {
    const [key, value] = part.trim().split('=')
    return [key?.toLowerCase(), value] as const
  }))
  if (values.get('orgtreeexactrect') !== '1') return null
  if (values.has('orgtreeclientx')) {
    if (!owner) return null
    const coords = ['orgtreeclientx', 'orgtreeclienty', 'orgtreeclientwidth', 'orgtreeclientheight']
      .map(key => values.has(key) && values.get(key) !== '' ? Number(values.get(key)) : NaN)
    const [x, y, width, height] = coords
    const zoom = owner.webContents.getZoomFactor()
    if (!coords.every(n => Number.isFinite(n) && Math.abs(n) <= 2147483647)
      || width <= 0 || height <= 0 || !Number.isFinite(zoom) || zoom <= 0) return null
    // Electron uses DIP bounds across displays. CSS pixels must be scaled
    // by browser zoom, not devicePixelRatio (which also includes display DPI).
    const origin = owner.getContentBounds()
    const rect = {x: Math.round(origin.x + x * zoom), y: Math.round(origin.y + y * zoom),
      width: Math.round(width * zoom), height: Math.round(height * zoom)}
    return Object.values(rect).every(n => Number.isSafeInteger(n) && Math.abs(n) <= 2147483647)
      && rect.width > 0 && rect.height > 0 ? rect : null
  }
  const read = (key: string) => {
    const value = values.get(key)
    return value && /^-?\d+$/.test(value) ? Number(value) : NaN
  }
  const rect = {x: read('left'), y: read('top'), width: read('width'), height: read('height')}
  return Object.values(rect).every(value => Number.isSafeInteger(value) && Math.abs(value) <= 2147483647)
    && rect.width > 0 && rect.height > 0 ? rect : null
}

/** A restore's rect is the window's own content box as it reported it (the
 *  popout-state bounds), already in screen DIPs: it goes back as it is, never
 *  through the owner window's display mapping. */
export function nativePopoutRect(features?: string): boolean {
  return (features ?? '').split(',').some(part => part.trim().toLowerCase() === 'orgtreenativerect=1')
}

export function setExactPopoutBounds(window: Pick<BrowserWindow, 'setContentBounds' | 'getContentBounds'>, rect: Electron.Rectangle): void {
  let requested = { ...rect }
  // Windows may add an invisible frame allowance even to setBounds at a
  // fractional scale. Measure that allowance instead of guessing its size.
  // This is only the initial placement; never constrain subsequent gestures.
  for (let attempt = 0; attempt < 3; attempt++) {
    window.setContentBounds(requested)
    const actual = window.getContentBounds()
    if (actual.x === rect.x && actual.y === rect.y && actual.width === rect.width && actual.height === rect.height) return
    requested = { x: requested.x + rect.x - actual.x, y: requested.y + rect.y - actual.y,
      width: Math.max(1, requested.width + rect.width - actual.width),
      height: Math.max(1, requested.height + rect.height - actual.height) }
  }
}

/** An owner can span monitors with different DIP scales. Convert through
 * physical screen pixels when the new window belongs to another display. */
export function popoutDisplayBounds(owner: BrowserWindow, rect: Electron.Rectangle,
  displays: Pick<Electron.Screen, 'dipToScreenRect' | 'screenToDipRect' | 'getDisplayMatching'>): Electron.Rectangle {
  const physical = displays.dipToScreenRect(owner, rect)
  const target = displays.screenToDipRect(null, physical)
  // Avoid another rounding pass on the same display.
  return displays.getDisplayMatching(owner.getContentBounds()).id === displays.getDisplayMatching(target).id
    ? rect : target
}

/** Inline tab launches inherit their box, then fit the matching monitor's
 * work area. Other exact-frame launches keep their established placement. */
export function tabPopoutBounds(features: string, rect: Electron.Rectangle,
  displays: Pick<Electron.Screen, 'getDisplayMatching'>): Electron.Rectangle {
  if (!features.split(',').some(part => part.trim().toLowerCase() === 'orgtreeclampdisplay=1')) return rect
  const area = displays.getDisplayMatching(rect).workArea
  const width = Math.min(rect.width, area.width), height = Math.min(rect.height, area.height)
  return { x: Math.max(area.x, Math.min(rect.x, area.x + area.width - width)),
    y: Math.max(area.y, Math.min(rect.y, area.y + area.height - height)), width, height }
}

const panelsAwake = new WeakMap<BrowserWindow, boolean>()
const throttles = new WeakMap<BrowserWindow, () => void>()
/** Running app panels keep a window's timers unthrottled, also while it is
 *  hidden in the tray or minimized (user 2026-10-26: hidden panels run). */
export function setPanelsAwake(window: BrowserWindow, on: boolean): void {
  panelsAwake.set(window, on)
  if (!window.isDestroyed()) throttles.get(window)?.()
}

export function configureWindow(window: BrowserWindow, liveOrigin: Live, isMain: boolean, register?: (window: BrowserWindow, portal?: boolean) => void, openArtifact?: (url: string) => void, openExternal: OpenExternal = url => shell.openExternal(url), trackPopout?: TrackPopout): void {
  // did-create-window supplies parsed options, not the original feature text.
  // Retain only the named placement accepted by this window's open handler.
  const exactPlacements = new Map<string, Electron.Rectangle>()
  register?.(window, !isMain)
  if (!isMain) {
    // Chromium can leave an adopted about:blank document "hidden" even while
    // its native window is visible. Keep that visible portal's frames running.
    const throttle = () => window.webContents.setBackgroundThrottling(!panelsAwake.get(window) && (!window.isVisible() || window.isMinimized()))
    throttles.set(window, throttle)
    window.on('show', throttle)
    window.on('hide', throttle)
    window.on('minimize', throttle)
    window.on('restore', throttle)
    throttle()
  } else throttles.set(window, () => window.webContents.setBackgroundThrottling(!panelsAwake.get(window)))
  window.webContents.on('will-attach-webview', event => event.preventDefault())
  // Cut/copy/paste in every text field of this window. Registered HERE, and not
  // once for the main window, because this function recurses into every popout
  // through `did-create-window` below — so each popped-out surface gets its own
  // listener on its own webContents, and its menu is popped in the window that
  // was actually clicked in. See main/editmenu.ts.
  attachEditMenu(window)
  const routeExternal = (url: string): boolean => {
    const origin = live(liveOrigin), current = window.webContents.getURL()
    const trustedDocument = trustedUiUrl(current, origin) || (!isMain && current === 'about:blank')
    if (!trustedDocument || trustedUiUrl(url, origin) || artifactUrl(url, origin) || !(externalHttpUrl(url) || hubchatChatUrl(url))) return false
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
  window.webContents.setWindowOpenHandler((details) => {
    const { url } = details
    const origin = live(liveOrigin)
    if (artifactUrl(url, origin) && (isMain ? trustedUiUrl(window.webContents.getURL(), origin) : window.webContents.getURL() === 'about:blank')) {
      openArtifact?.(url)
      return { action: 'deny' }
    }
    const current = window.webContents.getURL()
    const trustedDocument = trustedUiUrl(current, origin) || (!isMain && current === 'about:blank')
    if (trustedDocument && !trustedUiUrl(url, origin) && !artifactUrl(url, origin) && (externalHttpUrl(url) || hubchatChatUrl(url))) {
      try { void Promise.resolve(openExternal(url)).catch(() => {}) } catch { /* browser launch failure must not break the renderer */ }
      return { action: 'deny' }
    }
    if (!isMain || !trustedUiUrl(window.webContents.getURL(), origin) || url !== 'about:blank') return { action: 'deny' }
    // Frameless like the main window: the surface's own header is the title
    // bar. That header must therefore carry the drag region — see .popout-mount
    // in styles.css, without which the window cannot be moved at all.
    const minDims = parsePopoutFeatures(details.features)
    const requested = exactPopoutBounds(details.features, window)
    const mapped = requested && process.platform === 'win32' && screen && !nativePopoutRect(details.features)
      ? popoutDisplayBounds(window, requested, screen) : requested
    const exact = mapped && screen ? tabPopoutBounds(details.features, mapped, screen) : mapped
    if (exact) exactPlacements.set(details.frameName, exact)
    else exactPlacements.delete(details.frameName)
    return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, frame: false,
      webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false },
      ...minDims } }
  })
  window.webContents.on('did-create-window', (child, details) => {
    const exact = exactPlacements.get(details.frameName)
    exactPlacements.delete(details.frameName)
    if (exact) setExactPopoutBounds(child, exact)
    const opts = (details as { options?: { minWidth?: number; minHeight?: number } })?.options
    const minW = opts?.minWidth
    const minH = opts?.minHeight
    if (minW && minH && typeof (child as unknown as { setMinimumSize?: (w: number, h: number) => void }).setMinimumSize === 'function') {
      try { (child as unknown as { setMinimumSize: (w: number, h: number) => void }).setMinimumSize(minW, minH) } catch { /* best effort */ }
    }
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
