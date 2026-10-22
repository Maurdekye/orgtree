// Short-lived path-only Node workers, never the real keeper/engine. All roots
// are fictional and actual prepareFixture's file/compiler seams are mocked.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import childProcess from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { syncBuiltinESMExports } from 'node:module'
import { mock } from 'node:test'
import { assertSafeRoot, liveRoots, cleanEnv } from '../../lib.mjs'
import { prepareFixture, fixtureSource } from '../../broker-synthetic.mjs'

const self = fileURLToPath(import.meta.url)
const base = 'C:\\Rig-Live-Roots-Unit'
const overlap = /overlaps the live Orgtree data folder/
const stage = process.argv[2]
function refuse(roots) {
  for (const root of roots) assert.throws(() => assertSafeRoot(path.join(root, 'data', 'rig-home')), overlap)
  assert.doesNotThrow(() => assertSafeRoot(path.join(base, 'scratch', 'synthetic-home')))
}
function child(next, roots, env) {
  const result = childProcess.spawnSync(process.execPath, [self, next, JSON.stringify(roots)], {
    env, windowsHide: true, encoding: 'utf8', timeout: 5000,
  })
  assert.equal(result.error, undefined)
  assert.equal(result.signal, null)
  assert.equal(result.status, 0, result.stderr || result.stdout)
  return result.stdout
}

if (stage === 'parent') {
  const original = liveRoots()
  assert.ok(original.every(root => root.startsWith(base)))
  refuse(original)
  const output = path.join(base, 'scratch')
  const inside = p => path.resolve(p).startsWith(output + path.sep)
  try {
    for (const name of ['mkdirSync', 'writeFileSync']) mock.method(fs, name, p => assert.ok(inside(p)))
    mock.method(fs, 'copyFileSync', (from, to) => assert.ok(inside(from) && inside(to)))
    mock.method(fs, 'realpathSync', p => { assert.ok(inside(p)); return path.resolve(p) })
    mock.method(fs, 'existsSync', p => inside(p))
    mock.method(fs, 'readFileSync', p => {
      if (p === fixtureSource) return Buffer.from('synthetic source')
      assert.ok(inside(p))
      return path.basename(p) === 'gitconfig' ? '' : Buffer.from('synthetic exe')
    })
    mock.method(childProcess, 'execFileSync', () => Buffer.alloc(0))
    syncBuiltinESMExports()
    process.env.RIG_BROKER_OUTPUT = output
    prepareFixture({ dir: path.join(output, 'run') })
  } finally { mock.restoreAll(); syncBuiltinESMExports() }
  assert.equal(process.env.USERPROFILE, path.join(output, 'synthetic-home'))
  assert.equal(process.env.ORGTREE_V2_DATA, undefined, 'actual fixture removed original override')
  refuse(original)
  const result = child('keeper', original, cleanEnv())
  assert.match(result, /grandchild protected/)
  console.log('fresh keeper and grandchild protected')
} else if (stage === 'keeper') {
  const original = JSON.parse(process.argv[3])
  refuse(original)
  assert.deepEqual(liveRoots(), original, 'fresh import adopts original roots, not synthetic home')
  // A replacement metadata value can add protection but cannot discard this
  // process's import-time roots when cleanEnv builds the next child environment.
  const extra = path.join(base, 'additional-protected-root')
  process.env.RIG_PROTECTED_ROOTS = JSON.stringify([extra])
  const next = cleanEnv()
  const roots = [...new Set([...original, extra])]
  assert.deepEqual(JSON.parse(next.RIG_PROTECTED_ROOTS), roots)
  const result = child('grandchild', roots, next)
  assert.match(result, /grandchild protected/)
  console.log(result.trim())
} else if (stage === 'grandchild') {
  const roots = JSON.parse(process.argv[3])
  assert.deepEqual(liveRoots(), roots)
  refuse(roots)
  console.log('grandchild protected')
} else if (stage === 'import-only') {
  console.log('import succeeded')
} else { throw Error('unknown path-only fixture stage') }
