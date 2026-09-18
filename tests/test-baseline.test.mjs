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

test('a test that failed and then passed on re-run here is called flaky, not a regression', async t => {
  // The alternative — counting it as a regression — makes the gate cry wolf on
  // every flaky file in the tree, and a gate that cries wolf gets ignored.
  // This is an observation, not a guess: the confirmation pass watched it pass.
  const flakyOutcome = { ...outcome('solid', 'failed', 'intermittent'), stability: 'flaky', retry_status: 'passed' }
  const { status, report, human } = runFixture(t, {
    baseline: baselineFixture(),
    outcomes: [flakyOutcome, outcome('also-solid', 'passed')],
  })
  assert.equal(report.new_failures.length, 0)
  assert.deepEqual(report.flaky_failures.map(f => f.test), ['solid'])
  assert.equal(status, 0, 'a test that passes on re-run is not a deterministic regression')
  assert.match(human, /FLAKY HERE/)
  // …but it must never be silent. A verdict of "nothing new" that hid a flaky
  // failure would be exactly the dishonest report this tool exists to prevent.
  assert.match(human, /failed and then passed on re-run here/)
})

test('--strict-flaky counts that same failure against the agent', async t => {
  const flakyOutcome = { ...outcome('solid', 'failed', 'intermittent'), stability: 'flaky', retry_status: 'passed' }
  const { status, report } = runFixture(t, {
    baseline: baselineFixture(),
    outcomes: [flakyOutcome],
    args: ['--strict-flaky'],
  })
  assert.deepEqual(report.flaky_failures.map(f => f.test), ['solid'])
  assert.equal(status, 1)
})

test('a known-flaky test that passes this time is not credited as a fix', async t => {
  const baseline = baselineFixture()
  baseline.suites['node-root'].failures = [{ ...failure('old-broken'), stability: 'flaky' }]
  const { report } = runFixture(t, {
    baseline,
    outcomes: [outcome('old-broken', 'passed')],
  })
  assert.equal(report.fixed_since_baseline.length, 1)
  assert.equal(report.fixed_since_baseline[0].likely_flakiness_not_a_fix, true)
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
  assert.match(result.stderr, /BASELINE REFUSED/)
  // An automated caller records a refusal and a regression as the same non-zero
  // exit, so the words have to separate them. Without this line the agent whose
  // commit happened to trip a stale baseline goes looking for a regression that
  // does not exist.
  assert.match(result.stderr, /NOT a failure of your change/)
  assert.match(result.stderr, /test-baseline\.mjs record/, 'a refusal must say what would fix it')
  assert.match(result.stdout, /STALE/)
})

// --------------------------------------------------------------------------
// Usable vs fresh — the distinction the release `full` profile runs on.
// --------------------------------------------------------------------------

const HEAD = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8', windowsHide: true }).stdout.trim()

/** A baseline measured on THIS machine, at a commit this checkout can see. */
function usableFixture(overrides = {}) {
  const baseline = baselineFixture()
  baseline.commit = HEAD
  // `trees: {}` matches no current tree hash, so this baseline is DRIFTED by
  // `code_moved` and nothing else — exactly the state a release verification is
  // always in, because it runs on a commit past the one the baseline recorded.
  return Object.assign(baseline, overrides)
}

function compareWith(t, baseline, args) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baseline-test-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const baselineFile = path.join(dir, 'baseline.json')
  const resultsFile = path.join(dir, 'results.json')
  fs.writeFileSync(baselineFile, JSON.stringify(baseline))
  fs.writeFileSync(resultsFile, JSON.stringify({
    schema: 'orgtree.test-run/v1', ran_at: new Date().toISOString(), commit: HEAD,
    suites: { 'node-root': { counts: { files: 1, tests: 1, passed: 1, failed: 0, skipped: 0 }, outcomes: [outcome('solid', 'passed')], duration_ms: 1 } },
  }))
  return spawnSync(process.execPath, [TOOL, 'compare', '--baseline', baselineFile, '--results', resultsFile, ...args], {
    cwd: REPO, encoding: 'utf8', windowsHide: true,
  })
}

test('--require-usable accepts a baseline the code has merely moved past; --require-fresh refuses the same one', async t => {
  // This is the whole reason --require-usable exists. A release verification
  // runs on a commit PAST the one the baseline was recorded at, by
  // construction, so --require-fresh refuses every single verification — it was
  // measured doing exactly that on 2026-09-17, on a baseline 14 hours old. A
  // gate wired to --require-fresh would never pass, and a gate wired to nothing
  // would trust a baseline from another machine. This flag is the line between.
  const baseline = usableFixture()
  const strict = compareWith(t, baseline, ['--require-fresh'])
  assert.equal(strict.status, 2, '--require-fresh refuses ordinary code movement')
  assert.match(strict.stdout, /DRIFTED/)

  const usable = compareWith(t, baseline, ['--require-usable'])
  assert.equal(usable.status, 0, '--require-usable tolerates the same drift')
  assert.match(usable.stdout, /the code under test changed since/, 'tolerated, but never hidden')
})

test('--require-usable refuses a baseline measured on another machine', async t => {
  // These failures are partly environmental, so another machine's acquittals
  // are not evidence about this one. Exit 2, and the reason says whose they are.
  const result = compareWith(t, usableFixture({
    machine: { host: 'SomeOtherBox', platform: process.platform, arch: process.arch, node: process.version, cpus: 1, concurrency: 4 },
  }), ['--require-usable'])
  assert.equal(result.status, 2)
  assert.match(result.stderr, /BASELINE REFUSED/)
  assert.match(result.stderr, /NOT a failure of your change/)
  assert.match(result.stderr, /SomeOtherBox/)
})

test('--require-usable refuses a baseline whose commit this checkout cannot see', async t => {
  // Drift cannot be measured against a commit that is not here, so "no new
  // failures" would be a claim with nothing behind it.
  const result = compareWith(t, usableFixture({ commit: 'a'.repeat(40) }), ['--require-usable'])
  assert.equal(result.status, 2)
  assert.match(result.stderr, /not in this checkout/)
})

test('--require-usable refuses a baseline measured on a dirty tree, and names what would fix it', async t => {
  const result = compareWith(t, usableFixture({ measured_tree_clean: false }), ['--require-usable'])
  assert.equal(result.status, 2)
  assert.match(result.stderr, /UNCOMMITTED changes/)
  assert.match(result.stderr, /test-baseline\.mjs record/)
})

// --------------------------------------------------------------------------
// Acquittal does not expire — but it is never silent.
// --------------------------------------------------------------------------

test('an acquitted failure is reported with its age and with the fact that nobody owns it', async t => {
  // Acquitting a pre-existing failure deliberately does NOT expire: failing the
  // next commit for a failure it did not cause is the defect this tool exists
  // to remove. What replaces expiry is visibility — every acquittal carries how
  // long it has been excused and whether anyone has ever been told about it, so
  // "quietly forgiven for a month" cannot happen without it being on screen.
  const baseline = baselineFixture()
  baseline.suites['node-root'].failures[0].failing_since = new Date(Date.now() - 30 * 24 * 3_600_000).toISOString()
  const { report, human, status } = runFixture(t, {
    baseline,
    outcomes: [outcome('old-broken', 'failed', 'boom'), outcome('solid', 'passed')],
  })
  assert.equal(status, 0, 'still acquitted — age is reported, not enforced')
  const acquitted = report.pre_existing_failures[0]
  assert.equal(acquitted.failing_for_days, 30)
  assert.equal(acquitted.failing_since_is_lower_bound, false)
  assert.equal(acquitted.open_handover, null, 'null is the answer this field exists to make visible')
  assert.match(human, /failing for 30 day\(s\); UNOWNED — nobody has been told/)
  assert.match(human, /handover --test/, 'the report must name the verb that hands it on')
})

test('an entry recorded before failing_since existed is dated "at least", never precisely', async t => {
  // The fallback is the suite's own recorded_at: it was already failing then, so
  // that is a lower bound and the report may not dress it up as the real age.
  const baseline = baselineFixture()
  baseline.suites['node-root'].recorded_at = new Date(Date.now() - 10 * 24 * 3_600_000).toISOString()
  delete baseline.suites['node-root'].failures[0].failing_since
  const { report, human } = runFixture(t, {
    baseline,
    outcomes: [outcome('old-broken', 'failed', 'boom'), outcome('solid', 'passed')],
  })
  assert.equal(report.pre_existing_failures[0].failing_since_is_lower_bound, true)
  assert.match(human, /failing for at least 10 day\(s\)/)
})

test('an acquitted failure that has been handed over names its owner instead of shouting', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baseline-ledger-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const ledger = path.join(dir, 'handovers.json')
  fs.writeFileSync(ledger, JSON.stringify({
    schema: 'orgtree.test-handover/v1',
    handovers: [{ seq: 4, status: 'open', test_id: id('old-broken'), route_to: 'someone-else', at: new Date().toISOString(), work_item: 'a-ticket' }],
  }))
  const { report, human } = runFixture(t, {
    baseline: baselineFixture(),
    outcomes: [outcome('old-broken', 'failed', 'boom'), outcome('solid', 'passed')],
    args: ['--ledger', ledger],
  })
  assert.equal(report.pre_existing_failures[0].open_handover.route_to, 'someone-else')
  assert.match(human, /handed to someone-else as #4 \(a-ticket\)/)
  assert.doesNotMatch(human, /UNOWNED/)
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


// ---------------------------------------------------------------------------
// The suite name itself — a green verdict for a run that never happened
// ---------------------------------------------------------------------------
//
// `compare --suite node` ran nothing, printed `VERDICT: no new failures` and
// exited 0. The registered name is `node-root`. The only signal was an
// ABSENCE — no suite block in the output — while the verdict line positively
// asserted the opposite, and this tool is the team's designated proof that
// nobody introduced a regression. `toolbar-polish` hit it on 2026-09-17 with
// `--suite node` and `--suite python` and nearly quoted both as evidence.
//
// These cases run the tool with a bad command line, which returns before any
// suite is executed, so they cost nothing measurable.

/** Run the tool with no baseline dependency and capture everything. */
function runTool(argv) {
  const result = spawnSync(process.execPath, [TOOL, ...argv], {
    cwd: REPO, encoding: 'utf8', windowsHide: true,
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

// The two spellings that actually happened, plus one that is a near-miss in the
// other direction, so the case does not rest on a single string.
for (const name of ['node', 'python', 'renderer-x']) {
  for (const command of ['compare', 'show', 'run', 'record']) {
    test(`${command} --suite ${name} refuses instead of reporting a pass`, () => {
      const { status, stdout, stderr } = runTool([command, '--suite', name])
      assert.notEqual(status, 0, `--suite ${name} must not exit 0:\n${stderr}`)
      // The heart of it: no verdict may be printed about a suite that never
      // ran. Checked across BOTH streams, because `compare --json` moves the
      // human output to stderr and a verdict hiding on the other stream is
      // still a verdict somebody will quote.
      assert.doesNotMatch(stdout + stderr, /VERDICT/,
        `a command that ran nothing printed a verdict:\n${stdout}\n${stderr}`)
      assert.doesNotMatch(stdout + stderr, /no new failures/,
        `a command that ran nothing claimed no new failures:\n${stdout}\n${stderr}`)
      // and it names the real ones, so the next thing the reader types is right
      assert.match(stderr, /node-root/)
      assert.match(stderr, /python-backend/)
      assert.match(stderr, /renderer/)
    })
  }
}

test('the refusal suggests the registered name the typo was reaching for', () => {
  assert.match(runTool(['compare', '--suite', 'node']).stderr, /did you mean: node-root\?/)
  assert.match(runTool(['compare', '--suite', 'python']).stderr, /did you mean: python-backend\?/)
})

test('a valid suite name is still accepted — the guard refuses typos, not work', () => {
  // `show` is the one subcommand that reaches a real result without running a
  // test suite, so it is what proves the guard lets correct spellings through.
  const { status, stdout } = runTool(['show', '--suite', 'node-root'])
  assert.equal(status, 0, 'a registered suite name must not be refused')
  assert.match(stdout, /── node-root/)
})

test('show --suite actually narrows the output instead of ignoring the flag', () => {
  // It used to parse `--suite` and print all three suites anyway: the flag was
  // accepted, the output was plausible, and nothing said they did not
  // correspond. A refusal test alone would not have caught that.
  const one = runTool(['show', '--suite', 'node-root']).stdout
  const all = runTool(['show']).stdout
  assert.doesNotMatch(one, /── python-backend/)
  assert.doesNotMatch(one, /── renderer/)
  assert.match(all, /── python-backend/, 'the unfiltered form must still show everything')
  assert.match(all, /── renderer/)
})

test('a comparison that executes zero suites is never reported as clean', async t => {
  // The general form of the same defect, reached without a typo: the baseline
  // asks for node-root and the saved run holds only renderer, so the loop that
  // builds `runs` matches nothing. Before the fix this fell through to
  // newFailures === 0 and printed a green verdict about no measurement at all.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baseline-test-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const baselineFile = path.join(dir, 'baseline.json')
  const resultsFile = path.join(dir, 'results.json')
  fs.writeFileSync(baselineFile, JSON.stringify(baselineFixture()))
  fs.writeFileSync(resultsFile, JSON.stringify({
    schema: 'orgtree.test-run/v1',
    ran_at: new Date().toISOString(),
    commit: 'b'.repeat(40),
    suites: { renderer: { counts: { files: 0, tests: 0, passed: 0, failed: 0, skipped: 0 }, outcomes: [], duration_ms: 1 } },
  }))
  const { status, stdout, stderr } = runTool([
    'compare', '--baseline', baselineFile, '--results', resultsFile, '--json',
  ])
  assert.notEqual(status, 0, 'zero suites compared must not exit 0')
  assert.doesNotMatch(stdout + stderr, /VERDICT/)
  assert.doesNotMatch(stdout + stderr, /no new failures/)
  assert.match(stderr, /NOTHING WAS COMPARED/)
  // and it must not emit a report either: a caller parsing stdout has to fail
  // loudly rather than read an empty-but-green comparison
  assert.equal(stdout.trim(), '', `stdout should carry no report:\n${stdout}`)
})

test('the verdict names the suites it actually covers', async t => {
  // "Ran and found nothing new" and "ran nothing" must not be able to produce
  // the same output. Naming the coverage is what makes them distinguishable at
  // a glance, and it stops a one-suite run being quoted as a clean bill of
  // health for the whole repo.
  const { human, status } = runFixture(t, {
    baseline: baselineFixture(),
    outcomes: [outcome('old-broken', 'failed', 'boom'), outcome('solid', 'passed'), outcome('also-solid', 'passed')],
  })
  assert.equal(status, 0)
  assert.match(human, /VERDICT: no new failures in 1 suite\(s\): node-root\./)
})
