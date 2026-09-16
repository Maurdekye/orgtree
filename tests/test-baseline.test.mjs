// tests/test-baseline.test.mjs — the classifier that decides whose failure it is.
//
// The whole value of tools/test-baseline.mjs rests on one judgement: given a
// run and a baseline, which failures are NEW (the agent's) and which were
// already there (somebody else's). If that judgement is wrong in the generous
// direction an agent ships a regression believing the baseline acquitted it,
// and there is no second run to catch it any more — the point of the tool is
// that the second run stops happening. So it is tested here against fixtures
// rather than only demonstrated once by hand.
//
// These cases run `compare --results`, which classifies a saved run and
// executes no test suite at all, so the file costs no measurable time.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const TOOL = path.join(REPO, 'tools', 'test-baseline.mjs')

const id = name => `node-root::tests/example.test.mjs::${name}`

// Stands in for the tool's own scrub-and-hash: same error text, same digest;
// different text, different digest. That is the only property the comparison
// relies on.
const digestOf = error => (error ? `digest-${error.length}` : null)

const outcome = (name, status, error = null) => ({
  id: id(name),
  suite: 'node-root',
  file: 'tests/example.test.mjs',
  test: name,
  status,
  kind: 'leaf',
  failure_type: status === 'failed' ? 'testCodeFailure' : null,
  error,
  error_digest: digestOf(error),
  duration_ms: 1,
})

const failure = (name, error = 'boom') => ({
  id: id(name),
  file: 'tests/example.test.mjs',
  test: name,
  kind: 'leaf',
  failure_type: 'testCodeFailure',
  stability: 'stable',
  error,
  error_digest: digestOf(error),
})

/** A baseline in which `old-broken` was already failing and `solid` passed. */
function baselineFixture(overrides = {}) {
  return {
    schema: 'orgtree.test-baseline/v1',
    recorded_at: new Date().toISOString(),
    recorded_by: 'fixture',
    max_age_days: 7,
    commit: 'a'.repeat(40),
    commit_subject: 'fixture',
    commit_at: new Date().toISOString(),
    branch: 'main',
    tree_clean: true,
    measured_tree_clean: true,
    trees: {},
    machine: { host: os.hostname(), platform: process.platform, arch: process.arch, node: process.version, cpus: 1, concurrency: 4 },
    suites: {
      'node-root': {
        title: 'fixture',
        description: 'fixture',
        runner: 'fixture',
        counts: { files: 1, tests: 3, passed: 2, failed: 1, skipped: 0 },
        failing_files: ['tests/example.test.mjs'],
        failures: [failure('old-broken')],
        known_test_ids: [id('old-broken'), id('solid'), id('also-solid')],
        ...overrides,
      },
    },
  }
}

function runFixture(t, { baseline, outcomes, args = [] }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baseline-test-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const baselineFile = path.join(dir, 'baseline.json')
  const resultsFile = path.join(dir, 'results.json')
  fs.writeFileSync(baselineFile, JSON.stringify(baseline))
  fs.writeFileSync(resultsFile, JSON.stringify({
    schema: 'orgtree.test-run/v1',
    ran_at: new Date().toISOString(),
    commit: 'b'.repeat(40),
    suites: {
      'node-root': {
        counts: {
          files: 1,
          tests: outcomes.length,
          passed: outcomes.filter(o => o.status === 'passed').length,
          failed: outcomes.filter(o => o.status === 'failed').length,
          skipped: 0,
        },
        outcomes,
        duration_ms: 1,
      },
    },
  }))
  const result = spawnSync(process.execPath, [
    TOOL, 'compare', '--baseline', baselineFile, '--results', resultsFile, '--json', ...args,
  ], { cwd: REPO, encoding: 'utf8', windowsHide: true })
  // With --json the tool puts the report on stdout and everything human on
  // stderr, so stdout parses whole. A caller that has to find JSON inside prose
  // is a caller that will eventually mis-parse it.
  let parsed
  try {
    parsed = JSON.parse(result.stdout)
  } catch (error) {
    assert.fail(`stdout was not pure JSON (${error.message}):\n${result.stdout}\n--- stderr ---\n${result.stderr}`)
  }
  return {
    status: result.status,
    stdout: result.stdout,
    human: result.stderr,
    report: parsed.suites['node-root'],
  }
}

test('a pre-existing failure is not counted against the agent, and the run still exits clean', async t => {
  const { status, report } = runFixture(t, {
    baseline: baselineFixture(),
    outcomes: [outcome('old-broken', 'failed', 'boom'), outcome('solid', 'passed'), outcome('also-solid', 'passed')],
  })
  assert.equal(report.new_failures.length, 0)
  assert.equal(report.pre_existing_failures.length, 1)
  assert.equal(report.pre_existing_failures[0].test, 'old-broken')
  assert.equal(status, 0, 'a run that broke nothing new must exit 0')
})

test('a newly broken test that the baseline saw passing is a NEW failure and exits 1', async t => {
  const { status, report } = runFixture(t, {
    baseline: baselineFixture(),
    outcomes: [outcome('old-broken', 'failed', 'boom'), outcome('solid', 'failed', 'I broke this'), outcome('also-solid', 'passed')],
  })
  assert.deepEqual(report.new_failures.map(f => f.test), ['solid'])
  assert.deepEqual(report.pre_existing_failures.map(f => f.test), ['old-broken'])
  assert.equal(status, 1, 'a regression must fail the gate')
})

test('the two are separated in the SAME run — that is the whole job', async t => {
  const { status, report, human } = runFixture(t, {
    baseline: baselineFixture(),
    outcomes: [outcome('old-broken', 'failed', 'boom'), outcome('solid', 'failed', 'I broke this'), outcome('also-solid', 'failed', 'and this')],
  })
  assert.deepEqual(report.new_failures.map(f => f.test).sort(), ['also-solid', 'solid'])
  assert.deepEqual(report.pre_existing_failures.map(f => f.test), ['old-broken'])
  assert.match(human, /NEW FAILURES \(yours\): 2/)
  assert.match(human, /PRE-EXISTING \(not yours\): 1/)
  assert.equal(status, 1)
})

test('a failure in a test the baseline never saw is counted against the agent, not excused', async t => {
  // The generous reading — "not in the baseline, so not my fault" — is the one
  // that lets a regression through, because a renamed or newly added test is
  // exactly what a change introduces.
  const { status, report } = runFixture(t, {
    baseline: baselineFixture(),
    outcomes: [outcome('brand-new-test', 'failed', 'boom')],
  })
  assert.equal(report.new_failures.length, 0)
  assert.deepEqual(report.unclassifiable_failures.map(f => f.test), ['brand-new-test'])
  assert.equal(status, 1, 'a failure the baseline cannot acquit must still fail the gate')
})

test('a known failure that now passes is reported as fixed', async t => {
  const { status, report } = runFixture(t, {
    baseline: baselineFixture(),
    outcomes: [outcome('old-broken', 'passed'), outcome('solid', 'passed'), outcome('also-solid', 'passed')],
  })
  assert.deepEqual(report.fixed_since_baseline.map(f => f.test), ['old-broken'])
  assert.equal(report.new_failures.length, 0)
  assert.equal(status, 0)
})

test('a known failure missing from the run is named, not silently treated as fixed', async t => {
  const { report } = runFixture(t, {
    baseline: baselineFixture(),
    outcomes: [outcome('solid', 'passed'), outcome('also-solid', 'passed')],
  })
  assert.equal(report.fixed_since_baseline.length, 0, 'absent is not fixed')
  assert.deepEqual(report.baseline_tests_absent_from_this_run, [id('old-broken')])
})

test('a pre-existing failure whose error text changed is flagged rather than waved through', async t => {
  const { report } = runFixture(t, {
    baseline: baselineFixture(),
    outcomes: [outcome('old-broken', 'failed', 'a completely different explosion')],
  })
  assert.equal(report.pre_existing_failures.length, 1)
  assert.equal(report.pre_existing_failures[0].error_changed, true)
})

test('a suite the baseline has never measured cannot acquit anything in it', async t => {
  const baseline = baselineFixture()
  delete baseline.suites['node-root']
  baseline.suites.other = {
    title: 'fixture', description: 'fixture', runner: 'fixture',
    counts: { files: 0, tests: 0, passed: 0, failed: 0, skipped: 0 },
    failing_files: [], failures: [], known_test_ids: [],
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baseline-test-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const baselineFile = path.join(dir, 'baseline.json')
  const resultsFile = path.join(dir, 'results.json')
  fs.writeFileSync(baselineFile, JSON.stringify(baseline))
  fs.writeFileSync(resultsFile, JSON.stringify({
    schema: 'orgtree.test-run/v1', ran_at: new Date().toISOString(), commit: 'b'.repeat(40),
    suites: { 'node-root': { counts: {}, outcomes: [outcome('anything', 'failed', 'boom')], duration_ms: 1 } },
  }))
  const result = spawnSync(process.execPath, [
    TOOL, 'compare', '--baseline', baselineFile, '--results', resultsFile, '--suite', 'node-root',
  ], { cwd: REPO, encoding: 'utf8', windowsHide: true })
  assert.match(result.stdout, /NOT IN THE BASELINE/)
  assert.equal(result.status, 1)
})

test('the baseline reports its own age and provenance before any verdict', async t => {
  const { human } = runFixture(t, {
    baseline: baselineFixture(),
    outcomes: [outcome('solid', 'passed')],
  })
  // A verdict quoted without its age is the failure mode this tool exists to
  // stop, so the age line must come first and must name the commit.
  assert.match(human, /^baseline: (FRESH|DRIFTED|STALE) — recorded /)
  assert.match(human, /at commit aaaaaaaaaa/)
})

test('--max-age-days refuses an old baseline instead of quietly trusting it', async t => {
  const baseline = baselineFixture()
  baseline.recorded_at = new Date(Date.now() - 30 * 24 * 3_600_000).toISOString()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baseline-test-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const baselineFile = path.join(dir, 'baseline.json')
  fs.writeFileSync(baselineFile, JSON.stringify(baseline))
  const result = spawnSync(process.execPath, [
    TOOL, 'compare', '--baseline', baselineFile, '--max-age-days', '7',
  ], { cwd: REPO, encoding: 'utf8', windowsHide: true })
  assert.equal(result.status, 2, 'refusal is its own exit code, distinct from "found regressions"')
  assert.match(result.stderr, /refusing/)
  assert.match(result.stdout, /STALE/)
})

test('a handover cannot be recorded for a failure the baseline does not know about', async t => {
  // Without this guard the ledger becomes a place to disown your own
  // regressions, which is worse than having no ledger.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baseline-test-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const baselineFile = path.join(dir, 'baseline.json')
  const ledgerFile = path.join(dir, 'handovers.json')
  fs.writeFileSync(baselineFile, JSON.stringify(baselineFixture()))
  const result = spawnSync(process.execPath, [
    TOOL, 'handover', '--baseline', baselineFile, '--ledger', ledgerFile,
    '--test', 'a failure nobody ever recorded', '--to', 'someone',
  ], { cwd: REPO, encoding: 'utf8', windowsHide: true })
  assert.equal(result.status, 2)
  assert.match(result.stderr, /no known failure matches/)
  assert.equal(fs.existsSync(ledgerFile), false, 'a refused handover must write nothing')
})

test('a handover records the failure as explicitly not claimed, and refuses to claim it', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baseline-test-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const baselineFile = path.join(dir, 'baseline.json')
  const ledgerFile = path.join(dir, 'handovers.json')
  fs.writeFileSync(baselineFile, JSON.stringify(baselineFixture()))

  const ok = spawnSync(process.execPath, [
    TOOL, 'handover', '--baseline', baselineFile, '--ledger', ledgerFile,
    '--test', 'old-broken', '--to', 'someone-else', '--by', 'me', '--summary', 'was already red',
  ], { cwd: REPO, encoding: 'utf8', windowsHide: true })
  assert.equal(ok.status, 0, ok.stderr)

  const ledger = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'))
  assert.equal(ledger.handovers.length, 1)
  assert.equal(ledger.handovers[0].claimed, false)
  assert.equal(ledger.handovers[0].ownership, 'not-claimed-by-reporter')
  assert.equal(ledger.handovers[0].reported_by, 'me')
  assert.equal(ledger.handovers[0].route_to, 'someone-else')
  // The routing text must SAY it is not a claim; a recipient reads the message,
  // not the JSON.
  assert.match(ok.stdout, /I am not working on this and I am not taking it on/)

  const claimed = spawnSync(process.execPath, [
    TOOL, 'handover', '--baseline', baselineFile, '--ledger', ledgerFile,
    '--test', 'old-broken', '--to', 'someone-else', '--claim',
  ], { cwd: REPO, encoding: 'utf8', windowsHide: true })
  assert.equal(claimed.status, 2)
  assert.match(claimed.stderr, /cannot carry a claim/)
})

test('the same failure is not handed over twice by accident', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baseline-test-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const baselineFile = path.join(dir, 'baseline.json')
  const ledgerFile = path.join(dir, 'handovers.json')
  fs.writeFileSync(baselineFile, JSON.stringify(baselineFixture()))
  const args = [TOOL, 'handover', '--baseline', baselineFile, '--ledger', ledgerFile,
    '--test', 'old-broken', '--to', 'someone-else', '--by', 'me']
  assert.equal(spawnSync(process.execPath, args, { cwd: REPO, encoding: 'utf8', windowsHide: true }).status, 0)
  const again = spawnSync(process.execPath, args, { cwd: REPO, encoding: 'utf8', windowsHide: true })
  assert.match(again.stderr, /already handed over as #1/)
  assert.equal(JSON.parse(fs.readFileSync(ledgerFile, 'utf8')).handovers.length, 1)
})
