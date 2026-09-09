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

  assert.match(main, /import \{ checkForUpdatesViaEvents, UpdateController \} from '\.\/updater'/)
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
  assert.match(main, /autoUpdater\.on\('error', \(\) => updater\.errored\(\)\)/)
  assert.match(main, /autoUpdater\.on\('update-downloaded', \(\) => \{ downloaded = true; updater\.downloaded\(\) \}\)/)
  assert.match(main, /autoUpdater\.on\('download-progress', progress => updater\.progress\(Math\.round\(progress\.percent\)\)\)/)
  assert.doesNotMatch(main, /autoUpdater\.on\('error', \(\) => \{ broadcast/,
    'the error handler must route through the controller, not broadcast a hardcoded state directly')

  // long-running sessions: a periodic tick lives in the same poll loop that
  // already drives engine stats and maintenance, not a one-shot startup call
  assert.match(main, /stats = await engine\.stats\(\); rebuildTray\(\)\r?\n\s*void updater\.tick\(\)/)
  assert.doesNotMatch(main, /void autoUpdater\.checkForUpdates\(\)\.catch/,
    'the one-shot startup check is superseded by the controller\'s own tick(), which is due immediately on first call')

  assert.match(main, /\{ label: 'Check for updates', click: \(\) => \{ void updater\.check\(\)\.catch\(\(\) => \{\}\) \} \}/)
})
