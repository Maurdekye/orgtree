// The local development install channel (docs/dev-builds.md): a dev build
// must be producible without publishing, must name its source commit, and
// must not be able to overwrite or impersonate the published artifact.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { devVersion, devBuildInfo, devPackagingConfig, DEV_APP_ID, DEV_PRODUCT_NAME, DEV_OUTPUT_DIR } from '../tools/dev-build.mjs'
import { assertReleaseProvenance, assertPackageInputsPresent, REQUIRED_PACKAGE_INPUTS } from '../tools/preflight-lib.mjs'

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-dev-install-test-'))
const req = createRequire(import.meta.url)
async function load(name) {
  const out = path.join(temp, name + '.cjs')
  await build({ entryPoints: [`apps/desktop/main/${name}.ts`], outfile: out, bundle: true, platform: 'node', format: 'cjs' })
  return req(out)
}
const channel = await load('build-channel')
const { compareUpdateVersions, uninstallRegistryGuid } = await load('updater')
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'))

test('dev version names the exact source commit and tree state', () => {
  assert.equal(devVersion('2.0.9', 'ab12cd34ef99', false), '2.0.9-dev.gab12cd34ef')
  assert.equal(devVersion('2.0.9', 'ab12cd34ef99', true), '2.0.9-dev.gab12cd34ef.dirty')
  // An all-digit short hash would be an invalid numeric semver identifier
  // (leading zero) without the g prefix; ordered, not just well-formed.
  const numeric = devVersion('2.0.9', '0123456789abcdef', false)
  assert.equal(numeric, '2.0.9-dev.g0123456789')
  assert.equal(compareUpdateVersions(numeric, '2.0.9') < 0, true, 'dev prerelease must sort below its release')
  assert.notEqual(compareUpdateVersions('2.0.9-dev.gab12cd34ef.dirty', '2.0.9'), null)
  // No commit, no dev build: the installed build could not name its source.
  assert.throws(() => devVersion('2.0.9', null, false), /git commit/)
  assert.throws(() => devVersion('2.0.9', 'not-a-hash', false), /git commit/)
  assert.throws(() => devVersion('2.0.9-alpha', 'ab12cd34ef99', false), /x\.y\.z/)
})

test('dev build-info keeps provenance and switches only channel and version', () => {
  const info = { version: '2.0.9', channel: 'release', commit: 'ab12cd34ef99', dirty: true, builtAt: 'x', sha256: { a: '1' } }
  const dev = devBuildInfo(info)
  assert.equal(dev.channel, 'dev')
  assert.equal(dev.version, '2.0.9-dev.gab12cd34ef.dirty')
  assert.deepEqual({ ...dev, channel: info.channel, version: info.version }, info)
  assert.equal(info.channel, 'release', 'input must not be mutated')
})

test('dev packaging config shares no identity with the release config', () => {
  const version = devVersion(pkg.version, 'ab12cd34ef99', false)
  const config = devPackagingConfig(pkg.build, version)
  // Every value the installed release derives its identity from must differ.
  assert.equal(config.appId, DEV_APP_ID)
  assert.notEqual(config.appId, pkg.build.appId)
  assert.equal(config.productName, DEV_PRODUCT_NAME)
  assert.notEqual(config.productName, pkg.build.productName)
  assert.equal(config.directories.output, DEV_OUTPUT_DIR)
  assert.notEqual(config.directories.output, pkg.build.directories.output)
  assert.equal(config.nsis.shortcutName, DEV_PRODUCT_NAME)
  assert.equal(config.nsis.menuCategory, DEV_PRODUCT_NAME)
  assert.equal(config.nsis.include, 'build/installer-dev.nsh')
  // Nothing to publish and no update feed to generate.
  assert.equal('publish' in config, false)
  assert.equal(config.win && 'publish' in config.win, false)
  assert.equal(config.extraMetadata.version, version)
  // A dev build has no native production deps; the rebuild step is what
  // stripped shared dev-only packages when run through a worktree junction.
  assert.equal(config.npmRebuild, false)
  // The rest of packaging behavior is inherited, not forked.
  assert.deepEqual(config.files, pkg.build.files)
  assert.deepEqual(config.extraResources, pkg.build.extraResources)
  assert.equal(pkg.build.appId, 'com.maurdekye.orgtree', 'release identity must stay untouched')
  assert.deepEqual(pkg.build.publish, [{ provider: 'github', owner: 'Maurdekye', repo: 'orgtree', releaseType: 'release' }])
  // The uninstall registry keys the two channels write can never collide.
  assert.notEqual(uninstallRegistryGuid(config.appId), uninstallRegistryGuid(pkg.build.appId))
  assert.throws(() => devPackagingConfig(pkg.build, pkg.version), /-dev\./)
  assert.throws(() => devPackagingConfig({ ...pkg.build, appId: DEV_APP_ID }, version), /share release identity/)
})

test('release preflight refuses a dev-channel build outright', () => {
  const head = 'ab12cd34ef99'
  const release = { version: '2.0.9', channel: 'release', commit: head, dirty: false, sha256: {} }
  assertReleaseProvenance(release, head, '')
  assert.throws(() => assertReleaseProvenance({ ...release, channel: 'dev' }, head, ''), /channel/)
  assert.throws(() => assertReleaseProvenance({ ...release, channel: undefined }, head, ''), /channel/)
  assert.throws(() => assertReleaseProvenance(devBuildInfo(release), head, ''), /channel/)
  assert.throws(() => assertReleaseProvenance({ ...release, dirty: true }, head, ''), /clean committed/)
  assert.throws(() => assertReleaseProvenance({ ...release, commit: 'ffffffffffff' }, head, ''), /clean committed/)
  assert.throws(() => assertReleaseProvenance(release, head, ' M file'), /clean committed/)
  const io = { readFileSync: () => 'other-bytes' }
  assert.throws(() => assertReleaseProvenance({ ...release, sha256: { 'dist/x': 'abc' } }, head, '', io), /Build input changed/)
})

test('packaging preflight still demands the standalone inputs', () => {
  assert.deepEqual(REQUIRED_PACKAGE_INPUTS.slice(0, 3), ['engine/launch.py', 'engine/backend/orgtree/api.py', 'engine/runtime/python.exe'])
  const present = new Set(REQUIRED_PACKAGE_INPUTS)
  assertPackageInputsPresent({ existsSync: file => present.has(file) })
  present.delete('engine/runtime/python.exe')
  assert.throws(() => assertPackageInputsPresent({ existsSync: file => present.has(file) }), /Package is incomplete: engine\/runtime\/python\.exe/)
})

test('packaged dev channel is a third identity, fully distinct from the release', () => {
  const release = channel.desktopIdentity(true, 'release')
  const dev = channel.desktopIdentity(true, 'dev')
  assert.deepEqual(release, { appId: 'com.maurdekye.orgtree', name: 'Orgtree v2', appUserModelId: 'com.maurdekye.orgtree', displayName: 'Orgtree', updatesSupported: true })
  // The name is the userData directory and the single-instance lock; the
  // appId is the uninstall key; the AUMID is the shell identity. All differ.
  assert.deepEqual(dev, { appId: 'com.maurdekye.orgtree.dev', name: 'Orgtree v2 Dev', appUserModelId: 'com.maurdekye.orgtree.dev', displayName: 'Orgtree Dev', updatesSupported: false })
  assert.equal(dev.appId, DEV_APP_ID, 'runtime and packaging must agree on the dev appId')
  // Unpackaged development keeps its long-standing values on either channel.
  for (const c of ['release', 'dev']) {
    assert.deepEqual(channel.desktopIdentity(false, c), { appId: 'com.maurdekye.orgtree', name: 'Orgtree v2', appUserModelId: 'com.maurdekye.orgtree.dev', displayName: 'Orgtree', updatesSupported: false })
  }
})

test('build channel reads only an explicit dev marker, failing toward release', () => {
  const file = path.join(temp, 'build-info.json')
  const readAs = value => { fs.writeFileSync(file, value); return channel.readBuildChannel(file) }
  assert.equal(readAs(JSON.stringify({ channel: 'dev' })), 'dev')
  assert.equal(readAs(JSON.stringify({ channel: 'release' })), 'release')
  assert.equal(readAs(JSON.stringify({ version: '2.0.3' })), 'release', 'published artifacts predate the field')
  assert.equal(readAs('not json'), 'release')
  assert.equal(readAs(JSON.stringify(['dev'])), 'release')
  assert.equal(channel.readBuildChannel(path.join(temp, 'missing.json')), 'release')
})

test('dev installer include arms the guard and the guard precedes machine state', () => {
  const dev = fs.readFileSync('build/installer-dev.nsh', 'utf8')
  assert.match(dev, /!define ORGTREE_DEV_CHANNEL[\s\S]*!include .*installer\.nsh/, 'the define must precede the include to take effect')
  const installer = fs.readFileSync('build/installer.nsh', 'utf8')
  const guard = installer.indexOf('!macro orgtreeDevScopeGuard')
  assert.notEqual(guard, -1)
  const body = installer.slice(guard, installer.indexOf('!macroend', guard))
  assert.match(body, /\$installMode == "all"/)
  assert.match(body, /SetErrorLevel 2/)
  assert.match(body, /\bQuit\b/)
  assert.match(body, /\/SD IDOK/, 'the refusal must also answer a silent install')
  // Declared before the boot preflight section, so it executes first.
  const section = installer.indexOf('Section "-Orgtree dev channel scope guard"')
  const preflight = installer.indexOf('Section "-Orgtree boot preflight"')
  assert.equal(section !== -1 && preflight !== -1 && section < preflight, true)
  assert.equal(installer.slice(0, section).lastIndexOf('!ifdef ORGTREE_DEV_CHANNEL') !== -1, true, 'the guard section must exist only on the dev channel')
})

test('package:dev script exists and the release packaging path is unchanged', () => {
  assert.equal(pkg.scripts['package:dev'], 'npm run build && node tools/package-dev.mjs')
  assert.equal(pkg.scripts['package:win'], 'npm run build && node tools/package-preflight.mjs && electron-builder --win nsis')
  assert.equal(pkg.build.nsis.include, 'build/installer.nsh')
})
