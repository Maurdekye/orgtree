// Compile and RUN the repository's real customInstallMode macro against a
// controllable UAC stub, and check what it actually did.
//
// This exists because of the 2.1.3-RC4 field failure. Setup closed Orgtree,
// then called UAC_RunElevated from inside an install section: that starts a
// second complete wizard and blocks the first, and because the first window
// was never hidden the user was left with an "Installing" page frozen at 3%
// and a second Setup window behind it. Nothing was written and it never
// recovered.
//
// Source assertions can show that the elevation MOVED. Only running it can
// show what happens on each outcome, and the outcome that matters most is the
// unhappy one: when elevation is declined or fails, the upgrade must stop
// rather than carry on without the rights it needs to replace files.
//
// Nothing here installs, elevates, writes a registry key, starts an
// application or touches any real installation. The UAC surface is a stub and
// the only side effect is a text file in a temporary directory.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const root = path.resolve(import.meta.dirname, '..')
const source = fs.readFileSync(path.join(root, 'build/installer.nsh'), 'utf8')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-installer-elevation-'))
const compiler = path.resolve(process.env.ORGTREE_MAKENSIS || path.join(
  process.env.LOCALAPPDATA || '',
  'electron-builder/Cache/nsis-3.0.4.1/nsis-3.0.4.1-1mx3n/makensis.exe'))
const mui = path.join(path.dirname(compiler), 'Contrib', 'Modern UI 2', 'MUI2.nsh')

if (!fs.existsSync(compiler)) throw new Error('INERT: NSIS compiler unavailable; set ORGTREE_MAKENSIS')

function macro(name) {
  const match = source.match(new RegExp(`!macro ${name}\\r?\\n[\\s\\S]*?\\r?\\n!macroend`))
  assert.ok(match, `${name} macro must exist`)
  return match[0]
}

const vars = source.split(/\r?\n/).filter(line => /^Var (OrgUpgrade|OrgtreeUpgrade)/.test(line)).join('\n')
const installMode = macro('customInstallMode')

// `admin` decides what ${UAC_IsAdmin} answers; `code`/`instance` are the $0/$1
// the UAC plugin would return. Each run records the steps it reached.
function run(label, { admin, code, instance }) {
  const log = path.join(temp, `${label}.log`)
  const nsi = `!include LogicLib.nsh
!include "${mui}"
Name "Orgtree elevation fixture"
OutFile "${path.join(temp, `${label}.exe`)}"
RequestExecutionLevel user
SilentInstall silent
!define APP_EXECUTABLE_FILENAME "Orgtree.exe"
!define FIXTURE_LOG "${log.replace(/\\/g, '\\\\')}"
${vars}
Var installMode
!macro FixtureNote text
  FileOpen $R9 "\${FIXTURE_LOG}" a
  FileSeek $R9 0 END
  FileWrite $R9 "\${text}$\\r$\\n"
  FileClose $R9
!macroend
# The UAC surface electron-builder would supply, under this run's control.
!macro _UAC_IsAdmin _a _b _t _f
  StrCmp "${admin}" "1" \`\${_t}\` \`\${_f}\`
!macroend
!define UAC_IsAdmin \`"" UAC_IsAdmin ""\`
!macro UAC_RunElevated
  !insertmacro FixtureNote "ELEVATION_REQUESTED"
  StrCpy $0 "${code}"
  StrCpy $1 "${instance}"
!macroend
# Reaching either of these means the upgrade PROCEEDED with this scope.
!macro setInstallModePerAllUsers
  !insertmacro FixtureNote "PROCEEDED_ALL_USERS"
  StrCpy $installMode all
!macroend
!macro setInstallModePerUser
  !insertmacro FixtureNote "PROCEEDED_CURRENT_USER"
  StrCpy $installMode CurrentUser
!macroend
${installMode}
Function .onInit
  !insertmacro FixtureNote "START"
  StrCpy $OrgUpgradeSelected "1"
  StrCpy $OrgUpgradeInstallMode "all"
  StrCpy $OrgUpgradeInstallDir "$TEMP\\\\Orgtree fixture"
  !insertmacro customInstallMode
  !insertmacro FixtureNote "FELL_THROUGH"
FunctionEnd
Section
SectionEnd
`
  const file = path.join(temp, `${label}.nsi`)
  fs.writeFileSync(file, nsi)
  const compiled = spawnSync(compiler, ['/V1', file], { encoding: 'utf8', windowsHide: true, timeout: 20000 })
  assert.equal(compiled.status, 0, `${label} did not compile: ${compiled.stdout}${compiled.stderr}`)
  spawnSync(path.join(temp, `${label}.exe`), ['/S'], { encoding: 'utf8', windowsHide: true, timeout: 20000 })
  const steps = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split(/\r?\n/).filter(Boolean) : []
  assert.ok(steps.includes('START'), `${label} never ran`)
  return steps
}

// Already elevated: no prompt, and the upgrade proceeds with the recorded
// all-users scope. The ordinary path must not have become more expensive.
const asAdmin = run('admin', { admin: 1, code: 0, instance: 2 })
assert.ok(!asAdmin.includes('ELEVATION_REQUESTED'), 'an already-elevated Setup must not elevate again')
assert.ok(asAdmin.includes('PROCEEDED_ALL_USERS'), 'an already-elevated all-users upgrade must proceed')
console.log('PASS admin proceeds without elevating')

// Not elevated, and an elevated instance took over ($0=0, $1=1). This process
// is only the wrapper: it must elevate and then stop, never also install.
const wrapper = run('wrapper', { admin: 0, code: 0, instance: 1 })
assert.ok(wrapper.includes('ELEVATION_REQUESTED'), 'an unelevated all-users upgrade must elevate')
assert.ok(!wrapper.includes('PROCEEDED_ALL_USERS'), 'the outer instance must not install as well as its elevated child')
assert.ok(!wrapper.includes('FELL_THROUGH'), 'the outer instance must quit once its child has run')
console.log('PASS the outer instance elevates and then stops')

// THE SAFETY PROPERTY. The user declined the prompt (1223). Setup must not
// continue: without admin it cannot replace files in a per-machine
// installation, and continuing only moves the failure to the middle of the
// copy. Mutate customInstallMode to Abort instead of Quit here and this fails.
const declined = run('declined', { admin: 0, code: 1223, instance: 0 })
assert.ok(declined.includes('ELEVATION_REQUESTED'), 'a declined run must still have asked')
assert.ok(!declined.includes('PROCEEDED_ALL_USERS'), 'a declined elevation must never proceed unelevated')
assert.ok(!declined.includes('FELL_THROUGH'), 'a declined elevation must stop, not fall through to the install')
console.log('PASS a declined elevation never proceeds unelevated')

// And an outright plugin failure is treated the same way as a refusal.
const failed = run('failed', { admin: 0, code: 5, instance: 0 })
assert.ok(failed.includes('ELEVATION_REQUESTED'))
assert.ok(!failed.includes('PROCEEDED_ALL_USERS'), 'a failed elevation must never proceed unelevated')
console.log('PASS a failed elevation never proceeds unelevated')

fs.rmSync(temp, { recursive: true, force: true })
console.log('NSIS elevation fixture used no installation, registry writes, real elevation or live-data changes.')
