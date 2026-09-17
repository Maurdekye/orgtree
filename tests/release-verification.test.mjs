import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  classifyReleaseChanges,
  createVerificationReceipt,
  isVersionOnlyChange,
  reusableReceipt,
  runVerification,
  resolveVerificationPlan,
  selectReleaseVerification,
  sourceFingerprint,
  testedSourceFiles,
} from '../tools/release-verification.mjs'

test('release selector keeps release-only changes focused', () => {
  const plan = selectReleaseVerification(['tools/release-windows.mjs', 'docs/windows-release.md'])
  assert.equal(plan.area, 'release')
  assert.equal(plan.escalation, false)
  assert.deepEqual(plan.checks.map(check => check.gate), ['source', 'receipt'])
  assert.equal(plan.gates.find(gate => gate.gate === 'artifact').reuse, true)
})

test('installer changes retain release safety checks without escalating to the full suite', () => {
  const classification = classifyReleaseChanges(['tools/installer-upgrade.ps1'])
  assert.equal(classification.area, 'installer')
  const plan = selectReleaseVerification(classification.changedFiles)
  assert.deepEqual(plan.checks.map(check => check.gate), ['installer', 'release'])
})

test('unknown and application changes escalate to both full suites', () => {
  for (const files of [['README.md'], ['apps/desktop/main.ts']]) {
    const plan = selectReleaseVerification(files)
    assert.equal(plan.area, 'full')
    assert.equal(plan.escalation, true)
    assert.deepEqual(plan.checks.map(check => check.gate), ['full-node', 'full-renderer'])
  }
})

// ---------------------------------------------------------------------------
// The full profile and the baseline. See the header comment on FULL in
// tools/release-verification.mjs for why these are pinned rather than trusted.
// ---------------------------------------------------------------------------

const fullChecks = () => selectReleaseVerification(['README.md']).checks

test('the full profile classifies failures against the baseline instead of running a raw suite', () => {
  const checks = fullChecks()
  assert.deepEqual(checks.map(check => check.gate), ['full-node', 'full-renderer'])
  for (const check of checks) {
    assert.deepEqual(check.command.slice(0, 3), ['node', 'tools/test-baseline.mjs', 'compare'],
      `${check.gate} is not going through the baseline comparison`)
  }
  // ⚠ The revert-by-simplification guard. A raw `npm test` has no concept of a
  // test that was already failing, so one unowned failure anywhere in the suite
  // blocked release verification for every commit touching an unclassified
  // path — and told the blocked agent nothing about why. Pinned so that going
  // back to it fails a test instead of silently re-breaking every ordinary
  // commit the next time a known failure appears.
  for (const check of checks) {
    assert.equal(check.command[0], 'node', `${check.gate} must not shell out to npm`)
    assert.equal(check.command.includes('test'), false,
      `${check.gate} is running a raw suite again; route it through tools/test-baseline.mjs compare`)
  }
})

test('each full gate names exactly one suite — a bare compare cannot finish in one command', () => {
  // ⚠ This is a TIMING invariant, not a style one. A bare `compare` runs all
  // three registered suites, and `python-backend` alone takes 9.9 minutes
  // (measured; it is in the baseline's own duration_ms), which puts the single
  // command past the 600s ceiling a foreground command is killed at. Split per
  // suite it was 63s and 80s, measured 2026-09-17. Dropping `--suite`, or
  // folding both gates into one, brings that ceiling straight back.
  const baseline = JSON.parse(fs.readFileSync(path.resolve('docs/test-baseline.json'), 'utf8'))
  for (const check of fullChecks()) {
    const suiteFlags = check.command.filter(argument => argument === '--suite')
    assert.equal(suiteFlags.length, 1, `${check.gate} must name exactly one suite`)
    const suite = check.command[check.command.indexOf('--suite') + 1]
    // A gate naming a suite the baseline has never measured acquits nothing and
    // counts every failure in it against whoever is committing.
    assert.ok(baseline.suites[suite], `${check.gate} names suite "${suite}", which the baseline does not record`)
  }
})

test('the full profile refuses an untrustworthy baseline but tolerates the code having moved on', () => {
  for (const check of fullChecks()) {
    assert.ok(check.command.includes('--require-usable'), `${check.gate} would trust a baseline from another machine`)
    assert.equal(check.command[check.command.indexOf('--max-age-days') + 1], '7', `${check.gate} sets no age ceiling`)
    // --require-fresh refuses on ANY drift, including the code having moved past
    // the recorded commit — which is the normal state of a release candidate, so
    // a gate carrying it would refuse every run. Measured 2026-09-17: a baseline
    // 14 hours and four commits old already reported DRIFTED.
    assert.equal(check.command.includes('--require-fresh'), false,
      `${check.gate} carries --require-fresh, which refuses every release verification`)
  }
})

test('the baseline tool is release tooling, and its own tests run when it changes', () => {
  // The lesson of ed152e5, applied to the file that now decides whether a
  // release is verified: release tooling whose own tests are not in the source
  // gate can break them and still be waved through green.
  const plan = selectReleaseVerification(['tools/test-baseline.mjs'])
  assert.equal(plan.area, 'release')
  assert.ok(plan.checks.find(check => check.gate === 'source').command.includes('tests/test-baseline.test.mjs'))
  // Its guide is classified with the release documentation, as
  // docs/windows-release.md already is.
  assert.equal(classifyReleaseChanges(['docs/known-failures.md']).area, 'release')
})

test('editing the acquittal list itself escalates to the full profile', () => {
  // docs/test-baseline.json is the list of failures the gate forgives. It is
  // deliberately NOT release tooling: if the focused profile could wave through
  // a change to it, the gate could be widened by editing its own input.
  assert.equal(classifyReleaseChanges(['docs/test-baseline.json']).area, 'full')
})

test('a full gate that reports a new failure stops the run and the receipt is not green', () => {
  const calls = []
  const receipt = runVerification({
    root: process.cwd(), files: ['README.md'], candidate: 'abc123',
    git: (_command, args) => {
      if (args[0] === 'rev-parse') return 'base123\n'
      if (args[0] === 'diff') return 'README.md\n'
      if (args[0] === 'ls-files') return 'README.md\n'
      throw new Error(`unexpected git call: ${args.join(' ')}`)
    },
    // Exit 1 is what `compare` returns for "failures this baseline does not
    // account for". It must still block: acquitting the known ones does not
    // soften the new ones.
    runner: (command, args) => { calls.push(args); return { status: 1, stdout: 'VERDICT: 1 failure(s)', stderr: '' } },
  })
  assert.equal(receipt.green, false)
  assert.equal(calls.length, 1, 'the run stops at the first failing gate')
})

test('version-only classification compares Git content and stays focused', () => {
  const values = {
    'base:package.json': { version: '2.1.3', name: 'orgtree', scripts: { test: 'node --test' } },
    'head:package.json': { version: '2.1.4', name: 'orgtree', scripts: { test: 'node --test' } },
    'base:package-lock.json': { version: '2.1.3', packages: { '': { version: '2.1.3' }, dep: { version: '1' } } },
    'head:package-lock.json': { version: '2.1.4', packages: { '': { version: '2.1.4' }, dep: { version: '1' } } },
  }
  const git = (_command, args) => JSON.stringify(values[`${args[1].startsWith('base') ? 'base' : 'head'}:${args[1].split(':').at(-1)}`])
  assert.equal(isVersionOnlyChange(['package.json', 'package-lock.json'], { root: '.', base: 'base', candidate: 'head', git }), true)
  const changed = classifyReleaseChanges(['package.json', 'package-lock.json'], { root: '.', base: 'base', candidate: 'head', git })
  assert.equal(changed.area, 'release')
  assert.equal(changed.versionOnly, true)
  assert.equal(isVersionOnlyChange(['package.json'], { root: '.', base: 'base', candidate: 'head', git }), true)
  values['head:package.json'].scripts.test = 'node --test --experimental-test-coverage'
  assert.equal(isVersionOnlyChange(['package.json'], { root: '.', base: 'base', candidate: 'head', git }), false)
})

test('version plus matching release notes stays focused, but mixed edits escalate', () => {
  const values = {
    'base:package.json': { version: '2.1.3', name: 'orgtree', scripts: { test: 'node --test' } },
    'head:package.json': { version: '2.1.4', name: 'orgtree', scripts: { test: 'node --test' } },
    'base:package-lock.json': { version: '2.1.3', packages: { '': { version: '2.1.3' }, dep: { version: '1' } } },
    'head:package-lock.json': { version: '2.1.4', packages: { '': { version: '2.1.4' }, dep: { version: '1' } } },
  }
  const git = (_command, args) => JSON.stringify(values[`${args[1].startsWith('base') ? 'base' : 'head'}:${args[1].split(':').at(-1)}`])
  const files = ['package.json', 'package-lock.json', 'docs/release-notes-2.1.4-RC1.md']
  const focused = classifyReleaseChanges(files, { root: '.', base: 'base', candidate: 'head', git })
  assert.equal(focused.area, 'release')
  assert.equal(focused.versionOnly, true)
  assert.deepEqual(testedSourceFiles(selectReleaseVerification(files, { root: '.', base: 'base', candidate: 'head', git }), {
    trackedFiles: [...files, 'tools/release-windows.mjs'],
  }), ['tools/release-windows.mjs'])
  assert.equal(classifyReleaseChanges([...files, 'README.md'], { root: '.', base: 'base', candidate: 'head', git }).area, 'full')
  values['head:package.json'].scripts.test = 'node --test --changed'
  assert.equal(classifyReleaseChanges(files, { root: '.', base: 'base', candidate: 'head', git }).area, 'full')
})

test('--plan and execution resolve the same Git-aware profile', () => {
  const values = {
    'base:package.json': { version: '2.1.3', name: 'orgtree' },
    'head:package.json': { version: '2.1.4', name: 'orgtree' },
    'base:package-lock.json': { version: '2.1.3', packages: { '': { version: '2.1.3' } } },
    'head:package-lock.json': { version: '2.1.4', packages: { '': { version: '2.1.4' } } },
  }
  const git = (_command, args) => {
    if (args[0] === 'rev-parse') return 'base\n'
    if (args[0] === 'diff') return 'package.json\npackage-lock.json\ndocs/release-notes-2.1.4-RC1.md\n'
    return JSON.stringify(values[`${args[1].startsWith('base') ? 'base' : 'head'}:${args[1].split(':').at(-1)}`])
  }
  const resolved = resolveVerificationPlan({ root: '.', base: 'base', candidate: 'head', git })
  assert.equal(resolved.candidate, 'head')
  assert.equal(resolved.plan.area, 'release')
  assert.equal(resolved.plan.versionOnly, true)
  assert.deepEqual(resolved.plan.changedFiles, ['docs/release-notes-2.1.4-RC1.md', 'package-lock.json', 'package.json'])
})

test('real Git graph resolves the immediate parent and preserves the three-file version diff', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-release-git-'))
  const gitRun = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim()
  try {
    gitRun(['init', '-q'])
    gitRun(['config', 'user.email', 'release-verification@example.invalid'])
    gitRun(['config', 'user.name', 'Release Verification'])
    fs.mkdirSync(path.join(root, 'docs'), { recursive: true })
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'orgtree', version: '2.1.3' }) + '\n')
    fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ version: '2.1.3', packages: { '': { version: '2.1.3' } } }) + '\n')
    gitRun(['add', '.'])
    gitRun(['commit', '-qm', 'base'])
    const base = gitRun(['rev-parse', 'HEAD'])
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'orgtree', version: '2.1.4' }) + '\n')
    fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ version: '2.1.4', packages: { '': { version: '2.1.4' } } }) + '\n')
    fs.writeFileSync(path.join(root, 'docs/release-notes-2.1.4-RC1.md'), '# Orgtree 2.1.4-RC1\n')
    gitRun(['add', '.'])
    gitRun(['commit', '-qm', 'version'])
    const candidate = gitRun(['rev-parse', 'HEAD'])
    const git = (_command, args, options) => execFileSync('git', args, { ...options, encoding: 'utf8', windowsHide: true }).toString()

    // Negative control: the unfixed expression dereferences the candidate and
    // therefore sees no diff at all.
    assert.equal(gitRun(['rev-parse', `${candidate}^{commit}`]), candidate)
    assert.equal(gitRun(['diff', '--name-only', `${candidate}^{commit}...${candidate}`]), '')

    const resolved = resolveVerificationPlan({ root, candidate, git })
    assert.equal(resolved.base, base)
    assert.notEqual(resolved.base, resolved.candidate)
    assert.deepEqual(resolved.plan.changedFiles, ['docs/release-notes-2.1.4-RC1.md', 'package-lock.json', 'package.json'])
    assert.equal(resolved.plan.versionOnly, true)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('receipt reuse requires the exact candidate, commands, source bytes, and intact fingerprint', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-release-verification-'))
  try {
    fs.writeFileSync(path.join(root, 'tools.txt'), 'release tooling')
    const plan = selectReleaseVerification(['tools/release-windows.mjs'])
    const source = sourceFingerprint(['tools.txt'], { root })
    const receipt = createVerificationReceipt({
      plan, candidate: 'abc123', source,
      results: plan.checks.map(check => ({ gate: check.gate, status: 0 })),
      startedAt: '2026-09-13T00:00:00.000Z', finishedAt: '2026-09-13T00:00:01.000Z',
    })
    const expected = { candidate: 'abc123', source, commands: receipt.commands }
    assert.equal(reusableReceipt(receipt, expected), true)
    assert.equal(reusableReceipt({ ...receipt, candidate: 'def456' }, expected), false)
    assert.equal(reusableReceipt(receipt, { ...expected, candidate: 'def456' }), false)
    assert.equal(reusableReceipt(receipt, { ...expected, candidate: 'def456', allowCandidateChange: true, baseCandidate: 'abc123' }), true, 'source evidence can cross its version-only child commit')
    assert.equal(reusableReceipt(receipt, { ...expected, candidate: 'def456', allowCandidateChange: true, baseCandidate: 'older' }), false, 'an unrelated older receipt cannot be reused')
    assert.equal(reusableReceipt({ ...receipt, sourceFingerprint: 'sha256:wrong' }, expected), false)
    assert.equal(reusableReceipt({ ...receipt, fingerprint: 'sha256:wrong' }, expected), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('verification runner reuses only the receipt from the exact version parent', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-release-parent-'))
  try {
    const sourcePath = path.join(root, 'tools/release-windows.mjs')
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true })
    fs.writeFileSync(sourcePath, 'release source')
    const files = ['package.json', 'package-lock.json', 'docs/release-notes-2.1.4-RC1.md']
    const values = {
      'base:package.json': { version: '2.1.3', name: 'orgtree' },
      'head:package.json': { version: '2.1.4', name: 'orgtree' },
      'base:package-lock.json': { version: '2.1.3', packages: { '': { version: '2.1.3' } } },
      'head:package-lock.json': { version: '2.1.4', packages: { '': { version: '2.1.4' } } },
    }
    const git = (_command, args) => {
      if (args[0] === 'rev-parse') return 'base\n'
      if (args[0] === 'diff') return `${files.join('\n')}\n`
      if (args[0] === 'ls-files') return 'tools/release-windows.mjs\n'
      return JSON.stringify(values[`${args[1].startsWith('base') ? 'base' : 'head'}:${args[1].split(':').at(-1)}`])
    }
    const plan = selectReleaseVerification(files, { root, base: 'base', candidate: 'head', git })
    const source = sourceFingerprint(['tools/release-windows.mjs'], { root })
    const makeReceipt = candidate => createVerificationReceipt({
      plan, candidate, source, sourceFiles: ['tools/release-windows.mjs'],
      results: plan.checks.map(check => ({ gate: check.gate, status: 0 })),
      startedAt: '2026-09-13T00:00:00.000Z', finishedAt: '2026-09-13T00:00:01.000Z',
    })
    const exactPath = path.join(root, 'exact.json')
    fs.writeFileSync(exactPath, JSON.stringify(makeReceipt('base')))
    const reused = runVerification({ root, candidate: 'head', receiptPath: exactPath, git, runner: () => { throw new Error('exact parent should reuse') } })
    assert.equal(reused.reused, true)
    const oldPath = path.join(root, 'old.json')
    fs.writeFileSync(oldPath, JSON.stringify(makeReceipt('older')))
    let ran = 0
    const rerun = runVerification({ root, candidate: 'head', receiptPath: oldPath, git, runner: () => { ran++; return { status: 0 } } })
    assert.equal(rerun.reused, undefined)
    assert.equal(ran, 2)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('explicit changed paths cannot omit a Git-detected affected file', () => {
  assert.throws(() => runVerification({
    root: process.cwd(), candidate: 'abc123', files: ['tools/release-windows.mjs'],
    git: (_command, args) => {
      if (args[0] === 'rev-parse') return 'base123\n'
      if (args[0] === 'diff') return 'apps/desktop/main.ts\ntools/release-windows.mjs\n'
      throw new Error(`unexpected git call: ${args.join(' ')}`)
    }, runner: () => ({ status: 0 }),
  }), /must exactly match the Git diff/)
})

test('fixture spawn audit keeps release Windows helpers hidden and diagnostics captured', () => {
  const files = [
    'apps/desktop/renderer/tests/run.mjs', 'tests/attach.test.mjs',
    'tests/installer-elevation.test.mjs', 'tests/quit-stop.test.mjs',
    'tests/quit_engine_probe.mjs', 'tools/test-upgrade-close-boundary.mjs',
  ]
  for (const relative of files) {
    const source = fs.readFileSync(path.resolve(relative), 'utf8')
    assert.match(source, /windowsHide\s*:\s*true/, `${relative} has no hidden child-process option`)
  }
})

test('release fixture audit requires cleanup structure for normal and failed runs', () => {
  const files = [
    'apps/desktop/renderer/tests/run.mjs', 'tests/installer-elevation.test.mjs',
    'tools/test-upgrade-close-boundary.mjs',
  ]
  for (const relative of files) {
    const source = fs.readFileSync(path.resolve(relative), 'utf8')
    assert.match(source, /finally|process\.once\(['"]exit['"]/, `${relative} has no failure/exit cleanup boundary`)
    assert.match(source, /rmSync|Remove-Item|cleanup/, `${relative} has no temporary cleanup operation`)
  }
})

test('verification runner captures hidden child options, commands, and measured durations', () => {
  const calls = []
  const receipt = runVerification({
    root: process.cwd(), files: ['tools/release-windows.mjs'], candidate: 'abc123',
    git: (_command, args) => {
      if (args[0] === 'rev-parse') {
        assert.equal(args[1], 'abc123^')
        return 'base123\n'
      }
      if (args[0] === 'diff') return 'tools/release-windows.mjs\n'
      if (args[0] === 'ls-files') return 'tools/release-windows.mjs\n'
      throw new Error(`unexpected git call: ${args.join(' ')}`)
    },
    runner: (command, args, options) => {
      calls.push({ command, args, options })
      return { status: 0, stdout: 'PASS', stderr: '' }
    },
    now: (() => { let n = 0; return () => `2026-09-13T00:00:0${n++}.000Z` })(),
  })
  assert.equal(receipt.green, true)
  assert.equal(receipt.durationMs, 1000)
  assert.equal(calls.length, 2)
  assert.equal(calls.every(call => call.options.windowsHide === true), true)
  assert.equal(calls.every(call => call.options.stdio === 'pipe'), true)
  assert.deepEqual(calls.map(call => call.args[0]), ['--test', 'tools/run-python-verification.py'])
  // ⚠ The receipt gate must NEVER be a bare `python -m unittest`. Orgtree
  // prepends its own installed backend to PYTHONPATH when it spawns an agent
  // CLI, so that form resolved `import orgtree` to the SHIPPED build and the
  // gate verified the installed app instead of the release candidate — green,
  // and wrong, for as long as it existed. The sanctioned runner launches with
  // -I, which ignores PYTHONPATH. Pinned here so a "simplification" back to
  // `-m unittest` fails a test instead of silently un-verifying every release.
  assert.equal(calls.some(call => call.args.includes('unittest')), false,
    'a release gate is running a bare `python -m unittest`; route it through tools/run-python-verification.py')
})
