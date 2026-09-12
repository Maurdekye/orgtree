import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '..')
const read = file => fs.readFileSync(path.join(root, file), 'utf8')

test('the update controller is wired end to end: contracts, preload, main process, and the tray', () => {
  const contracts = read('packages/contracts/index.ts')
  const preload = read('apps/desktop/preload/index.ts')
  const main = read('apps/desktop/main/index.ts')

  assert.match(contracts, /getUpdateStatus\(\): Promise<UpdateStatus>/)
  assert.match(contracts, /checkForUpdates\(\): Promise<UpdateStatus>/)

  assert.match(preload, /getUpdateStatus: \(\) => ipcRenderer\.invoke\('desktop:update-status'\)/)
  assert.match(preload, /checkForUpdates: \(\) => ipcRenderer\.invoke\('desktop:check-for-updates'\)/)

  // Pin the names that must come from the controller module, not the exact
  // spelling of a line that legitimately grows: this assertion had been failing
  // on main ever since refreshTrayUpdateMenu joined the same import.
  const updaterImport = main.match(/import \{([^}]*)\} from '\.\/updater'/)
  assert.ok(updaterImport, 'the main process must import from ./updater')
  for (const name of ['checkForUpdatesViaEvents', 'installDownloadedUpdate', 'UpdateController', 'prepareAndHandOff', 'UpdateLog', 'updateLogger', 'bounded', 'installDirectoryWritable']) {
    assert.ok(updaterImport[1].split(',').map(part => part.trim()).includes(name), `main must import ${name}`)
  }
  // the install directory is still the RUNNING install's own directory
  assert.match(main, /const installDirectory = \(\) => path\.dirname\(process\.execPath\)/)
  assert.match(main, /installDownloadedUpdate\(autoUpdater as unknown as InstallableUpdater, installDirectory\(\)\)/)
  assert.match(main, /new UpdateController\(/)
  // the availability answer must come from electron-updater's own events, not a
  // hand-rolled version-string comparison (an older/disallowed release could
  // differ from the running version too, and a naive `!==` would call that "available").
  // Note: the SEPARATE, pre-existing MaintenanceController `check` callback below
  // still does its own version comparison for the engine-issued-maintenance flow -
  // that is a different, untouched code path and out of scope here.
  // ...and gated on updatesSupported, not app.isPackaged: a packaged
  // DEV-CHANNEL install (docs/dev-builds.md) has no feed and must not touch
  // the library, the release's install scope, or its registry.
  assert.match(main, /run: \(\) => updatesSupported \? checkForUpdatesViaEvents\(autoUpdater\) : Promise\.resolve\(\{ hasUpdate: false \}\)/)
  assert.match(main, /if \(process\.platform !== 'win32' \|\| !updatesSupported\) return resolve\(\)/,
    'a build without update support must never probe the uninstall registry scope')
  assert.match(main, /\r?\n      if \(updatesSupported\) \{\r?\n        autoUpdater\.autoInstallOnAppQuit = false/,
    'the electron-updater listeners exist only where updates are supported')
  assert.doesNotMatch(main, /app\.isPackaged \? checkForUpdatesViaEvents/,
    'no update path may gate on app.isPackaged alone any more')
  assert.match(main, /handle\('desktop:update-status', \(\) => updater\.current\(\)\)/)
  // ---- checking while an installer is prepared (user 2026-09-11) ----
  // THE DECISION MUST PRECEDE THE DOWNLOAD. electron-updater judges an offer
  // against the RUNNING version, so with a package prepared it calls the very
  // same release "available" - and accepting deletes what is on disk, as
  // tests/updater-library.test.mjs observes against the real library. Left to
  // autoDownload the deletion happens inside checkForUpdates itself, before any
  // listener of ours could weigh in, so the download must be ours to start.
  assert.match(main, /autoUpdater\.autoDownload = false/,
    'autoDownload starts the transfer inside doCheckForUpdates, which is too early for any decision of ours')
  assert.match(main, /download: \(\) => autoUpdater\.downloadUpdate\(\)\.then\(\(\) => \{\}\)/)

  // ONE guarded entry point. A second caller reaching updater.check() directly
  // would reopen the race this closes, so the tray, the renderer IPC and the
  // engine-issued maintenance flow must all go through the same function.
  assert.match(main, /const checkForUpdates = async \(\) => !updatesSupported \? \{ state: 'unavailable' \} as UpdateStatus\r?\n\s*: \(updateApplying \|\| quitting\) \? updater\.current\(\) : updater\.check\(\)/)
  assert.match(main, /handle\('desktop:check-for-updates', \(\) => checkForUpdates\(\)\)/)
  assert.match(main, /label: 'Check for updates', click: \(\) => \{ void checkForUpdates\(\)\.catch\(\(\) => \{\}\) \}/)
  assert.match(main, /check: async \(\) => \{[\s\S]*?const status = await checkForUpdates\(\)/,
    'the maintenance check must not call the library directly: that route bypassed every guard here')
  assert.doesNotMatch(main, /const result = await autoUpdater\.checkForUpdates\(\)/,
    'and it must no longer read the downloadPromise autoDownload used to create for it')
  const directChecks = main.match(/updater\.check\(\)/g) ?? []
  assert.equal(directChecks.length, 1, 'updater.check() must be reached through checkForUpdates() and nowhere else')

  // Nothing may be handed to the installer while a check or a download is in
  // flight; nothing may start a check while an attempt is under way. The two
  // guards together make the operations exclusive in both directions.
  assert.match(main, /const updateBusy = \(\) => updateReplacementInFlight\(updater\.current\(\)\)/)
  assert.match(main, /if \(updateBusy\(\)\) return\r?\n\s*updateApplying = true/,
    'the idle automatic path reaches applyDownloadedUpdate on its own every five seconds')
  assert.match(main, /if \(updateBusy\(\)\) throw new Error\('Orgtree is checking for a newer update/,
    'an explicit Update now must be refused with a reason the renderer can show, not silently')

  // the real electron-updater events must reach the controller, not bypass it
  // with their own ad-hoc broadcast (that was the pre-refactor shape, and the
  // whole point of the controller is to own state/backoff/coalescing alone)
  // The error must still reach the controller, but it must no longer be THROWN
  // AWAY on the way: errored() is deliberately a no-op outside a download, so
  // an install-stage failure used to leave no trace anywhere at all.
  assert.match(main, /autoUpdater\.on\('error', error => \{/)
  assert.match(main, /updateLog\.record\('error', error\)/)
  assert.match(main, /updater\.errored\(\)/)
  // the event's own version must reach the controller: a cached package can be
  // reported downloaded before any check resolves, and discarding it there
  // leaves the target version unknown on a perfectly ordinary download
  assert.match(main, /autoUpdater\.on\('update-downloaded', info => \{/)
  assert.match(main, /updater\.downloaded\(version\)/)
  assert.doesNotMatch(main, /updater\.downloaded\(\)/,
    'the update-downloaded listener must not throw the version away')
  assert.match(main, /autoUpdater\.on\('download-progress', progress => updater\.progress\(Math\.round\(progress\.percent\)\)\)/)
  assert.doesNotMatch(main, /autoUpdater\.on\('error', \(\) => \{ broadcast/,
    'the error handler must route through the controller, not broadcast a hardcoded state directly')

  // ---- the 2.0.3 hang and the shutdown-without-install ----
  // electron-updater's default logger is `console`, which a packaged Windows
  // GUI process discards. That is why both reported failures left no trace.
  assert.match(main, /autoUpdater\.logger = updateLogger\(updateLog\)/,
    'electron-updater must log somewhere the operator can actually read')
  assert.match(main, /new UpdateLog\(path\.join\(app\.getPath\('userData'\), 'update-log\.json'\)\)/)

  // Once `quitting` is latched, before-quit refuses every app.quit(), so an
  // unbounded await between that point and the handoff can only be escaped with
  // Task Manager. Both shutdown paths must therefore go through a deadline.
  assert.doesNotMatch(main, /await saveWindowLayout\(\); await engine\.stop\(\)/,
    'the update path must not await layout and engine shutdown without a deadline')
  assert.doesNotMatch(main, /void saveWindowLayout\(\)\.then/,
    'the ordinary quit path must not await the layout flush without a deadline either')
  assert.match(main, /await prepareAndHandOff\(\{/)
  assert.match(main, /bounded\(saveWindowLayout\(\), UPDATE_LAYOUT_MS\)/)
  // a resolved engine.stop() is NOT proof of death - it returns straight after
  // child.kill() - so the installer must wait on an OBSERVED exit
  assert.match(main, /confirmEngineStopped: \(\) => engine\.stoppedConfirmed\(UPDATE_ENGINE_CONFIRM_MS\)/)
  // the forced exit is derived from the budget, never written beside it
  assert.match(main, /const UPDATE_EXIT_MS = updateWatchdogMs\(\)/)
  // an abandoned shutdown must reject, or a manual Update now leaves the
  // renderer's button stuck on "Restarting..." for ever
  assert.match(main, /throw new Error\('The engine did not confirm that it stopped/)
  // ...and must release the renderer's exit latch, which otherwise stays set
  assert.match(main, /orgtree:exit-cancelled/)
  const life = read('apps/desktop/renderer/src/windowlife.ts')
  assert.match(life, /window\.addEventListener\('orgtree:exit-cancelled'/)
  assert.match(read('apps/desktop/renderer/src/windowlayout.ts'), /export const endWindowExit = \(\) => \{ exiting = false \}/)
  // install SCOPE, not just writability: an elevated process can write to an
  // all-users directory, and the user wants the control off for those anyway
  assert.match(main, /installedForAllUsers !== true && installDirectoryWritable\(installDirectory\(\)\)/)
  assert.match(main, /uninstallRegistryGuid\(appId\)/)

  // START-UP ORDER. The poll's first tick can find a cached package and begin
  // applying it, so the listeners, the install scope and any recovery hold must
  // all be established BEFORE the first refresh - not after it.
  const wiring = main.indexOf("autoUpdater.on('update-downloaded'")
  const scope = main.indexOf('await readInstallScope()')
  const hold = main.indexOf('pendingUpdateHold(updateLog.lastAttempt()')
  const firstRefresh = main.indexOf('void refresh()')
  const pollStart = main.indexOf('startPoll()\r\n')
  for (const [name, at] of [['listener wiring', wiring], ['install scope', scope], ['recovery hold', hold]]) {
    assert.ok(at > 0, `${name} must be present`)
    assert.ok(at < firstRefresh, `${name} must be established before the first refresh`)
    assert.ok(at < pollStart, `${name} must be established before the poll starts`)
  }
  // the hold is spent by its OWN durable marker, never by 'not-installed',
  // which the spawn-failure path writes before the relaunch it causes
  assert.match(main, /updateLog\.record\('hold-consumed'/)
  assert.doesNotMatch(main, /!previous\.some\(entry => entry\.stage === 'not-installed'\)/,
    "'not-installed' must not be the guard that spends the hold")

  // An unattended automatic install that provably needs elevation is HELD, not
  // performed: performing it shuts the app down and installs nothing.
  assert.match(main, /if \(unattended && !canInstallUnattended\(\)\)/)
  // decided by WRITING, because Windows access checks report the read-only
  // attribute rather than the ACL, and probed once rather than every poll

  // the same answer drives the settings row and the tray item the user asked
  // to be greyed out where nothing can install unattended
  assert.match(main, /handle\('desktop:update-capability', \(\) => \(\{ unattendedInstall: canInstallUnattended\(\)/)
  assert.match(main, /automatic\.enabled = canInstallUnattended\(\)/)
  // the engine-issued maintenance update is unattended too, so it must be
  // held by the same rule even though the preference does not govern it
  assert.match(main, /apply: \(\) => applyDownloadedUpdate\(false, true\)/)
  // ...and holding must never touch the preference or the manual route.
  assert.doesNotMatch(main, /setPreferences\(\{ automaticUpdates: false \}\)/,
    'a hold must never silently disable the user\'s automatic-update preference')
  assert.match(main, /updateHold = undefined\r?\n\s*await applyDownloadedUpdate\(\)/,
    'an explicit Update now must clear the hold and proceed')

  // long-running sessions: a periodic tick lives in the same poll loop that
  // already drives engine stats and maintenance, not a one-shot startup call
  assert.match(main, /stats = await engine\.stats\(\); rebuildTray\(\)\r?\n\s*void updater\.tick\(\)/)
  assert.doesNotMatch(main, /void autoUpdater\.checkForUpdates\(\)\.catch/,
    'the one-shot startup check is superseded by the controller\'s own tick(), which is due immediately on first call')
})
