// Setup checks the Microsoft Visual C++ runtime the bundled PostgreSQL needs (user 2026-11-12: on a PC with an
// outdated runtime Setup succeeded and the database failed at every start).
//   - tools/vc-runtime.ps1: the decision, in tests/vc-runtime.test.ps1 with every system read, download and
//     process start replaced (nothing is downloaded, installed or run)
//   - build/installer.nsh: the real result handling compiled into an inert, silent NSIS control and run on
//     synthetic results; the PowerShell launch itself is not executed
//   - tools/postgres-layout.mjs: the package gate that keeps Setup's minimum at or above the payload's toolset
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { assertVcRuntimeMinimum, msvcLinkerVersion, vcRuntimeMinimum } from '../tools/postgres-layout.mjs'

const windows = process.platform === 'win32'
const source = fs.readFileSync('build/installer.nsh', 'utf8')
const helper = fs.readFileSync('tools/vc-runtime.ps1', 'utf8')
const compiler = process.env.ORGTREE_MAKENSIS || path.join(process.env.LOCALAPPDATA ?? '', 'electron-builder/Cache/nsis-3.0.4.1/nsis-3.0.4.1-1mx3n/makensis.exe')
const macro = name => {
  const value = source.match(new RegExp(`^!macro ${name}(?:[ \\t]+[^\\r\\n]*)?\\r?\\n[\\s\\S]*?^!macroend`, 'm'))?.[0]
  assert.ok(value, `actual ${name} macro must exist`)
  return value
}
const func = name => source.match(new RegExp(`^[ \\t]*Function ${name}\\r?\\n[\\s\\S]*?^[ \\t]*FunctionEnd`, 'm'))?.[0]

test('the decision: 26 isolated checks of tools/vc-runtime.ps1', { skip: !windows }, () => {
  const run = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', 'tests/vc-runtime.test.ps1'],
    { encoding: 'utf8', windowsHide: true, timeout: 60000 })
  assert.equal(run.status, 0, run.stdout + run.stderr)
  assert.match(run.stdout, /vc-runtime: 26 checks passed/)
})

// One inert control: the real VcRuntimeResult macro and the real logger; no process launch exists in it.
function execute(name, output, exit) {
  assert.ok(fs.existsSync(compiler), 'NSIS compiler is required for an executed verdict')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `orgtree-inert-vc-${name}-`))
  const exe = path.join(dir, 'control.exe'), nsi = path.join(dir, 'control.nsi')
  const result = macro('VcRuntimeResult')
  assert.doesNotMatch(result, /nsExec|powershell|ExecWait|ExecShell|\bExec\b/, 'the result handling launches nothing')
  const code = `Unicode true
!include LogicLib.nsh
!include FileFunc.nsh
Name "Inert Visual C++ runtime control"
OutFile "${exe}"
RequestExecutionLevel user
SilentInstall silent
AutoCloseWindow true
Var OrgLogPath
Var OrgLogStage
Var OrgLogDetail
!define ORGTREE_LOG_MAX_BYTES 262144
${macro('OrgLog')}
${func('orgtreeInstallerLog')}
${result}
Section
  StrCpy $0 "kept-0"
  StrCpy $1 "kept-1"
  StrCpy $2 "kept-2"
  StrCpy $3 "kept-3"
  Push "${output}"
  Push "${exit}"
  !insertmacro VcRuntimeResult
  !insertmacro OrgLog "registers" "$0 $1 $2 $3"
SectionEnd
`
  try {
    fs.writeFileSync(nsi, code, 'utf8')
    const compiled = spawnSync(compiler, ['/V2', nsi], { encoding: 'utf8', windowsHide: true, timeout: 30000 })
    assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr)
    const run = spawnSync(exe, [], { encoding: 'utf8', windowsHide: true, timeout: 10000 })
    assert.equal(run.error, undefined)
    assert.equal(run.status, 0, 'the runtime check never stops Setup')
    const log = path.join(dir, 'orgtree-installer.log')
    return fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : ''
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
}
const warned = log => /\[vc-runtime-warning\]/.test(log)

test('a recent runtime, or one Setup just installed, is logged and warns nobody', { skip: !windows }, () => {
  let log = execute('ok', 'ok|version 14.51.36247.0', '0')
  assert.match(log, /\[vc-runtime\] exit=0; ok\|version 14\.51\.36247\.0/)
  assert.ok(!warned(log), log)
  assert.match(log, /\[registers\] kept-0 kept-1 kept-2 kept-3/, 'the registers the caller holds are restored')
  log = execute('installed', 'installed|version 14.51.36247.0 (was too old: msvcp140.dll 14.29.30139.0)', '0')
  assert.match(log, /\[vc-runtime\] exit=0; installed\|version 14\.51/)
  assert.ok(!warned(log), log)
})

test('every other outcome is logged and warned about, and Setup still completes', { skip: !windows }, () => {
  for (const [name, output, exit] of [
    ['silent', 'needs-runtime|too old: msvcp140.dll 14.29.30139.0', '0'],
    ['offline', 'download-failed|missing: vcruntime140_1.dll; the download failed: The remote name could not be resolved', '0'],
    ['signature', 'signature-refused|too old: msvcp140.dll 14.29.30139.0; the downloaded file was not run: its signature is not valid (NotSigned)', '0'],
    ['failed', 'install-failed|too old: msvcp140.dll 14.29.30139.0; the runtime installer ended with code 1603', '0'],
    ['restart', 'restart-required|too old: msvcp140.dll 14.29.30139.0; the runtime installer asks for a restart of Windows', '0'],
    // the helper itself failed: an "ok" it printed before failing is not believed
    ['helper', 'ok|version 14.51.36247.0', '1'],
    ['nothing', '', 'error'],
  ]) {
    const log = execute(name, output, exit)
    assert.ok(log.includes(`[vc-runtime] exit=${exit}; ${output}`), `${name}: ${log}`)
    assert.ok(warned(log), `${name} must warn: ${log}`)
    assert.match(log, /\[registers\] kept-0 kept-1 kept-2 kept-3/)
  }
  // a status that merely starts like a good one is not one
  assert.ok(warned(execute('prefix', 'okay|', '0')))
})

test('the warning says the database will not start and gives Microsoft\'s link; the same link is downloaded', () => {
  const result = macro('VcRuntimeResult')
  const box = result.match(/MessageBox [^\r\n]+/)?.[0] ?? ''
  assert.match(box, /database will not start until the runtime is installed/)
  assert.match(box, /https:\/\/aka\.ms\/vs\/17\/release\/vc_redist\.x64\.exe/)
  assert.match(box, /\/SD IDOK$/, 'a silent run answers it by itself')
  assert.match(helper, /^\$script:VcRuntimeUrl='https:\/\/aka\.ms\/vs\/17\/release\/vc_redist\.x64\.exe'\r?$/m)
})

test('Setup runs the check after the files are in place, in every build; a silent run only checks', () => {
  const install = macro('customInstall')
  const at = install.indexOf('!insertmacro VcRuntimeRun'), result = install.indexOf('!insertmacro VcRuntimeResult')
  assert.ok(at > 0 && result > at && result < install.indexOf('"install-complete"'), 'run, then result, before the completion line')
  // not inside a channel or install-mode condition: count the conditionals open at that point
  const before = install.slice(0, at)
  const open = text => (text.match(/^\s*(!ifn?def\b|!if\b|\$\{if\})/gm) ?? []).length - (text.match(/^\s*(!endif|\$\{endif\})/gm) ?? []).length
  assert.equal(open(before), 0, 'unconditional')
  const run = macro('VcRuntimeRun')
  const launches = run.match(/nsExec::ExecToStack [^\r\n]+/g) ?? []
  assert.equal(launches.length, 2)
  assert.match(run, /\$\{if\} \$\{Silent\}\r?\n\s*nsExec::ExecToStack [^\r\n]+ -CheckOnly'\r?\n\s*\$\{else\}\r?\n\s*nsExec::ExecToStack [^\r\n]+-WorkDir "\$PLUGINSDIR"'\r?\n/)
  for (const file of ['vc-runtime.ps1', 'ensure-vc-runtime.ps1']) assert.ok(run.includes(`File /oname=$PLUGINSDIR\\${file} "\${PROJECT_DIR}\\tools\\${file}"`), file)
  assert.match(helper, /ArgumentList '\/install','\/quiet','\/norestart'/)
})

// --- the package gate
const pe = (major, minor) => {
  const bytes = Buffer.alloc(0x100)
  bytes.writeUInt16LE(0x5a4d, 0); bytes.writeUInt32LE(0x80, 0x3c); bytes.writeUInt32LE(0x4550, 0x80)
  bytes[0x80 + 26] = major; bytes[0x80 + 27] = minor
  return bytes
}
function payload(t, files) {
  const engine = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-vc-gate-'))
  t.after(() => fs.rmSync(engine, { recursive: true, force: true }))
  for (const [name, bytes] of Object.entries(files)) {
    const full = path.join(engine, 'postgresql', name)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, bytes)
  }
  return engine
}

test('the toolset is read from the PE header; other files and other toolchains are not MSVC binaries', () => {
  assert.deepEqual(msvcLinkerVersion(pe(14, 44)), [14, 44])
  assert.equal(msvcLinkerVersion(pe(2, 44)), null, 'MinGW')
  assert.equal(msvcLinkerVersion(Buffer.from('postgresql/bin/postgres.exe')), null)
  assert.equal(msvcLinkerVersion(Buffer.alloc(0)), null)
  const cut = pe(14, 44); cut.writeUInt32LE(0xfffffff0, 0x3c)
  assert.equal(msvcLinkerVersion(cut), null, 'a header that points outside the file')
})

test('Setup\'s minimum is the one number in tools/vc-runtime.ps1, and a script without it refuses', () => {
  assert.deepEqual(vcRuntimeMinimum(), [14, 44])
  assert.deepEqual(vcRuntimeMinimum("$script:VcRuntimeMinimum=[version]'14.50.0.0'\r\n"), [14, 50])
  assert.throws(() => vcRuntimeMinimum('# nothing'), /no longer states/)
})

test('a payload built by a newer toolset than Setup\'s minimum refuses the package, naming the file', t => {
  const engine = payload(t, { 'bin/postgres.exe': pe(14, 44), 'bin/libintl-9.dll': pe(2, 44), 'lib/plpgsql.dll': pe(14, 40),
    'share/postgres.bki': Buffer.from('text'), 'bin/readme.exe': Buffer.from('not a program') })
  assert.deepEqual(assertVcRuntimeMinimum(engine), { binaries: 2, newest: '14.44', minimum: '14.44' })
  assert.deepEqual(assertVcRuntimeMinimum(engine, [14, 51]), { binaries: 2, newest: '14.44', minimum: '14.51' })
  fs.writeFileSync(path.join(engine, 'postgresql/lib/icuuc78.dll'), pe(14, 50))
  assert.throws(() => assertVcRuntimeMinimum(engine), /needs Visual C\+\+ runtime 14\.50 \(postgresql\/lib\/icuuc78\.dll\), newer than Setup's minimum 14\.44; raise \$script:VcRuntimeMinimum/)
  assert.equal(assertVcRuntimeMinimum(engine, [15, 0]).newest, '14.50')
})

test('the package preflight runs the gate right after the payload check', () => {
  const preflight = fs.readFileSync('tools/package-preflight.mjs', 'utf8')
  assert.match(preflight, /assertPostgresRuntime\('engine', \{ sourceRoot: process\.cwd\(\) \}\)\r?\n[^\r\n]*\r?\n[^\r\n]*assertVcRuntimeMinimum\('engine'\)/)
})
