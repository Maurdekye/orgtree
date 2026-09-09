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
const { UpdateController } = createRequire(import.meta.url)(outfile)

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
