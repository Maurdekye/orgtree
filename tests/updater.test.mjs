import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-updater-'))
const outfile = path.join(root, 'updater.cjs')
await build({ entryPoints: ['apps/desktop/main/updater.ts'], outfile, bundle: true, format: 'cjs', platform: 'node' })
const { trayUpdateState, refreshTrayUpdateMenu, UpdateController, checkForUpdatesViaEvents, installDownloadedUpdate,
  bounded, prepareAndHandOff, installDirectoryIsSafeForNsis, installDirectoryWritable, UpdateLog, updateLogger, sanitizeUpdateDetail,
  uninstallRegistryGuid, UPDATE_DEADLINES, updateWatchdogMs } = createRequire(import.meta.url)(outfile)

test('downloaded install uses the real NSIS silent-update command and relaunches into the same directory', () => {
  const { NsisUpdater } = createRequire(import.meta.url)('electron-updater/out/NsisUpdater.js')
  const { BaseUpdater } = createRequire(import.meta.url)('electron-updater/out/BaseUpdater.js')
  const calls = []
  const updater = {
    installerPath: 'C:\\Downloads\\Orgtree Setup.exe',
    spawnLog: (exe, args) => { calls.push({ exe, args }); return Promise.resolve() },
    dispatchError: error => { throw error },
    quitAndInstallCalled: false,
    downloadedUpdateHelper: { file: 'C:\\Downloads\\Orgtree Setup.exe', packageFile: null, downloadedFileInfo: { isAdminRightsRequired: false } },
    _logger: { info() {}, warn() {}, error() {} },
    doInstall(options) { return NsisUpdater.prototype.doInstall.call(this, options) },
    // the REAL BaseUpdater.install, which is what production now calls
    install(isSilent, isForceRunAfter) { return BaseUpdater.prototype.install.call(this, isSilent, isForceRunAfter) },
    quitAndInstall(isSilent, isForceRunAfter) {
      NsisUpdater.prototype.doInstall.call(this, { isSilent, isForceRunAfter, isAdminRightsRequired: false })
    },
  }
  // Both of the directories this originally used contained a space, which is
  // measurably NOT passed through intact: Windows quotes such an argument and
  // NSIS requires /D= unquoted. That case now has its own test below; these are
  // the directories for which /D= genuinely survives the command line.
  for (const directory of ['C:\\Orgtree', 'D:\\Apps\\Orgtree']) {
    updater.quitAndInstallCalled = false
    installDownloadedUpdate(updater, directory)
    assert.deepEqual(calls.at(-1), { exe: updater.installerPath,
      args: ['--updated', '/S', '--force-run', `/D=${directory}`] })
  }
  updater.quitAndInstall(false, true)
  assert.ok(!calls.at(-1).args.includes('/S'), 'the previous interactive call is a negative control')
})

function rig(overrides = {}) {
  const reports = []
  let now = 0
  const controller = new UpdateController({
    run: async () => ({ hasUpdate: false }),
    report: status => reports.push(status),
    now: () => now,
    ...overrides,
  }, overrides.options)
  return { reports, controller, advance: ms => { now += ms } }
}

test('idle status before any check', () => {
  const { controller } = rig()
  assert.deepEqual(controller.current(), { state: 'idle' })
})

test('startup check with no update reports up-to-date', async () => {
  const { controller, reports } = rig({ run: async () => ({ hasUpdate: false }) })
  await controller.tick()
  assert.deepEqual(reports, [{ state: 'checking' }, { state: 'up-to-date' }])
  assert.deepEqual(controller.current(), { state: 'up-to-date' })
})

test('startup check finding an update moves to downloading with its version', async () => {
  const { controller, reports } = rig({ run: async () => ({ hasUpdate: true, version: '2.0.0-alpha.6' }) })
  await controller.tick()
  assert.deepEqual(reports.at(-1), { state: 'downloading', version: '2.0.0-alpha.6' })
})

test('a stray progress event with no active download is ignored', () => {
  const { controller, reports } = rig()
  controller.progress(50)
  assert.deepEqual(controller.current(), { state: 'idle' })
  assert.deepEqual(reports, [])
})

test('downloaded is trusted unconditionally, since electron-updater only emits it after a real download', () => {
  const { controller, reports } = rig()
  controller.downloaded('2.0.0')
  assert.deepEqual(controller.current(), { state: 'pending-idle', version: '2.0.0' })
  assert.deepEqual(reports, [{ state: 'pending-idle', version: '2.0.0' }])
})

test('progress only applies while downloading and carries the known version', async () => {
  const { controller, reports } = rig({ run: async () => ({ hasUpdate: true, version: '2.0.0-alpha.6' }) })
  await controller.tick()
  controller.progress(10)
  controller.progress(0)
  assert.deepEqual(reports.slice(-2), [{ state: 'downloading', version: '2.0.0-alpha.6', percent: 10 }, { state: 'downloading', version: '2.0.0-alpha.6', percent: 0 }])
  controller.downloaded()
  assert.deepEqual(controller.current(), { state: 'pending-idle', version: '2.0.0-alpha.6' }, 'downloaded keeps the version already known from the check')
})

test('a real pending update is never redundantly re-checked, by periodic tick or manual request', async () => {
  const { controller, reports } = rig({ run: async () => ({ hasUpdate: true, version: '9.9.9' }) })
  await controller.tick()
  controller.downloaded()
  reports.length = 0
  await controller.tick()
  assert.deepEqual(reports, [], 'periodic tick must not touch a known-pending download')
  const status = await controller.check()
  assert.deepEqual(status, { state: 'pending-idle', version: '9.9.9' })
  assert.deepEqual(reports, [{ state: 'pending-idle', version: '9.9.9' }], 'manual check reports the existing status instead of re-checking')
})

test('concurrent checks coalesce into a single in-flight run', async () => {
  let calls = 0, release
  const barrier = new Promise(resolve => { release = resolve })
  const { controller } = rig({ run: async () => { calls++; await barrier; return { hasUpdate: false } } })
  const a = controller.check(), b = controller.check(), c = controller.tick()
  release()
  await Promise.all([a, b, c])
  assert.equal(calls, 1)
})

test('a failed check backs off before the next automatic attempt, doubling per consecutive failure, capped at the periodic interval', async () => {
  const { controller, reports, advance } = rig({
    run: async () => { throw new Error('offline') },
    options: { periodicMs: 100000, backoffBaseMs: 1000 },
  })
  await controller.tick()
  assert.deepEqual(controller.current(), { state: 'unavailable' })
  advance(999)
  await controller.tick()
  assert.equal(reports.filter(r => r.state === 'checking').length, 1, 'not yet due')
  advance(2)
  await controller.tick()
  assert.equal(reports.filter(r => r.state === 'checking').length, 2, 'first backoff window elapsed')
  advance(1999)
  await controller.tick()
  assert.equal(reports.filter(r => r.state === 'checking').length, 2, 'second window (2x base) not yet elapsed')
  advance(2)
  await controller.tick()
  assert.equal(reports.filter(r => r.state === 'checking').length, 3)
})

test('backoff never exceeds the periodic interval even after many consecutive failures', async () => {
  let attempts = 0
  const { controller, advance } = rig({ run: async () => { attempts++; throw new Error('offline') }, options: { periodicMs: 5000, backoffBaseMs: 1000 } })
  // Doubling unboundedly would need 1000,2000,4000,8000... ms; each wait here is only the 5000ms cap.
  for (let i = 0; i < 6; i++) { await controller.tick(); advance(5000) }
  assert.equal(attempts, 6, 'every capped-interval wait must be enough to trigger the next retry, not an ever-growing delay')
})

test('manual check bypasses backoff entirely', async () => {
  let attempts = 0
  const { controller } = rig({ run: async () => { attempts++; if (attempts === 1) throw new Error('offline'); return { hasUpdate: false } }, options: { periodicMs: 100000, backoffBaseMs: 100000 } })
  await controller.tick()
  assert.equal(controller.current().state, 'unavailable')
  const status = await controller.check()
  assert.equal(status.state, 'up-to-date', 'manual retry is not blocked by an automatic backoff window')
})

test('success resets a prior failure backoff for the following periodic cadence', async () => {
  let attempts = 0
  const { controller, advance } = rig({ run: async () => { attempts++; if (attempts === 1) throw new Error('offline'); return { hasUpdate: false } }, options: { periodicMs: 10000, backoffBaseMs: 1000 } })
  await controller.tick()
  advance(1000)
  await controller.tick()
  assert.equal(controller.current().state, 'up-to-date')
  advance(9999)
  await controller.tick()
  assert.equal(attempts, 2, 'not yet due on the full periodic interval')
  advance(1)
  await controller.tick()
  assert.equal(attempts, 3)
})

test('an error mid-download reports failed and schedules its own retry, independent of the check that started the download', async () => {
  const { controller, reports, advance } = rig({ run: async () => ({ hasUpdate: true, version: '1.2.3' }), options: { periodicMs: 100000, backoffBaseMs: 500 } })
  await controller.tick()
  controller.errored()
  assert.deepEqual(reports.at(-1), { state: 'failed' })
  await controller.tick()
  assert.deepEqual(controller.current(), { state: 'failed' }, 'not yet due')
  advance(500)
  await controller.tick()
  assert.equal(controller.current().state, 'downloading', 'the backoff window elapsed and the next automatic check ran')
})

test('errored() is a no-op before any check has ever run', () => {
  const { controller, reports } = rig()
  controller.errored()
  assert.deepEqual(controller.current(), { state: 'idle' })
  assert.deepEqual(reports, [])
})

test('errored() is a no-op while a check is still in flight (the check-time failure case)', async () => {
  // This is the real scenario: electron-updater's 'error' event fires for a
  // check-time failure TOO (Node calls every listener on an emitter), so the
  // SAME failure would otherwise reach both run()'s own rejection (handled
  // below, via runCheck's catch) and this permanent handler - a naive errored()
  // would double-increment backoff and race the final displayed state.
  let release
  const barrier = new Promise(resolve => { release = resolve })
  const { controller, reports } = rig({ run: () => barrier.then(() => { throw new Error('offline') }) })
  const pending = controller.tick()
  assert.equal(controller.current().state, 'checking')
  reports.length = 0
  controller.errored() // the duplicate 'error' event, arriving mid-check
  assert.deepEqual(controller.current(), { state: 'checking' }, 'errored() must not preempt the in-flight check\'s own outcome')
  assert.deepEqual(reports, [], 'errored() must not report anything while a check is still in flight')
  release()
  await pending
  assert.deepEqual(controller.current(), { state: 'unavailable' }, 'the check\'s own rejection is what actually sets the final state')
})

test('errored() after a check already failed does not double the backoff', async () => {
  let attempts = 0
  const { controller, reports, advance } = rig({
    run: async () => { attempts++; if (attempts === 1) throw new Error('offline'); return { hasUpdate: false } },
    options: { periodicMs: 100000, backoffBaseMs: 1000 },
  })
  await controller.tick() // consecutiveFailures -> 1, nextRetryAt = 1000
  reports.length = 0
  controller.errored() // the duplicate 'error' event, arriving just after
  assert.deepEqual(controller.current(), { state: 'unavailable' }, 'errored() must not overwrite the check\'s own failure state')
  assert.deepEqual(reports, [], 'errored() must not report anything on top of the check\'s own report')
  advance(999)
  await controller.tick()
  assert.equal(attempts, 1, 'not yet due at 999ms - a real double-count would have needed 2000ms instead of 1000ms, but this alone would also pass with no bug, so the boundary check below is what actually proves it')
  advance(2)
  await controller.tick()
  assert.equal(attempts, 2, 'due at exactly 1000ms after the first failure - proves errored() did not push nextRetryAt out to backoffBaseMs*2 (which would need 2000ms total, not 1001ms)')
  assert.equal(controller.current().state, 'up-to-date')
})

test('errored() is a no-op once a check found no update', async () => {
  const { controller, reports } = rig()
  await controller.tick()
  reports.length = 0
  controller.errored()
  assert.deepEqual(controller.current(), { state: 'up-to-date' })
  assert.deepEqual(reports, [])
})

test('errored() is a no-op once a download has already completed', () => {
  const { controller, reports } = rig()
  controller.downloaded('1.2.3')
  reports.length = 0
  controller.errored()
  assert.deepEqual(controller.current(), { state: 'pending-idle', version: '1.2.3' })
  assert.deepEqual(reports, [])
})

test('errored() still applies normally to a real download-stage failure', () => {
  const { controller, reports } = rig({ run: async () => ({ hasUpdate: true, version: '9.9.9' }) })
  return controller.tick().then(() => {
    reports.length = 0
    controller.errored()
    assert.deepEqual(reports, [{ state: 'failed' }])
    assert.deepEqual(controller.current(), { state: 'failed' })
  })
})

test('checkForUpdatesViaEvents resolves hasUpdate:true from update-available, carrying its version', async () => {
  const listeners = new Map()
  const fake = {
    checkForUpdates: () => new Promise(() => {}), // never resolves; the event decides first
    once: (event, listener) => listeners.set(event, listener),
    removeListener: (event, listener) => { if (listeners.get(event) === listener) listeners.delete(event) },
  }
  const promise = checkForUpdatesViaEvents(fake)
  listeners.get('update-available')({ version: '3.0.0' })
  assert.deepEqual(await promise, { hasUpdate: true, version: '3.0.0' })
  assert.equal(listeners.size, 0, 'all three listeners must be removed once settled')
})

test('checkForUpdatesViaEvents resolves hasUpdate:false from update-not-available', async () => {
  const listeners = new Map()
  const fake = {
    checkForUpdates: () => new Promise(() => {}),
    once: (event, listener) => listeners.set(event, listener),
    removeListener: (event, listener) => { if (listeners.get(event) === listener) listeners.delete(event) },
  }
  const promise = checkForUpdatesViaEvents(fake)
  listeners.get('update-not-available')()
  assert.deepEqual(await promise, { hasUpdate: false })
  assert.equal(listeners.size, 0)
})

test('checkForUpdatesViaEvents rejects on the error event', async () => {
  const listeners = new Map()
  const fake = {
    checkForUpdates: () => new Promise(() => {}),
    once: (event, listener) => listeners.set(event, listener),
    removeListener: (event, listener) => { if (listeners.get(event) === listener) listeners.delete(event) },
  }
  const promise = checkForUpdatesViaEvents(fake)
  listeners.get('error')(new Error('offline'))
  await assert.rejects(promise, /offline/)
  assert.equal(listeners.size, 0)
})

test('checkForUpdatesViaEvents falls back to hasUpdate:false when checkForUpdates resolves falsy without ever emitting', async () => {
  const listeners = new Map()
  const fake = {
    checkForUpdates: () => Promise.resolve(null),
    once: (event, listener) => listeners.set(event, listener),
    removeListener: (event, listener) => { if (listeners.get(event) === listener) listeners.delete(event) },
  }
  assert.deepEqual(await checkForUpdatesViaEvents(fake), { hasUpdate: false })
})

test('checkForUpdatesViaEvents settles only once even if an event and the falsy fallback both fire', async () => {
  const listeners = new Map()
  const fake = {
    checkForUpdates: () => Promise.resolve(null), // resolves after the event below, on the next microtask
    once: (event, listener) => listeners.set(event, listener),
    removeListener: (event, listener) => { if (listeners.get(event) === listener) listeners.delete(event) },
  }
  const promise = checkForUpdatesViaEvents(fake)
  listeners.get('update-available')({ version: '1.0.0' })
  assert.deepEqual(await promise, { hasUpdate: true, version: '1.0.0' }, 'the event that fired first wins; the later falsy resolve must not override it')
})

// ── composed: UpdateController driven by a real checkForUpdatesViaEvents(),
// against a fake autoUpdater emitter, proving the two actual production event
// orderings a real autoUpdater can deliver both leave the correct terminal state.
function fakeAutoUpdater() {
  const listeners = new Map()
  return {
    fire: (event, arg) => listeners.get(event)?.(arg),
    once: (event, listener) => listeners.set(event, listener),
    removeListener: (event, listener) => { if (listeners.get(event) === listener) listeners.delete(event) },
    checkForUpdates: () => new Promise(() => {}), // the events alone decide the outcome in these tests
  }
}

test('composed: update-downloaded arriving before the check promise settles still ends pending-idle, not downloading', async () => {
  const emitter = fakeAutoUpdater()
  const { controller, reports } = rig({ run: () => checkForUpdatesViaEvents(emitter) })
  const pending = controller.tick()
  assert.equal(controller.current().state, 'checking')
  // Both fire synchronously, before runCheck's `await this.callbacks.run()`
  // continuation has had a chance to run (promise continuations are always
  // queued as microtasks, never synchronous) - this is the exact ordering a
  // fast/cached real download can produce: 'update-available' resolves
  // checkForUpdatesViaEvents' promise, but 'update-downloaded' (wired directly
  // to controller.downloaded(), independent of run() entirely) still reaches
  // the controller FIRST, before that resolution's continuation runs.
  emitter.fire('update-available', { version: '2.0.0' })
  controller.downloaded('2.0.0')
  assert.deepEqual(controller.current(), { state: 'pending-idle', version: '2.0.0' }, 'downloaded() already won before runCheck\'s continuation could run')
  await pending
  assert.deepEqual(controller.current(), { state: 'pending-idle', version: '2.0.0' }, 'the check\'s own continuation must not regress a terminal state that already arrived')
  assert.deepEqual(reports.at(-1), { state: 'pending-idle', version: '2.0.0' })
})

test('composed: the ordinary order (check resolves, then the download completes) still works', async () => {
  const emitter = fakeAutoUpdater()
  const { controller } = rig({ run: () => checkForUpdatesViaEvents(emitter) })
  const pending = controller.tick()
  emitter.fire('update-available', { version: '2.0.0' })
  await pending
  assert.deepEqual(controller.current(), { state: 'downloading', version: '2.0.0' })
  controller.downloaded('2.0.0')
  assert.deepEqual(controller.current(), { state: 'pending-idle', version: '2.0.0' })
})

test('composed: an error event arriving before the check promise settles still ends unavailable, with exactly one backoff step', async () => {
  const emitter = fakeAutoUpdater()
  const { controller, reports } = rig({ run: () => checkForUpdatesViaEvents(emitter), options: { periodicMs: 100000, backoffBaseMs: 1000 } })
  const pending = controller.tick()
  // The real autoUpdater.on('error', ...) permanent listener (wired in index.ts,
  // not modeled by checkForUpdatesViaEvents' once-listeners here) would ALSO
  // see this same emit - reached indirectly since checkForUpdatesViaEvents'
  // own once-listener consumes it into run()'s rejection. errored()'s state
  // guard (only applies while 'downloading') is what actually prevents a
  // second, redundant backoff step if index.ts's permanent handler fires too;
  // this test proves the check-time path alone lands on exactly one.
  emitter.fire('error', new Error('offline'))
  await pending
  assert.deepEqual(controller.current(), { state: 'unavailable' })
  assert.deepEqual(reports.filter(r => r.state === 'unavailable'), [{ state: 'unavailable' }], 'exactly one unavailable report, not two')
})


test('tray update controls show progress and allow installation without a renderer', async () => {
  const items = Object.fromEntries(['update-status', 'update-check', 'update-install']
    .map(id => [id, { label: '', enabled: true, visible: true }]))
  const menu = { getMenuItemById: id => items[id] }
  const statusItem = items['update-status']
  let ready = false
  const { controller } = rig({
    run: async () => ({ hasUpdate: true, version: '2.0.3' }),
    report: status => refreshTrayUpdateMenu(menu, status, ready, false),
  })
  const checking = controller.check()
  assert.equal(statusItem.label, 'Checking for updates...')
  assert.equal(items['update-check'].enabled, false)
  assert.equal(items['update-install'].visible, false)
  await checking
  controller.progress(37)
  assert.match(statusItem.label, /2.0.3.*37%/)
  controller.progress(84)
  assert.match(statusItem.label, /84%/)
  assert.equal(items['update-status'], statusItem, 'updates the existing native menu item')
  ready = true
  controller.downloaded()
  assert.match(statusItem.label, /2.0.3 ready to install/)
  assert.equal(items['update-install'].visible, true)
  assert.equal(items['update-install'].enabled, true)
  refreshTrayUpdateMenu(menu, controller.current(), true, true)
  assert.equal(statusItem.label, 'Installing update...')
  assert.equal(items['update-install'].enabled, false)
})

test('tray handles failed, unavailable, current and invalid progress states honestly', () => {
  assert.match(trayUpdateState({ state: 'failed' }, false, false).label, /failed/)
  assert.equal(trayUpdateState({ state: 'failed' }, false, false).checkEnabled, true)
  assert.match(trayUpdateState({ state: 'unavailable' }, false, false).label, /unavailable/)
  assert.match(trayUpdateState({ state: 'up-to-date' }, false, false).label, /up to date/)
  assert.doesNotMatch(trayUpdateState({ state: 'downloading', percent: NaN }, false, false).label, /NaN/)
  assert.match(trayUpdateState({ state: 'downloading', percent: 140 }, false, false).label, /100%/)
  const main = fs.readFileSync('apps/desktop/main/index.ts', 'utf8')
  assert.match(main, /id: 'update-install'[\s\S]*?requestUpdateInstall\(\)/)
  assert.match(main, /id: 'update-check'[\s\S]*?updater.check\(\)/)
  assert.match(main, /report: status => \{ broadcast\(.*refreshTrayUpdates\(\)/)
  assert.match(main, /if \(trayMenuOpen\) \{ refreshTrayUpdates\(\); return \}/)
})


test('disabling automatic updates suppresses due checks but leaves manual checks and reenabling intact', async () => {
  let enabled = false, calls = 0
  const { controller, advance } = rig({ automaticEnabled: () => enabled,
    run: async () => { calls++; return { hasUpdate: false } }, options: { periodicMs: 1000 } })
  await controller.tick()
  advance(10000)
  await controller.tick()
  assert.equal(calls, 0)
  assert.equal(controller.current().state, 'idle')
  await controller.check()
  assert.equal(calls, 1, 'manual check remains available while automatic updates are off')
  advance(10000)
  await controller.tick()
  assert.equal(calls, 1)
  enabled = true
  await controller.tick()
  assert.equal(calls, 2, 'reenabling resumes due background checks')
  enabled = false
  advance(10000)
  await controller.tick()
  assert.equal(calls, 2)
})

// ===================================================================
// Update application: the 2.0.3 hang and the shutdown-without-install.
// ===================================================================

test('bounded reports a deadline instead of hanging, and still distinguishes success from failure', async () => {
  const never = new Promise(() => {})
  assert.equal(await bounded(never, 20), 'timeout')
  // POSITIVE CONTROLS: the same helper must be able to say 'ok' and to carry an
  // error, otherwise "timeout" would be the only thing it can ever report.
  assert.equal(await bounded(Promise.resolve('x'), 1000), 'ok')
  const failed = await bounded(Promise.reject(new Error('boom')), 1000)
  assert.equal(typeof failed, 'object')
  assert.equal(failed.error.message, 'boom')
  // A promise that settles just after the deadline must not resolve it twice.
  const late = new Promise(resolve => setTimeout(resolve, 60))
  assert.equal(await bounded(late, 10), 'timeout')
  await late
})

test('a renderer that never flushes cannot wedge the update: the installer is still reached', async () => {
  // This is the measured 2.0.3 failure. In real Electron 44,
  // webContents.executeJavaScript does not settle on a busy renderer, and does
  // not settle even when that renderer is destroyed or force-crashed, so
  // saveWindowLayout()'s promise can simply never resolve. It was awaited after
  // "quitting" was already latched - the point at which before-quit refuses
  // every app.quit() - and before the forced-exit timer was armed.
  const stages = [], calls = []
  const handoff = await prepareAndHandOff({
    armWatchdog: () => calls.push('arm'),
    cancelWatchdog: () => calls.push('cancel'),
    saveLayout: () => new Promise(() => {}),           // never settles, as measured
    stopEngine: async () => { calls.push('stop') }, confirmEngineStopped: async () => true,
    markQuitComplete: () => calls.push('quit-complete'),
    handOff: () => { calls.push('handoff'); return { accepted: true, directory: 'C:\\Orgtree' } },
    record: stage => stages.push(stage),
    layoutMs: 20, engineMs: 1000, engineConfirmMs: 1000,
  })
  assert.equal(handoff.stage, 'handed-off')
  assert.deepEqual(calls, ['arm', 'stop', 'quit-complete', 'handoff'])
  assert.deepEqual(stages, ['layout-timeout', 'engine-shutdown', 'handoff'])
  // The forced-exit watchdog is armed BEFORE anything is awaited. In 2.0.3 it
  // was the last statement before the handoff, so a preparation step that never
  // settled meant it was never armed - the app simply sat there forever.
  assert.equal(calls.indexOf('arm'), 0)
})

test('the wedge is real: the same sequence awaited without a deadline never reaches the installer', async () => {
  // NEGATIVE CONTROL for the test above. Without it, "the installer was
  // reached" proves nothing - it would also pass against code that could hang.
  let reached = false
  const productionShape = (async () => { await new Promise(() => {}); reached = true })()
  const outcome = await Promise.race([productionShape.then(() => 'finished'), new Promise(r => setTimeout(() => r('still-waiting'), 80))])
  assert.equal(outcome, 'still-waiting')
  assert.equal(reached, false, 'an unbounded await really does stop the sequence dead')
})

test('a layout flush that does complete is recorded as success, not as a timeout', async () => {
  // POSITIVE CONTROL for the stage record: if every run said 'layout-timeout'
  // the stage log would be telling us nothing.
  const stages = []
  await prepareAndHandOff({
    armWatchdog: () => {}, cancelWatchdog: () => {},
    saveLayout: async () => {}, stopEngine: async () => {}, confirmEngineStopped: async () => true,
    markQuitComplete: () => {}, handOff: () => ({ accepted: true, directory: 'C:\\Orgtree' }),
    record: stage => stages.push(stage), layoutMs: 1000, engineMs: 1000, engineConfirmMs: 1000,
  })
  assert.deepEqual(stages, ['layout', 'engine-shutdown', 'handoff'])
})

test('an engine that never confirms shutdown BLOCKS the installer: nothing is installed over a live engine', async () => {
  // Installing over a running engine is never acceptable, so a stop that timed
  // out has not earned the handoff. The watchdog is released as well, or the
  // caller would be force-exited while it tries to put the app back.
  const stages = [], calls = []
  const result = await prepareAndHandOff({
    armWatchdog: () => calls.push('arm'), cancelWatchdog: () => calls.push('cancel'),
    saveLayout: async () => {}, stopEngine: () => new Promise(() => {}), confirmEngineStopped: async () => true,
    markQuitComplete: () => calls.push('quit-complete'),
    handOff: () => { calls.push('handoff'); return { accepted: true, directory: 'C:\\Orgtree' } },
    record: stage => stages.push(stage), layoutMs: 1000, engineMs: 20, engineConfirmMs: 1000,
  })
  assert.equal(result.stage, 'engine-unconfirmed')
  assert.ok(!calls.includes('handoff'), 'the installer must NOT be launched')
  assert.ok(!calls.includes('quit-complete'), 'and the quit must not be released either')
  assert.deepEqual(calls, ['arm', 'cancel'])
  assert.deepEqual(stages, ['layout', 'engine-shutdown-timeout'])
})

test('an engine stop that RESOLVES but is not observed gone still blocks the installer', async () => {
  // Engine.stop returns immediately after child.kill(), which only REQUESTS
  // termination. A resolved stop is therefore not evidence of death, and this
  // is the case a "did the promise settle" check cannot see at all.
  const calls = [], stages = []
  const result = await prepareAndHandOff({
    armWatchdog: () => calls.push('arm'), cancelWatchdog: () => calls.push('cancel'),
    saveLayout: async () => {}, stopEngine: async () => { calls.push('stop') },
    confirmEngineStopped: async () => false,
    markQuitComplete: () => calls.push('quit-complete'),
    handOff: () => { calls.push('handoff'); return { accepted: true } },
    record: (stage, detail) => stages.push([stage, detail]), layoutMs: 1000, engineMs: 1000, engineConfirmMs: 1000,
  })
  assert.equal(result.stage, 'engine-unconfirmed')
  assert.ok(!calls.includes('handoff'), 'the installer must NOT be launched')
  assert.deepEqual(calls, ['arm', 'stop', 'cancel'])
  assert.match(stages.at(-1)[1], /not observed to exit/)
})

test('a confirmation that never answers blocks the installer rather than hanging', async () => {
  const calls = []
  const result = await prepareAndHandOff({
    armWatchdog: () => calls.push('arm'), cancelWatchdog: () => calls.push('cancel'),
    saveLayout: async () => {}, stopEngine: async () => {},
    confirmEngineStopped: () => new Promise(() => {}),
    markQuitComplete: () => calls.push('quit-complete'),
    handOff: () => { calls.push('handoff'); return { accepted: true } },
    record: () => {}, layoutMs: 1000, engineMs: 1000, engineConfirmMs: 20,
  })
  assert.equal(result.stage, 'engine-unconfirmed')
  assert.ok(!calls.includes('handoff'))
})

test('the forced exit outlasts every deadline it covers, with margin', () => {
  // The previous watchdog was 20s against deadlines of 5 + 12 + 3 = 20, so it
  // could fire during the very last step it exists to protect.
  const covered = UPDATE_DEADLINES.layoutMs + UPDATE_DEADLINES.engineStopMs
    + UPDATE_DEADLINES.engineConfirmMs + UPDATE_DEADLINES.spawnGraceMs
  assert.ok(updateWatchdogMs() > covered,
    `watchdog ${updateWatchdogMs()}ms must exceed the ${covered}ms of steps it covers`)
  assert.equal(updateWatchdogMs(), covered + UPDATE_DEADLINES.marginMs)
  // NEGATIVE CONTROL: a budget with no margin is reported as such, so this
  // assertion is about the relationship and not about today's numbers.
  const noMargin = { ...UPDATE_DEADLINES, marginMs: 0 }
  assert.equal(updateWatchdogMs(noMargin) > covered, false)
})

test('the uninstall registry key is derived exactly as electron-builder writes it', () => {
  // POSITIVE CONTROL AGAINST REALITY: this machine's installed 2.0.3 registers
  // HKLM\...\Uninstall\{21991930-a33d-57f0-b948-692a56fc3ca7}, read from the
  // real registry. Deriving that same name is what makes the install SCOPE
  // checkable - a writability probe cannot see it, because an elevated process
  // can write to an all-users directory perfectly well.
  assert.equal(uninstallRegistryGuid('com.maurdekye.orgtree'), '21991930-a33d-57f0-b948-692a56fc3ca7')
  // a different id must give a different key, or the derivation is inert
  assert.notEqual(uninstallRegistryGuid('com.example.other'), uninstallRegistryGuid('com.maurdekye.orgtree'))
  // and it must be a well-formed v5 UUID
  assert.match(uninstallRegistryGuid('com.maurdekye.orgtree'), /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
})

test('an engine stop that REJECTS blocks the installer for the same reason', async () => {
  const calls = []
  const result = await prepareAndHandOff({
    armWatchdog: () => calls.push('arm'), cancelWatchdog: () => calls.push('cancel'),
    saveLayout: async () => {}, stopEngine: async () => { throw new Error('shutdown route refused') }, confirmEngineStopped: async () => true,
    markQuitComplete: () => calls.push('quit-complete'),
    handOff: () => { calls.push('handoff'); return { accepted: true } },
    record: () => {}, layoutMs: 1000, engineMs: 1000, engineConfirmMs: 1000,
  })
  assert.equal(result.stage, 'engine-unconfirmed')
  assert.deepEqual(calls, ['arm', 'cancel'])
})

test('an engine that DOES confirm shutdown reaches the installer', async () => {
  // POSITIVE CONTROL for the two tests above: without it, "the installer was
  // not launched" would also pass against code that never launches it at all.
  const calls = []
  const result = await prepareAndHandOff({
    armWatchdog: () => calls.push('arm'), cancelWatchdog: () => calls.push('cancel'),
    saveLayout: async () => {}, stopEngine: async () => {}, confirmEngineStopped: async () => true,
    markQuitComplete: () => calls.push('quit-complete'),
    handOff: () => { calls.push('handoff'); return { accepted: true, directory: 'C:\\Orgtree' } },
    record: () => {}, layoutMs: 1000, engineMs: 1000, engineConfirmMs: 1000,
  })
  assert.equal(result.stage, 'handed-off')
  assert.deepEqual(calls, ['arm', 'quit-complete', 'handoff'])
})

test('a handoff that throws is treated exactly like one that refuses', async () => {
  // Either way no app.quit() is coming, so leaving the watchdog armed would
  // force-exit a process that installed nothing. This window is the one place
  // an unhandled throw would be unrecoverable.
  const stages = [], calls = []
  const result = await prepareAndHandOff({
    armWatchdog: () => calls.push('arm'), cancelWatchdog: () => calls.push('cancel'),
    saveLayout: async () => {}, stopEngine: async () => {}, confirmEngineStopped: async () => true,
    markQuitComplete: () => {}, handOff: () => { throw new Error('spawn exploded') },
    record: stage => stages.push(stage), layoutMs: 1000, engineMs: 1000, engineConfirmMs: 1000,
  })
  assert.equal(result.stage, 'refused')
  assert.deepEqual(calls, ['arm', 'cancel'])
  assert.deepEqual(stages.slice(-2), ['error', 'handoff-refused'])
})

test('a refused handoff cancels the forced exit, so the app is never killed with nothing installed', async () => {
  // electron-updater's BaseUpdater does NOT call app.quit() when install()
  // refuses - it just clears its own latch. Left alone, the app sits in a
  // half-shut-down state until the watchdog force-exits it, having installed
  // nothing: the reported unattended disappearance.
  const stages = [], calls = []
  const result = await prepareAndHandOff({
    armWatchdog: () => calls.push('arm'), cancelWatchdog: () => calls.push('cancel'),
    saveLayout: async () => {}, stopEngine: async () => {}, confirmEngineStopped: async () => true,
    markQuitComplete: () => {}, handOff: () => ({ accepted: false }),
    record: stage => stages.push(stage), layoutMs: 1000, engineMs: 1000, engineConfirmMs: 1000,
  })
  assert.equal(result.stage, 'refused')
  assert.deepEqual(calls, ['arm', 'cancel'])
  assert.equal(stages.at(-1), 'handoff-refused')
  // ... and an ACCEPTED handoff must NOT cancel it, or the watchdog would stop
  // covering the window between the spawn and the updater's own app.quit().
  const kept = []
  await prepareAndHandOff({
    armWatchdog: () => kept.push('arm'), cancelWatchdog: () => kept.push('cancel'),
    saveLayout: async () => {}, stopEngine: async () => {}, confirmEngineStopped: async () => true,
    markQuitComplete: () => {}, handOff: () => ({ accepted: true, directory: 'C:\\Orgtree' }),
    record: () => {}, layoutMs: 1000, engineMs: 1000, engineConfirmMs: 1000,
  })
  assert.deepEqual(kept, ['arm'])
})

test('the handoff result reports whether electron-updater actually accepted it', () => {
  // install() answers synchronously, which is the whole point: quitAndInstall
  // would have scheduled app.quit() already, leaving no decision point.
  assert.equal(installDownloadedUpdate({ install: () => true }, 'C:\\Orgtree').accepted, true)
  // A refusal must also clear the library's own latch, or every later attempt
  // is silently ignored as a duplicate and the update can never be retried.
  const refused = { quitAndInstallCalled: true, install: () => false }
  assert.equal(installDownloadedUpdate(refused, 'C:\\Orgtree').accepted, false)
  assert.equal(refused.quitAndInstallCalled, false)
})

test('a /D= that Windows will quote is reported, and still passed through unchanged', () => {
  // Measured on the real Win32 command line: spawn turns
  //   /D=C:\Program Files\Orgtree
  // into
  //   "/D=C:\Program Files\Orgtree"
  // NSIS requires /D= to be the last parameter AND unquoted; app-builder-lib's
  // own GetDParameter scans the raw command line for "/D=" and copies
  // everything after it - trailing quote included - into $INSTDIR.
  const { NsisUpdater } = createRequire(import.meta.url)('electron-updater/out/NsisUpdater.js')
  const { BaseUpdater } = createRequire(import.meta.url)('electron-updater/out/BaseUpdater.js')
  const calls = []
  // Drives the REAL BaseUpdater.install and NsisUpdater.doInstall, so what
  // the installer would actually receive is asserted, not re-stated.
  const updater = {
    quitAndInstallCalled: false,
    _logger: { info() {}, warn() {}, error() {} },
    downloadedUpdateHelper: { file: 'C:\\Downloads\\Orgtree Setup.exe', packageFile: null, downloadedFileInfo: { isAdminRightsRequired: false } },
    get installerPath() { return this.downloadedUpdateHelper.file },
    spawnLog: (exe, args) => { calls.push({ exe, args }); return Promise.resolve() },
    dispatchError: error => { throw error },
    doInstall(options) { return NsisUpdater.prototype.doInstall.call(this, options) },
    install(isSilent, isForceRunAfter) { return BaseUpdater.prototype.install.call(this, isSilent, isForceRunAfter) },
  }
  // The behaviour is DELIBERATELY UNCHANGED: withholding the argument would
  // change where the installer lands and which scope it picks, and that cannot
  // be verified without running the real installer. Only the log gains a note.
  const flagged = installDownloadedUpdate(updater, 'C:\\Program Files\\Orgtree')
  assert.equal(flagged.directory, 'C:\\Program Files\\Orgtree')
  assert.equal(flagged.directoryWillBeQuoted, true)
  assert.deepEqual(calls.at(-1).args, ['--updated', '/S', '--force-run', '/D=C:\\Program Files\\Orgtree'],
    'the exact existing installation directory is still passed through')

  // POSITIVE CONTROL: a directory Windows will not quote carries no warning, so
  // the flag means something rather than being set on everything.
  updater.quitAndInstallCalled = false
  const clean = installDownloadedUpdate(updater, 'C:\\Orgtree')
  assert.equal(clean.directory, 'C:\\Orgtree')
  assert.equal(clean.directoryWillBeQuoted, undefined)
  assert.deepEqual(calls.at(-1).args, ['--updated', '/S', '--force-run', '/D=C:\\Orgtree'])
  assert.equal(installDirectoryIsSafeForNsis('C:\\Orgtree'), true)
  assert.equal(installDirectoryIsSafeForNsis('C:\\Program Files\\Orgtree'), false)
  assert.equal(installDirectoryIsSafeForNsis(''), false)
})

test('writability is decided by writing, because Windows access checks ignore the ACL', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-writable-'))
  assert.equal(installDirectoryWritable(dir), true, 'a real writable directory must pass')
  assert.equal(fs.readdirSync(dir).length, 0, 'the probe file must not be left behind')
  // NEGATIVE CONTROL: a path that cannot accept a child file fails. Using a
  // FILE as the directory makes the write fail for a real filesystem reason
  // (ENOTDIR) without needing an elevated fixture.
  const file = path.join(dir, 'not-a-directory')
  fs.writeFileSync(file, 'x')
  assert.equal(installDirectoryWritable(file), false)
  assert.equal(installDirectoryWritable(path.join(dir, 'absent')), false)
  assert.equal(installDirectoryWritable(''), false)
})

test('update diagnostics are persisted, bounded, and redact credentials', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-updatelog-'))
  const file = path.join(dir, 'update-log.json')
  let clock = 1757000000000
  const log = new UpdateLog(file, 5, () => clock)
  log.record('attempt', 'explicit request', { from: '2.0.3', to: '2.0.4' })
  clock += 1000
  log.record('handoff', 'installer launched for C:\\Orgtree')
  assert.deepEqual(log.all().map(e => e.stage), ['attempt', 'handoff'])
  assert.equal(log.all()[0].from, '2.0.3')
  assert.equal(log.all()[0].to, '2.0.4')
  assert.match(log.all()[0].at, /^2025-|^2026-/)

  // it survives the process that wrote it - the whole point
  assert.deepEqual(new UpdateLog(file, 5).all().map(e => e.stage), ['attempt', 'handoff'])

  // bounded: the oldest entries are dropped, not the newest
  for (let i = 0; i < 10; i++) log.record('updater', 'line ' + i)
  const kept = new UpdateLog(file, 5).all()
  assert.equal(kept.length, 5)
  assert.equal(kept.at(-1).detail, 'line 9')

  // lastAttempt slices from the most recent attempt only
  log.record('attempt', 'automatic idle application', { from: '2.0.3' })
  log.record('layout-timeout')
  log.record('handoff', 'installer launched')
  assert.deepEqual(log.lastAttempt().map(e => e.stage), ['attempt', 'layout-timeout', 'handoff'])
  assert.equal(new UpdateLog(path.join(dir, 'none.json')).lastAttempt().length, 0)

  // a log that cannot be written must never break the update it describes
  assert.doesNotThrow(() => new UpdateLog(path.join(file, 'under-a-file.json')).record('error', 'x'))
})

test('sanitized details drop secrets and stay one bounded line, without gutting ordinary text', () => {
  const token = 'a'.repeat(64)
  assert.equal(sanitizeUpdateDetail('auth failed for ' + token), 'auth failed for [redacted]')
  assert.equal(sanitizeUpdateDetail('https://host/f.exe?token=abc123&x=1'), 'https://host/f.exe?token=[redacted]&x=1')
  assert.equal(sanitizeUpdateDetail('https://s3/f.exe?X-Amz-Signature=deadbeefcafe'), 'https://s3/f.exe?X-Amz-Signature=[redacted]')
  assert.equal(sanitizeUpdateDetail(new Error('Cannot run installer: error code EPERM')), 'Cannot run installer: error code EPERM')
  assert.equal(sanitizeUpdateDetail('line one\r\nline two\ttabbed'), 'line one line two tabbed')
  assert.equal(sanitizeUpdateDetail('x'.repeat(500)).length, 403)
  // POSITIVE CONTROL: an ordinary installer message must survive intact, or the
  // redaction would be destroying the very evidence this exists to keep.
  const real = 'Executing: C:\\Users\\u\\AppData\\Local\\orgtree-updater\\pending\\Orgtree-Setup-2.0.4.exe with args: --updated,/S,--force-run'
  assert.equal(sanitizeUpdateDetail(real), real)
})

test('electron-updater log lines are captured, with its errors kept distinct from its chatter', () => {
  const log = new UpdateLog()
  const logger = updateLogger(log)
  logger.info('Install: isSilent: true, isForceRunAfter: true')
  logger.warn('install call ignored: quitAndInstallCalled is set to true')
  logger.error(new Error('Cannot run installer: error code: EPERM'))
  assert.deepEqual(log.all().map(e => e.stage), ['updater', 'updater', 'error'])
  assert.equal(log.all()[0].detail, 'Install: isSilent: true, isForceRunAfter: true')
  assert.equal(log.all()[2].detail, 'Cannot run installer: error code: EPERM')
})

test('a cached package reported downloaded before any check still carries its version', async () => {
  // electron-updater can report a previously cached download immediately, before
  // (or instead of) a check of ours resolving. The listener used to discard
  // info.version, which left the target version unknown on an ordinary,
  // perfectly successful download - and the header tooltip with nothing to show.
  const seen = []
  const cold = new UpdateController({ run: async () => ({ hasUpdate: false }), report: s => seen.push(s) })
  cold.downloaded('2.0.4')
  assert.deepEqual(cold.current(), { state: 'pending-idle', version: '2.0.4' })

  // ...and it must not REPLACE a version a check already established, when the
  // event happens to carry none.
  const warm = new UpdateController({ run: async () => ({ hasUpdate: true, version: '2.0.4' }), report: () => {} })
  await warm.check()
  warm.downloaded(undefined)
  assert.deepEqual(warm.current(), { state: 'pending-idle', version: '2.0.4' })

  // POSITIVE CONTROL: without a version from either source it is genuinely
  // unknown, so the assertions above are not passing on a default.
  const blind = new UpdateController({ run: async () => ({ hasUpdate: false }), report: () => {} })
  blind.downloaded(undefined)
  assert.equal(blind.current().state, 'pending-idle')
  assert.equal(blind.current().version, undefined)
})

test('a held update still reads as installable in the tray, and says why it is waiting', () => {
  const pending = { state: 'pending-idle', version: '2.0.4' }
  const held = trayUpdateState(pending, true, false, 'needs administrator approval - use Update now')
  assert.equal(held.label, 'Update 2.0.4: needs administrator approval - use Update now')
  assert.equal(held.installVisible, true)
  assert.equal(held.installEnabled, true, 'holding the AUTOMATIC path must never disable the manual one')
  // POSITIVE CONTROL: with no hold the wording is unchanged from before.
  assert.equal(trayUpdateState(pending, true, false).label, 'Update 2.0.4 ready to install')
  // and work already under way still outranks the hold
  assert.equal(trayUpdateState(pending, true, true, 'needs administrator approval').label, 'Installing update...')
})
