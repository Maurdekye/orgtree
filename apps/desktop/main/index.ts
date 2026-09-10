import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, powerMonitor, screen, session, shell, Tray } from 'electron'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { autoUpdater } from 'electron-updater'
import { Engine, ENGINE_REFUSED, type RuntimeStats } from './engine'
import { Preferences } from './preferences'
import { closeAction, HARNESS_LINKS, validateDataRoot } from './policy'
import { assertNativeSender, configureArtifactSession, configureEngineSession, configureWindow } from './windows'
import { detectHarnesses } from './harnesses'
import { NotificationGate } from './notifications'
import { MaintenanceController } from './maintenance'
import { checkForUpdatesViaEvents, UpdateController } from './updater'
import type { DesktopEvent, LoginProvider } from '../../../packages/contracts/index'
import { isVisualTheme, isCustomTheme } from '../../../packages/contracts/visual-theme'
import { cancelProviderLogin, getProviderLoginStatus, startProviderLogin, submitProviderLoginCode } from './providerlogin'
import { popupBounds, trayListHtml, trayNavigationSlug } from './traylist'
import type { VisualTheme, PresetVisualTheme } from '../../../packages/contracts/visual-theme'

app.setName('Orgtree v2')
app.setAppUserModelId('com.maurdekye.orgtree')
// Isolated development/test profiles never touch the operator's installed data.
if (!app.isPackaged && process.env.ORGTREE_V2_PROFILE) app.setPath('userData', validateDataRoot(process.env.ORGTREE_V2_PROFILE, path.join(os.homedir(), 'orgtree')))
const single = app.requestSingleInstanceLock()
if (!single) app.quit()
else {
  let main: BrowserWindow | undefined, tray: Tray | undefined, preferences: Preferences
  let quitting = false, quitComplete = false, downloaded = false, updateApplying = false
  let stats: RuntimeStats | null = null, poll: NodeJS.Timeout | undefined
  // The renderer owns provider discovery. This ephemeral value mirrors its
  // effective theme for native tray/taskbar/window icons and is never persisted.
  let effectiveTheme: VisualTheme | undefined
  let restoreWindows = !process.argv.includes('--background')
  const windowState = () => ({
    visible: !!main && !main.isDestroyed() && main.isVisible(),
    restoreWindows,
  })
  const windowControlsState = () => ({
    ...windowState(),
    minimized: !!main && !main.isDestroyed() && main.isMinimized(),
    maximized: !!main && !main.isDestroyed() && main.isMaximized(),
  })
  const engine = new Engine()
  // Native image readers and Windows shell integration cannot reliably read
  // files inside app.asar. Packaged runtime icons are unpacked by the build;
  // development keeps the source-tree path.
  const assetsPath = app.isPackaged
    ? path.join(process.resourcesPath, 'runtime-icons')
    : path.join(app.getAppPath(), 'apps/desktop/assets')
  const iconPath = path.join(assetsPath, 'orgtree-eye.ico')
  const trayIconNames: Record<PresetVisualTheme | 'grey', string> = {
    grey: 'orgtree-eye-tray-grey.ico', orgtree: 'orgtree-eye-tray-orgtree.ico',
    claude: 'orgtree-eye-tray-claude.ico', codex: 'orgtree-eye-tray-codex.ico',
    antigravity: 'orgtree-eye-tray-antigravity.ico', openrouter: 'orgtree-eye-tray-openrouter.ico',
  }
  const runtimeIcon = () => {
    const current = preferences?.get() as { visualTheme?: VisualTheme; visualThemeExplicit?: boolean } | undefined
    // A neutral/unset preference follows the renderer's resolved provider.
    // Older alpha settings with a non-neutral value remain explicit.
    const explicit = current?.visualTheme &&
      (current.visualTheme !== 'orgtree' || current.visualThemeExplicit === true)
      ? current.visualTheme : undefined
    const theme = effectiveTheme ?? explicit ?? 'claude'
    const name = engine.status.state === 'ready' ? trayIconNames[isCustomTheme(theme) ? 'orgtree' : theme] : trayIconNames.grey
    const image = nativeImage.createFromPath(path.join(assetsPath, name))
    if (engine.status.state === 'ready' && isCustomTheme(theme) && !image.isEmpty()) {
      const bitmap = image.toBitmap(), size = image.getSize()
      const color = theme.slice(7), rgb = [1,3,5].map(i => parseInt(color.slice(i,i+2),16))
      // Electron bitmap bytes are BGRA. Keep the eye silhouette's alpha.
      for (let i=0;i<bitmap.length;i+=4) { bitmap[i]=rgb[2]!; bitmap[i+1]=rgb[1]!; bitmap[i+2]=rgb[0]! }
      return nativeImage.createFromBitmap(bitmap,size)
    }
    return image.isEmpty() ? nativeImage.createFromPath(iconPath) : image
  }
  const notifications = new NotificationGate()
  const show = () => { if (main && !main.isDestroyed()) { restoreWindows = true; main.show(); main.restore(); main.focus(); broadcast({ type: 'main-window-shown', data: windowState() }) } }
  const broadcast = (event: DesktopEvent) => { if (main && !main.isDestroyed()) main.webContents.send('desktop:event', event) }
  const publishWindowState = () => broadcast({ type: 'window-state', data: windowControlsState() })
  // n/m active/hired (user spec 2026-09-10) — the same two counts every org
  // row shows, summed: totalAgents is currently HIRED agents (launch.py).
  const label = () => stats ? `${stats.activeAgents} active / ${stats.totalAgents} hired` : `Engine ${engine.status.state}`
  // ------------------------------------------------------- tray org list
  // Primary click on the tray icon (user spec 2026-09-10): a popup listing
  // every organization as aligned spinner/name/n-m columns; selecting a row
  // opens that org in the main window (whose renderer then restores the
  // org's own saved pins, popouts and camera). Content and geometry are
  // pure functions in traylist.ts; this block owns only the window.
  let trayPopup: BrowserWindow | undefined
  let trayPopupSeq = 0
  const closeTrayPopup = () => {
    const popup = trayPopup
    trayPopup = undefined
    if (popup && !popup.isDestroyed()) popup.destroy()
  }
  const openOrgFromTray = (slug: string) => { closeTrayPopup(); show(); broadcast({ type: 'open-org', data: { org: slug } }) }
  const showTrayList = async (anchor: Electron.Rectangle) => {
    const seq = ++trayPopupSeq
    // fetched per click, not cached from the poll: the list must say what is
    // active NOW, and a click is rare enough to afford the fresh read
    const rows = await engine.orgActivity()
    if (seq !== trayPopupSeq || quitting) return   // a newer click or quit superseded this fetch
    closeTrayPopup()
    // Windows hands the icon rect on click; an empty rect falls back to the
    // cursor so the popup still lands on the right display
    const point = anchor.width > 0 ? { x: anchor.x + Math.round(anchor.width / 2), y: anchor.y } : screen.getCursorScreenPoint()
    const area = screen.getDisplayNearestPoint(point).workArea
    const bounds = popupBounds(anchor.width > 0 ? anchor : { ...point, width: 0, height: 0 }, area, rows?.length ?? 1)
    // no preload, no node, sandboxed, scriptless document (CSP: no sources):
    // the popup is a picture of a list — selection is a CANCELLED navigation
    // to a reserved .invalid origin, so it never gains any other capability
    const popup = new BrowserWindow({ ...bounds, frame: false, show: false, resizable: false, movable: false,
      minimizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true, alwaysOnTop: true, autoHideMenuBar: true,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false } })
    const followSelection = (url: string) => {
      const slug = trayNavigationSlug(url)
      if (slug) openOrgFromTray(slug)
    }
    popup.webContents.setWindowOpenHandler(({ url }) => { followSelection(url); return { action: 'deny' } })
    popup.webContents.on('will-navigate', (event, url) => { event.preventDefault(); followSelection(url) })
    // identity-guarded: a superseded popup's late blur must not close its successor
    popup.on('blur', () => { if (trayPopup === popup) closeTrayPopup() })
    trayPopup = popup
    try { await popup.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(trayListHtml(rows))) }
    catch { if (trayPopup === popup) closeTrayPopup(); return }
    if (trayPopup !== popup || popup.isDestroyed()) return
    popup.show()
  }
  const loginPreference = () => {
    // Never register the development electron.exe as a login application.
    if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: preferences.get().startAtLogin, path: process.execPath, args: ['--background'] })
  }
  const setPreferences = (patch: unknown) => {
    // Renderer theme resolution is authoritative; discard the previous
    // ephemeral value so a newly explicit choice is reflected immediately.
    effectiveTheme = undefined
    const next = preferences.set(patch); loginPreference(); rebuildTray()
    broadcast({ type: 'preferences', data: next }); return next
  }
  const setEffectiveTheme = (value: unknown) => {
    if (!isVisualTheme(value)) throw new Error('Unknown visual theme')
    effectiveTheme = value
    rebuildTray()
  }
  const rebuildTray = () => {
    const image = runtimeIcon()
    tray?.setImage(image)
    for (const window of BrowserWindow.getAllWindows()) window.setIcon(image)
    if (!tray) return
    const prefs = preferences.get()
    tray.setToolTip(`Orgtree - ${label()}`)
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Check for updates', click: () => { void updater.check().catch(() => {}) } },
      { label: 'Start at login', type: 'checkbox', checked: prefs.startAtLogin, click: item => setPreferences({ startAtLogin: item.checked }) },
      { label: 'Exit on close', type: 'checkbox', checked: prefs.exitOnClose, click: item => setPreferences({ exitOnClose: item.checked }) },
      { label: 'Routine mail and completion notifications', type: 'checkbox', checked: prefs.routineNotifications, click: item => setPreferences({ routineNotifications: item.checked }) },
      { label: 'Harness setup', submenu: detectHarnesses().map(h => ({ label: `${h.id}: ${h.detected ? 'detected' : 'not detected'} - official setup`, click: () => { void shell.openExternal(h.url) } })) },
      { type: 'separator' }, { label: 'Quit Orgtree', click: () => app.quit() },
    ]))
  }
  const handle = (channel: string, handler: (...args: unknown[]) => unknown) => ipcMain.handle(channel, (event, ...args: unknown[]) => { assertNativeSender(event, main, engine.origin); return handler(...args) })
  const saveWindowLayout = async () => {
    if (main && !main.isDestroyed()) {
      try { await main.webContents.executeJavaScript('window.dispatchEvent(new Event("orgtree:before-exit"))') } catch { /* Crashed renderer cannot save layout. */ }
    }
  }
  const quitAfterLastView = () => {
    if (!quitting && preferences.get().exitOnClose && BrowserWindow.getAllWindows().every(w => !w.isVisible())) app.quit()
  }
  const applyDownloadedUpdate = async () => {
    if (updateApplying || quitting) return
    // A boot-host engine is stopped gracefully through its authenticated
    // shutdown route before its files are replaced; the installer restarts
    // the task afterwards. A stop that cannot be VERIFIED throws here, with
    // no state disturbed — a maintenance request then lands in its designed
    // failure report, and the idle auto-path simply retries later — because
    // installing over a live engine is never acceptable.
    if (!engine.managed) await engine.stopAttachedForUpdate()
    if (updateApplying || quitting) return
    updateApplying = true; quitting = true
    if (poll) clearInterval(poll)
    await saveWindowLayout(); await engine.stop(); quitComplete = true
    setTimeout(() => app.exit(1), 15000).unref()
    autoUpdater.quitAndInstall(false, true)
  }
  const maintenance = new MaintenanceController({
    ack: (id, outcome) => engine.acknowledgeMaintenance(id, outcome),
    failure: id => engine.reportMaintenanceFailure(id),
    restart: async () => {
      if (quitting) return
      // Electron's relaunch helper is outside the Python Job, as is the updater.
      app.relaunch(); app.quit()
    },
    apply: applyDownloadedUpdate,
    check: async () => {
      if (!app.isPackaged) return 'unavailable'
      try {
        const result = await autoUpdater.checkForUpdates()
        if (!result) return 'unavailable'
        if (result.downloadPromise) {
          void result.downloadPromise.catch(() => broadcast({ type: 'maintenance', data: { state: 'unavailable' } }))
          return 'pending'
        }
        return result.updateInfo.version === app.getVersion() ? 'up-to-date' : 'unavailable'
      } catch { return 'unavailable' }
    },
    report: state => {
      // Distinct from UpdateController's own 'update' channel below: this is the
      // engine-issued maintenance flow (restart/update-on-request), a separate
      // state vocabulary ('pending', 'failure-record-unavailable', ...) that a
      // renderer listening for UpdateStatus must never be handed.
      broadcast({ type: 'maintenance', data: { state } })
      if (state === 'failed' || state === 'failure-record-unavailable') {
        void dialog.showMessageBox({ type: 'error', message: 'Orgtree maintenance did not complete.',
          detail: state === 'failed' ? 'The request failed and will not be executed again automatically. Automatic update application is paused until a new update request. Reopen Orgtree if its engine stopped.'
            : 'The maintenance failure could not be saved. Check the application data folder before requesting another restart or update.' }).catch(() => {})
      }
    },
  }, path.join(app.getPath('userData'), 'maintenance-failures.json'))
  // Independent of the engine-driven maintenance flow above: this is the
  // plain "is a newer release available" question, checked on its own
  // schedule and surfaced directly to the header/Settings - not gated on
  // any engine-issued request.
  const updater = new UpdateController({
    // electron-updater's own update-available/update-not-available events are the
    // authoritative "is this actually newer" answer (channel/prerelease/downgrade
    // rules included) - comparing version strings here would get an older or
    // disallowed release wrong by treating any difference as an update.
    run: () => app.isPackaged ? checkForUpdatesViaEvents(autoUpdater) : Promise.resolve({ hasUpdate: false }),
    report: status => broadcast({ type: 'update', data: status }),
  })
  // Explicit Quit/update already persisted layout and requests engine shutdown.
  // Renderer draft guards must not strand a window after its engine has stopped.
  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-prevent-unload', event => { if (quitting) event.preventDefault() })
  })
  app.on('second-instance', show)
  app.on('activate', show)
  app.on('window-all-closed', () => { /* Tray/main remain alive by default. */ })
  app.on('before-quit', event => {
    if (quitComplete) return
    event.preventDefault()
    if (quitting) return
    quitting = true
    if (poll) clearInterval(poll)
    trayPopupSeq++; closeTrayPopup()
    // ⚠ a login left running when the app quits must not become an orphan
    // (coordinator review): Claude/Codex spawn a REAL child process via
    // providerlogin.ts, and neither engine.stop() below nor Electron's own
    // teardown touches it. Antigravity is deliberately excluded — its
    // terminal is a detached, user-owned window by design (see
    // launchAntigravityTerminal's docstring) and must outlive the app.
    cancelProviderLogin('claude', true)
    cancelProviderLogin('codex', true)
    void saveWindowLayout().then(() => engine.stop()).finally(() => { quitComplete = true; tray?.destroy(); app.quit() })
  })
  app.whenReady().then(async () => {
    preferences = new Preferences(path.join(app.getPath('userData'), 'desktop-settings.json'))
    loginPreference()
    tray = new Tray(runtimeIcon())
    // primary click = the org activity list; double-click keeps opening the
    // app itself (second click of the pair dismisses the just-shown popup)
    tray.on('click', (_event, iconBounds) => { void showTrayList(iconBounds) })
    tray.on('double-click', () => {
      trayPopupSeq++; closeTrayPopup()
      // A hidden main window is retained in the tray; visible popouts count too.
      if (!BrowserWindow.getAllWindows().some(w => !w.isDestroyed() && w.isVisible())) show()
    })
    rebuildTray()
    handle('desktop:status', () => engine.status)
    handle('desktop:window-state', () => windowState())
    handle('desktop:window-controls-state', () => windowControlsState())
    handle('desktop:window-minimize', () => { main?.minimize() })
    handle('desktop:window-toggle-maximize', () => {
      if (!main) return
      if (main.isMaximized()) main.unmaximize(); else main.maximize()
    })
    handle('desktop:window-close', () => { main?.close() })
    handle('desktop:preferences', () => preferences.get())
    handle('desktop:set-preferences', value => setPreferences(value))
    handle('desktop:set-effective-theme', value => setEffectiveTheme(value))
    handle('desktop:show', () => show())
    handle('desktop:quit', () => { app.quit() })
    handle('desktop:harnesses', () => detectHarnesses())
    handle('desktop:notify', value => {
      if (!Notification.isSupported()) return false
      const data = notifications.take(value, preferences.get().routineNotifications)
      if (!data) return false
      const notice = new Notification({ title: data.title, body: data.body })
      notice.on('click', () => { show(); broadcast({ type: 'notification-click', data }) })
      notice.show()
      return true
    })
    handle('desktop:open-harness', id => {
      if (typeof id !== 'string' || !Object.hasOwn(HARNESS_LINKS, id)) throw new Error('Unknown harness')
      return shell.openExternal(HARNESS_LINKS[id as keyof typeof HARNESS_LINKS])
    })
    handle('desktop:update-status', () => updater.current())
    handle('desktop:check-for-updates', () => updater.check())
    // Provider sign-in (D-231): the child spawn lives ONLY in this process —
    // see providerlogin.ts's module docstring for why. `assertNativeSender`
    // (via `handle` above) already keeps this off any surface but the app's
    // own authoritative renderer, same as every other native control here.
    const asLoginProvider = (value: unknown): LoginProvider => {
      if (value !== 'claude' && value !== 'codex') throw new Error('Unknown login provider')
      return value
    }
    handle('desktop:provider-login-start', (provider, opts) => {
      // multi-account: the optional {profileDir, accountId} pair rides to
      // the login spawn; only these two string fields pass, nothing else
      const o = (opts && typeof opts === 'object') ? opts as Record<string, unknown> : {}
      return startProviderLogin(engine.origin, engine.token, asLoginProvider(provider), {
        profileDir: typeof o.profileDir === 'string' ? o.profileDir : undefined,
        accountId: typeof o.accountId === 'string' ? o.accountId : undefined,
      })
    })
    handle('desktop:provider-login-status', provider => getProviderLoginStatus(asLoginProvider(provider)))
    handle('desktop:provider-login-code', (provider, code) => {
      if (typeof code !== 'string') throw new Error('code must be a string')
      return submitProviderLoginCode(asLoginProvider(provider), code)
    })
    handle('desktop:provider-login-cancel', provider => cancelProviderLogin(asLoginProvider(provider)))
    engine.on('status', status => { broadcast({ type: 'engine-status', data: status }); stats = null; rebuildTray() })
    const base = app.isPackaged ? process.resourcesPath : app.getAppPath()
    const directory = path.join(base, 'engine')
    try {
      const engineOptions = { directory,
        python: app.isPackaged ? path.join(directory, 'runtime', 'python.exe') : process.env.ORGTREE_V2_PYTHON ?? '',
        dataRoot: process.env.ORGTREE_V2_DATA ?? path.join(app.getPath('userData'), 'data'),
        forbiddenRoot: process.env.ORGTREE_DATA || path.join(os.homedir(), 'orgtree'),
        uiDirectory: app.isPackaged ? path.join(process.resourcesPath, 'ui') : path.join(app.getAppPath(), 'dist', 'renderer') }
      // A boot-host engine (operator's scheduled task) publishes a verified
      // attach descriptor; adopt it instead of racing it for the root lock.
      if (!await engine.attach(engineOptions)) {
        if (engine.attachDiagnostic) console.warn(`boot-engine descriptor rejected: ${engine.attachDiagnostic}`)
        try { await engine.start(engineOptions) }
        catch (error) {
          // A structured refusal means another owner holds this root — the
          // boot host mid-startup, whose descriptor appears when it becomes
          // ready. Retry attaching instead of showing the fatal dialog.
          if (!(error instanceof Error) || !error.message.startsWith(ENGINE_REFUSED)) throw error
          if (!await engine.attachWithRetry(engineOptions)) {
            // The root is owned AND no descriptor verified for the whole
            // budget: the reason it was declined is the actual diagnosis
            // (an unverifiable owner, a stale port), not the lock refusal.
            if (engine.attachDiagnostic) throw new Error(`${error.message}\nBoot engine descriptor rejected: ${engine.attachDiagnostic}`)
            throw error
          }
        }
      }
      const browserSession = session.fromPartition('persist:orgtree-v2')
      // The preload origin is fixed per window; session signing reads LIVE
      // engine values so a recovered attachment's new token keeps working.
      const initialOrigin = engine.origin
      const register = configureEngineSession(browserSession, () => engine.origin, () => engine.token)
      const openArtifact = (url: string) => {
        const artifactSession = session.fromPartition(`artifact-${randomUUID()}`)
        configureArtifactSession(artifactSession, url, engine.origin, engine.token)
        // Artifact viewers do not receive the app bridge or renderer chrome;
        // retain the native title bar for this read-only auxiliary window.
        const viewer = new BrowserWindow({ width: 1000, height: 760, icon: iconPath, autoHideMenuBar: true,
          webPreferences: { session: artifactSession, sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false } })
        viewer.setIcon(runtimeIcon())
        viewer.on('closed', quitAfterLastView)
        viewer.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
        viewer.webContents.on('will-navigate', event => event.preventDefault())
        viewer.webContents.on('will-redirect', event => event.preventDefault())
        void viewer.loadURL(url).catch(() => viewer.destroy())
      }
      main = new BrowserWindow({ width: 1400, height: 900, minWidth: 640, minHeight: 480, frame: false, show: false, icon: iconPath, autoHideMenuBar: true,
        webPreferences: { session: browserSession, preload: path.join(__dirname, '../preload/index.cjs'), contextIsolation: true,
          sandbox: true, nodeIntegration: false, webviewTag: false, additionalArguments: [`--orgtree-ui-origin=${initialOrigin}`] } })
      main.setIcon(runtimeIcon())
      main.on('maximize', publishWindowState)
      main.on('unmaximize', publishWindowState)
      main.on('minimize', publishWindowState)
      main.on('restore', publishWindowState)
      main.on('show', publishWindowState)
      main.on('hide', publishWindowState)
      configureWindow(main, () => engine.origin, true, register, openArtifact)
      main.webContents.on('did-create-window', child => {
        child.setIcon(runtimeIcon())
        child.on('closed', quitAfterLastView)
      })
      main.on('close', event => {
        const otherViews = BrowserWindow.getAllWindows().filter(w => w !== main && w.isVisible()).length
        const action = closeAction(preferences.get().exitOnClose, quitting, otherViews)
        if (action !== 'close') { event.preventDefault(); if (action === 'hide') main?.hide(); else app.quit() }
      })
      main.webContents.on('render-process-gone', () => { void dialog.showMessageBox({ type: 'error', message: 'The Orgtree window stopped responding.', detail: 'The engine is still running. Restart Orgtree to restore the interface.' }) })
      await main.loadURL(engine.origin + '/')
      if (!process.argv.includes('--background')) show()
      if (!process.argv.includes('--background') && !detectHarnesses().some(h => h.detected)) await dialog.showMessageBox(main, { type: 'info', message: 'No agent harness was detected.', detail: 'Install Claude Code, Codex, or Antigravity using the official setup links in the tray menu. Orgtree does not install or sign in to harnesses.' })
      const refresh = async () => {
        if (quitting) return
        stats = await engine.stats(); rebuildTray()
        void updater.tick().catch(() => {})
        if (stats === null && !engine.managed) {
          await engine.verifyAttached()
          if (!engine.managed && engine.status.state === 'stopped' && !quitting) {
            const outcome = await engine.recoverAttached(engineOptions)
            if (outcome !== 'failed') {
              // Same origin (the engine port persists): the live session
              // getters already sign with the new token; reload the app so
              // the renderer re-establishes its streams. A CHANGED origin
              // needs the preload origin rebuilt — relaunch cleanly.
              if (engine.origin === initialOrigin) main?.webContents.reload()
              else { await saveWindowLayout(); app.relaunch(); app.quit() }
            }
            return
          }
        }
        if (stats?.maintenance || maintenance.hasFailures()) {
          await maintenance.tick(stats, powerMonitor.getSystemIdleTime(), downloaded)
          return
        }
        if (downloaded && stats?.idle && powerMonitor.getSystemIdleTime() >= 60 && !updateApplying && maintenance.automaticUpdatesAllowed()) {
          // An unverifiable attached-engine stop throws with state untouched;
          // the next idle sample simply tries again.
          await applyDownloadedUpdate().catch(() => {})
        }
      }
      let refreshing = false
      poll = setInterval(() => { if (refreshing) return; refreshing = true; void refresh().finally(() => { refreshing = false }) }, 5000)
      void refresh()
      if (app.isPackaged) {
        autoUpdater.autoInstallOnAppQuit = false
        autoUpdater.allowPrerelease = true
        autoUpdater.on('error', () => updater.errored())
        autoUpdater.on('update-downloaded', () => { downloaded = true; updater.downloaded() })
        autoUpdater.on('download-progress', progress => updater.progress(Math.round(progress.percent)))
      }
    } catch (error) {
      await dialog.showMessageBox({ type: 'error', message: 'Orgtree could not start its engine.', detail: error instanceof Error ? error.message : 'Unknown startup error' })
      app.quit()
    }
  }).catch(() => app.quit())
}
