// update-rehearsal.test.mjs — THE GUARDS THAT KEEP A REHEARSAL OFF PRODUCTION.
//
// The rehearsal tooling packages a build that can substitute a harmless fixture
// for a real installer, serves it an update over loopback, launches it and then
// kills processes and deletes directories. Every one of those verbs is one step
// away from something you would never want done to an installed release.
//
// ⚠ SO THE RULES ARE PURE FUNCTIONS AND THIS FILE DRIVES THEM WITH
// PRODUCTION-SHAPED INPUTS. A guard that can only be exercised by actually
// running a rehearsal is a guard nobody checks, and "it refuses Program Files"
// is otherwise a claim about a comment. Each test below hands a guard exactly
// the input that would do the damage and asserts that it refuses.
//
// Run: node --test tests/update-rehearsal.test.mjs

import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { build } from 'esbuild'
import { createRequire } from 'node:module'

import {
  assertFixtureProvenance, assertNotElevated, assertRehearsalComposition,
  assertRehearsalPackage, assertRehearsalTarget, compareSnapshots, DEFAULT_REHEARSAL_OUT,
  installedManifest, installedRootsFromRegistry, isElevated, isInside, isolationChecks,
  isRehearsalProcessPath, overlaps, productionDataRoot, productionInstallRoots,
  rehearsalDataRoot, REHEARSAL_UPDATER_CACHE, uninstallKeys, resolveInstalledRoot,
} from '../tools/rehearsal-isolation.mjs'
import {
  assertRehearsalPaths, assertRemovable, FIXTURE_VERSION, isFreshEntry, planRehearsal,
  receiptToken,
} from '../tools/run-rehearsal.mjs'
import { isLoopbackFeedUrl, isLoopbackHost, serveFeed, writeFeed } from '../tools/private-update-feed.mjs'
import { assertNoUpdateFixture } from '../tools/preflight-lib.mjs'

const require_ = createRequire(import.meta.url)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-rehearsal-guards-'))

// A machine-shaped environment that is nobody's real machine.
const ENV = {
  APPDATA: 'C:\\Users\\tester\\AppData\\Roaming',
  LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local',
  ProgramFiles: 'C:\\Program Files',
  'ProgramFiles(x86)': 'C:\\Program Files (x86)',
}
const INSTALLED = 'C:\\Program Files\\Orgtree'
const OUT = 'E:\\checkout\\release-rehearsal'
const EXE = path.join(OUT, 'win-unpacked', 'Orgtree Dev.exe')
const FIXTURE = 'E:\\checkout\\dist\\update-fixture\\orgtree-update-fixture.exe'
const GOOD_PACKAGE = { channel: 'dev', updateFixture: true, version: '2.1.5-dev.gabcdef0' }

const refuses = (fn, pattern) => assert.throws(fn, pattern)

// ------------------------------------------------- one definition of loopback

test('§1 ⚠ THE TOOLING AND THE APP AGREE ON WHAT "LOOPBACK" MEANS', async () => {
  // The tooling decides what it will SERVE and OFFER; the app decides what it
  // will ACCEPT. They are written in different languages in different files, so
  // the only thing keeping them honest is this: the same table, both copies.
  const outfile = path.join(tmp, 'update-fixture.cjs')
  await build({
    entryPoints: ['apps/desktop/main/update-fixture.ts'], outfile,
    bundle: true, format: 'cjs', platform: 'node',
    define: { __ORGTREE_UPDATE_FIXTURE__: JSON.stringify('ORGTREE-UPDATE-FIXTURE-BUILD:enabled') },
  })
  const app = require_(outfile)

  const cases = [
    'http://127.0.0.1:1234/', 'http://localhost:9/', 'https://localhost:443/feed/',
    'http://[::1]:8080/', 'http://LOCALHOST:1/', 'http://127.0.0.1/',
    'https://github.com/Maurdekye/orgtree/releases/', 'http://localhost.evil.test/',
    'http://127.0.0.1.evil.test/', 'http://not-localhost/', 'https://127.0.0.2/',
    'http://10.0.0.1/', 'file:///C:/feed/', 'ftp://localhost/', 'localhost:1234',
    '', 'not a url', 'http://0.0.0.0/', 'http://[::]/',
  ]
  for (const value of cases) {
    assert.equal(isLoopbackFeedUrl(value), app.isLoopbackFeedUrl(value),
      `the tooling and the app disagree about [${value}]`)
  }
  for (const host of ['localhost', '127.0.0.1', '::1', '[::1]', 'LocalHost',
    '0.0.0.0', '127.0.0.2', 'example.test', '', null, undefined]) {
    assert.equal(isLoopbackHost(host), app.isLoopbackHost(host),
      `the tooling and the app disagree about host [${host}]`)
  }
  // And the table is not vacuous in either direction.
  assert.equal(isLoopbackFeedUrl('http://127.0.0.1:1/'), true)
  assert.equal(isLoopbackFeedUrl('https://github.com/Maurdekye/orgtree/releases/'), false)
})

test('§2 ⚠ THE FEED REFUSES TO BIND ANYTHING BUT LOOPBACK', async () => {
  const directory = path.join(tmp, 'feed')
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(directory, 'artifact.exe'), 'not really an installer')
  writeFeed({
    directory, artifact: path.join(directory, 'artifact.exe'),
    version: FIXTURE_VERSION, releaseDate: new Date(0).toISOString(),
  })
  // The default was already 127.0.0.1 — but a default is a convention, and this
  // needs to be a guarantee. 0.0.0.0 would put update artifacts on the LAN.
  await assert.rejects(() => serveFeed(directory, { host: '0.0.0.0' }), /loopback only/)
  await assert.rejects(() => serveFeed(directory, { host: '192.168.1.10' }), /loopback only/)

  const served = await serveFeed(directory)
  assert.match(served.url, /^http:\/\/127\.0\.0\.1:\d+\/$/)
  await served.close()
})

// -------------------------------------------------------------- path rules

test('§3 containment is bounded by a separator, so a sibling is not "inside"', () => {
  assert.equal(isInside('C:\\a\\b\\c', 'C:\\a\\b'), true)
  assert.equal(isInside('C:\\A\\B\\C', 'c:\\a\\b'), true, 'Windows paths compare case-insensitively')
  assert.equal(isInside('C:\\a\\bc', 'C:\\a\\b'), false, 'a prefix is not containment')
  assert.equal(isInside('C:\\a\\b', 'C:\\a\\b'), false, 'a directory is not inside itself')
  assert.equal(isInside('', 'C:\\a'), false)
  assert.equal(isInside('C:\\a', ''), false)
})

test('§4 ⚠ THE LAUNCH GUARD REFUSES EVERY PRODUCTION SHAPE', () => {
  // The installed release itself — the single worst thing to launch with a
  // fixture environment set.
  refuses(() => assertRehearsalTarget({
    exe: path.join(INSTALLED, 'Orgtree.exe'), outDir: OUT, env: ENV, installedRoot: INSTALLED,
  }), /inside the installed location/)

  // Packaging or launching out of Program Files, whatever it is called.
  refuses(() => assertRehearsalTarget({
    exe: 'C:\\Program Files\\Orgtree\\win-unpacked\\Orgtree Dev.exe',
    outDir: 'C:\\Program Files\\Orgtree', env: ENV, installedRoot: INSTALLED,
  }), /overlaps the installed location/)

  // The per-user install location electron-builder's NSIS target uses.
  refuses(() => assertRehearsalTarget({
    exe: 'C:\\Users\\tester\\AppData\\Local\\Programs\\Orgtree\\Orgtree.exe',
    outDir: OUT, env: ENV, installedRoot: INSTALLED,
  }), /inside the installed location/)

  // Anything at all outside the directory this tooling packaged.
  refuses(() => assertRehearsalTarget({
    exe: 'E:\\somewhere\\else\\Orgtree Dev.exe', outDir: OUT, env: ENV, installedRoot: INSTALLED,
  }), /not inside the rehearsal output directory/)

  refuses(() => assertRehearsalTarget({ exe: '', outDir: OUT }), /no rehearsal executable/)
  refuses(() => assertRehearsalTarget({ exe: EXE, outDir: '' }), /no rehearsal output directory/)

  // …and the real shape is accepted, so the guard is not simply refusing.
  assert.equal(
    assertRehearsalTarget({ exe: EXE, outDir: OUT, env: ENV, installedRoot: INSTALLED }),
    path.resolve(EXE))
})

test('§5 ⚠ CLEANUP KILLS ONLY PROCESSES RUNNING OUT OF THE REHEARSAL DIRECTORY', () => {
  // Matching by process NAME would catch the user's real Orgtree, which is
  // running while the rehearsal runs — they share a product name by design.
  assert.equal(isRehearsalProcessPath(path.join(INSTALLED, 'Orgtree.exe'), OUT), false)
  assert.equal(isRehearsalProcessPath('C:\\Program Files\\Orgtree\\Orgtree.exe', OUT), false)
  assert.equal(isRehearsalProcessPath(EXE, OUT), true)
  assert.equal(isRehearsalProcessPath(undefined, OUT), false, 'a process with no path is not ours')
  assert.equal(isRehearsalProcessPath(EXE, undefined), false)
})

test('§6 ⚠ DELETION IS LIMITED TO THE TWO DIRECTORIES THE REHEARSAL CREATES', () => {
  refuses(() => assertRemovable(productionDataRoot(ENV), { env: ENV }), /refusing to remove/)
  refuses(() => assertRemovable('C:\\Program Files\\Orgtree', { env: ENV }), /refusing to remove/)
  refuses(() => assertRemovable('C:\\', { env: ENV }), /refusing to remove/)
  refuses(() => assertRemovable('', { env: ENV }), /refusing to remove/)
  // A child of an allowed directory is still not an allowed directory: cleanup
  // removes whole known roots, it does not take paths on trust.
  refuses(() => assertRemovable(path.join(rehearsalDataRoot(ENV), 'anything'), { env: ENV }),
    /refusing to remove/)

  assert.equal(assertRemovable(rehearsalDataRoot(ENV), { env: ENV }),
    path.resolve(rehearsalDataRoot(ENV)))
  assert.equal(assertRemovable(path.join(ENV.LOCALAPPDATA, REHEARSAL_UPDATER_CACHE), { env: ENV }),
    path.resolve(path.join(ENV.LOCALAPPDATA, REHEARSAL_UPDATER_CACHE)))
})

test('§7 the production and rehearsal data roots are different directories', () => {
  const production = path.resolve(productionDataRoot(ENV)).toLowerCase()
  const rehearsal = path.resolve(rehearsalDataRoot(ENV)).toLowerCase()
  assert.notEqual(production, rehearsal)
  assert.equal(isInside(rehearsal, production), false)
  assert.equal(isInside(production, rehearsal), false)
})

// ------------------------------------------------------- what may be packaged

test('§8 ⚠ A PACKAGE THAT IS NOT DEV-IDENTITY AND FIXTURE-COMPOSED IS REFUSED', () => {
  refuses(() => assertRehearsalPackage({ channel: 'release', updateFixture: true }),
    /not dev/)
  refuses(() => assertRehearsalPackage({ channel: 'dev' }), /does not disclose the update fixture/)
  refuses(() => assertRehearsalPackage({ channel: 'dev', updateFixture: 'yes' }),
    /does not disclose the update fixture/)
  refuses(() => assertRehearsalPackage(null), /no packaged build-info/)
  assert.deepEqual(assertRehearsalPackage(GOOD_PACKAGE), GOOD_PACKAGE)
})

test('§9 ⚠ THE RELEASE PATH STILL REFUSES A FIXTURE-COMPOSED BUILD', () => {
  // This tooling exists BECAUSE fixture composition is dangerous in a release,
  // so the refusal it deliberately steps around must still be there.
  const bundle = path.join(tmp, 'bundle.cjs')
  fs.writeFileSync(bundle, 'const marker = "ORGTREE-UPDATE-FIXTURE-BUILD' + ':enabled"\n')
  refuses(() => assertNoUpdateFixture({ updateFixture: true }, bundle), /refuses a build/)
  refuses(() => assertNoUpdateFixture({}, bundle), /substitution is compiled into it/)

  const clean = path.join(tmp, 'clean.cjs')
  fs.writeFileSync(clean, 'const marker = "ORGTREE-UPDATE-FIXTURE-BUILD' + ':disabled"\n')
  assert.doesNotThrow(() => assertNoUpdateFixture({}, clean))
})

test('§10 ⚠ NO RELEASE SCRIPT ROUTES THROUGH THE REHEARSAL TOOLING', () => {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'))
  for (const [name, script] of Object.entries(pkg.scripts ?? {})) {
    assert.ok(!script.includes('package-rehearsal'),
      `script [${name}] must not package a rehearsal build: ${script}`)
    assert.ok(!script.includes('run-rehearsal'),
      `script [${name}] must not run a rehearsal: ${script}`)
    assert.ok(!script.includes('--update-fixture'),
      `script [${name}] must not compose the fixture: ${script}`)
  }
  // And the release scripts still go through the preflight that would refuse one.
  for (const name of ['package:dir', 'package:win']) {
    assert.match(pkg.scripts[name], /package-preflight/,
      `${name} must still run the release preflight`)
  }
})

test('§11 the rehearsal never shares the release updater cache', () => {
  // The packager writes this name into the packaged app-update.yml and the
  // runner deletes exactly this directory. One shared constant, so they cannot
  // drift into either sharing the release's cache or deleting the wrong thing.
  assert.equal(REHEARSAL_UPDATER_CACHE, 'orgtree-rehearsal-updater')
  const packager = fs.readFileSync('tools/package-rehearsal.mjs', 'utf8')
  assert.match(packager, /updaterCacheDirName: \$\{REHEARSAL_UPDATER_CACHE\}/,
    'the packager must write the shared constant, not a second copy of the string')
  assert.match(packager, /url: http:\/\/127\.0\.0\.1:1\//,
    'the placeholder feed the packager writes must itself be loopback')
})

// ------------------------------------------------------------------ the plan

test('§12 ⚠ THE PLAN IS THE GATE, AND IT REFUSES EVERY UNSAFE COMBINATION', () => {
  const good = { outDir: OUT, exe: EXE, fixture: FIXTURE, feedUrl: 'http://127.0.0.1:52217/',
    packagedInfo: GOOD_PACKAGE, env: ENV, installedRoot: INSTALLED }

  // A public feed: the exact failure this whole design exists to prevent.
  refuses(() => planRehearsal({ ...good, feedUrl: 'https://github.com/Maurdekye/orgtree/releases/' }),
    /isolated loopback URL/)
  refuses(() => planRehearsal({ ...good, feedUrl: '' }), /isolated loopback URL/)

  // A release-identity build: it would share the installed release's data root.
  refuses(() => planRehearsal({ ...good, packagedInfo: { channel: 'release', updateFixture: true } }),
    /not dev/)
  // A build with no fixture composed in: it would hand off to a REAL installer.
  refuses(() => planRehearsal({ ...good, packagedInfo: { channel: 'dev' } }),
    /does not disclose the update fixture/)

  // The installed release as the launch target.
  refuses(() => planRehearsal({ ...good, exe: path.join(INSTALLED, 'Orgtree.exe') }),
    /inside the installed location/)

  // ⚠ AND THE ARTIFACT OFFERED AS "THE UPDATE" MAY NOT COME FROM AN
  // INSTALLATION — serving a real installer over the private feed would turn a
  // rehearsal into an actual install.
  refuses(() => planRehearsal({ ...good, fixture: path.join(INSTALLED, 'Orgtree.exe') }),
    /refusing to offer/)

  const plan = planRehearsal(good)
  assert.equal(plan.exe, path.resolve(EXE))
  assert.equal(plan.fixture, path.resolve(FIXTURE))
  assert.equal(plan.feedUrl, 'http://127.0.0.1:52217/')
  assert.equal(plan.dataRoot, rehearsalDataRoot(ENV))
  assert.equal(plan.updateLog, path.join(rehearsalDataRoot(ENV), 'update-log.json'))
  assert.notEqual(plan.dataRoot.toLowerCase(), plan.productionDataRoot.toLowerCase())
})

test('§13 the plan uses the caller\'s loopback decision, not a second opinion', () => {
  // planRehearsal takes isLoopback as a seam so the app's own compiled rule can
  // be substituted; its DEFAULT must be the shared tooling rule, or the gate
  // could be weaker than the app it is protecting.
  let asked = null
  refuses(() => planRehearsal({
    outDir: OUT, exe: EXE, fixture: FIXTURE, feedUrl: 'http://127.0.0.1:1/',
    packagedInfo: GOOD_PACKAGE, env: ENV, installedRoot: INSTALLED,
    isLoopback: (value) => { asked = value; return false },
  }), /isolated loopback URL/)
  assert.equal(asked, 'http://127.0.0.1:1/', 'the injected decision must actually be consulted')
})

// ---------------------------------------------------------- before and after

test('§14 ⚠ THE BASELINE COMPARISON NOTICES THE THINGS IT EXISTS TO NOTICE', () => {
  const before = {
    installedBuildInfo: { sha256: 'aaa', text: '{"channel":"release"}' },
    installedExe: { sha256: 'bbb', size: 100 },
    installedTree: { count: 1200, sha256: 'ddd' },
    uninstall: ['{guid}|Orgtree 2.1.5-RC3|2.1.5-RC3|C:\\Program Files\\Orgtree'],
    productionDataExists: true, rehearsalDataExists: false,
  }
  assert.ok(compareSnapshots(before, { ...before }).every(r => r.ok),
    'an unchanged machine must pass every row')

  const identityRow = rows => rows.find(r => /byte-for-byte unchanged/.test(r.name))
  const changedExe = compareSnapshots(before,
    { ...before, installedExe: { sha256: 'ccc', size: 120 } })
  assert.equal(identityRow(changedExe).ok, false)

  const changedInfo = compareSnapshots(before,
    { ...before, installedBuildInfo: { sha256: 'zzz', text: '{}' } })
  assert.equal(identityRow(changedInfo).ok, false)

  const newEntry = compareSnapshots(before,
    { ...before, uninstall: [...before.uninstall, '{other}|Orgtree Dev|9.9.9|E:\\x'] })
  assert.equal(newEntry.find(r => /uninstall entry/.test(r.name)).ok, false)

  const lostData = compareSnapshots(before, { ...before, productionDataExists: false })
  assert.equal(lostData.find(r => /production data root/.test(r.name)).ok, false)

  // A rehearsal data root appearing is NOT a failure — that is the rehearsal
  // doing its job, and treating it as damage would make the comparison useless.
  assert.ok(compareSnapshots(before, { ...before, rehearsalDataExists: true }).every(r => r.ok))
})

test('§15 ⚠ A FIXTURE-CAPABLE INSTALLED BUILD STOPS THE REHEARSAL DEAD', () => {
  // If the INSTALLED release could substitute, a rehearsal could reach inside
  // the real installation. Nothing else in this file would catch that.
  const root = 'C:\\Program Files\\Orgtree'
  const buildInfo = path.join(root, 'resources', 'build-info.json')
  const fakeFs = (text) => ({
    existsSync: (p) => path.resolve(p) === path.resolve(buildInfo),
    readFileSync: () => text,
  })
  const run = (script) => {
    if (script.includes('IsInRole')) return 'False'
    if (script.includes('Uninstall')) return '[]'
    return ''
  }
  const rows = (text) => isolationChecks({
    env: ENV, installedRoot: root, run, fileSystem: fakeFs(text),
    isLoopback: () => true, feed: 'http://127.0.0.1:1/',
  })

  const capable = rows(JSON.stringify(
    { channel: 'release', version: '2.1.5', commit: 'abc1234', updateFixture: false }))
  const row = capable.find(r => /fixture-capable/.test(r.name))
  assert.equal(row.ok, false, 'an installed build disclosing the fixture at all must stop this')
  assert.match(row.detail, /FIXTURE-CAPABLE/)

  const wrongChannel = rows(JSON.stringify({ channel: 'dev', version: '2.1.5' }))
  assert.equal(wrongChannel.find(r => /fixture-capable/.test(r.name)).ok, false)

  const fine = rows(JSON.stringify({ channel: 'release', version: '2.1.5', commit: 'abc1234' }))
  assert.ok(fine.every(r => r.ok), fine.filter(r => !r.ok).map(r => r.detail).join('\n'))
})

test('§16 ⚠ AN ELEVATED SHELL IS REFUSED', () => {
  // A rehearsal needs no privileges. Elevation is precisely what would let a
  // mistake reach Program Files or HKLM.
  const run = (script) => {
    if (script.includes('IsInRole')) return 'True'
    if (script.includes('Uninstall')) return '[]'
    return ''
  }
  const rows = isolationChecks({
    env: ENV, installedRoot: 'C:\\Program Files\\Orgtree', run,
    fileSystem: { existsSync: () => false, readFileSync: () => '' },
    isLoopback: () => true,
  })
  const row = rows.find(r => /elevated/.test(r.name))
  assert.equal(row.ok, false)
  assert.match(row.detail, /refusing to rehearse from an elevated shell/)
})

test('§17 a rehearsal uninstall entry already existing stops the run', () => {
  // A dev entry means a previous rehearsal installed something, which this
  // tooling never does — so the machine is not in the state it assumes.
  const run = (script) => {
    if (script.includes('IsInRole')) return 'False'
    if (script.includes('Uninstall')) {
      return JSON.stringify([{ PSChildName: '{dev}', DisplayName: 'Orgtree Dev',
        DisplayVersion: '9.9.9', InstallLocation: 'E:\\x' }])
    }
    return ''
  }
  const rows = isolationChecks({
    env: ENV, installedRoot: 'C:\\Program Files\\Orgtree', run,
    fileSystem: { existsSync: () => false, readFileSync: () => '' },
    isLoopback: () => true,
  })
  assert.equal(rows.find(r => /uninstall entry/.test(r.name)).ok, false)
})

test('§18 the installed root is discovered, not assumed', () => {
  // Hardcoding C:\Program Files\Orgtree would make this tooling silently
  // "protect" a directory that is not where the release actually lives.
  const entries = [
    { PSChildName: '{a}', DisplayName: 'Orgtree Dev', InstallLocation: 'D:\\dev\\Orgtree' },
    { PSChildName: '{b}', DisplayName: 'Orgtree 2.1.5-RC3', InstallLocation: 'D:\\Apps\\Orgtree' },
  ]
  assert.equal(resolveInstalledRoot({ env: {}, entries }), path.resolve('D:\\Apps\\Orgtree'),
    'the release entry wins over the dev one')
  assert.equal(resolveInstalledRoot({ env: { ORGTREE_INSTALLED_ROOT: 'X:\\here' }, entries }),
    path.resolve('X:\\here'), 'an explicit override wins over the registry')
  assert.equal(resolveInstalledRoot({ env: {}, entries: [] }),
    path.resolve('C:\\Program Files\\Orgtree'), 'and the default is the fallback, not the answer')

  // A discovered root is then what the launch guard protects.
  refuses(() => assertRehearsalTarget({
    exe: 'D:\\Apps\\Orgtree\\Orgtree.exe', outDir: OUT, env: ENV,
    installedRoot: 'D:\\Apps\\Orgtree',
  }), /inside the installed location/)
})

test('§19 uninstall keys are stable and include where it is installed', () => {
  const keys = uninstallKeys([
    { PSChildName: '{b}', DisplayName: 'B', DisplayVersion: '2', InstallLocation: 'C:\\b' },
    { PSChildName: '{a}', DisplayName: 'A', DisplayVersion: '1' },
  ])
  assert.deepEqual(keys, ['{a}|A|1|', '{b}|B|2|C:\\b'])
  // Sorted, so registry enumeration order cannot make an unchanged machine look
  // changed — a false alarm here would train an operator to ignore the check.
  assert.deepEqual(keys, [...keys].sort())
})

test('§20 the default rehearsal output directory is not a release directory', () => {
  assert.equal(DEFAULT_REHEARSAL_OUT, 'release-rehearsal')
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'))
  assert.notEqual(DEFAULT_REHEARSAL_OUT, pkg.build?.directories?.output ?? 'release')
  assert.ok(!productionInstallRoots(ENV, INSTALLED).some(root =>
    isInside(path.resolve(DEFAULT_REHEARSAL_OUT), root)))
})

// ═══════════════════════════════════════════════════════════════════════════
// THE SECOND ROUND. Everything below answers a defect queue-drain MEASURED by
// bundling the real main() against inert dependencies — which found four
// main-flow failures the twenty tests above could not see, because they only
// ever exercised pure predicates. Each test names the behaviour that was wrong.
// ═══════════════════════════════════════════════════════════════════════════

test('§21 ⚠ THE OUTPUT DIRECTORY MAY NOT CONTAIN AN INSTALLATION EITHER', () => {
  // C:\ is not INSIDE C:\Program Files\Orgtree, so the one-directional check
  // accepted a drive root as --out — and cleanup scans the output directory's
  // descendants, which would then include the installation.
  refuses(() => assertRehearsalTarget({
    exe: 'C:\\win-unpacked\\Orgtree Dev.exe', outDir: 'C:\\', env: ENV, installedRoot: INSTALLED,
  }), /overlaps the installed location/)
  assert.equal(overlaps('C:\\', INSTALLED), true, 'containing counts as overlapping')
  assert.equal(overlaps(INSTALLED, 'C:\\'), true, 'and so does being contained')
  assert.equal(overlaps('D:\\elsewhere', INSTALLED), false)
})

test('§22 ⚠ A DISCOVERED INSTALL ROOT IS ADDED TO THE KNOWN ONES, NOT SUBSTITUTED', () => {
  // Passing installedRoot used to REPLACE the default, so pointing the tooling
  // at one installation silently dropped every other from protection — and
  // ORGTREE_INSTALLED_ROOT became a way to switch the guard off.
  const roots = productionInstallRoots(ENV, 'D:\\Custom\\Orgtree', ['E:\\Third\\Orgtree'])
  for (const expected of ['C:\\Program Files\\Orgtree', 'D:\\Custom\\Orgtree',
    'E:\\Third\\Orgtree', 'C:\\Program Files (x86)\\Orgtree',
    'C:\\Users\\tester\\AppData\\Local\\Programs\\Orgtree']) {
    assert.ok(roots.some(root => root.toLowerCase() === path.resolve(expected).toLowerCase()),
      `${expected} must stay protected`)
  }
  // The measured case: a custom installation was accepted as an output directory
  // because only the default was being protected.
  refuses(() => assertRehearsalTarget({
    exe: 'D:\\CustomInstalled\\Orgtree\\win-unpacked\\Orgtree Dev.exe',
    outDir: 'D:\\CustomInstalled\\Orgtree', env: ENV,
    installedRoot: 'D:\\CustomInstalled\\Orgtree',
  }), /overlaps the installed location/)
  // …and it stays refused when it is merely one of several registry entries,
  // rather than the single root chosen for the baseline.
  refuses(() => assertRehearsalTarget({
    exe: 'D:\\CustomInstalled\\Orgtree\\win-unpacked\\Orgtree Dev.exe',
    outDir: 'D:\\CustomInstalled\\Orgtree', env: ENV, installedRoot: INSTALLED,
    installedRoots: ['D:\\CustomInstalled\\Orgtree'],
  }), /overlaps the installed location/)
})

test('§23 ⚠ THE WORKING DIRECTORY IS JUDGED TOO — IT IS WRITTEN TO', () => {
  // Measured: --work inside the installation had its feed directory written,
  // with a copy of the artifact in it, before the plan refused anything else.
  const good = { outDir: OUT, exe: EXE, fixture: FIXTURE, env: ENV, installedRoot: INSTALLED }
  refuses(() => assertRehearsalPaths({ ...good, workDir: path.join(INSTALLED, 'work') }),
    /overlaps an installed location/)
  refuses(() => assertRehearsalPaths({ ...good, workDir: INSTALLED }),
    /overlaps an installed location/)
  refuses(() => assertRehearsalPaths({ ...good, workDir: productionDataRoot(ENV) }),
    /overlaps the production data root/)
  refuses(() => assertRehearsalPaths({
    ...good, workDir: path.join(productionDataRoot(ENV), 'rehearsal'),
  }), /overlaps the production data root/)

  const paths = assertRehearsalPaths({ ...good, workDir: 'E:\\checkout\\dist\\rehearsal' })
  assert.equal(paths.workDir, path.resolve('E:\\checkout\\dist\\rehearsal'))
})

test('§24 ⚠ A JUNCTION MAY NOT LAUNDER A PROTECTED PATH', () => {
  // A lexical comparison sees two unrelated strings where the filesystem sees
  // one directory. Real reparse points, in a disposable temp directory —
  // nothing here touches an installation.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-alias-'))
  const real = path.join(base, 'Orgtree')
  fs.mkdirSync(path.join(real, 'resources'), { recursive: true })
  const alias = path.join(base, 'alias')
  const made = spawnSync('cmd', ['/c', 'mklink', '/J', alias, real],
    { encoding: 'utf8', windowsHide: true })
  if (made.status !== 0) {
    // Junction creation can be unavailable; say so rather than passing quietly.
    console.log(`SKIPPED §24: could not create a junction (${(made.stderr || made.stdout).trim()})`)
    return
  }
  assert.equal(overlaps(alias, real), true,
    'a junction and its target are the same directory and must compare as one')
  refuses(() => assertRehearsalTarget({
    exe: path.join(alias, 'Orgtree.exe'), outDir: OUT, env: ENV, installedRoot: real,
  }), /inside the installed location/)
  fs.rmSync(alias, { recursive: true, force: true })
  fs.rmSync(base, { recursive: true, force: true })
})

test('§25 ⚠ UNKNOWN ELEVATION IS REFUSED, NOT TREATED AS "NOT ELEVATED"', () => {
  // Measured: an exception and empty output both let the run through. A guard
  // that passes when it cannot see is not a guard.
  assert.equal(isElevated(() => 'True'), true)
  assert.equal(isElevated(() => 'false\r\n'), false)
  for (const unreadable of ['', '   ', 'maybe', 'True False']) {
    assert.equal(isElevated(() => unreadable), null, `[${unreadable}] is not an answer`)
  }
  assert.equal(isElevated(() => { throw new Error('powershell is missing') }), null)

  refuses(() => assertNotElevated(() => 'True'), /elevated shell/)
  refuses(() => assertNotElevated(() => ''), /could not determine/)
  refuses(() => assertNotElevated(() => { throw new Error('nope') }), /could not determine/)
  assert.equal(assertNotElevated(() => 'False'), false)
})

test('§26 ⚠ A HANDOFF LINE IS NOT A RESULT — FRESHNESS AND A COMPLETE RECEIPT', () => {
  // Measured: one handoff record dated the year 2000 and zero receipts produced
  // exit 0 and applied=true.
  const launchedAt = Date.parse('2026-09-15T10:00:00Z')
  assert.equal(isFreshEntry({ at: '2000-01-01T00:00:00Z' }, launchedAt), false)
  assert.equal(isFreshEntry({ at: '2026-09-15T10:00:01Z' }, launchedAt), true)
  assert.equal(isFreshEntry({ at: '2026-09-15T10:00:00Z' }, launchedAt), true, 'the boundary counts')
  assert.equal(isFreshEntry({}, launchedAt), false, 'no timestamp is treated as OLD')
  assert.equal(isFreshEntry({ at: 'not a date' }, launchedAt), false)
  assert.equal(isFreshEntry(null, launchedAt), false)

  const complete = [
    '[fixture] orgtree update fixture ran; nothing was installed',
    '[fixture-instdir] E:\\out\\win-unpacked',
    '[fixture-token] abc-123',
    '[fixture-silent] yes',
    '[fixture-complete] abc-123',
  ].join('\r\n')
  assert.equal(receiptToken(complete), 'abc-123')
  // Truncated: the fixture died before its terminal record.
  assert.equal(receiptToken(complete.split('\r\n').slice(0, -1).join('\r\n')), null)
  // Disagreeing: a terminal record that does not match the token it declares.
  assert.equal(receiptToken(complete.replace('[fixture-complete] abc-123',
    '[fixture-complete] different')), null)
  // Trailing content after the terminal record — it must be LAST.
  assert.equal(receiptToken(complete + '\r\n[fixture] something else'), null)
  assert.equal(receiptToken(''), null)
  assert.equal(receiptToken(null), null)
})

test('§27 ⚠ AN ARBITRARY EXECUTABLE IS NOT "THE HARMLESS FIXTURE"', () => {
  // Measured: C:\Downloads\RealSetup.exe was accepted, and the app would then
  // launch it at handoff — performing the real installation this promises
  // cannot happen. Location said nothing about what the bytes were.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-provenance-'))
  const exe = path.join(home, 'orgtree-update-fixture.exe')
  const nsi = path.join(home, 'build', 'update-fixture.nsi')
  fs.mkdirSync(path.dirname(nsi), { recursive: true })
  fs.writeFileSync(nsi, '; a stand-in for the real fixture script\n')
  fs.writeFileSync(exe, 'pretend fixture bytes')
  const digest = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  const sidecar = path.join(home, 'orgtree-update-fixture.provenance.json')
  const record = {
    artifact: 'orgtree-update-fixture.exe', sha256: digest(exe),
    source: 'build/update-fixture.nsi', sourceSha256: digest(nsi),
  }

  // No provenance at all — the downloaded-installer case.
  refuses(() => assertFixtureProvenance(exe, { repoRoot: home }), /no provenance beside it/)

  // Provenance that does not describe these bytes.
  fs.writeFileSync(sidecar, JSON.stringify({ ...record, sha256: 'f'.repeat(64) }))
  refuses(() => assertFixtureProvenance(exe, { repoRoot: home }), /not the bytes this repository built/)

  // Right bytes, but built from a different fixture script than the one here.
  fs.writeFileSync(sidecar, JSON.stringify({ ...record, sourceSha256: 'a'.repeat(64) }))
  refuses(() => assertFixtureProvenance(exe, { repoRoot: home }), /built from a different/)

  // Unreadable.
  fs.writeFileSync(sidecar, 'not json')
  refuses(() => assertFixtureProvenance(exe, { repoRoot: home }), /unreadable/)

  // And the honest article is accepted.
  fs.writeFileSync(sidecar, JSON.stringify(record))
  assert.equal(assertFixtureProvenance(exe, { repoRoot: home }).sha256, record.sha256)

  // ⚠ CHANGING THE BYTES AFTERWARDS IS CAUGHT — the sha is recomputed from the
  // file about to be served, never read out of the sidecar and believed.
  fs.writeFileSync(exe, 'swapped for a real installer')
  refuses(() => assertFixtureProvenance(exe, { repoRoot: home }), /not the bytes this repository built/)
  fs.rmSync(home, { recursive: true, force: true })
})

test('§28 ⚠ THE PACKAGE IS JUDGED BY WHAT WAS COMPILED, NOT BY ITS JSON', () => {
  // build-info.json is an editable text file next to the app: two lines in an
  // editor turn any packaged build into one this tooling believes is a
  // fixture-composed rehearsal build.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-composition-'))
  const resources = path.join(home, 'resources')
  fs.mkdirSync(resources, { recursive: true })
  const write = (info, asar, yml) => {
    fs.writeFileSync(path.join(resources, 'build-info.json'), JSON.stringify(info))
    if (asar === null) fs.rmSync(path.join(resources, 'app.asar'), { force: true })
    else fs.writeFileSync(path.join(resources, 'app.asar'), asar)
    if (yml === null) fs.rmSync(path.join(resources, 'app-update.yml'), { force: true })
    else fs.writeFileSync(path.join(resources, 'app-update.yml'), yml)
  }
  const MARKER = 'ORGTREE-UPDATE-FIXTURE-BUILD' + ':enabled'
  const GOOD_YML = `provider: generic\nurl: http://127.0.0.1:1/\n`
    + `updaterCacheDirName: ${REHEARSAL_UPDATER_CACHE}\n`

  write(GOOD_PACKAGE, `x ${MARKER} x`, GOOD_YML)
  assert.deepEqual(assertRehearsalComposition(home), GOOD_PACKAGE)

  // ⚠ THE CASE THAT MATTERS: the JSON says fixture-composed, the bundle is not.
  // Such a build hands off to a REAL installer.
  write(GOOD_PACKAGE, 'an ordinary bundle with no marker', GOOD_YML)
  refuses(() => assertRehearsalComposition(home), /does NOT carry the compiled update-fixture/)

  write({ channel: 'release', updateFixture: true }, `x ${MARKER} x`, GOOD_YML)
  refuses(() => assertRehearsalComposition(home), /not dev/)

  write(GOOD_PACKAGE, `x ${MARKER} x`, null)
  refuses(() => assertRehearsalComposition(home), /no packaged app-update.yml/)

  write(GOOD_PACKAGE, `x ${MARKER} x`,
    'provider: generic\nurl: http://127.0.0.1:1/\nupdaterCacheDirName: orgtree-updater\n')
  refuses(() => assertRehearsalComposition(home), /must not share the release's updater cache/)

  write(GOOD_PACKAGE, `x ${MARKER} x`,
    `provider: generic\nurl: https://github.com/Maurdekye/orgtree/releases/\n`
    + `updaterCacheDirName: ${REHEARSAL_UPDATER_CACHE}\n`)
  refuses(() => assertRehearsalComposition(home), /which is not loopback/)

  write(GOOD_PACKAGE, null, GOOD_YML)
  refuses(() => assertRehearsalComposition(home), /no packaged bundle/)
  fs.rmSync(home, { recursive: true, force: true })
})

test('§29 ⚠ THE COMPARISON CHECKS THE WHOLE INSTALLATION, AND SAYS WHAT IT CHECKED', () => {
  // The row used to claim the installed release was "byte-for-byte untouched"
  // while hashing exactly two files — saying nothing about app.asar or the
  // bundled runtime.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-manifest-'))
  fs.mkdirSync(path.join(home, 'resources', 'engine'), { recursive: true })
  fs.writeFileSync(path.join(home, 'Orgtree.exe'), 'exe')
  fs.writeFileSync(path.join(home, 'resources', 'app.asar'), 'bundle')
  fs.writeFileSync(path.join(home, 'resources', 'engine', 'python.exe'), 'runtime')

  const before = installedManifest(home)
  assert.equal(before.count, 3, 'every file under the installation is manifested')
  assert.deepEqual(installedManifest(home), before, 'and it is stable between reads')

  // A file rewritten deep inside the tree is a difference.
  fs.writeFileSync(path.join(home, 'resources', 'app.asar'), 'a DIFFERENT bundle')
  assert.notDeepEqual(installedManifest(home), before)

  // So is one appearing.
  fs.writeFileSync(path.join(home, 'resources', 'app.asar'), 'bundle')
  fs.writeFileSync(path.join(home, 'resources', 'extra.dll'), 'new')
  const added = installedManifest(home)
  assert.equal(added.count, 4)
  assert.notEqual(added.sha256, before.sha256)

  // No row promises more than it measured.
  const base = { installedBuildInfo: { sha256: 'a' }, installedExe: { sha256: 'b' },
    installedTree: before, uninstall: [], productionDataExists: true }
  const rows = compareSnapshots(base, base)
  assert.ok(rows.every(r => r.ok))
  assert.ok(rows.some(r => /no file anywhere under the installation/.test(r.name)),
    'the whole-tree row must exist')
  assert.ok(!rows.some(r => /BYTE-FOR-BYTE UNTOUCHED/.test(r.name)),
    'the row that claimed more than it checked must be gone')
  const treeRow = compareSnapshots(base, { ...base, installedTree: added })
    .find(r => /no file anywhere/.test(r.name))
  assert.equal(treeRow.ok, false)
  fs.rmSync(home, { recursive: true, force: true })
})

test('§30 ⚠ OWNERSHIP IS A PRECONDITION, NOT AN ASSUMPTION', () => {
  // Cleanup identifies its processes by the directory they run from, which is
  // only sound if nothing was already running from there. That is checkable, so
  // the preflight checks it instead of leaving cleanup to assume it.
  const run = (script) => {
    if (script.includes('IsInRole')) return 'False'
    if (script.includes('Uninstall')) return '[]'
    if (script.includes('Get-Process')) {
      return JSON.stringify([{ Id: 777, ProcessName: 'Orgtree Dev',
        Path: path.join(OUT, 'win-unpacked', 'Orgtree Dev.exe') }])
    }
    return ''
  }
  const rows = isolationChecks({
    env: ENV, installedRoot: INSTALLED, run, outDir: OUT,
    fileSystem: { existsSync: () => false, readFileSync: () => '' },
    isLoopback: () => true,
  })
  const row = rows.find(r => /already running/.test(r.name))
  assert.equal(row.ok, false)
  assert.match(row.detail, /ALREADY running/)

  // Nothing there — the check passes and says so.
  const quiet = isolationChecks({
    env: ENV, installedRoot: INSTALLED, outDir: OUT,
    run: (script) => script.includes('IsInRole') ? 'False'
      : script.includes('Get-Process') ? '[]' : '[]',
    fileSystem: { existsSync: () => false, readFileSync: () => '' },
    isLoopback: () => true,
  })
  assert.ok(quiet.every(r => r.ok), quiet.filter(r => !r.ok).map(r => r.detail).join('\n'))
})

test('§31 the registry can report more than one installation, and all are protected', () => {
  const entries = [
    { PSChildName: '{a}', DisplayName: 'Orgtree 2.1.5', InstallLocation: 'C:\\Program Files\\Orgtree' },
    { PSChildName: '{b}', DisplayName: 'Orgtree 2.0.0', InstallLocation: 'D:\\Old\\Orgtree' },
    { PSChildName: '{c}', DisplayName: 'Orgtree Dev', InstallLocation: '' },
  ]
  const roots = installedRootsFromRegistry({ entries })
  assert.deepEqual(roots.map(r => r.toLowerCase()).sort(),
    [path.resolve('C:\\Program Files\\Orgtree').toLowerCase(),
      path.resolve('D:\\Old\\Orgtree').toLowerCase()].sort())
  refuses(() => assertRehearsalTarget({
    exe: 'D:\\Old\\Orgtree\\Orgtree.exe', outDir: OUT, env: ENV,
    installedRoot: INSTALLED, installedRoots: roots,
  }), /inside the installed location/)
})

test('§32 ⚠ THE RUNNER DOES NOT RETURN FROM INSIDE ITS OWN try, SO finally CAN FAIL IT', () => {
  // Measured: the dry run returned 0 before `finally` ran, so a FAILED baseline
  // comparison was reported as success. The shape is the fix, so the shape is
  // what is pinned — there must be no `return` between the try and the finally.
  // Newlines are normalized: this tree stores CRLF, and a test that silently
  // never matches is worse than no test.
  const source = fs.readFileSync('tools/run-rehearsal.mjs', 'utf8').replace(/\r\n/g, '\n')
  const finallyAt = source.indexOf('\n  } finally {\n')
  // The try that OWNS this finally, not the earlier validation one — that
  // earlier block returns before anything exists, which is exactly right.
  const tryAt = source.lastIndexOf('\n  try {\n', finallyAt)
  assert.ok(tryAt > 0 && finallyAt > tryAt, 'the runner must have one guarded body')
  const body = source.slice(tryAt, finallyAt)
  // Four spaces is the try body's own level; anything deeper is inside a nested
  // function, where a return goes nowhere near main()'s result.
  assert.ok(!/\n {4}return\b/.test(body),
    'no return may escape the guarded body: finally must be able to lower the exit code')
  // And a missing comparison is a failure rather than a silent pass.
  assert.match(source.slice(finallyAt), /the installed release was NOT verified unchanged/)
  assert.match(source.slice(finallyAt), /exitCode = 1/,
    'the missing-comparison branch must actually set a failing exit code')
})

test('§33 ⚠ CLEANUP AND TERMINATION ONLY EVER RUN AFTER A LAUNCH', () => {
  // Measured twice: a refused --out still reached Stop-Process with that same
  // rejected directory, and a dry run stopped a pre-existing process and
  // deleted a pre-existing updater cache.
  const source = fs.readFileSync('tools/run-rehearsal.mjs', 'utf8').replace(/\r\n/g, '\n')
  const finallyAt = source.indexOf('\n  } finally {\n')
  assert.ok(finallyAt > 0, 'the runner must have a finally block')
  const cleanup = source.slice(finallyAt)
  assert.match(cleanup, /if \(launched && plan\) \{\s*\n\s*const stopped = stopRehearsalProcesses\(plan\.outDir\)/,
    'termination must be gated on an actual launch and use the VALIDATED directory')
  assert.ok(!/stopRehearsalProcesses\(plan\?\.outDir \?\? outDir\)/.test(source),
    'the unvalidated fallback that was measured reaching Program Files must be gone')
  assert.match(cleanup, /if \(!launched\) \{\s*\n\s*step\('nothing was removed'/,
    'deletion must be gated on an actual launch')
  assert.match(cleanup, /preexistingCache/,
    'the updater cache must be preserved when it existed before the run')
})

test('§34 ⚠ AN ASYNCHRONOUS SPAWN FAILURE IS HANDLED, NOT LEFT TO CRASH', () => {
  const source = fs.readFileSync('tools/run-rehearsal.mjs', 'utf8')
  assert.match(source, /child\.on\('error'/,
    'a detached spawn reports failure asynchronously; the surrounding try cannot see it')
  assert.match(source, /!spawnError && handedOff && receipts\.length > 0/,
    'and a failed launch can never be reported as applied')
})
