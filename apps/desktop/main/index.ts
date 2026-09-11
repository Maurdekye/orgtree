import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, powerMonitor, screen, session, shell, Tray } from 'electron'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { autoUpdater } from 'electron-updater'
import { Engine, ENGINE_REFUSED, type RuntimeStats } from './engine'
import { Preferences } from './preferences'
import { WindowPlacement } from './window-placement'
import { appUserModelId, configureTaskbar } from './taskbar'
import { closeAction, HARNESS_LINKS, validateDataRoot } from './policy'
import { assertNativeSender, configureArtifactSession, configureEngineSession, configureWindow } from './windows'
import { detectHarnesses } from './harnesses'
import { NotificationGate } from './notifications'
import { MaintenanceController } from './maintenance'
import { bounded, checkForUpdatesViaEvents, installDirectoryWritable, installDownloadedUpdate, pendingUpdateHold, prepareAndHandOff, preparedSurvivesOffer, refreshTrayUpdateMenu, sanitizeUpdateDetail, uninstallRegistryGuid, UPDATE_DEADLINES, UpdateController, UpdateLog, updateLogger, updateReplacementInFlight, updateWatchdogMs } from './updater'
import type { InstallableUpdater } from './updater'
import type { DesktopEvent } from '../../../packages/contracts/index'
import { isVisualTheme, isCustomTheme } from '../../../packages/contracts/visual-theme'
import { asLoginProvider, cancelProviderLogin, getProviderLoginStatus, startProviderLogin, submitProviderLoginCode } from './providerlogin'
import { popupBounds, trayListHtml, trayNavigationSlug } from './traylist'
import type { VisualTheme, PresetVisualTheme } from '../../../packages/contracts/visual-theme'

// The build's appId, which is what electron-builder derives its uninstall
// registry key from. Kept beside setName so the two are read together.
const appId = 'com.maurdekye.orgtree'
app.setName('Orgtree v2')
// Development notifications must not register Electron against the installed app.
app.setAppUserModelId(appUserModelId(app.isPackaged))
// Isolated development/test profiles never touch the operator's installed data.
if (!app.isPackaged && process.env.ORGTREE_V2_PROFILE) app.setPath('userData', validateDataRoot(process.env.ORGTREE_V2_PROFILE, path.join(os.homedir(), 'orgtree')))
const single = app.requestSingleInstanceLock()
if (!single) app.quit()
else {
  let main: BrowserWindow | undefined, tray: Tray | undefined, preferences: Preferences
  let trayMenu: Menu | undefined
  let trayMenuOpen = false
  let quitting = false, quitComplete = false, downloaded = false, updateApplying = false
  // Set once an automatic attempt is refused before anything is disturbed, so
  // the 5s poll neither retries it forever nor re-probes the filesystem.
  let updateHold: string | undefined, updateHoldAnnounced = false
  let updateExitWatchdog: NodeJS.Timeout | undefined
  let lastInstallError: unknown, installErrorWaiter: ((error: unknown) => void) | undefined
  /** Assigned once the poll exists, so an abandoned update can restore it. */
  let restartPoll: (() => void) | undefined
  // The 2.0.3 failures left no trace at all: electron-updater logs to `console`
  // by default, which a packaged Windows GUI process discards. Stages and
  // errors are written here instead, sanitized, beside the other desktop state.
  const updateLog = new UpdateLog(path.join(app.getPath('userData'), 'update-log.json'))
  let stats: RuntimeStats | null = null, poll: NodeJS.Timeout | undefined
  // The renderer owns provider discovery. This ephemeral value mirrors its
  // effective theme for native tray/taskbar/window icons and is never persisted.
  let effectiveTheme: VisualTheme | undefined
  let placement: WindowPlacement | undefined, restoreMaximized = false
  const savePlacement = () => { if (main && placement && !restoreMaximized) { try { placement.capture(main) } catch (error) { console.warn("Window position could not be saved", error) } } }
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
  // Explorer's taskbar group reads shell properties separately from WM_SETICON.
  // Use a real unpacked file and explicit relaunch identity for every window.
  app.on('browser-window-created', (_event, window) => {
    if (process.platform === 'win32' && app.isPackaged) configureTaskbar(window, process.execPath, iconPath)
  })
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
  const show = () => { if (main && !main.isDestroyed()) { restoreWindows = true; main.show(); if (main.isMinimized()) main.restore(); if (restoreMaximized) { restoreMaximized = false; main.maximize() }; main.focus(); broadcast({ type: 'main-window-shown', data: windowState() }) } }
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
  const refreshTrayUpdates = () => {
    if (trayMenu) refreshTrayUpdateMenu(trayMenu, updater.current(), downloaded, updateApplying || quitting, updateHold)
    const automatic = trayMenu?.getMenuItemById('update-automatic')
    if (automatic) {
      automatic.checked = preferences.get().automaticUpdates
      // Same preference as the settings row, so it is disabled on the same
      // terms: where nothing can install unattended, the switch is misleading.
      automatic.enabled = canInstallUnattended()
    }
  }
  const rebuildTray = () => {
    const image = runtimeIcon()
    tray?.setImage(image)
    for (const window of BrowserWindow.getAllWindows()) window.setIcon(image)
    if (!tray) return
    if (trayMenuOpen) { refreshTrayUpdates(); return }
    const prefs = preferences.get()
    tray.setToolTip(`Orgtree - ${label()}`)
    trayMenu = Menu.buildFromTemplate([
      { id: 'update-status', label: 'Updates have not been checked', enabled: false },
      { id: 'update-install', label: 'Update now', visible: downloaded, enabled: !updateApplying && !quitting,
        click: () => { void requestUpdateInstall().catch(error => {
          void dialog.showMessageBox({ type: 'error', message: 'Orgtree could not install the update.',
            detail: error instanceof Error ? error.message : String(error) })
        }) } },
      { id: 'update-automatic', label: 'Automatic updates', type: 'checkbox', checked: prefs.automaticUpdates,
        enabled: canInstallUnattended(),
        click: item => setPreferences({ automaticUpdates: item.checked }) },
      { id: 'update-check', label: 'Check for updates', click: () => { void updater.check().catch(() => {}) } },
      { type: 'separator' },
      { label: 'Start at login', type: 'checkbox', checked: prefs.startAtLogin, click: item => setPreferences({ startAtLogin: item.checked }) },
      { label: 'Exit on close', type: 'checkbox', checked: prefs.exitOnClose, click: item => setPreferences({ exitOnClose: item.checked }) },
      { label: 'Routine mail and completion notifications', type: 'checkbox', checked: prefs.routineNotifications, click: item => setPreferences({ routineNotifications: item.checked }) },
      { label: 'Harness setup', submenu: detectHarnesses().map(h => ({ label: `${h.id}: ${h.detected ? 'detected' : 'not detected'} - official setup`, click: () => { void shell.openExternal(h.url) } })) },
      { type: 'separator' }, { label: 'Quit Orgtree', click: () => app.quit() },
    ])
    trayMenu.on('menu-will-show', () => { trayMenuOpen = true })
    trayMenu.on('menu-will-close', () => { trayMenuOpen = false })
    refreshTrayUpdates()
    tray.setContextMenu(trayMenu)
  }
  const handle = (channel: string, handler: (...args: unknown[]) => unknown) => ipcMain.handle(channel, (event, ...args: unknown[]) => { assertNativeSender(event, main, engine.origin); return handler(...args) })
  const saveWindowLayout = async () => {
    savePlacement()
    if (main && !main.isDestroyed()) {
      try { await main.webContents.executeJavaScript('window.dispatchEvent(new Event("orgtree:before-exit"))') } catch { /* Crashed renderer cannot save layout. */ }
    }
  }
  const quitAfterLastView = () => {
    if (!quitting && preferences.get().exitOnClose && BrowserWindow.getAllWindows().every(w => !w.isVisible())) app.quit()
  }
  // Deadlines for the shutdown sequence. Nothing awaited between `quitting`
  // becoming true and the installer handoff may be unbounded: at that point
  // before-quit refuses every app.quit(), so an await that never settles
  // leaves the app wedged at "Installing update..." with no way out but Task
  // Manager. executeJavaScript is exactly such an await — measured in real
  // Electron it does not settle on a busy renderer, and does not settle even
  // when that renderer is destroyed or force-crashed.
  // Derived, never set beside the steps it covers: the previous 20s equalled
  // 5 + 12 + 3 exactly, so the forced exit could fire DURING the spawn grace
  // it is supposed to be protecting.
  const UPDATE_LAYOUT_MS = UPDATE_DEADLINES.layoutMs
  const UPDATE_ENGINE_STOP_MS = UPDATE_DEADLINES.engineStopMs
  const UPDATE_ENGINE_CONFIRM_MS = UPDATE_DEADLINES.engineConfirmMs
  const UPDATE_SPAWN_GRACE_MS = UPDATE_DEADLINES.spawnGraceMs
  const UPDATE_EXIT_MS = updateWatchdogMs()
  const installDirectory = () => path.dirname(process.execPath)
  /** Resolved ONCE per run: both facts are properties of where this copy is
   *  installed, which cannot change while it runs, and the writability half
   *  writes a real file. `allUsers` stays undefined when the scope could not be
   *  read, in which case writability alone decides. */
  let unattendedInstallPossible: boolean | undefined, installedForAllUsers: boolean | undefined
  const canInstallUnattended = () => {
    if (unattendedInstallPossible === undefined) {
      // BOTH are needed. A writability probe alone cannot see the scope: an
      // ELEVATED process can write to an all-users directory perfectly well,
      // and the user asked for the control to be off for all-users regardless.
      // The scope alone is not enough either - a read-only volume or a
      // restrictive ACL blocks a per-user install just as completely.
      unattendedInstallPossible = installedForAllUsers !== true && installDirectoryWritable(installDirectory())
    }
    return unattendedInstallPossible
  }
  /** electron-builder registers its uninstaller under a derived GUID: HKLM for
   *  an all-users installation, HKCU for a per-user one. Read once at startup,
   *  bounded, read-only; failure leaves the answer unknown rather than wrong. */
  const readInstallScope = () => new Promise<void>(resolve => {
    if (process.platform !== 'win32' || !app.isPackaged) return resolve()
    const key = `HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${uninstallRegistryGuid(appId)}`
    execFile('reg', ['query', key], { timeout: 4000, windowsHide: true }, (error, stdout) => {
      if (!error && /InstallLocation|UninstallString|DisplayName/i.test(stdout)) installedForAllUsers = true
      else if (error && /not.*(find|exist)/i.test(String(error.message))) installedForAllUsers = false
      updateLog.record('updater', `install scope: ${installedForAllUsers === undefined ? 'unknown' : installedForAllUsers ? 'all users' : 'per user'}`)
      unattendedInstallPossible = undefined
      resolve()
    })
  })
  const cancelUpdateWatchdog = () => { if (updateExitWatchdog) clearTimeout(updateExitWatchdog); updateExitWatchdog = undefined }
  /** Put the app back after a shutdown that must not complete. `quitting` is
   *  latched by then, which is what makes every app.quit() a no-op, so leaving
   *  it set is the 2.0.3 wedge by another route. */
  const abandonUpdateShutdown = (message: string, detail: string) => {
    cancelUpdateWatchdog()
    quitting = false; quitComplete = false; updateApplying = false
    updateHold = 'last attempt did not complete - use Update now'
    restartPoll?.()
    refreshTrayUpdates()
    // saveWindowLayout already told the renderer it was exiting, which latches
    // a flag that stops it persisting layout. Nothing was going to take that
    // back, so a window that survived an abandoned update stopped saving its
    // position for the rest of the session.
    if (main && !main.isDestroyed()) {
      void main.webContents.executeJavaScript('window.dispatchEvent(new Event("orgtree:exit-cancelled"))').catch(() => {})
    }
    void dialog.showMessageBox({ type: 'error', message, detail }).catch(() => {})
  }
  /** electron-updater reports a spawn failure asynchronously. Resolves with the
   *  error if one arrives inside the window, or undefined if none does. */
  const awaitInstallError = (ms: number) => new Promise<unknown>(resolve => {
    if (lastInstallError !== undefined) { const seen = lastInstallError; lastInstallError = undefined; return resolve(seen) }
    const timer = setTimeout(() => { installErrorWaiter = undefined; resolve(undefined) }, ms)
    installErrorWaiter = error => { clearTimeout(timer); installErrorWaiter = undefined; resolve(error) }
  })
  /** Whether a check or a download is in flight, either of which can be in the
   *  middle of REPLACING the prepared package. electron-updater deletes the old
   *  installer as soon as the feed offers a different artifact, and goes on
   *  pointing at the deleted path, so a handoff racing a check can hand the
   *  installer a file that is no longer there. */
  const updateBusy = () => updateReplacementInFlight(updater.current())
  const applyDownloadedUpdate = async (automatic = false, unattended = automatic) => {
    // Once shutdown begins, finish installing. Before that boundary, disabling
    // automatic updates also holds any package that has already downloaded.
    // `unattended` is the wider property: the engine-issued maintenance update
    // also runs with nobody present, but is deliberately NOT governed by the
    // automatic-updates preference, so the two cannot be the same flag.
    if (automatic && !preferences.get().automaticUpdates) return
    if (unattended && updateHold) return
    if (updateApplying || quitting) return
    // Never hand off while the package could be being replaced underneath it.
    // The idle path reaches here on its own every five seconds, so this is a
    // real guard and not just backstop for the manual route below.
    if (updateBusy()) return
    updateApplying = true
    refreshTrayUpdates()
    const version = updater.current().version
    updateLog.record('attempt', automatic ? 'automatic idle application' : 'explicit request', { from: app.getVersion(), to: version })
    try {
    // An UNATTENDED install that cannot write the installed directory cannot
    // succeed: the bundled NSIS preflight elevates and quits, so the app would
    // shut down and install nothing. The write failure says only that THIS
    // process cannot replace those files — an all-users installation is the
    // usual cause, but a read-only volume or a restrictive ACL is identical, and
    // the response is the same either way. Checked FIRST, before the engine is
    // touched, so a hold disturbs nothing. An explicit request still proceeds:
    // the user is there to approve whatever Windows asks.
    if (unattended && !canInstallUnattended()) {
      updateHold = 'cannot install unattended - use Update now'
      updateLog.record('held', 'installation directory is not writable by this process: ' + installDirectory())
      updateApplying = false
      refreshTrayUpdates()
      // Held, never silently dropped: automatic updates stay ON and the
      // package stays ready. Said once per run, because the idle path would
      // otherwise reach this every five seconds.
      if (!updateHoldAnnounced) {
        updateHoldAnnounced = true
        // A failed write means "this process cannot replace these files" and
        // nothing more specific: an all-users installation is the usual cause,
        // but a read-only volume or a restrictive ACL reads identically.
        void dialog.showMessageBox({ type: 'info', message: 'Orgtree is ready to update, but cannot install it on its own.',
          detail: `Orgtree cannot write to ${installDirectory()}, so the installer cannot run unattended. Choose "Update now" in the Orgtree tray menu and approve any Windows prompt. Automatic updates remain enabled.` }).catch(() => {})
      }
      return
    }
    // A boot-host engine is stopped gracefully through its authenticated
    // shutdown route before its files are replaced; the installer restarts
    // the task afterwards. A stop that cannot be VERIFIED throws here, with
    // no state disturbed — a maintenance request then lands in its designed
    // failure report, and the idle auto-path simply retries later — because
    // installing over a live engine is never acceptable.
    if (!engine.managed) { await engine.stopAttachedForUpdate(); updateLog.record('engine-stopped', 'attached boot engine confirmed stopped') }
    if (quitting) return
    quitting = true
    if (poll) clearInterval(poll)
    // Every step from here is bounded and recorded by prepareAndHandOff, which
    // is driven end to end in tests precisely because this is the window that
    // wedged: app.quit() is already refused, so nothing else can rescue it.
    const outcome = await prepareAndHandOff({
      armWatchdog: () => {
        updateExitWatchdog = setTimeout(() => {
          updateLog.record('watchdog-exit', 'update preparation exceeded ' + UPDATE_EXIT_MS + 'ms')
          app.exit(1)
        }, UPDATE_EXIT_MS)
        updateExitWatchdog.unref()
      },
      cancelWatchdog: cancelUpdateWatchdog,
      saveLayout: saveWindowLayout,
      stopEngine: () => engine.stop(),
      confirmEngineStopped: () => engine.stoppedConfirmed(UPDATE_ENGINE_CONFIRM_MS),
      markQuitComplete: () => { quitComplete = true },
      // Typed as the abstract AppUpdater, but always a BaseUpdater at runtime;
      // InstallableUpdater names exactly the members used. Note that going
      // through install() rather than quitAndInstall() also means the library
      // does not emit 'before-quit-for-update' - nothing here listens for it,
      // and owning the quit is what lets a failed spawn be caught at all.
      handOff: () => installDownloadedUpdate(autoUpdater as unknown as InstallableUpdater, installDirectory()),
      record: (stage, detail) => { updateLog.record(stage, detail, { from: app.getVersion(), to: version }) },
      layoutMs: UPDATE_LAYOUT_MS, engineMs: UPDATE_ENGINE_STOP_MS, engineConfirmMs: UPDATE_ENGINE_CONFIRM_MS,
    })
    if (outcome.stage === 'engine-unconfirmed') {
      // Nothing was installed and nothing was handed off. The engine's state is
      // UNKNOWN, so this process must not relaunch into a second one either.
      // Put the app back the way it was and leave the update pending. THROWING
      // matters: a manual request that resolved here would leave the renderer's
      // Update now button stuck on "Restarting..." for ever.
      abandonUpdateShutdown('Orgtree did not install the update.',
        'The engine did not confirm that it stopped, and Orgtree will not replace its files while it may still be running. The update is still ready; try again from the tray.')
      throw new Error('The engine did not confirm that it stopped, so the update was not installed.')
    }
    if (outcome.stage === 'refused') {
      // electron-updater declined, so no quit is coming from it. The engine IS
      // confirmed stopped here, so relaunching into a working app is safe.
      updateLog.record('handoff-refused', 'relaunching after a declined install request')
      app.relaunch(); app.exit(0)
      return
    }
    // The installer was LAUNCHED, which is not the same as succeeded: a spawn
    // that fails does so asynchronously, on the 'error' event, after install()
    // has already returned true. Measured, that failure still quit the app and
    // installed nothing. Owning the quit lets us wait a bounded moment for it.
    const spawnFailure = await awaitInstallError(UPDATE_SPAWN_GRACE_MS)
    if (spawnFailure !== undefined) {
      // Unlike the unconfirmed-stop path, the engine here IS confirmed gone, so
      // carrying on in place would leave a running app with a dead engine.
      // Relaunch into a working one, exactly as a declined handoff does.
      updateLog.record('handoff-refused', spawnFailure)
      updateLog.record('not-installed', 'the installer could not be started', { from: app.getVersion(), to: version })
      app.relaunch(); app.exit(0)
      return
    }
    app.quit()
    } catch (error) {
      updateLog.record('error', error)
      // Before the point of no return nothing was disturbed: release the
      // attempt and let the caller decide. After it, quitting is latched and
      // the engine may be stopped, so the armed watchdog is what guarantees
      // this can never become the 2.0.3 wedge.
      if (!quitting) updateApplying = false
      refreshTrayUpdates()
      throw error
    }
  }
  const requestUpdateInstall = async () => {
    if (!downloaded || !app.isPackaged) throw new Error('No downloaded update is ready to install.')
    // Refused with a reason the renderer can show, rather than silently: an
    // explicit Update now that raced a check would shut the engine down and
    // hand off to a package the check had just deleted.
    if (updateBusy()) throw new Error('Orgtree is checking for a newer update. Try again in a moment.')
    // An explicit request retires any hold: the user is present, so the
    // administrator approval the automatic path could not obtain can be given.
    updateHold = undefined
    await applyDownloadedUpdate()
  }
  const maintenance = new MaintenanceController({
    ack: (id, outcome) => engine.acknowledgeMaintenance(id, outcome),
    failure: id => engine.reportMaintenanceFailure(id),
    restart: async () => {
      if (quitting) return
      // Electron's relaunch helper is outside the Python Job, as is the updater.
      app.relaunch(); app.quit()
    },
    // Unattended, though not automatic: nobody is present to approve a UAC
    // prompt, so this must respect the same hold as the idle path.
    apply: () => applyDownloadedUpdate(false, true),
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
    automaticEnabled: () => preferences.get().automaticUpdates,
    // electron-updater's own update-available/update-not-available events are the
    // authoritative "is this actually newer" answer (channel/prerelease/downgrade
    // rules included) - comparing version strings here would get an older or
    // disallowed release wrong by treating any difference as an update.
    run: () => app.isPackaged ? checkForUpdatesViaEvents(autoUpdater) : Promise.resolve({ hasUpdate: false }),
    report: status => {
      // A download is either the first one or a REPLACEMENT for the package
      // already prepared. Either way nothing is installable until it finishes,
      // and the old file is already gone.
      if (status.state === 'downloading') downloaded = false
      broadcast({ type: 'update', data: status }); refreshTrayUpdates()
    },
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
    // Bounded for the same measured reason as the update path: executeJavaScript
    // does not settle on a busy or crashed renderer, and until quitComplete is
    // set this handler preventDefaults every further app.quit() — so an
    // unbounded flush here is a Quit that can never complete.
    void bounded(saveWindowLayout(), UPDATE_LAYOUT_MS)
      .then(() => bounded(engine.stop(), UPDATE_ENGINE_STOP_MS))
      .finally(() => { quitComplete = true; tray?.destroy(); app.quit() })
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
    handle('desktop:app-version', () => app.getVersion())
    handle('desktop:install-update', () => requestUpdateInstall())
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
    handle('desktop:update-capability', () => ({ unattendedInstall: canInstallUnattended(), installDirectory: installDirectory() }))
    // Refused, not queued, while an application attempt is under way: a check
    // that found a newer release would delete the very package being installed.
    handle('desktop:check-for-updates', () => (updateApplying || quitting) ? updater.current() : updater.check())
    // Provider sign-in (D-231): the child spawn lives ONLY in this process —
    // see providerlogin.ts's module docstring for why. `assertNativeSender`
    // (via `handle` above) already keeps this off any surface but the app's
    // own authoritative renderer, same as every other native control here.
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
      placement = new WindowPlacement(path.join(app.getPath('userData'), 'window-state.json'))
      const savedPlacement = placement.restore(screen.getAllDisplays().map(display => display.workArea))
      restoreMaximized = savedPlacement?.maximized ?? false
      main = new BrowserWindow({ width: 1400, height: 900, ...savedPlacement?.bounds, minWidth: 640, minHeight: 480, frame: false, show: false, icon: iconPath, autoHideMenuBar: true,
        webPreferences: { session: browserSession, preload: path.join(__dirname, '../preload/index.cjs'), contextIsolation: true,
          sandbox: true, nodeIntegration: false, webviewTag: false, additionalArguments: [`--orgtree-ui-origin=${initialOrigin}`] } })
      main.setIcon(runtimeIcon())
      main.on('moved', savePlacement)
      main.on('resized', savePlacement)
      main.on('maximize', savePlacement)
      main.on('unmaximize', savePlacement)
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
        savePlacement()
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
        if (preferences.get().automaticUpdates && downloaded && stats?.idle && powerMonitor.getSystemIdleTime() >= 60 && !updateApplying && maintenance.automaticUpdatesAllowed()) {
          // An unverifiable attached-engine stop throws with state untouched;
          // the next idle sample simply tries again.
          await applyDownloadedUpdate(true).catch(() => {})
        }
      }
      // ------------------------------------------------ updater start-up
      // EVERYTHING the updater needs is established BEFORE the first refresh.
      // The poll's very first tick can find a cached package and begin applying
      // it, so wiring the listeners or reading the install scope after that
      // leaves a window in which a download completes with no listener attached
      // and an attempt runs before it is known whether a hold applies.
      if (app.isPackaged) {
        autoUpdater.autoInstallOnAppQuit = false
        autoUpdater.allowPrerelease = true
        // Its own info lines name the installer, its arguments and the exact
        // spawn failure. Previously they went to a console nobody can read.
        autoUpdater.logger = updateLogger(updateLog)
        autoUpdater.on('error', error => {
          // errored() is deliberately a no-op outside a download (it exists to
          // stop a check-time failure being counted twice), which is precisely
          // why an INSTALL-stage failure used to vanish without trace. The
          // controller's state machine is left alone; the error is recorded,
          // and while an application attempt is in flight it is also shown.
          updateLog.record('error', error)
          // While an attempt is in flight this is very likely the installer
          // spawn failing. Hand it to whoever is waiting on the grace window
          // rather than showing a dialog the imminent quit would discard.
          if (updateApplying || quitting) {
            if (installErrorWaiter) installErrorWaiter(error)
            else lastInstallError = error
          }
          updater.errored()
        })
        // Forward the REAL version. A cached package can be reported downloaded
        // before any check of ours has resolved, and discarding info.version
        // then leaves the target unknown on an ordinary, successful download.
        autoUpdater.on('update-downloaded', info => {
          downloaded = true
          const version = info && typeof info === 'object' && typeof (info as { version?: unknown }).version === 'string'
            ? (info as { version: string }).version : undefined
          updater.downloaded(version)
        })
        autoUpdater.on('download-progress', progress => updater.progress(Math.round(progress.percent)))
        // A prepared installer does not survive the feed offering a DIFFERENT
        // release: electron-updater empties its own pending directory before
        // downloading the replacement, while still pointing at the path it just
        // deleted. This event fires before that download starts, and it is the
        // only signal that covers every route into it - the manual check, the
        // periodic tick, and the engine-issued maintenance check, which calls
        // the library directly and never touches UpdateController at all.
        autoUpdater.on('update-available', info => {
          if (!downloaded) return
          const offered = info && typeof info === 'object' && typeof (info as { version?: unknown }).version === 'string'
            ? (info as { version: string }).version : undefined
          if (preparedSurvivesOffer(updater.preparedVersion(), offered)) return
          downloaded = false
          updateLog.record('updater', 'a different release was offered; the prepared installer is being replaced')
          refreshTrayUpdates()
        })
      }
      // Awaited deliberately: canInstallUnattended must not answer before the
      // scope is known, and the first refresh must not run before either.
      await readInstallScope()
      // A previous attempt that ended without the version changing holds the
      // automatic path for exactly ONE run, so the app cannot spend every idle
      // minute shutting itself down for an install that will not happen.
      // 'hold-consumed' is what spends it - NOT 'not-installed', which the
      // spawn-failure path writes before the relaunch that leads to this very
      // boot, and which as a guard let that failure retry immediately instead.
      if (pendingUpdateHold(updateLog.lastAttempt(), app.getVersion())) {
        updateLog.record('hold-consumed', 'the previous attempt did not change the running version')
        updateHold = 'last install did not complete - use Update now'
      }
      refreshTrayUpdates()

      let refreshing = false
      const startPoll = () => {
        if (poll) clearInterval(poll)
        poll = setInterval(() => { if (refreshing) return; refreshing = true; void refresh().finally(() => { refreshing = false }) }, 5000)
      }
      restartPoll = startPoll
      startPoll()
      void refresh()
    } catch (error) {
      await dialog.showMessageBox({ type: 'error', message: 'Orgtree could not start its engine.', detail: error instanceof Error ? error.message : 'Unknown startup error' })
      app.quit()
    }
  }).catch(() => app.quit())
}
