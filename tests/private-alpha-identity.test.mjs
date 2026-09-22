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
  PRIVATE_ALPHA_VERSION as VERSION, PRIVATE_ALPHA_APP_ID, PRIVATE_ALPHA_INSTALLER,
  PRIVATE_ALPHA_PRODUCT, assertPublicReleaseAllowed, privateAlphaConfig,
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

test('the private installer is a separate Windows installation from stable Orgtree', () => {
  const config = privateAlphaConfig(pkg.build)
  // Distinct appId -> distinct NSIS GUID -> distinct uninstall entry and
  // install registry key: installing it cannot replace or uninstall stable.
  assert.notEqual(config.appId, pkg.build.appId)
  assert.equal(config.appId, PRIVATE_ALPHA_APP_ID)
  const stableGuid = UUID.v5(pkg.build.appId, NSIS_NAMESPACE)
  const privateGuid = UUID.v5(config.appId, NSIS_NAMESPACE)
  assert.notEqual(privateGuid, stableGuid)
  // Distinct product name -> distinct per-user install directory and shortcuts.
  assert.equal(config.productName, PRIVATE_ALPHA_PRODUCT)
  assert.notEqual(config.productName, pkg.build.productName)
  assert.equal(config.nsis.shortcutName, PRIVATE_ALPHA_PRODUCT)
  assert.equal(config.nsis.menuCategory, PRIVATE_ALPHA_PRODUCT)
  assert.equal(config.nsis.perMachine, false)
  assert.equal(config.nsis.runAfterFinish, false)
  // Uninstall keeps the private data directory, exactly as stable does.
  assert.equal(config.nsis.deleteAppDataOnUninstall, false)
  assert.notEqual(config.directories.output, pkg.build.directories.output)
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

test('a stable 2.x installation is never offered this prerelease, and the private build has no updater', async t => {
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
  // The private build's identity: its own data directory, no updater at all,
  // even with the update fixture requested.
  const priv = compiled[true]
  const identity = priv.desktopIdentity(true, priv.readBuildChannel(path.join(dir, 'absent.json')), true)
  assert.deepEqual(identity, { appId: PRIVATE_ALPHA_APP_ID, name: 'Orgtree v3 Alpha',
    appUserModelId: PRIVATE_ALPHA_APP_ID, displayName: PRIVATE_ALPHA_PRODUCT, updatesSupported: false })
  assert.notEqual(identity.name, stable.desktopIdentity(true, 'release').name)
})
