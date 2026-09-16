// Compile the repository's upgrade-page/mode macros as an isolated NSIS
// fixture. This never writes a registry key, starts an app, or runs an
// installer section; it catches generated-script regressions at the macro
// boundary where electron-builder consumes build/installer.nsh.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { locateEngineRuntime } from './runtime-layout.mjs'

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
const finish = macro('customFinishPage')

// The real OrgLog macro calls orgtreeInstallerLog, which is defined inside
// customHeader — and no fixture here includes customHeader, because these
// fixtures exist to compile the upgrade/mode/finish macros in isolation. Once
// those macros started logging, every fixture stopped compiling with
// `macro named "OrgLog" not found`. The arguments are still expanded into
// StrCpy, so a call site with the wrong argument count still fails here exactly
// as it would in the generated script; only the file write is dropped.
const logStub = `Var OrgFixtureLogStage
Var OrgFixtureLogDetail
!macro OrgLog stage detail
  StrCpy $OrgFixtureLogStage "\${stage}"
  StrCpy $OrgFixtureLogDetail "\${detail}"
!macroend`

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
${logStub}
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
!macro _StubExecShellAsUser _result _exe _verb _args
  # StdUtils answers with a TOKEN ("ok"/"fallback"/errors), never an exit
  # code. The stub must speak the real convention: stubbing "0" here is what
  # hid the 2.1.4-RC4 "(error ok)" failure from this harness.
  StrCpy \`\${_result}\` "ok"
!macroend
!define StdUtils.ExecShellAsUser \`!insertmacro _StubExecShellAsUser\`
${functions}
${finish}
${welcome}
${installMode}
!insertmacro customFinishPage
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

// Exercise the helper-preparation instruction sequence in a compiled NSIS
// executable.  The source-only fixture above cannot observe CopyFiles,
// $PLUGINSDIR extraction, or the Error flag that NSIS carries between
// instructions.  Keep this fixture deliberately small: it extracts the real
// helper, calls the real preparation function, and writes only a marker in a
// temporary path with spaces.
const preparationTemp = path.join(temp, 'installer helper temp path')
fs.mkdirSync(preparationTemp)
const preparationEnv = { ...process.env, TEMP: preparationTemp, TMP: preparationTemp }
const preparationMarker = path.join(temp, 'helper preparation marker.txt')
function preparationFixture(finishMacro, executable, marker) {
  return `!include LogicLib.nsh
!include "${mui}"
Name "Orgtree helper preparation fixture"
OutFile "${executable}"
RequestExecutionLevel user
SilentInstall silent
!define PRODUCT_NAME "Orgtree"
!define APP_EXECUTABLE_FILENAME "Orgtree.exe"
!define UNINSTALL_FILENAME "Uninstall Orgtree.exe"
!define UNINSTALL_DISPLAY_NAME "Orgtree 2.1.3-RC1"
!define UNINSTALL_REGISTRY_KEY "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{fixture-helper}"
!define INSTALL_REGISTRY_KEY "Software\\com.maurdekye.orgtree\\fixture-helper"
!macro _isUpdated _a _b _t _f
  StrCmp "0" "1" \`\${_t}\` \`\${_f}\`
!macroend
!define isUpdated \`"" _isUpdated ""\`
!define orgtreeOriginalIsUpdated \`\${isUpdated}\`
${vars}
${logStub}
!macro _StubExecShellAsUser _result _exe _verb _args
  StrCpy \`\${_result}\` "ok"
!macroend
!define StdUtils.ExecShellAsUser \`!insertmacro _StubExecShellAsUser\`
${finishMacro}
${welcome}
!insertmacro customFinishPage
Var installMode
Function .onInit
  InitPluginsDir
  File /oname=$PLUGINSDIR\\installer-relaunch.py "${path.join(root, 'tools/installer-relaunch.py')}"
FunctionEnd
Section
  # Simulate the stale NSIS error flag left by a failed probe immediately
  # before the page-leave preparation call. The preparation routine must
  # clear and independently check its own filesystem operations.
  FileOpen $R7 "$TEMP\\orgtree-helper-preparation-missing-$HWNDPARENT" r
  Call orgtreePrepareUpgradeRelaunch
  FileOpen $R8 "${marker}" w
  FileWrite $R8 "$OrgUpgradeRelaunchPrepared|$OrgUpgradeRelaunchDir$\\r$\\n"
  FileClose $R8
SectionEnd
`}
const preparationNsi = preparationFixture(finish, path.join(temp, 'helper-preparation-fixture.exe'), preparationMarker)
const preparationFile = path.join(temp, 'helper-preparation-fixture.nsi')
fs.writeFileSync(preparationFile, preparationNsi)
const preparationCompile = spawnSync(compilerPath, ['/V1', preparationFile], {
  encoding: 'utf8', windowsHide: true, timeout: 15000,
})
assert.equal(preparationCompile.status, 0, preparationCompile.stdout + preparationCompile.stderr)
const preparationRun = spawnSync(path.join(temp, 'helper-preparation-fixture.exe'), ['/S'], {
  encoding: 'utf8', windowsHide: true, timeout: 15000, env: preparationEnv,
})
assert.equal(preparationRun.status, 0, preparationRun.stdout + preparationRun.stderr)
assert.ok(fs.existsSync(preparationMarker), 'compiled helper fixture wrote no preparation marker')
const [prepared, preparedDir] = fs.readFileSync(preparationMarker, 'utf8').trim().split('|')
assert.equal(prepared, '1', `compiled helper preparation failed in packaged path: ${preparedDir}`)
assert.ok(preparedDir.includes('OrgtreeInstallerRelaunch-'), `unexpected helper directory: ${preparedDir}`)
assert.ok(preparedDir.startsWith(preparationTemp), `helper directory escaped the configured temp path: ${preparedDir}`)
assert.ok(fs.existsSync(path.join(preparedDir, 'installer-relaunch.py')), 'compiled fixture did not copy the helper')
fs.rmSync(preparedDir, { recursive: true, force: true })
console.log('PASS compiled NSIS helper extraction/preparation path')

// Keep a compiled control using the pre-fix instruction sequence. A failed
// optional FileOpen leaves NSIS's Error flag set; without the two local
// ClearErrors calls, the old routine reports failure despite successful copy.
const legacyFinish = finish
  .replace(/      # Filesystem instructions[\s\S]*?      ClearErrors\r?\n(?=      CreateDirectory)/, '')
  .replace(/      ClearErrors\r?\n(?=      CopyFiles)/, '')
const legacyMarker = path.join(temp, 'legacy helper preparation marker.txt')
const legacyNsi = preparationFixture(
  legacyFinish,
  path.join(temp, 'legacy-helper-preparation-fixture.exe'),
  legacyMarker,
)
const legacyFile = path.join(temp, 'legacy-helper-preparation-fixture.nsi')
fs.writeFileSync(legacyFile, legacyNsi)
const legacyCompile = spawnSync(compilerPath, ['/V1', legacyFile], {
  encoding: 'utf8', windowsHide: true, timeout: 15000,
})
assert.equal(legacyCompile.status, 0, legacyCompile.stdout + legacyCompile.stderr)
const legacyRun = spawnSync(path.join(temp, 'legacy-helper-preparation-fixture.exe'), ['/S'], {
  encoding: 'utf8', windowsHide: true, timeout: 15000, env: preparationEnv,
})
assert.equal(legacyRun.status, 0, legacyRun.stdout + legacyRun.stderr)
const [legacyPrepared, legacyDir] = fs.readFileSync(legacyMarker, 'utf8').trim().split('|')
assert.equal(legacyPrepared, '0', 'legacy helper preparation control unexpectedly ignored stale NSIS Errors')
if (legacyDir && fs.existsSync(legacyDir)) fs.rmSync(legacyDir, { recursive: true, force: true })
console.log('PASS compiled regression reproduces stale NSIS Errors before the fix')

// ---------------------------------------------------------------------------
// REAL StdUtils.dll relaunch dispatch. The 2.1.4-RC4 field failure was the
// dispatch result convention itself — ExecShellAsUser answered "ok" and the
// `$1 != 0` test walked that success into "(error ok)" — so this coverage
// refuses to stub the plugin: it compiles the repository's real dispatch
// function against electron-builder's own StdUtils.dll, lets it start the
// real installer-relaunch.py helper, and watches the helper launch the
// (fixture) executable exactly once after the installer process exits.
const stdUtilsPlugins = (() => {
  if (process.env.ORGTREE_NSIS_PLUGINS) return path.resolve(process.env.ORGTREE_NSIS_PLUGINS)
  const cache = path.join(process.env.LOCALAPPDATA || '', 'electron-builder', 'Cache')
  const resourceRoots = fs.existsSync(cache)
    ? fs.readdirSync(cache).filter(name => name.startsWith('nsis-resources-')).map(name => path.join(cache, name))
    : []
  for (const resourceRoot of resourceRoots) {
    if (!fs.statSync(resourceRoot, { throwIfNoEntry: false })?.isDirectory()) continue
    for (const inner of fs.readdirSync(resourceRoot)) {
      const candidate = path.join(resourceRoot, inner, 'plugins', 'x86-unicode')
      if (fs.existsSync(path.join(candidate, 'StdUtils.dll'))) return candidate
    }
  }
  return null
})()
if (!stdUtilsPlugins) throw new Error('INERT: StdUtils.dll unavailable; set ORGTREE_NSIS_PLUGINS')
const stdUtilsInclude = path.join(root, 'node_modules', 'app-builder-lib', 'templates', 'nsis', 'include')
assert.ok(fs.existsSync(path.join(stdUtilsInclude, 'StdUtils.nsh')), 'app-builder-lib StdUtils.nsh must exist')

const dispatchTemp = path.join(temp, 'dispatch temp with spaces')
fs.mkdirSync(dispatchTemp)
const dispatchEnv = { ...process.env, TEMP: dispatchTemp, TMP: dispatchTemp }

// The relaunch host is the application's OWN pythonw.exe, read out of the
// installed tree, so the fixture needs an $INSTDIR that looks installed. The
// runtime is provisioned rather than committed (engine/runtime is gitignored),
// so it is located rather than assumed, and it is LINKED rather than copied —
// a directory junction needs no privileges and no 100 MB of duplication.
//
// This junction is a throwaway inside the harness temp directory. It is not a
// node_modules link: nothing installs through it, and it is removed with the
// temp tree.
// Located by walking UPWARD: engine/runtime is gitignored, so a linked worktree
// has none of its own and a plain join made this harness INERT there.
const runtimeSource = locateEngineRuntime(root, { marker: 'pythonw.exe' })
if (!runtimeSource) {
  throw new Error('INERT: no provisioned engine runtime (engine/runtime/pythonw.exe); set ORGTREE_ENGINE_RUNTIME')
}
const installRoot = path.join(temp, 'fixture install root')
fs.mkdirSync(path.join(installRoot, 'resources', 'engine'), { recursive: true })
fs.symlinkSync(runtimeSource, path.join(installRoot, 'resources', 'engine', 'runtime'), 'junction')

// THIS HARNESS MUST NOT OPEN A WINDOW, AND SAYING SO IN A COMMENT WAS NOT
// ENOUGH. It used to dispatch console-subsystem powershell.exe from its raw
// plugin probe, so every run flashed a console — the exact class of event this
// whole ticket exists to remove — and the only thing standing between that and
// an agent running it in a headless context was a comment 330 lines in, which
// is where it stayed unread. The subsystem is a fact in the PE header, so read
// it and assert it: a target that regresses to a console image now fails the
// test instead of opening something.
//
// Subsystem lives at offset 0x44 of the optional header in BOTH PE32 and PE32+,
// so this needs no bitness branch. 2 = WINDOWS_GUI, 3 = WINDOWS_CUI.
const PE_SUBSYSTEM_GUI = 2
function peSubsystem(exe) {
  const fd = fs.openSync(exe, 'r')
  try {
    const dos = Buffer.alloc(0x40)
    assert.equal(fs.readSync(fd, dos, 0, 0x40, 0), 0x40, `${exe} is too small to be a PE image`)
    assert.equal(dos.toString('latin1', 0, 2), 'MZ', `${exe} has no MZ header`)
    const peOffset = dos.readUInt32LE(0x3c)
    const optional = Buffer.alloc(0x48)
    const signature = Buffer.alloc(4)
    fs.readSync(fd, signature, 0, 4, peOffset)
    assert.equal(signature.toString('latin1'), 'PE\0\0', `${exe} has no PE signature`)
    // 4 bytes of signature + a 20-byte COFF header precede the optional header.
    assert.equal(fs.readSync(fd, optional, 0, 0x48, peOffset + 24), 0x48,
      `${exe} has a truncated optional header`)
    return optional.readUInt16LE(0x44)
  } finally { fs.closeSync(fd) }
}
function assertWindowlessTarget(exe) {
  const subsystem = peSubsystem(exe)
  assert.equal(subsystem, PE_SUBSYSTEM_GUI,
    `${exe} is PE subsystem ${subsystem}, not GUI (${PE_SUBSYSTEM_GUI}); `
    + 'ShellExecute allocates a console for a console-subsystem image, and this '
    + 'harness is required to stay windowless')
  return exe
}

// The raw probe dispatches the SAME host production dispatches — the fixture's
// own pythonw.exe — rather than a console-subsystem stand-in.
const probeHost = assertWindowlessTarget(
  path.join(installRoot, 'resources', 'engine', 'runtime', 'pythonw.exe'))

function dispatchFixture(finishMacro, executable, resultMarker, launchTarget) {
  return `Unicode true
!include LogicLib.nsh
!include "${mui}"
!addplugindir /x86-unicode "${stdUtilsPlugins}"
!addincludedir "${stdUtilsInclude}"
!include "StdUtils.nsh"
Name "Orgtree relaunch dispatch fixture"
OutFile "${executable}"
RequestExecutionLevel user
SilentInstall silent
!define PRODUCT_NAME "Orgtree"
!define APP_EXECUTABLE_FILENAME "Orgtree.exe"
!define UNINSTALL_FILENAME "Uninstall Orgtree.exe"
!define UNINSTALL_DISPLAY_NAME "Orgtree 2.1.3-RC1"
!define UNINSTALL_REGISTRY_KEY "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{fixture-dispatch}"
!define INSTALL_REGISTRY_KEY "Software\\com.maurdekye.orgtree\\fixture-dispatch"
!macro _isUpdated _a _b _t _f
  StrCmp "0" "1" \`\${_t}\` \`\${_f}\`
!macroend
!define isUpdated \`"" _isUpdated ""\`
!define orgtreeOriginalIsUpdated \`\${isUpdated}\`
${vars}
${logStub}
${finishMacro}
${welcome}
!insertmacro customFinishPage
Var installMode
Var rawToken
Function .onInit
  InitPluginsDir
  File /oname=$PLUGINSDIR\\installer-relaunch.py "${path.join(root, 'tools/installer-relaunch.py')}"
  # The dispatch reads its host out of the installed tree, so the fixture has to
  # look like one: $INSTDIR\\resources\\engine\\runtime\\pythonw.exe must exist
  # or the real function refuses to schedule anything, which is the guard this
  # fixture is not trying to exercise.
  StrCpy $INSTDIR "${installRoot.replaceAll('\\', '\\\\')}"
FunctionEnd
Section
  # Raw plugin contract, no stubs: the same call shape production uses. This
  # records what the DLL actually answers so the routing below is checked
  # against evidence rather than against an assumed convention.
  # ⚠ THE TARGET IS THE FIXTURE'S OWN pythonw.exe, AND THAT IS LOAD-BEARING.
  # This probe used to dispatch powershell.exe to keep its reading comparable
  # with the 2.1.4-RC4 evidence, and it flashed a console on every run:
  # ShellExecute allocates one for a console-subsystem image, which is the very
  # incident this work exists for. That comparability argument does not survive
  # contact with what is actually being measured — the token ExecShellAsUser
  # answers is a property of the DISPATCH, not of the target's subsystem — so
  # the historical target bought nothing and cost a visible window. This now
  # dispatches the same GUI-subsystem host production dispatches, which is also
  # the one .onInit already guarantees exists. The "-c pass" argument starts a
  # runtime that immediately exits. The subsystem is read out of the PE header before this
  # fixture is compiled (see assertWindowlessTarget), so a target that regresses
  # to a console image is a test FAILURE rather than another flash.
  \${StdUtils.ExecShellAsUser} $rawToken "${probeHost.replaceAll('\\', '\\\\')}" "open" "-c pass"
  Call orgtreePrepareUpgradeRelaunch
  StrCpy $OrgUpgradeExe "${launchTarget}"
  Call orgtreeDispatchUpgradeRelaunch
  FileOpen $R8 "${resultMarker}" w
  FileWrite $R8 "$rawToken|$OrgUpgradeRelaunchPrepared|$OrgUpgradeRelaunchScheduled|$OrgUpgradeRelaunchReady$\\r$\\n"
  FileClose $R8
SectionEnd
`}

const launchMarker = path.join(temp, 'dispatch launch marker.txt')
const launchTarget = path.join(temp, 'dispatch launch target.cmd')
fs.writeFileSync(launchTarget, `@echo launched>>"${launchMarker}"\r\n@exit 0\r\n`)

async function runDispatchFixture(name, finishMacro) {
  const executable = path.join(temp, `${name}.exe`)
  const resultMarker = path.join(temp, `${name} result.txt`)
  const file = path.join(temp, `${name}.nsi`)
  fs.writeFileSync(file, dispatchFixture(finishMacro, executable, resultMarker, launchTarget))
  const compiled = spawnSync(compilerPath, ['/V1', file], { encoding: 'utf8', windowsHide: true, timeout: 30000 })
  assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr)
  const run = spawnSync(executable, ['/S'], { encoding: 'utf8', windowsHide: true, timeout: 30000, env: dispatchEnv })
  assert.equal(run.status, 0, run.stdout + run.stderr)
  assert.ok(fs.existsSync(resultMarker), `compiled dispatch fixture ${name} wrote no result marker`)
  // The staged helper waits for THIS fixture process to exit, then performs
  // its single launch. Wait for that observable launch rather than sleeping.
  const deadline = Date.now() + 30000
  while (!fs.existsSync(launchMarker) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  assert.ok(fs.existsSync(launchMarker), `the relaunch helper never launched the fixture executable (${name})`)
  // Give a hypothetical second launch time to land, then require exactly one.
  await new Promise(resolve => setTimeout(resolve, 1500))
  const launches = fs.readFileSync(launchMarker, 'utf8').split(/\r?\n/).filter(Boolean)
  assert.equal(launches.length, 1, `the helper must launch exactly once, saw ${launches.length} (${name})`)
  fs.rmSync(launchMarker, { force: true })
  return fs.readFileSync(resultMarker, 'utf8').trim().split('|')
}

const [rawToken, dispatchPrepared, dispatchScheduled, dispatchReady] =
  await runDispatchFixture('dispatch-fixture', finish)
assert.equal(dispatchPrepared, '1', 'real dispatch fixture failed helper preparation')
assert.ok(rawToken === 'ok' || rawToken === 'fallback',
  `StdUtils.ExecShellAsUser answered ${JSON.stringify(rawToken)}, not a success token`)
assert.notEqual(rawToken, '0', 'the plugin does not answer numeric 0 on success; stubs must not either')
assert.equal(dispatchScheduled, '1', `fixed routing rejected the real success token ${JSON.stringify(rawToken)}`)
assert.equal(dispatchReady, '1', 'fixed routing did not mark the relaunch ready (Finish page would stay up)')
console.log(`PASS real StdUtils dispatch: token ${rawToken}, scheduled once, single launch after exit`)

// Pre-fix control: restore the released 2.1.4-RC4 result test (`$1 != 0`) on
// the same real-DLL path. The dispatch itself still succeeds — the helper
// launches — while the installer reports failure and never marks the
// relaunch scheduled. That mismatch is exactly the "(error ok)" field report.
//
// ⚠ ANCHOR THE TRANSFORM TO THE DISPATCH FUNCTION, NOT TO THE FIRST MATCH.
// `customFinishPage` holds more than one `$1 == "ok"` token test: f444d2e added
// `Function orgtreeFinishPageRun` AHEAD of `orgtreeDispatchUpgradeRelaunch` and
// routes the same token the same way. A bare non-global `.replace()` therefore
// rewrote the Finish page's Run action — which this fixture never calls — and
// left the routing under test fixed, so the control silently stopped
// controlling while still passing the "did the transform change anything" guard
// below. Slicing to the dispatch function first, and requiring exactly one
// rewrite inside it, makes the next function inserted above it fail loudly
// instead of quietly retargeting this control.
const dispatchFnStart = finish.indexOf('Function orgtreeDispatchUpgradeRelaunch')
assert.ok(dispatchFnStart > 0, 'customFinishPage must define orgtreeDispatchUpgradeRelaunch')
const tokenTest = /\$\{if\} \$1 == "ok"\r?\n\s*\$\{orif\} \$1 == "fallback"/g
const beforeDispatchFn = finish.slice(0, dispatchFnStart)
const fromDispatchFn = finish.slice(dispatchFnStart)
assert.equal((fromDispatchFn.match(tokenTest) ?? []).length, 1,
  'the dispatch function must hold exactly one token test for this control to rewrite')
const legacyDispatch = beforeDispatchFn + fromDispatchFn.replace(tokenTest, '${if} $1 == 0')
assert.notEqual(legacyDispatch, finish, 'legacy dispatch control transform must change the routing')
assert.equal(legacyDispatch.slice(0, dispatchFnStart), beforeDispatchFn,
  'the control must not modify anything ahead of the dispatch function')
const [legacyToken, legacyDispatchPrepared, legacyScheduled, legacyReady] =
  await runDispatchFixture('legacy-dispatch-fixture', legacyDispatch)
assert.equal(legacyDispatchPrepared, '1', 'legacy control failed helper preparation')
assert.ok(legacyToken === 'ok' || legacyToken === 'fallback', `unexpected legacy control token ${JSON.stringify(legacyToken)}`)
// NSIS variables start empty, and the legacy failure branch never writes
// them — "not scheduled" is the assertion, whatever its spelling.
assert.notEqual(legacyScheduled, '1', 'legacy numeric routing unexpectedly accepted the token; control lost its meaning')
assert.notEqual(legacyReady, '1', 'legacy numeric routing unexpectedly marked the relaunch ready')
console.log('PASS compiled control reproduces the RC4 "(error ok)" success-treated-as-failure with the real DLL')
