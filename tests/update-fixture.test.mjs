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
  // A reviewer found the previous revision of this work unreachable: the policy
  // existed, the seam existed, and index.ts still called the ordinary
  // two-argument form, so nothing outside tests could ever reach it. This reads
  // the real call site so that cannot recur silently.
  const index = fs.readFileSync('apps/desktop/main/index.ts', 'utf8')
  assert.match(index, /import \{ updateFixtureDecision, UPDATE_FIXTURE_ENV \} from '\.\/update-fixture'/,
    'index.ts must import the decision')
  assert.match(index, /updateFixtureDecision\(\{[\s\S]*?requested: process\.env\[UPDATE_FIXTURE_ENV\]/,
    'the live handoff must consult the environment through the decision')
  assert.match(index, /decision\.kind === 'active'[\s\S]*?installer: decision\.installer/,
    'the live handoff must pass the fixture through to installDownloadedUpdate')
  assert.match(index, /updateLog\.record\('update-fixture-refused'/,
    'a refusal must be recorded, not ignored')
  assert.match(index, /updateLog\.record\('update-fixture-handoff'/,
    'a fixture handoff must be recorded so it never reads as a real update')
  // And the ordinary two-argument call must be gone from the handoff.
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
