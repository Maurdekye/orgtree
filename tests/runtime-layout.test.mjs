// runtime-layout.test.mjs — the packaged Python runtime's LAYOUT contract.
//
// 2.1.4-RC4 shipped with every backend dependency at engine/runtime/
// site-packages while python313._pth names Lib/site-packages; the installed
// app could not import its own server. These tests hold the shared layout
// validator to that exact failure (a fixture reproducing the RC4 tree must be
// refused BY NAME), to the manifest-vs-dist-info completeness rule, to the
// tree digest that staging identity rests on, and to the staging command that
// replaces the hand copy which caused the field failure. When a provisioned
// runtime exists in this checkout (every release build worktree), the import
// probe runs the REAL embedded interpreter — the check is only skipped where
// there is genuinely no runtime to probe.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  assertRuntimeImports,
  assertRuntimeLayout,
  assertRuntimeLayoutMac,
  locateEngineRuntime,
  normalizeDistName,
  REPRESENTATIVE_RUNTIME_IMPORTS,
  runtimeTreeDigest,
} from '../tools/runtime-layout.mjs'
import { stageRuntime } from '../tools/stage-runtime.mjs'

const repoRoot = path.resolve(import.meta.dirname, '..')

function fixtureRoot() {
  // realpathSync: on macOS os.tmpdir() sits behind /var -> /private/var, and
  // stageRuntime's junction/symlink guard (rightly) refuses any ancestor
  // symlink, so fixtures must hand back the already-resolved path.
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-runtime-layout-')))
}

function put(root, relative, content) {
  const file = path.join(root, ...relative.split('/'))
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
  return file
}

const PTH = 'python313.zip\r\n.\r\nLib/site-packages\r\n../backend\r\n../mailhub\r\n../../\r\nimport site\r\n'
const MANIFEST = JSON.stringify({
  python: '3.13.15',
  dependencies: [
    { name: 'fastapi', version: '0.141.1' },
    { name: 'annotated-doc', version: '0.0.5' },
    { name: 'typing_extensions', version: '4.15.0' },
  ],
})
const MAC_PTH = '../../../../backend\n../../../../mailhub\n../../../../../\n'

/** A minimal CORRECT runtime tree matching what provision-runtime.py writes. */
function correctRuntime(root, runtimeRelative = 'engine/runtime') {
  put(root, `${runtimeRelative}/python.exe`, 'exe-bytes')
  put(root, `${runtimeRelative}/python313.zip`, 'zip-bytes')
  put(root, `${runtimeRelative}/python313._pth`, PTH)
  put(root, `${runtimeRelative}/runtime-manifest.json`, MANIFEST)
  put(root, `${runtimeRelative}/Lib/site-packages/fastapi-0.141.1.dist-info/METADATA`, 'meta')
  put(root, `${runtimeRelative}/Lib/site-packages/fastapi/__init__.py`, 'fastapi')
  put(root, `${runtimeRelative}/Lib/site-packages/annotated_doc-0.0.5.dist-info/METADATA`, 'meta')
  put(root, `${runtimeRelative}/Lib/site-packages/typing_extensions-4.15.0.dist-info/METADATA`, 'meta')
  put(root, `${runtimeRelative}/Lib/site-packages/typing_extensions.py`, 'module')
  return path.join(root, ...runtimeRelative.split('/'))
}

/** A minimal CORRECT macOS runtime tree matching what provision-runtime.py's darwin branch writes. */
function correctRuntimeMac(root, runtimeRelative = 'engine/runtime') {
  put(root, `${runtimeRelative}/bin/python3.13`, 'exe-bytes')
  put(root, `${runtimeRelative}/runtime-manifest.json`, MANIFEST)
  put(root, `${runtimeRelative}/lib/python3.13/site-packages/fastapi-0.141.1.dist-info/METADATA`, 'meta')
  put(root, `${runtimeRelative}/lib/python3.13/site-packages/fastapi/__init__.py`, 'fastapi')
  put(root, `${runtimeRelative}/lib/python3.13/site-packages/annotated_doc-0.0.5.dist-info/METADATA`, 'meta')
  put(root, `${runtimeRelative}/lib/python3.13/site-packages/typing_extensions-4.15.0.dist-info/METADATA`, 'meta')
  put(root, `${runtimeRelative}/lib/python3.13/site-packages/typing_extensions.py`, 'module')
  put(root, `${runtimeRelative}/lib/python3.13/site-packages/orgtree.pth`, MAC_PTH)
  return path.join(root, ...runtimeRelative.split('/'))
}

test('dist-info names use PEP 503 normalization', () => {
  assert.equal(normalizeDistName('annotated-doc'), 'annotated_doc')
  assert.equal(normalizeDistName('typing_extensions'), 'typing_extensions')
  assert.equal(normalizeDistName('Pillow'), 'pillow')
  assert.equal(normalizeDistName('foo.bar--baz'), 'foo_bar_baz')
})

test('a correct macOS provisioned layout passes and reports every dependency', () => {
  const root = fixtureRoot()
  try {
    const runtime = correctRuntimeMac(root)
    const result = assertRuntimeLayoutMac(runtime, { label: 'fixture runtime' })
    assert.deepEqual(Object.keys(result.distInfo).sort(),
      ['annotated-doc', 'fastapi', 'typing_extensions'])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('assertRuntimeLayoutMac refuses a tree with no bin/python3.13 interpreter, by name', () => {
  const root = fixtureRoot()
  try {
    const runtime = correctRuntimeMac(root)
    fs.rmSync(path.join(runtime, 'bin', 'python3.13'))
    assert.throws(() => assertRuntimeLayoutMac(runtime, { label: 'runtime' }), /bin\/python3\.13/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('assertRuntimeLayoutMac refuses a manifest dependency with no matching dist-info', () => {
  const root = fixtureRoot()
  try {
    const runtime = correctRuntimeMac(root)
    fs.rmSync(path.join(runtime, 'lib', 'python3.13', 'site-packages', 'fastapi-0.141.1.dist-info'), { recursive: true })
    assert.throws(() => assertRuntimeLayoutMac(runtime, { label: 'runtime' }),
      /missing fastapi-0\.141\.1\.dist-info/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("locateEngineRuntime's default marker is bin/python3.13 on darwin, python.exe elsewhere", () => {
  const root = fixtureRoot()
  try {
    const runtime = correctRuntimeMac(root)
    const found = locateEngineRuntime(root, process.platform === 'darwin' ? {} : { marker: 'bin/python3.13' })
    assert.equal(found, runtime)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a correct provisioned layout passes and reports every dependency', () => {
  const root = fixtureRoot()
  try {
    const runtime = correctRuntime(root)
    const result = assertRuntimeLayout(runtime, { label: 'fixture runtime' })
    assert.deepEqual(Object.keys(result.distInfo).sort(),
      ['annotated-doc', 'fastapi', 'typing_extensions'])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('the exact 2.1.4-RC4 mis-staging — site-packages beside Lib instead of inside it — is refused by name', () => {
  const root = fixtureRoot()
  try {
    const runtime = correctRuntime(root)
    // Reproduce the shipped payload: the same packages, one level up, and no
    // Lib at all. Both halves of that state must be refused independently.
    fs.cpSync(path.join(runtime, 'Lib', 'site-packages'), path.join(runtime, 'site-packages'), { recursive: true })
    assert.throws(() => assertRuntimeLayout(runtime, { label: 'runtime' }), /stray top-level site-packages/)
    fs.rmSync(path.join(runtime, 'Lib'), { recursive: true, force: true })
    assert.throws(() => assertRuntimeLayout(runtime, { label: 'runtime' }), /stray top-level site-packages/)
    fs.rmSync(path.join(runtime, 'site-packages'), { recursive: true, force: true })
    assert.throws(() => assertRuntimeLayout(runtime, { label: 'runtime' }), /Lib[\\/]site-packages/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a gutted site-packages cannot pass on the strength of loose interpreter files', () => {
  const root = fixtureRoot()
  try {
    const runtime = correctRuntime(root)
    fs.rmSync(path.join(runtime, 'Lib', 'site-packages', 'fastapi-0.141.1.dist-info'), { recursive: true })
    assert.throws(() => assertRuntimeLayout(runtime, { label: 'runtime' }),
      /missing fastapi-0\.141\.1\.dist-info/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('the exact 2.1.6-beta.0 ._pth — no ../mailhub entry, so the hub child cannot import itself — is refused by name', () => {
  const root = fixtureRoot()
  try {
    const runtime = correctRuntime(root)
    // The literal ._pth 2.1.6-beta.0 shipped: everything else correct, only
    // the mail hub entry missing. The installed hub failed at startup with
    // ModuleNotFoundError: No module named 'mailhub'.
    put(root, 'engine/runtime/python313._pth', 'python313.zip\r\n.\r\nLib/site-packages\r\n../backend\r\n../../\r\nimport site\r\n')
    assert.throws(() => assertRuntimeLayout(runtime, { label: 'runtime' }), /does not name \.\.\/mailhub/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a ._pth that stops naming Lib/site-packages is a contract change, not a pass', () => {
  const root = fixtureRoot()
  try {
    const runtime = correctRuntime(root)
    put(root, 'engine/runtime/python313._pth', 'python313.zip\r\n.\r\nimport site\r\n')
    assert.throws(() => assertRuntimeLayout(runtime, { label: 'runtime' }), /_pth no longer names/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('the runtime tree digest is deterministic, ignores __pycache__, and sees every byte', () => {
  const left = fixtureRoot()
  const right = fixtureRoot()
  try {
    const leftRuntime = correctRuntime(left)
    const rightRuntime = correctRuntime(right)
    put(left, 'engine/runtime/Lib/site-packages/__pycache__/x.pyc', 'cache')
    const a = runtimeTreeDigest(leftRuntime)
    const b = runtimeTreeDigest(rightRuntime)
    assert.deepEqual(a, b, 'identical trees (modulo __pycache__) must digest identically')
    put(right, 'engine/runtime/Lib/site-packages/fastapi/__init__.py', 'fastapi CHANGED')
    const c = runtimeTreeDigest(rightRuntime)
    assert.equal(a.files, c.files)
    assert.notEqual(a.sha256, c.sha256, 'a one-byte change anywhere must change the digest')
  } finally {
    fs.rmSync(left, { recursive: true, force: true })
    fs.rmSync(right, { recursive: true, force: true })
  }
})

test('runtime staging copies exactly, validates both ends, and never overwrites', () => {
  const source = fixtureRoot()
  const destination = fixtureRoot()
  try {
    const sourceRuntime = correctRuntime(source)
    put(source, 'engine/runtime/Lib/site-packages/__pycache__/x.pyc', 'cache')
    fs.mkdirSync(path.join(destination, 'engine'), { recursive: true })
    const staged = stageRuntime({ from: source, root: destination })
    assert.equal(staged.destination, path.join(destination, 'engine', 'runtime'))
    const sourceDigest = runtimeTreeDigest(sourceRuntime)
    assert.equal(staged.sha256, sourceDigest.sha256)
    assert.equal(staged.files, sourceDigest.files)
    assert.equal(fs.existsSync(path.join(staged.destination, 'Lib', 'site-packages', '__pycache__')), false,
      'packaging excludes __pycache__, so staging must too')
    // Staging refuses to overwrite what a build may already depend on.
    assert.throws(() => stageRuntime({ from: source, root: destination }), /never overwrites/)
  } finally {
    fs.rmSync(source, { recursive: true, force: true })
    fs.rmSync(destination, { recursive: true, force: true })
  }
})

test('runtime staging refuses a source with the RC4 layout instead of propagating it', () => {
  const source = fixtureRoot()
  const destination = fixtureRoot()
  try {
    const runtime = correctRuntime(source)
    fs.cpSync(path.join(runtime, 'Lib', 'site-packages'), path.join(runtime, 'site-packages'), { recursive: true })
    fs.rmSync(path.join(runtime, 'Lib'), { recursive: true })
    fs.mkdirSync(path.join(destination, 'engine'), { recursive: true })
    assert.throws(() => stageRuntime({ from: source, root: destination }), /stray top-level site-packages/)
    assert.equal(fs.existsSync(path.join(destination, 'engine', 'runtime')), false, 'nothing may be staged from a refused source')
  } finally {
    fs.rmSync(source, { recursive: true, force: true })
    fs.rmSync(destination, { recursive: true, force: true })
  }
})

test('the embedded interpreter imports the representative backend dependencies from inside the runtime', (t) => {
  // REAL probe, real python.exe, no ambient rescue: neutral cwd, scrubbed
  // PYTHON* environment. Runs wherever a provisioned runtime exists — which
  // includes every release build worktree, where the release-verification
  // source gate executes this file.
  // Located by walking UPWARD, not joined onto this checkout. engine/runtime is
  // gitignored, so a linked worktree has none of its own and this probe used to
  // skip for every agent working under the worktree rule — the one environment
  // where it would have caught something.
  const runtime = locateEngineRuntime(repoRoot)
  if (!runtime) {
    t.skip('no provisioned engine/runtime in this checkout or above it; the release worktree runs this for real')
    return
  }
  ;(process.platform === 'darwin' ? assertRuntimeLayoutMac : assertRuntimeLayout)(runtime, { label: 'provisioned runtime' })
  const report = assertRuntimeImports(runtime)
  assert.equal(report.ok, true)
  for (const name of REPRESENTATIVE_RUNTIME_IMPORTS) {
    assert.equal(report.modules[name].inside, true, `${name} resolved outside the runtime: ${report.modules[name].file}`)
  }
})

test('the import probe fails closed when a dependency resolves outside the runtime tree', () => {
  // Drive assertRuntimeImports through its injected spawn so the refusal
  // logic itself is covered even where no real runtime exists.
  const root = fixtureRoot()
  try {
    const runtime = correctRuntime(root)
    put(root, 'engine/runtime/bin/python3.13', 'exe-bytes') // darwin's assertRuntimeImports probes this path
    const outside = {
      python: '3.13.15', executable: path.join(runtime, 'python.exe'),
      modules: { fastapi: { file: 'C:/Python313/Lib/site-packages/fastapi/__init__.py', inside: false } },
      ok: false,
    }
    assert.throws(() => assertRuntimeImports(runtime, {
      spawnSyncImpl: () => ({ status: 3, stdout: JSON.stringify(outside), stderr: '' }),
    }), /import probe failed/)
    const good = {
      python: '3.13.15', executable: path.join(runtime, 'python.exe'),
      modules: { fastapi: { file: path.join(runtime, 'Lib', 'site-packages', 'fastapi', '__init__.py'), inside: true } },
      ok: true,
    }
    const report = assertRuntimeImports(runtime, {
      spawnSyncImpl: () => ({ status: 0, stdout: JSON.stringify(good), stderr: '' }),
    })
    assert.equal(report.ok, true)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
