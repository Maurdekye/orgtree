import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, powerMonitor, session, shell, Tray } from 'electron'
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
import type { DesktopEvent } from '../../../packages/contracts/index'
import { isVisualTheme } from '../../../packages/contracts/visual-theme'
import type { VisualTheme } from '../../../packages/contracts/visual-theme'

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
  const trayIconNames: Record<VisualTheme | 'grey', string> = {
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
    const name = engine.status.state === 'ready' ? trayIconNames[theme] : trayIconNames.grey
    const image = nativeImage.createFromPath(path.join(assetsPath, name))
    return image.isEmpty() ? nativeImage.createFromPath(iconPath) : image
  }
  const notifications = new NotificationGate()
  const show = () => { if (main && !main.isDestroyed()) { restoreWindows = true; main.show(); main.restore(); main.focus(); broadcast({ type: 'main-window-shown', data: windowState() }) } }
  const broadcast = (event: DesktopEvent) => { if (main && !main.isDestroyed()) main.webContents.send('desktop:event', event) }
  const publishWindowState = () => broadcast({ type: 'window-state', data: windowControlsState() })
  const label = () => stats ? `${stats.activeAgents} active / ${stats.totalAgents} agents` : `Engine ${engine.status.state}`
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
      { label: 'Open Orgtree', click: show }, { label: label(), enabled: false }, { type: 'separator' },
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
          void result.downloadPromise.catch(() => broadcast({ type: 'update', data: { state: 'unavailable' } }))
          return 'pending'
        }
        return result.updateInfo.version === app.getVersion() ? 'up-to-date' : 'unavailable'
      } catch { return 'unavailable' }
    },
    report: state => {
      broadcast({ type: 'update', data: { state } })
      if (state === 'failed' || state === 'failure-record-unavailable') {
        void dialog.showMessageBox({ type: 'error', message: 'Orgtree maintenance did not complete.',
          detail: state === 'failed' ? 'The request failed and will not be executed again automatically. Automatic update application is paused until a new update request. Reopen Orgtree if its engine stopped.'
            : 'The maintenance failure could not be saved. Check the application data folder before requesting another restart or update.' }).catch(() => {})
      }
    },
  }, path.join(app.getPath('userData'), 'maintenance-failures.json'))
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
    void saveWindowLayout().then(() => engine.stop()).finally(() => { quitComplete = true; tray?.destroy(); app.quit() })
  })
  app.whenReady().then(async () => {
    preferences = new Preferences(path.join(app.getPath('userData'), 'desktop-settings.json'))
    loginPreference()
    tray = new Tray(runtimeIcon())
    tray.on('double-click', show); rebuildTray()
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
        autoUpdater.on('error', () => { broadcast({ type: 'update', data: { state: 'unavailable' } }) })
        autoUpdater.on('update-downloaded', () => { downloaded = true; broadcast({ type: 'update', data: { state: 'pending-idle' } }) })
        void autoUpdater.checkForUpdates().catch(() => {})
      }
    } catch (error) {
      await dialog.showMessageBox({ type: 'error', message: 'Orgtree could not start its engine.', detail: error instanceof Error ? error.message : 'Unknown startup error' })
      app.quit()
    }
  }).catch(() => app.quit())
}
