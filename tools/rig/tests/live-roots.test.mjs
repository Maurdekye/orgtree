import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { assertSafeRoot, liveRoots } from '../lib.mjs'
import { prepareFixture, fixtureSource } from '../broker-synthetic.mjs'

// The Windows rig's path guard needs no engine, database, compiler or disk I/O.
const windows = { skip: process.platform !== 'win32' }
const virtualOutput = path.join(os.tmpdir(), 'orgtree-live-roots-path-only')
const originalRoots = liveRoots()
const overlap = /overlaps the live Orgtree data folder/

function restoreEnvironment(saved) {
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, saved)
}

test('original live roots and their descendants are refused before fixture preparation', windows, () => {
  assert.ok(originalRoots.length >= 2)
  for (const root of originalRoots) {
    assert.throws(() => assertSafeRoot(root), overlap)
    assert.throws(() => assertSafeRoot(path.join(root, 'data', 'rig-home')), overlap)
  }
  assert.doesNotThrow(() => assertSafeRoot(virtualOutput))
})

test('prepareFixture cannot blind the guard to the original live roots', windows, ctx => {
  const saved = { ...process.env }
  const insideOutput = p => path.resolve(p).startsWith(virtualOutput + path.sep)
  let compilerCalls = 0, writes = 0
  try {
    // Execute real prepareFixture/environment replacement. Its only external
    // seams are virtual: no real profile access, filesystem writes or compiler.
    ctx.mock.method(fs, 'mkdirSync', p => { assert.ok(insideOutput(p)); writes++ })
    ctx.mock.method(fs, 'writeFileSync', p => { assert.ok(insideOutput(p)); writes++ })
    ctx.mock.method(fs, 'copyFileSync', (from, to) => {
      assert.ok(insideOutput(from) && insideOutput(to)); writes++
    })
    ctx.mock.method(fs, 'realpathSync', p => { assert.ok(insideOutput(p)); return path.resolve(p) })
    ctx.mock.method(fs, 'existsSync', p => insideOutput(p))
    ctx.mock.method(fs, 'readFileSync', p => {
      if (p === fixtureSource) return Buffer.from('synthetic source bytes')
      assert.ok(insideOutput(p))
      return path.basename(p) === 'gitconfig' ? '' : Buffer.from('synthetic exe bytes')
    })
    ctx.mock.method(childProcess, 'execFileSync', () => { compilerCalls++; return Buffer.alloc(0) })
    syncBuiltinESMExports()
    process.env.RIG_BROKER_OUTPUT = virtualOutput
    prepareFixture({ dir: path.join(virtualOutput, 'run') })
    assert.equal(compilerCalls, 1, 'actual prepareFixture compiler seam executed')
    assert.ok(writes > 0, 'actual prepareFixture write seams executed')
    assert.notEqual(process.env.APPDATA, saved.APPDATA)
    assert.equal(os.homedir(), path.join(virtualOutput, 'synthetic-home'))
    for (const root of originalRoots) {
      assert.throws(() => assertSafeRoot(path.join(root, 'data', 'rig-home')), overlap)
    }
    assert.deepEqual(liveRoots(), originalRoots)
    assert.doesNotThrow(() => assertSafeRoot(path.join(process.env.APPDATA, 'Orgtree v2', 'rig-home')))
  } finally {
    restoreEnvironment(saved)
    ctx.mock.restoreAll()
    syncBuiltinESMExports()
  }
})

test('an original explicit data override remains protected after it is replaced', windows, async () => {
  const saved = { ...process.env }
  const explicit = path.join(virtualOutput, 'original-data-override')
  try {
    process.env.ORGTREE_V2_DATA = explicit
    const isolated = await import('../lib.mjs?original-data-override')
    process.env.ORGTREE_V2_DATA = path.join(virtualOutput, 'replacement-data-override')
    assert.throws(() => isolated.assertSafeRoot(path.join(explicit, 'rig-home')), overlap)
  } finally { restoreEnvironment(saved) }
})

test('a caller cannot mutate the live-root snapshot through the returned array', windows, () => {
  const roots = liveRoots()
  roots.length = 0
  assert.deepEqual(liveRoots(), originalRoots)
  assert.throws(() => assertSafeRoot(path.join(originalRoots[0], 'data', 'rig-home')), overlap)
})
