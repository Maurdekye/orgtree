import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, powerMonitor, screen, session, shell, Tray } from 'electron'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { execFile, spawn as spawnProcess } from 'node:child_process'
import { autoUpdater } from 'electron-updater'
import { Engine, ENGINE_REFUSED, INSTALLER_UPGRADE_STOP_BUDGET_MS, QUIT_STOP_BUDGET_MS, type RuntimeStats } from './engine'
import { Preferences } from './preferences'
import { WindowPlacement } from './window-placement'
import { configureTaskbar } from './taskbar'
import { desktopIdentity, readBuildChannel } from './build-channel'
import { closeAction, HARNESS_LINKS, validateDataRoot } from './policy'
import { assertNativeSender, configureArtifactSession, configureEngineSession, configureWindow, popoutRegistry, revealPopout } from './windows'
import { detectHarnesses } from './harnesses'
import { NativeNotifications, anyOrgtreeWindowFocused } from './notifications'
import { TaskbarAttention, attentionIdentities } from './taskbar-attention'
import { NOTIFICATION_OPTIONS } from '../../../packages/contracts/notifications'
import { MaintenanceController } from './maintenance'
import { awaitInstallerProof, bounded, checkForUpdatesViaEvents, installerLogTail, installDirectoryWritable, installDownloadedUpdate, MANUAL_UPGRADE_URL, pendingUpdateHold, prepareAndHandOff, refreshTrayUpdateMenu, sanitizeUpdateDetail, uninstallRegistryGuid, updateAttemptFailed, updateFailureDialogOptions, updateFailureToReport, UPDATE_DEADLINES, UpdateController, UpdateLog, updateLogger, updateReplacementInFlight, updateWatchdogMs } from './updater'
import type { InstallableUpdater, UpdateStatus } from './updater'
import { buildPermitsUpdateFixture, confineExecutorToLoopback, prepareUpdateFixture, privateFeedDecision, UPDATE_FEED_ENV, UPDATE_FIXTURE_ENV } from './update-fixture'
import type { PreparedFixture } from './update-fixture'
import type { DesktopEvent } from '../../../packages/contracts/index'
import { isVisualTheme, isCustomTheme } from '../../../packages/contracts/visual-theme'
import { asLoginProvider, cancelProviderLogin, getProviderLoginStatus, startProviderLogin, submitProviderLoginCode } from './providerlogin'
import { popupBounds, trayListHtml, trayNavigationSlug } from './traylist'
import type { VisualTheme, PresetVisualTheme } from '../../../packages/contracts/visual-theme'
import { hasInstallerUpgradeRequest } from './installer-upgrade'

// Who this process is — installed release, installed DEV-channel build (see
// docs/dev-builds.md), or unpackaged development — is decided in one place
// from the channel packaging recorded beside the app. A dev-channel install
// carries its own appId (and so its own uninstall registry key), its own name
// (and so its own userData/data directory and single-instance lock) and its
// own shell identity: it runs side by side with an installed release and can
// touch none of its state.
const identity = desktopIdentity(app.isPackaged, app.isPackaged ? readBuildChannel(path.join(process.resourcesPath, 'build-info.json')) : 'release', buildPermitsUpdateFixture())
const appId = identity.appId
app.setName(identity.name)
app.setAppUserModelId(identity.appUserModelId)
// Updates exist only for the packaged release channel: a dev-channel install
// ships no feed, and everything update-shaped gates on this rather than on
// app.isPackaged so it can never probe the release's install scope either.
// ⚠ A REHEARSAL BUILD WITHOUT AN ISOLATED PRIVATE FEED HAS NO UPDATER AT ALL.
// The fixture only substitutes at the HANDOFF, which is the end of a flow that
// begins with a feed saying a newer version exists — so a fixture-composed
// build needs a feed before its in-app entry is reachable. Falling back to the
// packaged feed would point that build at the PUBLIC release feed and let a
// private rehearsal download a real update, so the fallback is refusal: no
// private feed, no checking, and the build behaves like an ordinary dev build.
const updateFeed = privateFeedDecision({ requested: process.env[UPDATE_FEED_ENV] })
const updatesSupported = identity.updatesSupported && updateFeed.kind !== 'refused'
// Isolated development/test profiles never touch the operator's installed data.
if (!app.isPackaged && process.env.ORGTREE_V2_PROFILE) app.setPath('userData', validateDataRoot(process.env.ORGTREE_V2_PROFILE, path.join(os.homedir(), 'orgtree')))
const installerUpgradeRequested = hasInstallerUpgradeRequest(process.argv)
const single = app.requestSingleInstanceLock()
if (!single) app.quit()
else if (installerUpgradeRequested) {
  // The upgrade helper only launches this command after it has path-verified
  // an already-running installed process. A standalone control invocation
  // must still exit without creating a window or starting an engine.
  //
  // Reaching here means this process HELD the single-instance lock, so no
  // application was running to receive the request and nothing else is writing
  // the log. The messenger case — where a primary does exist — is deliberately
  // silent here and recorded by that primary instead: both processes rewriting
  // this file at once would lose entries from whichever wrote first.
  void app.whenReady().then(() => {
    try {
      new UpdateLog(path.join(app.getPath('userData'), 'update-log.json'))
        .record('installer-upgrade-control', 'no running application received the request')
    } catch { /* the record is diagnostic; it must never hold up the exit */ }
    app.quit()
  })
}
else {
  let main: BrowserWindow | undefined, tray: Tray | undefined, preferences: Preferences
  let trayMenu: Menu | undefined
  let trayMenuOpen = false
  let quitting = false, quitComplete = false, downloaded = false, updateApplying = false
  let installerUpgradeShutdown = false, installerUpgradePending = false, engineReady = false
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
  // An installer-requested shutdown and whatever started the application again
  // are two halves of one event, and the log recorded neither. This is the
  // second half: the entry that says how this run began, written next to the
  // entry that says why the last one ended.
  updateLog.record('startup', process.argv.includes('--updated') ? 'relaunched by the updater'
    : process.argv.includes('--background') ? 'started in the background by startup registration'
    : 'started directly')
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
    // Development has a real source-tree .ico and its own AppUserModelID too;
    // leaving it to Electron's default identity makes Windows show the generic
    // Electron/document icon. Keep release and development shell metadata on
    // the same path while retaining their distinct identities.
    if (process.platform === 'win32') configureTaskbar(window, process.execPath, iconPath, identity.appUserModelId, identity.displayName)
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
  const notifications = new NativeNotifications(
    data => new Notification({ title: data.title, body: data.body }),
    data => { show(); broadcast({ type: 'notification-click', data }) },
    () => anyOrgtreeWindowFocused(BrowserWindow.getAllWindows()))
  // The taskbar's own attention behaviour, driven by the same cross-org
  // projection as the in-app dot so the two indicators cannot disagree.
  const taskbarAttention = new TaskbarAttention(() => main)
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
    const currentTheme = preferences?.get() as { visualTheme?: VisualTheme; visualThemeExplicit?: boolean } | undefined
    const explicitTheme = currentTheme?.visualTheme &&
      (currentTheme.visualTheme !== 'orgtree' || currentTheme.visualThemeExplicit === true)
      ? currentTheme.visualTheme : undefined
    const theme = effectiveTheme ?? explicitTheme ?? 'claude'
    try { await popup.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(trayListHtml(rows, theme))) }
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
    notifications.configure(next)
    broadcast({ type: 'preferences', data: next }); return next
  }
  const setEffectiveTheme = (value: unknown) => {
    if (!isVisualTheme(value)) throw new Error('Unknown visual theme')
    effectiveTheme = value
    rebuildTray()
  }
  /** Keep the recovery path behind an explicit user action. The app never
   * downloads or executes the release; the browser handles the official page.
   * A failed browser launch must not turn a dialog the user already dismissed
   * into an undelivered failure report. */
  const showUpdateFailure = (message: string, detail: string, type: 'error' | 'warning' = 'error') =>
    dialog.showMessageBox(updateFailureDialogOptions(message, detail, type)).then(({ response }) => {
      if (response === 0) void shell.openExternal(MANUAL_UPGRADE_URL).catch(() => {})
    })
  const showUpdateInstallError = (error: unknown) => {
    const detail = error instanceof Error ? error.message : String(error)
    const failedUpdate = updateFailureToReport(updateLog.lastAttempt(), app.getVersion())
    if (failedUpdate) {
      return showUpdateFailure('Orgtree could not install the update.',
        `${detail}\n\nThe update attempt ended without changing the installed version. Download the latest release manually if the in-app update could not be completed.`)
    }
    return dialog.showMessageBox({ type: 'error', message: 'Orgtree could not install the update.', detail })
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
    // Without update support (dev-channel install, unpackaged development)
    // the four update rows would only mislead: their ids are absent, which
    // refreshTrayUpdates already tolerates, and one honest line takes their
    // place. Not "up to date" - a build with no feed cannot claim that.
    const updateRows: Electron.MenuItemConstructorOptions[] = updatesSupported ? [
      { id: 'update-status', label: 'Updates have not been checked', enabled: false },
      { id: 'update-install', label: 'Update now', visible: downloaded, enabled: !updateApplying && !quitting,
        click: () => { void requestUpdateInstall().catch(error => { void showUpdateInstallError(error) }) } },
      { id: 'update-automatic', label: 'Automatic updates', type: 'checkbox', checked: prefs.automaticUpdates,
        enabled: canInstallUnattended(),
        click: item => setPreferences({ automaticUpdates: item.checked }) },
      { id: 'update-check', label: 'Check for updates', click: () => { void checkForUpdates().catch(() => {}) } },
    ] : [{ label: 'Updates are disabled in this development build', enabled: false }]
    trayMenu = Menu.buildFromTemplate([
      ...updateRows,
      { type: 'separator' },
      { label: 'Start at login', type: 'checkbox', checked: prefs.startAtLogin, click: item => setPreferences({ startAtLogin: item.checked }) },
      { label: 'Exit on close', type: 'checkbox', checked: prefs.exitOnClose, click: item => setPreferences({ exitOnClose: item.checked }) },
      { label: 'Notifications', submenu: [
        { label: 'Notifications', type: 'checkbox' as const, checked: prefs.notificationsEnabled, click: (item: Electron.MenuItem) => setPreferences({ notificationsEnabled: item.checked }) },
        { type: 'separator' as const },
        ...NOTIFICATION_OPTIONS.map(({ key, label }) => ({ label, type: 'checkbox' as const,
          checked: prefs[key], enabled: prefs.notificationsEnabled, click: (item: Electron.MenuItem) => setPreferences({ [key]: item.checked }) })),
      ] },
      { label: 'Harness setup', submenu: detectHarnesses().map(h => ({ label: `${h.id}: ${h.detected ? 'detected' : 'not detected'} - official setup`, click: () => { void shell.openExternal(h.url) } })) },
      { type: 'separator' }, { label: 'Quit Orgtree', click: () => app.quit() },
    ])
    trayMenu.on('menu-will-show', () => { trayMenuOpen = true })
    trayMenu.on('menu-will-close', () => { trayMenuOpen = false })
    refreshTrayUpdates()
    tray.setContextMenu(trayMenu)
  }
  const handle = (channel: string, handler: (...args: unknown[]) => unknown) => ipcMain.handle(channel, (event, ...args: unknown[]) => { assertNativeSender(event, main, engine.origin); return handler(...args) })
  // Window commands for popped-out desks and modals; see popoutRegistry.
  const popouts = popoutRegistry<BrowserWindow>(state => broadcast({ type: 'popout-state', data: state }))
  const saveWindowLayout = async () => {
    savePlacement()
    if (main && !main.isDestroyed()) {
      try { await main.webContents.executeJavaScript('window.dispatchEvent(new Event("orgtree:before-exit"))') } catch { /* Crashed renderer cannot save layout. */ }
    }
  }
  /** The installer sends a second-instance control request. Keep this path
   * separate from the ordinary Quit handler: that handler may force-kill a
   * stuck engine, while an upgrade must return failure and leave everything
   * running for Retry or Cancel. */
  const requestInstallerUpgradeShutdown = async () => {
    updateLog.record('installer-upgrade-requested')
    if (installerUpgradeShutdown || quitComplete || quitting) return
    if (!engineReady) {
      installerUpgradePending = true
      updateLog.record('installer-upgrade-deferred', 'the engine is not ready yet')
      return
    }
    installerUpgradePending = false
    installerUpgradeShutdown = true
    updateLog.record('installer-upgrade-began')
    try {
      await bounded(saveWindowLayout(), UPDATE_DEADLINES.layoutMs)
      if (!await engine.stopGracefullyForInstaller(INSTALLER_UPGRADE_STOP_BUDGET_MS)) {
        updateLog.record('installer-upgrade-refused', 'the engine did not stop within its budget')
        return
      }
      updateLog.record('installer-upgrade-engine-stopped')
      quitting = true
      if (poll) clearInterval(poll)
      trayPopupSeq++; closeTrayPopup()
      cancelProviderLogin('claude', true)
      cancelProviderLogin('codex', true)
      quitComplete = true
      updateLog.record('installer-upgrade-complete')
      tray?.destroy()
      app.quit()
    } catch (error) {
      // A graceful control failure is intentionally non-destructive. The
      // helper reports it and offers Retry/Cancel; the app remains usable.
      updateLog.record('installer-upgrade-refused', error)
    } finally {
      if (!quitComplete) installerUpgradeShutdown = false
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
  // The quit's own budget, DERIVED from the phases stopForQuit can actually
  // spend (QUIT_DEADLINES) rather than guessed here: stopForQuit apportions
  // that sum and never exceeds it, and this outer bound is the same number
  // plus the usual margin — so `bounded` is the backstop it is meant to be
  // and not the thing that routinely ends the quit.
  const QUIT_ENGINE_TOTAL_MS = QUIT_STOP_BUDGET_MS + UPDATE_DEADLINES.marginMs
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
    if (process.platform !== 'win32' || !updatesSupported) return resolve()
    const key = `HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${uninstallRegistryGuid(appId)}`
    execFile('reg', ['query', key], { timeout: 4000, windowsHide: true }, (error, stdout) => {
      if (!error && /InstallLocation|UninstallString|DisplayName/i.test(stdout)) installedForAllUsers = true
      else if (error && /not.*(find|exist)/i.test(String(error.message))) installedForAllUsers = false
      updateLog.record('updater', `install scope: ${installedForAllUsers === undefined ? 'unknown' : installedForAllUsers ? 'all users' : 'per user'}`)
      unattendedInstallPossible = undefined
      resolve()
    })
  })
  /** WHERE THE INSTALLER WRITES ITS OWN LOG, in the order it prefers.
   *
   *  The installer records its stages to `orgtree-installer.log` beside Setup
   *  itself ($EXEDIR) and falls back to the temp folder when that is not
   *  writable. Neither location is knowable from in here with certainty after a
   *  restart, so all three candidates are offered and the first that exists is
   *  used: the path electron-updater downloaded to, the pending directory named
   *  by app-update.yml, and the temp folder.
   *
   *  ⚠ THIS IS THE HALF OF THE RECORD THE APPLICATION CANNOT WRITE. Everything
   *  after the handoff happens inside the installer, and on the machine that
   *  failed there was nothing there at all — which is why its outcome could not
   *  be explained. Copying the installer's own last lines into update-log.json
   *  means the operator sends ONE file and it leads to both halves. */
  const installerLogCandidates = (): string[] => {
    const candidates: string[] = []
    try {
      const file = (autoUpdater as unknown as { installerPath?: string }).installerPath
      if (file) candidates.push(path.join(path.dirname(file), 'orgtree-installer.log'))
    } catch { /* the library may not have one this run */ }
    try {
      // Read the same key electron-updater reads to find its own cache.
      const config = fs.readFileSync(path.join(process.resourcesPath, 'app-update.yml'), 'utf8')
      const dirName = /updaterCacheDirName:\s*(.+)/.exec(config)?.[1]?.trim()
      const localAppData = process.env.LOCALAPPDATA
      if (dirName && localAppData) candidates.push(path.join(localAppData, dirName, 'pending', 'orgtree-installer.log'))
    } catch { /* unpackaged, or no feed config */ }
    candidates.push(path.join(os.tmpdir(), 'orgtree-installer.log'))
    return candidates
  }
  /** Fold the installer's own tail into the application log. Bounded to the last
   *  few lines and recorded one line per entry, because each entry is sanitized
   *  and length-capped on the way in — a single blob would be truncated exactly
   *  where the interesting end of it is. */
  const ingestInstallerLog = (): string | undefined => {
    for (const file of installerLogCandidates()) {
      try {
        if (!fs.existsSync(file)) continue
        const lines = installerLogTail(fs.readFileSync(file, 'utf8'))
        if (!lines.length) continue
        updateLog.record('installer-log', `from ${file}`)
        for (const line of lines) updateLog.record('installer-log', line)
        return file
      } catch { /* try the next candidate */ }
    }
    return undefined
  }
  /** WHERE THE INSTALLER ITSELF BELIEVES THIS INSTALLATION LIVES — RECORDED,
   *  NOT ACTED ON.
   *
   *  ⚠ NOTHING BRANCHES ON THIS. It was read in order to decide whether a
   *  whitespace-bearing /D= could be replaced by letting NSIS resolve its own
   *  registered location; the fixture then showed the quoted argument reaches
   *  the right destination anyway, so that change was withdrawn. What is left is
   *  a diagnostic: an incident log that says where the app was running from AND
   *  where the installer believes the installation lives can distinguish a
   *  disagreement that no log could show before.
   *
   *  ⚠ NOT THE UNINSTALL KEY. electron-builder writes InstallLocation on its
   *  APPLICATION key, `Software\<APP_GUID>`, and multiUser.nsh reads it from
   *  there to assign $INSTDIR. Verified read-only on this machine: the
   *  application key holds `C:\Program Files\Orgtree` while the uninstall key's
   *  InstallLocation is EMPTY, so reading the uninstall key would have produced
   *  a confident wrong answer.
   *
   *  HKLM first, then HKCU, matching the scope order the installer uses.
   *  Failure leaves it undefined and nothing depends on it either way — a read
   *  that did not answer must not become a fact about the installation. */
  let registeredInstallLocation: string | undefined
  const readRegisteredInstallLocation = () => new Promise<void>(resolve => {
    if (process.platform !== 'win32' || !updatesSupported) return resolve()
    const roots = ['HKLM', 'HKCU']
    const next = (index: number): void => {
      if (index >= roots.length) {
        updateLog.record('updater', 'registered install location: not found in HKLM or HKCU')
        return resolve()
      }
      execFile('reg', ['query', `${roots[index]}\\SOFTWARE\\${uninstallRegistryGuid(appId)}`, '/v', 'InstallLocation'],
        { timeout: 4000, windowsHide: true }, (error, stdout) => {
          const value = error ? '' : (/InstallLocation\s+REG_[A-Z_]+\s+(.+)/.exec(String(stdout))?.[1] ?? '').trim()
          if (value) {
            registeredInstallLocation = value
            updateLog.record('updater', `registered install location (${roots[index]}): ${value}`)
            return resolve()
          }
          next(index + 1)
        })
    }
    next(0)
  })
  const cancelUpdateWatchdog = () => { if (updateExitWatchdog) clearTimeout(updateExitWatchdog); updateExitWatchdog = undefined }
  /** Put the app back after a shutdown that must not complete. `quitting` is
   *  latched by then, which is what makes every app.quit() a no-op, so leaving
   *  it set is the 2.0.3 wedge by another route. */
  /** The installer's own file name, lower-cased — the ONLY image that proves
   *  the update is really running. Empty when electron-updater cannot name the
   *  file, which the caller treats as "no proof is obtainable" rather than as
   *  a failure: see the fallback in sampleInstallerProcesses. */
  const installerImageName = (): string => {
    try {
      const file = (autoUpdater as unknown as { installerPath?: string }).installerPath
      return file ? path.basename(file).toLowerCase() : ''
    } catch { return '' }
  }
  /** One look at the process table, as `awaitInstallerProof` wants it.
   *
   *  ⚠ elevate.exe IS NOT A SUBSTITUTE for the installer. It is the UAC broker,
   *  and it is alive for the whole time the prompt is on screen — so treating
   *  it as proof would report success in exactly the case where the user is
   *  about to click No.
   *
   *  One `tasklist` per look rather than one per image: the cost is a process
   *  spawn either way, and asking twice doubles it for no extra truth.
   *
   *  ⚠ A FAILED LISTING REPORTS ITSELF AS UNREADABLE, and that distinction is
   *  the whole safety of this. `tasklist` can time out or be blocked, and an
   *  empty result is then indistinguishable from a clean "nothing is running" —
   *  which is the opposite claim. Reported as `readable: false`, the verdict
   *  refuses to conclude anything from it; reported as an empty listing, two
   *  hung looks would burn the appear bound and declare a perfectly healthy
   *  install dead. A listing is only believed when it parsed into at least one
   *  process, because a successful `tasklist` always lists many. */
  const sampleInstallerProcesses = (installerImage: string) => async () => {
    const listing = await new Promise<string>(resolve => {
      execFile('tasklist', ['/NH', '/FO', 'CSV'], { windowsHide: true, timeout: 4000, maxBuffer: 8 << 20 },
        (error, stdout) => resolve(error ? '' : String(stdout)))
    })
    const running = new Set<string>()
    for (const line of listing.split(/\r?\n/)) {
      const name = /^"([^"]+)"/.exec(line)?.[1]
      if (name) running.add(name.toLowerCase())
    }
    return {
      installerRunning: !!installerImage && running.has(installerImage),
      elevatorRunning: running.has('elevate.exe'),
      readable: running.size > 0,
    }
  }
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
  /** Whatever electron-updater has reported SO FAR, consumed. Synchronous,
   *  because the proof loop asks between looks rather than waiting on it — the
   *  waiting is the loop's job and it has better reasons to stop. */
  const takeInstallError = (): unknown => {
    if (lastInstallError === undefined) return undefined
    const seen = lastInstallError
    lastInstallError = undefined
    return seen
  }
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
  /** THE ONE WAY A CHECK IS STARTED. The tray item, the renderer's Settings
   *  button and the engine-issued maintenance flow all come through here, so
   *  the refusal below cannot be bypassed by adding another caller. (The
   *  periodic tick is the fourth route and needs no guard of its own: it
   *  already returns while anything is prepared or downloading, and an
   *  application attempt can only begin from a prepared package.)
   *
   *  Refused, not queued, while an attempt is under way: a check that accepted
   *  a newer release would delete the very package being installed. Together
   *  with `updateBusy` refusing the install while a check is in flight, the two
   *  operations exclude each other in both directions. */
  // Without update support there is nothing to ask: answered 'unavailable'
  // without disturbing the controller, so Settings' button gets an honest
  // response instead of an "up to date" no feed could have established.
  const checkForUpdates = async () => !updatesSupported ? { state: 'unavailable' } as UpdateStatus
    : (updateApplying || quitting) ? updater.current() : updater.check()
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
    // Held across the handoff so the proof below can ask the SAME preparation
    // whether its fixture finished, and whether its child reported an error.
    let preparedFixture: PreparedFixture | undefined
    const fixtureToken = randomUUID()
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
      handOff: () => {
        // THE COMPOSITION LIVES IN prepareUpdateFixture, NOT HERE. An earlier
        // revision assembled it inline and a reviewer's extraction of this very
        // callback found three defects that unit tests of the pieces all
        // passed through: the receipt path was never given to the child, a
        // stale receipt plus a failed delete fabricated success, and the child
        // had no error listener so an async ENOENT threw. Keeping this thin is
        // what makes the composition testable.
        preparedFixture = prepareUpdateFixture({
          requested: process.env[UPDATE_FIXTURE_ENV],
          // UNIQUE PER ATTEMPT, so a receipt from an earlier attempt cannot be
          // read as this one's and nothing has to be deleted to make that true.
          receiptPath: path.join(app.getPath('userData'), `update-fixture-${fixtureToken}.txt`),
          token: fixtureToken,
          io: fs,
          spawn: (file, args, options) => spawnProcess(file, args, {
            // Detached and stdio-ignored, the shape electron-updater uses for
            // the real installer: the point of the fixture is that process
            // ancestry and survival can be compared, so a differently parented
            // child would answer a different question.
            detached: true, stdio: 'ignore', windowsHide: true,
            env: { ...process.env, ...options.env },
          }),
        })
        const decision = preparedFixture.decision
        // A REFUSAL IS RECORDED. A stray variable in an operator's environment
        // must change nothing, and must not change nothing INVISIBLY.
        if (decision.kind === 'refused') {
          updateLog.record('update-fixture-refused', decision.reason,
            { from: app.getVersion(), to: version })
        }
        // NOT a refusal: the ordinary update went ahead. Recorded so a stray
        // variable that changed nothing is still readable as having changed
        // nothing, which is the whole reason a production build ignores it
        // rather than declining.
        if (decision.kind === 'ignored') {
          updateLog.record('update-fixture-ignored', decision.reason,
            { from: app.getVersion(), to: version })
        }
        if (decision.kind === 'active') {
          updateLog.record('update-fixture-handoff',
            `handing off to the update fixture at [${decision.installer}] instead of the `
            + 'downloaded installer; this is a rehearsal and did not install anything',
            { from: app.getVersion(), to: version })
        }
        // ⚠ `attempt`, NOT `handoff`. A REFUSED rehearsal must DECLINE, never
        // fall through to a real installation: someone who set the fixture
        // variable is saying 'do not really update', and answering a missing
        // fixture by installing for real is the worst outcome this code can
        // produce. `attempt` is undefined only when nothing was requested, which
        // is the case that keeps ordinary production behaviour untouched.
        return installDownloadedUpdate(
          autoUpdater as unknown as InstallableUpdater, installDirectory(),
          preparedFixture.attempt)
      },
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
    // The installer was LAUNCHED, which is not the same as succeeded — and
    // "launched" is itself weaker than it sounds. `install()` returning true
    // means electron-updater got a PID BACK (BaseUpdater.spawnLog resolves on
    // `p.pid !== undefined`), which says a process object was created and
    // nothing more. The only failure it can report is a spawn-time 'error'; a
    // process that STARTS AND THEN DIES emits nothing at all. So waiting a few
    // quiet seconds and then quitting is exactly how an update disappeared:
    // the app closed, the installer never ran, and the log said 'handoff'.
    //
    // The exit now waits for a VERDICT instead. See awaitInstallerProof.
    //
    // ⚠ THE WATCHDOG IS CANCELLED FIRST, and that is not a loosening. It was
    // sized for a sequence with no human in it and ends in app.exit(1); the
    // wait below can legitimately outlast it, because a Windows permission
    // prompt takes as long as the person takes. Killing the app there would
    // destroy the very update it exists to protect. The loop is the new bound,
    // and it is bounded everywhere a bound is honest.
    cancelUpdateWatchdog()
    /** ⚠ NO PROOF IS OBTAINABLE, so do not manufacture a verdict. Two different
     *  things land here and they are the same state: the library would not name
     *  the file it launched, or the process table could not be read at all.
     *  Either way "no process by that name is running" is a statement about our
     *  ignorance, not about the installer, and failing on it would turn working
     *  updates into false alarms. Fall back to the old behaviour — the short
     *  grace for a reported spawn error, then exit — and SAY SO in the log, so
     *  an unproven exit is distinguishable from a proven one. */
    const exitWithoutProof = async () => {
      const spawnFailure = await awaitInstallError(UPDATE_SPAWN_GRACE_MS)
      if (spawnFailure !== undefined) {
        updateLog.record('handoff-refused', spawnFailure)
        updateLog.record('not-installed', 'the installer could not be started', { from: app.getVersion(), to: version })
        app.relaunch(); app.exit(0)
        return
      }
      app.quit()
    }
    // ⚠ WATCH THE IMAGE THAT WAS ACTUALLY LAUNCHED. The proof used to take
    // electron-updater's downloaded installer name unconditionally, so after
    // a fixture handoff it watched a process that was never started and
    // reported installer-never-started while the fixture was alive. The
    // handoff says what it launched; that is what gets watched.
    const handedOffFixture = outcome.handoff.fixture
    const installerImage = handedOffFixture
      ? path.basename(handedOffFixture).toLowerCase()
      : installerImageName()
    if (!installerImage) {
      updateLog.record('installer-proof-unavailable',
        'electron-updater did not expose the installer path, so its process could not be identified', { from: app.getVersion(), to: version })
      await exitWithoutProof()
      return
    }
    const proof = await awaitInstallerProof({
      sample: sampleInstallerProcesses(installerImage),
      now: () => Date.now(),
      sleep: (ms) => new Promise<void>(resolve => { setTimeout(resolve, ms).unref?.() }),
      record: (stage, detail) => { updateLog.record(stage, detail, { from: app.getVersion(), to: version }) },
      // the one failure electron-updater CAN tell us about, folded in so the
      // wait ends on it rather than running out a bound for something already
      // known not to be coming
      // THE FIXTURE'S OWN SPAWN FAILURE MUST END THE WAIT TOO. takeInstallError
      // carries only electron-updater's errors, so a fixture that could not be
      // executed reported nothing here and the wait ran out its bound.
      reportedError: () => preparedFixture?.spawnError() ?? takeInstallError(),
      // Only a fixture handoff supplies this, so a real installer that dies
      // instantly still fails exactly as before. The completion check is
      // content-validated against this attempt's token inside the
      // preparation, never a bare existsSync.
      ...(preparedFixture?.handoff
        ? { fixtureCompleted: () => preparedFixture?.completed() === true }
        : {}),
    })
    if (proof.verdict === 'unknown') {
      // The process table could never be read, so we did not observe an absent
      // installer — we failed to observe anything. That is ignorance, not
      // failure, and it takes the unproven exit rather than telling the user an
      // update died when it may well be running. awaitInstallerProof has
      // already recorded 'installer-proof-unavailable' with the reason.
      await exitWithoutProof()
      return
    }
    if (proof.verdict === 'failed') {
      // Unlike the unconfirmed-stop path, the engine here IS confirmed gone, so
      // carrying on in place would leave a running app with a dead engine.
      // Relaunch into a working one, exactly as a declined handoff does.
      // ⚠ AND SAY SO — BUT NOT FROM HERE, AND THIS IS THE THIRD SHAPE THIS
      // BRANCH HAS HAD, so the reasoning is worth keeping.
      //
      // It began as `void dialog.showMessageBox(...)` followed by app.exit(0).
      // That never presented anything: app.exit force-exits on the next
      // statement. Measured with real Electron — the awaited form shows one
      // window, the un-awaited form showed ZERO across four runs, the process
      // gone in 67-224ms. So a failure the user never sees, which is the
      // original complaint wearing a quieter hat.
      //
      // Awaiting it presents the dialog and then BLOCKS THE RELAUNCH until
      // somebody clicks. This branch is reachable from the AUTOMATIC idle path
      // (applyDownloadedUpdate(automatic) via the idle timer), so that is an
      // empty room at 3am holding the restart until morning: a new way for
      // Orgtree to go away and not come back, again through the fix for it.
      //
      // So the exit tells NOBODY and waits for NOTHING. It records the failure
      // and relaunches at once; the instance that comes back reports it, where
      // there is a running app and usually a person. See
      // updateFailureToReport, and the report site in the startup sequence.
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
    if (!downloaded || !updatesSupported) throw new Error('No downloaded update is ready to install.')
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
    // Routed through the SAME guarded lifecycle as every other check rather
    // than calling the library directly. It used to read the downloadPromise
    // that autoDownload created for it, which no longer exists now that the
    // download is started deliberately; going through the controller also
    // means this path cannot start a check during an install, cannot race a
    // second check against the first, and leaves the same state behind.
    check: async () => {
      if (!updatesSupported) return 'unavailable'
      try {
        const status = await checkForUpdates()
        // 'pending-idle' is a package ALREADY prepared: maintenance only asks
        // when there is none, but if one appears it is the same answer -
        // something is on its way, ask again next tick.
        if (status.state === 'downloading' || status.state === 'pending-idle') return 'pending'
        return status.state === 'up-to-date' ? 'up-to-date' : 'unavailable'
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
    automaticEnabled: () => updatesSupported && preferences.get().automaticUpdates,
    preparedInstallFailed: () => updateAttemptFailed(updateLog.lastAttempt(), app.getVersion()),
    // electron-updater's own update-available/update-not-available events are the
    // authoritative "is this actually newer" answer (channel/prerelease/downgrade
    // rules included) - comparing version strings here would get an older or
    // disallowed release wrong by treating any difference as an update.
    run: () => updatesSupported ? checkForUpdatesViaEvents(autoUpdater) : Promise.resolve({ hasUpdate: false }),
    // autoDownload is off, so this is the only thing that starts a transfer -
    // and therefore the only thing that lets electron-updater delete a package
    // already prepared. The controller calls it only after judging the offer
    // against what is prepared.
    download: () => autoUpdater.downloadUpdate().then(() => {}),
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
  app.on('second-instance', (_event, commandLine) => {
    // A second installed process is the upgrade helper's graceful control
    // request. It reaches the primary instance, whose dedicated refusal-safe
    // lifecycle stops the engine and persists layout before exit.
    if (hasInstallerUpgradeRequest(commandLine)) { void requestInstallerUpgradeShutdown(); return }
    show()
  })
  app.on('activate', show)
  app.on('window-all-closed', () => { /* Tray/main remain alive by default. */ })
  // ---------------------------------------------------- console signals
  // A CONSOLE CLOSING MUST NOT KILL THIS PROCESS COLD (user report: closing a
  // console window they had not opened made Orgtree exit immediately).
  //
  // ⚠ WHAT THIS CAN AND CANNOT DO, because the difference matters and the
  // honest half is easy to overstate. On Windows, Node raises SIGHUP when a
  // console the process is ATTACHED to is closed, SIGINT on Ctrl+C and
  // SIGBREAK on Ctrl+Break. With NO listener installed — which is what this
  // file had, for all three — the default disposition terminates the process
  // at once: no layout flush, no graceful engine stop, provider logins left
  // orphaned. Installing a listener does NOT make the process immortal; for a
  // console close Windows still terminates it after a few seconds' grace. What
  // it buys is that the grace is USED, so the exit is the same orderly one a
  // tray Quit performs instead of a hard kill.
  //
  // ⚠ AND FOR THE INSTALLED SHAPE, NOTHING ARRIVES HERE AT ALL. A packaged
  // Orgtree launched from a shortcut is a child of explorer.exe with no console
  // of its own (measured, 2026-09-14), so no console close can reach it and
  // these handlers never fire. They exist for every OTHER way the process can
  // end up attached to one — started from a terminal, from a script, or from a
  // launcher that owns a console — which is precisely the set of cases nobody
  // has been able to enumerate.
  //
  // Routed through app.quit() rather than doing the work here, so there is ONE
  // shutdown sequence and this cannot drift from it.
  for (const signal of ['SIGHUP', 'SIGINT', 'SIGBREAK'] as const) {
    try {
      process.on(signal, () => {
        // Recorded before anything else: an exit nobody could explain is how
        // this arrived, and the log is the only thing that outlives it.
        try { updateLog.record('startup', `shutting down on ${signal} — a console this process was attached to closed, or was interrupted`) } catch { /* never worth failing the shutdown over */ }
        app.quit()
      })
    } catch { /* a platform without this signal simply has no handler */ }
  }

  app.on('before-quit', event => {
    if (quitComplete) return
    if (installerUpgradeShutdown) { event.preventDefault(); return }
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
    //
    // ⚠ stopForQuit, NOT stop(). This handler is the ONLY thing a tray-menu
    // Quit runs, and stop() returns immediately for an ATTACHED boot engine —
    // which is why quitting left the engine, its guardian and every provider
    // child running until the machine was rebooted. The update path does not
    // come through here at all (prepareAndHandOff sets quitComplete before its
    // own app.quit()), so this cannot disturb an install.
    void bounded(saveWindowLayout(), UPDATE_LAYOUT_MS)
      .then(() => bounded(engine.stopForQuit(QUIT_STOP_BUDGET_MS), QUIT_ENGINE_TOTAL_MS))
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
    // Deliberately NOT the desktop:window-* handlers above: those act on the
    // main window, and a popout's controls must never reach it.
    handle('desktop:popout-state', name => typeof name === 'string' ? popouts.state(name) : null)
    handle('desktop:popout-minimize', name => { popouts.window(name)?.minimize() })
    handle('desktop:popout-toggle-maximize', name => {
      const window = popouts.window(name)
      if (!window) return
      if (window.isMaximized()) window.unmaximize(); else window.maximize()
    })
    handle('desktop:popout-close', name => { popouts.window(name)?.close() })
    // "Show desk"/"Show window" on a popped-out surface's placeholder, and
    // (2026-09-14) a presentation card whose document is already in one of
    // these windows. See revealPopout for why the order matters.
    handle('desktop:popout-focus', name => { revealPopout(popouts.window(name)) })
    handle('desktop:preferences', () => preferences.get())
    handle('desktop:set-preferences', value => setPreferences(value))
    handle('desktop:set-effective-theme', value => setEffectiveTheme(value))
    handle('desktop:show', () => show())
    handle('desktop:quit', () => { app.quit() })
    handle('desktop:harnesses', () => detectHarnesses())
    handle('desktop:notify', value => {
      if (!Notification.isSupported()) return false
      return notifications.notify(value, preferences.get())
    })
    handle('desktop:sync-notifications', value => notifications.sync(value))
    handle('desktop:pending-attention', value => { taskbarAttention.set(attentionIdentities(value)) })
    handle('desktop:open-harness', id => {
      if (typeof id !== 'string' || !Object.hasOwn(HARNESS_LINKS, id)) throw new Error('Unknown harness')
      return shell.openExternal(HARNESS_LINKS[id as keyof typeof HARNESS_LINKS])
    })
    handle('desktop:open-charter-folder', async () => {
      const dir = path.join(os.homedir(), '.orgtree', 'charters')
      try {
        if (fs.existsSync(dir)) {
          const stat = fs.statSync(dir)
          if (!stat.isDirectory()) {
            return { ok: false, error: `Charter path exists but is not a directory: ${dir}` }
          }
        } else {
          fs.mkdirSync(dir, { recursive: true })
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return { ok: false, error: `Could not create charter directory: ${message}` }
      }
      try {
        const errorMsg = await shell.openPath(dir)
        if (errorMsg) {
          return { ok: false, error: `Could not open charter directory: ${errorMsg}` }
        }
        return { ok: true, path: dir }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return { ok: false, error: `Could not open charter directory: ${message}` }
      }
    })
    // ⚠ REVEAL, NEVER OPEN, AND NEVER `shell.openPath` HERE (user ruling,
    // 2026-09-13). These paths arrive from markdown an AGENT wrote, so opening
    // one the way a double-click does would make any link in chat a one-click
    // way to RUN a program — the reported example was an installer.
    // `showItemInFolder` selects the file in the OS file manager and can
    // launch nothing. Swapping it for a launcher reverses a decision the user
    // made on that argument; it is not an implementation detail.
    handle('desktop:reveal-file', value => {
      if (typeof value !== 'string' || !value) return { ok: false, error: 'No path given' }
      const target = path.normalize(value)
      // absolute only: a relative path here has no meaningful base, and
      // resolving it against this process's cwd would reveal something the
      // author never named
      if (!path.isAbsolute(target)) return { ok: false, error: `Not an absolute path: ${value}` }
      // report a missing file rather than silently doing nothing — on Windows
      // showItemInFolder is a no-op for a path that is not there, which reads
      // to the user as a dead link
      if (!fs.existsSync(target)) return { ok: false, error: `No such file: ${target}` }
      shell.showItemInFolder(target)
      return { ok: true }
    })
    handle('desktop:update-status', () => updater.current())
    handle('desktop:update-capability', () => ({ unattendedInstall: canInstallUnattended(), installDirectory: installDirectory() }))
    handle('desktop:check-for-updates', () => checkForUpdates())
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
      // Windows cancels a taskbar flash on activation; tell the controller so
      // a later arrival can pulse again without the poll restarting this one.
      main.on('focus', () => taskbarAttention.focused())
      configureWindow(main, () => engine.origin, true, register, openArtifact, undefined, popouts.track)
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
      engineReady = true
      if (installerUpgradePending) void requestInstallerUpgradeShutdown()
      if (!process.argv.includes('--background')) show()
      if (!process.argv.includes('--background') && !detectHarnesses().some(h => h.detected)) await dialog.showMessageBox(main, { type: 'info', message: 'No agent harness was detected.', detail: 'Install Claude Code, Codex, or Antigravity using the official setup links in the tray menu. Orgtree does not install or sign in to harnesses.' })
      const refresh = async () => {
        if (quitting || installerUpgradeShutdown) return
        // Native timers keep running when Chromium throttles a hidden window.
        // Wake only the attention read; leave ordinary UI polling unchanged.
        broadcast({ type: 'notification-poll', data: null })
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
      if (updatesSupported) {
        // THE PRIVATE FEED REPLACES THE PACKAGED ONE, and only a build composed
        // for rehearsal can reach this at all: on a released build the decision
        // is 'default' or 'ignored' and this branch never runs, so the packaged
        // release feed is what a real installation keeps using.
        if (updateFeed.kind === 'private') {
          autoUpdater.setFeedURL({ provider: 'generic', url: updateFeed.url })
          // ⚠ ADMITTING THE FEED URL IS NOT ISOLATION. Review measured two
          // escapes past a URL check with the real client: a manifest may name
          // an ABSOLUTE artifact URL on any host, and a loopback manifest may
          // answer 302 toward one — and the executor follows redirects. Both
          // defeat a check on the string that was admitted.
          //
          // So the confinement is at the transport boundary the client actually
          // uses: every request it makes, of every kind, and every redirect it
          // follows, is created through this executor. Nothing a feed says can
          // route around it. Production never reaches this branch.
          // ⚠ DIFFERENTIAL AND MULTIPLE-RANGE DOWNLOADS ARE TURNED OFF FOR A
          // REHEARSAL, and this is not tidiness. Those paths follow redirects
          // that Electron handles INTERNALLY, with no hook the confinement can
          // reach — review measured DifferentialDownloader following an external
          // URL on an already-created request while the guard saw one loopback
          // creation and zero blocks. A guard that silently misses a path is
          // worse than no guard, so the path is removed rather than trusted.
          // A released build is unaffected: it never reaches this branch and
          // keeps differential downloads.
          ;(autoUpdater as unknown as { disableDifferentialDownload?: boolean })
            .disableDifferentialDownload = true
          // ⚠ AND WEB INSTALLERS ARE REFUSED OUTRIGHT, because disabling
          // differential downloads does NOT cover them. Review measured that
          // NsisUpdater still calls differentialDownloadWebPackage for a web
          // package even with disableDifferentialDownload true — that function
          // never consults the flag — and its byte reads build request options
          // that leave redirect mode unset, so Electron follows redirects
          // automatically with no event to intercept.
          //
          // With this set, the library throws ERR_UPDATER_WEB_INSTALLER_DISABLED
          // BEFORE any download begins, which is the narrow rejection the
          // reviewer asked for: a rehearsal has no business fetching a web
          // installer, and refusing the offer is stronger than policing its
          // downloads. A released build never reaches this branch.
          ;(autoUpdater as unknown as { disableWebInstaller?: boolean })
            .disableWebInstaller = true
          const executor = (autoUpdater as unknown as { httpExecutor?: unknown }).httpExecutor
          if (executor && typeof (executor as { createRequest?: unknown }).createRequest === 'function') {
            confineExecutorToLoopback(executor as Parameters<typeof confineExecutorToLoopback>[0],
              (host) => updateLog.record('update-feed-escape-blocked',
                `the update client tried to reach [${host}] while confined to the isolated `
                + 'loopback feed; the request was blocked before any external connection',
                { from: app.getVersion(), to: app.getVersion() }))
          } else {
            // ⚠ NO EXECUTOR MEANS NO CONFINEMENT, AND THAT MUST NOT BE SILENT.
            // A rehearsal that cannot be confined is one that might leave the
            // machine, so it does not run: this is the same refusal shape the
            // feed decision uses, applied to the enforcement rather than the URL.
            throw new Error('the update client exposes no HTTP executor to confine, so an '
              + 'isolated rehearsal cannot be guaranteed; refusing to check for updates')
          }
          updateLog.record('update-feed-private',
            `checking an isolated loopback feed at [${updateFeed.url}] instead of the `
            + 'packaged release feed; this build is composed for rehearsal',
            { from: app.getVersion(), to: app.getVersion() })
        }
        autoUpdater.autoInstallOnAppQuit = false
        autoUpdater.allowPrerelease = true
        // ⚠ THE OFFER MUST BE JUDGED BEFORE ANYTHING IS DELETED. Left on,
        // electron-updater starts downloading inside doCheckForUpdates itself,
        // and its first act is to empty its pending directory whenever the
        // feed's checksum differs from the cached one - so by the time any
        // listener of ours runs, a package we wanted to keep is already gone.
        // Its "is there an update" answer compares against the RUNNING version,
        // which says yes to the identical release and to a rolled-back older
        // one, so leaving the decision to the library means losing a prepared
        // update to a release no newer than it. UpdateController judges the
        // offer and calls downloadUpdate() itself.
        autoUpdater.autoDownload = false
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
      }
      // Awaited deliberately: canInstallUnattended must not answer before the
      // scope is known, and the first refresh must not run before either.
      await readInstallScope()
      // ⚠ AWAITED FOR THE SAME REASON, AND IT IS LOAD-BEARING. An undefined
      // registered location is treated as "not confirmed", which REFUSES a
      // whitespace-bearing silent install. If this had not answered before the
      // idle path could fire, a perfectly updatable machine would be held on
      // the strength of a read that simply had not finished yet.
      await readRegisteredInstallLocation()
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
      // ⚠ WHERE A FAILED UPDATE IS ACTUALLY REPORTED. The exit could not do it:
      // an un-awaited dialog is never presented before app.exit, and an awaited
      // one blocks the relaunch on the unattended path. This runs in a live app
      // instead, so nothing is holding a lifecycle open while it waits.
      //
      // ⚠ TWO RECORDS, BECAUSE SHOWN AND DELIVERED ARE DIFFERENT THINGS.
      // 'failure-report-shown' is written now, and bounds how many launches may
      // repeat an unacknowledged message. 'failure-reported' is written when the
      // user actually DISMISSES it, which is the only evidence anybody was told:
      // writing that one up front would have produced a record saying "reported"
      // for a dialog nobody ever saw, and there is no second surface to catch it
      // (the tray hold exists only in the session that consumed it).
      const failedUpdate = updateFailureToReport(updateLog.lastAttempt(), app.getVersion())
      if (failedUpdate) {
        // ⚠ THE INSTALLER'S OWN RECORD IS COPIED IN FIRST, so the file the
        // message points at contains both halves of the story by the time
        // anybody opens it. On the machine that failed, the application's log
        // ended at 'handoff' and there was nothing else anywhere.
        const installerLog = ingestInstallerLog()
        updateLog.record('failure-report-shown', 'the previous failure was put on screen')
        void showUpdateFailure('Orgtree did not install the update.',
          `${failedUpdate.detail}\n\nOrgtree restarted and is running normally, still on ${app.getVersion()}${failedUpdate.to ? ` rather than ${failedUpdate.to}` : ''}. The update is still ready — try again from the tray.`
            + `\n\nThe full record is in update-log.json beside Orgtree's data`
            + (installerLog ? `, and now includes the installer's own log from ${installerLog}.` : '. The installer left no log of its own this time.'), 'warning')
          .then(() => { updateLog.record('failure-reported', 'the user dismissed the failure report') })
          .catch(() => { /* never shown, so never recorded as delivered: it repeats */ })
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
