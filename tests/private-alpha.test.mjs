import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { build } from 'esbuild'
import {
  PRIVATE_ALPHA_VERSION as VERSION, PRIVATE_ALPHA_INSTALLER as INSTALLER,
  PRIVATE_ALPHA_APP_ID, PRIVATE_ALPHA_MARKER, privateAlphaConfig,
} from '../tools/private-alpha-policy.mjs'
import {
  APPROVAL_SCHEMA, assertIntegrationApproval, assertLocalPath,
  assertPrivateBuildInfo, assertNoUpdateMetadata, buildPrivateAlpha,
  makePrivateManifest, parsePrivateAlphaArgs, privateAlphaPlan,
  privateArtifactRecord, verifyPrivateDelivery, verifyPrivateResources,
  verifyPrivateInstaller,
} from '../tools/private-alpha.mjs'
import {
  parseReleaseArgs, releasePlan, channelFileName, publishRelease,
  produceWindowsRelease, serializeJson, sha256Bytes,
} from '../tools/release-windows.mjs'
import { assertNoUpdateFixture, assertReleaseProvenance } from '../tools/preflight-lib.mjs'
import { devPackagingConfig } from '../tools/dev-build.mjs'

const require = createRequire(import.meta.url)
const { createPackage, uncacheAll } = require('@electron/asar')
const { getPublishConfigs } = require('app-builder-lib/out/publish/PublishManager')
const { validateConfiguration } = require('app-builder-lib/out/util/config/config')
const { NsisTarget } = require('app-builder-lib/out/targets/nsis/NsisTarget')
const { CancellationToken } = require('builder-util-runtime')
const candidate = 'a'.repeat(40)
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'))
const approval = { schema: APPROVAL_SCHEMA, candidate, version: VERSION,
  approved: true, reviewer: 'independent-reviewer', evidence: ['combined-integration-review'] }
const verification = { schema: 'orgtree.windows-release-verification/v1', green: true,
  candidate, fingerprint: 'source-receipt', sourceFingerprint: 'source-files', commands: [['test']] }
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-private-alpha-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}
function put(root, relative, bytes) {
  const file = path.join(root, relative)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, bytes)
  return file
}

// Exercise the selected custom page with electron-builder's actual option ->
// define mapping and NSIS's actual MUI/page preprocessing. /PPO writes no EXE;
// the only substituted behavior is logging and the dispatch plugin surface.
async function preprocessInstaller(t, source, config, name) {
  const root = fixture(t)
  const compiler = process.env.ORGTREE_MAKENSIS || path.join(process.env.LOCALAPPDATA || '',
    'electron-builder/Cache/nsis-3.0.4.1/nsis-3.0.4.1-1mx3n/makensis.exe')
  assert.ok(fs.existsSync(compiler), 'NSIS compiler required; set ORGTREE_MAKENSIS')
  const defines = {}
  await NsisTarget.prototype.configureDefines.call({ options: config.nsis,
    packager: { info: { cancellationToken: new CancellationToken() },
      appInfo: { sanitizedProductName: config.productName },
      getResource: async () => null, expandMacro: value => value } }, false, defines)
  const macro = label => {
    const found = source.match(new RegExp(`!macro ${label}\\r?\\n[\\s\\S]*?\\r?\\n!macroend`))
    assert.ok(found, `${label} must exist`)
    return found[0]
  }
  const variables = source.match(/!ifndef BUILD_UNINSTALLER\r?\nVar OrgUpgradeAvailable[\s\S]*?(?=\r?\n# Snapshot)/)?.[0]
  assert.ok(variables, 'retain actual variable guards when composing the fixture')
  const devInclude = fs.readFileSync(config.nsis.include, 'utf8')
  const fixtureExe = path.join(root, 'never-built.exe')
  const nsi = `!include LogicLib.nsh
!include "${path.join(path.dirname(compiler), 'Contrib', 'Modern UI 2', 'MUI2.nsh')}"
${devInclude.includes('!define ORGTREE_DEV_CHANNEL') ? '!define ORGTREE_DEV_CHANNEL' : ''}
${Object.hasOwn(defines, 'HIDE_RUN_AFTER_FINISH') ? '!define HIDE_RUN_AFTER_FINISH' : ''}
Name "Private alpha composition fixture"
OutFile "${fixtureExe}"
RequestExecutionLevel user
!define PRODUCT_NAME "Orgtree"
!define APP_EXECUTABLE_FILENAME "Orgtree.exe"
!define UNINSTALL_FILENAME "Uninstall Orgtree.exe"
!define UNINSTALL_DISPLAY_NAME "Orgtree fixture"
!define UNINSTALL_REGISTRY_KEY "Software\\FixtureUninstall"
!define INSTALL_REGISTRY_KEY "Software\\FixtureInstall"
!define isUpdated '$OrgUpgradeSelected == "1"'
${variables}
!macro OrgLog stage detail
  DetailPrint "\${stage}: \${detail}"
!macroend
!macro FixtureExecShellAsUser result exe verb args
  DetailPrint "FIXTURE_DISPATCH \${exe}"
  StrCpy \${result} "ok"
!macroend
!define StdUtils.ExecShellAsUser '!insertmacro FixtureExecShellAsUser'
${macro('orgtreeUpgradeFunctions')}
${macro('customWelcomePage')}
${macro('customFinishPage')}
!insertmacro customWelcomePage
!insertmacro customFinishPage
!insertmacro MUI_LANGUAGE "English"
Section
SectionEnd
`
  const file = put(root, `${name}.nsi`, nsi)
  const result = spawnSync(compiler, ['/V1', '/PPO', file], {
    encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 8 * 1024 * 1024 })
  assert.equal(result.status, 0, result.error?.message || result.stdout + result.stderr)
  assert.equal(fs.existsSync(fixtureExe), false, 'preprocessing must not build an installer')
  return { output: result.stdout, hidden: Object.hasOwn(defines, 'HIDE_RUN_AFTER_FINISH') }
}

function assertNoInstallerLaunch(output) {
  assert.doesNotMatch(output, /(?:Function|Call) orgtree(?:FinishPageRun|UpgradeFinishPagePre|PrepareUpgradeRelaunch|ScheduleUpgradeRelaunch|DispatchUpgradeRelaunch)\b/,
    'private installer must contain neither the Run callback nor any upgrade relaunch path')
  assert.doesNotMatch(output, /FIXTURE_DISPATCH|OrgUpgradeRelaunch|OrgUpgradeLaunchOwned/,
    'no launch plugin calls, launch claims, preparation, or unused launch variables')
}

test('actual NSIS composition removes private Run and upgrade relaunch while retaining stable/dev paths',
  { skip: process.platform !== 'win32' }, async t => {
    const source = fs.readFileSync('build/installer.nsh', 'utf8')
    for (const [name, config] of [['private', privateAlphaConfig(pkg.build)], ['stable', pkg.build],
      ['dev', devPackagingConfig(pkg.build, '2.1.10-dev.gabcdef1234')]]) {
      const { output, hidden } = await preprocessInstaller(t, source, config, name)
      assert.equal(hidden, name === 'private')
      if (hidden) assertNoInstallerLaunch(output)
      else {
        for (const callback of ['orgtreeFinishPageRun', 'orgtreePrepareUpgradeRelaunch',
          'orgtreeScheduleUpgradeRelaunch', 'orgtreeDispatchUpgradeRelaunch']) {
          assert.ok(new RegExp(`Function ${callback}\\b`).test(output), `${name}: ${callback} definition missing`)
          assert.ok(new RegExp(`Call ["']?${callback}\\b`).test(output), `${name}: ${callback} call missing`)
        }
        assert.match(output, /FIXTURE_DISPATCH/)
      }
    }
  })

test('NSIS no-launch discriminator catches the reviewed unguarded composition',
  { skip: process.platform !== 'win32' }, async t => {
    const source = fs.readFileSync('build/installer.nsh', 'utf8')
    // Disable only the new guards: this restores f1's generated behavior while
    // keeping runAfterFinish:false and the same real builder + MUI composition.
    const unguarded = source.replaceAll('!ifndef HIDE_RUN_AFTER_FINISH', '!ifndef FIXTURE_DISABLED_NO_LAUNCH_GUARD')
    assert.notEqual(unguarded, source, 'negative control must actually remove the protection')
    const { output, hidden } = await preprocessInstaller(t, unguarded, privateAlphaConfig(pkg.build), 'unguarded')
    assert.equal(hidden, true)
    assert.ok(/Call ["']?orgtreeFinishPageRun\b/.test(output), 'negative control must expose the real MUI Run callback')
    assert.match(output, /Call orgtreeScheduleUpgradeRelaunch\b/)
    assert.throws(() => assertNoInstallerLaunch(output), /private installer/)
  })

test('default command only describes the exact private plan and rejects publication flags', () => {
  assert.deepEqual(parsePrivateAlphaArgs([]), { build: false })
  for (const args of [['--publish'], ['--publish', 'never'], ['--tag'], ['--version', VERSION], ['--build'], ['--build', '--candidate', candidate]]) {
    assert.throws(() => parsePrivateAlphaArgs(args))
  }
  const plan = privateAlphaPlan(pkg.build)
  assert.equal(plan.version, VERSION)
  assert.equal(plan.publication, false)
  assert.deepEqual(plan.package.slice(-2), ['--publish', 'never'])
  const result = spawnSync(process.execPath, ['tools/private-alpha.mjs'], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).mode, 'plan-only')
})

test('build and approval require an exact reviewed candidate before packaging', async () => {
  assert.equal(assertIntegrationApproval(approval, candidate), approval)
  for (const patch of [{ candidate: 'b'.repeat(40) }, { version: '3.0.0' }, { approved: false }, { reviewer: '' }, { evidence: [] }]) {
    assert.throws(() => assertIntegrationApproval({ ...approval, ...patch }, candidate), /approval/)
  }
  await assert.rejects(buildPrivateAlpha({ build: false, candidate }), /Explicit/)
  await assert.rejects(buildPrivateAlpha({ build: true, candidate: 'HEAD' }), /Explicit/)
})

test('real electron-builder validation and provider resolution disable every publish level even with credentials', async t => {
  const original = structuredClone(pkg.build)
  const config = privateAlphaConfig({ ...pkg.build,
    win: { publish: [{ provider: 'github' }] }, nsis: { publish: [{ provider: 'github' }] } })
  await validateConfiguration(config, { isEnabled: false })
  assert.equal(config.appId, PRIVATE_ALPHA_APP_ID)
  assert.equal(config.extraMetadata.version, VERSION)
  assert.equal(config.artifactName, INSTALLER)
  assert.equal(config.nsis.runAfterFinish, false)
  assert.equal(config.nsis.include, 'build/installer-dev.nsh')
  const prior = process.env.GH_TOKEN
  process.env.GH_TOKEN = 'fixture-only-no-network'
  t.after(() => { if (prior === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = prior })
  const packager = { config, platformSpecificBuildOptions: config.win }
  assert.equal(await getPublishConfigs(packager, config.nsis, null), null)
  assert.equal(await getPublishConfigs(packager, {}, null), null)
  assert.equal(await getPublishConfigs({ config, platformSpecificBuildOptions: {} }, {}, null), null)
  assert.deepEqual(pkg.build, original)
})

test('public entry points refuse private alpha before git, network or process mutations', async () => {
  for (const invoke of [() => parseReleaseArgs([VERSION]), () => parseReleaseArgs([VERSION, '--publish']),
    () => releasePlan(VERSION, { publish: true }), () => channelFileName(VERSION)]) assert.throws(invoke, /private-only/)
  const unexpected = () => { throw new Error('EXTERNAL SIDE EFFECT') }
  await assert.rejects(produceWindowsRelease({ version: VERSION }, { execFileSync: unexpected, fetch: unexpected }), /private-only/)
  for (const manifest of [{ version: VERSION }, { version: '2.1.10', tag: `v${VERSION}` }, { version: '2.1.10', channel: 'private-alpha' }]) {
    await assert.rejects(publishRelease({ manifest, runGit: unexpected, runExternal: unexpected, fetchImpl: unexpected }), /private-only/)
  }
  assert.equal(parseReleaseArgs(['2.1.10']).version, '2.1.10')
  assert.equal(channelFileName('2.1.10-beta.0'), 'beta.yml')
  assert.equal(channelFileName('2.1.10'), 'latest.yml')
})

test('public preflight refuses renamed private bundles as well as private metadata', () => {
  const info = { version: '2.1.10', channel: 'release', dirty: false, commit: candidate, sha256: {} }
  assert.throws(() => assertNoUpdateFixture(info, 'bundle', { readFileSync: () => PRIVATE_ALPHA_MARKER }), /compiled private-alpha/)
  assert.throws(() => assertReleaseProvenance({ ...info, version: VERSION }, candidate, ''), /private-only/)
})

test('compiled private identity survives corrupt or absent metadata and cannot enable updates', async t => {
  const root = fixture(t)
  for (const enabled of [false, true]) {
    const outfile = path.join(root, `${enabled}.cjs`)
    await build({ entryPoints: ['apps/desktop/main/build-channel.ts'], outfile,
      bundle: true, platform: 'node', format: 'cjs',
      define: { __ORGTREE_PRIVATE_ALPHA__: JSON.stringify(`ORGTREE-PRIVATE-ALPHA-BUILD:${enabled ? 'enabled' : 'disabled'}`) } })
    const compiled = require(outfile)
    assert.equal(fs.readFileSync(outfile, 'utf8').includes(PRIVATE_ALPHA_MARKER), enabled,
      'ordinary builds must not carry a private marker that public preflight would reject')
    const channel = compiled.readBuildChannel(path.join(root, 'absent.json'))
    assert.equal(channel, enabled ? 'private-alpha' : 'release')
    const identity = compiled.desktopIdentity(true, channel, true)
    assert.equal(identity.updatesSupported, !enabled)
    assert.equal(identity.name, enabled ? 'Orgtree v3 Alpha' : 'Orgtree v2')
    assert.equal(identity.appId, enabled ? PRIVATE_ALPHA_APP_ID : pkg.build.appId)
  }
})

test('build provenance and real ASAR payload checks detect version drift, fixture substitution and tampering', async t => {
  const root = fixture(t)
  const main = PRIVATE_ALPHA_MARKER + '\nORGTREE-UPDATE-FIXTURE-BUILD:disabled'
  put(root, 'dist/main/index.cjs', main)
  put(root, 'dist/renderer/index.html', 'UI fixture')
  const info = { version: VERSION, channel: 'private-alpha', candidate, commit: candidate,
    dirty: false, sha256: { 'dist/main/index.cjs': sha256Bytes(main), 'dist/renderer/index.html': sha256Bytes('UI fixture') } }
  put(root, 'dist/build-info.json', JSON.stringify(info))
  const source = path.join(root, 'app')
  put(source, 'package.json', JSON.stringify({ version: VERSION }))
  put(source, 'dist/main/index.cjs', main)
  put(source, 'dist/renderer/index.html', 'UI fixture')
  const resources = path.join(root, 'resources')
  put(resources, 'build-info.json', JSON.stringify(info))
  put(resources, 'ui/index.html', 'UI fixture')
  put(resources, 'engine/backend/orgtree/api.py', 'engine fixture')
  const engineHashes = { 'engine/backend/orgtree/api.py': sha256Bytes('engine fixture') }
  await createPackage(source, path.join(resources, 'app.asar'))
  assert.equal(assertPrivateBuildInfo(info, { root, candidate }), info)
  assert.equal(verifyPrivateResources({ root, resources, info, engineHashes }).packageVersion, VERSION)
  put(resources, 'ui/index.html', 'changed UI')
  assert.throws(() => verifyPrivateResources({ root, resources, info, engineHashes }), /UI input differs/)
  put(resources, 'ui/index.html', 'UI fixture')
  put(resources, 'engine/backend/orgtree/api.py', 'changed engine')
  assert.throws(() => verifyPrivateResources({ root, resources, info, engineHashes }), /engine input differs/)
  put(resources, 'engine/backend/orgtree/api.py', 'engine fixture')
  assert.throws(() => assertPrivateBuildInfo({ ...info, dirty: true }, { root, candidate }), /identity/)
  put(resources, 'app-update.yml', 'provider: github')
  assert.throws(() => verifyPrivateResources({ root, resources, info }), /updater metadata/)
  fs.unlinkSync(path.join(resources, 'app-update.yml'))
  put(source, 'package.json', JSON.stringify({ version: '2.1.10' }))
  await createPackage(source, path.join(resources, 'app.asar'))
  uncacheAll()
  assert.throws(() => verifyPrivateResources({ root, resources, info }), /wrong private version/)
  put(root, 'dist/main/index.cjs', main + ' changed')
  assert.throws(() => assertPrivateBuildInfo(info, { root, candidate }), /changed/)
})

test('updater manifest checks include nested stable, beta, alpha, and app feeds', t => {
  const root = fixture(t)
  for (const name of ['latest.yml', 'beta.yml', 'alpha.yml', 'latest-linux.yml', 'app-update.yaml']) {
    const file = put(root, `nested/${name}`, 'feed')
    assert.throws(() => assertNoUpdateMetadata(root), /updater metadata/)
    fs.unlinkSync(file)
  }
  put(root, 'nested/compose.yaml', 'valid unrelated YAML')
  assert.doesNotThrow(() => assertNoUpdateMetadata(root))
  assert.throws(() => assertLocalPath(root, path.join(root, '..', 'elsewhere'), { absent: true }), /inside/)
})

test('installer hook refuses the wrong PE ProductVersion before extraction or execution', t => {
  const root = fixture(t)
  const installer = put(root, INSTALLER, 'fixture, never executable')
  assert.throws(() => verifyPrivateInstaller({ root, installer, productVersion: () => '3.0.0' }), /ProductVersion/)
  assert.equal(fs.existsSync(path.join(root, 'release-private-alpha')), false)
})

test('private delivery manifests are deterministic for identical inputs and reject altered artifacts', t => {
  const root = fixture(t)
  const artifacts = [INSTALLER, 'engine-hashes.json', 'source-verification.json']
    .map(name => privateArtifactRecord(put(root, name, name)))
  const args = { candidate, artifacts, approval, verification, payload: { productVersion: VERSION, installerExecuted: false } }
  const manifest = makePrivateManifest(args)
  assert.equal(serializeJson(manifest, { sortKeys: true }), serializeJson(makePrivateManifest(args), { sortKeys: true }))
  put(root, 'private-alpha-manifest.json', serializeJson(manifest, { sortKeys: true }))
  const record = privateArtifactRecord(path.join(root, 'private-alpha-manifest.json'))
  put(root, 'private-alpha-receipt.json', JSON.stringify({ schema: 'orgtree.private-alpha-receipt/v1', version: VERSION,
    candidate, publicationAllowed: false, manifest: record, artifacts }))
  assert.equal(verifyPrivateDelivery(root).commit, candidate)
  put(root, INSTALLER, 'changed bytes')
  assert.throws(() => verifyPrivateDelivery(root), /artifact changed/)
  assert.throws(() => makePrivateManifest({ ...args, artifacts: artifacts.slice(1) }), /exact installer/)
})
