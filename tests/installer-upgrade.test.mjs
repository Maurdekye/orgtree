import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '..')
const installer = fs.readFileSync(path.join(root, 'build/installer.nsh'), 'utf8')
const helper = fs.readFileSync(path.join(root, 'tools/installer-upgrade.ps1'), 'utf8')
const app = fs.readFileSync(path.join(root, 'apps/desktop/main/index.ts'), 'utf8')
const docs = fs.readFileSync(path.join(root, 'docs/windows-release.md'), 'utf8')

function canonical(value) {
  return path.win32.normalize(path.win32.resolve(value)).replace(/[\\/]+$/, '').toLowerCase()
}

function validInstall(record) {
  const prefix = 'Orgtree'
  const displayName = String(record.uninstall?.DisplayName ?? '')
  if (displayName !== prefix && !displayName.startsWith(`${prefix} `)) return false
  if (!record.install?.InstallLocation || !record.uninstall?.DisplayVersion ||
      !record.uninstall?.UninstallString || !record.uninstall?.DisplayIcon ||
      record.uninstall?.OrgtreeUpgradeMetadata !== '1' ||
      record.install?.OrgtreeUpgradeMetadata !== '1') return false

  const directory = canonical(record.install.InstallLocation)
  return record.files.has(`${directory}\\orgtree.exe`) &&
    record.files.has(`${directory}\\uninstall orgtree.exe`)
}

function detectUpgrade(candidates) {
  const valid = candidates.filter(validInstall)
  return valid.length === 1 ? valid[0] : null
}

function fixture(overrides = {}) {
  const directory = canonical('C:\\Users\\fixture\\AppData\\Local\\Programs\\Orgtree')
  const base = {
    install: { InstallLocation: directory, OrgtreeUpgradeMetadata: '1' },
    uninstall: {
      DisplayName: 'Orgtree 2.1.2', DisplayVersion: '2.1.2',
      UninstallString: `"${directory}\\Uninstall Orgtree.exe" /currentuser`,
      DisplayIcon: `${directory}\\Orgtree.exe,0`, OrgtreeUpgradeMetadata: '1',
    },
    files: new Set([`${directory}\\orgtree.exe`, `${directory}\\uninstall orgtree.exe`]),
  }
  return {
    ...base,
    ...overrides,
    install: { ...base.install, ...(overrides.install ?? {}) },
    uninstall: { ...base.uninstall, ...(overrides.uninstall ?? {}) },
    files: overrides.files ?? base.files,
  }
}

test('valid metadata selects the recorded application location and scope', () => {
  const currentUser = fixture()
  const selected = detectUpgrade([currentUser])
  assert.equal(selected, currentUser)
  assert.equal(selected.install.InstallLocation, canonical('C:\\Users\\fixture\\AppData\\Local\\Programs\\Orgtree'))
})

test('incomplete or old metadata safely falls back to full setup', () => {
  assert.equal(detectUpgrade([fixture({ install: { OrgtreeUpgradeMetadata: '' } })]), null)
  assert.equal(detectUpgrade([fixture({ uninstall: { OrgtreeUpgradeMetadata: '' } })]), null)
  assert.equal(detectUpgrade([fixture({ uninstall: { DisplayName: 'Electron 2.1.2' } })]), null)
  assert.equal(detectUpgrade([fixture({ files: new Set() })]), null)
})

test('ambiguous per-user and all-users records never guess an upgrade target', () => {
  const currentUser = fixture()
  const allUsersDir = canonical('C:\\Program Files\\Orgtree')
  const allUsers = fixture({
    install: { InstallLocation: allUsersDir },
    uninstall: { UninstallString: `"${allUsersDir}\\Uninstall Orgtree.exe" /allusers`, DisplayIcon: `${allUsersDir}\\Orgtree.exe,0` },
    files: new Set([`${allUsersDir}\\orgtree.exe`, `${allUsersDir}\\uninstall orgtree.exe`]),
  })
  assert.equal(detectUpgrade([currentUser, allUsers]), null)
})

test('NSIS reads the location from the application registry record', () => {
  assert.match(installer, /ReadRegStr \$OrgUpgradeProbeDir HKCU "\$\{INSTALL_REGISTRY_KEY\}" InstallLocation/)
  assert.match(installer, /ReadRegStr \$OrgUpgradeProbeDir HKLM "\$\{INSTALL_REGISTRY_KEY\}" InstallLocation/)
  assert.doesNotMatch(installer, /ReadRegStr \$OrgUpgradeProbeDir HK(?:CU|LM) "\$\{UNINSTALL_REGISTRY_KEY\}" InstallLocation/)
  assert.match(installer, /ReadRegStr \$1 HKCU "\$\{UNINSTALL_REGISTRY_KEY\}" OrgtreeUpgradeMetadata/)
  assert.match(installer, /ReadRegStr \$2 HKCU "\$\{INSTALL_REGISTRY_KEY\}" OrgtreeUpgradeMetadata/)
  assert.match(installer, /ReadRegStr \$1 HKLM "\$\{UNINSTALL_REGISTRY_KEY\}" OrgtreeUpgradeMetadata/)
  assert.match(installer, /ReadRegStr \$2 HKLM "\$\{INSTALL_REGISTRY_KEY\}" OrgtreeUpgradeMetadata/)
})

test('Upgrade reuses scope and directory and skips only after consent', () => {
  assert.match(installer, /StrCpy \$INSTDIR \$OrgUpgradeInstallDir/)
  assert.match(installer, /SetShellVarContext all/)
  assert.match(installer, /SetShellVarContext current/)
  assert.match(installer, /!define isUpdated '\$OrgUpgradeSelected == "1"'/)
  assert.match(installer, /!define orgtreeOriginalIsUpdated `\$\{isUpdated\}`/)
  assert.match(installer, /PageCallbacks orgtreeUpgradePageShow orgtreeUpgradePageLeave/)
  assert.doesNotMatch(installer, /PageCallbacks orgtreeUpgradePagePre orgtreeUpgradePageShow/)
  assert.match(installer, /"&Upgrade"/)
  assert.match(installer, /"&Advanced setup"/)
  assert.match(installer, /WriteRegStr SHELL_CONTEXT "\$\{INSTALL_REGISTRY_KEY\}" OrgtreeUpgradeMetadata "1"/)
  assert.match(installer, /WriteRegStr SHELL_CONTEXT "\$\{UNINSTALL_REGISTRY_KEY\}" OrgtreeUpgradeMetadata "1"/)
})

test('graceful shutdown is path-bound, retryable, and never force-kills', () => {
  assert.match(helper, /Get-CimInstance -ClassName Win32_Process/)
  assert.match(helper, /Equals\(\$processPath, \$executable, \[StringComparison\]::OrdinalIgnoreCase\)/)
  assert.match(helper, /Start-Process -FilePath \$executable -ArgumentList @\('--installer-upgrade'\)/)
  assert.doesNotMatch(helper, /(?:Stop-Process|taskkill|\.Kill\s*\()/i)
  assert.match(installer, /IDRETRY orgtreeUpgradeShutdownAttempt IDCANCEL orgtreeUpgradeShutdownCancel/)
  assert.match(installer, /Retry to request a graceful close again, or Cancel to leave the existing installation untouched/)
  assert.match(installer, /!ifndef BUILD_UNINSTALLER[\s\S]*?Call orgtreeCloseForUpgrade[\s\S]*?!else[\s\S]*?!insertmacro _CHECK_APP_RUNNING[\s\S]*?!endif/)
})

test('installer control invocation quits the app without starting a desktop', () => {
  assert.match(app, /hasInstallerUpgradeRequest\(process\.argv\)/)
  assert.match(app, /else if \(installerUpgradeRequested\)/)
  assert.match(app, /hasInstallerUpgradeRequest\(commandLine\)/)
  assert.match(app, /app\.whenReady\(\)\.then\(\(\) => app\.quit\(\)\)/)
})

test('Windows release docs describe the upgrade safety boundary', () => {
  assert.match(docs, /OrgtreeUpgradeMetadata=1/)
  assert.match(docs, /Advanced setup/)
  assert.match(docs, /--installer-upgrade/)
  assert.match(docs, /does not force-kill a process/)
  assert.match(docs, /Retry.*Cancel/)
})
