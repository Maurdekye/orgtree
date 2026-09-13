import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
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
    if (args[0] === 'diff') return 'package.json\npackage-lock.json\ndocs/release-notes-2.1.4-RC1.md\n'
    return JSON.stringify(values[`${args[1].startsWith('base') ? 'base' : 'head'}:${args[1].split(':').at(-1)}`])
  }
  const resolved = resolveVerificationPlan({ root: '.', base: 'base', candidate: 'head', git })
  assert.equal(resolved.candidate, 'head')
  assert.equal(resolved.plan.area, 'release')
  assert.equal(resolved.plan.versionOnly, true)
  assert.deepEqual(resolved.plan.changedFiles, ['docs/release-notes-2.1.4-RC1.md', 'package-lock.json', 'package.json'])
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
    assert.equal(reusableReceipt(receipt, { ...expected, candidate: 'def456', allowCandidateChange: true }), true, 'source evidence can cross a version-only commit')
    assert.equal(reusableReceipt({ ...receipt, sourceFingerprint: 'sha256:wrong' }, expected), false)
    assert.equal(reusableReceipt({ ...receipt, fingerprint: 'sha256:wrong' }, expected), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('explicit changed paths cannot omit a Git-detected affected file', () => {
  assert.throws(() => runVerification({
    root: process.cwd(), candidate: 'abc123', files: ['tools/release-windows.mjs'],
    git: (_command, args) => {
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
  assert.deepEqual(calls.map(call => call.args[0]), ['--test', '-m'])
})
