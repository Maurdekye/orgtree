import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import childProcess from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { syncBuiltinESMExports } from 'node:module'
import { withBuildLock } from '../lib.mjs'

// Legacy callers retain their result shape, but may never probe, acquire,
// release or recover the retired filesystem permit, even after failure.
function forbidLockFiles(ctx) {
  const previous = process.env.ORGTREE_BUILD_LOCK
  process.env.ORGTREE_BUILD_LOCK = path.join(os.tmpdir(), 'synthetic-permit-check', 'build.lock')
  ctx.after(() => {
    if (previous === undefined) delete process.env.ORGTREE_BUILD_LOCK
    else process.env.ORGTREE_BUILD_LOCK = previous
  })
  const touched = []
  for (const name of ['existsSync', 'readFileSync', 'statSync', 'mkdirSync', 'writeFileSync', 'rmSync']) {
    const original = fs[name]
    ctx.mock.method(fs, name, (...args) => {
      if (/build\.(?:lock|queue\.txt)(?:[\\/]|$)/i.test(String(args[0]))) {
        touched.push({ name, path: String(args[0]) })
        throw new Error('retired lock file access')
      }
      return original(...args)
    })
  }
  return touched
}

test('compatibility wrapper returns the callback value without lock files or an obsolete RAM gate', ctx => {
  const touched = forbidLockFiles(ctx)
  const result = { built: true }
  let calls = 0
  const out = withBuildLock('synthetic build', () => { calls++; return result }, { freeRam: () => 0 })
  assert.equal(calls, 1)
  assert.equal(out.result, result)
  assert.match(out.lock, /caller-managed.*build-slot/)
  assert.deepEqual(touched, [])
})

test('callback failures propagate unchanged without file-lock cleanup', ctx => {
  const touched = forbidLockFiles(ctx)
  const failure = new Error('synthetic compiler failure')
  assert.throws(() => withBuildLock('synthetic failure', () => { throw failure }, { freeRam: () => 16 }), error => error === failure)
  assert.deepEqual(touched, [])
})

test('rig build runs both original cargo steps under the caller permit without touching lock files', async ctx => {
  const savedArgs = process.argv
  const savedTarget = process.env.CARGO_TARGET_DIR
  const savedExit = process.exitCode
  const calls = [], printed = []
  const touched = forbidLockFiles(ctx)
  ctx.mock.method(childProcess, 'spawnSync', (exe, args, options) => {
    calls.push({ exe, args, options })
    assert.equal(exe, 'cargo', 'no real process or RAM probe may run')
    return { status: 0, signal: null, error: undefined }
  })
  ctx.mock.method(console, 'log', text => printed.push(JSON.parse(text)))
  ctx.mock.method(console, 'error', () => {})
  syncBuiltinESMExports()
  try {
    process.env.CARGO_TARGET_DIR = process.platform === 'win32' ? 'C:/orgtree-build/synthetic-permit-check/cargo' : '/synthetic-permit-check/cargo'
    process.argv = [process.execPath, 'rig.mjs', 'build']
    await import(`../rig.mjs?permit-check=${Date.now()}`)
    assert.equal(process.exitCode, savedExit)
    assert.equal(calls.length, 2)
    assert.deepEqual(calls[0].args, ['build', '-j', '2', '-p', 'orgtree-engine'])
    assert.deepEqual(calls[1].args, ['build', '-j', '2'])
    assert.match(calls[0].options.cwd, /engine[\\/]rs$/)
    assert.match(calls[1].options.cwd, /rig[\\/]fakecli$/)
    assert.match(printed[0].engine, /orgtree-engine\.exe$/)
    assert.match(printed[0].fakecli, /orgtree-fakecli\.exe$/)
    assert.match(printed[0].lock, /caller-managed.*build-slot/)
    assert.deepEqual(touched, [])
  } finally {
    process.argv = savedArgs
    process.exitCode = savedExit
    if (savedTarget === undefined) delete process.env.CARGO_TARGET_DIR
    else process.env.CARGO_TARGET_DIR = savedTarget
    ctx.mock.restoreAll()
    syncBuiltinESMExports()
  }
})
