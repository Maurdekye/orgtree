// Compile the repository's upgrade-page/mode macros as an isolated NSIS
// fixture. This never writes a registry key, starts an app, or runs an
// installer section; it catches generated-script regressions at the macro
// boundary where electron-builder consumes build/installer.nsh.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const root = path.resolve(import.meta.dirname, '..')
const source = fs.readFileSync(path.join(root, 'build/installer.nsh'), 'utf8')
const helper = fs.readFileSync(path.join(root, 'tools/installer-upgrade.ps1'), 'utf8')
const appSource = fs.readFileSync(path.join(root, 'apps/desktop/main/index.ts'), 'utf8')
const controlSource = fs.readFileSync(path.join(root, 'apps/desktop/main/installer-upgrade.ts'), 'utf8')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-installer-upgrade-'))
const compiler = process.env.ORGTREE_MAKENSIS || path.join(
  process.env.LOCALAPPDATA || '',
  'electron-builder/Cache/nsis-3.0.4.1/nsis-3.0.4.1-1mx3n/makensis.exe')
const compilerPath = path.resolve(compiler)
const mui = path.join(path.dirname(compilerPath), 'Contrib', 'Modern UI 2', 'MUI2.nsh')

if (!fs.existsSync(compilerPath)) throw new Error('INERT: NSIS compiler unavailable; set ORGTREE_MAKENSIS')

function macro(name) {
  const match = source.match(new RegExp(`!macro ${name}\\r?\\n[\\s\\S]*?\\r?\\n!macroend`))
  assert.ok(match, `${name} macro must exist`)
  return match[0]
}

const vars = source.split(/\r?\n/).filter(line => /^Var (OrgUpgrade|OrgtreeUpgrade)/.test(line)).join('\n')
const functions = macro('orgtreeUpgradeFunctions')
const welcome = macro('customWelcomePage')
const installMode = macro('customInstallMode')
const nsi = `!include LogicLib.nsh
!include "${mui}"
Name "Orgtree upgrade fixture"
OutFile "${path.join(temp, 'upgrade-fixture.exe')}"
RequestExecutionLevel user
SilentInstall silent
!define PRODUCT_NAME "Orgtree"
!define APP_EXECUTABLE_FILENAME "Orgtree.exe"
!define UNINSTALL_FILENAME "Uninstall Orgtree.exe"
!define UNINSTALL_DISPLAY_NAME "Orgtree 2.1.3-RC1"
!define UNINSTALL_REGISTRY_KEY "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{fixture}"
!define INSTALL_REGISTRY_KEY "Software\\com.maurdekye.orgtree"
!macro _isUpdated _a _b _t _f
  StrCmp "0" "1" \`\${_t}\` \`\${_f}\`
!macroend
!define isUpdated \`"" _isUpdated ""\`
!define orgtreeOriginalIsUpdated \`\${isUpdated}\`
${vars}
# electron-builder supplies UAC.nsh; the fixture supplies the same surface so
# the mode macro compiles in isolation. customInstallMode elevates for an
# all-users upgrade, which is where electron-builder elevates too.
!macro _UAC_IsAdmin _a _b _t _f
  StrCmp "1" "1" \`\${_t}\` \`\${_f}\`
!macroend
!define UAC_IsAdmin \`"" UAC_IsAdmin ""\`
!macro UAC_RunElevated
  StrCpy $0 "0"
  StrCpy $1 "2"
!macroend
${functions}
${welcome}
${installMode}
!macro setInstallModePerAllUsers
  StrCpy $installMode all
!macroend
!macro setInstallModePerUser
  StrCpy $installMode CurrentUser
!macroend
Var installMode
!insertmacro customWelcomePage
Function .onInit
  StrCpy $OrgUpgradeSelected "1"
  StrCpy $OrgUpgradeInstallMode "CurrentUser"
  StrCpy $OrgUpgradeInstallDir "$TEMP\\Orgtree fixture"
  !insertmacro customInstallMode
FunctionEnd
Section
SectionEnd
`
const file = path.join(temp, 'upgrade-fixture.nsi')
fs.writeFileSync(file, nsi)
const compile = spawnSync(compilerPath, ['/V1', file], { encoding: 'utf8', windowsHide: true, timeout: 15000 })
assert.equal(compile.status, 0, compile.stdout + compile.stderr)
console.log('PASS NSIS upgrade macros compile')

assert.match(source, /OrgtreeUpgradeMetadata "1"/, 'successful installs must write upgrade metadata')
assert.match(source, /!define orgtreeOriginalIsUpdated `\$\{isUpdated\}`/, 'legacy update predicate must be snapshotted before page-choice redefinition')
assert.match(source, /ReadRegStr \$1 HKCU .*OrgtreeUpgradeMetadata/, 'current-user metadata is authoritative')
assert.match(source, /ReadRegStr \$1 HKLM .*OrgtreeUpgradeMetadata/, 'all-users metadata is authoritative')
assert.match(source, /StrCpy \$OrgUpgradeSelected "1"/, 'Upgrade must select the page-skip state')
assert.match(source, /!define isUpdated '\$OrgUpgradeSelected == "1"'/, 'known setup pages skip only after Upgrade consent')
assert.match(source, /"&Upgrade"/, 'Upgrade is an explicit primary action')
assert.match(source, /"&Advanced setup"/, 'advanced setup remains available')
assert.match(source, /IDRETRY orgtreeUpgradeShutdownAttempt IDCANCEL orgtreeUpgradeShutdownCancel/, 'shutdown failure offers Retry or Cancel')
assert.doesNotMatch(helper, /(?:Stop-Process|taskkill|\.Kill\s*\()/i, 'upgrade helper never force-kills a process')
assert.match(helper, /--installer-upgrade/, 'helper uses the explicit app control argument')
assert.match(controlSource, /--installer-upgrade/, 'app and helper share the explicit control argument')
assert.match(appSource, /hasInstallerUpgradeRequest\(commandLine\)/, 'primary app handles the second-instance control request')
assert.match(appSource, /else if \(installerUpgradeRequested\)/, 'standalone control launch never starts the desktop')
console.log('PASS metadata, action, retry/cancel, and no-force-kill contracts')
console.log('NSIS upgrade fixture used no registry writes, elevation, process launch, installation, or live-data changes.')
