import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  CANONICAL_ASSET_NAMES,
  PACKAGED_ENGINE_ENTRIES,
  PACKAGED_ENGINE_FILES,
  PACKAGED_HASH_FILES,
  assertBuildProvenance,
  assertCleanReleaseTree,
  assertLockfileVersion,
  assertNotesFile,
  assertNoPublicRelease,
  assertNoTagCollision,
  assertReleaseVerification,
  assertVersionMatchesPackage,
  deriveEngineHashes,
  derivePackagedHashes,
  hashFile,
  installerAssetName,
  installerSourceName,
  packagedEngineDigest,
  packagedEngineRecord,
  parseLatestYml,
  parseReleaseArgs,
  publishRelease,
  produceWindowsRelease,
  releasePlan,
  resolveNpmInvocation,
  serializeJson,
  sha256Bytes,
  sha512Bytes,
  stageCanonicalAssets,
  validReleaseVersion,
  validateLatestYml,
  verifyPublicRelease,
  verifyInstallerPayloadEngine,
  verifyPackagedEngine,
} from '../tools/release-windows.mjs'
import { POSTGRES_PIN, POSTGRES_REQUIRED, POSTGRES_SCHEMA } from '../tools/postgres-layout.mjs'

function fixtureRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-release-fixture-'))
}

function removeFixture(root) {
  fs.rmSync(root, { recursive: true, force: true })
}

function put(root, relative, bytes) {
  const file = path.join(root, ...relative.split('/'))
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, bytes)
  return file
}

function responseJson(value, status = 200) {
  return { status, ok: status >= 200 && status < 300, json: async () => value }
}

/** A v2 PostgreSQL payload (manifest + postgresql/**) under `engine`.
 *  Returns a `save` that rewrites the manifest after `files` is edited. */
function postgresFixture(engine) {
  const files = {}
  for (const name of POSTGRES_REQUIRED) {
    const data = Buffer.from(name)
    put(engine, name, data)
    files[name] = { bytes: data.length, sha256: sha256Bytes(data) }
  }
  const manifest = { schema: POSTGRES_SCHEMA, archive: POSTGRES_PIN, files }
  const save = () => put(engine, 'postgres-runtime-manifest.json', JSON.stringify(manifest))
  save()
  return { manifest, save }
}

/** The engine build outputs at their source locations, as cargo leaves them,
 *  plus the provisioned PostgreSQL payload. */
function engineSourceFixture(root) {
  const postgres = postgresFixture(path.join(root, 'engine'))
  for (const [packaged, source] of Object.entries(PACKAGED_ENGINE_FILES)) {
    if (packaged !== source) put(root, source, Buffer.from(`built:${packaged}`))
  }
  return postgres
}

/** Copy the build outputs where package.json build.extraResources puts them. */
function packageEngine(root, resources) {
  for (const [packaged, source] of Object.entries(PACKAGED_ENGINE_FILES)) {
    put(resources, packaged, fs.readFileSync(path.join(root, ...source.split('/'))))
  }
  fs.cpSync(path.join(root, 'engine', 'postgresql'), path.join(resources, 'engine', 'postgresql'), { recursive: true })
}

/** spawnSync stand-in: answers `orgtree-engine.exe --version` and records it. */
function versionProbe(output, calls = []) {
  return (exe, args) => {
    assert.equal(path.basename(exe), 'orgtree-engine.exe')
    assert.deepEqual(args, ['--version'])
    calls.push(exe)
    return { status: 0, stdout: `${output}\r\n`, stderr: '' }
  }
}

test('package.json ships exactly the engine files release verification checks, and no Python', () => {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'))
  const resources = pkg.build.extraResources
  const engineEntry = resources.find(entry => entry.from === 'engine' && entry.to === 'engine')
  assert.deepEqual(engineEntry.filter, ['postgresql/**/*', 'postgres-runtime-manifest.json'])
  for (const [packaged, source] of Object.entries(PACKAGED_ENGINE_FILES)) {
    if (packaged === source) continue
    assert.ok(resources.some(entry => entry.from === source && entry.to === packaged), `${source} -> ${packaged} is packaged`)
  }
  const engineTargets = resources.filter(entry => String(entry.to).startsWith('engine'))
  assert.deepEqual(engineTargets.map(entry => entry.to).sort(),
    ['engine', ...Object.keys(PACKAGED_ENGINE_FILES).filter(file => file !== 'engine/postgres-runtime-manifest.json')].sort(),
    'nothing else is packaged under resources/engine')
  assert.equal(JSON.stringify(resources).match(/runtime\/|backend|\.py\b|pg-custodian|pg_migrations/g), null)
  assert.deepEqual(PACKAGED_ENGINE_ENTRIES.sort(), [
    'orgtree-credential-broker.exe', 'orgtree-engine.exe', 'orgtree-installer-relaunch.exe',
    'orgtree-mailhub.exe', 'postgres-runtime-manifest.json', 'postgresql'])
  assert.equal(pkg.scripts['postgres:provision'], 'node tools/provision-postgres.mjs')
  for (const name of Object.keys(pkg.scripts)) assert.doesNotMatch(pkg.scripts[name], /python|runtime:/i, name)
})

test('the packaged engine must be byte-identical to the build outputs, carry no Python, and report the release', t => {
  const root = fixtureRoot()
  t.after(() => removeFixture(root))
  engineSourceFixture(root)
  const resources = path.join(root, 'resources')
  packageEngine(root, resources)
  const calls = []
  const verify = (output = 'orgtree-engine 2.1.2') => verifyPackagedEngine({
    root, resources, version: '2.1.2', spawnSyncImpl: versionProbe(output, calls) })
  const result = verify()
  assert.equal(result.engineVersion, 'orgtree-engine 2.1.2')
  assert.deepEqual(result.digest, packagedEngineDigest(resources))
  assert.equal(result.digest.files, Object.keys(PACKAGED_ENGINE_FILES).length)
  assert.equal(result.postgresManifestSha256, hashFile(path.join(resources, 'engine', 'postgres-runtime-manifest.json')))
  assert.deepEqual(calls, [path.join(resources, 'engine', 'orgtree-engine.exe')])

  // A development build, or one from another version, is not this release.
  assert.throws(() => verify('orgtree-engine 2.1.2 (dev)'), /development build/)
  assert.throws(() => verify('orgtree-engine 2.1.1'), /reports "orgtree-engine 2\.1\.1", expected "orgtree-engine 2\.1\.2"/)

  // A stale relaunch helper in the package is named, with both hashes.
  const relaunch = path.join(resources, 'engine', 'orgtree-installer-relaunch.exe')
  fs.writeFileSync(relaunch, 'stale helper')
  assert.throws(() => verify(), /Packaged engine\/orgtree-installer-relaunch\.exe differs from the built engine\/rs\/target\/release\/orgtree-installer-relaunch\.exe/)
  fs.copyFileSync(path.join(root, 'engine/rs/target/release/orgtree-installer-relaunch.exe'), relaunch)
  fs.rmSync(relaunch)
  assert.throws(() => verify(), /packaged resources\/engine orgtree-installer-relaunch\.exe/)
  fs.copyFileSync(path.join(root, 'engine/rs/target/release/orgtree-installer-relaunch.exe'), relaunch)
  assert.equal(verify().engineVersion, 'orgtree-engine 2.1.2')

  // The retired Python payload, in any of its old shapes, is refused by name.
  put(path.join(resources, 'engine', 'runtime'), 'Lib/site.py', 'old interpreter')
  assert.throws(() => verify(), /still carries runtime\/, the retired embedded Python runtime/)
  fs.rmSync(path.join(resources, 'engine', 'runtime'), { recursive: true })
  put(resources, 'engine/service_host.py', 'old host')
  assert.throws(() => verify(), /still carries Python engine source service_host\.py/)
  fs.rmSync(path.join(resources, 'engine', 'service_host.py'))
  put(resources, 'engine/pg-custodian.exe', 'old custodian')
  assert.throws(() => verify(), /unexpected entry pg-custodian\.exe/)
  fs.rmSync(path.join(resources, 'engine', 'pg-custodian.exe'))

  // The PostgreSQL manifest that shipped must be the source's.
  const packagedManifest = path.join(resources, 'engine', 'postgres-runtime-manifest.json')
  const manifest = JSON.parse(fs.readFileSync(packagedManifest, 'utf8'))
  fs.writeFileSync(packagedManifest, JSON.stringify(manifest, null, 1))
  assert.throws(() => verify(), /Packaged PostgreSQL differs from source/)
})

test('installer payload rejects a self-consistent stale PostgreSQL or engine', t => {
  const root = fixtureRoot()
  t.after(() => removeFixture(root))
  engineSourceFixture(root)
  const resources = path.join(root, 'resources')
  packageEngine(root, resources)
  const engine = path.join(resources, 'engine')
  const expectedPostgresManifestSha256 = hashFile(path.join(engine, 'postgres-runtime-manifest.json'))
  const expectedDigest = packagedEngineDigest(resources)
  const installer = put(root, 'fixture.exe', 'fixture-installer')
  put(root, `node_modules/electron-winstaller/vendor/7z-${process.arch === 'arm64' ? 'arm64' : 'x64'}.exe`, 'fixture-7z')
  let extractions = 0, probes = 0
  let reported = 'orgtree-engine 2.1.2'
  const spawnSyncImpl = (exe, args) => {
    if (args[0] === 'x') {
      extractions++
      const output = args.find(arg => arg.startsWith('-o')).slice(2)
      if (args.at(-1) === '$PLUGINSDIR/app-64.7z') put(output, '$PLUGINSDIR/app-64.7z', 'fixture-archive')
      else fs.cpSync(engine, path.join(output, 'resources', 'engine'), { recursive: true })
      return { status: 0, stdout: '', stderr: '' }
    }
    assert.equal(path.basename(exe), 'orgtree-engine.exe')
    assert.ok(exe.startsWith(path.join(root, 'extracted')), 'the probe runs the EXTRACTED payload engine')
    probes++
    return { status: 0, stdout: reported, stderr: '' }
  }
  const verify = (expected = expectedPostgresManifestSha256) => verifyInstallerPayloadEngine({
    root, installer, workDir: path.join(root, 'extracted'), expectedDigest,
    expectedPostgresManifestSha256: expected, version: '2.1.2', spawnSyncImpl,
  })
  const ok = verify()
  assert.equal(ok.postgresManifestSha256, expectedPostgresManifestSha256)
  assert.equal(ok.engineVersion, 'orgtree-engine 2.1.2')
  assert.deepEqual(ok.digest, expectedDigest)
  assert.deepEqual([extractions, probes], [2, 1])
  assert.equal(fs.existsSync(path.join(root, 'extracted')), false, 'the extraction is removed')

  // A stale payload PostgreSQL that is internally consistent, with an
  // identical engine, is still refused against the verified manifest.
  const postgres = JSON.parse(fs.readFileSync(path.join(engine, 'postgres-runtime-manifest.json'), 'utf8'))
  const stale = Buffer.from('stale-extension')
  put(engine, 'postgresql/lib/stale.dll', stale)
  postgres.files['postgresql/lib/stale.dll'] = { bytes: stale.length, sha256: sha256Bytes(stale) }
  put(engine, 'postgres-runtime-manifest.json', JSON.stringify(postgres))
  assert.deepEqual(packagedEngineDigest(resources).hashes['engine/orgtree-engine.exe'], expectedDigest.hashes['engine/orgtree-engine.exe'])
  assert.throws(() => verify(), /Installer payload PostgreSQL differs/)
  assert.throws(() => verify(null), /Installer payload PostgreSQL differs/)
  assert.equal(probes, 1, 'nothing is run from a refused payload')
  fs.rmSync(path.join(engine, 'postgresql/lib/stale.dll'))
  delete postgres.files['postgresql/lib/stale.dll']
  fs.copyFileSync(path.join(root, 'engine', 'postgres-runtime-manifest.json'), path.join(engine, 'postgres-runtime-manifest.json'))

  // A payload engine file that differs from the verified win-unpacked one.
  put(engine, 'orgtree-credential-broker.exe', 'other broker')
  assert.throws(() => verify(), /Installer payload engine differs from the verified packaged engine \(engine\/orgtree-credential-broker\.exe\)/)
  fs.copyFileSync(path.join(root, 'engine/rs/target/release/orgtree-credential-broker.exe'), path.join(engine, 'orgtree-credential-broker.exe'))

  // The retired Python runtime in the payload.
  put(path.join(engine, 'runtime'), 'Lib/site.py', 'old interpreter')
  assert.throws(() => verify(), /installer payload resources\/engine still carries runtime\//)
  fs.rmSync(path.join(engine, 'runtime'), { recursive: true })

  reported = 'orgtree-engine 2.1.2 (dev)'
  assert.throws(() => verify(), /installer payload orgtree-engine\.exe is a development build/)
  reported = 'orgtree-engine 2.1.2'
  assert.equal(verify().engineVersion, 'orgtree-engine 2.1.2')
})

function responseBytes(bytes, status = 200) {
  const buffer = Buffer.from(bytes)
  return {
    status,
    ok: status >= 200 && status < 300,
    arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
  }
}

test('manifest JSON serialization is deterministic CRLF with a final newline', () => {
  const output = serializeJson({ z: 1, a: { z: 2, a: 3 } }, { sortKeys: true })
  assert.equal(output, '{\r\n  "a": {\r\n    "a": 3,\r\n    "z": 2\r\n  },\r\n  "z": 1\r\n}\r\n')
  assert.equal(output.includes('\n'), true)
  assert.equal(output.replaceAll('\r\n', '').includes('\n'), false)
})

test('engine-hashes records every packaged engine file from its build output', () => {
  const root = fixtureRoot()
  try {
    engineSourceFixture(root)
    const hashes = deriveEngineHashes({ root })
    assert.deepEqual(Object.keys(hashes), Object.keys(PACKAGED_ENGINE_FILES).sort())
    for (const [packaged, source] of Object.entries(PACKAGED_ENGINE_FILES)) {
      assert.equal(hashes[packaged], hashFile(path.join(root, ...source.split('/'))), packaged)
    }
    assert.equal(hashes['engine/orgtree-installer-relaunch.exe'], sha256Bytes(Buffer.from('built:engine/orgtree-installer-relaunch.exe')))
    fs.rmSync(path.join(root, 'engine/rs/target/release/orgtree-installer-relaunch.exe'))
    assert.throws(() => deriveEngineHashes({ root }), /engine build output engine\/rs\/target\/release\/orgtree-installer-relaunch\.exe/)
  } finally {
    removeFixture(root)
  }
})

test('unchanged engine build outputs produce byte-identical manifests', () => {
  const previous = fixtureRoot()
  const current = fixtureRoot()
  try {
    for (const root of [previous, current]) engineSourceFixture(root)
    const previousText = serializeJson(deriveEngineHashes({ root: previous }), { sortKeys: true })
    const currentText = serializeJson(deriveEngineHashes({ root: current }), { sortKeys: true })
    assert.equal(currentText, previousText)
  } finally {
    removeFixture(previous)
    removeFixture(current)
  }
})

test('packaged-hashes preserves the proven schema and insertion order', () => {
  const root = fixtureRoot()
  try {
    const resources = path.join(root, 'resources')
    for (const relative of PACKAGED_HASH_FILES) put(resources, relative, Buffer.from(relative))
    const installer = put(root, 'Orgtree Setup 2.1.2.exe', Buffer.from('installer'))
    const digest = packagedEngineDigest(resources)
    const engine = packagedEngineRecord(
      { digest, engineVersion: 'orgtree-engine 2.1.2', postgresManifestSha256: 'e'.repeat(64) },
      { digest, engineVersion: 'orgtree-engine 2.1.2' })
    const result = derivePackagedHashes({ resources, installer, commit: 'a'.repeat(40), version: '2.1.2', engine })
    // The engine section sits between the resource hash map and the
    // installer hash, where the 2.1.4-RC4 complete-runtime record used to be.
    assert.deepEqual(Object.keys(result), ['commit', 'version', 'files', 'engine', 'installerSha256'])
    assert.deepEqual(PACKAGED_HASH_FILES, ['app.asar', 'build-info.json', ...Object.keys(PACKAGED_ENGINE_FILES)])
    assert.deepEqual(Object.keys(result.files), PACKAGED_HASH_FILES)
    assert.deepEqual(result.engine, {
      files: digest.files, sha256: digest.sha256, version: 'orgtree-engine 2.1.2', postgresManifestSha256: 'e'.repeat(64),
      payload: { files: digest.files, sha256: digest.sha256, version: 'orgtree-engine 2.1.2' },
    })
    assert.equal(result.files['app.asar'], sha256Bytes(Buffer.from('app.asar')))
    assert.equal(result.files['engine/orgtree-installer-relaunch.exe'], sha256Bytes(Buffer.from('engine/orgtree-installer-relaunch.exe')))
    assert.equal(result.installerSha256, sha256Bytes(Buffer.from('installer')))
    const encoded = serializeJson(result)
    assert.equal(encoded.startsWith('{\r\n  "commit"'), true)
    assert.equal(encoded.endsWith('\r\n'), true)
  } finally {
    removeFixture(root)
  }
})

test('staging renames updater assets by copying and validates latest.yml', () => {
  const root = fixtureRoot()
  try {
    const releaseDir = path.join(root, 'release')
    const resources = path.join(releaseDir, 'win-unpacked', 'resources')
    const installerBytes = Buffer.from('installer fixture bytes')
    const installer = put(releaseDir, installerSourceName('2.1.2'), installerBytes)
    put(releaseDir, `${installerSourceName('2.1.2')}.blockmap`, Buffer.from('blockmap'))
    const latest = [
      'version: 2.1.2',
      'files:',
      `  - url: ${installerAssetName('2.1.2')}`,
      `    sha512: ${sha512Bytes(installerBytes)}`,
      `    size: ${installerBytes.length}`,
      `path: ${installerAssetName('2.1.2')}`,
      `sha512: ${sha512Bytes(installerBytes)}`,
      "releaseDate: '2026-09-13T00:00:00.000Z'",
      '',
    ].join('\r\n')
    put(releaseDir, 'latest.yml', Buffer.from(latest))
    put(resources, 'build-info.json', Buffer.from('{"version":"2.1.2"}\r\n'))
    const engineHashes = { 'engine/orgtree-engine.exe': sha256Bytes(Buffer.from('a')) }
    const packagedHashes = { commit: 'b'.repeat(40), version: '2.1.2', files: {}, installerSha256: sha256Bytes(installerBytes) }
    const staged = stageCanonicalAssets({ root, releaseDir, version: '2.1.2', engineHashes, packagedHashes })
    assert.equal(fs.existsSync(installer), true, 'the spaced source installer remains')
    assert.equal(fs.existsSync(path.join(staged.uploadDir, installerAssetName('2.1.2'))), true)
    assert.equal(fs.existsSync(path.join(staged.uploadDir, `${installerAssetName('2.1.2')}.blockmap`)), true)
    assert.deepEqual(fs.readFileSync(path.join(staged.uploadDir, installerAssetName('2.1.2'))), installerBytes)
    assert.deepEqual(parseLatestYml(latest).files[0], {
      url: installerAssetName('2.1.2'), sha512: sha512Bytes(installerBytes), size: installerBytes.length,
    })
  } finally {
    removeFixture(root)
  }
})

test('latest.yml refuses a size, path, or SHA mismatch', () => {
  const bytes = Buffer.from('installer')
  const text = [
    'version: 2.1.2',
    'files:',
    `  - url: ${installerAssetName('2.1.2')}`,
    `    sha512: ${sha512Bytes(bytes)}`,
    `    size: ${bytes.length + 1}`,
    `path: ${installerAssetName('2.1.2')}`,
    `sha512: ${sha512Bytes(bytes)}`,
  ].join('\n')
  assert.throws(() => validateLatestYml(text, {
    version: '2.1.2', installerName: installerAssetName('2.1.2'), installerBytes: bytes,
  }), /size/)
})

test('release preconditions refuse dirty trees, version drift, and collisions', () => {
  assert.doesNotThrow(() => assertCleanReleaseTree(''))
  assert.throws(() => assertCleanReleaseTree(' M package.json\n'), /clean tracked checkout/)
  assert.doesNotThrow(() => assertVersionMatchesPackage('2.1.2', '2.1.2'))
  assert.throws(() => assertVersionMatchesPackage('2.1.2', '2.1.1'), /does not match/)
  assert.doesNotThrow(() => assertLockfileVersion('2.1.2', { version: '2.1.2', packages: { '': { version: '2.1.2' } } }))
  assert.throws(() => assertLockfileVersion('2.1.2', { version: '2.1.2', packages: { '': { version: '2.1.1' } } }), /package-lock/)
  assert.throws(() => assertNoTagCollision({ tag: 'v2.1.2', local: true }), /local tag/)
  assert.throws(() => assertNoTagCollision({ tag: 'v2.1.2', remote: true }), /remote tag/)
})

test('release notes must be present, non-empty, and tracked', () => {
  const root = fixtureRoot()
  try {
    assert.throws(() => assertNotesFile(root, '2.1.2'), /release notes/)
    const relative = 'docs/release-notes-2.1.2.md'
    put(root, relative, Buffer.from(''))
    assert.throws(() => assertNotesFile(root, '2.1.2'), /empty/)
    put(root, relative, Buffer.from('# Release\n'))
    assert.doesNotThrow(() => assertNotesFile(root, '2.1.2', () => relative + '\n'))
    assert.throws(() => assertNotesFile(root, '2.1.2', () => { throw new Error('not tracked') }), /checked in/)
  } finally {
    removeFixture(root)
  }
})

async function orchestrateCandidate(root, { afterPackage = () => {} } = {}) {
  const version = '2.1.2'
  const commit = 'f'.repeat(40)
  const packageJson = {
    version,
    build: {
      directories: { output: 'release' },
      publish: [{ provider: 'github', owner: 'Maurdekye', repo: 'orgtree', releaseType: 'release' }],
    },
  }
  put(root, 'package.json', Buffer.from(JSON.stringify(packageJson)))
  put(root, 'package-lock.json', Buffer.from(JSON.stringify({ version, packages: { '': { version } } })))
  put(root, 'docs/release-notes-2.1.2.md', Buffer.from('# Release\n'))
  // The prerequisites are the engine build outputs and a PostgreSQL payload
  // that matches its v2 manifest byte for byte, so the fixture carries real
  // ones rather than placeholder bytes. There is no Python runtime.
  engineSourceFixture(root)
  for (const relative of [
    'dist/renderer/index.html',
    'node_modules/electron/package.json',
    'node_modules/electron-builder/package.json',
  ]) put(root, relative, Buffer.from(relative))

  const gitExec = (command, args) => {
    assert.equal(command, 'git')
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return root + '\n'
    if (args[0] === 'rev-parse') return commit + '\n'
    if (args[0] === 'status') return ''
    if (args[0] === 'ls-files' && args[1] === '--error-unmatch') return args.at(-1) + '\n'
    throw new Error(`unexpected git fixture call: ${args.join(' ')}`)
  }
  const gitProbe = (_command, args) => ({ status: args[0] === 'show-ref' ? 1 : 2 })
  const externalCalls = []
  const runExternal = (command, args) => {
    externalCalls.push([command, args])
    const resources = path.join(root, 'release', 'win-unpacked', 'resources')
    const inputHashes = {}
    for (const relative of [
      ...Object.values(PACKAGED_ENGINE_FILES),
      'dist/renderer/index.html',
    ]) inputHashes[relative] = hashFile(path.join(root, ...relative.split('/')))
    put(root, 'dist/build-info.json', Buffer.from(JSON.stringify({
      version, channel: 'release', commit, dirty: false, sha256: inputHashes,
    }) + '\n'))
    put(root, 'release/win-unpacked/resources/build-info.json', fs.readFileSync(path.join(root, 'dist/build-info.json')))
    put(root, 'release/win-unpacked/resources/app.asar', Buffer.from('resource:app.asar'))
    packageEngine(root, resources)
    afterPackage(resources)
    const installerBytes = Buffer.from('fixture installer')
    put(root, 'release/Orgtree Setup 2.1.2.exe', installerBytes)
    put(root, 'release/Orgtree Setup 2.1.2.exe.blockmap', Buffer.from('fixture blockmap'))
    put(root, 'release/latest.yml', Buffer.from([
      `version: ${version}`,
      'files:',
      `  - url: ${installerAssetName(version)}`,
      `    sha512: ${sha512Bytes(installerBytes)}`,
      `    size: ${installerBytes.length}`,
      `path: ${installerAssetName(version)}`,
      `sha512: ${sha512Bytes(installerBytes)}`,
      '',
    ].join('\r\n')))
  }

  const engineChecks = []
  const result = await produceWindowsRelease({ version, publish: false }, {
    root,
    execFileSync: gitExec,
    spawnSync: gitProbe,
    runExternal,
    fetch: async () => responseJson({}, 404),
    // The real packaged/payload engine verifiers run orgtree-engine.exe and
    // 7-Zip; the orchestration fixture proves they are INVOKED with the real
    // build outputs and that their digest flows into the manifest. Their own
    // behavior is covered by the verifyPackagedEngine and
    // verifyInstallerPayloadEngine tests above.
    verifyPackagedEngine: ({ root: checkedRoot, resources, version: checkedVersion }) => {
      engineChecks.push(['packaged', checkedRoot, resources, checkedVersion])
      return { digest: packagedEngineDigest(resources), postgresManifestSha256: 'a'.repeat(64), engineVersion: `orgtree-engine ${checkedVersion}` }
    },
    verifyInstallerPayloadEngine: ({ installer, expectedDigest, expectedPostgresManifestSha256, version: checkedVersion }) => {
      assert.equal(expectedPostgresManifestSha256, 'a'.repeat(64))
      engineChecks.push(['payload', installer, checkedVersion])
      return { digest: expectedDigest, postgresManifestSha256: expectedPostgresManifestSha256, engineVersion: `orgtree-engine ${checkedVersion}` }
    },
    runVerification: async () => ({
      schema: 'orgtree.windows-release-verification/v1', profile: 'focused-release-v1',
      candidate: commit, sourceFingerprint: 'sha256:fixture', sourceFiles: ['tools/release-windows.mjs'],
      commands: [{ gate: 'source', command: ['node', '--test', 'tests/release-windows.test.mjs'] }],
      results: [{ gate: 'source', status: 0, durationMs: 1 }], durationMs: 1, green: true,
      fingerprint: 'sha256:fixture-receipt',
    }),
  })
  return { result, version, commit, externalCalls, engineChecks }
}

test('candidate orchestration builds, stages, verifies, and writes the handoff without mutation', async () => {
  const root = fixtureRoot()
  try {
    const { result, version, commit, externalCalls, engineChecks } = await orchestrateCandidate(root)
    const manifest = JSON.parse(fs.readFileSync(result.manifestPath, 'utf8'))
    const handoff = JSON.parse(fs.readFileSync(result.handoffPath, 'utf8'))
    assert.deepEqual(manifest.artifacts.map(record => record.name), CANONICAL_ASSET_NAMES(version))
    assert.equal(manifest.publication.state, 'candidate-only')
    assert.equal(handoff.commit, commit)
    assert.equal(manifest.verification.candidate, commit)
    assert.equal(manifest.verification.profile, 'focused-release-v1')
    assert.equal(externalCalls.length, 1)
    const npm = resolveNpmInvocation()
    assert.deepEqual(externalCalls[0][1], [...npm.args, 'run', 'package:win', '--', '--publish', 'never'])
    // Both installed-shaped payload checks ran, against the build outputs and
    // for this version, and the engine record reached the staged manifest.
    assert.deepEqual(engineChecks.map(check => check[0]), ['packaged', 'payload'])
    assert.equal(engineChecks[0][2], path.join(root, 'release', 'win-unpacked', 'resources'))
    assert.equal(engineChecks[0][3], version)
    assert.match(engineChecks[1][1], /Orgtree Setup 2\.1\.2\.exe$/)
    const resources = path.join(root, 'release', 'win-unpacked', 'resources')
    const stagedPackaged = JSON.parse(fs.readFileSync(path.join(result.uploadDir, 'packaged-hashes.json'), 'utf8'))
    const digest = packagedEngineDigest(resources)
    assert.equal(stagedPackaged.runtime, undefined, 'no Python runtime record')
    assert.deepEqual(stagedPackaged.engine, {
      files: digest.files, sha256: digest.sha256, version: 'orgtree-engine 2.1.2', postgresManifestSha256: 'a'.repeat(64),
      payload: { files: digest.files, sha256: digest.sha256, version: 'orgtree-engine 2.1.2' },
    })
    const stagedEngine = JSON.parse(fs.readFileSync(path.join(result.uploadDir, 'engine-hashes.json'), 'utf8'))
    assert.deepEqual(stagedEngine, deriveEngineHashes({ root }))
    for (const relative of Object.keys(PACKAGED_ENGINE_FILES)) assert.equal(stagedPackaged.files[relative], stagedEngine[relative], relative)
    // The handoff's installed check is the engine and relaunch helper, read only.
    assert.equal(handoff.runtimeVerification, undefined)
    assert.equal(handoff.engineVerification.readOnly, true)
    assert.equal(handoff.engineVerification.expected.engineVersion, 'orgtree-engine 2.1.2')
    assert.equal(handoff.engineVerification.expected.relaunchHelperSha256, stagedEngine['engine/orgtree-installer-relaunch.exe'])
    assert.equal(handoff.engineVerification.expected.engineSha256, stagedEngine['engine/orgtree-engine.exe'])
    assert.match(handoff.engineVerification.commands[0], /orgtree-engine\.exe" --version$/)
    assert.doesNotMatch(JSON.stringify(handoff), /python|verify-installed-runtime/i)
  } finally {
    removeFixture(root)
  }
})

test('candidate verification refuses a packaged engine file that is not the build output', async () => {
  for (const file of ['engine/orgtree-installer-relaunch.exe', 'engine/orgtree-engine.exe']) {
    const root = fixtureRoot()
    try {
      // The verifiers are stubbed to agree with whatever was packaged, so
      // this is the candidate check's own built = shipped comparison.
      await assert.rejects(orchestrateCandidate(root, {
        afterPackage: resources => put(resources, file, Buffer.from('stale from an earlier build')),
      }), new RegExp(`Packaged ${file.replaceAll('.', '\\.')} differs from the build output`))
    } finally {
      removeFixture(root)
    }
  }
})

test('safe candidate plan never includes tag, push, or GitHub publication', () => {
  const plan = releasePlan('2.1.2')
  assert.equal(plan.mode, 'candidate')
  assert.deepEqual(plan.build, ['npm', 'run', 'package:win', '--', '--publish', 'never'])
  assert.equal(plan.publication, null)
  const publishPlan = releasePlan('2.1.2', { publish: true })
  assert.equal(publishPlan.mode, 'publish')
  assert.deepEqual(publishPlan.publication.tag, ['git', 'tag', 'v2.1.2'])
})

test('prereleases use the exact beta.N convention in arguments and asset names', () => {
  // ⚠ THIS USED TO ASSERT THE RCn CONVENTION, and the convention changed for a
  // measured reason rather than a stylistic one: the updater reads a
  // prerelease label as a CHANNEL NAME, so a build labelled RC1 sits on a
  // channel whose only member is itself and can never move onto a newer
  // release. tests/update-channel.test.mjs drives the real updater through
  // both outcomes. An RC label is now refused outright so the stranding cannot
  // be re-published.
  const version = '2.1.3-beta.1'
  assert.equal(validReleaseVersion(version), true)
  assert.equal(validReleaseVersion('2.1.3-beta.2'), true)
  assert.equal(validReleaseVersion('2.1.3-alpha.1'), true)
  assert.equal(validReleaseVersion('2.1.3'), true)
  assert.equal(validReleaseVersion('2.1.3-RC1'), false, 'the label that stranded 2.1.5-RC3')
  assert.equal(validReleaseVersion('2.1.3-beta'), false, 'beta.N, not a bare label')
  assert.equal(validReleaseVersion('2.1.3-beta.01'), false)
  assert.equal(validReleaseVersion('2.1.3-BETA.1'), false)
  assert.deepEqual(parseReleaseArgs([version]), { version, publish: false, help: false })
  assert.throws(() => parseReleaseArgs(['2.1.3-RC1']), /only alpha\.N and beta\.N/)
  assert.equal(installerSourceName(version), 'Orgtree Setup 2.1.3-beta.1.exe')
  assert.equal(installerAssetName(version), 'Orgtree-Setup-2.1.3-beta.1.exe')
  assert.deepEqual(releasePlan(version, { publish: true }).publication.tag,
    ['git', 'tag', 'v2.1.3-beta.1'])
})

test('the version refusal never recommends a version it would refuse', () => {
  // ⚠ THE POINT IS THE ADVICE, NOT THE REFUSAL. Both call sites used to say
  // "a release candidate such as 2.1.3-RC1" — the one label this command
  // rejects, and rejects for the measured reason above. An operator who typed
  // -RCn was told to type -RCn. It survived a convention change because the
  // old test asserted only that SOMETHING was thrown, matching the stale
  // phrase `/release candidate/`, so it kept passing while the sentence it
  // pinned had become wrong.
  //
  // So this asserts the property rather than the wording: whatever the message
  // says, every version it offers as an example must actually be accepted.
  for (const broken of ['2.1.3-RC1', '2.1.3-rc.1', '2.1.3-beta', 'nonsense', '']) {
    let message = ''
    try { parseReleaseArgs([broken]) } catch (error) { message = String(error?.message ?? error) }
    assert.ok(message, `no refusal for ${broken || '<empty>'}`)
    const offered = message.match(/\d+\.\d+\.\d+(?:-[A-Za-z]+\.?\d*)?/g) ?? []
    const examples = offered.filter((candidate) => candidate !== broken)
    assert.ok(examples.length, `the refusal for ${broken || '<empty>'} offers no example`)
    for (const example of examples) {
      assert.equal(validReleaseVersion(example), true,
        `the refusal recommends ${example}, which it would itself refuse`)
    }
  }
  // …and the refused label is still named, so the operator learns WHY rather
  // than only that they were wrong. Without this the message could satisfy the
  // loop above by dropping every mention of RC and explaining nothing.
  let rcMessage = ''
  try { parseReleaseArgs(['2.1.3-RC1']) } catch (error) { rcMessage = String(error?.message ?? error) }
  assert.match(rcMessage, /-RCn/)
  assert.match(rcMessage, /channel/)
  // both refusal sites share one message, so they cannot drift apart again
  let planMessage = ''
  try { releasePlan('2.1.3-RC1') } catch (error) { planMessage = String(error?.message ?? error) }
  assert.equal(planMessage, rcMessage)
})

test('the release build invokes npm through a Windows-safe Node CLI boundary', () => {
  const npm = resolveNpmInvocation()
  const result = spawnSync(npm.command, [...npm.args, '--version'], {
    encoding: 'utf8',
    windowsHide: true,
  })
  assert.equal(result.error, undefined, result.error?.message)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+(?:[-+].*)?$/)
})

function publicationFixture() {
  const root = fixtureRoot()
  const version = '9.9.9'
  const commit = 'a'.repeat(40)
  const uploadDir = path.join(root, 'upload')
  fs.mkdirSync(uploadDir, { recursive: true })
  const notes = { file: put(root, 'docs/release-notes-9.9.9.md', Buffer.from('# Fixture\n')) }
  const manifest = {
    version,
    commit,
    tag: `v${version}`,
    artifacts: CANONICAL_ASSET_NAMES(version).map(name => ({ name })),
  }
  return { root, version, manifest, notes, repository: { owner: 'Maurdekye', repo: 'orgtree' }, uploadDir }
}

test('publication never deletes a pre-existing or ambiguous GitHub release', async () => {
  for (const failureText of ['already exists', 'network failure after upload']) {
    const fixture = publicationFixture()
    const externalCalls = []
    try {
      await assert.rejects(() => publishRelease({
        ...fixture,
        runGit: () => {},
        spawnSyncImpl: (_command, args) => ({ status: args[0] === 'show-ref' ? 1 : 2 }),
        fetchImpl: async () => responseJson({}, 404),
        runExternal: (_command, args) => {
          externalCalls.push(args)
          if (args[0] === 'release' && args[1] === 'create') throw new Error(failureText)
        },
      }), /no GitHub release was auto-deleted/)
      assert.equal(externalCalls.some(args => args[0] === 'release' && args[1] === 'delete'), false)
    } finally {
      removeFixture(fixture.root)
    }
  }
})

test('publication verification gives 404 propagation bounded backoff without republishing', async () => {
  for (const terminalStatus of [404, 403]) {
    const fixture = publicationFixture()
    let lookups = 0
    const waits = []
    const mutations = []
    try {
      await assert.rejects(() => publishRelease({
        ...fixture,
        runGit: args => mutations.push(args),
        runExternal: (_command, args) => mutations.push(args),
        spawnSyncImpl: (_command, args) => ({ status: args[0] === 'show-ref' ? 1 : 2 }),
        fetchImpl: async () => responseJson({}, lookups++ === 0 ? 404 : terminalStatus),
        verificationSleep: async ms => { waits.push(ms) },
      }), error => error.message.includes(`GitHub request failed (${terminalStatus})`))
      assert.equal(lookups, terminalStatus === 404 ? 10 : 2, 'one collision check plus bounded verification attempts')
      assert.deepEqual(waits, terminalStatus === 404 ? [3000, 6000, 9000, 12000, 15000, 18000, 21000, 24000] : [])
      assert.equal(waits.reduce((total, ms) => total + ms, 0), terminalStatus === 404 ? 108000 : 0)
      assert.equal(mutations.filter(args => args[0] === 'release' && args[1] === 'create').length, 1)
      assert.equal(mutations.filter(args => args[0] === 'release' && args[1] === 'edit').length, 1)
    } finally { removeFixture(fixture.root) }
  }
})

test('build provenance refuses a build stamped for a different HEAD', () => {
  const root = fixtureRoot()
  try {
    const input = put(root, 'dist/input.js', Buffer.from('input'))
    const head = 'c'.repeat(40)
    const base = { version: '2.1.2', channel: 'release', commit: head, dirty: false, sha256: { 'dist/input.js': hashFile(input) } }
    assert.doesNotThrow(() => assertBuildProvenance(base, { root, head, porcelain: '', version: '2.1.2' }))
    assert.throws(() => assertBuildProvenance({ ...base, commit: 'd'.repeat(40) }, { root, head, porcelain: '', version: '2.1.2' }), /provenance/)
  } finally {
    removeFixture(root)
  }
})

test('public release verification downloads every canonical asset and checks tag, Latest, and updater metadata', async () => {
  const version = '2.1.2'
  const commit = 'e'.repeat(40)
  const tag = `v${version}`
  const owner = 'Maurdekye'
  const repo = 'orgtree'
  const prefix = `https://github.com/${owner}/${repo}/releases/download/${tag}/`
  const installerBytes = Buffer.from('public installer')
  const latestText = [
    `version: ${version}`,
    'files:',
    `  - url: ${installerAssetName(version)}`,
    `    sha512: ${sha512Bytes(installerBytes)}`,
    `    size: ${installerBytes.length}`,
    `path: ${installerAssetName(version)}`,
    `sha512: ${sha512Bytes(installerBytes)}`,
  ].join('\n')
  const contents = new Map([
    ['build-info.json', Buffer.from(JSON.stringify({ version, channel: 'release', commit, dirty: false }) + '\n')],
    ['engine-hashes.json', Buffer.from('{"engine/orgtree-engine.exe":"hash"}\n')],
    ['latest.yml', Buffer.from(latestText)],
    [installerAssetName(version), installerBytes],
    [`${installerAssetName(version)}.blockmap`, Buffer.from('blockmap')],
    ['packaged-hashes.json', Buffer.from('{"commit":"' + commit + '"}\n')],
  ])
  const artifacts = [...contents].map(([name, bytes]) => ({
    name,
    size: bytes.length,
    sha256: sha256Bytes(bytes),
    sha512: sha512Bytes(bytes),
  }))
  const manifest = { version, commit, tag, artifacts }
  const release = {
    id: 123,
    tag_name: tag,
    name: `Orgtree ${version}`,
    target_commitish: 'main',
    draft: false,
    prerelease: false,
    html_url: `https://github.com/${owner}/${repo}/releases/tag/${tag}`,
    assets: [...contents].map(([name, bytes]) => ({ name, size: bytes.length, browser_download_url: prefix + name })),
  }
  const api = `https://api.github.com/repos/${owner}/${repo}`
  const calls = []
  let releaseLookups = 0
  const fetchImpl = async url => {
    calls.push(url)
    if (url === `${api}/releases/tags/${tag}` && releaseLookups++ === 0) return responseJson({ message: 'still propagating' }, 404)
    if (url === `${api}/releases/tags/${tag}` || url === `${api}/releases/latest`) return responseJson(release)
    if (url === `${api}/git/ref/tags/${tag}`) return responseJson({ object: { type: 'commit', sha: commit } })
    for (const [name, bytes] of contents) if (url === prefix + name) return responseBytes(bytes)
    return responseJson({ message: 'not found' }, 404)
  }
  const result = await verifyPublicRelease({ manifest, owner, repo, fetchImpl, retry: { retries: 2, delayMs: 0 } })
  assert.equal(result.tagTarget.sha, commit)
  assert.equal(result.latest.tag, tag)
  assert.deepEqual(Object.keys(result.assets).sort(), CANONICAL_ASSET_NAMES(version).sort())
  assert.equal(calls.filter(url => url.startsWith(prefix)).length, 6, 'each public asset is downloaded exactly once')
  assert.equal(releaseLookups, 2, 'post-publication verification retries a transient propagation 404')
})

test('canonical release verification refuses a receipt for another candidate', () => {
  const receipt = {
    schema: 'orgtree.windows-release-verification/v1', green: true,
    candidate: 'a'.repeat(40), profile: 'focused-release-v1', fingerprint: 'sha256:x',
    sourceFingerprint: 'sha256:y', commands: [['node', '--test']],
  }
  assert.doesNotThrow(() => assertReleaseVerification(receipt, { commit: 'a'.repeat(40) }))
  assert.throws(() => assertReleaseVerification(receipt, { commit: 'b'.repeat(40) }), /not candidate/)
})

test('public collision checks distinguish an absent release from an existing one', async () => {
  const missing = await assertNoPublicRelease({ owner: 'Maurdekye', repo: 'orgtree', tag: 'v9.9.9', fetchImpl: async () => responseJson({}, 404) })
  assert.deepEqual(missing, { exists: false, tag: 'v9.9.9' })
  await assert.rejects(() => assertNoPublicRelease({ owner: 'Maurdekye', repo: 'orgtree', tag: 'v2.1.1', fetchImpl: async () => responseJson({ tag_name: 'v2.1.1' }) }), /Public release collision/)
})
