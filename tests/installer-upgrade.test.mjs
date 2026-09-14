import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { spawnSync } from 'node:child_process'

const root = path.resolve(import.meta.dirname, '..')
const installer = fs.readFileSync(path.join(root, 'build/installer.nsh'), 'utf8')
const helper = fs.readFileSync(path.join(root, 'tools/installer-upgrade.ps1'), 'utf8')
const relaunch = fs.readFileSync(path.join(root, 'tools/installer-relaunch.ps1'), 'utf8')
const app = fs.readFileSync(path.join(root, 'apps/desktop/main/index.ts'), 'utf8')
const docs = fs.readFileSync(path.join(root, 'docs/windows-release.md'), 'utf8')
const updater = fs.readFileSync(path.join(root, 'apps/desktop/main/updater.ts'), 'utf8')

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

test('successful interactive upgrades skip Finish and relaunch once after installer exit', () => {
  assert.match(installer, /!macro customFinishPage[\s\S]*?!define MUI_PAGE_CUSTOMFUNCTION_PRE orgtreeUpgradeFinishPagePre[\s\S]*?!insertmacro MUI_PAGE_FINISH/)
  assert.match(installer, /Function orgtreeUpgradeFinishPagePre[\s\S]*?\$OrgUpgradeSelected == "1"[\s\S]*?Call orgtreeScheduleUpgradeRelaunch[\s\S]*?\$OrgUpgradeRelaunchReady == "1"[\s\S]*?Abort/)
  assert.match(installer, /System::Call 'kernel32::GetCurrentProcessId\(\) i \.r0'/)
  assert.match(installer, /\$OrgUpgradeRelaunchArgs .*installer-relaunch\.ps1.*-InstallerPid \$0.*-ExecutablePath "\$OrgUpgradeExe"/)
  assert.match(installer, /\$\{StdUtils\.ExecShellAsUser\} \$1 "\$SYSDIR\\WindowsPowerShell\\v1\.0\\powershell\.exe"/)
  assert.match(installer, /\$OrgUpgradeRelaunchScheduled == "1"/)
  assert.match(installer, /CreateDirectory \$OrgUpgradeRelaunchDir[\s\S]*?CopyFiles \/SILENT "\$PLUGINSDIR\\installer-relaunch\.ps1" \$OrgUpgradeRelaunchDir/)
  assert.match(installer, /-File "\$OrgUpgradeRelaunchDir\\installer-relaunch\.ps1"/)
  assert.match(relaunch, /while \(\$null -ne \(Get-Process -Id \$InstallerPid -ErrorAction SilentlyContinue\)\)/)
  const wait = relaunch.indexOf('while ($null -ne (Get-Process -Id $InstallerPid')
  const launch = relaunch.indexOf('Start-Process -FilePath $ExecutablePath')
  assert.ok(wait >= 0 && launch > wait, 'the app must start only after the installer-exit wait')
  assert.equal((relaunch.match(/Start-Process -FilePath \$ExecutablePath/g) ?? []).length, 1, 'the helper has one launch site')
  assert.match(relaunch, /Remove-Item -LiteralPath \$PSScriptRoot -Recurse -Force/)
})

test('fresh, failed/cancelled, and silent flows do not inherit upgrade relaunch', () => {
  assert.match(installer, /Function orgtreeUpgradeFinishPagePre[\s\S]*?\$OrgUpgradeSelected == "1"/)
  assert.match(installer, /\$OrgUpgradeRelaunchReady == "1"[\s\S]*?Abort[\s\S]*?\$\{endif\}[\s\S]*?\$\{endif\}/)
  assert.match(installer, /Function orgtreeScheduleUpgradeRelaunch[\s\S]*?\$\{if\} \$OrgUpgradeRelaunchScheduled == "1"[\s\S]*?Return[\s\S]*?\$\{endif\}[\s\S]*?\$\{if\} \$\{Silent\}[\s\S]*?Return[\s\S]*?\$\{endif\}/)
  assert.match(installer, /\$1 != 0[\s\S]*?MessageBox[\s\S]*?Return[\s\S]*?\$\{endif\}/)
  assert.match(installer, /!insertmacro MUI_PAGE_FINISH/)
})

test('graceful shutdown is path-bound, retryable, and never force-kills', () => {
  assert.match(helper, /Get-CimInstance -ClassName Win32_Process/)
  // The candidate is compared against the recorded executable, case-insensitively
  // as Windows itself compares paths. The comparison is an operator on values
  // both sides have canonicalized, not an overloaded static.
  assert.match(helper, /\$candidate = Get-CanonicalPath \(\[string\]\$reading\.Path\)/)
  assert.match(helper, /if \(Test-SamePath \$candidate \$executable\)/)
  assert.match(helper, /\$Left\.ToUpperInvariant\(\) -ceq \$Right\.ToUpperInvariant\(\)/)
  assert.match(helper, /Start-Process -FilePath \$executable -ArgumentList @\('--installer-upgrade'\)/)
  assert.doesNotMatch(helper, /(?:Stop-Process|taskkill|\.Kill\s*\()/i)
  assert.match(installer, /IDRETRY orgtreeUpgradeShutdownAttempt IDCANCEL orgtreeUpgradeShutdownCancel/)
  assert.match(installer, /Retry to request a graceful close again, or Cancel to leave the existing installation untouched/)
  assert.match(installer, /!ifndef BUILD_UNINSTALLER[\s\S]*?Call orgtreeCloseForUpgrade[\s\S]*?!else[\s\S]*?!insertmacro _CHECK_APP_RUNNING[\s\S]*?!endif/)
})

test('the shutdown helper stays runnable under the PowerShell the installer uses', () => {
  // NSIS runs this helper with $SYSDIR\WindowsPowerShell\v1.0\powershell.exe —
  // Windows PowerShell 5.1, and because NSIS is a 32-bit process that path is
  // WOW64-redirected to the 32-bit host.
  //
  // 2.1.3-RC1 failed here on every invocation with "Argument types do not
  // match", before it inspected a single process, which is how a release
  // shipped that never closed anything. The cause is `New-Object` on a quoted
  // generic type name — but only across the WHOLE sequence of building the
  // list, adding to it, and enumerating it back through `@()` as a return
  // value. That is measured directly by the regression below; this test keeps
  // the hazard out of the file.
  //
  // The helper now avoids generic lists entirely and uses plain arrays. It also
  // does its comparisons with operators rather than overloaded statics and
  // names the step that failed — hardening beyond the fix, because a dialog
  // that names nothing is what made this cost two release candidates to read.
  // `$matches` is an automatic variable and is not used as a name either,
  // though it was never the cause.
  // The comment above names every hazard, so only executable lines are
  // examined; a test its own explanation can satisfy proves nothing.
  const code = helper.split('\n').filter(line => !/^\s*#/.test(line)).join('\n')
  assert.doesNotMatch(code, /New-Object\s+(['"])?System\.Collections\.Generic\./i)
  assert.doesNotMatch(code, /System\.Collections\.Generic\.[A-Za-z]+\[[^\]]+\]\]::new\(\)/)
  assert.doesNotMatch(code, /\$matches\b/)
  // Overloaded statics replaced by things that cannot be ambiguous.
  assert.doesNotMatch(code, /\[string\]::Equals\(/i)
  assert.doesNotMatch(code, /\[IO\.Path\]::Combine\(/i)
  // Two single-overload statics remain on purpose, and the claim that only
  // those two remain is what this pins: anything else reintroduced here would
  // be an untested overloaded static in the region RC1 died in.
  // GetFullPath itself is measured by tools/test-upgrade-close-boundary.mjs.
  const statics = [...code.matchAll(/\[(?:System\.)?IO\.Path\]::(\w+)/gi)].map(match => match[1])
  assert.deepEqual([...new Set(statics)].sort(), ['GetFileNameWithoutExtension', 'GetFullPath'])

  // Every stage names itself, and the catch puts that name in front of the
  // message the user actually sees. This is what makes the next failure
  // answerable from one screenshot.
  assert.match(code, /\$script:Step\s*=/)
  assert.match(code, /Set-Step\s+'canonicalize-paths'/)
  assert.match(code, /Set-Step\s+'detect-running-processes'/)
  assert.match(code, /Set-Step\s+'request-graceful-shutdown'/)
  assert.match(code, /\[Console\]::Error\.WriteLine\(\$detail\)/)
  assert.match(code, /\$detail\s*=\s*"\[\$script:Step\]/)

  // A durable record, and an installer that asks for one.
  assert.match(code, /\[string\]\s*\$LogPath/)
  assert.match(installer, /-LogPath "\$TEMP\\orgtree-installer-upgrade\.log"/)

  // Detection must survive a process it cannot read, and must have a second
  // way to ask. An elevated enumeration reaches processes an ordinary one
  // never sees, and aborting a whole upgrade over one unrelated system process
  // would be its own defect.
  // The fallback reads the WHOLE table and fails closed. `Get-Process -Name X
  // -ErrorAction SilentlyContinue` cannot tell "no such process" from "the table
  // could not be read" — both are an empty collection, and empty here becomes
  // "already closed" and an installer that proceeds. Measured: with that form,
  // a non-terminating read error makes the helper exit 0 saying the application
  // is already closed while it is still running.
  assert.match(code, /\$records = @\(Get-Process -ErrorAction Stop\)/)
  assert.doesNotMatch(code, /Get-Process -Name [^\n]*SilentlyContinue/)
  assert.match(code, /if \(-not \(Test-SamePath \$name \$base\)\) \{ continue \}/)
  // The one surviving SilentlyContinue is the liveness probe, where $null means
  // "this id is gone" and any real error is caught and counted as ALIVE, so it
  // cannot produce the same inversion.
  assert.match(code, /Get-Process -Id \$Id -ErrorAction SilentlyContinue/)
  assert.match(code, /try \{ \$name = \[string\]\$record\.Name \} catch \{ continue \}/)

  // The fail-safe direction. Success is positive proof that the processes
  // identified BEFORE the request have gone, checked by id; it is never
  // inferred from a path scan that came back empty, because a scan that cannot
  // read anything comes back empty too. Anything unverifiable counts as alive,
  // and the request is only considered sent once the control process started.
  assert.match(code, /\$script:Watch\s*=\s*@\(\$targets\) \+ @\(\$controlId\)/)
  // An untrackable control process is a failure, never an omission from the
  // watch set: it carries the same image path, so if it won the single-instance
  // race it IS the application, and waiting only on the original ids would
  // watch them exit and call that success.
  assert.match(code, /if \(\$controlId -le 0\) \{[\s\S]*?throw 'The graceful close was requested, but the control process could not be tracked/)
  assert.match(code, /control process could not be tracked[\s\S]*?\$script:Requested = \$true/)
  assert.match(code, /function Test-TargetAlive/)
  assert.match(code, /return \(\$null -ne \(Get-Process -Id \$Id -ErrorAction SilentlyContinue\)\)/)
  // The unverifiable-is-alive rule, in both places it has to hold.
  assert.match(code, /if \(\$Id -le 0\) \{ return \$true \}/)
  assert.match(code, /\} catch \{\s*return \$true\s*\}/)
  // Requested is set only after Start-Process returned a control process.
  assert.match(code, /if \(\$null -eq \$control\) \{[\s\S]*?throw 'The graceful close could not be requested[\s\S]*?\$script:Requested = \$true/)
  // The recovery reads the fixed id set, never a fresh path scan.
  assert.match(code, /if \(\$script:Requested -and @\(\$script:Watch\)\.Count -gt 0\)/)
  assert.match(code, /\$alive = @\(Get-LiveTargets\)/)
  assert.doesNotMatch(code, /Get-Process -ErrorAction SilentlyContinue \| Where-Object/)
})

// The measurement the RC1 fix rests on, kept where it can be re-run rather than
// re-argued. Testing the CONSTRUCTOR alone reports the old form as healthy —
// that is what made this look like a phantom and cost an extra release
// candidate. The failure needs the whole sequence, so that is what runs here,
// in both hosts, against the real Windows PowerShell 5.1.
test('the generic-list construction RC1 used still fails 5.1, and the form replacing it does not', { skip: process.platform !== 'win32' ? 'Windows only' : false }, () => {
  const hosts = [
    path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    path.join(process.env.SystemRoot || 'C:\\Windows', 'SysWOW64/WindowsPowerShell/v1.0/powershell.exe'),
  ].filter(fs.existsSync)
  assert.ok(hosts.length, 'no Windows PowerShell 5.1 host to measure against')

  // Identical but for how the list is built, and each does the full sequence:
  // construct, add an object, return it enumerated through `@()`.
  const sequence = build => `
function Probe {
  $list = ${build}
  $list.Add([pscustomobject]@{ Name = 'Orgtree.exe' })
  return @($list)
}
try { $r = @(Probe); [Console]::Out.WriteLine('OK ' + $r.Count) }
catch { [Console]::Out.WriteLine('THREW ' + $_.Exception.Message) }`

  for (const host of hosts) {
    const run = script => {
      const done = spawnSync(host, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { encoding: 'utf8', windowsHide: true })
      assert.equal(done.status, 0, `${host} could not run the probe: ${done.stderr}`)
      return (done.stdout || '').trim()
    }
    // If this ever starts reporting OK, Windows PowerShell has changed and the
    // hazard is gone; that is worth a failing test and a human deciding, not a
    // silent pass.
    assert.equal(run(sequence(`New-Object 'System.Collections.Generic.List[object]'`)),
      'THREW Argument types do not match',
      `${host}: the construction RC1 used no longer reproduces the reported failure`)
    assert.equal(run(sequence('[System.Collections.Generic.List[object]]::new()')), 'OK 1',
      `${host}: the replacement construction does not survive the same sequence`)
    // And the constructor on its own is healthy in BOTH forms — the reason
    // testing it alone cleared code that was in fact broken.
    assert.equal(run(`$null = New-Object 'System.Collections.Generic.List[object]'; [Console]::Out.WriteLine('OK 1')`), 'OK 1')
  }
})

test('the application records the installer-requested shutdown and how it started again', () => {
  // When the installer's graceful close last failed, nothing on the
  // application's side had written a single line about it: the log held only
  // the next run's routine update check. These stages are the record that was
  // missing — what was asked, how far it got, and what started the application
  // afterwards.
  for (const stage of ['installer-upgrade-requested', 'installer-upgrade-deferred', 'installer-upgrade-began',
    'installer-upgrade-engine-stopped', 'installer-upgrade-complete', 'installer-upgrade-refused',
    'installer-upgrade-control', 'startup']) {
    assert.match(updater, new RegExp(`'${stage}'`), `UpdateStage is missing ${stage}`)
    assert.match(app, new RegExp(`\\.record\\('${stage}'`), `nothing records ${stage}`)
  }
  // The refusal path must be recorded on both ways out: the engine declining
  // to stop, and the shutdown throwing.
  assert.match(app, /installer-upgrade-refused', 'the engine did not stop within its budget'/)
  assert.match(app, /catch \(error\) \{[\s\S]*?installer-upgrade-refused', error\)/)
  // Only the instance holding the single-instance lock may write the log: the
  // messenger runs while the application is writing it too.
  assert.match(app, /no running application received the request/)
})

test('installer control invocation quits the app without starting a desktop', () => {
  assert.match(app, /hasInstallerUpgradeRequest\(process\.argv\)/)
  assert.match(app, /else if \(installerUpgradeRequested\)/)
  assert.match(app, /hasInstallerUpgradeRequest\(commandLine\)/)
  assert.match(app, /app\.whenReady\(\)\.then\(\(\) => \{[\s\S]*?app\.quit\(\)\s*\}\)/)
})

test('Windows release docs describe the upgrade safety boundary', () => {
  assert.match(docs, /OrgtreeUpgradeMetadata=1/)
  assert.match(docs, /Advanced setup/)
  assert.match(docs, /--installer-upgrade/)
  assert.match(docs, /does not force-kill a process/)
  assert.match(docs, /Retry.*Cancel/)
})
