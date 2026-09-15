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
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'
import { createRequire } from 'node:module'

import {
  assertRehearsalPackage, assertRehearsalTarget, compareSnapshots, DEFAULT_REHEARSAL_OUT,
  isInside, isolationChecks, isRehearsalProcessPath, productionDataRoot,
  productionInstallRoots, rehearsalDataRoot, REHEARSAL_UPDATER_CACHE, uninstallKeys,
  resolveInstalledRoot,
} from '../tools/rehearsal-isolation.mjs'
import { assertRemovable, FIXTURE_VERSION, planRehearsal } from '../tools/run-rehearsal.mjs'
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
  }), /is inside the installed location/)

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
    uninstall: ['{guid}|Orgtree 2.1.5-RC3|2.1.5-RC3|C:\\Program Files\\Orgtree'],
    productionDataExists: true, rehearsalDataExists: false,
  }
  assert.ok(compareSnapshots(before, { ...before }).every(r => r.ok),
    'an unchanged machine must pass every row')

  const changedExe = compareSnapshots(before,
    { ...before, installedExe: { sha256: 'ccc', size: 120 } })
  assert.equal(changedExe.find(r => /BYTE-FOR-BYTE/.test(r.name)).ok, false)

  const changedInfo = compareSnapshots(before,
    { ...before, installedBuildInfo: { sha256: 'zzz', text: '{}' } })
  assert.equal(changedInfo.find(r => /BYTE-FOR-BYTE/.test(r.name)).ok, false)

  const newEntry = compareSnapshots(before,
    { ...before, uninstall: [...before.uninstall, '{other}|Orgtree Dev|9.9.9|E:\\x'] })
  assert.equal(newEntry.find(r => /UNINSTALL/.test(r.name)).ok, false)

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
