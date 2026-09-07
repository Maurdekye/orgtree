import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-maintenance-'))
const outfile = path.join(root, 'maintenance.cjs')
await build({ entryPoints: ['apps/desktop/main/maintenance.ts'], outfile, bundle: true, format: 'cjs', platform: 'node' })
const { MaintenanceController, maintenanceRequest } = createRequire(import.meta.url)(outfile)
const request = { id: 'r1', action: 'restart', target: 'org', reason: 'approved tool request' }
const idle = (maintenance = request) => ({ idle: true, maintenance })
function rig(overrides = {}) {
  const calls = []
  const gate = new MaintenanceController({ ack: async id => { calls.push(['ack', id]); return true },
    restart: async () => calls.push(['restart']), apply: async () => calls.push(['apply']),
    check: async () => { calls.push(['check']); return 'up-to-date' },
    report: state => calls.push(['report', state]), ...overrides })
  return { calls, gate }
}

test('maintenance identity is bounded and never accepts arbitrary native operations', () => {
  assert.deepEqual(maintenanceRequest(request), request)
  for (const delta of [{ id: '' }, { id: 'x'.repeat(201) }, { action: 'exec' }, { target: 'foreign' }, { reason: null }])
    assert.equal(maintenanceRequest({ ...request, ...delta }), null)
})

test('restart requires current engine idle, OS idle and exact acknowledgment before native relaunch', async () => {
  const { calls, gate } = rig()
  for (const [status, seconds] of [[null, 600], [{ idle: false, maintenance: request }, 600], [idle(), 59]])
    await gate.tick(status, seconds, false)
  assert.deepEqual(calls, [])
  await gate.tick(idle(), 60, false)
  assert.deepEqual(calls, [['ack', 'r1'], ['restart']])
  await gate.tick(idle(), 60, false)
  assert.equal(calls.length, 2, 'one request cannot relaunch repeatedly')
  const rejected = rig({ ack: async () => false })
  await rejected.gate.tick(idle(), 60, true)
  assert.deepEqual(rejected.calls, [], 'cancelled or superseded request cannot stop the engine')
})

test('update download needs a fresh idle sample and exact ack; failure preserves pending request', async () => {
  const update = { ...request, action: 'update' }
  const { calls, gate } = rig({ check: async () => 'pending' })
  await gate.tick(idle(update), 60, false)
  assert.deepEqual(calls, [['report', 'pending']])
  await gate.tick({ idle: false, maintenance: update }, 60, true)
  assert.equal(calls.length, 1)
  await gate.tick(idle(update), 60, true)
  assert.deepEqual(calls.slice(1), [['ack', 'r1'], ['apply']])
  let now = 0
  const failed = rig({ now: () => now, check: async () => { throw new Error('offline') } })
  await assert.rejects(failed.gate.tick(idle(update), 60, false), /offline/)
  assert.deepEqual(failed.calls, [])
  now = 60001
  await assert.rejects(failed.gate.tick(idle(update), 60, false), /offline/)
})

test('no-update result consumes only on a fresh idle tick and does not restart', async () => {
  const update = { ...request, action: 'update' }, { calls, gate } = rig()
  await gate.tick(idle(update), 60, false)
  assert.deepEqual(calls, [['check'], ['report', 'up-to-date']])
  await gate.tick(idle(update), 10, false)
  assert.equal(calls.length, 2)
  await gate.tick(idle(update), 60, false)
  assert.deepEqual(calls.slice(2), [['ack', 'r1'], ['report', 'up-to-date']])
})

test('overlapping polls cannot acknowledge a request twice', async () => {
  let release
  const barrier = new Promise(resolve => { release = resolve })
  const { calls, gate } = rig({ ack: async () => { await barrier; return true } })
  const first = gate.tick(idle(), 60, false)
  await gate.tick(idle(), 60, false)
  release(); await first
  assert.deepEqual(calls, [['restart']])
})
