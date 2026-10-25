// Replay the actual final signed-out check, including the predecessor control.
// An optional retained packet supplies measured calls/start data; no runtime.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { attributeAuthRuntimes } from '../proofs/agy-auth-wake.mjs'

const repo = fileURLToPath(new URL('../../../', import.meta.url))
const file = 'tools/rig/proofs/agy-auth-wake.mjs'
const source = (process.env.AGY_AUTH_WAKE_PROOF_REF
  ? execFileSync('git', ['show', process.env.AGY_AUTH_WAKE_PROOF_REF + ':' + file], { cwd: repo, encoding: 'utf8' })
  : fs.readFileSync(path.join(repo, file), 'utf8')).replaceAll('\r\n', '\n')
const begin = source.indexOf('  const rejected = calls().slice(rejectedMark)')
const end = source.indexOf("  p.check('signed-out wake creates no inference turn'", begin)
assert(begin >= 0 && end > begin)
const check = new Function('calls', 'rejectedMark', 'p', 'rig', 'fs', 'path', 'attributeAuthRuntimes', source.slice(begin, end))
const data = path.resolve('C:/orgtree-build/fixture/data'), org = 'rig-org'
const start = (agent, pid = 2280, extra = {}) => ({ agent, entry: { kind: 'start', mode: 'agy', org, pid,
  cwd: path.join(data, 'scratch', org, agent), ...extra } })
const calls = [{ kind: 'runtime', pid: 2280 }, { kind: 'check', pid: 13808 }]
function run(rows, starts, options = { data, org }) {
  const checks = [], files = []
  const names = [...new Set(starts.map(s => s.agent))]
  const rig = { ...options, fakeDir: path.join(options.data, 'fakecli'),
    fakeLog: agent => starts.filter(s => s.agent === agent).map(s => s.entry) }
  const fixtureFs = { existsSync: () => true, readdirSync: () => names.map(agent => ({ name: agent + '.jsonl', isFile: () => true })) }
  const p = { check: (what, ok, detail) => checks.push({ what, ok, detail }), file: (name, value) => files.push({ name, value }) }
  check(() => rows, 0, p, rig, fixtureFs, path, attributeAuthRuntimes)
  assert.equal(checks.length, 1)
  assert.equal(checks[0].what, 'signed-out wake runs one check and no runtime')
  return { ...checks[0], files }
}

test('a measured delayed previous runtime is not attributed to the signed-out agent', () => {
  let rows = calls, starts = [start('auth-retry')], options = { data, org }
  if (process.env.AGY_AUTH_WAKE_PACKET) {
    const packet = JSON.parse(fs.readFileSync(process.env.AGY_AUTH_WAKE_PACKET, 'utf8'))
    rows = packet.primary.check.detail
    const entry = packet.attribution.value
    assert.equal(entry.kind, 'start'); assert.equal(entry.mode, 'agy'); assert.equal(entry.pid, 2280)
    assert.equal(path.basename(entry.cwd), 'auth-retry')
    options = { data: path.dirname(path.dirname(path.dirname(entry.cwd))), org: entry.org }
    starts = [{ agent: 'auth-retry', entry }]
  }
  assert.equal(run(rows, starts, options).ok, true)
})

test('another positively owned runtime may interleave without changing one-check semantics', () => {
  const result = run(calls, [start('auth-metadata')])
  assert.equal(result.ok, true)
  assert.equal(result.files[0].value.runtimes[0].owner, 'auth-metadata')
})

test('no runtime with exactly one check passes', () => {
  assert.equal(run(calls.slice(1), []).ok, true)
})

test('any rejected-agent runtime fails even with another known owner in the slice', () => {
  assert.equal(run(calls, [start('auth-reject')]).ok, false)
  assert.equal(run([...calls, { kind: 'runtime', pid: 99 }], [start('auth-retry'), start('auth-reject', 99)]).ok, false)
})

test('an unknown, invalid or conflicting PID never disappears', () => {
  for (const starts of [[], [start('auth-retry', 99)], [start('auth-retry'), start('auth-reject')]])
    assert.equal(run(calls, starts).ok, false)
  for (const pid of [null, '2280', 0, -1, 1.5])
    assert.equal(run([{ kind: 'runtime', pid }, calls[1]], [start('auth-retry')]).ok, false)
})

test('matching PID needs the same org, exact agent cwd and AGY start record', () => {
  for (const extra of [{ org: 'other-org' }, { cwd: path.join(data, 'scratch', org, 'auth-reject') },
    { cwd: path.join(data, 'scratch', org, 'auth-retry-extra') }, { cwd: path.join(data, 'elsewhere', 'auth-retry') },
    { cwd: 'auth-retry' }, { mode: 'claude' }, { kind: 'turn_start' }, { agent: 'auth-reject' }])
    assert.equal(run(calls, [start('auth-retry', 2280, extra)]).ok, false)
  assert.equal(run(calls, [start('auth-retry'), start('auth-retry', 2280, { org: 'other-org' })]).ok, false)
})

test('missing or repeated checks still fail after attribution', () => {
  for (const rows of [[calls[0]], [...calls, calls[1]]])
    assert.equal(run(rows, [start('auth-retry')]).ok, false)
})

test('attribution retains raw calls and records unknown and rejected runtimes as blocking', () => {
  const rows = [...calls, { kind: 'runtime', pid: 99 }, { kind: 'runtime', pid: 100 }]
  const result = attributeAuthRuntimes(rows, [start('auth-retry'), start('auth-reject', 99)], { data, org, rejected: 'auth-reject' })
  assert.deepEqual(result.runtimes.map(r => r.call), rows.filter(r => r.kind === 'runtime'))
  assert.deepEqual(result.blocking.map(r => r.call.pid), [99, 100])
  assert.deepEqual(result.runtimes.map(r => r.owner), ['auth-retry', 'auth-reject', null])
})
