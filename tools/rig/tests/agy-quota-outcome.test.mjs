// Replay the actual quota wait/check through Rig.waitFor, without an engine.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { Rig } from '../lib.mjs'

const repo = fileURLToPath(new URL('../../../', import.meta.url)), file = 'tools/rig/proofs/agy-lane.mjs'
const source = (process.env.AGY_QUOTA_PROOF_REF
  ? execFileSync('git', ['show', process.env.AGY_QUOTA_PROOF_REF + ':' + file], { cwd: repo, encoding: 'utf8' })
  : fs.readFileSync(path.join(repo, file), 'utf8')).replaceAll('\r\n', '\n')
const begin = source.indexOf('  const pf = await rig.waitFor(')
const end = source.indexOf('\n\n  // ---------------------------------------------------------------- max:', begin)
assert(begin >= 0 && end > begin)
const execute = new (Object.getPrototypeOf(async function () {}).constructor)('rig', 'freezeOf', 'p', source.slice(begin, end))
const flush = () => new Promise(resolve => setImmediate(resolve))
const row = { id: 19, started_at: '2026-01-01T00:00:00.000Z', ended_at: '2026-01-01T00:00:00.010Z', error: null, killed: false }
const freeze = { limit: true, error: 'Daily quota exceeded for this model; the limit lifts tomorrow.' }

async function run(t, frozen, turn = row) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 })
  const checks = [], seen = { waits: 0, reads: 0 }
  const rig = { turns: () => turn ? [turn] : [], waitFor(fn, options) { seen.waits++; return Rig.prototype.waitFor.call(this, fn, options) } }
  const p = { check: (what, ok, detail) => checks.push({ what, ok, detail }) }
  let done = false, error = null
  execute(rig, () => { seen.reads++; return frozen(Date.now()) }, p).then(() => { done = true }, e => { error = e; done = true })
  await flush()
  while (!done && Date.now() <= 60000) { t.mock.timers.tick(500); await flush() }
  assert(done, 'the actual wait terminates within its bounded budget'); assert.equal(seen.waits, 1, 'no retry or fixed sleep')
  return { checks, ...seen, error, elapsed: Date.now() }
}
function result(seen) {
  assert.equal(seen.error, null, 'an absent freeze is a durable failed check, not an aborted proof')
  assert.equal(seen.checks.length, 1)
  assert.equal(seen.checks[0].what, 'pia: "limit" with quota/exceeded is a usage limit (frozen, not a plain failure)')
  return seen.checks[0]
}

test('an ended ledger row must not outrun the later quota freeze', async t => {
  let ended = row, quota = freeze
  if (process.env.AGY_QUOTA_PACKET) {
    const packet = JSON.parse(fs.readFileSync(process.env.AGY_QUOTA_PACKET, 'utf8'))
    ended = packet.tip.check.detail; quota = packet.base.check.detail
    assert(ended.ended_at && ended.error === null && quota.limit === true)
  }
  // Deliberately model the documented two-write gap; not a new runtime trace.
  const seen = await run(t, now => now >= 500 ? quota : null, ended)
  assert.equal(result(seen).ok, true); assert.equal(seen.elapsed, 500)
})

test('an already recorded quota freeze completes immediately', async t => {
  const seen = await run(t, () => freeze)
  assert.equal(result(seen).ok, true); assert.equal(seen.elapsed, 0); assert.equal(seen.reads, 1)
})

test('a non-limit freeze remains a failure', async t => {
  const seen = await run(t, () => ({ limit: false, error: 'Synthetic connection refusal' }))
  assert.equal(result(seen).ok, false)
})

test('an ended turn without any freeze still fails and retains its ledger diagnostics', async t => {
  const seen = await run(t, () => null), check = result(seen)
  assert.equal(check.ok, false); assert.deepEqual(check.detail.turn ?? check.detail, row)
  assert(seen.elapsed <= 30000)
})

test('a missing outcome cannot abort before recording the named failed check', async t => {
  const seen = await run(t, () => null, { ...row, ended_at: null })
  assert.equal(result(seen).ok, false); assert.equal(seen.elapsed, 30000)
})

test('a terminal plain failure never becomes a successful quota assertion', async t => {
  const failed = { ...row, error: 'Synthetic terminal refusal' }
  const seen = await run(t, () => null, failed), check = result(seen)
  assert.equal(check.ok, false); assert.equal((check.detail.turn ?? check.detail).error, failed.error)
})
