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
  assert.match(main, /installDownloadedUpdate\(autoUpdater, installDirectory\(\)\)/)
  assert.match(main, /new UpdateController\(/)
  // the availability answer must come from electron-updater's own events, not a
  // hand-rolled version-string comparison (an older/disallowed release could
  // differ from the running version too, and a naive `!==` would call that "available").
  // Note: the SEPARATE, pre-existing MaintenanceController `check` callback below
  // still does its own version comparison for the engine-issued-maintenance flow -
  // that is a different, untouched code path and out of scope here.
  assert.match(main, /run: \(\) => app\.isPackaged \? checkForUpdatesViaEvents\(autoUpdater\) : Promise\.resolve\(\{ hasUpdate: false \}\)/)
  assert.match(main, /handle\('desktop:update-status', \(\) => updater\.current\(\)\)/)
  assert.match(main, /handle\('desktop:check-for-updates', \(\) => updater\.check\(\)\)/)

  // the real electron-updater events must reach the controller, not bypass it
  // with their own ad-hoc broadcast (that was the pre-refactor shape, and the
  // whole point of the controller is to own state/backoff/coalescing alone)
  // The error must still reach the controller, but it must no longer be THROWN
  // AWAY on the way: errored() is deliberately a no-op outside a download, so
  // an install-stage failure used to leave no trace anywhere at all.
  assert.match(main, /autoUpdater\.on\('error', error => \{/)
  assert.match(main, /updateLog\.record\('error', error\)/)
  assert.match(main, /updater\.errored\(\)/)
  assert.match(main, /autoUpdater\.on\('update-downloaded', \(\) => \{ downloaded = true; updater\.downloaded\(\) \}\)/)
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

  // An unattended automatic install that provably needs elevation is HELD, not
  // performed: performing it shuts the app down and installs nothing.
  assert.match(main, /if \(unattended && !installDirectoryWritable\(installDirectory\(\)\)\)/)
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

  assert.match(main, /label: 'Check for updates', click: \(\) => \{ void updater\.check\(\)\.catch\(\(\) => \{\}\) \}/)
})
