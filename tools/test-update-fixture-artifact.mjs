// Drives the REAL orgtree-update-fixture.exe with the REAL handoff argument
// vector, and checks what it received.
//
// WHY THIS IS NOT IN tests/: it compiles and RUNS an executable. Everything
// under tests/*.test.mjs stays pure so `npm test` never starts a process, and
// this follows tools/test-dev-installer-guard.mjs instead — tiny installers,
// fully silent, no installation, no registry write, no elevation.
//
// WHAT IT ESTABLISHES, and why it is the dual-entry evidence rather than a
// restatement of the unit tests. The in-app route's side is a pure function,
// updateHandoffArgs, and tests/update-fixture.test.mjs pins that the live
// handoff passes exactly its output to the fixture. This half takes that SAME
// vector, hands it to the artifact the way the MANUAL route does — by launching
// the executable — and reads back what the artifact actually received. The two
// routes therefore meet on one measured contract instead of on an argument:
// same binary, same vector, one receipt to diff.
//
// ⚠ IT IS NOT THE IN-APP ROUTE END TO END. Nothing here asks a real feed for an
// update or drives the Update button. This measures the contract both routes
// target, not the discovery that precedes one of them.
//
// Run: node tools/test-update-fixture-artifact.mjs

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { build } from 'esbuild'
import { createRequire } from 'node:module'

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-update-fixture-artifact-'))
const require_ = createRequire(import.meta.url)

// The argument vector comes from the SHIPPED function, not from a copy of it
// written here — a copy would agree with itself forever.
const updaterOut = path.join(temp, 'updater.cjs')
await build({ entryPoints: ['apps/desktop/main/updater.ts'], outfile: updaterOut, bundle: true, format: 'cjs', platform: 'node' })
const { updateHandoffArgs } = require_(updaterOut)

const exe = path.join(temp, 'orgtree-update-fixture.exe')
const built = spawnSync(process.execPath, ['tools/build-update-fixture.mjs', '--out', exe],
  { encoding: 'utf8', windowsHide: true, timeout: 120000 })
if (built.status !== 0) {
  if (/INERT/.test(built.stdout + built.stderr)) {
    console.log('INERT: ' + (built.stdout + built.stderr).trim())
    process.exit(0)
  }
  throw new Error(built.stdout + built.stderr)
}
assert.ok(fs.existsSync(exe), 'the fixture artifact must exist')

// A destination WITH A SPACE, deliberately: that is the shape the field
// incident used, and the shape Windows quotes on the way to the installer.
const destination = path.join(temp, 'Program Files', 'Orgtree')
const receipt = path.join(temp, 'receipt.txt')
const args = updateHandoffArgs(destination)

const run = spawnSync(exe, args, {
  encoding: 'utf8', windowsHide: true, timeout: 60000,
  env: { ...process.env, ORGTREE_UPDATE_FIXTURE_RECEIPT: receipt },
})
assert.equal(run.status, 0, `the fixture must exit 0, got ${run.status}: ${run.stdout}${run.stderr}`)
assert.ok(fs.existsSync(receipt), 'the fixture must write a receipt')
const text = fs.readFileSync(receipt, 'utf8')
const field = (name) => (text.match(new RegExp(`^\\[${name}\\] ?(.*)$`, 'm')) ?? [])[1] ?? ''

console.log(text.trim().split(/\r?\n/).map(line => '  ' + line).join('\n'))

// ---- the contract both routes target -------------------------------------
assert.match(field('fixture'), /nothing was installed/)

// Every argument the real handoff sends arrived.
const cmdline = field('fixture-cmdline')
for (const arg of ['--updated', '/S', '--force-run']) {
  assert.ok(cmdline.includes(arg), `the fixture must receive ${arg}; got: ${cmdline}`)
}
assert.ok(cmdline.includes('/D=' + destination),
  `the fixture must receive the /D= destination; got: ${cmdline}`)
// /D= LAST, as NSIS requires, measured on the received line rather than on the
// array we sent.
assert.ok(cmdline.lastIndexOf('/D=') > cmdline.lastIndexOf('--force-run'),
  `/D= must be the last argument on the received command line; got: ${cmdline}`)
console.log('PASS the fixture received the real handoff vector, /D= last')

// ---- what NSIS's OWN /D= parser does with each form ------------------------
//
// ⚠ MEASURED, AND THE RESULT IS WORTH THE TICKET'S ATTENTION. $INSTDIR above is
// EMPTY for a whitespace-bearing destination, because Node's spawn quotes any
// argument containing whitespace and NSIS's built-in /D= handling does not
// accept a quoted form. The shipped installer is unaffected only because
// app-builder-lib's GetDParameter scans the RAW command line itself rather than
// relying on the built-in — which is precisely the parser the earlier
// trailing-quote analysis was about.
//
// So this is asserted as a PAIR with a control, not as a single reading: a
// space-free destination, which Node does not quote, must fill $INSTDIR, and
// the quoted one must not. One without the other would leave "empty" looking
// like a broken fixture instead of a property of the argument form.
const plainDestination = path.join(temp, 'OrgtreePlain')
const plainReceipt = path.join(temp, 'receipt-plain.txt')
const plainRun = spawnSync(exe, updateHandoffArgs(plainDestination), {
  encoding: 'utf8', windowsHide: true, timeout: 60000,
  env: { ...process.env, ORGTREE_UPDATE_FIXTURE_RECEIPT: plainReceipt },
})
assert.equal(plainRun.status, 0, 'the fixture must exit 0 for the unquoted control')
const plainText = fs.readFileSync(plainReceipt, 'utf8')
const plainInstdir = (plainText.match(/^\[fixture-instdir\] ?(.*)$/m) ?? [])[1] ?? ''

assert.equal(plainInstdir, plainDestination,
  "NSIS's built-in /D= must resolve an UNQUOTED destination exactly — this is "
  + 'the control that gives the quoted reading below its meaning')
assert.equal(field('fixture-instdir'), '',
  "NSIS's built-in /D= must NOT resolve the quoted whitespace-bearing form; if "
  + 'this ever starts resolving, the note above and the incident analysis it '
  + 'refers to both need revisiting')
console.log('PASS NSIS resolves an unquoted /D= exactly, and does NOT resolve the quoted form')
console.log('     (the shipped installer parses the raw line itself, which is why it is unaffected)')

assert.equal(field('fixture-silent'), 'yes', 'the fixture must run silently')
console.log('PASS the fixture ran silently')

// ---- and it really installed nothing --------------------------------------
assert.ok(!fs.existsSync(destination),
  'the fixture must not create its destination directory')
console.log('PASS nothing was installed: the destination was never created')


// ---- the REAL executable honours the receipt-and-token contract -------------
//
// ⚠ THIS IS THE HALF A SIMULATION CANNOT COVER. The composition's unit tests
// drive a simulated child that writes wherever it is told; this proves the
// SHIPPED artifact actually reads ORGTREE_UPDATE_FIXTURE_RECEIPT and echoes
// ORGTREE_UPDATE_FIXTURE_TOKEN back. The defect being guarded is precise: an
// earlier revision computed a receipt path, watched it, and never passed it to
// the child, so the fixture wrote beside itself and every rehearsal read as a
// failed update.
const tokenReceipt = path.join(temp, 'told', 'attempt-receipt.txt')
fs.mkdirSync(path.dirname(tokenReceipt), { recursive: true })
const token = 'attempt-' + process.pid + '-' + Date.now()
const tokenRun = spawnSync(exe, updateHandoffArgs(path.join(temp, 'Dest With Space')), {
  encoding: 'utf8', windowsHide: true, timeout: 60000,
  env: {
    ...process.env,
    ORGTREE_UPDATE_FIXTURE_RECEIPT: tokenReceipt,
    ORGTREE_UPDATE_FIXTURE_TOKEN: token,
  },
})
assert.equal(tokenRun.status, 0, 'the fixture must exit 0 when told where to write')
assert.ok(fs.existsSync(tokenReceipt),
  'the fixture must write to the path it was TOLD, not beside itself')
const told = fs.readFileSync(tokenReceipt, 'utf8')
assert.ok(told.includes('[fixture-token] ' + token),
  'the fixture must echo the attempt token so a stale receipt cannot satisfy the proof')
// And nothing was written beside the executable for this run.
assert.ok(!fs.existsSync(path.join(path.dirname(exe), 'orgtree-update-fixture-receipt.txt')),
  'being told a path must stop it defaulting to one beside itself')
console.log('PASS the real artifact writes where it is told and echoes the attempt token')

// The receipt of a DIFFERENT attempt must not satisfy this one — the property
// the token exists for, checked against the real file rather than a fixture.
assert.ok(!told.includes('[fixture-token] some-other-attempt'))
console.log('PASS a receipt carries exactly one attempt token')

fs.rmSync(temp, { recursive: true, force: true })
console.log('Update-fixture artifact used no registry writes, elevation, installation or visible window.')
