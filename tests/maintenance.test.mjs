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
  const gate = new MaintenanceController({ ack: async (id, outcome) => { calls.push(['ack', id, outcome]); return true },
    restart: async () => calls.push(['restart']), apply: async () => calls.push(['apply']),
    check: async () => { calls.push(['check']); return 'up-to-date' },
    failure: async id => { calls.push(['failure', id]); return true },
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
  assert.deepEqual(calls, [['ack', 'r1', 'execute'], ['restart']])
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
  assert.deepEqual(calls.slice(1), [['ack', 'r1', 'execute'], ['apply']])
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
  assert.deepEqual(calls.slice(2), [['ack', 'r1', 'up-to-date'], ['report', 'up-to-date']], 'no-op update must not acquire the shutdown admission hold')
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

test('throwing native restart and update release only the acknowledged request and never retry execution', async () => {
  for (const action of ['restart', 'update']) {
    let hold = null, executions = 0
    const row = { ...request, id: `failed-${action}`, action }
    const { gate, calls } = rig({
      ack: async id => { hold = id; return true },
      [action === 'restart' ? 'restart' : 'apply']: async () => { executions++; throw new Error('native failure') },
      failure: async id => { assert.equal(id, row.id); assert.equal(hold, id); hold = null; return true },
    })
    await gate.tick(idle(row), 60, true)
    assert.equal(executions, 1, 'native operation must actually have been attempted')
    assert.equal(hold, null, 'failure releases the admission hold')
    assert.deepEqual(calls, [['report', 'failed']])
    assert.equal(gate.automaticUpdatesAllowed(), false)
    await gate.tick(idle(row), 60, true)
    assert.equal(executions, 1, 'uncertain execution cannot be repeated')
  }
})

test('lost acknowledgment response resolves its possible hold without running the native operation', async () => {
  let hold = null, released = 0
  const { gate, calls } = rig({
    ack: async id => { hold = id; throw new Error('response lost') },
    failure: async id => { assert.equal(hold, id); hold = null; released++; return true },
  })
  await gate.tick(idle(), 60, false)
  assert.equal(released, 1)
  assert.equal(hold, null)
  assert.deepEqual(calls, [['report', 'failed']], 'neither restart nor apply may run after uncertain acknowledgment')
})

test('unavailable failure reporting persists across restart and retries only the report, even while busy', async () => {
  const failureFile = path.join(root, 'failed-maintenance.json')
  let executions = 0, reports = 0
  const callbacks = {
    ack: async () => true,
    restart: async () => { executions++; throw new Error('engine already stopped') },
    apply: async () => { executions++ }, check: async () => 'up-to-date', report: () => {},
    failure: async () => { reports++; return false },
  }
  const first = new MaintenanceController(callbacks, failureFile)
  await first.tick(idle(), 60, false)
  assert.equal(first.hasFailures(), true)
  assert.deepEqual(JSON.parse(fs.readFileSync(failureFile)), { pending: ['r1'], automaticBlocked: true })
  const restarted = new MaintenanceController({ ...callbacks,
    failure: async id => { assert.equal(id, 'r1'); reports++; return true },
  }, failureFile)
  await restarted.tick({ idle: false }, 0, false)
  assert.equal(reports, 2, 'recovery does not require the failed request to remain pending in status')
  assert.equal(executions, 1)
  assert.equal(restarted.hasFailures(), false)
  assert.deepEqual(JSON.parse(fs.readFileSync(failureFile)), { pending: [], automaticBlocked: true })
  await restarted.tick(idle(), 60, true)
  assert.equal(executions, 1, 'a recovered failure must remain consumed')
  const nextLaunch = new MaintenanceController(callbacks, failureFile)
  assert.equal(nextLaunch.automaticUpdatesAllowed(), false, 'automatic application stays paused across launches')
  await nextLaunch.tick(idle({ ...request, id: 'new-explicit-update', action: 'update' }), 60, true)
  assert.equal(executions, 2, 'a new explicit request remains usable')
  assert.equal(nextLaunch.automaticUpdatesAllowed(), true)
})
