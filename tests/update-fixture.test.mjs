// update-fixture.test.mjs — THE HARMLESS DUAL-ENTRY UPDATE FIXTURE.
//
// What this measures is a REFUSAL as much as a capability, because the
// requirement is that a production build must not merely decline to advertise
// the substitution mechanism — it must be UNABLE to perform it.
//
// ⚠ TWO WEAKER DESIGNS WERE REJECTED, AND BOTH ARE TESTED AS NEGATIVES HERE
// rather than merely described in a comment, because a reviewer's probe broke
// the second one: an environment variable read by shipped code is a mechanism a
// production build accepts, and a flag in the build-info.json beside the app is
// mutable data that passed both a naive capability reader AND the real release
// provenance validator. So the capability is a constant the bundler substitutes,
// and §5-§8 below exist to prove that neither the environment nor any file
// beside the app can turn it on.
//
// The two bundles in §5-§8 are built by esbuild with different `define` values,
// which is the real mechanism rather than a stand-in for it.
//
// Run: node --test tests/update-fixture.test.mjs

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'
import { createRequire } from 'node:module'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-update-fixture-'))
const require_ = createRequire(import.meta.url)

/** The module as a build COMPOSED WITH or WITHOUT the fixture would contain it.
 *  The define mirrors tools/build.mjs exactly — the whole marker string — so
 *  this is the real mechanism rather than a stand-in for it. */
async function composed(permitted) {
  const outfile = path.join(root, `update-fixture-${permitted}.cjs`)
  await build({
    entryPoints: ['apps/desktop/main/update-fixture.ts'], outfile,
    bundle: true, format: 'cjs', platform: 'node',
    define: { __ORGTREE_UPDATE_FIXTURE__: JSON.stringify(
      'ORGTREE-UPDATE-FIXTURE-BUILD:' + (permitted ? 'enabled' : 'disabled')) },
  })
  return { module: require_(outfile), outfile }
}
/** No define at all — a bundler run that never heard of the flag. */
async function composedWithoutDefine() {
  const outfile = path.join(root, 'update-fixture-undefined.cjs')
  await build({
    entryPoints: ['apps/desktop/main/update-fixture.ts'], outfile,
    bundle: true, format: 'cjs', platform: 'node',
  })
  return require_(outfile)
}

const enabled = await composed(true)
const disabled = await composed(false)
const noDefine = await composedWithoutDefine()

const updaterOut = path.join(root, 'updater.cjs')
await build({ entryPoints: ['apps/desktop/main/updater.ts'], outfile: updaterOut, bundle: true, format: 'cjs', platform: 'node' })
const { installDownloadedUpdate, updateHandoffArgs } = require_(updaterOut)

const preflight = await import('../tools/preflight-lib.mjs')

const present = () => true
const absent = () => false
const FIXTURE = 'C:\\fixtures\\orgtree-update-fixture.exe'

// ------------------------------------------------- the capability is the build

test('§1 a build composed WITHOUT the fixture cannot perform a substitution', () => {
  assert.equal(disabled.module.buildPermitsUpdateFixture(), false)
  const decision = disabled.module.updateFixtureDecision({ requested: FIXTURE, exists: present })
  assert.equal(decision.kind, 'refused')
  assert.match(decision.reason, /not composed to accept/)
  assert.match(decision.reason, /ordinary installer handoff was used unchanged/)
  assert.match(decision.reason, /C:\\fixtures\\orgtree-update-fixture\.exe/)
})

test('§2 a MISSING define is not capable either — it fails closed, not open', () => {
  assert.equal(noDefine.buildPermitsUpdateFixture(), false)
  assert.equal(
    noDefine.updateFixtureDecision({ requested: FIXTURE, exists: present }).kind, 'refused')
})

test('§3 a build composed WITH the fixture activates it', () => {
  assert.equal(enabled.module.buildPermitsUpdateFixture(), true)
  assert.deepEqual(
    enabled.module.updateFixtureDecision({ requested: `  ${FIXTURE}  `, exists: present }),
    { kind: 'active', installer: FIXTURE })
})

test('§4 even a capable build refuses a fixture that is not there, and never silently', () => {
  const decision = enabled.module.updateFixtureDecision({ requested: FIXTURE, exists: absent })
  assert.equal(decision.kind, 'refused')
  assert.match(decision.reason, /does not exist/)
})

test('§5 asking for nothing is off, and off is not a refusal', () => {
  for (const requested of [undefined, '', '   ']) {
    assert.deepEqual(
      enabled.module.updateFixtureDecision({ requested, exists: present }), { kind: 'off' })
    assert.deepEqual(
      disabled.module.updateFixtureDecision({ requested, exists: present }), { kind: 'off' })
  }
})

// ------------------------------------------------------------ tamper negatives

test('§6 ⚠ THE ENVIRONMENT CANNOT TURN IT ON. No value of the variable helps.', () => {
  for (const requested of [FIXTURE, 'true', '1', 'yes', '  anything  ', 'C:\\Windows\\System32\\cmd.exe']) {
    const decision = disabled.module.updateFixtureDecision({ requested, exists: present })
    assert.equal(decision.kind, 'refused', `env value ${JSON.stringify(requested)} must not activate`)
  }
})

test('§7 ⚠ METADATA BESIDE THE APP CANNOT TURN IT ON — the rejected design, as a negative', () => {
  // The module exposes no reader for the build-info flag at all any more, which
  // is the structural half of this: there is nothing at runtime to feed. This
  // asserts that, so a future change that reintroduces a metadata reader has to
  // delete a test that says why it must not.
  assert.equal(typeof disabled.module.readFixtureCapability, 'undefined',
    'no runtime reader of build-info may exist: mutable metadata is not a guard')
  // And the decision takes no file path, so there is no seam to point at one.
  const decision = disabled.module.updateFixtureDecision({
    requested: FIXTURE, exists: present,
    // Anything extra is ignored: the shape below is what the rejected design
    // would have needed, and it changes nothing.
    capable: true, buildInfo: { channel: 'release', updateFixture: true },
  })
  assert.equal(decision.kind, 'refused')
})

test('§8 ⚠ A DISABLED BUILD DOES NOT CARRY THE ENABLED MARKER — measured, not assumed', () => {
  // THIS TEST ALREADY EARNED ITS KEEP. The first version of this mechanism used
  // a BOOLEAN define and relied on esbuild eliminating the dead branch; this
  // test failed, because esbuild kept the eliminated branch's literal and the
  // disabled bundle carried the marker exactly as often as the enabled one. The
  // preflight's bundle scan would then have refused every build. The design was
  // changed to substitute the whole marker string, which needs no elimination.
  // The claim is about the BUNDLER, so it stays measured against real output.
  const ENABLED = enabled.module.UPDATE_FIXTURE_MARKER + enabled.module.UPDATE_FIXTURE_ENABLED_SUFFIX
  assert.equal(ENABLED, 'ORGTREE-UPDATE-FIXTURE-BUILD:enabled')
  assert.equal(enabled.module.updateFixtureBuildMark(), ENABLED)
  assert.equal(disabled.module.updateFixtureBuildMark(), 'ORGTREE-UPDATE-FIXTURE-BUILD:disabled')
  assert.equal(noDefine.updateFixtureBuildMark(), null)

  const enabledText = fs.readFileSync(enabled.outfile, 'utf8')
  const disabledText = fs.readFileSync(disabled.outfile, 'utf8')
  assert.ok(enabledText.includes(ENABLED), 'the enabled bundle must carry the enabled marker')
  assert.ok(!disabledText.includes(ENABLED),
    'the disabled bundle must NOT carry the enabled marker — the source must never '
    + 'contain it as a contiguous literal, or the preflight scan false-positives')
})

// ------------------------------------------------- published artifact rejection

test('§9 ⚠ RELEASE PACKAGING REFUSES A FIXTURE BUILD, by disclosure AND by bundle', () => {
  const bundleWith = path.join(root, 'bundle-with.cjs')
  const bundleWithout = path.join(root, 'bundle-without.cjs')
  // The enabled marker as a real bundle would carry it, and the DISABLED marker
  // in the clean one — a scan that matched the bare prefix would refuse both,
  // so the clean case here is a control on the scan itself.
  fs.writeFileSync(bundleWith, `const x = "ORGTREE-UPDATE-FIXTURE-BUILD:enabled"\n`)
  fs.writeFileSync(bundleWithout, `const x = "ORGTREE-UPDATE-FIXTURE-BUILD:disabled"\n`)

  // Clean build: accepted.
  preflight.assertNoUpdateFixture({ channel: 'release' }, bundleWithout)

  // Disclosed: refused.
  assert.throws(() => preflight.assertNoUpdateFixture({ channel: 'release', updateFixture: true }, bundleWithout),
    /discloses the update/)

  // ⚠ DISCLOSURE DELETED BUT THE BUNDLE STILL CAPABLE: refused anyway. This is
  // the case that makes the check worth having — the JSON field is the easy
  // thing to remove, and the bundle is what actually runs.
  assert.throws(() => preflight.assertNoUpdateFixture({ channel: 'release' }, bundleWith),
    /compiled into it/)

  // Even `updateFixture: false` is refused: a release build does not write the
  // field at all, so its presence in any form means a fixture build.
  assert.throws(() => preflight.assertNoUpdateFixture({ channel: 'release', updateFixture: false }, bundleWithout),
    /discloses the update/)
})

// -------------------------------------------------------------- the handoff

test('§10 the fixture is handed EXACTLY the real argument vector, /D= last', () => {
  const args = updateHandoffArgs('C:\\Program Files\\Orgtree')
  assert.deepEqual(args, ['--updated', '/S', '--force-run', '/D=C:\\Program Files\\Orgtree'])
  assert.ok(args[args.length - 1].startsWith('/D='), 'the /D= argument must be last')
  assert.equal(args.filter(a => a.startsWith('/D=')).length, 1)
})

test('§11 an active fixture takes the handoff, and the result SAYS it was a fixture', () => {
  const calls = []
  const updater = {
    install: () => { throw new Error('the library must not be asked to install for a fixture handoff') },
  }
  const result = installDownloadedUpdate(updater, 'C:\\Program Files\\Orgtree', {
    installer: FIXTURE,
    spawn: (file, args) => { calls.push({ file, args }); return { pid: 4242 } },
  })
  assert.deepEqual(calls, [{
    file: FIXTURE,
    args: ['--updated', '/S', '--force-run', '/D=C:\\Program Files\\Orgtree'],
  }])
  assert.equal(result.accepted, true)
  assert.equal(result.fixture, FIXTURE)
  assert.equal(result.directoryQuotedByNode, true)
})

test('§12 a fixture that does not start is NOT accepted', () => {
  const result = installDownloadedUpdate({ install: () => true }, 'C:\\Orgtree', {
    installer: FIXTURE, spawn: () => ({}),
  })
  assert.equal(result.accepted, false)
})

test('§13 ⚠ THE ORDINARY HANDOFF IS UNTOUCHED when no fixture is supplied', () => {
  const seen = []
  const updater = { install: (silent, runAfter) => { seen.push({ silent, runAfter }); return true } }
  const result = installDownloadedUpdate(updater, 'C:\\Program Files\\Orgtree')
  assert.deepEqual(seen, [{ silent: true, runAfter: true }])
  assert.equal(updater.installDirectory, 'C:\\Program Files\\Orgtree')
  assert.equal(result.accepted, true)
  assert.equal('fixture' in result, false)
})

test('§14 a declined ordinary handoff still clears the library latch', () => {
  const updater = { install: () => false, quitAndInstallCalled: true }
  const result = installDownloadedUpdate(updater, 'C:\\Orgtree')
  assert.equal(result.accepted, false)
  assert.equal(updater.quitAndInstallCalled, false)
  assert.equal('fixture' in result, false)
})

// ------------------------------------------------------- reachable from the app

test('§15 ⚠ THE LIVE HANDOFF IS WIRED TO IT — not just exported and unused', () => {
  // A reviewer found an earlier revision unreachable: the policy existed, the
  // seam existed, and index.ts still called the ordinary two-argument form, so
  // nothing outside tests could reach it. This reads the real call site; the
  // BEHAVIOUR of the composition is driven in §25-§32.
  const index = fs.readFileSync('apps/desktop/main/index.ts', 'utf8')
  assert.match(index, /import \{[^}]*\bprepareUpdateFixture\b[^}]*\} from '\.\/update-fixture'/,
    'index.ts must import the composed preparation')
  assert.match(index, /requested: process\.env\[UPDATE_FIXTURE_ENV\]/,
    'the live handoff must consult the environment')
  assert.match(index, /preparedFixture\.handoff\)/,
    'the live handoff must pass the prepared fixture to installDownloadedUpdate')
  assert.match(index, /updateLog\.record\('update-fixture-refused'/,
    'a refusal must be recorded, not ignored')
  assert.match(index, /updateLog\.record\('update-fixture-handoff'/,
    'a fixture handoff must be recorded so it never reads as a real update')
  assert.doesNotMatch(index, /handOff: \(\) => installDownloadedUpdate\([^)]*installDirectory\(\)\),/,
    'the ordinary two-argument handoff must no longer be the live call')
})
test('§16 the build enablement exists and defaults OFF', () => {
  const buildScript = fs.readFileSync('tools/build.mjs', 'utf8')
  assert.match(buildScript, /__ORGTREE_UPDATE_FIXTURE__/, 'the bundler must substitute the constant')
  assert.match(buildScript, /--update-fixture/, 'there must be an explicit build-time opt-in')
  // The default is the absence of the flag, so an ordinary `npm run build`
  // produces a build that cannot substitute.
  assert.match(buildScript, /process\.argv\.includes\('--update-fixture'\)/)
  assert.match(buildScript, /updateFixture \? \{ updateFixture: true \} : \{\}/,
    'the disclosure is written only for a fixture build')
})

// ------------------------------------------------- the composition gap (review)

const channelOut = path.join(root, 'build-channel.cjs')
await build({ entryPoints: ['apps/desktop/main/build-channel.ts'], outfile: channelOut, bundle: true, format: 'cjs', platform: 'node' })
const { desktopIdentity, DEV_APP_ID, RELEASE_APP_ID } = require_(channelOut)

test('§17 ⚠ WITHOUT THE FIXTURE, NO IDENTITY COULD RUN IT — the gap review found', () => {
  // Every identity that might have hosted an in-app rehearsal was excluded:
  // unpackaged and packaged-dev have no updater, and the only identity that
  // does is packaged release, which release packaging refuses to build with the
  // fixture (§9). The mechanism was unreachable one level above the wiring.
  assert.equal(desktopIdentity(false, 'release').updatesSupported, false, 'unpackaged has no updater')
  assert.equal(desktopIdentity(true, 'dev').updatesSupported, false, 'packaged dev has no updater')
  assert.equal(desktopIdentity(true, 'release').updatesSupported, true, 'only packaged release does')
})

test('§18 a fixture-composed dev build gains the updater and NOTHING else', () => {
  const plain = desktopIdentity(true, 'dev')
  const fixture = desktopIdentity(true, 'dev', true)
  assert.equal(fixture.updatesSupported, true, 'the in-app entry must exist in this composition')
  // ⚠ AND IT MUST STILL BE THE DEV IDENTITY IN EVERY OTHER RESPECT. Its own
  // appId (so its own uninstall key), its own name (so its own data directory
  // and single-instance lock), its own shell identity. Sharing any one of those
  // is what would let it collide with or impersonate the installed release,
  // which is the thing the dev identity exists to prevent.
  assert.equal(fixture.appId, plain.appId)
  assert.equal(fixture.appId, DEV_APP_ID)
  assert.notEqual(fixture.appId, RELEASE_APP_ID)
  assert.equal(fixture.name, plain.name)
  assert.equal(fixture.appUserModelId, plain.appUserModelId)
  assert.equal(fixture.displayName, plain.displayName)
})

test('§19 the flag cannot promote a build that is not packaged', () => {
  assert.equal(desktopIdentity(false, 'dev', true).updatesSupported, false)
  assert.equal(desktopIdentity(false, 'release', true).updatesSupported, false)
})

// ------------------------------------------- a completed fixture is not a failure

const { awaitInstallerProof } = require_(updaterOut)

/** The proof, driven with the process table always empty — nothing ever runs.
 *  That is the reading a fixture which finished too fast produces, and it is
 *  also the reading an installer that died on launch produces. */
async function proveWithNothingRunning({ fixtureCompleted } = {}) {
  const stages = []
  let clock = 0
  return {
    verdict: await awaitInstallerProof({
      sample: async () => ({ installerRunning: false, elevatorRunning: false, readable: true }),
      now: () => clock,
      sleep: async (ms) => { clock += ms },
      record: (stage, detail) => stages.push({ stage, detail }),
      ...(fixtureCompleted ? { fixtureCompleted } : {}),
    }),
    stages,
  }
}

test('§20 ⚠ A REAL INSTALLER THAT NEVER APPEARS STILL FAILS — the defect this wait exists for', async () => {
  const { verdict, stages } = await proveWithNothingRunning()
  assert.equal(verdict.verdict, 'failed')
  assert.ok(stages.some(s => s.stage === 'installer-never-started'))
  assert.ok(!stages.some(s => s.stage === 'update-fixture-completed'))
})

test('§21 a fixture that COMPLETED is a success, not installer-never-started', async () => {
  const { verdict, stages } = await proveWithNothingRunning({ fixtureCompleted: () => true })
  assert.equal(verdict.verdict, 'started')
  assert.match(verdict.detail, /completed and wrote its receipt/)
  assert.match(verdict.detail, /nothing was installed/)
  assert.ok(stages.some(s => s.stage === 'update-fixture-completed'),
    'the log must say a fixture completed, never that an installer ran')
  assert.ok(!stages.some(s => s.stage === 'installer-running'),
    'a fixture must never be recorded as a running installer')
  assert.ok(!stages.some(s => s.stage === 'installer-never-started'))
})

test('§22 a fixture that never ran still FAILS — the receipt is the discriminator', async () => {
  const { verdict, stages } = await proveWithNothingRunning({ fixtureCompleted: () => false })
  assert.equal(verdict.verdict, 'failed')
  assert.ok(stages.some(s => s.stage === 'installer-never-started'))
})

test('§23 a reported spawn failure ends the wait BEFORE the receipt is consulted', async () => {
  // A fixture whose spawn failed cannot have completed, and a stale receipt
  // must not be able to rescue it.
  const stages = []
  let clock = 0
  let asked = 0
  const verdict = await awaitInstallerProof({
    sample: async () => ({ installerRunning: false, elevatorRunning: false, readable: true }),
    now: () => clock,
    sleep: async (ms) => { clock += ms },
    record: (stage, detail) => stages.push({ stage, detail }),
    reportedError: () => 'ENOENT: the fixture could not be started',
    fixtureCompleted: () => { asked++; return true },
  })
  assert.equal(verdict.verdict, 'failed')
  assert.equal(asked, 0, 'a reported spawn failure must not consult the receipt at all')
  assert.ok(stages.some(s => s.stage === 'installer-never-started'))
})

test('§24 ⚠ THE PROOF WATCHES WHAT WAS LAUNCHED, not the downloaded installer', () => {
  // The reviewer measured an earlier revision selecting autoUpdater.installerPath
  // after launching the fixture, so the watched name was a process that was never
  // started and the wait failed at its bound while the fixture was alive.
  const index = fs.readFileSync('apps/desktop/main/index.ts', 'utf8')
  assert.match(index, /const handedOffFixture = outcome\.handoff\.fixture/)
  assert.match(index, /const installerImage = handedOffFixture/,
    'the watched image must come from what was launched')
  assert.match(index, /path\.basename\(handedOffFixture\)\.toLowerCase\(\)/)
})
// -------------------------------------------- the COMPOSITION, driven end to end
//
// ⚠ EVERY DEFECT IN THIS SECTION PASSED A UNIT TEST OF ITS PARTS. A reviewer
// extracted the real handoff callback and drove it, and found three: the receipt
// path was computed and never given to the child, a stale receipt plus a failed
// delete fabricated success, and the spawned child had no error listener so an
// asynchronous ENOENT threw instead of being reported. The composition is now a
// function, and this drives that function rather than reading source.

const { prepareUpdateFixture, UPDATE_FIXTURE_RECEIPT_ENV, UPDATE_FIXTURE_TOKEN_ENV,
  UPDATE_FIXTURE_TOKEN_LINE } = enabled.module

const RECEIPT = 'C:\\private-data\\update-fixture-abc123.txt'
const TOKEN = 'abc123'

/** A filesystem and a child process, simulated exactly enough to drive the
 *  composition. `files` maps a path to its contents; a value of null is a
 *  DIRECTORY, which exists but is not a file. */
function harness({ files = new Map(), childPid = 123, writesReceipt = true } = {}) {
  // The fixture executable has to EXIST, or the decision refuses before any
  // of this is reached — which is itself covered by §4.
  files.set(FIXTURE, 'MZ')
  const spawns = []
  let emitError = () => {}
  const io = {
    existsSync: (p) => files.has(p),
    statSync: (p) => ({ isFile: () => files.get(p) !== null }),
    readFileSync: (p) => files.get(p) ?? '',
  }
  const spawn = (file, args, options) => {
    spawns.push({ file, args, options })
    const listeners = []
    // The real executable writes where it was TOLD to. If it was told nothing,
    // it writes beside itself — which is precisely the drift that broke this.
    if (writesReceipt) {
      const told = options?.env?.[UPDATE_FIXTURE_RECEIPT_ENV]
      const token = options?.env?.[UPDATE_FIXTURE_TOKEN_ENV]
      const target = told ?? 'C:\\fixtures\\orgtree-update-fixture-receipt.txt'
      files.set(target, '[fixture] ran\r\n' + UPDATE_FIXTURE_TOKEN_LINE + (token ?? '') + '\r\n')
    }
    emitError = (error) => listeners.forEach(l => l(error))
    return { pid: childPid, on: (_event, listener) => listeners.push(listener) }
  }
  return { files, spawns, io, spawn, fail: (e) => emitError(e) }
}

const prepared = (h, over = {}) => prepareUpdateFixture({
  requested: FIXTURE, receiptPath: RECEIPT, token: TOKEN,
  io: h.io, spawn: h.spawn, permitted: true, ...over,
})

test('§25 ⚠ THE CHILD IS TOLD WHERE TO WRITE — the defect that made the receipt useless', () => {
  const h = harness()
  const p = prepared(h)
  assert.equal(p.decision.kind, 'active')
  p.handoff.spawn(p.handoff.installer, updateHandoffArgs('C:\\App'))
  assert.equal(h.spawns.length, 1)
  const env = h.spawns[0].options?.env
  assert.ok(env, 'the spawn must receive an environment at all')
  assert.equal(env[UPDATE_FIXTURE_RECEIPT_ENV], RECEIPT,
    'the fixture must be told the same path the proof watches')
  assert.equal(env[UPDATE_FIXTURE_TOKEN_ENV], TOKEN)
  // And with that, the completion check now actually sees it.
  assert.equal(p.completed(), true)
})

test('§26 a fixture told nothing writes elsewhere, and completion stays FALSE', () => {
  // The old shape, reproduced: the child is given no environment, so it writes
  // beside itself and the proof watching userData sees nothing. Asserted from
  // the failing side so the guarantee in §25 is a real one.
  const h = harness()
  const p = prepared(h, { spawn: (file, args) => h.spawn(file, args, undefined) })
  p.handoff.spawn(p.handoff.installer, updateHandoffArgs('C:\\App'))
  assert.equal(h.files.has(RECEIPT), false)
  assert.equal(p.completed(), false)
})

test('§27 ⚠ A STALE RECEIPT CANNOT FABRICATE SUCCESS — it refuses instead of deleting', () => {
  // The old shape deleted a fixed path and swallowed the failure, so an
  // undeletable receipt from an earlier attempt read as this attempt finishing.
  const h = harness({ files: new Map([[RECEIPT, 'left over from an earlier attempt']]) })
  const p = prepared(h)
  assert.equal(p.decision.kind, 'refused', 'a pre-existing receipt path must refuse the substitution')
  assert.match(p.decision.reason, /already exists/)
  assert.match(p.decision.reason, /ordinary installer handoff was used unchanged/)
  assert.equal(p.handoff, undefined, 'nothing may be handed off')
  assert.equal(p.completed(), false)
  assert.equal(h.spawns.length, 0, 'and nothing may be spawned')
})

test('§28 ⚠ EXISTENCE IS NOT COMPLETION: empty, partial, wrong-token and directory all fail', () => {
  for (const [label, contents] of [
    ['empty', ''],
    ['partial', '[fixture] ran\r\n'],
    ['wrong token', '[fixture] ran\r\n' + UPDATE_FIXTURE_TOKEN_LINE + 'some-other-attempt\r\n'],
    ['token line absent', '[fixture] ran\r\n[fixture-instdir] C:\\App\r\n'],
    ['a directory', null],
  ]) {
    const h = harness({ writesReceipt: false })
    const p = prepared(h)
    h.files.set(RECEIPT, contents)
    assert.equal(p.completed(), false, label + ' must not read as completion')
  }
  // …and the real thing does.
  const good = harness({ writesReceipt: false })
  const p = prepared(good)
  good.files.set(RECEIPT, '[fixture] ran\r\n' + UPDATE_FIXTURE_TOKEN_LINE + TOKEN + '\r\n')
  assert.equal(p.completed(), true)
})

test('§29 ⚠ AN ASYNCHRONOUS SPAWN ERROR IS CAPTURED, not thrown', () => {
  // A ChildProcess with no 'error' listener THROWS when Node reports a failed
  // exec, and the updater's own error slot carries only electron-updater's
  // errors, so a missing fixture used to surface as an uncaught exception and
  // never as a verdict.
  const h = harness()
  const p = prepared(h)
  p.handoff.spawn(p.handoff.installer, updateHandoffArgs('C:\\App'))
  assert.equal(p.spawnError(), undefined, 'nothing has gone wrong yet')
  assert.doesNotThrow(() => h.fail(new Error('spawn ENOENT')),
    'an error event must not throw out of the composition')
  assert.match(String(p.spawnError()), /ENOENT/)
})

test('§30 a captured spawn error ends the proof, and outranks a valid receipt', async () => {
  const h = harness()
  const p = prepared(h)
  p.handoff.spawn(p.handoff.installer, updateHandoffArgs('C:\\App'))
  h.fail(new Error('spawn ENOENT'))
  // The receipt EXISTS and is valid here — the simulated child wrote it — so
  // this also proves a reported failure outranks a receipt rather than racing it.
  assert.equal(p.completed(), true)
  const stages = []
  let clock = 0
  const verdict = await awaitInstallerProof({
    sample: async () => ({ installerRunning: false, elevatorRunning: false, readable: true }),
    now: () => clock,
    sleep: async (ms) => { clock += ms },
    record: (stage, detail) => stages.push({ stage, detail }),
    reportedError: () => p.spawnError(),
    fixtureCompleted: () => p.completed(),
  })
  assert.equal(verdict.verdict, 'failed')
  assert.ok(stages.some(s => s.stage === 'installer-never-started'))
  assert.ok(!stages.some(s => s.stage === 'update-fixture-completed'))
})

test('§31 the whole composition, happy path: spawn → receipt → proof says completed', async () => {
  const h = harness()
  const p = prepared(h)
  const result = installDownloadedUpdate(
    { install: () => { throw new Error('the library must not install for a fixture handoff') } },
    'C:\\Program Files\\Orgtree', p.handoff)
  assert.equal(result.accepted, true)
  assert.equal(result.fixture, FIXTURE)
  assert.equal(result.fixtureReceipt, RECEIPT)
  assert.deepEqual(h.spawns[0].args, ['--updated', '/S', '--force-run', '/D=C:\\Program Files\\Orgtree'])

  const stages = []
  let clock = 0
  const verdict = await awaitInstallerProof({
    sample: async () => ({ installerRunning: false, elevatorRunning: false, readable: true }),
    now: () => clock,
    sleep: async (ms) => { clock += ms },
    record: (stage, detail) => stages.push({ stage, detail }),
    reportedError: () => p.spawnError(),
    fixtureCompleted: () => p.completed(),
  })
  assert.equal(verdict.verdict, 'started')
  assert.ok(stages.some(s => s.stage === 'update-fixture-completed'))
  assert.ok(!stages.some(s => s.stage === 'installer-running'))
})

test('§32 index.ts uses the composed preparation rather than assembling it inline', () => {
  const index = fs.readFileSync('apps/desktop/main/index.ts', 'utf8')
  assert.match(index, /preparedFixture = prepareUpdateFixture\(\{/)
  assert.match(index, /receiptPath: path\.join\(app\.getPath\('userData'\), `update-fixture-\$\{fixtureToken\}\.txt`\)/,
    'the receipt path must be unique per attempt')
  assert.match(index, /const fixtureToken = randomUUID\(\)/)
  assert.match(index, /env: \{ \.\.\.process\.env, \.\.\.options\.env \}/,
    'the child must actually receive the environment the preparation built')
  assert.match(index, /reportedError: \(\) => preparedFixture\?\.spawnError\(\) \?\? takeInstallError\(\)/,
    "the fixture's own spawn failure must end the wait")
  assert.match(index, /fixtureCompleted: \(\) => preparedFixture\?\.completed\(\) === true/)
  assert.doesNotMatch(index, /fs\.rmSync\(fixtureReceipt/,
    'the delete-then-trust shape must be gone')
})
