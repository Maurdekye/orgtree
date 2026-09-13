import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  classifyReleaseChanges,
  createVerificationReceipt,
  reusableReceipt,
  runVerification,
  selectReleaseVerification,
  sourceFingerprint,
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
    assert.equal(reusableReceipt({ ...receipt, sourceFingerprint: 'sha256:wrong' }, expected), false)
    assert.equal(reusableReceipt({ ...receipt, fingerprint: 'sha256:wrong' }, expected), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('verification runner captures hidden child options, commands, and measured durations', () => {
  const calls = []
  const receipt = runVerification({
    root: process.cwd(), files: ['tools/release-windows.mjs'], candidate: 'abc123',
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
