// run-bounds.test.mjs - tests/run.mjs (the `npm test` runner) is SEEN to bound
// what it launches, not just configured to.
//
// §1 it refuses to start below its free-memory floor, and on a malformed floor,
//    before running anything
// §2 a test process it launches carries the heap cap and the testguard preload
//    (both through NODE_OPTIONS), the per-test timeout and, on Windows, the
//    Job marker, each set to a non-default value so a hard-coded default
//    cannot pass; and node's own --test-name-pattern still selects one test
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const RUNNER = path.join(ROOT, 'tests', 'run.mjs')
const PROBE = path.join(ROOT, 'tests', 'fixtures', 'run-bounds', 'probe.test.mjs')

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
