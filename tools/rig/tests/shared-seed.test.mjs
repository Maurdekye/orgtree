import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { Rig } from '../lib.mjs'
import { SEED_SETTLE_TIMEOUT } from '../seed-settle.mjs'

const repo = fileURLToPath(new URL('../../../', import.meta.url))
const files = fs.readdirSync(path.join(repo, 'tools/rig/proofs')).filter(f => f.endsWith('.mjs'))
const base = process.env.SHARED_SEED_BASE_REF
const source = (file, ref = process.env.SHARED_SEED_PROOF_REF) => (ref
  ? execFileSync('git', ['show', ref + ':tools/rig/proofs/' + file], { cwd: repo, encoding: 'utf8' })
  : fs.readFileSync(path.join(repo, 'tools/rig/proofs', file), 'utf8')).replaceAll('\r\n', '\n')
const texts = new Map(files.map(file => [file, source(file)]))
const flush = () => new Promise(resolve => setImmediate(resolve))
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

function seedClosure(file) {
  const text = texts.get(file), label = text.search(/what:\s*'seed[^']*'/)
  const start = text.lastIndexOf('await rig.waitFor(', label), end = text.indexOf('})', label) + 2
  assert(label >= 0 && start >= 0 && end > start)
  return new AsyncFunction('rig', 'SEED_SETTLE_TIMEOUT', text.slice(start, end))
}
async function clock(t, file, open) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 })
  const seen = { waits: 0, queries: 0, options: null }
  const rig = {
    sql() { seen.queries++; return open(Date.now()) ? [{ id: 1 }] : [] },
    waitFor(fn, options) { seen.waits++; seen.options = options; return Rig.prototype.waitFor.call(this, fn, options) },
  }
  let done = false, error = null
  seedClosure(file)(rig, SEED_SETTLE_TIMEOUT).then(() => { done = true }, e => { error = e; done = true })
  await flush()
  while (!done && Date.now() <= SEED_SETTLE_TIMEOUT) { t.mock.timers.tick(500); await flush() }
  assert(done, 'the actual seed wait has a real deadline'); assert.equal(seen.waits, 1, 'no retries')
  return { ...seen, error, elapsed: Date.now() }
}
function localHelper(text, name, rig) {
  const start = text.indexOf('  const ' + name + ' = '); assert(start >= 0)
  const body = text.slice(start + ('  const ' + name + ' = ').length)
  const firstLine = body.slice(0, body.indexOf('\n'))
  const end = /=>\s*\{\s*$/.test(firstLine) ? body.indexOf('\n  }') + '\n  }'.length : body.indexOf('})') + 2
  assert(end > 2)
  return new Function('rig', 'busy', 'return (' + body.slice(0, end) + ')')(rig, () => [])
}
const wrapped = [...texts].flatMap(([file, text]) => [...text.matchAll(/\b(settle|quiet)\(\s*'seed(?:ing)?[^']*'(?:,\s*SEED_SETTLE_TIMEOUT)?\)/g)].map(m => ({ file, helper: m[1] })))
async function helperOptions(text, helper, what, timeout) {
  let seen
  const rig = { waitFor: (_fn, options) => { seen = options; return Promise.resolve(options) } }
  await localHelper(text, helper, rig)(what, timeout)
  assert(seen, 'the actual helper called Rig.waitFor')
  return seen
}

test('every labeled seed wait uses the single shared budget, including local wrappers', () => {
  let direct = 0
  for (const [file, text] of texts) {
    for (const m of text.matchAll(/what\s*:\s*(['"])(seed(?:ing)?[^'"\n]*)\1/gi)) {
      const options = text.slice(text.lastIndexOf('{', m.index), text.indexOf('}', m.index) + 1)
      direct++; assert.match(options, /timeout\s*:\s*SEED_SETTLE_TIMEOUT\b/, file + ': ' + m[2])
    }
    for (const m of text.matchAll(/\b(settle|quiet)\(\s*'seed(?:ing)?[^']*'([^)]*)\)/g))
      assert.match(m[2], /^,\s*SEED_SETTLE_TIMEOUT$/, file + ': explicit seed-only wrapper budget')
  }
  assert.equal(direct, 128); assert.equal(wrapped.length, 20); assert.equal(SEED_SETTLE_TIMEOUT, 120000)
})

for (const file of ['agy-own-notes.mjs', 'answered-card.mjs', 'attention.mjs', 'audiences.mjs']) {
  test(file + ': actual seed closure admits completion after the helper grace', async t => {
    const seen = await clock(t, file, now => now < 61000)
    assert.equal(seen.error, null); assert.equal(seen.elapsed, 61000)
  })
}

test('all local helpers accept the shared seed budget explicitly', async () => {
  for (const { file, helper } of wrapped) {
    const options = await helperOptions(texts.get(file), helper, 'seed turns to settle', SEED_SETTLE_TIMEOUT)
    assert.equal(options.timeout, SEED_SETTLE_TIMEOUT, file)
  }
})

test('all local helper non-seed defaults are unchanged from the assigned base', async () => {
  const ninetySeconds = new Set(['conversation-recall.mjs', 'mailhub-upgrade.mjs', 'mailhub-v2.mjs', 'session-choice.mjs'])
  const twoMinutes = new Set(['reminder-race.mjs', 'reminders.mjs'])
  for (const { file, helper } of wrapped) {
    // Normal runs need no historical Git object (including shallow CI clones).
    // Author controls can additionally compare the actual assigned-base helper.
    const previous = base ? await helperOptions(source(file, base), helper, 'ordinary turn completion')
      : { what: 'ordinary turn completion', timeout: twoMinutes.has(file) ? 120000 : ninetySeconds.has(file) ? 90000 : 60000 }
    const current = await helperOptions(texts.get(file), helper, 'ordinary turn completion')
    assert.deepEqual(current, previous, file)
  }
})

test('a stuck seed still fails once at its configured real deadline', async t => {
  const seen = await clock(t, 'answered-card.mjs', () => true)
  assert.match(seen.error?.message ?? '', /timed out after \d+ ms waiting for seed turns to settle/)
  assert.equal(seen.elapsed, seen.options.timeout)
})

test('an already completed seed proceeds immediately without a fixed grace sleep', async t => {
  const seen = await clock(t, 'answered-card.mjs', () => false)
  assert.equal(seen.error, null); assert.equal(seen.elapsed, 0); assert.equal(seen.queries, 1)
})

test('persistent SQL refusal remains a failed seed wait', async t => {
  const seen = await clock(t, 'answered-card.mjs', () => { throw Error('Synthetic seed SQL refusal') })
  assert.match(seen.error?.message ?? '', /Synthetic seed SQL refusal$/)
  assert.equal(seen.elapsed, seen.options.timeout)
})
