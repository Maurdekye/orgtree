// Do the installer and the relaunch helper really share ONE atomic launch
// claim, and does the loser really lose?
//
// Exactly one party may start the application after an upgrade: the helper, or
// the installer's own Finish page Run action. The previous design had the
// installer write a "withdrawn" flag that the helper read before launching —
// check-then-act, with a window between the read and the launch, and a failure
// mode where an unreadable flag was treated as permission to launch anyway and
// the application's single-instance lock was expected to collapse the
// duplicate. That is a false success: it reports a clean relaunch while having
// no idea whether it caused a second one.
//
// The replacement is a file that cannot be created twice: CreateFileW with
// CREATE_NEW on the NSIS side, O_CREAT | O_EXCL on the Python side, against the
// same path. This harness runs BOTH sides against ONE claim and requires that
// the winner is decided once, that the loser launches nothing, and that a claim
// which cannot be made at all is a refusal rather than a licence.
//
// It compiles the REAL functions out of build/installer.nsh, because the point
// is the actual Win32 call and its actual error codes; a stub cannot tell
// ERROR_FILE_EXISTS from "could not do it".
//
// The fixture installs nothing: SilentInstall silent, RequestExecutionLevel
// user, one section that writes marker lines to a temp file, no UAC, no window.
//
// Run it directly: node tools/test-installer-launch-claim.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'

const root = path.resolve(import.meta.dirname, '..')
const source = fs.readFileSync(path.join(root, 'build/installer.nsh'), 'utf8')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-launch-claim-'))
const compiler = process.env.ORGTREE_MAKENSIS || path.join(
  process.env.LOCALAPPDATA || '',
  'electron-builder/Cache/nsis-3.0.4.1/nsis-3.0.4.1-1mx3n/makensis.exe')
const compilerPath = path.resolve(compiler)

if (!fs.existsSync(compilerPath)) throw new Error('INERT: NSIS compiler unavailable; set ORGTREE_MAKENSIS')

const engineRuntime = [process.env.ORGTREE_ENGINE_RUNTIME, path.join(root, 'engine', 'runtime')]
  .filter(Boolean)
  .find(candidate => fs.existsSync(path.join(candidate, 'pythonw.exe')))

function nsisFunction(name) {
  // The functions live INSIDE customFinishPage, so both the header and the
  // FunctionEnd are indented; anchoring on a column-zero FunctionEnd finds
  // nothing and would quietly take the rest of the file instead.
  const match = source.match(new RegExp(`Function ${name}\\r?\\n[\\s\\S]*?\\r?\\n\\s*FunctionEnd`))
  assert.ok(match, `${name} must exist in build/installer.nsh`)
  return match[0]
}

const claimFunction = nsisFunction('orgtreeClaimUpgradeLaunch')
const resolveFunction = nsisFunction('orgtreeResolveUpgradeLaunchClaim')
const vars = source.split(/\r?\n/).filter(line => /^Var (OrgUpgrade|OrgtreeUpgrade)/.test(line)).join('\n')

// `claim` is the ownership path the fixture is told to claim; `dir` is what
// $OrgUpgradeRelaunchDir holds, so the resolver can be exercised too.
function fixture({ name, claim, dir = '' }) {
  const marker = path.join(temp, `${name}.txt`)
  const executable = path.join(temp, `${name}.exe`)
  return {
    marker,
    executable,
    nsi: `Unicode true
!include LogicLib.nsh
Name "Orgtree launch claim fixture"
OutFile "${executable}"
RequestExecutionLevel user
SilentInstall silent

${vars}

# Logging is not what is being measured; keep it inert so a log failure cannot
# masquerade as an ownership result.
!macro OrgLog stage detail
!macroend

${resolveFunction}

${claimFunction}

Section
  StrCpy $OrgUpgradeRelaunchDir "${dir}"
  StrCpy $OrgUpgradeRelaunchClaim "${claim}"
  Call orgtreeClaimUpgradeLaunch
  FileOpen $R9 "${marker}" w
  FileWrite $R9 "OWNED=[$OrgUpgradeLaunchOwned]$\\r$\\n"
  FileWrite $R9 "CLAIM=[$OrgUpgradeRelaunchClaim]$\\r$\\n"
  FileClose $R9
SectionEnd
`,
  }
}

function runInstallerClaim(spec) {
  const { marker, executable, nsi } = fixture(spec)
  const file = path.join(temp, `${spec.name}.nsi`)
  fs.writeFileSync(file, nsi)
  const compiled = spawnSync(compilerPath, ['/V1', file], { encoding: 'utf8', windowsHide: true, timeout: 30000 })
  assert.equal(compiled.status, 0, `${spec.name} failed to COMPILE:\n${compiled.stdout}${compiled.stderr}`)
  const ran = spawnSync(executable, ['/S'], { encoding: 'utf8', windowsHide: true, timeout: 30000 })
  assert.equal(ran.status, 0, `${spec.name} exited ${ran.status}`)
  const text = fs.readFileSync(marker, 'utf8')
  const field = key => text.match(new RegExp(`^${key}=\\[(.*)\\]$`, 'm'))?.[1] ?? null
  const owned = field('OWNED')
  console.log('  installer %s → owned %j, claim %j', spec.name, owned, field('CLAIM'))
  return { owned, claim: field('CLAIM') }
}

// ---------------------------------------------------------------------------
// THE PRIMITIVE, from the installer's side.
const fresh = path.join(temp, 'fresh.launch-claim')
const first = runInstallerClaim({ name: 'first-claim', claim: fresh })
assert.equal(first.owned, '1', 'the first claimant must own the launch')
assert.ok(fs.existsSync(fresh), 'owning the launch must leave the claim behind for the other party to find')
console.log('PASS the first claimant owns the launch')

const second = runInstallerClaim({ name: 'second-claim', claim: fresh })
assert.equal(second.owned, 'other',
  'the second claimant must be told the launch is owned elsewhere, not allowed to take it')
console.log('PASS a second claim on the same path loses')

// UNCLAIMABLE: a path inside a directory that does not exist. This is the case
// the decision turns on — it must be neither ownership nor a licence to launch.
const impossible = path.join(temp, 'no-such-directory', 'x.launch-claim')
const unclaimable = runInstallerClaim({ name: 'unclaimable', claim: impossible })
assert.equal(unclaimable.owned, '',
  'a claim that cannot be made must answer "no ownership", which is what stops the launch')
console.log('PASS an impossible claim is a refusal, not ownership')

// THE IDENTITY, which is where the PID-reuse defect lived. The claim file
// outlives the run that made it, so a name derived from the installer's process
// id alone can be resolved again by a completely unrelated later install —
// which would find a claim whose owner died weeks ago and permanently refuse to
// start the application it had just installed. Windows reuses process ids, so
// this is not hypothetical.
//
// Both of these fixtures are given the SAME staged directory, which is what a
// reused process id would produce, and they must still come out with different
// identities.
const staged = path.join(temp, 'OrgtreeInstallerRelaunch-4242')
const firstRun = runInstallerClaim({ name: 'identity-first', claim: '', dir: staged })
const secondRun = runInstallerClaim({ name: 'identity-second', claim: '', dir: staged })
assert.equal(firstRun.owned, '1', 'an allocated identity must be usable')
assert.equal(secondRun.owned, '1',
  'a later invocation must NOT be blocked by an older claim: that is the process-id reuse defect')
assert.notEqual(firstRun.claim, secondRun.claim,
  'two invocations must not share a launch identity, however their process ids fall')
assert.doesNotMatch(firstRun.claim, /OrgtreeInstallerRelaunch-4242\.launch-claim$/,
  'the identity must not be derived from the staged directory (i.e. from the process id) alone')
for (const allocated of [firstRun.claim, secondRun.claim]) {
  assert.match(allocated, /OrgtreeInstallerRelaunch-.+\.launch-claim$/,
    'an allocated claim must still be recognisable as this installer\'s, in the temp directory beside its staged helper')
  assert.ok(path.isAbsolute(allocated), 'the claim path must be absolute')
  // Allocated in the real temp directory rather than this harness's, so clean
  // up after the fixtures that made them — but only ever these two.
  fs.rmSync(allocated, { force: true })
}
console.log('PASS each invocation allocates its own launch identity, so a reused process id cannot block a later update')

// And an identity that has already been allocated is INHERITED, not replaced —
// this is what the elevated inner instance receives in preInit, and re-deriving
// it there would give one update two identities and therefore two owners.
const inherited = path.join(temp, 'inherited.launch-claim')
const kept = runInstallerClaim({ name: 'identity-inherited', claim: inherited, dir: staged })
assert.equal(kept.claim, inherited, 'an identity that is already set must be kept, not re-derived')
console.log('PASS an inherited launch identity is kept rather than re-derived')

// ---------------------------------------------------------------------------
// BOTH SIDES, ONE CLAIM. This is the part a single-language test cannot show:
// the helper and the installer must be using the same primitive on the same
// file, or the "exactly once" property is two separate stories.
if (!engineRuntime) {
  console.log('SKIP cross-process cases: no provisioned engine runtime; set ORGTREE_ENGINE_RUNTIME')
} else {
  const helper = path.join(root, 'tools/installer-relaunch.py')
  const pythonw = path.join(engineRuntime, 'pythonw.exe')
  const launchMarker = path.join(temp, 'helper-launched.txt')
  const target = path.join(temp, 'fake application.cmd')
  fs.writeFileSync(target, `@echo launched>>"${launchMarker}"\r\n@exit 0\r\n`)

  function runHelper(name, claim) {
    const staging = fs.mkdtempSync(path.join(temp, `${name}-`))
    const script = path.join(staging, 'installer-relaunch.py')
    fs.copyFileSync(helper, script)
    // Process id 4 is the System process. It is deliberately NOT used here:
    // this case is about ownership, so the helper is given its own process id,
    // which it can always open a handle on and which never exits — the wait is
    // cut short by a tiny timeout instead. Ownership is decided before the wait.
    // The ready marker is deliberately kept OUTSIDE the staged directory here:
    // the helper removes that directory as it exits, which would take the
    // marker with it and leave this harness unable to tell "never acknowledged"
    // from "acknowledged and then cleaned up". In production the installer
    // reads the marker while the helper is still waiting, which the behavioural
    // sections in tests/installer-upgrade.test.mjs exercise.
    const ready = path.join(temp, `${name}-ready.txt`)
    const ran = spawnSync(pythonw, [script, String(process.pid), target, ready, claim], {
      windowsHide: true, encoding: 'utf8', timeout: 60000,
      env: { ...process.env, ORGTREE_RELAUNCH_LOG_DIR: temp, ORGTREE_RELAUNCH_TIMEOUT_MS: '300' },
    })
    console.log('  helper %s → exit %s', name, ran.status)
    return { status: ran.status, ready: fs.existsSync(ready) }
  }

  // The installer owns it; the helper must lose and start nothing.
  const contested = path.join(temp, 'contested.launch-claim')
  const installerOwns = runInstallerClaim({ name: 'installer-first', claim: contested })
  assert.equal(installerOwns.owned, '1', 'the installer must have taken the contested claim')
  const helperLoses = runHelper('helper-loses', contested)
  assert.equal(helperLoses.status, 6, 'the helper must report that the launch was owned elsewhere')
  assert.ok(!helperLoses.ready,
    'a helper that lost the claim must NOT acknowledge: the acknowledgement is what closes the user\'s Finish page')
  assert.ok(!fs.existsSync(launchMarker), 'the losing helper must not start the application')
  console.log('PASS the helper loses an installer-held claim, launches nothing, and does not acknowledge')

  // And the reverse: a LIVE helper owns it and the installer's Finish action
  // must lose. The helper is left running for this one — a helper that has
  // already exited is a different case, and conflating the two is exactly the
  // "reservation with no live owner" confusion this round is about.
  const helperHeld = path.join(temp, 'helper-held.launch-claim')
  const heldStaging = fs.mkdtempSync(path.join(temp, 'helper-holds-'))
  const heldScript = path.join(heldStaging, 'installer-relaunch.py')
  fs.copyFileSync(helper, heldScript)
  const heldReady = path.join(temp, 'helper-holds-ready.txt')
  const holder = spawn(pythonw, [heldScript, String(process.pid), target, heldReady, helperHeld], {
    windowsHide: true, stdio: 'ignore',
    env: { ...process.env, ORGTREE_RELAUNCH_LOG_DIR: temp, ORGTREE_RELAUNCH_TIMEOUT_MS: '30000' },
  })
  try {
    const deadline = Date.now() + 20000
    while (!fs.existsSync(heldReady) && Date.now() < deadline) spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},50)'])
    assert.ok(fs.existsSync(heldReady), 'the holding helper never acknowledged, so this case never got set up')
    assert.ok(fs.existsSync(helperHeld), 'the holding helper must be holding its claim while it waits')
    const installerLoses = runInstallerClaim({ name: 'installer-loses', claim: helperHeld })
    assert.equal(installerLoses.owned, 'other',
      'the installer must see the live helper\'s claim and hand the launch to it rather than starting a second copy')
    console.log('PASS the installer loses a live helper-held claim and defers to it')
  } finally {
    holder.kill()
  }

  // A HELPER THAT GIVES UP MUST GIVE THE LAUNCH BACK. Owning the launch and
  // performing it are different things: this one claims, then times out
  // waiting, and a claim left behind by it would be a reservation with no live
  // owner — which the Finish page would otherwise read as "something else is
  // about to start the application" and tell the user so.
  const abandoned = path.join(temp, 'abandoned.launch-claim')
  const gaveUp = runHelper('helper-gives-up', abandoned)
  assert.equal(gaveUp.status, 4, 'this helper owns the launch and then times out waiting')
  assert.ok(!fs.existsSync(abandoned),
    'a helper that ended without launching must release its claim, or it leaves a reservation nobody will honour')
  const afterRelease = runInstallerClaim({ name: 'after-release', claim: abandoned })
  assert.equal(afterRelease.owned, '1',
    'once the claim is released the installer must be able to take it and actually start the application')
  console.log('PASS a helper that gives up releases the launch, and the installer can then take it')

  // A KILLED owner cannot release anything, which is the stale claim the Finish
  // page has to survive. The file is still there and nothing may assume a
  // launch is coming from it; the installer's own claim then answers "other"
  // and the page reports unknown ownership rather than promising a start.
  assert.ok(fs.existsSync(helperHeld),
    'a killed owner leaves its claim behind: this is the stale-claim state the Finish page must report as unknown')
  const stale = runInstallerClaim({ name: 'stale-claim', claim: helperHeld })
  assert.equal(stale.owned, 'other',
    'a stale claim must still be refused rather than stolen; the truthful message is the Finish page\'s job')
  console.log('PASS a stale claim from a killed owner is refused, not stolen')

  assert.ok(!fs.existsSync(launchMarker),
    'nothing in this harness may have started the stand-in application: every helper here either lost or timed out')
}

fs.rmSync(temp, { recursive: true, force: true })
console.log('\nALL PASS — one atomic claim, one winner, and an unmakeable claim refuses rather than launches')
