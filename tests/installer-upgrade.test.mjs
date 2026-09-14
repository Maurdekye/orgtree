import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { spawn, spawnSync } from 'node:child_process'

const root = path.resolve(import.meta.dirname, '..')
const installer = fs.readFileSync(path.join(root, 'build/installer.nsh'), 'utf8')
const helper = fs.readFileSync(path.join(root, 'tools/installer-upgrade.ps1'), 'utf8')
const relaunch = fs.readFileSync(path.join(root, 'tools/installer-relaunch.py'), 'utf8')

// IMAGE_SUBSYSTEM values from the PE optional header. Only these two matter
// here: a GUI-subsystem image is started by ShellExecute with no console, a
// console-subsystem image causes Windows to allocate one.
const SUBSYSTEM_GUI = 2
const SUBSYSTEM_CUI = 3

// Reads the subsystem byte out of a PE image. This is the instrument behind the
// console regression guard, so it THROWS on anything it cannot read rather than
// returning a value: a reader that answered "GUI" for a missing or malformed
// file would turn "could not ask" into "the answer is safe", and would look
// exactly like a working guard until the day it mattered.
function peSubsystem(file) {
  const fd = fs.openSync(file, 'r')
  try {
    const dos = Buffer.alloc(0x40)
    if (fs.readSync(fd, dos, 0, 0x40, 0) !== 0x40) throw new Error(`${file}: too small to be a PE image`)
    if (dos.readUInt16LE(0) !== 0x5a4d) throw new Error(`${file}: no MZ signature`)
    const peOffset = dos.readUInt32LE(0x3c)
    const signature = Buffer.alloc(4)
    if (fs.readSync(fd, signature, 0, 4, peOffset) !== 4) throw new Error(`${file}: truncated at the PE signature`)
    if (signature.toString('latin1') !== 'PE\u0000\u0000') throw new Error(`${file}: no PE signature`)
    // The optional header follows the 20-byte COFF header, and Subsystem sits
    // at offset 68 within it for BOTH PE32 and PE32+ — the extra 4 bytes of
    // ImageBase in PE32+ are offset by the absent BaseOfData.
    const field = Buffer.alloc(2)
    if (fs.readSync(fd, field, 0, 2, peOffset + 24 + 68) !== 2) throw new Error(`${file}: truncated before Subsystem`)
    return field.readUInt16LE(0)
  } finally {
    fs.closeSync(fd)
  }
}

// Resolves an NSIS $SYSDIR-rooted path the way the 32-bit installer process
// would see it, so the guard measures the same file Windows would start.
function systemPath(nsisPath) {
  return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32',
    nsisPath.replace(/^\$SYSDIR\\/, '').replace(/\\/g, path.sep))
}

// The relaunch host now lives inside the INSTALLED tree, so there is no
// installed copy to read in a source checkout. The provisioned runtime is the
// same build that gets packaged into it (engine/runtime is gitignored, so it is
// located rather than assumed). Everything that depends on it SKIPS with a
// reason when it is absent — a missing runtime is an environment limit, not a
// silent pass.
const engineRuntime = (() => {
  const candidates = [process.env.ORGTREE_ENGINE_RUNTIME, path.join(root, 'engine', 'runtime')].filter(Boolean)
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'pythonw.exe'))) return candidate
  }
  return null
})()

// Resolves whatever build/installer.nsh names as the relaunch host onto a file
// this checkout can actually read.
function hostPath(nsisPath) {
  if (nsisPath.startsWith('$SYSDIR\\')) return systemPath(nsisPath)
  const installed = nsisPath.match(/^\$INSTDIR\\resources\\engine\\runtime\\(.+)$/)
  if (installed && engineRuntime) return path.join(engineRuntime, installed[1])
  throw new Error(`cannot resolve the relaunch host ${nsisPath} in a source checkout`)
}
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
  assert.match(installer, /\$OrgUpgradeRelaunchArgs .*installer-relaunch\.py.*\$0 "\$OrgUpgradeExe" "\$OrgUpgradeRelaunchReadyMarker"/)
  assert.match(installer, /\$\{StdUtils\.ExecShellAsUser\} \$1 "\$OrgUpgradeRelaunchHost"/)
  assert.match(installer, /StrCpy \$OrgUpgradeRelaunchHost "\$INSTDIR\\resources\\engine\\runtime\\pythonw\.exe"/)
  assert.match(installer, /\$OrgUpgradeRelaunchScheduled == "1"/)
  assert.match(installer, /Function orgtreePrepareUpgradeRelaunch[\s\S]*?CreateDirectory \$OrgUpgradeRelaunchDir[\s\S]*?CopyFiles \/SILENT "\$PLUGINSDIR\\installer-relaunch\.py" \$OrgUpgradeRelaunchDir/)
  assert.match(installer, /Function orgtreePrepareUpgradeRelaunch[\s\S]*?ClearErrors\r?\n\s+CreateDirectory \$OrgUpgradeRelaunchDir[\s\S]*?ClearErrors\r?\n\s+CopyFiles \/SILENT/)
  assert.match(installer, /"\$OrgUpgradeRelaunchDir\\installer-relaunch\.py"/)
  // Wait strictly before launch, and exactly one launch site. These anchor on
  // the CALLS, not the definitions, and they are line-ending agnostic: a
  // literal '\n' anchor silently finds nothing in a normal CRLF checkout, which
  // is an assertion that passes by not looking.
  const wait = relaunch.search(/^\s*outcome = wait_on\(handle, pid, timeout_ms\)\s*$/m)
  const launch = relaunch.search(/^\s*launch\(executable\)\s*$/m)
  assert.ok(wait >= 0, 'the helper must call the wait; the anchor found no call at all')
  assert.ok(launch > wait, 'the app must start only after the installer-exit wait')
  assert.equal((relaunch.match(/^\s*launch\(executable\)$/gm) ?? []).length, 1, 'the helper has one launch site')
  assert.equal((relaunch.match(/^\s*subprocess\.Popen\($/gm) ?? []).length, 1, 'the helper starts exactly one process')
  assert.match(relaunch, /shutil\.rmtree\(directory, ignore_errors=True\)/)
})

test('fresh, failed/cancelled, and silent flows do not inherit upgrade relaunch', () => {
  assert.match(installer, /Function orgtreeUpgradeFinishPagePre[\s\S]*?\$OrgUpgradeSelected == "1"/)
  assert.match(installer, /\$OrgUpgradeRelaunchReady == "1"[\s\S]*?Abort[\s\S]*?\$\{endif\}[\s\S]*?\$\{endif\}/)
  assert.match(installer, /Function orgtreeScheduleUpgradeRelaunch[\s\S]*?\$\{if\} \$OrgUpgradeRelaunchScheduled == "1"[\s\S]*?Return[\s\S]*?\$\{endif\}[\s\S]*?\$\{if\} \$\{Silent\}[\s\S]*?Return[\s\S]*?\$\{endif\}/)
  // StdUtils.ExecShellAsUser answers a token, never an exit code. RC4
  // shipped `$1 != 0`, which turned the real success token "ok" into the
  // "(error ok)" dialog; the routing must accept exactly the two success
  // tokens and show anything else verbatim.
  assert.match(installer, /\$\{if\} \$1 == "ok"[\s\S]*?\$\{orif\} \$1 == "fallback"[\s\S]*?StrCpy \$OrgUpgradeRelaunchScheduled "1"[\s\S]*?StrCpy \$OrgUpgradeRelaunchReady "1"[\s\S]*?\$\{else\}[\s\S]*?MessageBox[\s\S]*?\(result: \$1\)[\s\S]*?\$\{endif\}/)
  // Instructions only: a comment that NAMES the regression (to warn the next
  // reader off it) is not the regression, and a guard that cannot tell the
  // difference punishes writing the warning down.
  assert.doesNotMatch(installer.split(/\r?\n/).filter(line => !/^\s*#/.test(line)).join('\n'),
    /\$1 != 0/, 'the numeric ExecShellAsUser result test is the RC4 regression')
  assert.match(installer, /!insertmacro MUI_PAGE_FINISH/)
  assert.match(installer, /UAC_AsUser_GetGlobalVar \$OrgUpgradeRelaunchDir/)
  assert.match(installer, /UAC_AsUser_GetGlobalVar \$OrgUpgradeRelaunchPrepared/)
  assert.match(installer, /Call orgtreePrepareUpgradeRelaunch[\s\S]*?\$OrgUpgradeRelaunchPrepared != "1"[\s\S]*?Quit/)
})

test('all-users elevation carries a user-owned helper across the UAC boundary', () => {
  const prepared = installer.indexOf('Function orgtreePrepareUpgradeRelaunch')
  const copy = installer.indexOf('CopyFiles /SILENT "$PLUGINSDIR\\installer-relaunch.py" $OrgUpgradeRelaunchDir')
  const call = installer.indexOf('Call orgtreePrepareUpgradeRelaunch')
  const elevation = installer.indexOf('!insertmacro UAC_RunElevated')
  assert.ok(prepared >= 0 && copy > prepared && call >= 0 && call < elevation, 'helper staging is called before all-users elevation')
  assert.match(installer, /StrCpy \$OrgUpgradeRelaunchDir "\$TEMP\\OrgtreeInstallerRelaunch-\$0"/)
  assert.match(installer, /UAC_AsUser_GetGlobalVar \$OrgUpgradeRelaunchDir/)
  assert.match(installer, /UAC_AsUser_GetGlobalVar \$OrgUpgradeRelaunchPrepared/)
  assert.match(installer, /File \/oname=\$PLUGINSDIR\\installer-relaunch\.py/)
  assert.match(relaunch, /shutil\.rmtree\(directory, ignore_errors=True\)/)
})

// The console regression guard. This is the thing that will silently come back:
// the dispatch is a ShellExecute, so naming a CONSOLE-SUBSYSTEM binary here
// makes Windows allocate a console, which under Windows Terminal is a visible
// terminal window. The guard does not match on a name blocklist — it reads the
// PE subsystem byte of whatever executable build/installer.nsh actually names,
// so pointing the dispatch at any console binary fails, not just the one that
// caused the incident.
test('the upgrade relaunch dispatch never targets a console-subsystem host', {
  skip: process.platform !== 'win32' ? 'Windows only'
    : !engineRuntime ? 'no provisioned engine runtime (engine/runtime/pythonw.exe); set ORGTREE_ENGINE_RUNTIME'
    : false,
}, () => {
  // EVERY dispatch, not the first one. There are two now — the relaunch helper's
  // host and the Finish page's launch action — and a guard that stopped at the
  // first would have gone on passing while a console came back through the
  // second. Targets name VARIABLES, so each is resolved from the line that
  // assigns it; an unrecognised target is a failure rather than a skip, because
  // "I could not resolve it" must never read as "it is safe".
  const dispatches = [...installer.matchAll(/\$\{StdUtils\.ExecShellAsUser\} \$\d+ "([^"]+)"/g)].map(m => m[1])
  assert.ok(dispatches.length >= 2, `expected the helper dispatch and the Finish launch, found ${dispatches.length}`)

  for (const named of dispatches) {
    if (named === '$OrgUpgradeRelaunchHost') {
      // The helper's host: a real file this checkout can read.
      const assigned = installer.match(/StrCpy \$OrgUpgradeRelaunchHost "([^"]+)"/)?.[1]
      assert.ok(assigned, 'the relaunch host assignment could not be found')
      const target = hostPath(assigned)
      assert.ok(fs.existsSync(target), `the dispatch target does not exist: ${target}`)
      // THE SUBJECT.
      assert.equal(peSubsystem(target), SUBSYSTEM_GUI,
        `${assigned} is console-subsystem; ShellExecute cannot suppress its console and a terminal window will appear`)
      continue
    }
    if (named === '$0') {
      // The Finish page's launch action. $0 is assigned immediately above it
      // and is the INSTALLED APPLICATION — Electron, GUI-subsystem — with a
      // fallback to $INSTDIR\<app>.exe. There is no such file in a source
      // checkout, so what is asserted here is that it is the application and
      // not a host: a script host or interpreter reintroduces the console this
      // work removed.
      const run = installer.match(/Function orgtreeFinishPageRun[\s\S]*?FunctionEnd/)?.[0]
      assert.ok(run, 'the Finish launch function could not be found')
      assert.match(run, /StrCpy \$0 "\$OrgUpgradeExe"/)
      assert.match(run, /StrCpy \$0 "\$INSTDIR\\\$\{APP_EXECUTABLE_FILENAME\}"/)
      assert.doesNotMatch(run, /\$SYSDIR|\.ps1|\.js\b|\.py\b|pythonw?\.exe|powershell\.exe|cmd\.exe/,
        'the Finish page must start the application directly, not through a host')
      continue
    }
    assert.fail(`unrecognised ExecShellAsUser target ${named}: resolve it here rather than letting it pass unmeasured`)
  }

  // POSITIVE CONTROL — the assertion must FAIL for the exact binary the defect
  // used. Without this, a guard that could never fire would read as a pass.
  const defect = systemPath('$SYSDIR\\WindowsPowerShell\\v1.0\\powershell.exe')
  assert.equal(peSubsystem(defect), SUBSYSTEM_CUI,
    'powershell.exe no longer reads as console-subsystem, so this guard can no longer detect the original defect')
  assert.notEqual(peSubsystem(defect), SUBSYSTEM_GUI)

  // The host must also not be a component a policy can switch off underneath
  // the upgrade. Windows Script Host is exactly that, and a disabled WSH cannot
  // report that it is disabled — the dispatch still answers "ok".
  const instructions = installer.split(/\r?\n/).filter(line => !/^\s*#/.test(line)).join('\n')
  assert.doesNotMatch(instructions, /wscript\.exe|cscript\.exe/,
    'Windows Script Host can be disabled by policy, and a disabled host cannot log its own failure')

  // INSTRUMENT CONTROL — break the reader, not just the subject. A probe that
  // returned a value for something it could not read would turn "could not ask"
  // into "the answer is GUI" and pass forever. Both a missing file and a real
  // file that is not a PE image must THROW.
  assert.throws(() => peSubsystem(path.join(root, 'no-such-binary-for-the-guard.exe')))
  assert.throws(() => peSubsystem(path.join(root, 'package.json')), /no MZ signature|too small/)
})

// The stranded-client guard. A silent --updated run reaches no page, so it never
// reaches customInstallMode — the install-mode page PRE callback was the only
// place this installer elevated. These pin the SHAPE; the reachability itself is
// measured by running a compiled fixture in
// tools/test-installer-silent-elevation.mjs, which this cannot do because the
// normal suite must not require the NSIS compiler.
test('the silent update path reaches an elevation decision of its own', () => {
  const init = installer.match(/!macro customInit\r?\n[\s\S]*?\r?\n!macroend/)
  assert.ok(init, 'customInit must exist')
  const body = init[0]

  // customInit is expanded from .onInit, which runs under silence — unlike a
  // page callback. The decision has to live here to be reachable at all.
  assert.match(body, /\$\{if\} \$installMode == "all"[\s\S]*?\$\{ifNot\} \$\{UAC_IsAdmin\}[\s\S]*?!insertmacro UAC_RunElevated/)
  // Gated on the real --updated entry point, so a MANUAL Upgrade never enters
  // it and keeps every page it has today. This is the RC5 boundary.
  const gate = body.indexOf('${if} ${orgtreeOriginalIsUpdated}')
  const elevate = body.indexOf('!insertmacro UAC_RunElevated')
  assert.ok(gate >= 0 && elevate > gate, 'the silent elevation must sit inside the --updated gate')
  // An inner instance re-elevating is an elevation loop.
  assert.match(body, /\$\{ifNot\} \$\{UAC_IsInnerInstance\}/)
  // Scope and location are resolved by the /D= block; elevating before it would
  // decide on a scope that the destination can still change.
  const destination = body.indexOf('!insertmacro GetDParameter')
  assert.ok(destination >= 0 && elevate > destination,
    'elevation must come after the /D= destination resolution, or it decides on a scope that is not final yet')
  // THE CHILD'S RESULT IS THE UPDATE'S RESULT. UAC.nsh returns the elevated
  // child's exit code in $2 ("The NSIS errlvl is also set"), and $1 == 1 only
  // says a child ran — not that it worked. Reporting 0 for every started child
  // tells the auto-updater that a failed all-users update succeeded.
  assert.match(body, /\$\{if\} \$2 == 0[\s\S]*?SetErrorLevel 0[\s\S]*?\$\{else\}[\s\S]*?SetErrorLevel \$2[\s\S]*?\$\{endif\}\r?\n\s*Quit/)
  assert.match(body, /elevation-child-succeeded/)
  assert.match(body, /elevation-child-failed/)
  // Every other documented answer has its own branch: 3 is "ask again" (a
  // non-admin account was typed in), 2 is "already elevated", and $0 == 0 with
  // $1 == 0 means the OS has no UAC at all.
  assert.match(body, /\$1 == 3[\s\S]*?elevation-retry[\s\S]*?Goto orgtreeSilentElevateAttempt/)
  assert.match(body, /\$OrgUpgradeElevateAttempts < 2/, 'the credential retry must be bounded')
  assert.match(body, /\$1 == 2[\s\S]*?elevation-unnecessary[\s\S]*?Goto orgtreeSilentElevateDone/)
  assert.match(body, /elevation-unavailable/)
  // A refusal must be distinguishable and must not be silent-failure-by-zero.
  assert.match(body, /\$0 == 1223[\s\S]*?elevation-declined/)
  assert.match(body, /SetErrorLevel 2\r?\n\s*Quit/)
  // The window is hidden before the prompt, as at every other elevation site.
  assert.match(body, /ShowWindow \$HWNDPARENT \$\{SW_HIDE\}\r?\n\s*!insertmacro UAC_RunElevated/)
})

// The silent route reached the close helper with an EMPTY executable, which is
// a recovery gap rather than a cosmetic one: the helper's parameter is
// mandatory, so PowerShell refuses the binding and the helper's body — the
// graceful shutdown request — never runs at all.
test('the silent update path resolves a real executable before anything can close the app', () => {
  const init = installer.match(/!macro customInit\r?\n[\s\S]*?\r?\n!macroend/)
  assert.ok(init, 'customInit must exist')
  const body = init[0]

  const assignment = body.indexOf('StrCpy $OrgUpgradeExe "$INSTDIR\\${APP_EXECUTABLE_FILENAME}"')
  assert.ok(assignment >= 0,
    'customInit must set the executable itself: the only other assignment is reached from the upgrade page, which silence skips')
  // Ordering is the whole content of this fix. setInstallModePerAllUsers and
  // setInstallModePerUser rewrite $INSTDIR, so reading it before the /D= block
  // records the directory this run STARTED with rather than its destination.
  const destination = body.indexOf('!insertmacro GetDParameter')
  assert.ok(destination >= 0 && assignment > destination,
    'the target must be recorded AFTER the /D= destination resolution, or it names a directory the run will not install into')
  // Before elevation, so a log that stops at a declined prompt still names the
  // destination, and so the elevated child's own customInit re-resolves it.
  const elevate = body.indexOf('!insertmacro UAC_RunElevated')
  assert.ok(elevate > assignment, 'the target must be recorded before the elevation hand-off')
  assert.match(body, /StrCpy \$OrgUpgradeInstallDir \$INSTDIR[\s\S]*?StrCpy \$OrgUpgradeExe/)
  assert.match(body, /\$installMode == "all"[\s\S]*?StrCpy \$OrgUpgradeRegistryRoot "HKLM"[\s\S]*?\$\{else\}[\s\S]*?"HKCU"/)

  // The close call the empty value was flowing into.
  assert.match(installer, /installer-upgrade\.ps1" -InstallDir "\$OrgUpgradeInstallDir" -ExecutablePath "\$OrgUpgradeExe"/)
  assert.match(helper, /\[Parameter\(Mandatory = \$true\)\]\r?\n\s*\[string\] \$ExecutablePath/)
})

test('an empty executable path stops the close helper before its body runs', {
  skip: process.platform !== 'win32' ? 'Windows only' : false,
}, () => {
  // Parameter BINDING only. An empty mandatory string is refused before the
  // script body exists, so nothing here can close an application, inspect a
  // process or touch an installation — which is also why this is the only way
  // to exercise the real contract headlessly.
  const script = path.join(root, 'tools/installer-upgrade.ps1').replaceAll("'", "''")
  const command = `try { & '${script}' -InstallDir 'C:\\Program Files\\Orgtree' -ExecutablePath ''; exit 99 } catch { [Console]::WriteLine($_.Exception.Message); exit 17 }`
  const run = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    windowsHide: true, encoding: 'utf8', timeout: 30000,
  })
  assert.equal(run.status, 17,
    `an empty -ExecutablePath must be REFUSED at binding (exit 99 means the body ran): ${run.stdout}${run.stderr}`)
  assert.match(run.stdout, /ExecutablePath[\s\S]*empty string/,
    'the refusal must be the mandatory-parameter one, not some later failure')
})

test('the manual upgrade elevation is left where it was', () => {
  // The silent path gets its own decision; the field-tested manual one must not
  // be disturbed by that, or this trades a silent failure for a visible one.
  const mode = installer.match(/!macro customInstallMode\r?\n[\s\S]*?\r?\n!macroend/)
  assert.ok(mode, 'customInstallMode must exist')
  assert.match(mode[0], /\$OrgUpgradeSelected == "1"[\s\S]*?\$OrgUpgradeInstallMode == "all"[\s\S]*?\$\{ifNot\} \$\{UAC_IsAdmin\}[\s\S]*?ShowWindow \$HWNDPARENT \$\{SW_HIDE\}[\s\S]*?!insertmacro UAC_RunElevated/)
  assert.match(mode[0], /MessageBox[\s\S]*?Administrator approval is required/)
})

// THE FALLBACK HAS TO EXIST. Defining customFinishPage takes away the ELSE
// branch of app-builder-lib's assistedInstaller.nsh, and that branch is where
// the stock StartApp function and the MUI_FINISHPAGE_RUN defines live — so this
// page had no launch control at all, while the upgrade failure paths told the
// user to start the application from it.
test('the retained Finish page carries a real launch action, under the original user token', () => {
  const finish = installer.match(/!macro customFinishPage\r?\n[\s\S]*?\r?\n!macroend/)
  assert.ok(finish, 'customFinishPage must exist')
  const body = finish[0]

  assert.match(body, /!define MUI_FINISHPAGE_RUN\r?\n\s*!define MUI_FINISHPAGE_RUN_FUNCTION orgtreeFinishPageRun/)
  assert.match(body, /Function orgtreeFinishPageRun[\s\S]*?\$\{StdUtils\.ExecShellAsUser\} \$1 "\$0" "open" ""/)
  // The target is the installed application, which is GUI-subsystem. Starting
  // it through a script host here would put the console back exactly where the
  // incident put it.
  assert.match(body, /Function orgtreeFinishPageRun[\s\S]*?StrCpy \$0 "\$OrgUpgradeExe"[\s\S]*?\$0 == ""[\s\S]*?\$INSTDIR\\\$\{APP_EXECUTABLE_FILENAME\}/)
  // One owner for the launch: taking it back from a helper that may still be
  // coming happens BEFORE the user's launch, not after it.
  // OWNERSHIP IS TAKEN BEFORE ANYTHING IS STARTED, and losing it is not a
  // reason to start anyway. This is the ordering that makes "exactly once" a
  // property of the kernel rather than of two programs being polite.
  const claim = body.indexOf('Call orgtreeClaimUpgradeLaunch')
  const dispatch = body.indexOf('${StdUtils.ExecShellAsUser} $1 "$0" "open" ""')
  assert.ok(claim >= 0 && dispatch > claim,
    'the Finish page must take launch ownership before it starts anything')
  assert.match(body, /\$OrgUpgradeLaunchOwned == "other"[\s\S]*?MessageBox[\s\S]*?Return/,
    'losing the claim must defer to the owner and say so, not launch a second copy')
  assert.match(body, /\$OrgUpgradeLaunchOwned != "1"[\s\S]*?MessageBox[\s\S]*?Return/,
    'a claim that could not be made must be a visible refusal, not a silent launch')

  // The primitive itself: CREATE_NEW cannot succeed twice, and the two failure
  // reasons are told apart by the error code rather than collapsed.
  assert.match(installer, /Function orgtreeClaimUpgradeLaunch[\s\S]*?kernel32::CreateFileW\(w r9, i 0x40000000, i 0, p 0, i 1, i 0x80, p 0\) p \.r8 \? e/)
  assert.match(installer, /Function orgtreeClaimUpgradeLaunch[\s\S]*?\$7 == 80[\s\S]*?StrCpy \$OrgUpgradeLaunchOwned "other"/)
  assert.match(relaunch, /os\.O_CREAT \| os\.O_EXCL \| os\.O_WRONLY/,
    'the helper must claim with the same exclusive-create primitive')
  // Both sides must name the SAME file, or the claim decides nothing.
  assert.match(installer, /\$OrgUpgradeRelaunchArgs '"\$OrgUpgradeRelaunchDir\\installer-relaunch\.py" \$0 "\$OrgUpgradeExe" "\$OrgUpgradeRelaunchReadyMarker" "\$OrgUpgradeRelaunchClaim"'/)
  // THE IDENTITY IS PER INVOCATION, NOT PER PROCESS ID. The claim file outlives
  // the run that made it and Windows reuses process ids, so a pid-derived name
  // lets an unrelated later install resolve a claim whose owner died weeks ago
  // and refuse to start the application it just installed.
  assert.match(installer, /Function orgtreeResolveUpgradeLaunchClaim[\s\S]*?ole32::CoCreateGuid\(g \.r2\) i \.r3/)
  assert.match(installer, /StrCpy \$OrgUpgradeRelaunchClaim "\$TEMP\\OrgtreeInstallerRelaunch-\$2\.launch-claim"/)
  assert.doesNotMatch(installer, /StrCpy \$OrgUpgradeRelaunchClaim "\$OrgUpgradeRelaunchDir\.launch-claim"/,
    'deriving the claim from the staged directory derives it from the process id, which is the reuse defect')
  // Allocated ONCE and then inherited, never re-derived: an already-set
  // identity is kept, preparation allocates it before the all-users elevation,
  // and the elevated inner instance receives it in preInit.
  assert.match(installer, /Function orgtreeResolveUpgradeLaunchClaim\r?\n\s*\$\{if\} \$OrgUpgradeRelaunchClaim != ""\r?\n\s*Return/)
  assert.match(installer, /Function orgtreePrepareUpgradeRelaunch[\s\S]*?Call orgtreeResolveUpgradeLaunchClaim/)
  assert.match(installer, /UAC_AsUser_GetGlobalVar \$OrgUpgradeRelaunchClaim/,
    'the elevated inner instance must inherit the identity rather than allocate a second one')

  // A CLAIM IS NOT A LAUNCH THAT IS GOING TO HAPPEN. The claim is taken before
  // the acknowledgement, so an unacknowledged helper may still own it — a
  // helper whose marker write failed looks exactly like one that never started.
  // Only an acknowledged owner may be reported as a start that is coming.
  assert.match(body, /\$OrgUpgradeRelaunchAcknowledged == "1"[\s\S]*?Orgtree will start as soon as Setup closes[\s\S]*?\$\{else\}[\s\S]*?finish-run-owner-unknown[\s\S]*?shortcut/,
    'an unacknowledged owner must be reported as unknown and pointed at the shortcut, never promised')
  assert.doesNotMatch(installer, /never acknowledged, so it never took launch ownership/,
    'that claim does not follow from an absent acknowledgement and was the contradictory log line')
  // Ownership is never taken from a party that might still be alive.
  assert.doesNotMatch(installer, /Delete "\$OrgUpgradeRelaunchClaim"/,
    'stealing or replaying somebody else\'s claim is how two copies start')

  // The old protocol must be gone on BOTH sides, not merely unused on one.
  assert.doesNotMatch(installer, /relaunch-withdrawn|orgtreeWithdrawUpgradeRelaunch/,
    'the check-then-act withdrawal was replaced by the claim; leaving it behind gives two arbiters')
  assert.doesNotMatch(relaunch, /relaunch-withdrawn|def cancelled/)

  // A MESSAGE MAY NOT PROMISE A CONTROL THAT IS NOT THERE. This is the guard on
  // the defect itself: the old text said to use Finish on a page that could
  // only close.
  if (/Run Orgtree ticked|start it from Finish|Use Finish to start/i.test(installer)) {
    assert.match(body, /!define MUI_FINISHPAGE_RUN\b/,
      'the installer tells the user the Finish page can start Orgtree, so it must define that action')
  }
})

// THE LIVENESS CONTRACT. The previous helper asked WMI whether the installer
// was still running and treated a FAILED query as "it has exited", which
// launched the application immediately, over a live installer, and exited 0 as
// though it had waited. The replacement waits on a real process handle and
// keeps the three possible answers apart.
test('the relaunch helper waits on a process handle and never guesses', () => {
  // No WMI, no COM, no script host: the dependencies that could not report
  // their own absence are gone.
  assert.doesNotMatch(relaunch, /winmgmts|Win32_Process|ActiveXObject|WScript|win32com/)
  assert.match(relaunch, /kernel32\.OpenProcess\(SYNCHRONIZE, False, pid\)/)
  assert.match(relaunch, /kernel32\.WaitForSingleObject\(handle, timeout_ms\)/)

  // Three answers, three outcomes, and only one of them may launch.
  assert.match(relaunch, /if result == WAIT_OBJECT_0:\r?\n\s*return EXITED/)
  assert.match(relaunch, /if result == WAIT_TIMEOUT:[\s\S]*?return STILL_RUNNING/)
  assert.match(relaunch, /return UNREADABLE/)
  assert.match(relaunch, /if outcome == STILL_RUNNING:\r?\n\s*release_claim\(claim\)\r?\n\s*return EXIT_STILL_RUNNING/)
  assert.match(relaunch, /if outcome != EXITED:[\s\S]*?release_claim\(claim\)\r?\n\s*return EXIT_UNREADABLE/)
  // OWNING THE LAUNCH AND PERFORMING IT ARE DIFFERENT THINGS. Every path that
  // ends without a launch gives the claim back, or it leaves a reservation with
  // no live owner and the installer reads that as "something else is starting".
  assert.match(relaunch, /release_claim\(claim\)\r?\n\s*return EXIT_LAUNCH_FAILED/)
  assert.doesNotMatch(relaunch, /release_claim\(claim\)\r?\n\s*record\("started/,
    'a completed launch keeps its claim: that file is the record of this invocation')
  assert.match(relaunch, /def release_claim\(claim\)[\s\S]*?os\.remove\(claim\)/)
  // A process id that does not exist at all is the one failure that IS an exit:
  // OpenProcess answers ERROR_INVALID_PARAMETER for it, and nothing else.
  assert.match(relaunch, /if error == ERROR_INVALID_PARAMETER:[\s\S]*?return None, EXITED/)
  assert.equal((relaunch.match(/return (?:None, )?EXITED/g) ?? []).length, 2,
    'only "no such process" and a signalled handle may count as an exit')

  // ⚠ ORDER: THE HANDLE, THEN THE ACKNOWLEDGEMENT. The installer reads the
  // marker as permission to close its own Finish page, so writing it before
  // knowing whether this helper can wait at all gives away the user's fallback
  // on a promise that may not be keepable — OpenProcess can still be refused,
  // and a marker that has been read cannot be withdrawn by deleting the file.
  const acquiring = relaunch.search(/^\s*handle, status = acquire\(pid\)\s*$/m)
  const ready = relaunch.search(/^\s*announce_ready\(marker\)\s*$/m)
  const waiting = relaunch.search(/^\s*outcome = wait_on\(handle, pid, timeout_ms\)\s*$/m)
  assert.ok(acquiring >= 0, 'the helper must acquire the handle in its own step')
  assert.ok(ready > acquiring, 'the handle must be acquired BEFORE the acknowledgement is published')
  assert.ok(waiting > ready, 'the acknowledgement must precede the wait, or the installer waits out the upgrade')
  // And an unreadable acquisition must return before the acknowledgement, not
  // merely skip the launch later.
  assert.match(relaunch, /handle, status = acquire\(pid\)\r?\n\s*if status == UNREADABLE:[\s\S]*?return EXIT_UNREADABLE/)

  // HANDLE, THEN OWNERSHIP, THEN ACKNOWLEDGEMENT. Each step is a promise the
  // helper must already be able to keep before it makes it, and the
  // acknowledgement is the one that costs the user their fallback.
  const claiming = relaunch.search(/^\s*ownership = claim_launch\(claim\)\s*$/m)
  assert.ok(claiming > acquiring, 'ownership must be taken after the handle is in hand')
  assert.ok(ready > claiming, 'the claim must be settled BEFORE the acknowledgement is published')
  assert.match(relaunch, /ownership != OWNED:[\s\S]*?return EXIT_OWNED_ELSEWHERE if ownership == OWNED_ELSEWHERE else EXIT_UNCLAIMABLE/)
  // And no second look before launching: re-reading ownership at launch time
  // would be the check-then-act race the claim exists to remove.
  const launching = relaunch.search(/^\s*launch\(executable\)\s*$/m)
  assert.ok(launching > waiting, 'the launch must follow the wait')
  assert.equal((relaunch.match(/^\s*ownership = claim_launch\(claim\)\s*$/gm) ?? []).length, 1,
    'ownership is claimed at exactly one place and never re-checked')
})

// BEHAVIOURAL. The sections above read the source; these RUN the exact helper
// under the exact host the installer names. Nothing here is an installer: the
// "installer" is a throwaway process that sleeps, the "application" is a
// one-line script that appends to a file, and the host is GUI-subsystem, so no
// window appears at any point.
const relaunchHelper = path.join(root, 'tools/installer-relaunch.py')
const helperSkip = process.platform !== 'win32' ? 'Windows only'
  : !engineRuntime ? 'no provisioned engine runtime (engine/runtime/pythonw.exe); set ORGTREE_ENGINE_RUNTIME'
  : false

// The launch is DETACHED, so the helper's own exit does not mean the launched
// process has run yet. Wait for the launch to be observable, then keep waiting
// a little longer: "exactly once" is only a real claim if a second launch would
// have had time to land.
async function settledLaunches(each, expected, timeout = 15000) {
  const deadline = Date.now() + timeout
  while (each.launches() < expected && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  await new Promise(resolve => setTimeout(resolve, 750))
  return each.launches()
}

function discard(directory) {
  // Best effort: the launched stand-in is DETACHED and keeps this directory as
  // its current directory for a moment after it has done its one job, so a
  // removal can still be refused. The contract is what these tests are for; a
  // leftover directory under the system temp path is not worth failing one.
  try {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  } catch {}
}

function helperCase(name) {
  // Each case gets its own copy of the helper, because the helper deletes its
  // own directory on the way out — which is itself part of the contract.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `orgtree-relaunch-${name}-`))
  const staged = path.join(base, 'staged helper')
  fs.mkdirSync(staged)
  const script = path.join(staged, 'installer-relaunch.py')
  fs.copyFileSync(relaunchHelper, script)
  const launchMarker = path.join(base, 'launched.txt')
  const target = path.join(base, 'fake application.cmd')
  fs.writeFileSync(target, `@echo launched>>"${launchMarker}"\r\n@exit 0\r\n`)
  return {
    base, script, target, launchMarker,
    ready: path.join(staged, 'relaunch-started.txt'),
    // BESIDE the staged directory, never inside it — the helper deletes that
    // directory as it exits, and an ownership record that vanishes when one
    // owner finishes is not an ownership record.
    claim: path.join(base, 'relaunch.launch-claim'),
    log: path.join(base, 'orgtree-installer-relaunch.log'),
    env: { ...process.env, ORGTREE_RELAUNCH_LOG_DIR: base },
    launches: () => (fs.existsSync(launchMarker)
      ? fs.readFileSync(launchMarker, 'utf8').split(/\r?\n/).filter(Boolean).length
      : 0),
    logText: () => (fs.existsSync(path.join(base, 'orgtree-installer-relaunch.log'))
      ? fs.readFileSync(path.join(base, 'orgtree-installer-relaunch.log'), 'utf8')
      : ''),
  }
}

// A stand-in for the installer process: it holds a process id for a while and
// then exits. It is Node, not an installer, and it touches nothing.
function livingProcess(ms) {
  return spawn(process.execPath, ['-e', `setTimeout(() => {}, ${ms})`], {
    windowsHide: true, stdio: 'ignore',
  })
}

function runHelper(host, args, options) {
  return spawnSync(host, args, { windowsHide: true, encoding: 'utf8', timeout: 60000, ...options })
}

test('the relaunch helper starts the application exactly once, after the installer exits', {
  skip: helperSkip, timeout: 60000,
}, async () => {
  const each = helperCase('waits')
  const host = path.join(engineRuntime, 'pythonw.exe')
  const installer = livingProcess(4000)
  try {
    const started = Date.now()
    const helper = spawn(host, [each.script, String(installer.pid), each.target, each.ready, each.claim], {
      windowsHide: true, stdio: 'ignore', env: each.env,
    })

    // The acceptance handshake must appear while the installer is still alive —
    // that is the whole point of it, and it is what the installer waits for
    // before it skips its Finish page.
    const deadline = Date.now() + 15000
    while (!fs.existsSync(each.ready) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    assert.ok(fs.existsSync(each.ready), 'the helper never wrote its ready marker')
    assert.equal(each.launches(), 0, 'the application was started while the installer was still running')

    const code = await new Promise(resolve => helper.on('exit', resolve))
    const elapsed = Date.now() - started
    assert.equal(code, 0, `the helper must report success after a completed relaunch: ${each.logText()}`)
    assert.ok(elapsed >= 3000, `the helper returned after ${elapsed}ms, so it cannot have waited out the installer`)
    assert.equal(await settledLaunches(each, 1), 1,
      `the application must be started exactly once: ${each.logText()}`)
    assert.ok(!fs.existsSync(path.dirname(each.script)), 'the helper must remove its own staged copy')
  } finally {
    installer.kill()
    discard(each.base)
  }
})

// THE REGRESSION FOR THE WMI DEFECT. An unreadable process state is not an
// observed exit. PID 4 is the System process: it exists, and OpenProcess is
// refused for it, which is exactly the shape of "I cannot tell".
test('an unreadable installer state never becomes an observed exit', { skip: helperSkip, timeout: 60000 }, () => {
  const each = helperCase('unreadable')
  try {
    const run = runHelper(path.join(engineRuntime, 'pythonw.exe'),
      [each.script, '4', each.target, each.ready, each.claim], { env: each.env })
    assert.equal(run.status, 3,
      `an unreadable state must report its own exit code, not success: ${each.logText()}`)
    assert.equal(each.launches(), 0,
      `nothing may be launched when the installer's state could not be read: ${each.logText()}`)
    assert.match(each.logText(), /could not open installer process 4[\s\S]*not launching/)
    // AND IT MUST NOT HAVE ACKNOWLEDGED. This is the ordering defect: the
    // marker used to be written first, so the installer could read it, skip its
    // Finish page, and only then have this helper refuse to launch — leaving no
    // application and no way to start one. A marker deleted afterwards cannot
    // take back a decision the installer has already made.
    assert.ok(!fs.existsSync(each.ready),
      'a helper that could not acquire the handle must NOT publish the acknowledgement that authorises closing Setup')
  } finally {
    discard(each.base)
  }
})

// The other half of R1: the installer can hand the launch back to the user, and
// a helper that acknowledged late must not then start a second copy.
// EXACTLY ONE LAUNCH, DECIDED BY THE KERNEL. Two parties can start the
// application after an upgrade — this helper and the installer's Finish page
// Run action — and the previous design arbitrated with a flag one side wrote
// and the other read, which is check-then-act: a window between the read and
// the launch, and an unreadable flag was treated as permission to launch and
// let the application's single-instance lock collapse the duplicate. This runs
// two real helpers at the same claim and requires the loser to launch nothing.
test('two helpers racing for one launch produce exactly one launch', {
  skip: helperSkip, timeout: 60000,
}, async () => {
  const each = helperCase('race')
  const installerProcess = livingProcess(2500)
  try {
    const host = path.join(engineRuntime, 'pythonw.exe')
    // Same claim, same stand-in installer, same target: the only thing that can
    // separate them is the claim itself.
    const contenders = ['a', 'b'].map(tag => spawn(host,
      // The acknowledgement markers go BESIDE the staged directory: the winner
      // deletes that directory as it exits, which would take its own marker
      // with it and make "acknowledged" indistinguishable from "never did".
      [each.script, String(installerProcess.pid), each.target, path.join(each.base, `ready-${tag}.txt`), each.claim],
      { windowsHide: true, stdio: 'ignore', env: each.env }))

    const codes = await Promise.all(contenders.map(child =>
      new Promise(resolve => child.on('exit', resolve))))

    assert.equal(await settledLaunches(each, 1), 1,
      `exactly one launch, whatever the scheduling: ${codes} / ${each.logText()}`)
    assert.equal(codes.filter(code => code === 0).length, 1,
      `exactly one contender may report a completed relaunch, got ${codes}`)
    assert.equal(codes.filter(code => code === 6).length, 1,
      `the loser must report that the launch was owned elsewhere, got ${codes}`)
    // And the loser must not have acknowledged either: the acknowledgement is
    // what closes the user's Finish page, so a helper that will never launch
    // must not be the one that takes the fallback away.
    const acknowledgements = ['a', 'b'].filter(tag => fs.existsSync(path.join(each.base, `ready-${tag}.txt`)))
    assert.equal(acknowledgements.length, 1,
      `only the owner of the launch may acknowledge, saw ${acknowledgements.length}`)
    assert.match(each.logText(), /already owned by another party/)
  } finally {
    installerProcess.kill()
    discard(each.base)
  }
})

// THE RESERVATION WITH NO LIVE OWNER. Claim-before-acknowledgement does NOT
// mean "no acknowledgement implies no claim": announcing readiness is
// best-effort, so a helper can own the launch and then fail to write its
// marker. If it then gives up, the claim it leaves behind is a reservation
// nobody will honour — and the installer would read it as a launch that is
// coming. Every path that ends WITHOUT a launch therefore gives the claim back.
test('a helper that owns the launch but gives up releases it again', {
  skip: helperSkip, timeout: 60000,
}, async () => {
  const each = helperCase('reservation')
  const installer = livingProcess(30000)
  try {
    // The marker path is inside a directory that does not exist, which is how
    // an acknowledgement fails while the claim itself succeeds — the shape
    // queue-drain reproduced.
    const unwritable = path.join(each.base, 'no-such-directory', 'relaunch-started.txt')
    const run = runHelper(path.join(engineRuntime, 'pythonw.exe'),
      [each.script, String(installer.pid), each.target, unwritable, each.claim],
      { env: { ...each.env, ORGTREE_RELAUNCH_TIMEOUT_MS: '400' } })

    assert.equal(run.status, 4, `the wait timed out, which is its own exit code: ${each.logText()}`)
    assert.ok(!fs.existsSync(unwritable), 'this case requires the acknowledgement to have failed')
    assert.equal(await settledLaunches(each, 0), 0, 'nothing may be launched over a live installer')
    assert.ok(!fs.existsSync(each.claim),
      'the claim must be released: a helper that is not going to launch must not leave the launch reserved')
    assert.match(each.logText(), /could not write the ready marker/)
    assert.match(each.logText(), /released the launch claim[\s\S]*not left reserved/)
  } finally {
    installer.kill()
    discard(each.base)
  }
})

// The decision that replaced the old behaviour: ownership that cannot be
// ESTABLISHED is a failure, not a licence. The claim here names a directory
// that does not exist, which is the same shape as a permissions refusal.
test('a launch that cannot be claimed is refused, not guessed at', { skip: helperSkip, timeout: 60000 }, async () => {
  const each = helperCase('unclaimable')
  const installerProcess = livingProcess(1)
  await new Promise(resolve => installerProcess.on('exit', resolve))
  try {
    const impossible = path.join(each.base, 'no-such-directory', 'relaunch.launch-claim')
    const run = runHelper(path.join(engineRuntime, 'pythonw.exe'),
      [each.script, String(installerProcess.pid), each.target, each.ready, impossible], { env: each.env })

    assert.equal(run.status, 7,
      `an unestablished claim has its own exit code and is not success: ${each.logText()}`)
    assert.equal(await settledLaunches(each, 0), 0,
      `not knowing whether something else is launching is not permission to launch: ${each.logText()}`)
    assert.ok(!fs.existsSync(each.ready),
      'a helper that could not take ownership must not acknowledge')
    assert.match(each.logText(), /could not establish launch ownership[\s\S]*not launching/)
  } finally {
    discard(each.base)
  }
})

// NEGATIVE CONTROL for the section above. Restore the reviewed behaviour — an
// unreadable state counted as an exit — in a copy of the helper, and the same
// run must launch the application over a process it never observed exiting. If
// this control stops reproducing, the section above proves nothing.
test('the unreadable-state guard is measuring something', { skip: helperSkip, timeout: 60000 }, async () => {
  const each = helperCase('unreadable-control')
  try {
    // Line-ending agnostic on purpose: a literal '\n' anchor does not match a
    // normal CRLF checkout, so the mutation silently does nothing and the
    // control passes by being inert — the exact failure mode a control exists
    // to rule out. The replacement targets the refusal inside acquire(), which
    // is the answer the pre-fix helper did not have.
    const original = fs.readFileSync(each.script, 'utf8')
    const defective = original.replace(/return None, UNREADABLE(\r?\n)/, 'return None, EXITED$1')
    assert.notEqual(defective, original,
      'the control could not restore the pre-fix answer; its anchor moved')
    fs.writeFileSync(each.script, defective)

    const run = runHelper(path.join(engineRuntime, 'pythonw.exe'),
      [each.script, '4', each.target, each.ready, each.claim], { env: each.env })
    assert.equal(run.status, 0, 'CONTROL IS BROKEN: the pre-fix answer was expected to report success')
    assert.equal(await settledLaunches(each, 1), 1,
      'CONTROL IS BROKEN: the pre-fix answer was expected to launch over an unobserved installer')
  } finally {
    discard(each.base)
  }
})

test('an installer that outlives the wait is reported, not overtaken', { skip: helperSkip, timeout: 60000 }, () => {
  const each = helperCase('timeout')
  const installer = livingProcess(30000)
  try {
    const run = runHelper(path.join(engineRuntime, 'pythonw.exe'),
      [each.script, String(installer.pid), each.target, each.ready, each.claim],
      { env: { ...each.env, ORGTREE_RELAUNCH_TIMEOUT_MS: '400' } })
    assert.equal(run.status, 4, `a timed-out wait has its own exit code: ${each.logText()}`)
    assert.equal(each.launches(), 0,
      `starting the application over a live installer is the failure the wait exists to prevent: ${each.logText()}`)
    assert.match(each.logText(), /had not exited after 400 ms[\s\S]*not launching/)
  } finally {
    installer.kill()
    discard(each.base)
  }
})

test('an already-finished installer is launched for immediately, and bad arguments are refused', {
  skip: helperSkip, timeout: 60000,
}, async () => {
  const finished = helperCase('finished')
  const gone = livingProcess(1)
  await new Promise(resolve => gone.on('exit', resolve))
  try {
    const run = runHelper(path.join(engineRuntime, 'pythonw.exe'),
      [finished.script, String(gone.pid), finished.target, finished.ready, finished.claim], { env: finished.env })
    assert.equal(run.status, 0, `an installer that has already exited is not an error: ${finished.logText()}`)
    assert.equal(await settledLaunches(finished, 1), 1, 'the application must still be started exactly once')
  } finally {
    discard(finished.base)
  }

  const bad = helperCase('bad-arguments')
  try {
    const noPid = runHelper(path.join(engineRuntime, 'pythonw.exe'),
      [bad.script, 'not-a-pid', bad.target], { env: bad.env })
    assert.equal(noPid.status, 2, 'an unusable process id must be refused')
    assert.equal(bad.launches(), 0, 'nothing may be launched from unusable arguments')
    assert.match(bad.logText(), /is not a number/)
  } finally {
    discard(bad.base)
  }
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
