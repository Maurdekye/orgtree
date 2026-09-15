// Packages a FIXTURE-COMPOSED, DEV-IDENTITY build for a private update rehearsal.
//
//   node tools/package-rehearsal.mjs [--out release-rehearsal]
//
// ⚠ THIS PRODUCES AN UNPACKED APP DIRECTORY, NOT AN INSTALLER. `--dir` writes
// files and installs nothing: no uninstall registry key, no shortcuts, no
// elevation, and nothing that could overwrite or impersonate an installed
// release. The rehearsal runs the app out of that directory.
//
// ⚠ AND IT DELIBERATELY SKIPS package-preflight, WHICH WOULD REFUSE IT. That
// refusal is correct and is not being worked around: the preflight exists to
// stop a fixture-composed build being PUBLISHED, and nothing here publishes.
// The runtime layout check it also performs is run directly instead, because a
// build with a mis-staged runtime cannot start its engine and would waste the
// rehearsal.
//
// The identity comes from tools/dev-build.mjs, unchanged: its own appId, its own
// product name, its own output directory. Those are what keep this build from
// touching the installed release's registry key, install directory or data.

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { devBuildInfo, devPackagingConfig, DEV_APP_ID } from './dev-build.mjs'
import { assertRuntimeLayout } from './runtime-layout.mjs'
import {
  assertNotElevated, assertRehearsalComposition, assertRehearsalTarget,
  DEFAULT_REHEARSAL_OUT, installedRootsFromRegistry, REHEARSAL_UPDATER_CACHE,
  resolveInstalledRoot,
} from './rehearsal-isolation.mjs'

const require_ = createRequire(import.meta.url)
const argv = process.argv.slice(2)
const outDir = argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : DEFAULT_REHEARSAL_OUT

// 0. ⚠ REFUSE TO PACKAGE INTO AN INSTALLATION. --out is a path from the command
//    line; pointed at Program Files it would write a fixture-capable build over
//    the installed release. The same guard the runner uses to decide what it may
//    launch decides what this may write.
//
//    ⚠ AND THE INSTALLATIONS ARE DISCOVERED, NOT ASSUMED. Calling this without
//    the discovered root meant only the DEFAULT C:\Program Files\Orgtree was
//    protected: review measured D:\CustomInstalled\Orgtree being accepted as an
//    output directory, so the documented protection of a custom installation
//    was not actually in force here.
assertRehearsalTarget({
  exe: path.join(path.resolve(outDir), 'win-unpacked', 'Orgtree Dev.exe'),
  outDir: path.resolve(outDir),
  installedRoot: resolveInstalledRoot(),
  installedRoots: installedRootsFromRegistry(),
})
// Nothing here needs administrator rights either, and packaging WRITES — so the
// no-elevation rule applies to this entry point exactly as it does to the runner.
assertNotElevated()

// 1. The bundle, COMPOSED WITH THE FIXTURE. Without this the packaged app has no
//    substitution compiled in and the rehearsal cannot happen at all.
const built = spawnSync(process.execPath, ['tools/build.mjs', '--update-fixture'],
  { encoding: 'utf8', stdio: 'inherit', windowsHide: true })
if (built.status !== 0) throw new Error('the fixture-composed build failed')

const info = JSON.parse(fs.readFileSync('dist/build-info.json', 'utf8'))
if (info.updateFixture !== true) {
  throw new Error('the build did not disclose the update fixture; refusing to package a '
    + 'rehearsal that cannot rehearse')
}

// 2. The DEV channel identity, written over the release-channel stamp the build
//    just produced. This is what gives the packaged app its own data directory,
//    its own uninstall key and its own shell identity.
// ⚠ devVersion REQUIRES A PLAIN x.y.z BASE and package.json is at an RC, so the
// shared helper cannot version this as it stands. The numeric core is used
// instead of loosening devVersion, which is shipped, reviewed code and is strict
// for a reason: a dev stamp that could be mistaken for a release is exactly what
// it exists to prevent. The rehearsal therefore reports e.g. 2.1.5-dev.g<sha>,
// which is unmistakably a development build and is comfortably outranked by the
// 9.9.9-fixture the private feed offers.
const core = String(info.version).replace(/-.*$/, '')
const dev = devBuildInfo({ ...info, version: core })
if (dev.channel !== 'dev') throw new Error('the rehearsal build must be the dev channel')
if (!dev.version.includes('-dev.')) throw new Error('the rehearsal version must be a dev version')
fs.writeFileSync('dist/build-info.json', JSON.stringify(dev, null, 2) + '\n')

// The runtime has to be staged or the packaged app cannot start its engine.
assertRuntimeLayout('engine/runtime', { label: 'engine/runtime' })

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'))
const config = devPackagingConfig(pkg.build, dev.version)
config.directories = { ...config.directories, output: outDir }
if (config.appId !== DEV_APP_ID) throw new Error('the rehearsal must keep the dev appId')
if (config.publish) throw new Error('a rehearsal build must carry no publish configuration')
fs.writeFileSync('dist/electron-builder-rehearsal.json', JSON.stringify(config, null, 2) + '\n')

console.log(`packaging rehearsal ${dev.version} (${dev.channel}) into ${outDir}/ — `
  + 'unpacked directory only, no installer')

const cli = require_.resolve('electron-builder/out/cli/cli.js')
const packed = spawnSync(process.execPath,
  [cli, '--win', '--dir', '--config', 'dist/electron-builder-rehearsal.json', '--publish', 'never'],
  { encoding: 'utf8', stdio: 'inherit', windowsHide: true })
if (packed.status !== 0) throw new Error('electron-builder --dir failed')

const unpacked = path.join(outDir, 'win-unpacked')
const exe = path.join(unpacked, 'Orgtree Dev.exe')
if (!fs.existsSync(exe)) throw new Error(`packaging produced no ${exe}`)

// ⚠ A DEV BUILD SHIPS NO app-update.yml, AND THE DOWNLOAD STAGE STILL NEEDS ONE.
// Measured, not assumed: the first rehearsal reached 'Found version 9.9.9-fixture'
// and then failed with ENOENT on resources/app-update.yml. setFeedURL overrides
// where the manifest is FETCHED from, but electron-updater still reads that file
// during the download — so a dev-channel build, which devPackagingConfig
// deliberately gives no publish configuration, cannot download an update at all
// without one.
//
// The placeholder written here names a LOOPBACK url, so even the value that is
// about to be overridden could not reach off-machine, and its own cache
// directory, so the rehearsal never shares the installed release's updater
// cache. This is a property of the REHEARSAL package only; nothing about the
// release packaging path changes.
const feedStub = path.join(unpacked, 'resources', 'app-update.yml')
fs.writeFileSync(feedStub, [
  'provider: generic',
  'url: http://127.0.0.1:1/',
  `updaterCacheDirName: ${REHEARSAL_UPDATER_CACHE}`,
  '',
].join('\n'))
console.log('wrote a loopback app-update.yml placeholder; setFeedURL replaces it at runtime')

// ⚠ PROVE WHAT WAS PACKAGED, rather than trusting the config — and prove it
// AFTER the placeholder is written, since the composition check reads it. This
// is the same function the runner uses before it launches anything, so the
// packager cannot certify a build the runner would reject.
const packagedInfo = assertRehearsalComposition(unpacked)

console.log(JSON.stringify({
  exe, version: packagedInfo.version, channel: packagedInfo.channel,
  updateFixture: packagedInfo.updateFixture, commit: packagedInfo.commit,
}, null, 2))
console.log('Rehearsal package built. Nothing was installed, elevated, published or launched.')
