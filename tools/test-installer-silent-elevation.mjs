// Does the SILENT --updated path actually reach an elevation decision?
//
// This is the question that stranded 2.1.3 clients: a silent all-users update
// never elevated, the boot preflight refused, and every retry took the identical
// route. A source-shape assertion cannot answer it, because the whole defect was
// that a correct-looking elevation block sat somewhere silence never executes.
//
// So this harness compiles the REAL customInit macro out of build/installer.nsh
// into an isolated fixture and RUNS it silently, with UAC_RunElevated stubbed to
// drop a marker instead of elevating. The marker is the answer: it exists only
// if the elevation decision was genuinely reached under `SetSilent silent`.
//
// The fixture installs nothing. Its only Section writes a marker line, it is
// compiled with SilentInstall silent and RequestExecutionLevel user, and every
// UAC macro is a stub — so it cannot elevate, cannot prompt, and cannot show a
// window. It is not an installer and must never become one.
//
// Run it directly: node tools/test-installer-silent-elevation.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const root = path.resolve(import.meta.dirname, '..')
const source = fs.readFileSync(path.join(root, 'build/installer.nsh'), 'utf8')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-silent-elevation-'))
const compiler = process.env.ORGTREE_MAKENSIS || path.join(
  process.env.LOCALAPPDATA || '',
  'electron-builder/Cache/nsis-3.0.4.1/nsis-3.0.4.1-1mx3n/makensis.exe')
const compilerPath = path.resolve(compiler)

if (!fs.existsSync(compilerPath)) throw new Error('INERT: NSIS compiler unavailable; set ORGTREE_MAKENSIS')

function macro(name) {
  const match = source.match(new RegExp(`!macro ${name}\\r?\\n[\\s\\S]*?\\r?\\n!macroend`))
  assert.ok(match, `${name} macro must exist`)
  return match[0]
}

const customInit = macro('customInit')
const vars = source.split(/\r?\n/).filter(line => /^Var (OrgUpgrade|OrgtreeUpgrade)/.test(line)).join('\n')

// `updated` decides whether ${orgtreeOriginalIsUpdated} is true, i.e. whether
// this run is the auto-updater's --updated entry point or a manual one.
// `admin`, `inner` and `mode` are the matrix cell being exercised.
function fixture({ name, body, updated = true, admin = false, inner = false, mode = 'all' }) {
  const marker = path.join(temp, `${name}.txt`)
  const executable = path.join(temp, `${name}.exe`)
  const bool = value => (value ? '"1" "1"' : '"0" "1"')
  return {
    marker,
    executable,
    nsi: `Unicode true
!include LogicLib.nsh
!include WinMessages.nsh
Name "Orgtree silent elevation fixture"
OutFile "${executable}"
RequestExecutionLevel user
SilentInstall silent
!define PRODUCT_NAME "Orgtree"
!define INSTALL_REGISTRY_KEY "Software\\com.maurdekye.orgtree\\fixture"
!define UNINSTALL_REGISTRY_KEY "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{fixture}"

# --updated entry point, or not. LogicLib prepends the underscore itself, so the
# define names isUpdated and the macro is _isUpdated; writing "_isUpdated" in the
# define makes it look for __isUpdated and the compile fails.
!macro _isUpdated _a _b _t _f
  StrCmp ${bool(updated)} \`\${_t}\` \`\${_f}\`
!macroend
!define isUpdated \`"" isUpdated ""\`
!define orgtreeOriginalIsUpdated \`\${isUpdated}\`

# The UAC surface electron-builder supplies, stubbed so the fixture can never
# actually elevate or prompt. UAC_RunElevated records that it was REACHED, which
# is the entire measurement.
!macro _UAC_IsAdmin _a _b _t _f
  StrCmp ${bool(admin)} \`\${_t}\` \`\${_f}\`
!macroend
!define UAC_IsAdmin \`"" UAC_IsAdmin ""\`
!macro _UAC_IsInnerInstance _a _b _t _f
  StrCmp ${bool(inner)} \`\${_t}\` \`\${_f}\`
!macroend
!define UAC_IsInnerInstance \`"" UAC_IsInnerInstance ""\`
!macro UAC_RunElevated
  Call orgtreeFixtureRecordElevation
  # Answer the way an APPROVED elevation does, so the macro under test takes its
  # success branch and quits like the real one.
  StrCpy $0 "0"
  StrCpy $1 "1"
!macroend

${vars}
Var installMode
Var perMachineInstallationFolder
Var perUserInstallationFolder

!macro setInstallModePerAllUsers
  StrCpy $installMode all
!macroend
!macro setInstallModePerUser
  StrCpy $installMode CurrentUser
!macroend
# Logging is not what is being measured; keep it inert so a log failure cannot
# masquerade as a routing result.
!macro OrgLog stage detail
!macroend
!macro GetDParameter var
  StrCpy \`\${var}\` ""
!macroend

Function orgtreeFixtureRecordElevation
  FileOpen $R9 "${marker}" a
  FileSeek $R9 0 END
  FileWrite $R9 "ELEVATION_REACHED$\\r$\\n"
  FileClose $R9
FunctionEnd

${body}

Function .onInit
  StrCpy $installMode "${mode}"
  StrCpy $INSTDIR "$TEMP\\Orgtree fixture"
  !insertmacro customInit
FunctionEnd

Section
  # Reached only if customInit did NOT quit. On the real silent all-users path a
  # successful elevation quits the outer process, so this line NOT appearing is
  # itself part of the expected result.
  FileOpen $R9 "${marker}" a
  FileSeek $R9 0 END
  FileWrite $R9 "SECTION_RAN$\\r$\\n"
  FileClose $R9
SectionEnd
`,
  }
}

function run(spec) {
  const { marker, executable, nsi } = fixture(spec)
  const file = path.join(temp, `${spec.name}.nsi`)
  fs.writeFileSync(file, nsi)
  const compiled = spawnSync(compilerPath, ['/V1', file], { encoding: 'utf8', windowsHide: true, timeout: 30000 })
  assert.equal(compiled.status, 0, `${spec.name} failed to COMPILE:\n${compiled.stdout}${compiled.stderr}`)
  const ran = spawnSync(executable, ['/S'], { encoding: 'utf8', windowsHide: true, timeout: 30000 })
  const text = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : ''
  console.log('  %s → exit %s, reached %j', spec.name, ran.status, text.trim().split(/\r?\n/).join('+') || 'nothing')
  return { status: ran.status, elevated: text.includes('ELEVATION_REACHED'), section: text.includes('SECTION_RAN') }
}

// ---------------------------------------------------------------------------
// THE SUBJECT: silent --updated, all-users, unelevated. This is the cell that
// stranded real clients.
const subject = run({ name: 'silent-allusers-unelevated', body: customInit })
assert.ok(subject.elevated,
  'the silent all-users update did NOT reach an elevation decision — this is the stranded-client defect')
assert.ok(!subject.section,
  'an approved elevation must quit the outer process rather than continuing into the sections unelevated')
// THE EXIT CODE IS PART OF THE FIX, not a detail. Quitting from .onInit exits 2
// by default, and on the silent path that code is the auto-updater's only
// signal — a successful handoff reported as 2 reads as a failed update and
// invites a retry of an upgrade that already happened. Measured: before
// SetErrorLevel 0 was added this cell returned 2 while every other cell here
// returned 0.
assert.equal(subject.status, 0,
  `a SUCCESSFUL elevation handoff must exit 0, not ${subject.status} — the updater reads this as the result of the upgrade`)
console.log('PASS silent all-users update reaches elevation, hands off, and reports success')

// POSITIVE CONTROL. Put the decision back where it was — reachable only from a
// page callback, which silence skips — and the measurement must go red. Without
// this, a harness that could never detect the defect would report a pass.
const defective = customInit.replace(
  /\r?\n    # ELEVATE HERE FOR A SILENT ALL-USERS UPDATE[\s\S]*?\r?\n    !endif\r?\n    !endif\r?\n/,
  '\n')
assert.notEqual(defective, customInit, 'the control could not remove the elevation block; its anchor moved')
const control = run({ name: 'control-page-only-elevation', body: defective })
assert.ok(!control.elevated,
  'CONTROL IS BROKEN: elevation was still reached after the block was removed, so this harness cannot detect the defect')
assert.ok(control.section,
  'CONTROL IS BROKEN: without elevation the run must fall through into the sections, which is how it stranded clients')
console.log('PASS positive control: removing the block reproduces the unelevated fall-through')

// MATRIX CELLS that must NOT prompt.
const elevatedAlready = run({ name: 'silent-allusers-elevated', body: customInit, admin: true })
assert.ok(!elevatedAlready.elevated, 'an already-elevated silent update must not ask for elevation again')
assert.ok(elevatedAlready.section, 'an already-elevated silent update must carry on into the sections')
console.log('PASS already-elevated silent update proceeds without a prompt')

const perUser = run({ name: 'silent-peruser-unelevated', body: customInit, mode: 'CurrentUser' })
assert.ok(!perUser.elevated, 'a per-user install needs no elevation and must not ask for it')
assert.ok(perUser.section, 'a per-user silent update must carry on into the sections')
console.log('PASS per-user silent update needs no elevation')

const innerInstance = run({ name: 'silent-allusers-inner', body: customInit, inner: true })
assert.ok(!innerInstance.elevated, 'the elevated inner instance must never elevate again — that is an elevation loop')
console.log('PASS inner instance does not re-elevate')

const manual = run({ name: 'manual-allusers-unelevated', body: customInit, updated: false })
assert.ok(!manual.elevated,
  'a MANUAL run must not be elevated by this block; its pages and customInstallMode own that decision')
assert.ok(manual.section, 'a manual run must continue into its normal flow')
console.log('PASS manual run is untouched by the silent-path elevation')

fs.rmSync(temp, { recursive: true, force: true })
console.log('\nALL PASS — silent elevation reachability, with a control that fails when the block is removed')
