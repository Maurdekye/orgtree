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
const { trayUpdateState, refreshTrayUpdateMenu, UpdateController, checkForUpdatesViaEvents, installDownloadedUpdate } = createRequire(import.meta.url)(outfile)

test('downloaded install uses the real NSIS silent-update command and relaunches into the same directory', () => {
  const { NsisUpdater } = createRequire(import.meta.url)('electron-updater/out/NsisUpdater.js')
  const calls = []
  const updater = {
    installerPath: 'C:\\Downloads\\Orgtree Setup.exe',
    spawnLog: (exe, args) => { calls.push({ exe, args }); return Promise.resolve() },
    dispatchError: error => { throw error },
    quitAndInstall(isSilent, isForceRunAfter) {
      NsisUpdater.prototype.doInstall.call(this, { isSilent, isForceRunAfter, isAdminRightsRequired: false })
    },
  }
  for (const directory of ['C:\\Program Files\\Orgtree', 'D:\\My Apps\\Orgtree']) {
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
