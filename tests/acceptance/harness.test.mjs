import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { prerequisites, isolatedRoot, phaseResult } from './run.mjs'

test('missing runtime is inert; complete fixture enables preflight and removing a member disables it', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-acceptance-preflight-'))
  const electron = path.join(fixture, 'electron.exe'), python = path.join(fixture, 'python.exe')
  assert.equal(prerequisites(fixture, electron, python).length, 7)
  for (const item of ['electron.exe', 'python.exe', 'engine/launch.py', 'engine/backend/orgtree/api.py', 'dist/main/index.cjs', 'dist/preload/index.cjs', 'dist/renderer/index.html']) {
    const file = path.join(fixture, item)
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'preflight fixture only')
  }
  assert.deepEqual(prerequisites(fixture, electron, python), [])
  fs.unlinkSync(python)
  assert.deepEqual(prerequisites(fixture, electron, python), ['Python interpreter'])
})

test('each acceptance run gets fresh real data/profile/project directories outside live root', () => {
  const first = isolatedRoot(), second = isolatedRoot()
  assert.notEqual(first, second)
  for (const root of [first, second]) {
    assert.equal(fs.realpathSync.native(root), root)
    for (const name of ['data', 'profile', 'project']) assert.deepEqual(fs.readdirSync(path.join(root, name)), [])
  }
})

test('completed UI assertions cannot mask a timed-out or failed application shutdown', () => {
  const report = { status: 'PASS', ready: true }
  assert.equal(phaseResult('restart', report, { status: 0 }, []).status, 'PASS')
  for (const result of [{ status: null, error: { code: 'ETIMEDOUT' } }, { status: 1 }, { status: null }]) {
    assert.equal(phaseResult('restart', report, result, []).status, 'FAIL')
  }
  assert.equal(phaseResult('restart', report, { status: 0 }, [123]).status, 'FAIL')
  assert.equal(phaseResult('restart', { status: 'FAIL' }, { status: 0 }, []).status, 'FAIL')
})
