// run-bounds.test.mjs - tests/run.mjs (the `npm test` runner) is SEEN to bound
// what it launches, not just configured to.
//
// §1 it refuses to start below its free-memory floor, and on a malformed floor,
//    before running anything
// §2 a test process it launches carries the heap cap and the testguard preload
//    (both through NODE_OPTIONS), the per-test timeout and, on Windows, the
//    Job marker, each set to a non-default value so a hard-coded default
//    cannot pass; and node's own --test-name-pattern still selects one test
// §3 tools/test-baseline.mjs runs the root suite in-process with node:test's
//    run(); the options its call site passes (tools/test-process-bounds.mjs)
//    put the heap cap and the guard on a real run() child, with NODE_OPTIONS
//    empty so nothing else could; without them the same child has neither;
//    and the floor refuses before anything starts
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const RUNNER = path.join(ROOT, 'tests', 'run.mjs')
const PROBE = path.join(ROOT, 'tests', 'fixtures', 'run-bounds', 'probe.test.mjs')
const BASELINE_RUN = path.join(ROOT, 'tests', 'fixtures', 'run-bounds', 'baseline-run.mjs')

const launch = (args, overrides) => spawnSync(process.execPath, [RUNNER, ...args], {
  cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 90_000,
  env: { ...process.env, ...overrides },
})

test('§1 tests/run.mjs refuses to start below its free-memory floor', { timeout: 60_000 }, () => {
  const refused = launch([PROBE], { ORGTREE_TEST_MIN_FREE_MB: '99999999' })
  assert.equal(refused.status, 2, refused.stderr)
  assert.match(refused.stderr, /FREE MEMORY \d+ MB is below the 99999999 MB floor/, refused.stderr)
  assert.doesNotMatch(refused.stdout, /\[probe\]/, 'nothing may run below the floor')
  const malformed = launch([PROBE], { ORGTREE_TEST_MIN_FREE_MB: '3gb' })
  assert.equal(malformed.status, 2, malformed.stderr)
  assert.match(malformed.stderr, /ORGTREE_TEST_MIN_FREE_MB="3gb" is not a whole number/, malformed.stderr)
})

test('§2 a test process it launches carries the heap cap, the guard, the timeout and the Job', { timeout: 90_000 }, () => {
  const r = launch([PROBE, '--test-name-pattern', 'reports its bounds'], {
    ORGTREE_TEST_MIN_FREE_MB: '0', ORGTREE_TEST_HEAP_MB: '1234',
    ORGTREE_TEST_TIMEOUT_MS: '45678', ORGTREE_TEST_JOB_MB: '4096',
  })
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`)
  const line = /\[probe\] (\{.*\})/.exec(r.stdout)?.[1]
  assert.ok(line, `the probe did not report:\n${r.stdout}\n${r.stderr}`)
  const bounds = JSON.parse(line)
  // the limit is the old-space cap plus the young generation (~200 MB)
  assert.equal(bounds.heapMb >= 1234 && bounds.heapMb <= 1234 + 512, true, `heap limit ${bounds.heapMb} MB`)
  assert.equal(bounds.guard, true, 'testguard.mjs was not preloaded')
  assert.equal(bounds.timeout, '--test-timeout=45678')
  assert.equal(bounds.contained, process.platform === 'win32' ? '4096' : null)
  assert.doesNotMatch(r.stdout, /second ran/, 'the name pattern did not reach the test process')
})

/** baseline-run.mjs in a clean process: no node:test marker (run() inside a
 *  test file skips every file) and an empty NODE_OPTIONS, so only run()'s
 *  execArgv can carry a bound into the probe child. */
const viaRun = (mode, overrides) => {
  const env = { ...process.env, NODE_OPTIONS: '', ...overrides }
  delete env.NODE_TEST_CONTEXT
  return spawnSync(process.execPath, [BASELINE_RUN, mode], {
    cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 90_000, env,
  })
}
const reported = (r) => JSON.parse(/\[probe\] (\{.*\})/.exec(r.stdout)?.[1] ?? 'null')

test('§3 the baseline tool\'s run() children carry the heap cap and the guard', { timeout: 90_000 }, () => {
  // the tool's own call site uses these options, after the floor
  const source = readFileSync(path.join(ROOT, 'tools', 'test-baseline.mjs'), 'utf8')
  assert.match(source, /assertFreeMemory\(bounds\.minFreeMb/, 'test-baseline.mjs no longer checks the floor')
  assert.match(source, /runNodeTests\(\{[^}]*execArgv: bounds\.execArgv/, 'test-baseline.mjs no longer passes the bounds to run()')
  const bounded = viaRun('bounded', { ORGTREE_TEST_HEAP_MB: '1234', ORGTREE_TEST_MIN_FREE_MB: '0' })
  const got = reported(bounded)
  assert.ok(got, `the probe did not report:\n${bounded.stdout}\n${bounded.stderr}`)
  assert.equal(got.heapMb >= 1234 && got.heapMb <= 1234 + 512, true, `heap limit ${got.heapMb} MB`)
  assert.equal(got.guard, true, 'testguard.mjs did not reach the run() child')
  // anti-vacuity: the same child without the options has neither
  const bare = reported(viaRun('bare', {}))
  assert.ok(bare, 'the bare probe did not report')
  assert.equal(bare.guard, false, 'the guard reached a bare child, so the bounded case proves nothing')
  assert.equal(bare.heapMb > 1234 + 512, true, `a bare child already had a ${bare.heapMb} MB limit`)
  // the floor refuses before any child starts
  const refused = viaRun('bounded', { ORGTREE_TEST_MIN_FREE_MB: '99999999' })
  assert.notEqual(refused.status, 0, refused.stdout)
  assert.match(refused.stderr, /FREE MEMORY \d+ MB is below the 99999999 MB floor/, refused.stderr)
  assert.doesNotMatch(refused.stdout, /\[probe\]/, 'a child started below the floor')
})
