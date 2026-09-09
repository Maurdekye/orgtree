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
const { UpdateController, checkForUpdatesViaEvents } = createRequire(import.meta.url)(outfile)

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
