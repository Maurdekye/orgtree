import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, powerMonitor, session, shell, Tray } from 'electron'
import path from 'node:path'
import os from 'node:os'
import { autoUpdater } from 'electron-updater'
import { Engine, type RuntimeStats } from './engine'
import { Preferences } from './preferences'
import { closeAction, HARNESS_LINKS } from './policy'
import { assertNativeSender, configureEngineSession, configureWindow } from './windows'
import { detectHarnesses } from './harnesses'
import type { DesktopEvent } from '../../../packages/contracts/index'

app.setName('Orgtree v2')
const single = app.requestSingleInstanceLock()
if (!single) app.quit()
else {
  let main: BrowserWindow | undefined, tray: Tray | undefined, preferences: Preferences
  let quitting = false, quitComplete = false, downloaded = false, updateApplying = false
  let stats: RuntimeStats | null = null, poll: NodeJS.Timeout | undefined
  const engine = new Engine()
  const show = () => { if (main && !main.isDestroyed()) { main.show(); main.restore(); main.focus() } }
  const broadcast = (event: DesktopEvent) => { if (main && !main.isDestroyed()) main.webContents.send('desktop:event', event) }
  const label = () => stats ? `${stats.activeAgents} active / ${stats.totalAgents} agents` : `Engine ${engine.status.state}`
  const loginPreference = () => {
    // Never register the development electron.exe as a login application.
    if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: preferences.get().startAtLogin, path: process.execPath, args: ['--background'] })
  }
  const setPreferences = (patch: unknown) => {
    const next = preferences.set(patch); loginPreference(); rebuildTray()
    broadcast({ type: 'preferences', data: next }); return next
  }
  const rebuildTray = () => {
    if (!tray) return
    const prefs = preferences.get()
    tray.setToolTip(`Orgtree · ${label()}`)
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open Orgtree', click: show }, { label: label(), enabled: false }, { type: 'separator' },
      { label: 'Start at login', type: 'checkbox', checked: prefs.startAtLogin, click: item => setPreferences({ startAtLogin: item.checked }) },
      { label: 'Exit on close', type: 'checkbox', checked: prefs.exitOnClose, click: item => setPreferences({ exitOnClose: item.checked }) },
      { label: 'Harness setup', submenu: detectHarnesses().map(h => ({ label: `${h.id}: ${h.detected ? 'detected' : 'not detected'} — official setup`, click: () => { void shell.openExternal(h.url) } })) },
      { type: 'separator' }, { label: 'Quit Orgtree', click: () => app.quit() },
    ]))
  }
  const handle = (channel: string, handler: (...args: unknown[]) => unknown) => ipcMain.handle(channel, (event, ...args: unknown[]) => { assertNativeSender(event, main, engine.origin); return handler(...args) })
  app.on('second-instance', show)
  app.on('activate', show)
  app.on('window-all-closed', () => { /* Tray/main remain alive by default. */ })
  app.on('before-quit', event => {
    if (quitComplete) return
    event.preventDefault()
    if (quitting) return
    quitting = true
    if (poll) clearInterval(poll)
    void engine.stop().finally(() => { quitComplete = true; tray?.destroy(); app.quit() })
  })
  app.whenReady().then(async () => {
    preferences = new Preferences(path.join(app.getPath('userData'), 'desktop-settings.json'))
    loginPreference()
    const pixels = Buffer.alloc(16 * 16 * 4)
    for (let y = 2; y < 14; y++) for (let x = 2; x < 14; x++) { const i = (y * 16 + x) * 4; pixels[i] = 84; pixels[i + 1] = 178; pixels[i + 2] = 145; pixels[i + 3] = 255 }
    tray = new Tray(nativeImage.createFromBitmap(pixels, { width: 16, height: 16 }))
    tray.on('double-click', show); rebuildTray()
    handle('desktop:status', () => engine.status)
    handle('desktop:preferences', () => preferences.get())
    handle('desktop:set-preferences', value => setPreferences(value))
    handle('desktop:show', () => show())
    handle('desktop:quit', () => { app.quit() })
    handle('desktop:harnesses', () => detectHarnesses())
    handle('desktop:open-harness', id => {
      if (typeof id !== 'string' || !Object.hasOwn(HARNESS_LINKS, id)) throw new Error('Unknown harness')
      return shell.openExternal(HARNESS_LINKS[id as keyof typeof HARNESS_LINKS])
    })
    engine.on('status', status => { broadcast({ type: 'engine-status', data: status }); stats = null; rebuildTray() })
    const base = app.isPackaged ? process.resourcesPath : app.getAppPath()
    const directory = path.join(base, 'engine')
    try {
      await engine.start({ directory,
        python: app.isPackaged ? path.join(directory, 'runtime', 'python.exe') : process.env.ORGTREE_V2_PYTHON ?? '',
        dataRoot: process.env.ORGTREE_V2_DATA ?? path.join(app.getPath('userData'), 'data'),
        forbiddenRoot: path.join(os.homedir(), 'orgtree'),
        uiDirectory: path.join(app.getAppPath(), 'dist', 'renderer') })
      const browserSession = session.fromPartition('persist:orgtree-v2')
      configureEngineSession(browserSession, engine.origin, engine.token)
      main = new BrowserWindow({ width: 1400, height: 900, minWidth: 640, minHeight: 480, show: false, autoHideMenuBar: true,
        webPreferences: { session: browserSession, preload: path.join(__dirname, '../preload/index.cjs'), contextIsolation: true,
          sandbox: true, nodeIntegration: false, webviewTag: false } })
      configureWindow(main, engine.origin, true)
      main.on('close', event => {
        const action = closeAction(preferences.get().exitOnClose, quitting)
        if (action !== 'close') { event.preventDefault(); if (action === 'hide') main?.hide(); else app.quit() }
      })
      main.webContents.on('render-process-gone', () => { void dialog.showMessageBox({ type: 'error', message: 'The Orgtree window stopped responding.', detail: 'The engine is still running. Restart Orgtree to restore the interface.' }) })
      await main.loadURL(engine.origin + '/')
      if (!process.argv.includes('--background')) show()
      if (!detectHarnesses().some(h => h.detected)) await dialog.showMessageBox(main, { type: 'info', message: 'No agent harness was detected.', detail: 'Install Claude Code, Codex, or Antigravity using the official setup links in the tray menu. Orgtree does not install or sign in to harnesses.' })
      const refresh = async () => {
        if (quitting) return
        stats = await engine.stats(); rebuildTray()
        if (downloaded && stats?.idle && powerMonitor.getSystemIdleTime() >= 60 && !updateApplying) {
          updateApplying = true; quitting = true
          if (poll) clearInterval(poll)
          await engine.stop(); quitComplete = true
          autoUpdater.quitAndInstall(false, true)
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
