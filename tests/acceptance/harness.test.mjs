import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { prerequisites, isolatedRoot, phaseResult, runtimeManifest } from './run.mjs'

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
    for (const name of ['data', 'profile', 'project', 'home']) assert.deepEqual(fs.readdirSync(path.join(root, name)), [])
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

test('runtime provenance changes when executable source or compiled resources change', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-acceptance-provenance-'))
  fs.mkdirSync(path.join(fixture, 'engine'))
  fs.mkdirSync(path.join(fixture, 'dist'))
  fs.writeFileSync(path.join(fixture, 'engine/launch.py'), 'source one')
  fs.writeFileSync(path.join(fixture, 'dist/app.cjs'), 'bundle one')
  const original = runtimeManifest(fixture)
  assert.equal(Object.keys(original.files).length, 2)
  assert.deepEqual(runtimeManifest(fixture), original)
  fs.writeFileSync(path.join(fixture, 'dist/app.cjs'), 'bundle two')
  assert.notEqual(runtimeManifest(fixture).digest, original.digest)
  const next = runtimeManifest(fixture)
  fs.writeFileSync(path.join(fixture, 'engine/launch.py'), 'source two')
  assert.notEqual(runtimeManifest(fixture).digest, next.digest)
})
