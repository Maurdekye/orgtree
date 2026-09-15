// update-fixture.test.mjs — THE HARMLESS DUAL-ENTRY UPDATE FIXTURE.
//
// What this measures is a REFUSAL as much as a capability. The requirement is
// that a production build must not expose or accept the substitution mechanism,
// so the interesting cases are the ones where a fixture is asked for and must
// not happen: that is the case a guard built out of an environment variable
// alone would get wrong, and it is the case a published build will actually be
// in if the variable is ever set in an operator's environment.
//
// Nothing is spawned here. The spawn seam is injected, so the in-app handoff's
// argument vector and its result are driven without starting a process — which
// is what lets the whole matrix run on a machine where the fixture routes
// themselves may not be executed.
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

const fixtureOut = path.join(root, 'update-fixture.cjs')
await build({ entryPoints: ['apps/desktop/main/update-fixture.ts'], outfile: fixtureOut, bundle: true, format: 'cjs', platform: 'node' })
const { readFixtureCapability, updateFixtureDecision, UPDATE_FIXTURE_ENV } = require_(fixtureOut)

const updaterOut = path.join(root, 'updater.cjs')
await build({ entryPoints: ['apps/desktop/main/updater.ts'], outfile: updaterOut, bundle: true, format: 'cjs', platform: 'node' })
const { installDownloadedUpdate, updateHandoffArgs } = require_(updaterOut)

const present = () => true
const absent = () => false

// ---------------------------------------------------------------- capability

test('§1 only an explicit updateFixture:true marker makes a build capable', () => {
  const io = (text) => ({ readFileSync: () => text })
  assert.equal(readFixtureCapability('x', io('{"updateFixture":true}')), true)

  // Every other shape is NOT capable. A published build carries none of the
  // field at all, which is the first case here.
  for (const text of [
    '{}',
    '{"channel":"release"}',
    '{"updateFixture":false}',
    '{"updateFixture":"true"}',   // a string is not the marker
    '{"updateFixture":1}',
    'null',
    '[]',
    'not json at all',
  ]) {
    assert.equal(readFixtureCapability('x', io(text)), false, `capable for ${text}`)
  }
})

test('§2 an unreadable or missing build-info fails CLOSED', () => {
  const throwing = { readFileSync: () => { throw new Error('ENOENT') } }
  assert.equal(readFixtureCapability('missing', throwing), false)
})

// ------------------------------------------------------------------ decision

test('§3 no request is off, and off is not a refusal', () => {
  for (const requested of [undefined, '', '   ']) {
    const decision = updateFixtureDecision({ requested, capable: true, exists: present })
    assert.deepEqual(decision, { kind: 'off' }, `requested ${JSON.stringify(requested)}`)
  }
})

test('§4 ⚠ A PRODUCTION BUILD REFUSES, and says so — the case an env-var guard gets wrong', () => {
  const decision = updateFixtureDecision({
    requested: 'C:\\fixtures\\harmless.exe', capable: false, exists: present,
  })
  assert.equal(decision.kind, 'refused')
  // The reason has to carry BOTH what was asked for and that the ordinary
  // handoff still ran; a refusal nobody can read afterwards is one more
  // indistinguishable hypothesis in the next update incident.
  assert.match(decision.reason, /C:\\fixtures\\harmless\.exe/)
  assert.match(decision.reason, new RegExp(UPDATE_FIXTURE_ENV))
  assert.match(decision.reason, /not packaged to accept/)
  assert.match(decision.reason, /ordinary installer handoff was used unchanged/)
})

test('§5 a capable build still refuses a fixture that is not there', () => {
  const decision = updateFixtureDecision({
    requested: 'C:\\fixtures\\gone.exe', capable: true, exists: absent,
  })
  assert.equal(decision.kind, 'refused')
  assert.match(decision.reason, /does not exist/)
  assert.match(decision.reason, /ordinary installer handoff was used unchanged/)
})

test('§6 a capable build with a real fixture activates it', () => {
  assert.deepEqual(
    updateFixtureDecision({ requested: '  C:\\fixtures\\harmless.exe  ', capable: true, exists: present }),
    { kind: 'active', installer: 'C:\\fixtures\\harmless.exe' })
})

// ------------------------------------------------------- the in-app handoff

test('§7 the fixture is handed EXACTLY the real argument vector, /D= last', () => {
  assert.deepEqual(updateHandoffArgs('C:\\Program Files\\Orgtree'),
    ['--updated', '/S', '--force-run', '/D=C:\\Program Files\\Orgtree'])
  // /D= must be last for NSIS, and it must not be pre-quoted by us: Windows
  // does that on its own for a whitespace-bearing path, which is measured
  // elsewhere. Asserting the tail explicitly so a reorder cannot pass.
  const args = updateHandoffArgs('C:\\Program Files\\Orgtree')
  assert.ok(args[args.length - 1].startsWith('/D='), 'the /D= argument must be last')
  assert.equal(args.filter(a => a.startsWith('/D=')).length, 1)
})

test('§8 an active fixture takes the handoff, and the result SAYS it was a fixture', () => {
  const calls = []
  const updater = {
    install: () => { throw new Error('the library must not be asked to install for a fixture handoff') },
  }
  const result = installDownloadedUpdate(updater, 'C:\\Program Files\\Orgtree', {
    installer: 'C:\\fixtures\\harmless.exe',
    spawn: (file, args) => { calls.push({ file, args }); return { pid: 4242 } },
  })
  assert.deepEqual(calls, [{
    file: 'C:\\fixtures\\harmless.exe',
    args: ['--updated', '/S', '--force-run', '/D=C:\\Program Files\\Orgtree'],
  }])
  assert.equal(result.accepted, true)
  assert.equal(result.fixture, 'C:\\fixtures\\harmless.exe')
  assert.equal(result.directory, 'C:\\Program Files\\Orgtree')
  // The whitespace diagnostic is still reported on the fixture route, so the
  // two routes' records stay comparable field for field.
  assert.equal(result.directoryQuotedByNode, true)
})

test('§9 a fixture that does not start is NOT accepted', () => {
  const result = installDownloadedUpdate({ install: () => true }, 'C:\\Orgtree', {
    installer: 'C:\\fixtures\\harmless.exe',
    spawn: () => ({}),          // no pid: the process object was never created
  })
  assert.equal(result.accepted, false)
  assert.equal(result.fixture, 'C:\\fixtures\\harmless.exe')
})

test('§10 ⚠ THE ORDINARY HANDOFF IS UNTOUCHED when no fixture is supplied', () => {
  const seen = []
  const updater = {
    install: (silent, runAfter) => { seen.push({ silent, runAfter }); return true },
  }
  const result = installDownloadedUpdate(updater, 'C:\\Program Files\\Orgtree')
  assert.deepEqual(seen, [{ silent: true, runAfter: true }])
  assert.equal(updater.installDirectory, 'C:\\Program Files\\Orgtree')
  assert.equal(result.accepted, true)
  // No fixture field at all, so a real update can never be read as a rehearsal.
  assert.equal('fixture' in result, false)
})

test('§11 a declined ordinary handoff still clears the library latch', () => {
  const updater = { install: () => false, quitAndInstallCalled: true }
  const result = installDownloadedUpdate(updater, 'C:\\Orgtree')
  assert.equal(result.accepted, false)
  assert.equal(updater.quitAndInstallCalled, false)
  assert.equal('fixture' in result, false)
})

// ------------------------------------------------------------- the two routes

test('§12 both entry points target ONE contract: the same binary, the same arguments', () => {
  // The manual route is the fixture executable launched by hand, so the
  // contract it targets is the file itself plus the arguments an installer
  // receives. The in-app route must therefore hand off to that same file with
  // that same vector — which is what §7 and §8 pin. This asserts the property
  // the requirement is actually about: the two routes cannot drift apart
  // without one of those failing.
  const manualRouteBinary = 'C:\\fixtures\\harmless.exe'
  const result = installDownloadedUpdate({ install: () => true }, 'C:\\Program Files\\Orgtree', {
    installer: manualRouteBinary,
    spawn: () => ({ pid: 7 }),
  })
  assert.equal(result.fixture, manualRouteBinary,
    'the in-app route must hand off to the same binary the manual route launches')
})
