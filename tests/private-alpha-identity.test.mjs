// private-alpha-identity.test.mjs — THE PRIVATE v3 BRANCH IS 3.0.0-alpha.0.
//
// private-alpha.test.mjs proves the private packaging POLICY with synthetic
// versions. This file pins what the private v3 branch itself declares: its
// package and lockfile say exactly 3.0.0-alpha.0, and every guard is driven
// with THAT real repository version rather than a literal typed here. So an
// ordinary build of this branch carries the private version into
// build-info.json, and every public path refuses it:
// release:windows, package:win/package:dir preflight, publication, and even
// package:dev, which accepts only a plain x.y.z base version.
//
// Nothing here builds, packages, installs, runs git or reaches the network.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { build } from 'esbuild'
import {
  PRIVATE_ALPHA_VERSION as VERSION, PRIVATE_ALPHA_INSTALLER, RELEASE_IDENTITY,
  assertPublicReleaseAllowed, privateAlphaConfig,
} from '../tools/private-alpha-policy.mjs'
import { privateAlphaPlan } from '../tools/private-alpha.mjs'
import {
  assertLockfileVersion, assertVersionMatchesPackage, parseReleaseArgs,
  produceWindowsRelease, publishRelease, releasePlan,
} from '../tools/release-windows.mjs'
import { assertNoUpdateFixture, assertReleaseProvenance } from '../tools/preflight-lib.mjs'
import { devBuildInfo, devPackagingConfig } from '../tools/dev-build.mjs'

const require = createRequire(import.meta.url)
const { UUID } = require('builder-util-runtime')
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'))
const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'))
const candidate = 'a'.repeat(40)
const unexpected = () => { throw new Error('EXTERNAL SIDE EFFECT') }
// electron-builder's NsisTarget: guid = UUID.v5(appId, this namespace). The
// uninstall registry key and the per-installation registry key derive from it.
const NSIS_NAMESPACE = UUID.parse('50e065bc-3134-11e6-9bab-38c9862bdaf3')

test('the private v3 package and lockfile identify exactly 3.0.0-alpha.0', () => {
  assert.equal(pkg.version, VERSION)
  assert.doesNotThrow(() => assertLockfileVersion(VERSION, lock))
  // The private packager stamps the same version into the packed package.json
  // and names the one deliverable after it.
  const config = privateAlphaConfig(pkg.build)
  assert.equal(config.extraMetadata.version, pkg.version)
  assert.equal(config.artifactName, `Orgtree-Private-Setup-${pkg.version}.exe`)
  assert.equal(config.nsis.artifactName, PRIVATE_ALPHA_INSTALLER)
  const plan = privateAlphaPlan(pkg.build)
  assert.equal(plan.version, pkg.version)
  assert.equal(plan.publication, false)
  assert.deepEqual(plan.package.slice(-2), ['--publish', 'never'])
})

// 2.1.12's installer identity, as its tagged package.json (v2.1.12 = 0008ccb)
// declares it. Literal on purpose: the test must fail if package.json drifts,
// not follow it. The installed 2.1.12's uninstall key is this GUID.
const V2112 = { appId: 'com.maurdekye.orgtree', productName: 'Orgtree', nsis: { oneClick: false,
  perMachine: false, allowToChangeInstallationDirectory: true, deleteAppDataOnUninstall: false,
  createStartMenuShortcut: true, shortcutName: 'Orgtree', menuCategory: 'Orgtree', include: 'build/installer.nsh' } }

test('the 3.0.0-alpha.0 installer IS 2.1.12's installation: it upgrades it in place', () => {
  const config = privateAlphaConfig(pkg.build)
  // Same appId -> same NSIS GUID -> the same uninstall entry and install
  // registry key, so electron-builder's installer treats 2.1.12 as the older
  // version of this app and replaces it (user decision 2026-09-28).
  assert.equal(config.appId, V2112.appId)
  assert.equal(UUID.v5(config.appId, NSIS_NAMESPACE), UUID.v5(V2112.appId, NSIS_NAMESPACE))
  // Same product name -> same per-user install folder, shortcuts and Start menu.
  assert.equal(config.productName, V2112.productName)
  for (const [k, v] of Object.entries(V2112.nsis)) assert.equal(config.nsis[k], v, `nsis.${k}`)
  assert.deepEqual({ appId: RELEASE_IDENTITY.appId, productName: RELEASE_IDENTITY.productName,
    nsis: { ...RELEASE_IDENTITY.nsis } }, V2112)
  // What differs from a stable release: no launch at the finish page, no
  // publication, its own output folder and installer name, its version.
  assert.equal(config.nsis.runAfterFinish, false)
  assert.equal(config.publish, null)
  assert.notEqual(config.directories.output, pkg.build.directories.output)
})

test('negative control: a build config that drifted from 2.1.12's identity is refused', () => {
  for (const [what, build] of [
    ['appId', { ...pkg.build, appId: 'com.maurdekye.orgtree.private-alpha' }],
    ['productName', { ...pkg.build, productName: 'Orgtree Private Alpha' }],
    ['dev include', { ...pkg.build, nsis: { ...pkg.build.nsis, include: 'build/installer-dev.nsh' } }],
    ['shortcut', { ...pkg.build, nsis: { ...pkg.build.nsis, shortcutName: 'Orgtree Private Alpha' } }],
    ['per-machine', { ...pkg.build, nsis: { ...pkg.build.nsis, perMachine: true } }],
  ]) assert.throws(() => privateAlphaConfig(build), /install over 2\.1\.12/, what)
})

test('negative control: every public release path refuses this branch\'s real version', async () => {
  assert.throws(() => assertPublicReleaseAllowed(pkg.version), /private-only/)
  assert.throws(() => parseReleaseArgs([pkg.version]), /private-only/)
  assert.throws(() => parseReleaseArgs([pkg.version, '--publish']), /private-only/)
  assert.throws(() => releasePlan(pkg.version, { publish: true }), /private-only/)
  await assert.rejects(produceWindowsRelease({ version: pkg.version },
    { execFileSync: unexpected, spawnSync: unexpected, fetch: unexpected,
      runExternal: unexpected, runGit: unexpected }), /private-only/)
  await assert.rejects(publishRelease({ manifest: { version: pkg.version, tag: `v${pkg.version}` },
    runGit: unexpected, runExternal: unexpected, fetchImpl: unexpected }), /private-only/)
})

test('negative control: this branch cannot be released under a stable 2.x version either', async t => {
  // The other half of the boundary: v3 source must not ship as a stable 2.x
  // update. release:windows requires the target to equal package.json's
  // version, and that is now the private version.
  for (const stable of ['2.1.10', '2.1.12', '2.1.13', '2.2.0-beta.0']) {
    assert.throws(() => assertVersionMatchesPackage(stable, pkg.version), /does not match package.json/)
    assert.throws(() => assertLockfileVersion(stable, lock), /does not match/)
  }
  // Driven through the real entry point against a fixture checkout that holds
  // this branch's package files. Git answers only "is this the root?"; any
  // other process, network or file publication is a failure.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-alpha-identity-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.copyFileSync('package.json', path.join(root, 'package.json'))
  fs.copyFileSync('package-lock.json', path.join(root, 'package-lock.json'))
  const gitRootOnly = (command, args) => {
    if (command === 'git' && args.join(' ') === 'rev-parse --show-toplevel') return root + '\n'
    throw new Error('EXTERNAL SIDE EFFECT: ' + command + ' ' + args.join(' '))
  }
  await assert.rejects(produceWindowsRelease({ version: '2.1.13' },
    { root, execFileSync: gitRootOnly, spawnSync: unexpected, fetch: unexpected,
      runExternal: unexpected, runGit: unexpected }), /does not match package.json version 3\.0\.0-alpha\.0/)
  assert.deepEqual(fs.readdirSync(root).sort(), ['package-lock.json', 'package.json'],
    'the refused release wrote nothing')
})

test('negative control: an ordinary (non-private) build of this branch cannot be packaged publicly', () => {
  // tools/build.mjs without --private-alpha records package.json's version on
  // the release channel. package:win / package:dir run this preflight.
  const ordinary = { version: pkg.version, channel: 'release', commit: candidate, dirty: false, sha256: {} }
  assert.throws(() => assertNoUpdateFixture(ordinary, 'bundle', { readFileSync: () => '' }), /private-only/)
  assert.throws(() => assertReleaseProvenance(ordinary, candidate, ''), /private-only/)
})

test('negative control: package:dev fails closed on the private version', () => {
  // devVersion accepts only a plain x.y.z base, so the dev channel cannot mint
  // a second identity for this branch; the private packager is the only path.
  assert.throws(() => devBuildInfo({ version: pkg.version, commit: candidate, dirty: false }),
    /plain x\.y\.z base version/)
  // The dev channel's own guard is unchanged for a stable base.
  assert.doesNotThrow(() => devPackagingConfig(pkg.build, '2.1.12-dev.gabcdef1234'))
})

test('a stable 2.x installation is never offered this prerelease, and the 3.0.0-alpha.0 build has no updater', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-alpha-channel-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const compiled = {}
  for (const enabled of [false, true]) {
    const outfile = path.join(dir, `${enabled}.cjs`)
    await build({ entryPoints: ['apps/desktop/main/build-channel.ts'], outfile,
      bundle: true, platform: 'node', format: 'cjs',
      define: { __ORGTREE_PRIVATE_ALPHA__: JSON.stringify(`ORGTREE-PRIVATE-ALPHA-BUILD:${enabled ? 'enabled' : 'disabled'}`) } })
    compiled[enabled] = require(outfile)
  }
  const stable = compiled[false]
  // Stable installations accept stable releases only, so even a (forbidden)
  // published alpha would not be offered to them.
  for (const installed of ['2.1.10', '2.1.12']) assert.equal(stable.allowPrereleaseUpdates(installed), false)
  assert.equal(stable.updateChannelOf(pkg.version), 'alpha')
  // The 3.0.0-alpha.0 build's identity is the installed release's (same
  // appId, AUMID, userData `Orgtree v2`, display name), with no updater at
  // all, even with the update fixture requested, and its data root locked.
  const v3 = compiled[true]
  const identity = v3.desktopIdentity(true, v3.readBuildChannel(path.join(dir, 'absent.json')), true)
  const release = stable.desktopIdentity(true, 'release')
  assert.deepEqual(identity, { ...release, updatesSupported: false, ownDataRootOnly: true })
  assert.deepEqual(release, { appId: V2112.appId, name: 'Orgtree v2', appUserModelId: V2112.appId,
    displayName: 'Orgtree', updatesSupported: true })
})

// ⚠ THE 3.0.0-alpha.0 BUILD'S BACKEND DATA ROOT is 2.1.12's own
// `%APPDATA%\Orgtree v2\data` (its userData is `Orgtree v2`). The
// ORGTREE_V2_DATA development override could point the installed app at any
// other folder (and that folder's engine, through its attach descriptor);
// resolveDataRoot refuses that for this build only.
async function compileMain(dir, name, enabled) {
  const outfile = path.join(dir, `${name}-${enabled}.cjs`)
  await build({ entryPoints: [`apps/desktop/main/${name}.ts`], outfile,
    bundle: true, platform: 'node', format: 'cjs',
    define: { __ORGTREE_PRIVATE_ALPHA__: JSON.stringify(`ORGTREE-PRIVATE-ALPHA-BUILD:${enabled ? 'enabled' : 'disabled'}`) } })
  return require(outfile)
}

async function dataRootFixture(t) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-alpha-dataroot-')))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const { resolveDataRoot } = await compileMain(dir, 'policy', false)
  const channel = await compileMain(dir, 'build-channel', true)
  const stableChannel = await compileMain(dir, 'build-channel', false)
  // The real identities: a packaged 3.0.0-alpha.0 build, a packaged stable
  // release and a packaged dev-channel build.
  const v3 = channel.desktopIdentity(true, channel.readBuildChannel(path.join(dir, 'absent.json')))
  const release = stableChannel.desktopIdentity(true, 'release')
  const dev = stableChannel.desktopIdentity(true, 'dev')
  assert.equal(v3.ownDataRootOnly, true)
  assert.equal(v3.name, release.name)
  const appData = path.join(dir, 'AppData', 'Roaming')
  const userData = path.join(appData, v3.name)                 // ...\Orgtree v2
  const own = path.join(userData, 'data')                      // 2.1.12's data folder
  const oldAlpha = path.join(appData, 'Orgtree v3 Alpha', 'data')
  fs.mkdirSync(own, { recursive: true })
  fs.mkdirSync(oldAlpha, { recursive: true })
  return { dir, resolveDataRoot, v3, release, dev, userData, own, oldAlpha }
}

const refusedByV3 = /3\.0\.0-alpha\.0 uses only its own data folder/

test('the 3.0.0-alpha.0 build uses 2.1.12\'s data folder, and only that, whatever ORGTREE_V2_DATA says', async t => {
  const f = await dataRootFixture(t)
  assert.equal(path.basename(f.userData), 'Orgtree v2')
  const resolve = requested => f.resolveDataRoot(requested, f.userData, f.v3)
  // Allowed: unset, or the same folder however it is spelled.
  assert.equal(resolve(undefined), f.own)
  for (const same of [f.own, f.own + path.sep, path.join(f.own, 'x', '..'),
    ...(process.platform === 'win32' ? [f.own.toUpperCase()] : [])]) assert.equal(resolve(same), f.own, same)
  if (process.platform === 'win32') {
    const junction = path.join(f.dir, 'junction-to-own')
    fs.symlinkSync(f.own, junction, 'junction')
    assert.equal(resolve(junction), f.own, 'a junction to the data folder is the same folder')
  }
  // Refused: any other folder (the old private alpha's included), before any start/attach.
  const elsewhere = [f.oldAlpha, f.userData, path.join(f.own, 'nested'), path.join(f.own, '..', '..'),
    path.join(f.dir, 'somewhere-else'), '', 'data', path.join('..', 'data')]
  if (process.platform === 'win32') {
    const toOther = path.join(f.dir, 'junction-to-other')
    fs.symlinkSync(f.oldAlpha, toOther, 'junction')
    elsewhere.push(toOther)
  }
  for (const other of elsewhere) assert.throws(() => resolve(other), refusedByV3, JSON.stringify(other))
  // The refusal names both folders so the dialog is actionable.
  assert.throws(() => resolve(f.oldAlpha), error => error.message.includes(f.own) && error.message.includes(JSON.stringify(f.oldAlpha)))
})

test('negative control: stable and dev identities keep the ORGTREE_V2_DATA override unchanged', async t => {
  const f = await dataRootFixture(t)
  for (const identity of [f.release, f.dev]) {
    const userData = path.join(f.dir, 'AppData', 'Roaming', identity.name)
    for (const requested of [undefined, f.own, f.oldAlpha, path.join(f.dir, 'somewhere-else'), '', 'data']) {
      // Exactly the previous expression's value.
      assert.equal(f.resolveDataRoot(requested, userData, identity), requested ?? path.join(userData, 'data'), `${identity.name} ${requested}`)
    }
  }
})

test('startup path: the engine options take their data root from resolveDataRoot with this process\'s identity', async t => {
  const source = fs.readFileSync('apps/desktop/main/index.ts', 'utf8')
  // The module-level identity is the one app.setName (and so userData) uses.
  assert.match(source, /^const identity = desktopIdentity\(/m)
  assert.match(source, /^app\.setName\(identity\.name\)\r?$/m)
  // The one data-root expression; no other main-process code reads the variable.
  const lines = source.split(/\r?\n/).filter(line => /^\s*dataRoot:/.test(line))
  assert.equal(lines.length, 1)
  const expression = /^\s*dataRoot: (.+),$/.exec(lines[0])[1]
  assert.equal(expression, "resolveDataRoot(process.env.ORGTREE_V2_DATA, app.getPath('userData'), identity)")
  for (const file of fs.readdirSync('apps/desktop/main').filter(name => name.endsWith('.ts'))) {
    const code = fs.readFileSync(path.join('apps/desktop/main', file), 'utf8')
    assert.equal((code.match(/env(\.ORGTREE_V2_DATA|\[['"`]ORGTREE_V2_DATA)/g) ?? []).length, file === 'index.ts' ? 1 : 0, file)
  }
  // It is evaluated inside the startup try, before any attach or start, and
  // that try's catch shows the error and quits.
  const at = source.indexOf(lines[0])
  const optionsAt = source.lastIndexOf('const engineOptions = {', at)
  assert.ok(optionsAt > 0 && at - optionsAt < 400)
  assert.ok(at < source.indexOf('engine.attach(engineOptions)') && at < source.indexOf('engine.start(engineOptions)'))
  assert.match(source.slice(at), /\} catch \(error\) \{\s*await dialog\.showMessageBox\(\{ type: 'error', message: 'Orgtree could not start its engine\.'[^\n]*\n\s*app\.quit\(\)/)

  // Drive the REAL expression text with the real policy and identities.
  const f = await dataRootFixture(t)
  const evaluate = (text, identity, requested, userData) =>
    new Function('resolveDataRoot', 'process', 'app', 'identity', 'path', `return ${text}`)(
      f.resolveDataRoot, { env: requested === undefined ? {} : { ORGTREE_V2_DATA: requested } },
      { getPath: name => { assert.equal(name, 'userData'); return userData } }, identity, path)
  assert.equal(evaluate(expression, f.v3, undefined, f.userData), f.own)
  assert.throws(() => evaluate(expression, f.v3, f.oldAlpha, f.userData), refusedByV3)
  assert.equal(evaluate(expression, f.release, f.oldAlpha, f.userData), f.oldAlpha)
  assert.equal(evaluate(expression, f.release, undefined, f.userData), f.own)

  // Negative control: the previous expression is exactly what this test
  // exists to catch — it hands the installed v3 build any folder it is told.
  const previous = "process.env.ORGTREE_V2_DATA ?? path.join(app.getPath('userData'), 'data')"
  assert.equal(evaluate(previous, f.v3, f.oldAlpha, f.userData), f.oldAlpha)
})
