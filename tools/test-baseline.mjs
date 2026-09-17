// tools/test-baseline.mjs — the shared record of what already fails.
//
// WHY THIS EXISTS. To say honestly "my change broke nothing", an agent has to
// know which tests were already failing. With no record of that, every agent
// stands up a second worktree at the base commit and runs the whole suite a
// second time — eleven agents on the 2.1.6 push described doing exactly that,
// at roughly twenty minutes of wall clock each. This tool records that answer
// once, in the repository, so the next agent reads it instead of re-deriving
// it.
//
//   node tools/test-baseline.mjs show
//       Print the recorded baseline: its commit, its age, how far main has
//       moved since, and the known failures. Runs nothing.
//
//   node tools/test-baseline.mjs record
//       Run the suites and WRITE docs/test-baseline.json. Do this on a clean
//       checkout of main. Human notes on still-failing tests are carried over.
//
//   node tools/test-baseline.mjs compare
//       Run the suites HERE, once, and split the result against the baseline
//       into NEW failures (yours), pre-existing failures (not yours), and
//       fixed. Exits 1 if and only if there are new failures.
//
//   node tools/test-baseline.mjs run --out results.json
//       Just run and save raw results, for comparing later or elsewhere.
//       `compare --results results.json` then runs nothing at all.
//
//   node tools/test-baseline.mjs handover --test "<id>" --to <agent> ...
//       Record a pre-existing failure in docs/test-handovers.json and print
//       the message that routes it to whoever owns it. Recording a handover
//       is NOT a claim on the work — see docs/known-failures.md.
//
//   node tools/test-baseline.mjs handovers
//       List the handover ledger.
//
// A BASELINE THAT DOES NOT SAY HOW OLD IT IS, IS WORSE THAN NONE. Every
// command that reads the baseline prints its age, the commit it was measured
// at, how many commits main has moved since, and whether any test file has
// changed in between. `compare` degrades that to a loud warning and, with
// --max-age-days / --require-usable / --require-fresh, to a refusal.
//
// `npm run verify:release` runs `compare` as its own full-suite gate, one gate
// per suite. See docs/known-failures.md, "Release verification runs on this
// baseline", before changing anything `compare` prints or exits with.

import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { run as runNodeTests } from 'node:test'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.dirname(HERE)
const BASELINE_PATH = path.join(REPO, 'docs', 'test-baseline.json')
const HANDOVER_PATH = path.join(REPO, 'docs', 'test-handovers.json')

const BASELINE_SCHEMA = 'orgtree.test-baseline/v1'
const HANDOVER_SCHEMA = 'orgtree.test-handover/v1'

/**
 * The main checkout, when REPO is a linked worktree. Agents here work in
 * worktrees under the repository root, so an error message routinely carries
 * both paths and neither is portable. Null in a plain clone, where REPO already
 * covers it.
 */
const MAIN_CHECKOUT = (() => {
  const common = git(['rev-parse', '--path-format=absolute', '--git-common-dir'])
  if (!common) return null
  const root = path.dirname(common)
  return path.normalize(root) === path.normalize(REPO) ? null : root
})()

// How old a baseline may get before `compare` starts shouting. Chosen because
// this repository lands work daily: a week-old baseline has usually survived,
// a fortnight-old one usually has not.
const DEFAULT_MAX_AGE_DAYS = 7

// ---------------------------------------------------------------------------
// Suites
// ---------------------------------------------------------------------------
//
// A suite is a named, re-runnable set of tests that yields per-test outcomes.
// Only suites that can report PER TEST are registered: a suite that reports
// one exit code cannot tell a new failure from an old one, which is the whole
// point here, and registering it would put a number in the baseline that
// nothing can be compared against.

const RENDERER_TESTS = path.join(REPO, 'apps', 'desktop', 'renderer', 'tests')

// Mirrors FAILURE_PHASES in tools/run-python-verification.py. Every other phase
// it reports — `pass`, `skip` — is a module that did not fail.
const PYTHON_FAILURE_PHASES = new Set([
  'assertion_failure', 'import_failure', 'teardown_failure', 'execution_failure', 'cleanup_error',
])

const SUITES = {
  'node-root': {
    title: 'Root/main-process suite',
    description: "node's built-in runner over tests/*.test.mjs — the `npm test` set",
    command: 'node --test tests/*.test.mjs',
    kind: 'node-test',
    files: () => listFiles(path.join(REPO, 'tests'), name => name.endsWith('.test.mjs')),
    excluded: [
      { what: 'tests/disruptive/*.test.mjs', why: 'separate `npm run test:disruptive` target; not part of `npm test`' },
      { what: 'tests/*.test.ps1', why: 'PowerShell boot/installer probes; not run by any node runner' },
      { what: 'tools/test-*.mjs', why: 'Electron/native probes needing a display and a built app' },
    ],
  },
  'python-backend': {
    title: 'Python backend suite',
    description: 'tools/run-python-verification.py over tests/test_*.py — a fresh interpreter and a fresh ORGTREE_DATA per module',
    command: 'python tools/run-python-verification.py tests/test_*.py',
    kind: 'python-verification',
    // MODULE-LEVEL, not test-level. The sanctioned runner reports one verdict
    // per module because it gives each one its own process and data root; that
    // isolation is the reason the suite is trustworthy at all, and it is not
    // worth trading for finer reporting. Recorded as `granularity` so nobody
    // reads a module verdict as a test verdict.
    granularity: 'module',
    files: () => listFiles(path.join(REPO, 'tests'), name => /^test_.*\.py$/.test(name)),
    excluded: [
      { what: 'tests/*.py not matching test_*.py', why: 'helpers and probes, not unittest modules' },
      { what: 'engine tests run any other way', why: 'running them without the runner\'s isolated ORGTREE_DATA produces mass spurious errors — measured: 18 errors in a module that passes cleanly under the runner' },
    ],
  },
  renderer: {
    title: 'Renderer suite',
    description: 'apps/desktop/renderer/tests/run.mjs — esbuild-bundled jsdom suites over the real renderer',
    command: 'node apps/desktop/renderer/tests/run.mjs',
    kind: 'spawn-ndjson',
    files: () => listFiles(RENDERER_TESTS, name => /\.test\.tsx?$/.test(name)),
    excluded: [
      { what: 'probe scripts (*_probe.py, *-probe.tsx, *.probe.ts)', why: 'driven by hand or by a native probe runner, not by run.mjs' },
    ],
  },
}

function listFiles(dir, predicate) {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir)
    .filter(predicate)
    .map(name => path.join(dir, name))
    .sort()
}

// ---------------------------------------------------------------------------
// Identity and scrubbing
// ---------------------------------------------------------------------------

/** Repo-relative, forward-slashed, so an id is the same in every worktree. */
function relative(file) {
  if (!file) return null
  const rel = path.relative(REPO, file)
  if (rel.startsWith('..')) return file.split(path.sep).join('/')
  return rel.split(path.sep).join('/')
}

/**
 * A test's identity across runs and across checkouts. Deliberately file+name
 * and NOT the error text: error text carries absolute paths, temp directories
 * and randomized fixture names, so using it as identity would make every
 * baseline entry a one-time match.
 */
function testId(suite, file, name) {
  return `${suite}::${file}::${name}`
}

/**
 * Make an error message comparable between machines and runs: strip the repo
 * root, the temp root, home, and the random tails that fixtures generate.
 */
function scrub(text) {
  if (typeof text !== 'string') return ''
  let out = text
  // Longest path first: a worktree lives inside the main checkout, so replacing
  // the shorter one first would leave the worktree tail dangling.
  const swap = [
    [REPO, '<repo>'],
    [MAIN_CHECKOUT, '<checkout>'],
    [os.tmpdir(), '<tmp>'],
    [os.homedir(), '<home>'],
  ].filter(([from]) => from).sort((a, b) => b[0].length - a[0].length)
  for (const [from, to] of swap) {
    // git reports forward slashes, node reports backslashes, and the same
    // message can carry both. Split on either and re-join both ways.
    const parts = from.split(/[\\/]/)
    for (const variant of [from, parts.join('/'), parts.join('\\')]) {
      out = out.split(variant).join(to)
      out = out.split(variant.toLowerCase()).join(to)
    }
  }
  // Randomized fixture tails — `acl-fixtures-JPe4Bo`, `orgtree-abc123XY` — but
  // not ordinary hyphenated English like `owner-exclusive`. A random tail mixes
  // case or mixes digits with letters; a word does neither.
  out = out.replace(/-([A-Za-z0-9_]{6,})(?![A-Za-z0-9_])/g, (whole, token) => {
    const mixedCase = /[a-z]/.test(token) && /[A-Z]/.test(token)
    const mixedDigits = /\d/.test(token) && /[A-Za-z]/.test(token)
    return mixedCase || mixedDigits ? '-<rand>' : whole
  })
  // Volatile ids that are not fixture names.
  out = out.replace(/\b\d{10,}\b/g, '<num>')
  out = out.replace(/\b[0-9a-f]{32,}\b/g, '<hex>')
  return out
}

function firstLine(text, limit = 300) {
  const line = scrub(text).split('\n').find(l => l.trim().length) ?? ''
  return line.trim().slice(0, limit)
}

function digest(text) {
  return createHash('sha256').update(text ?? '').digest('hex').slice(0, 12)
}

// ---------------------------------------------------------------------------
// Git and machine provenance
// ---------------------------------------------------------------------------

function git(args, cwd = REPO) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true })
  if (r.error || r.status !== 0) return null
  return r.stdout.trim()
}

// The directories whose content actually decides what the suites do. Their git
// TREE hashes are the precise staleness signal: two different commits with the
// same tests/ and engine/ trees run the same tests over the same code, so a
// baseline taken at one is exactly valid at the other. Commit counts alone
// cannot say that — most commits here touch neither.
const MEASURED_TREES = ['tests', 'engine', 'apps', 'packages', 'tools', 'package.json']

function treeHashes(ref = 'HEAD') {
  const out = {}
  for (const dir of MEASURED_TREES) {
    const line = git(['rev-parse', `${ref}:${dir}`])
    out[dir] = line ?? null
  }
  return out
}

function gitProvenance() {
  const commit = git(['rev-parse', 'HEAD'])
  return {
    commit,
    commit_subject: commit ? git(['log', '-1', '--format=%s', commit]) : null,
    commit_at: commit ? git(['log', '-1', '--format=%cI', commit]) : null,
    branch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
    // A baseline measured on a dirty tree is not a baseline of that commit —
    // but only where the dirt could change a test result. An uncommitted note
    // under docs/ cannot, and treating it as drift would fire the warning on
    // every run that also wrote a note, which is how an honest warning becomes
    // one people learn to ignore. `measured_tree_clean` is the one that gates.
    tree_clean: git(['status', '--porcelain']) === '',
    measured_tree_clean: git(['status', '--porcelain', '--', ...MEASURED_TREES]) === '',
    trees: treeHashes('HEAD'),
  }
}

function machineProvenance(concurrency) {
  return {
    host: os.hostname(),
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    cpus: os.cpus()?.length ?? null,
    concurrency,
  }
}

// ---------------------------------------------------------------------------
// Age / drift — how much a reader should trust the baseline
// ---------------------------------------------------------------------------

/**
 * Drift reasons that make a baseline UNUSABLE, as opposed to merely out of date.
 *
 * `--require-fresh` refuses on ANY reason, including `code_moved`, and that
 * makes it useless to an automated gate: a release verification runs on a commit
 * PAST the one the baseline was recorded at, by construction, so `code_moved` is
 * the normal condition rather than a warning sign. Measured 2026-09-17 — a
 * baseline recorded 14 hours earlier, four commits back, already reported
 * DRIFTED, so `--require-fresh` would have refused every verification that day.
 *
 * These six are different in kind. Each one means the baseline is not describing
 * THIS machine, THIS checkout, or any moment it is willing to name — so nothing
 * it acquits can be trusted, and a gate that accepted it would be exactly the
 * defect it exists to prevent: a check reporting on something other than what it
 * claims. `--require-usable` refuses on these and tolerates `code_moved`.
 */
const UNUSABLE_CODES = new Set([
  'no_timestamp', 'too_old', 'commit_unreachable', 'measured_dirty', 'host_mismatch', 'no_tree_hashes',
])

function ageOf(baseline) {
  // A baseline is only as fresh as its STALEST suite. `record --suite X`
  // re-measures one suite and carries the rest forward, so after a partial
  // re-record the top-level timestamp is the newest moment — which is exactly
  // the number that would flatter it.
  const stamps = Object.values(baseline?.suites ?? {})
    .map(suite => (suite.recorded_at ? Date.parse(suite.recorded_at) : NaN))
    .filter(Number.isFinite)
  const topLevel = baseline?.recorded_at ? Date.parse(baseline.recorded_at) : NaN
  const recordedAt = stamps.length ? Math.min(...stamps) : topLevel
  const ageHours = Number.isFinite(recordedAt) ? (Date.now() - recordedAt) / 3_600_000 : null
  const head = git(['rev-parse', 'HEAD'])
  const base = baseline?.commit ?? null

  let commitsSince = null
  let testFilesChanged = null
  let reachable = false
  if (base && head && git(['cat-file', '-e', `${base}^{commit}`]) !== null) {
    reachable = true
    const count = git(['rev-list', '--count', `${base}..HEAD`])
    commitsSince = count === null ? null : Number(count)
    const changed = git(['diff', '--name-only', `${base}...HEAD`, '--', 'tests', 'apps/desktop/renderer/tests'])
    testFilesChanged = changed === null ? null : (changed ? changed.split('\n').filter(Boolean) : [])
  }

  const sameCommit = !!base && base === head

  // The decisive check. Different commits are harmless when the trees that
  // decide the outcome are identical, and identical commit counts prove nothing
  // when they are not — most commits here touch neither the tests nor the code
  // under them.
  const nowTrees = treeHashes('HEAD')
  const treesChanged = baseline?.trees
    ? MEASURED_TREES.filter(dir => (baseline.trees[dir] ?? null) !== (nowTrees[dir] ?? null))
    : null

  const reasons = []
  const reasonCodes = []
  const notes = []
  const because = (code, text) => { reasonCodes.push(code); reasons.push(text) }
  if (ageHours === null) because('no_timestamp', 'the baseline records no timestamp')
  else if (ageHours > DEFAULT_MAX_AGE_DAYS * 24) because('too_old', `it is ${(ageHours / 24).toFixed(1)} days old`)
  if (!reachable && base) because('commit_unreachable', 'its commit is not in this checkout, so drift cannot be measured')
  if (baseline && baseline.measured_tree_clean === false) because('measured_dirty', 'it was measured with UNCOMMITTED changes to the code under test')
  else if (baseline && baseline.measured_tree_clean === undefined && baseline.tree_clean === false) because('measured_dirty', 'it was measured on a DIRTY tree')
  else if (baseline && baseline.tree_clean === false) notes.push('the tree had uncommitted files at record time, but none of them were under test')

  const hostMatches = baseline?.machine?.host ? baseline.machine.host === os.hostname() : null
  if (hostMatches === false) because('host_mismatch', `it was measured on ${baseline.machine.host}, not ${os.hostname()} — these failures are partly environmental, so treat that as drift`)

  if (treesChanged === null) because('no_tree_hashes', 'the baseline records no tree hashes, so content drift cannot be measured')
  else if (treesChanged.length) because('code_moved', `the code under test changed since, in: ${treesChanged.join(', ')}`)

  if (commitsSince) {
    const line = `HEAD is ${commitsSince} commit(s) past the baseline commit`
    if (treesChanged && treesChanged.length === 0) notes.push(`${line}, but every measured tree is byte-identical, so the baseline still describes this checkout`)
    else notes.push(line)
  }
  if (testFilesChanged?.length) notes.push(`${testFilesChanged.length} test file(s) differ between the two commits`)

  return {
    recorded_at: baseline?.recorded_at ?? null,
    age_hours: ageHours === null ? null : Number(ageHours.toFixed(2)),
    age_human: ageHours === null ? 'unknown' : humanAge(ageHours),
    baseline_commit: base,
    head_commit: head,
    same_commit: sameCommit,
    commit_reachable: reachable,
    commits_since: commitsSince,
    test_files_changed_since: testFilesChanged,
    trees_changed: treesChanged,
    host_matches: hostMatches,
    // `fresh` only when nothing that could move the result has drifted.
    verdict: reasons.length === 0 ? 'fresh' : (ageHours !== null && ageHours > DEFAULT_MAX_AGE_DAYS * 24 ? 'stale' : 'drifted'),
    reasons,
    reason_codes: reasonCodes,
    // USABLE is a weaker and more useful question than FRESH. See UNUSABLE_CODES.
    usable: !reasonCodes.some(code => UNUSABLE_CODES.has(code)),
    unusable_reasons: reasons.filter((_, index) => UNUSABLE_CODES.has(reasonCodes[index])),
    notes,
  }
}

function humanAge(hours) {
  if (hours < 1) return `${Math.round(hours * 60)} minutes`
  if (hours < 48) return `${hours.toFixed(1)} hours`
  return `${(hours / 24).toFixed(1)} days`
}

function printAge(age, say = console.log) {
  const mark = age.verdict === 'fresh' ? 'FRESH' : age.verdict === 'drifted' ? 'DRIFTED' : 'STALE'
  say(`baseline: ${mark} — recorded ${age.recorded_at ?? '(no timestamp)'} (${age.age_human} ago)`)
  say(`          at commit ${short(age.baseline_commit)}${age.same_commit ? ' (this is HEAD)' : `, HEAD is ${short(age.head_commit)}`}`)
  // Two marks, because the two classes of reason mean different things: `!` is
  // "the code moved on, read the verdict with that in mind", `✗` is "this
  // baseline cannot acquit anything here at all".
  age.reasons.forEach((reason, index) => {
    say(`  ${UNUSABLE_CODES.has(age.reason_codes?.[index]) ? '✗' : '!'} ${reason}`)
  })
  for (const note of age.notes ?? []) say(`  · ${note}`)
}

function short(sha) {
  return sha ? sha.slice(0, 10) : '(unknown)'
}

// ---------------------------------------------------------------------------
// Running a suite
// ---------------------------------------------------------------------------

/**
 * Run one suite and return per-test outcomes.
 *
 * Node reports a failing PARENT for every failing child, so a single broken
 * assertion shows up two or three times. Those aggregates are kept but marked
 * `aggregate: true`; only leaves are counted as failures.
 */
async function runSuite(suiteName, options) {
  const suite = SUITES[suiteName]
  if (!suite) throw new Error(`unknown suite: ${suiteName}`)
  let targets = options.files ?? suite.files()
  if (options.filter) targets = targets.filter(f => relative(f).includes(options.filter))
  if (!targets.length) throw new Error(`suite ${suiteName} matched no files${options.filter ? ` for filter "${options.filter}"` : ''}`)
  if (suite.kind === 'spawn-ndjson') return runSpawnedSuite(suiteName, targets, options)
  if (suite.kind === 'python-verification') return runPythonSuite(suiteName, targets, options)
  return runNodeTestSuite(suiteName, targets, options)
}

/**
 * Run the Python backend modules through the repository's own verification
 * runner.
 *
 * Reusing it rather than calling unittest directly is not politeness: each
 * module needs a fresh interpreter and a fresh ORGTREE_DATA, and without that
 * isolation the results are garbage — a module that passes cleanly under the
 * runner reports eighteen errors when run bare. A baseline built on the bare
 * invocation would record twenty spurious failures and teach every reader to
 * ignore it.
 */
async function runPythonSuite(suiteName, targets, { timeout }) {
  const started = Date.now()
  const receiptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-baseline-py-'))
  const receipt = path.join(receiptDir, 'receipt.json')
  const modules = targets.map(relative)

  const args = [
    path.join(HERE, 'run-python-verification.py'),
    '--repo-root', REPO,
    '--json-output', receipt,
    ...(timeout ? ['--timeout', String(Math.round(timeout / 1000))] : []),
    ...modules,
  ]
  const spawned = spawnSync('python', args, {
    cwd: REPO, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024,
  })

  if (!fs.existsSync(receipt)) {
    fs.rmSync(receiptDir, { recursive: true, force: true })
    throw new Error(
      `${suiteName}: the runner exited ${spawned.status} and wrote no receipt.\n` +
      `${(spawned.stderr || spawned.stdout || spawned.error?.message || '').slice(-2000)}`,
    )
  }
  const parsed = JSON.parse(fs.readFileSync(receipt, 'utf8'))
  fs.rmSync(receiptDir, { recursive: true, force: true })

  const outcomes = (parsed.modules ?? []).map(record => {
    const file = record.module ?? relative(record.module_path) ?? '(unknown module)'
    // Module granularity: the "test" name says so rather than pretending to
    // name a case the runner never reported.
    const name = `(whole module: ${record.phase})`
    // ⚠ Use the runner's OWN definition of failure, not "anything that is not
    // pass". Its non-failing phases include `skip`, and a module that skipped
    // one case is a module that passed. Reading those as failures put five
    // green modules into this baseline as known failures on the first run —
    // and a baseline with false entries in it teaches people to ignore it,
    // which is worse than having none.
    const failed = PYTHON_FAILURE_PHASES.has(record.phase)
    const message = failed ? firstLine(lastMeaningfulLine(record.stderr ?? '')) : null
    return {
      id: testId(suiteName, file, '(whole module)'),
      suite: suiteName,
      file,
      test: name,
      status: failed ? 'failed' : record.phase === 'skip' || record.phase === 'skipped' ? 'skipped' : 'passed',
      kind: 'leaf',
      failure_type: failed ? record.phase : null,
      // The runner's own tolerate-list key, so a baseline entry can be fed
      // straight back to it as `--baseline`.
      failure_id: record.failure_id ?? null,
      error: message,
      error_digest: message ? digest(message) : null,
      duration_ms: Math.round(record.duration_ms ?? 0),
    }
  })

  return {
    suite: suiteName,
    runner: SUITES[suiteName].command,
    granularity: 'module',
    duration_ms: Date.now() - started,
    files: modules,
    exit_status: spawned.status,
    outcomes: outcomes.sort((a, b) => a.id.localeCompare(b.id)),
  }
}

/** Python tracebacks end with the line that actually says what went wrong. */
function lastMeaningfulLine(stderr) {
  const lines = stderr.split('\n').map(l => l.trim()).filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^(OK|Ran \d+ tests?|-{5,}|={5,}|FAILED \()/.test(lines[i])) continue
    return lines[i]
  }
  return stderr.slice(0, 200)
}

/**
 * Run a suite whose own runner reports only an exit code.
 *
 * The runner is spawned unchanged — it owns the Job Object that bounds memory
 * and wall clock, and re-implementing that here to get structured results would
 * trade a reporting problem for a machine-wide one. Per-test outcomes come back
 * through tools/test-baseline-reporter.mjs, which node loads into every process
 * in the tree via NODE_OPTIONS.
 */
async function runSpawnedSuite(suiteName, targets, { concurrency, timeout }) {
  const started = Date.now()
  const ndjsonDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-baseline-'))
  const reporter = pathToFileURL(path.join(HERE, 'test-baseline-reporter.mjs')).href
  const all = SUITES[suiteName].files().map(relative)
  const selected = targets.map(relative)
  const partial = selected.length < all.length

  // ⚠ The runner's own default run limit is 300 s and this suite measured 274 s
  // of test time on the machine the baseline was first taken on — about ten per
  // cent of headroom. On a loaded machine that limit fires, batches are dropped,
  // and the files that never ran would be recorded as though they had passed.
  // A baseline is exactly the run that must not be silently truncated, so give
  // it real headroom and record the override as part of the environment.
  const runLimitMs = String(Number(process.env.ORGTREE_TEST_RUN_TIMEOUT_MS) || 900_000)
  const overrides = {
    ORGTREE_TEST_CONCURRENCY: String(concurrency ?? 4),
    ORGTREE_TEST_RUN_TIMEOUT_MS: runLimitMs,
  }
  const env = {
    ...process.env,
    ...overrides,
    ORGTREE_BASELINE_NDJSON_DIR: ndjsonDir,
    NODE_OPTIONS: [process.env.NODE_OPTIONS, `--test-reporter=${reporter}`, '--test-reporter-destination=stdout']
      .filter(Boolean).join(' '),
  }
  // The runner takes bare filename filters, and applies them twice — once to
  // the `.tsx` sources and again to the bundled `.mjs`. Only the extensionless
  // stem matches both. Passing the failing files back as filters is what makes
  // the confirmation pass cheap.
  const stems = selected.map(f => path.basename(f).replace(/\.tsx?$/, ''))
  const args = [path.join(RENDERER_TESTS, 'run.mjs'), ...(partial ? stems : [])]

  const spawned = spawnSync(process.execPath, args, {
    cwd: REPO, env, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024,
  })
  const stdout = spawned.stdout ?? ''
  const stderr = spawned.stderr ?? ''

  // The runner bounds the whole run at ORGTREE_TEST_RUN_TIMEOUT_MS and reports
  // 124 when it hits it, having dropped every batch that did not start. A
  // baseline built from a truncated run would read as if the dropped files had
  // passed, so this is surfaced rather than swallowed.
  const truncated = spawned.status === 124 || /RUN LIMIT|hit the run limit/.test(stderr + stdout)

  const outcomes = new Map()
  for (const name of fs.existsSync(ndjsonDir) ? fs.readdirSync(ndjsonDir) : []) {
    if (!name.endsWith('.ndjson')) continue
    for (const line of fs.readFileSync(path.join(ndjsonDir, name), 'utf8').split('\n')) {
      if (!line.trim()) continue
      let row
      try { row = JSON.parse(line) } catch { continue }
      const file = rendererSource(row.file)
      const id = testId(suiteName, file, row.name)
      const aggregate = row.failure_type === 'subtestsFailed'
      const message = row.passed ? null : firstLine(row.error ?? '')
      outcomes.set(id, {
        id,
        suite: suiteName,
        file,
        test: row.name,
        status: row.skip ? 'skipped' : row.todo ? 'todo' : row.passed ? 'passed' : 'failed',
        kind: aggregate ? 'aggregate' : 'leaf',
        failure_type: row.failure_type,
        error: message,
        error_digest: message ? digest(message) : null,
        duration_ms: Math.round(row.duration_ms ?? 0),
      })
    }
  }
  fs.rmSync(ndjsonDir, { recursive: true, force: true })

  if (!outcomes.size) {
    throw new Error(
      `${suiteName}: the runner exited ${spawned.status} but recorded no test results.\n` +
      `Usually the reporter did not load. Last runner output:\n${(stderr || stdout).slice(-2000)}`,
    )
  }

  // ⚠ A RUN THAT DIED IS NOT A RUN THAT PASSED. Besides the runner's own limit,
  // this suite can be killed from outside: an esbuild child here has reached
  // 5-9 GB and a host watchdog now kills any esbuild over 5 GB. Whatever the
  // cause, the tell is the same — files that were asked for produced no
  // outcome at all. Recording their tests as absent (and therefore, later, as
  // "fixed" or simply unmeasured) would be a lie in the most expensive
  // direction, so the whole suite is marked truncated and names the files.
  const filesWithOutcomes = new Set([...outcomes.values()].map(o => o.file))
  const silent = selected.filter(f => !filesWithOutcomes.has(f))
  const died = silent.length > 0

  return {
    suite: suiteName,
    runner: SUITES[suiteName].command,
    duration_ms: Date.now() - started,
    files: selected,
    env_overrides: overrides,
    exit_status: spawned.status,
    truncated: truncated || died || null,
    files_that_produced_no_result: silent.length ? silent : null,
    truncation_note: (truncated || died)
      ? (truncated
          ? 'The runner hit its own run limit and dropped batches. '
          : 'Some files produced no result at all — the run was cut short from outside (an out-of-memory kill, a watchdog, a crash). ')
        + `${silent.length} file(s) went unmeasured. Unmeasured is NOT passing. Fix the cause, raise ORGTREE_TEST_RUN_TIMEOUT_MS if it was the run limit, and record again.`
      : null,
    outcomes: [...outcomes.values()].sort((a, b) => a.id.localeCompare(b.id)),
  }
}

/**
 * Map a bundled test back to its source. The renderer runner esbuilds
 * `foo.test.tsx` to `<tmp>/bundles/foo.test.mjs`, so only the basename survives.
 */
function rendererSource(bundled) {
  if (!bundled) return '(unknown file)'
  const base = path.basename(bundled).replace(/\.mjs$/, '')
  for (const extension of ['.tsx', '.ts']) {
    const candidate = path.join(RENDERER_TESTS, base + extension)
    if (fs.existsSync(candidate)) return relative(candidate)
  }
  return relative(bundled) ?? bundled
}

async function runNodeTestSuite(suiteName, targets, { concurrency, timeout, onProgress }) {

  const started = Date.now()
  const outcomes = new Map()
  // Node emits the running test's name and its nesting depth but not its
  // ancestors; rebuild the path from the enclosing names seen so far, per file.
  const stacks = new Map()

  const stream = runNodeTests({
    files: targets,
    concurrency,
    timeout,
    // Tests here hold ref'd handles (React scheduler, timers); without this the
    // runner reaches 100 % and then sits forever.
    forceExit: false,
  })

  // The per-type listeners below receive the event's DATA directly; only the
  // generic `data` listener sees the {type, data} envelope.
  const record = (data, passed) => {
    const file = relative(data.file) ?? '(unknown file)'
    const stack = stacks.get(file) ?? []
    const nesting = data.nesting ?? 0
    const name = [...stack.slice(0, nesting), data.name].join(' > ')
    const failureType = data.details?.error?.failureType ?? null
    const aggregate = failureType === 'subtestsFailed'
    // A whole file that could not even load reports as a nesting-0 failure
    // whose name is the file path. That is a suite-level break, not one test.
    const isFileLevel = nesting === 0 && (data.name === file || data.name === data.file)
    const id = testId(suiteName, file, name)
    const message = passed ? null : firstLine(data.details?.error?.message ?? String(data.details?.error ?? ''))
    outcomes.set(id, {
      id,
      suite: suiteName,
      file,
      test: name,
      status: data.skip ? 'skipped' : data.todo ? 'todo' : passed ? 'passed' : 'failed',
      kind: isFileLevel ? 'file' : aggregate ? 'aggregate' : 'leaf',
      failure_type: failureType,
      error: message,
      error_digest: message ? digest(message) : null,
      duration_ms: Math.round(data.details?.duration_ms ?? 0),
    })
    if (!passed && !aggregate && onProgress) onProgress(id)
  }

  // TestsStream is a paused object-mode Readable: the per-type events below are
  // only emitted as the stream is consumed. Without a data listener nothing
  // flows, no event fires, and `end` never arrives.
  stream.on('data', () => {})
  stream.on('test:start', data => {
    const file = relative(data.file) ?? '(unknown file)'
    const stack = stacks.get(file) ?? []
    stack[data.nesting ?? 0] = data.name
    stacks.set(file, stack)
  })
  stream.on('test:pass', data => record(data, true))
  stream.on('test:fail', data => record(data, false))
  // Swallow the runner's own diagnostics; the outcome map is the record.
  stream.on('test:stderr', () => {})
  stream.on('test:stdout', () => {})

  await new Promise((resolve, reject) => {
    stream.on('end', resolve)
    stream.on('error', reject)
  })

  return {
    suite: suiteName,
    runner: SUITES[suiteName].command,
    duration_ms: Date.now() - started,
    files: targets.map(relative),
    outcomes: [...outcomes.values()].sort((a, b) => a.id.localeCompare(b.id)),
  }
}

function summarize(result) {
  const leaves = result.outcomes.filter(o => o.kind !== 'aggregate')
  return {
    files: result.files.length,
    tests: leaves.length,
    passed: leaves.filter(o => o.status === 'passed').length,
    failed: leaves.filter(o => o.status === 'failed').length,
    skipped: leaves.filter(o => o.status === 'skipped' || o.status === 'todo').length,
  }
}

function failuresOf(result) {
  return result.outcomes.filter(o => o.status === 'failed' && o.kind !== 'aggregate')
}

/**
 * Run the suite, then re-run only the files that failed.
 *
 * A test that fails once and passes on the retry is FLAKY, and a flaky test
 * recorded as a known failure is how a real regression gets waved through. The
 * confirmation pass is cheap because it only touches the failing files.
 */
async function runWithConfirmation(suiteName, options) {
  const first = await runSuite(suiteName, options)
  const failed = failuresOf(first)
  if (!failed.length || options.confirm === false) {
    for (const outcome of first.outcomes) outcome.stability = options.confirm === false ? 'unconfirmed' : 'stable'
    return { result: first, confirmation: null }
  }

  const failingFiles = [...new Set(failed.map(o => o.file))]
  console.error(`\n[baseline] confirming ${failed.length} failure(s) across ${failingFiles.length} file(s)…`)
  const second = await runSuite(suiteName, {
    ...options,
    files: failingFiles.map(f => path.join(REPO, f)),
    onProgress: null,
  })
  const secondById = new Map(second.outcomes.map(o => [o.id, o]))

  for (const outcome of first.outcomes) {
    if (!failingFiles.includes(outcome.file)) { outcome.stability = 'not-retried'; continue }
    const again = secondById.get(outcome.id)
    if (!again) { outcome.stability = 'vanished-on-retry'; continue }
    outcome.stability = again.status === outcome.status ? 'stable' : 'flaky'
    if (outcome.stability === 'flaky') outcome.retry_status = again.status
  }
  return {
    result: first,
    confirmation: { files: failingFiles, duration_ms: second.duration_ms },
  }
}

// ---------------------------------------------------------------------------
// Baseline file
// ---------------------------------------------------------------------------

function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8')
}

/** `--baseline <path>` lets a check run against a baseline from elsewhere — a
 *  peer's machine, an older commit, or a fixture in a test. */
function baselinePath(args) {
  return args?.baseline ? path.resolve(args.baseline) : BASELINE_PATH
}

function loadBaseline(args) {
  const file = baselinePath(args)
  const baseline = readJson(file, null)
  if (!baseline) return null
  if (baseline.schema !== BASELINE_SCHEMA) {
    throw new Error(`${relative(file)} has schema ${baseline.schema}, expected ${BASELINE_SCHEMA}`)
  }
  return baseline
}

function baselineFailures(baseline, suiteName) {
  const suite = baseline?.suites?.[suiteName]
  if (!suite) return null
  return new Map(suite.failures.map(f => [f.id, f]))
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdRecord(args) {
  const suiteNames = args.suite ? [args.suite] : Object.keys(SUITES)
  const concurrency = Number(args.concurrency ?? 4)
  const timeout = Number(args.timeout ?? 120_000)
  const previous = (() => { try { return loadBaseline(args) } catch { return null } })()
  const provenance = gitProvenance()

  if (!provenance.measured_tree_clean && !args.force) {
    console.error('refusing: there are uncommitted changes to the code under test, so this would not be a baseline of any commit.')
    console.error(`  dirty under: ${MEASURED_TREES.join(', ')}`)
    console.error('  commit or stash first, or pass --force and accept that measured_tree_clean is recorded as false.')
    return 2
  }
  if (!provenance.tree_clean) {
    console.error('note: the tree has uncommitted files, but none of them are under test. Recording.')
  }
  if (!args.force && provenance.branch && provenance.branch !== 'main' && !args.allowBranch) {
    console.error(`note: recording from branch ${provenance.branch}, not main. The commit is recorded either way.`)
  }

  const suites = {}
  for (const suiteName of suiteNames) {
    console.error(`[baseline] running ${suiteName} (concurrency ${concurrency}, per-test timeout ${timeout} ms)…`)
    const { result, confirmation } = await runWithConfirmation(suiteName, {
      concurrency,
      timeout,
      filter: args.filter,
      confirm: args.confirm !== false,
      onProgress: id => console.error(`  FAIL ${id}`),
    })
    const counts = summarize(result)
    const failures = failuresOf(result)

    // Carry human annotations forward. Regenerating the baseline must not cost
    // the reader the sentence that explains why a failure is expected.
    const previousNotes = new Map(
      (previous?.suites?.[suiteName]?.failures ?? []).map(f => [f.id, f.note]).filter(([, note]) => note),
    )

    // How long a failure has been acquitted, carried across re-records.
    //
    // Without this every re-record resets the clock, so a failure that has been
    // excused for a month reads exactly like one that appeared this morning, and
    // "acquitted indefinitely" becomes literally true and invisible. A failure
    // already in the previous baseline keeps its earliest known date; one whose
    // predecessor predates this field falls back to when that suite was last
    // measured, which is a LOWER BOUND — it was already failing then — and
    // `compare` says "at least" when it is reporting one.
    const recordedAt = new Date().toISOString()
    const previousSuite = previous?.suites?.[suiteName]
    const previousFailingSince = new Map(
      (previousSuite?.failures ?? []).map(f => [f.id, {
        at: f.failing_since ?? previousSuite?.recorded_at ?? null,
        exact: !!f.failing_since && f.failing_since_is_lower_bound !== true,
      }]),
    )
    const failingSince = id => {
      const before = previousFailingSince.get(id)
      if (!before?.at) return { failing_since: recordedAt, failing_since_is_lower_bound: false }
      return { failing_since: before.at, failing_since_is_lower_bound: !before.exact }
    }

    suites[suiteName] = {
      title: SUITES[suiteName].title,
      description: SUITES[suiteName].description,
      runner: SUITES[suiteName].command,
      granularity: SUITES[suiteName].granularity ?? 'test',
      // PER-SUITE provenance. `record --suite X` re-measures one suite and
      // keeps the others, which is the difference between re-recording a
      // 14-minute suite and re-recording all three. That only stays honest if
      // each suite says when and where IT was measured, because after a partial
      // re-record they are no longer the same moment.
      recorded_at: recordedAt,
      commit: provenance.commit,
      trees: provenance.trees,
      // A partial baseline must say so: without this, a filtered run reads as
      // if the unselected files had passed.
      partial: args.filter ? { filter: args.filter, warning: 'PARTIAL BASELINE — only files matching this filter were run; every other file is unmeasured, not passing.' } : null,
      excluded: SUITES[suiteName].excluded,
      duration_ms: result.duration_ms,
      confirmation_pass: confirmation,
      // A run the suite's own limits cut short measured fewer files than it
      // looks like. Say so in the record, not only on the console.
      truncated: result.truncated ?? null,
      truncation_note: result.truncation_note ?? null,
      files_that_produced_no_result: result.files_that_produced_no_result ?? null,
      env_overrides: result.env_overrides ?? null,
      counts,
      failing_files: [...new Set(failures.map(f => f.file))].sort(),
      failures: failures.map(f => ({
        id: f.id,
        file: f.file,
        test: f.test,
        kind: f.kind,
        failure_type: f.failure_type,
        stability: f.stability ?? 'unknown',
        error: f.error,
        error_digest: f.error_digest,
        ...failingSince(f.id),
        ...(previousNotes.has(f.id) ? { note: previousNotes.get(f.id) } : {}),
      })),
      // Tests that exist at all, so `compare` can tell "added by your branch"
      // from "was already failing".
      known_test_ids: result.outcomes.filter(o => o.kind !== 'aggregate').map(o => o.id),
    }
    console.error(`[baseline] ${suiteName}: ${counts.passed}/${counts.tests} passed, ${counts.failed} failed in ${(result.duration_ms / 1000).toFixed(0)}s`)
  }

  // Merge, never silently drop. Suites this run did not measure are carried
  // forward from the previous baseline with their own older provenance intact.
  const carried = []
  if (previous?.suites) {
    for (const [name, suite] of Object.entries(previous.suites)) {
      if (suites[name]) continue
      suites[name] = suite
      carried.push(name)
    }
  }
  if (carried.length) {
    console.error(`[baseline] carried forward, NOT re-measured: ${carried.join(', ')} (their own recorded_at is kept)`)
  }

  const baseline = {
    schema: BASELINE_SCHEMA,
    recorded_at: new Date().toISOString(),
    recorded_by: args.by ?? process.env.ORGTREE_AGENT ?? null,
    max_age_days: DEFAULT_MAX_AGE_DAYS,
    ...provenance,
    machine: machineProvenance(concurrency),
    suites,
  }
  if (args.out === '-') {
    console.log(JSON.stringify(baseline, null, 2))
  } else {
    const out = args.out ? path.resolve(args.out) : BASELINE_PATH
    writeJson(out, baseline)
    console.error(`[baseline] wrote ${relative(out)}`)
  }
  return 0
}

async function cmdRun(args) {
  const suiteNames = args.suite ? [args.suite] : Object.keys(SUITES)
  const concurrency = Number(args.concurrency ?? 4)
  const timeout = Number(args.timeout ?? 120_000)
  const suites = {}
  for (const suiteName of suiteNames) {
    const result = await runSuite(suiteName, { concurrency, timeout, filter: args.filter })
    for (const outcome of result.outcomes) outcome.stability = 'unconfirmed'
    suites[suiteName] = { counts: summarize(result), outcomes: result.outcomes, duration_ms: result.duration_ms }
  }
  const payload = {
    schema: 'orgtree.test-run/v1',
    ran_at: new Date().toISOString(),
    ...gitProvenance(),
    machine: machineProvenance(concurrency),
    suites,
  }
  const out = args.out ? path.resolve(args.out) : path.join(REPO, 'test-run.json')
  writeJson(out, payload)
  console.error(`[baseline] wrote ${relative(out)}`)
  return 0
}

async function cmdCompare(args) {
  const baseline = loadBaseline(args)
  if (!baseline) {
    console.error(`no baseline at ${relative(baselinePath(args))}. Record one: node tools/test-baseline.mjs record`)
    return 2
  }
  // With --json, stdout carries the report and nothing else: a caller that has
  // to find JSON inside prose is a caller that will eventually mis-parse it.
  const say = args.json ? (...parts) => console.error(...parts) : (...parts) => process.stdout.write(parts.join(' ') + '\n')
  const age = ageOf(baseline)
  printAge(age, say)

  // A refusal is NOT a test result, and an automated caller records both as a
  // non-zero exit. Say which one this is in words the next reader cannot misread
  // — otherwise the agent whose commit happened to trip it spends an afternoon
  // hunting a regression that does not exist.
  const refuse = lines => {
    console.error('\nBASELINE REFUSED — no suite was run, and this is NOT a failure of your change.')
    for (const line of lines) console.error(`  ${line}`)
    console.error('  Re-record the baseline on this machine: node tools/test-baseline.mjs record')
    return 2
  }
  const maxAge = args.maxAgeDays === undefined ? null : Number(args.maxAgeDays)
  if (maxAge !== null && age.age_hours !== null && age.age_hours > maxAge * 24) {
    return refuse([`--max-age-days ${maxAge} and the baseline is ${age.age_human} old.`])
  }
  if (args.requireUsable && !age.usable) {
    return refuse([
      'the baseline cannot acquit anything in this checkout:',
      ...age.unusable_reasons.map(reason => `  - ${reason}`),
    ])
  }
  if (args.requireFresh && age.verdict !== 'fresh') {
    return refuse(['--require-fresh and the baseline has drifted (reasons above).'])
  }
  say('')

  // Either replay a saved run or run the suites here, once.
  const suiteNames = args.suite ? [args.suite] : Object.keys(baseline.suites ?? {})
  const runs = {}
  if (args.results) {
    const saved = readJson(path.resolve(args.results), null)
    if (!saved) { console.error(`cannot read ${args.results}`); return 2 }
    for (const suiteName of suiteNames) {
      const entry = saved.suites?.[suiteName]
      if (!entry) continue
      runs[suiteName] = { outcomes: entry.outcomes, counts: entry.counts, duration_ms: entry.duration_ms }
    }
    say(`compared against saved run ${args.results} (${saved.ran_at}, commit ${short(saved.commit)}) — nothing was re-run.\n`)
  } else {
    const concurrency = Number(args.concurrency ?? baseline.machine?.concurrency ?? 4)
    const timeout = Number(args.timeout ?? 120_000)
    for (const suiteName of suiteNames) {
      if (!SUITES[suiteName]) continue
      console.error(`[baseline] running ${suiteName} once…`)
      const { result } = await runWithConfirmation(suiteName, {
        concurrency, timeout, filter: args.filter, confirm: args.confirm !== false,
      })
      runs[suiteName] = { outcomes: result.outcomes, counts: summarize(result), duration_ms: result.duration_ms }
    }
  }

  let newFailures = 0
  const report = { schema: 'orgtree.test-comparison/v1', baseline_age: age, suites: {} }

  // Who, if anyone, has been TOLD about each acquitted failure. Acquitting one
  // does not expire (see docs/known-failures.md) — blocking the next commit for
  // a failure it did not cause is the defect this tool exists to remove. What
  // replaces expiry is this: every acquittal is printed with its age and with
  // whether anybody owns it, so "nobody has ever been told" is visible on every
  // run instead of only when somebody goes looking.
  const openHandovers = (() => {
    try {
      return new Map(loadHandovers(args).handovers.filter(h => h.status === 'open').map(h => [h.test_id, h]))
    } catch { return new Map() }
  })()

  for (const suiteName of suiteNames) {
    const runResult = runs[suiteName]
    if (!runResult) continue
    const known = baselineFailures(baseline, suiteName)
    if (!known) {
      say(`── ${suiteName} ──`)
      say(`   NOT IN THE BASELINE. Every failure here is counted against you, because`)
      say(`   there is no record saying otherwise. Re-record: node tools/test-baseline.mjs record`)
      say('')
      newFailures += runResult.outcomes.filter(o => o.kind !== 'aggregate' && o.status === 'failed').length
      continue
    }
    const knownIds = new Set(baseline.suites[suiteName].known_test_ids ?? [])
    const leaves = runResult.outcomes.filter(o => o.kind !== 'aggregate')
    const failedNow = leaves.filter(o => o.status === 'failed')
    const failedNowIds = new Set(failedNow.map(o => o.id))

    const preExisting = []
    const regressions = []
    const unclassifiable = []
    const flaky = []
    for (const outcome of failedNow) {
      if (known.has(outcome.id)) {
        const before = known.get(outcome.id)
        const since = before.failing_since ?? baseline.suites[suiteName]?.recorded_at ?? null
        const sinceMs = since ? Date.parse(since) : NaN
        const handover = openHandovers.get(outcome.id) ?? null
        preExisting.push({
          ...outcome,
          baseline_note: before.note ?? null,
          baseline_stability: before.stability,
          error_changed: before.error_digest !== outcome.error_digest,
          failing_since: since,
          // True when the date is only "it was already failing by then" — either
          // the entry predates `failing_since` or it was itself carried from
          // such an entry. Reported as "at least", never as the real age.
          failing_since_is_lower_bound: !before.failing_since || before.failing_since_is_lower_bound === true,
          failing_for_days: Number.isFinite(sinceMs) ? Number(((Date.now() - sinceMs) / 86_400_000).toFixed(1)) : null,
          // `null` is the answer this exists to make visible: acquitted, and
          // nobody has ever been handed it.
          open_handover: handover && { seq: handover.seq, route_to: handover.route_to, at: handover.at, work_item: handover.work_item ?? null },
        })
      } else if (outcome.stability === 'flaky') {
        // THIS RUN watched it fail and then pass, in this checkout, minutes
        // apart. That is an observation, not an inference, and a test that
        // passes on re-run is not a deterministic regression — calling it one
        // would make the gate cry wolf on every flaky file in the tree. It is
        // still reported, loudly and separately, because a change that MAKES a
        // test flaky is a real defect; --strict-flaky fails the gate on it.
        flaky.push(outcome)
      } else if (!knownIds.has(outcome.id)) {
        // The baseline never saw this test. Usually your branch added it; it
        // could also be a rename. Either way the baseline cannot acquit it.
        unclassifiable.push(outcome)
      } else {
        regressions.push(outcome)
      }
    }
    const fixed = [...known.values()]
      .filter(f => !failedNowIds.has(f.id) && leaves.some(o => o.id === f.id))
      // A flaky failure that happens to pass this time is not a fix, and
      // reporting it as one hands the agent a credit it did not earn.
      .map(f => ({ ...f, likely_flakiness_not_a_fix: f.stability === 'flaky' }))
    const disappeared = [...known.values()].filter(f => !leaves.some(o => o.id === f.id))

    newFailures += regressions.length + unclassifiable.length + (args.strictFlaky ? flaky.length : 0)
    report.suites[suiteName] = {
      counts: runResult.counts,
      new_failures: regressions,
      unclassifiable_failures: unclassifiable,
      flaky_failures: flaky,
      pre_existing_failures: preExisting,
      fixed_since_baseline: fixed,
      baseline_tests_absent_from_this_run: disappeared.map(f => f.id),
    }

    say(`── ${suiteName} ──`)
    say(`   ${runResult.counts.passed}/${runResult.counts.tests} passed, ${runResult.counts.failed} failed`)
    say('')
    say(`   NEW FAILURES (yours): ${regressions.length}`)
    for (const f of regressions) say(`     ✗ ${f.file} :: ${f.test}\n         ${f.error}`)
    if (unclassifiable.length) {
      say(`   FAILURES THE BASELINE CANNOT ACQUIT (test not in baseline — new or renamed): ${unclassifiable.length}`)
      for (const f of unclassifiable) say(`     ? ${f.file} :: ${f.test}\n         ${f.error}`)
    }
    if (flaky.length) {
      say(`   FLAKY HERE — failed, then passed on re-run in this checkout: ${flaky.length}${args.strictFlaky ? ' (counted against you: --strict-flaky)' : ' (not counted against you)'}`)
      for (const f of flaky) say(`     ~ ${f.file} :: ${f.test}\n         ${f.error}`)
    }
    say(`   PRE-EXISTING (not yours): ${preExisting.length}`)
    for (const f of preExisting) {
      const flags = [f.baseline_stability === 'flaky' ? 'FLAKY in baseline' : null, f.error_changed ? 'error text differs' : null].filter(Boolean)
      say(`     · ${f.file} :: ${f.test}${flags.length ? `  [${flags.join('; ')}]` : ''}`)
      const age = f.failing_for_days === null ? 'failing for an unrecorded length of time'
        : `failing for ${f.failing_since_is_lower_bound ? 'at least ' : ''}${f.failing_for_days} day(s)`
      const owner = f.open_handover
        ? `handed to ${f.open_handover.route_to} as #${f.open_handover.seq}${f.open_handover.work_item ? ` (${f.open_handover.work_item})` : ''}`
        : 'UNOWNED — nobody has been told'
      say(`         ${age}; ${owner}`)
      if (!f.open_handover) {
        say(`         hand it on:  node tools/test-baseline.mjs handover --test "${f.id}" --to <agent>`)
      }
      if (f.baseline_note) say(`         note: ${f.baseline_note}`)
    }
    if (fixed.length) {
      say(`   FIXED since the baseline: ${fixed.length}`)
      for (const f of fixed) {
        say(`     ✓ ${f.file} :: ${f.test}${f.likely_flakiness_not_a_fix ? '  [was FLAKY in the baseline — probably flakiness, not a fix]' : ''}`)
      }
    }
    if (disappeared.length) {
      say(`   IN THE BASELINE BUT NOT IN THIS RUN: ${disappeared.length} (renamed, removed, or not selected)`)
      for (const id of report.suites[suiteName].baseline_tests_absent_from_this_run) say(`     – ${id}`)
    }
    say('')
  }

  if (args.json) console.log(JSON.stringify(report, null, 2))
  const flakyTotal = Object.values(report.suites).reduce((n, s) => n + (s.flaky_failures?.length ?? 0), 0)
  if (newFailures === 0) {
    say('VERDICT: no new failures. Every failure in this run was already failing in the baseline.')
    if (flakyTotal && !args.strictFlaky) {
      say(`         ${flakyTotal} test(s) failed and then passed on re-run here. Not counted as regressions,`)
      say('         but they are named above — do not quote this verdict without them.')
    }
    if (age.verdict !== 'fresh') say('         (read the drift warnings above before quoting this as proof.)')
  } else {
    say(`VERDICT: ${newFailures} failure(s) this baseline does not account for. Read them above.`)
  }
  say('\nTo hand a pre-existing failure to whoever owns it — without taking it on yourself:')
  say('  node tools/test-baseline.mjs handover --test "<id>" --to <agent> --summary "..."')
  return newFailures === 0 ? 0 : 1
}

function cmdShow(args) {
  const baseline = loadBaseline(args)
  if (!baseline) {
    console.error(`no baseline at ${relative(baselinePath(args))}. Record one: node tools/test-baseline.mjs record`)
    return 2
  }
  const age = ageOf(baseline)
  if (args.json) { console.log(JSON.stringify({ ...baseline, age }, null, 2)); return 0 }

  printAge(age)
  console.log(`          recorded by ${baseline.recorded_by ?? '(unrecorded)'} on ${baseline.machine?.host} (${baseline.machine?.platform}/${baseline.machine?.arch}, node ${baseline.machine?.node}, concurrency ${baseline.machine?.concurrency})`)
  console.log('')
  for (const [name, suite] of Object.entries(baseline.suites ?? {})) {
    console.log(`── ${name} — ${suite.title}`)
    console.log(`   ${suite.runner}`)
    if (suite.granularity === 'module') {
      console.log('   reports per MODULE, not per test — one verdict covers every case in the file')
    }
    // Only shout when this suite is MEANINGFULLY older than the file as a
    // whole. The suites of a single `record` are milliseconds apart, and a
    // warning that fires every time is a warning nobody reads.
    const lag = suite.recorded_at && baseline.recorded_at
      ? Date.parse(baseline.recorded_at) - Date.parse(suite.recorded_at)
      : 0
    if (lag > 60_000) {
      console.log(`   ! CARRIED FORWARD, not re-measured: last run ${suite.recorded_at} at ${short(suite.commit)}, ${humanAge(lag / 3_600_000)} older than the rest of this baseline`)
    }
    if (suite.partial) console.log(`   ! ${suite.partial.warning} (filter: ${suite.partial.filter})`)
    if (suite.truncated) console.log(`   ! ${suite.truncation_note}`)
    console.log(`   ${suite.counts.passed}/${suite.counts.tests} passed · ${suite.counts.failed} known failures across ${suite.failing_files.length} file(s) · ${(suite.duration_ms / 1000).toFixed(0)}s`)
    for (const file of suite.failing_files) {
      console.log(`   ${file}`)
      for (const f of suite.failures.filter(x => x.file === file)) {
        console.log(`     · ${f.test}${f.stability === 'flaky' ? '  [FLAKY]' : ''}`)
        console.log(`         ${f.error}`)
        if (f.note) console.log(`         note: ${f.note}`)
      }
    }
    if (suite.excluded?.length) {
      console.log('   NOT COVERED by this baseline:')
      for (const e of suite.excluded) console.log(`     – ${e.what} — ${e.why}`)
    }
    console.log('')
  }
  return 0
}

// ---------------------------------------------------------------------------
// Handover — the missing verb
// ---------------------------------------------------------------------------
//
// A pre-existing failure is a real finding that belongs to somebody else. Every
// existing way of writing it down implies taking it on: a docket finding needs
// an item, and the only item the reporter holds is its own. So the durable
// record lives here, in the repository, beside the baseline — and carries
// `claimed: false` as a structural field the tool will not let you set.

function handoverPath(args) {
  return args?.ledger ? path.resolve(args.ledger) : HANDOVER_PATH
}

function loadHandovers(args) {
  const ledger = readJson(handoverPath(args), null)
  if (!ledger) return { schema: HANDOVER_SCHEMA, handovers: [] }
  if (ledger.schema !== HANDOVER_SCHEMA) throw new Error(`${relative(handoverPath(args))} has schema ${ledger.schema}`)
  return ledger
}

function cmdHandover(args) {
  if (args.claim || args.claimed) {
    console.error('refusing: a handover records that a failure is NOT yours. It cannot carry a claim.')
    console.error('  If you mean to fix it, take the owning ticket instead.')
    return 2
  }
  if (!args.test) { console.error('handover needs --test "<id or substring>"'); return 2 }

  const baseline = loadBaseline(args)
  if (!baseline) { console.error('no baseline to hand over from; record one first.'); return 2 }

  const all = Object.entries(baseline.suites ?? {}).flatMap(([suite, s]) => s.failures.map(f => ({ ...f, suite })))
  const matches = all.filter(f => f.id === args.test || f.id.includes(args.test) || f.test.includes(args.test))
  if (!matches.length) {
    console.error(`no known failure matches "${args.test}".`)
    console.error('  This is the guard rail: you can only hand over a failure the baseline says was ALREADY there.')
    console.error('  If it is not in the baseline, it is not pre-existing as far as the record goes — either')
    console.error('  re-record the baseline, or treat it as yours.')
    return 2
  }
  if (matches.length > 1 && !args.all) {
    console.error(`"${args.test}" matches ${matches.length} known failures; narrow it or pass --all:`)
    for (const m of matches) console.error(`  ${m.id}`)
    return 2
  }

  const ledger = loadHandovers(args)
  const seqStart = ledger.handovers.reduce((n, h) => Math.max(n, h.seq), 0)
  const created = []
  matches.forEach((match, index) => {
    const existing = ledger.handovers.find(h => h.test_id === match.id && h.status === 'open')
    if (existing && !args.again) {
      console.error(`already handed over as #${existing.seq} by ${existing.reported_by} → ${existing.route_to} (${existing.at}). Not duplicating; pass --again to add another.`)
      return
    }
    const entry = {
      seq: seqStart + index + 1,
      at: new Date().toISOString(),
      reported_by: args.by ?? process.env.ORGTREE_AGENT ?? '(unidentified)',
      // Structural, and the tool refuses to set it otherwise. Recording a
      // pre-existing failure is not an undertaking to fix it.
      claimed: false,
      ownership: 'not-claimed-by-reporter',
      suite: match.suite,
      test_id: match.id,
      file: match.file,
      test: match.test,
      error: match.error,
      baseline_commit: baseline.commit,
      baseline_recorded_at: baseline.recorded_at,
      observed_at_commit: git(['rev-parse', 'HEAD']),
      route_to: args.to ?? 'unrouted',
      work_item: args.item ?? null,
      summary: args.summary ?? match.error ?? match.test,
      detail: args.detail ?? null,
      status: 'open',
    }
    ledger.handovers.push(entry)
    created.push(entry)
  })

  if (!created.length) return 1
  writeJson(handoverPath(args), ledger)
  console.error(`[baseline] recorded ${created.length} handover(s) in ${relative(HANDOVER_PATH)}\n`)

  for (const entry of created) {
    console.log('─'.repeat(72))
    console.log(`HANDOVER #${entry.seq} — send this, unchanged, to ${entry.route_to}:`)
    console.log('─'.repeat(72))
    console.log(handoverMessage(entry))
    console.log('')
  }
  console.log('Send it with orgtree_send_notice (passive — it does not wake anyone) unless')
  console.log('the recipient needs to act now, in which case use orgtree_message.')
  return 0
}

/**
 * The routing text. Its first job is to say, in words the recipient cannot
 * misread, that the sender is not taking this on.
 */
function handoverMessage(entry) {
  return [
    `PRE-EXISTING TEST FAILURE — reported, not claimed.`,
    ``,
    `I am not working on this and I am not taking it on. I ran into it while checking my own`,
    `change and the recorded baseline says it was already failing before I touched anything.`,
    `Passing it to you because it looks like yours. If it is not, hand it on.`,
    ``,
    `  suite:  ${entry.suite}`,
    `  file:   ${entry.file}`,
    `  test:   ${entry.test}`,
    `  error:  ${entry.error ?? '(none recorded)'}`,
    ``,
    `Already failing at ${short(entry.baseline_commit)}, measured ${entry.baseline_recorded_at}.`,
    `Seen again at ${short(entry.observed_at_commit)}.`,
    entry.detail ? `\n${entry.detail}` : '',
    ``,
    `The durable record is docs/test-handovers.json entry #${entry.seq}; it carries claimed: false.`,
    `Reproduce with:  node --test ${entry.file}`,
    `See the baseline: node tools/test-baseline.mjs show`,
  ].filter(l => l !== undefined).join('\n')
}

function cmdHandovers(args) {
  const ledger = loadHandovers(args)
  if (args.json) { console.log(JSON.stringify(ledger, null, 2)); return 0 }
  if (!ledger.handovers.length) { console.log('no handovers recorded.'); return 0 }
  for (const h of ledger.handovers) {
    if (args.open && h.status !== 'open') continue
    console.log(`#${h.seq}  [${h.status}]  ${h.reported_by} → ${h.route_to}${h.work_item ? ` (${h.work_item})` : ''}`)
    console.log(`     ${h.file} :: ${h.test}`)
    console.log(`     ${h.summary}`)
    console.log(`     recorded ${h.at}; claimed by reporter: ${h.claimed}`)
    console.log('')
  }
  return 0
}

function cmdResolve(args) {
  const ledger = loadHandovers(args)
  const entry = ledger.handovers.find(h => String(h.seq) === String(args.seq))
  if (!entry) { console.error(`no handover #${args.seq}`); return 2 }
  const status = args.status ?? 'closed'
  if (!['open', 'accepted', 'closed', 'declined'].includes(status)) {
    console.error(`status must be one of open|accepted|closed|declined`); return 2
  }
  entry.status = status
  entry.resolution = { at: new Date().toISOString(), by: args.by ?? process.env.ORGTREE_AGENT ?? '(unidentified)', note: args.note ?? null }
  writeJson(handoverPath(args), ledger)
  console.log(`#${entry.seq} → ${status}`)
  return 0
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (!token.startsWith('--')) { args._.push(token); continue }
    const [flag, inline] = token.slice(2).split('=', 2)
    const key = flag.replace(/-([a-z])/g, (_, c) => c.toUpperCase())
    const boolean = ['json', 'force', 'claim', 'claimed', 'all', 'again', 'open', 'requireFresh', 'requireUsable', 'allowBranch', 'strictFlaky']
    if (flag === 'no-confirm') { args.confirm = false; continue }
    if (boolean.includes(key)) { args[key] = inline === undefined ? true : inline !== 'false'; continue }
    args[key] = inline ?? argv[++i]
  }
  return args
}

const USAGE = `tools/test-baseline.mjs — the shared record of what already fails

  show                     print the baseline, its commit and its age (runs nothing)
  record                   run the suites and write docs/test-baseline.json
  run --out <file>         run the suites and save raw results
  compare [--results F]    run once here and split new failures from pre-existing ones
  handover --test <id> --to <agent> [--summary S] [--detail D] [--item SLUG] [--by ME]
  handovers [--open]       list the handover ledger
  resolve --seq N --status accepted|closed|declined [--note N]

common flags
  --suite <name>           limit to one suite (${Object.keys(SUITES).join(', ')})
  --filter <substring>     only files whose path contains this. A baseline recorded
                           with a filter is stored as PARTIAL and says so everywhere.
  --concurrency <n>        test-file concurrency (default 4; recorded in the baseline)
  --timeout <ms>           per-test timeout (default 120000)
  --no-confirm             skip the re-run of failing files that separates flaky from stable
  --json                   machine-readable output
  --max-age-days <n>       compare: refuse if the baseline is older than this
  --require-usable         compare: refuse unless the baseline describes THIS machine and
                           THIS checkout — wrong host, unreachable commit, dirty measurement,
                           no timestamp, no tree hashes. Code having moved on is tolerated,
                           because a release gate always runs past the recorded commit.
  --require-fresh          compare: refuse unless the baseline shows no drift at all.
                           Too strict for a gate: see --require-usable.
  --strict-flaky           compare: count a test that failed then passed on re-run as a regression
  --by <agent>             record/handover: who is doing this
  --baseline <file>        read the baseline from here instead of docs/test-baseline.json
  --ledger <file>          read/write the handover ledger here instead of docs/test-handovers.json
`

// An exception thrown inside a stream listener would otherwise kill the process
// with no output at all, which reads exactly like "the suite ran and found
// nothing". Say what happened instead.
process.on('uncaughtException', error => {
  console.error('\n[baseline] ABORTED — uncaught error:\n' + (error?.stack ?? String(error)))
  process.exit(2)
})
process.on('unhandledRejection', error => {
  console.error('\n[baseline] ABORTED — unhandled rejection:\n' + (error?.stack ?? String(error)))
  process.exit(2)
})

async function main() {
  const argv = process.argv.slice(2)
  const command = argv[0]
  const args = parseArgs(argv.slice(1))
  switch (command) {
    case 'show': return cmdShow(args)
    case 'record': return await cmdRecord(args)
    case 'run': return await cmdRun(args)
    case 'compare': return await cmdCompare(args)
    case 'handover': return cmdHandover(args)
    case 'handovers': return cmdHandovers(args)
    case 'resolve': return cmdResolve(args)
    default:
      console.log(USAGE)
      return command === undefined || command === '--help' || command === 'help' ? 0 : 2
  }
}

main().then(code => { process.exitCode = code }, error => {
  console.error(error?.stack ?? String(error))
  process.exitCode = 2
})
