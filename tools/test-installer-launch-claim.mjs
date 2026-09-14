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
import { spawnSync } from 'node:child_process'

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

// The resolver: with no claim path set, one is derived from the staged helper
// directory — BESIDE it, never inside it, because the helper deletes that
// directory as it exits and an ownership record cannot live in it.
const staged = path.join(temp, 'OrgtreeInstallerRelaunch-4242')
const derived = runInstallerClaim({ name: 'derived-claim', claim: '', dir: staged })
assert.equal(derived.claim, `${staged}.launch-claim`,
  'the claim must be derived beside the staged directory, not inside it')
assert.equal(derived.owned, '1', 'the derived claim must be usable')
console.log('PASS the claim path is derived beside the staged helper directory')

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

  // And the reverse: the helper owns it, the installer's Finish action loses.
  const helperHeld = path.join(temp, 'helper-held.launch-claim')
  const helperWins = runHelper('helper-wins', helperHeld)
  assert.ok(fs.existsSync(helperHeld), 'the helper must leave its claim behind')
  assert.equal(helperWins.status, 4,
    'this helper owns the launch and then times out waiting, which is the expected exit for a live installer')
  assert.ok(helperWins.ready, 'a helper that holds handle and ownership must acknowledge')
  const installerLoses = runInstallerClaim({ name: 'installer-loses', claim: helperHeld })
  assert.equal(installerLoses.owned, 'other',
    'the installer must see the helper\'s claim and hand the launch to it rather than starting a second copy')
  console.log('PASS the installer loses a helper-held claim and defers to it')

  assert.ok(!fs.existsSync(launchMarker),
    'nothing in this harness may have started the stand-in application: every helper here either lost or timed out')
}

fs.rmSync(temp, { recursive: true, force: true })
console.log('\nALL PASS — one atomic claim, one winner, and an unmakeable claim refuses rather than launches')
