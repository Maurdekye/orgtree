import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  CANONICAL_ASSET_NAMES,
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
} from '../tools/release-windows.mjs'
import { REPRESENTATIVE_RUNTIME_IMPORTS, runtimeTreeDigest } from '../tools/runtime-layout.mjs'

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

test('engine-hashes uses tracked on-disk Python bytes and excludes runtime', () => {
  const root = fixtureRoot()
  try {
    const first = put(root, 'engine/z.py', Buffer.from('z\r\n'))
    put(root, 'engine/a.py', Buffer.from('a\r\n'))
    put(root, 'engine/runtime/ignored.py', Buffer.from('runtime\r\n'))
    const hashes = deriveEngineHashes({
      root,
      gitFiles: 'engine/z.py\r\nengine/runtime/ignored.py\r\nengine/a.py\r\n',
    })
    assert.deepEqual(Object.keys(hashes), ['engine/a.py', 'engine/z.py'])
    assert.equal(hashes['engine/z.py'], hashFile(first))
    assert.equal(hashes['engine/a.py'], sha256Bytes(Buffer.from('a\r\n')))
  } finally {
    removeFixture(root)
  }
})

test('unchanged engine sources produce byte-identical manifests', () => {
  const previous = fixtureRoot()
  const current = fixtureRoot()
  try {
    for (const root of [previous, current]) {
      put(root, 'engine/a.py', Buffer.from('a\r\n'))
      put(root, 'engine/z.py', Buffer.from('z\r\n'))
    }
    const gitFiles = 'engine/z.py\r\nengine/a.py\r\n'
    const previousText = serializeJson(deriveEngineHashes({ root: previous, gitFiles }), { sortKeys: true })
    const currentText = serializeJson(deriveEngineHashes({ root: current, gitFiles }), { sortKeys: true })
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
    const runtime = {
      sitePackages: 'Lib/site-packages', files: 2, sha256: 'f'.repeat(64),
      imports: ['fastapi'], python: '3.13.15',
      payload: { files: 2, sha256: 'f'.repeat(64), imported: true },
    }
    const result = derivePackagedHashes({ resources, installer, commit: 'a'.repeat(40), version: '2.1.2', runtime })
    // The runtime section sits between the proven four-file map and the
    // installer hash: the complete-tree record added after 2.1.4-RC4 shipped
    // a manifest that vouched for a payload whose packages the interpreter
    // could not see.
    assert.deepEqual(Object.keys(result), ['commit', 'version', 'files', 'runtime', 'installerSha256'])
    assert.deepEqual(Object.keys(result.files), PACKAGED_HASH_FILES)
    assert.deepEqual(result.runtime, runtime)
    assert.equal(result.files['app.asar'], sha256Bytes(Buffer.from('app.asar')))
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
    const engineHashes = { 'engine/a.py': sha256Bytes(Buffer.from('a')) }
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

test('candidate orchestration builds, stages, verifies, and writes the handoff without mutation', async () => {
  const root = fixtureRoot()
  const version = '2.1.2'
  const commit = 'f'.repeat(40)
  const packageJson = {
    version,
    build: {
      directories: { output: 'release' },
      publish: [{ provider: 'github', owner: 'Maurdekye', repo: 'orgtree', releaseType: 'release' }],
    },
  }
  try {
    put(root, 'package.json', Buffer.from(JSON.stringify(packageJson)))
    put(root, 'package-lock.json', Buffer.from(JSON.stringify({ version, packages: { '': { version } } })))
    put(root, 'docs/release-notes-2.1.2.md', Buffer.from('# Release\n'))
    put(root, 'engine/a.py', Buffer.from('print("fixture")\r\n'))
    for (const relative of [
      'engine/launch.py',
      'engine/backend/orgtree/api.py',
      'engine/runtime/python.exe',
      'engine/runtime/python313.zip',
      'dist/renderer/index.html',
      'node_modules/electron/package.json',
      'node_modules/electron-builder/package.json',
    ]) put(root, relative, Buffer.from(relative))
    // The prerequisites now include the COMPLETE runtime layout, so the
    // fixture carries a real-shaped one rather than placeholder bytes.
    put(root, 'engine/runtime/python313._pth', Buffer.from('python313.zip\r\n.\r\nLib/site-packages\r\n../backend\r\n../mailhub\r\n../../\r\nimport site\r\n'))
    put(root, 'engine/runtime/runtime-manifest.json', Buffer.from(JSON.stringify({
      python: '3.13.15', dependencies: [{ name: 'fastapi', version: '0.141.1' }],
    })))
    put(root, 'engine/runtime/Lib/site-packages/fastapi-0.141.1.dist-info/METADATA', Buffer.from('meta'))

    const gitExec = (command, args) => {
      assert.equal(command, 'git')
      if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return root + '\n'
      if (args[0] === 'rev-parse') return commit + '\n'
      if (args[0] === 'status') return ''
      if (args[0] === 'ls-files' && args[1] === '--error-unmatch') return args.at(-1) + '\n'
      if (args[0] === 'ls-files' && args[1] === '--' && args[2] === 'engine') return 'engine/a.py\n'
      throw new Error(`unexpected git fixture call: ${args.join(' ')}`)
    }
    const gitProbe = (_command, args) => ({ status: args[0] === 'show-ref' ? 1 : 2 })
    const externalCalls = []
    const runExternal = (command, args) => {
      externalCalls.push([command, args])
      const releaseDir = path.join(root, 'release')
      const resources = path.join(releaseDir, 'win-unpacked', 'resources')
      const inputHashes = {}
      for (const relative of [
        'engine/launch.py',
        'engine/runtime/python.exe',
        'engine/runtime/python313._pth',
        'engine/runtime/runtime-manifest.json',
        'dist/renderer/index.html',
      ]) inputHashes[relative] = hashFile(path.join(root, ...relative.split('/')))
      put(root, 'dist/build-info.json', Buffer.from(JSON.stringify({
        version, channel: 'release', commit, dirty: false, sha256: inputHashes,
      }) + '\n'))
      put(root, 'release/win-unpacked/resources/build-info.json', fs.readFileSync(path.join(root, 'dist/build-info.json')))
      for (const relative of PACKAGED_HASH_FILES.filter(file => file !== 'build-info.json')) {
        put(root, `release/win-unpacked/resources/${relative}`, Buffer.from(`resource:${relative}`))
      }
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

    const runtimeChecks = []
    const result = await produceWindowsRelease({ version, publish: false }, {
      root,
      execFileSync: gitExec,
      spawnSync: gitProbe,
      runExternal,
      fetch: async () => responseJson({}, 404),
      // The real packaged/payload runtime verifiers run interpreters and
      // 7-Zip; the orchestration fixture proves they are INVOKED with the
      // real build outputs and that their digest flows into the manifest.
      // Their own behavior is covered by tests/runtime-layout.test.mjs.
      verifyPackagedRuntime: ({ root: checkedRoot, resources }) => {
        runtimeChecks.push(['packaged', checkedRoot, resources])
        return { digest: runtimeTreeDigest(path.join(resources, 'engine', 'runtime')), probe: { python: '3.13.15' } }
      },
      verifyInstallerPayloadRuntime: ({ installer, expectedDigest }) => {
        runtimeChecks.push(['payload', installer])
        return { digest: expectedDigest, probe: { python: '3.13.15' } }
      },
      runVerification: async () => ({
        schema: 'orgtree.windows-release-verification/v1', profile: 'focused-release-v1',
        candidate: commit, sourceFingerprint: 'sha256:fixture', sourceFiles: ['tools/release-windows.mjs'],
        commands: [{ gate: 'source', command: ['node', '--test', 'tests/release-windows.test.mjs'] }],
        results: [{ gate: 'source', status: 0, durationMs: 1 }], durationMs: 1, green: true,
        fingerprint: 'sha256:fixture-receipt',
      }),
    })
    const manifest = JSON.parse(fs.readFileSync(result.manifestPath, 'utf8'))
    const handoff = JSON.parse(fs.readFileSync(result.handoffPath, 'utf8'))
    assert.deepEqual(manifest.artifacts.map(record => record.name), CANONICAL_ASSET_NAMES(version))
    assert.equal(manifest.publication.state, 'candidate-only')
    assert.equal(handoff.commit, commit)
    assert.equal(handoff.runtimeVerification.readOnly, true)
    assert.equal(manifest.verification.candidate, commit)
    assert.equal(manifest.verification.profile, 'focused-release-v1')
    assert.equal(externalCalls.length, 1)
    const npm = resolveNpmInvocation()
    assert.deepEqual(externalCalls[0][1], [...npm.args, 'run', 'package:win', '--', '--publish', 'never'])
    // Both installed-shaped payload checks ran, against the build outputs,
    // and the complete-runtime record reached the staged manifest.
    assert.deepEqual(runtimeChecks.map(check => check[0]), ['packaged', 'payload'])
    assert.equal(runtimeChecks[0][2], path.join(root, 'release', 'win-unpacked', 'resources'))
    assert.match(runtimeChecks[1][1], /Orgtree Setup 2\.1\.2\.exe$/)
    const stagedPackaged = JSON.parse(fs.readFileSync(path.join(result.uploadDir, 'packaged-hashes.json'), 'utf8'))
    assert.equal(stagedPackaged.runtime.sitePackages, 'Lib/site-packages')
    assert.equal(stagedPackaged.runtime.payload.imported, true)
    assert.deepEqual(stagedPackaged.runtime.imports, REPRESENTATIVE_RUNTIME_IMPORTS)
  } finally {
    removeFixture(root)
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
  assert.throws(() => parseReleaseArgs(['2.1.3-RC1']), /release candidate/)
  assert.equal(installerSourceName(version), 'Orgtree Setup 2.1.3-beta.1.exe')
  assert.equal(installerAssetName(version), 'Orgtree-Setup-2.1.3-beta.1.exe')
  assert.deepEqual(releasePlan(version, { publish: true }).publication.tag,
    ['git', 'tag', 'v2.1.3-beta.1'])
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
    ['engine-hashes.json', Buffer.from('{"engine/a.py":"hash"}\n')],
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
