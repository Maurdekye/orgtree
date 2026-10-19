// Actual NSIS Finish + exclusive-claim functions, in an isolated executable.
// No install section, registry write, task operation, real app or live data.
// Only the UAC observation and Explorer dispatch boundary are controlled.
// Native Exec/CreateFileW run for real against a delayed, marker-only GUI probe.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {spawnSync} from 'node:child_process'

const repo = path.resolve(import.meta.dirname, '..')
const output = process.env.ORGTREE_FINISH_TEST_OUTPUT
assert.ok(output && path.isAbsolute(output), 'explicit disposable test output is required')
assert.match(output.replaceAll('\\', '/'), /^C:\/orgtree-build\/[^/]+\//i)
assert.equal(fs.existsSync(output), false, 'never overwrite prior test evidence')
fs.mkdirSync(output, {recursive: true})
const compiler = process.env.ORGTREE_MAKENSIS || path.join(process.env.LOCALAPPDATA || '',
  'electron-builder/Cache/nsis-3.0.4.1/nsis-3.0.4.1-1mx3n/makensis.exe')
assert.equal(fs.existsSync(compiler), true, 'NSIS compiler must already be provisioned; do not install one')
const source = fs.readFileSync(path.join(repo, 'build/installer.nsh'), 'utf8')
const extract = name => {
  const found = source.match(new RegExp(`^    Function ${name}\\r?\\n[\\s\\S]*?^    FunctionEnd`, 'm'))
  assert.ok(found, `production function ${name} must exist`)
  return found[0]
}
const functions = ['orgtreeFinishPageRun', 'orgtreeClaimUpgradeLaunch',
  'orgtreeResolveUpgradeLaunchClaim'].map(extract).join('\n')
const probeExe = path.join(output, 'delayed GUI probe.exe')
const launchMarker = path.join(output, 'probe-launched.txt')
const receipts = []
function run(exe, args, label) {
  const began = Date.now()
  const child = spawnSync(exe, args, {encoding: 'utf8', windowsHide: true, timeout: 20000})
  const receipt = {label, status: child.status, signal: child.signal,
    error: child.error?.message ?? null, ms: Date.now() - began}
  receipts.push(receipt)
  fs.writeFileSync(path.join(output, label + '.log'), (child.stdout || '') + (child.stderr || ''))
  fs.writeFileSync(path.join(output, 'processes.json'), JSON.stringify(receipts, null, 2))
  assert.equal(child.error, undefined, label + ' spawn/timeout must succeed')
  assert.equal(child.signal, null, label + ' must exit normally')
  assert.equal(child.status, 0, label + ': ' + child.stdout + child.stderr)
}
function compile(name, text) {
  const file = path.join(output, name + '.nsi')
  fs.writeFileSync(file, text)
  run(compiler, ['/V2', file], name + '-compile')
  return path.join(output, name + '.exe')
}
compile('delayed GUI probe', `Unicode true
Name "Synthetic delayed GUI probe"
OutFile "${probeExe}"
RequestExecutionLevel user
SilentInstall silent
Section
  # Startup is deliberately later than CreateProcess's return. Setup must
  # report dispatch, never wait for app readiness or launch a second copy.
  Sleep 400
  System::Call 'kernel32::GetCurrentProcessId() i .r0'
  FileOpen $1 "${launchMarker}" a
  FileWrite $1 "$0$\\r$\\n"
  FileClose $1
SectionEnd
`)

function fixture(name, {elevated = false, shell = 'ok', claim = 'new', missing = false} = {}) {
  const marker = path.join(output, name + '-result.txt')
  const claimPath = path.join(output, name + '.launch-claim')
  if (claim === 'other') fs.writeFileSync(claimPath, 'synthetic competing owner')
  const blockedParent = path.join(output, name + '-regular-file')
  if (claim === 'unavailable') fs.writeFileSync(blockedParent, 'not a directory')
  const claimValue = claim === 'unavailable' ? path.join(blockedParent, 'claim') : claimPath
  const target = missing ? path.join(output, 'absent probe.exe') : probeExe
  const exe = compile(name, `Unicode true
!include LogicLib.nsh
Name "Synthetic Orgtree Finish launch control"
OutFile "${path.join(output, name + '.exe')}"
RequestExecutionLevel user
SilentInstall silent
!define APP_EXECUTABLE_FILENAME "delayed GUI probe.exe"
Var OrgUpgradeExe
Var OrgUpgradeRelaunchClaim
Var OrgUpgradeLaunchOwned
Var OrgUpgradeRelaunchAcknowledged
Var FixtureShellCalls
Var FixtureStage
Var FixtureDetail
!macro _Fixture_IsAdmin _a _b _t _f
  StrCmp "${elevated ? '1' : '0'}" "1" \`\${_t}\` \`\${_f}\`
!macroend
!define UAC_IsAdmin \`"" Fixture_IsAdmin ""\`
!macro _Fixture_ExecShellAsUser result exe verb args
  IntOp $FixtureShellCalls $FixtureShellCalls + 1
  # A busy Explorer dispatch refuses without ever creating a process. No
  # real Explorer, elevation, or original-user token is used by this fixture.
  StrCpy \${result} "${shell}"
!macroend
!define StdUtils.ExecShellAsUser '!insertmacro _Fixture_ExecShellAsUser'
!macro OrgLog stage detail
  StrCpy $FixtureStage "\${stage}"
  StrCpy $FixtureDetail "\${detail}"
!macroend
${functions}
Section
  StrCpy $FixtureShellCalls "0"
  StrCpy $INSTDIR "${output}"
  StrCpy $OrgUpgradeExe "${target}"
  StrCpy $OrgUpgradeRelaunchClaim "${claimValue}"
  StrCpy $OrgUpgradeRelaunchAcknowledged "0"
  Call orgtreeFinishPageRun
  FileOpen $R0 "${marker}" w
  FileWrite $R0 "$FixtureStage|$FixtureShellCalls|$OrgUpgradeLaunchOwned|$FixtureDetail$\\r$\\n"
  FileClose $R0
SectionEnd
`)
  run(exe, ['/S'], name + '-run')
  const [stage, calls, owned, detail] = fs.readFileSync(marker, 'utf8').trim().split('|')
  return {stage, shellCalls: Number(calls), owned, detail}
}

test('unelevated fresh Finish launches once despite a busy Explorer', async () => {
  const result = fixture('fresh-busy-shell', {shell: 'error'})
  assert.equal(result.stage, 'finish-run', result.detail)
  assert.equal(result.shellCalls, 0, 'already unelevated Setup needs no Explorer dispatch')
  assert.equal(result.owned, '1')
  const deadline = Date.now() + 10000
  while (!fs.existsSync(launchMarker) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25))
  assert.equal(fs.existsSync(launchMarker), true, 'the actual GUI probe must reach its delayed startup')
  const pids = fs.readFileSync(launchMarker, 'utf8').trim().split(/\r?\n/)
  assert.equal(pids.length, 1, 'exactly one native launch')
  const pid = Number(pids[0])
  assert.ok(pid > 0)
  const exitDeadline = Date.now() + 5000
  for (;;) {
    let alive = false
    try { process.kill(pid, 0); alive = true } catch { /* probe exited */ }
    if (!alive) break
    assert.ok(Date.now() < exitDeadline, 'synthetic GUI probe must exit before the phase ends')
    await new Promise(resolve => setTimeout(resolve, 25))
  }
})

for (const token of ['ok', 'fallback']) test(`elevated Finish retains original-user shell dispatch (${token})`, () => {
  const result = fixture('elevated-' + token, {elevated: true, shell: token})
  assert.equal(result.shellCalls, 1)
  assert.equal(result.stage, 'finish-run')
})

test('ambiguous elevated shell failure is never retried with Setup privileges', () => {
  const result = fixture('elevated-failure', {elevated: true, shell: 'error'})
  assert.equal(result.shellCalls, 1)
  assert.equal(result.stage, 'finish-run-failed')
})

test('another launch owner excludes both native and shell dispatch', () => {
  const result = fixture('already-claimed', {claim: 'other'})
  assert.equal(result.owned, 'other')
  assert.equal(result.shellCalls, 0)
  assert.equal(result.stage, 'finish-run-owner-unknown')
})

test('unavailable claim refuses rather than guessing it owns the launch', () => {
  const result = fixture('claim-unavailable', {claim: 'unavailable'})
  assert.equal(result.owned, '')
  assert.equal(result.shellCalls, 0)
  assert.equal(result.stage, 'finish-run-unclaimable')
})

test('failed native creation remains visible and never becomes a shell retry', () => {
  const result = fixture('native-missing', {missing: true, shell: 'error'})
  assert.equal(result.shellCalls, 0)
  assert.equal(result.stage, 'finish-run-failed')
})
