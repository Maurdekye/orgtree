// Run the actual proof's seed closure through Rig.waitFor with a virtual clock.
// No engine, provider, database or window. A ref selects the predecessor control.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { Rig } from '../lib.mjs'
import { SEED_SETTLE_TIMEOUT } from '../seed-settle.mjs'

const repo = fileURLToPath(new URL('../../../', import.meta.url))
const file = 'tools/rig/proofs/account-windows.mjs'
const source = (process.env.ACCOUNT_WINDOWS_PROOF_REF
  ? execFileSync('git', ['show', process.env.ACCOUNT_WINDOWS_PROOF_REF + ':' + file], { cwd: repo, encoding: 'utf8' })
  : fs.readFileSync(path.join(repo, file), 'utf8')).replaceAll('\r\n', '\n')
const start = source.indexOf('  await rig.waitFor(', source.indexOf('  rig.scenario({'))
const end = source.indexOf('\n\n  // ---------------------------------------------------------------- logins and readings', start)
assert(start >= 0 && end > start, 'isolate only the real seed wait before account assertions')
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const seedWait = new AsyncFunction('rig', 'SEED_SETTLE_TIMEOUT', source.slice(start, end))
const flush = () => new Promise(resolve => setImmediate(resolve))

async function run(t, open) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 })
  const seen = { queries: 0, waits: 0, options: null }
  const rig = {
    sql(query) {
      assert.equal(query, 'SELECT 1 FROM ot.turns WHERE ended_at IS NULL')
      seen.queries++
      return open(Date.now()) ? [{ id: 1 }] : []
    },
    waitFor(fn, options) {
      seen.waits++; seen.options = options
      assert.equal(options.what, 'seed turns to settle')
      assert(options.timeout >= 60000 && options.timeout <= 120000, 'a real bounded seed budget')
      return Rig.prototype.waitFor.call(this, fn, options)
    },
  }
  let settled = false, error = null
  seedWait(rig, SEED_SETTLE_TIMEOUT).then(() => { settled = true }, e => { error = e; settled = true })
  await flush()
  while (!settled && Date.now() <= 120000) {
    t.mock.timers.tick(500)
    await flush()
  }
  assert(settled, 'the actual wait terminates within its bounded budget')
  assert.equal(seen.waits, 1, 'no retry of the seed path')
  return { ...seen, error, elapsed: Date.now() }
}

for (const completion of [60500, 119500]) {
  test(`seed completion at ${completion} ms survives the helper grace and leaves time for execution`, async t => {
    const seen = await run(t, now => now < completion)
    assert.equal(seen.error, null, 'the seed turn completes within the helper-plus-execution budget')
    assert.equal(seen.elapsed, completion)
    assert(seen.queries > 1)
  })
}

test('already-settled seeds proceed immediately without a fixed helper sleep', async t => {
  const seen = await run(t, () => false)
  assert.equal(seen.error, null); assert.equal(seen.elapsed, 0); assert.equal(seen.queries, 1)
})

test('a seed turn that never completes still fails at the real deadline', async t => {
  const seen = await run(t, () => true)
  assert.match(seen.error?.message ?? '', /timed out after \d+ ms waiting for seed turns to settle/)
  assert.equal(seen.elapsed, seen.options.timeout)
})

test('persistent seed SQL failure cannot look like an empty settled queue', async t => {
  const seen = await run(t, () => { throw new Error('Synthetic seed SQL refusal') })
  assert.match(seen.error?.message ?? '', /waiting for seed turns to settle: Synthetic seed SQL refusal$/)
  assert.equal(seen.elapsed, seen.options.timeout)
})
