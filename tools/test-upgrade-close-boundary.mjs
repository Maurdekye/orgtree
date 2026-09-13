// Boundary regression for the installer's graceful close.
//
// Every other upgrade test in this repository reads source text or re-implements
// the detection rules in JavaScript. Neither can see the failure that shipped in
// 2.1.3-RC1, because that failure only exists where a NEW installer meets an
// ALREADY-RUNNING OLD application. This test builds that boundary for real: it
// materialises a disposable packaged copy of a process double (tests/fixtures/
// legacy-desktop), starts it, and runs the REAL tools/installer-upgrade.ps1
// against it.
//
// The double never borrows the installed application's identity, and the helper
// is always pointed at the disposable copy, so no installed Orgtree is touched.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const fixtureSource = path.join(root, 'tests/fixtures/legacy-desktop')
const helper = path.join(root, 'tools/installer-upgrade.ps1')
const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe')

function electronRuntime () {
  if (process.env.ORGTREE_ELECTRON_EXE) return process.env.ORGTREE_ELECTRON_EXE
  try {
    const executable = createRequire(import.meta.url)('electron')
    return typeof executable === 'string' && fs.existsSync(executable) ? executable : undefined
  } catch { return undefined }
}

const runtime = electronRuntime()
if (!runtime) {
  console.log('SKIP: no Electron runtime available (set ORGTREE_ELECTRON_EXE to the electron.exe to test against).')
  process.exit(0)
}
if (process.platform !== 'win32') {
  console.log('SKIP: the installer close boundary is Windows-only.')
  process.exit(0)
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** Materialise a disposable packaged copy whose launcher is named exactly like
 *  the installed application, because the helper path-verifies by file name
 *  inside the recorded directory. Hard links keep this cheap; a copy is the
 *  fallback when linking is refused. */
function materialiseInstall (directory, mode) {
  const runtimeRoot = path.dirname(runtime)
  fs.mkdirSync(directory, { recursive: true })
  const walk = (from, to) => {
    fs.mkdirSync(to, { recursive: true })
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      const source = path.join(from, entry.name)
      const target = path.join(to, entry.name)
      if (entry.isDirectory()) { walk(source, target); continue }
      if (!entry.isFile()) continue
      try { fs.linkSync(source, target) } catch { fs.copyFileSync(source, target) }
    }
  }
  walk(runtimeRoot, directory)
  const launcher = path.join(directory, 'Orgtree.exe')
  fs.renameSync(path.join(directory, path.basename(runtime)), launcher)
  // An upgrade candidate must look like one on disk as well.
  fs.writeFileSync(path.join(directory, 'Uninstall Orgtree.exe'), '')
  const appDirectory = path.join(directory, 'resources/app')
  fs.mkdirSync(appDirectory, { recursive: true })
  for (const name of ['main.js', 'engine-double.js']) fs.copyFileSync(path.join(fixtureSource, name), path.join(appDirectory, name))
  fs.writeFileSync(path.join(appDirectory, 'package.json'), JSON.stringify({ name: 'orgtree-upgrade-fixture', version: '0.0.0', main: 'main.js' }))
  fs.writeFileSync(path.join(appDirectory, 'mode.txt'), mode)
  return { launcher, log: path.join(appDirectory, 'events.log'), lock: path.join(appDirectory, 'engine.lock') }
}

function events (log) {
  if (!fs.existsSync(log)) return []
  return fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(line => { try { return JSON.parse(line) } catch { return null } }).filter(Boolean)
}

async function waitForEvent (log, name, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (events(log).some(entry => entry.event === name)) return true
    await sleep(150)
  }
  return false
}

function alive (pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}

async function waitForExit (pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!alive(pid)) return true
    await sleep(150)
  }
  return !alive(pid)
}

/** Send a window message to every top-level window owned by a process. This is
 *  the mechanism an installer has when the running application understands no
 *  control argument of its own. */
function sendWindowMessage (pid, messages) {
  const script = `
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class OrgtreeWin {
  public delegate bool EnumProc(IntPtr handle, IntPtr param);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr param);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr handle, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr SendMessageTimeout(IntPtr handle, uint message, IntPtr wparam, IntPtr lparam, uint flags, uint timeout, out IntPtr result);
  public static List<IntPtr> Windows(uint wanted) {
    List<IntPtr> found = new List<IntPtr>();
    EnumWindows(delegate(IntPtr handle, IntPtr param) {
      uint pid; GetWindowThreadProcessId(handle, out pid);
      if (pid == wanted) found.Add(handle);
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
"@
$windows = [OrgtreeWin]::Windows(${pid})
Write-Output ("windows=" + $windows.Count)
foreach ($window in $windows) {
  foreach ($message in @(${messages.map(m => `@{ id = ${m.id}; wparam = ${m.wparam ?? 0}; lparam = ${m.lparam ?? 0} }`).join(',')})) {
    $result = [IntPtr]::Zero
    [void][OrgtreeWin]::SendMessageTimeout($window, [uint32]$message.id, [IntPtr]$message.wparam, [IntPtr]$message.lparam, 0x0002, 4000, [ref]$result)
  }
}
`
  const done = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { encoding: 'utf8', windowsHide: true })
  return { status: done.status, stdout: (done.stdout || '').trim(), stderr: (done.stderr || '').trim() }
}

// NSIS is a 32-bit process, so its `$SYSDIR` is redirected by WOW64 and the
// helper actually runs under SysWOW64's PowerShell, never the 64-bit one every
// earlier test used. The host is selectable here so that difference is measured
// rather than assumed.
const powershell32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'SysWOW64/WindowsPowerShell/v1.0/powershell.exe')

const psLiteral = value => `'${String(value).replace(/'/g, "''")}'`

function runHelper (directory, launcher, timeoutSeconds, options = {}) {
  const host = options.host ?? powershell
  const logPath = options.logPath ?? path.join(directory, 'installer-upgrade.log')
  const installDir = options.installDir ?? directory
  const common = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass']
  let args
  if (options.breakCommands?.length) {
    // Shadow a cmdlet the helper depends on, in the session that invokes it, to
    // make a real read failure happen at a point no fixture can otherwise
    // reach. A function defined here is inherited by the invoked script.
    // Two ways to break a cmdlet, and the difference is the whole point of the
    // fail-closed case. `throw` is terminating and no -ErrorAction can swallow
    // it. A NON-TERMINATING error is the dangerous one: it is exactly what a
    // caller written with `-ErrorAction SilentlyContinue` discards, turning a
    // failed read into an empty result. These shadows declare [CmdletBinding()]
    // so they honour the caller's -ErrorAction the way a real cmdlet does.
    const shadows = options.breakCommands.map(name => options.breakMode === 'non-terminating'
      ? `function ${name} { [CmdletBinding()] param([Parameter(ValueFromRemainingArguments=$true)] $Rest) Write-Error 'forced ${name} failure' }`
      : `function ${name} { throw 'forced ${name} failure' }`).join('\n')
    args = [...common, '-Command', [
      shadows,
      `& ${psLiteral(helper)} -InstallDir ${psLiteral(installDir)} -ExecutablePath ${psLiteral(launcher)}` +
        ` -TimeoutSeconds ${Number(timeoutSeconds)} -LogPath ${psLiteral(logPath)}`,
      'exit $LASTEXITCODE',
    ].join('\n')]
  } else {
    args = [...common, '-File', helper,
      '-InstallDir', installDir, '-ExecutablePath', launcher, '-TimeoutSeconds', String(timeoutSeconds)]
    if (logPath) args.push('-LogPath', logPath)
  }
  const done = spawnSync(host, args, { encoding: 'utf8', windowsHide: true })
  const log = logPath && fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : ''
  return { status: done.status, stdout: (done.stdout || '').trim(), stderr: (done.stderr || '').trim(), log, logPath }
}

// Resolved to its real long form: os.tmpdir() can report an 8.3 short path, and
// the installed application's own single-instance identity is derived from the
// path it was started from.
const workspace = fs.realpathSync.native(fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'orgtree-upgrade-boundary-')))
const started = []
const cases = []

function report (name, run) { cases.push({ name, run }) }

async function startInstalledApp (directory) {
  const child = spawn(path.join(directory, 'Orgtree.exe'), [], { stdio: 'ignore', windowsHide: false, detached: false })
  started.push(child)
  return child
}

let scenarios = 0
async function scenario (mode, body) {
  const directory = path.join(workspace, `${mode}-${scenarios++}`)
  const { launcher, log, lock } = materialiseInstall(directory, mode)
  const child = await startInstalledApp(directory)
  assert.ok(await waitForEvent(log, 'ready', 60000), `${mode} fixture never reached ready`)
  assert.ok(fs.existsSync(lock), 'the fixture engine never took its install-directory handle')
  try { return await body({ directory, launcher, log, lock, child }) } finally {
    if (alive(child.pid)) { try { child.kill('SIGKILL') } catch { /* already gone */ } }
    await waitForExit(child.pid, 5000)
  }
}

report('an installed app WITHOUT the control argument is not closed by it, and nothing is force-killed', () => scenario('legacy', async ({ directory, launcher, log, child }) => {
  const result = runHelper(directory, launcher, 8)
  assert.notEqual(result.status, 0, 'the helper reported success against an app that never closed')
  assert.match(result.stderr, /did not close within/i)
  assert.ok(alive(child.pid), 'the legacy app must be left running for Retry or Cancel')
  const seen = events(log)
  assert.ok(seen.some(entry => entry.event === 'second-instance' && entry.detail?.upgrade === true), 'the control request never reached the running app')
  assert.ok(seen.some(entry => entry.event === 'show'), 'a legacy app answers the control request by raising its window')
  assert.ok(!seen.some(entry => entry.event === 'quit-complete'), 'the legacy app must not have quit')
}))

report('an installed app WITH the control argument closes gracefully and releases its engine', () => scenario('modern', async ({ directory, launcher, log, lock, child }) => {
  const result = runHelper(directory, launcher, 30)
  assert.equal(result.status, 0, `graceful close failed: ${result.stderr}`)
  assert.ok(await waitForExit(child.pid, 5000), 'the app process survived a successful graceful close')
  const seen = events(log)
  assert.ok(seen.some(entry => entry.event === 'installer-upgrade-shutdown-start'), 'the dedicated shutdown path never ran')
  assert.ok(seen.some(entry => entry.event === 'engine-exit'), 'the managed engine was never released')
  assert.ok(!fs.existsSync(lock), 'the engine kept its handle on the install directory')
}))

// 2.1.3-RC1 failed in the real installer with the bare words "Argument types do
// not match" and nothing else: no step, no log, and no line of its own output.
// The cause is fixed and pinned by a regression in tests/installer-upgrade.test.mjs;
// these cases are about the other half — that reading that dialog took two
// release candidates because the helper said nothing about where it was.
report('the helper runs under the 32-bit PowerShell the installer actually launches', () => scenario('modern', async ({ directory, launcher, child }) => {
  if (!fs.existsSync(powershell32)) { console.log('    (no SysWOW64 PowerShell on this machine)'); return }
  const result = runHelper(directory, launcher, 30, { host: powershell32 })
  assert.equal(result.status, 0, `graceful close failed under the 32-bit host: ${result.stderr}`)
  assert.ok(await waitForExit(child.pid, 5000), 'the app survived a successful close under the 32-bit host')
}))

report('a lifecycle record is written for a successful close', () => scenario('modern', async ({ directory, launcher }) => {
  const result = runHelper(directory, launcher, 30)
  assert.equal(result.status, 0, `graceful close failed: ${result.stderr}`)
  for (const expected of ['step canonicalize-paths', 'step detect-running-processes', 'step request-graceful-shutdown', 'step await-exit', 'result: closed gracefully']) {
    assert.ok(result.log.includes(expected), `the lifecycle log never recorded "${expected}":\n${result.log}`)
  }
}))

report('a failure names the step it happened in, on screen and in the log', () => scenario('modern', async ({ directory, launcher }) => {
  // An executable outside the recorded directory is the cheapest way to make a
  // real failure happen before the app is ever asked to close.
  const elsewhere = path.join(workspace, 'elsewhere')
  fs.mkdirSync(elsewhere, { recursive: true })
  const result = runHelper(directory, launcher, 8, { installDir: elsewhere })
  assert.notEqual(result.status, 0, 'a mismatched executable location must not report success')
  assert.match(result.stderr, /^\[[a-z-]+\]/m, `the failure reached the user with no step tag: ${result.stderr}`)
  assert.match(result.stderr, /\[verify-executable-location\]/, `wrong step reported: ${result.stderr}`)
  assert.match(result.stderr, /installer-upgrade\.log/, 'the failure never told the user where the log is')
  assert.ok(result.log.includes('failure: [verify-executable-location]'), `the log did not record the failing step:\n${result.log}`)
  assert.ok(!result.stdout.includes('Requesting a graceful'), 'nothing may be requested when the location check fails')
}))

// The helper replaced the overloaded .NET statics it could, but two
// single-overload ones remain because nothing else normalizes a path the same
// way, and they sit in the same region RC1 died in. Leaving them there on the
// argument that they "cannot" be ambiguous is exactly the reasoning that cleared
// `New-Object` on its constructor alone while the full sequence was broken, so
// they are measured instead — in both hosts, across the path shapes the
// installer actually hands the helper.
report('path canonicalization is measured in both PowerShell hosts, not assumed', () => {
  const shapes = [
    ['C:\\Program Files\\Orgtree', 'C:\\Program Files\\Orgtree'],
    ['C:\\Program Files\\Orgtree\\Orgtree.exe', 'C:\\Program Files\\Orgtree\\Orgtree.exe'],
    ['C:\\Program Files\\Orgtree\\.\\..\\Orgtree\\Orgtree.exe', 'C:\\Program Files\\Orgtree\\Orgtree.exe'],
    ['C:\\Program Files\\Org tree\\Orgtree.exe', 'C:\\Program Files\\Org tree\\Orgtree.exe'],
    ['\\\\server\\share\\Orgtree\\Orgtree.exe', '\\\\server\\share\\Orgtree\\Orgtree.exe'],
  ]
  const script = shapes.map(([input]) =>
    `try { [Console]::Out.WriteLine([IO.Path]::GetFullPath(${psLiteral(input)})) }` +
    ` catch { [Console]::Out.WriteLine('THREW ' + $_.Exception.GetType().Name + ': ' + $_.Exception.Message) }`).join('\n') +
    `\n[Console]::Out.WriteLine([IO.Path]::GetFileNameWithoutExtension('Orgtree.exe'))`
  for (const host of [powershell, powershell32]) {
    if (!fs.existsSync(host)) continue
    const done = spawnSync(host, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { encoding: 'utf8', windowsHide: true })
    assert.equal(done.status, 0, `${host} could not run the canonicalization probe: ${done.stderr}`)
    const lines = (done.stdout || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean)
    shapes.forEach(([input, expected], index) => {
      assert.equal(lines[index], expected, `${path.basename(path.dirname(path.dirname(host)))} normalized ${input} to ${lines[index]}`)
    })
    assert.equal(lines[shapes.length], 'Orgtree', 'the executable base name did not resolve')
  }
})

// The fail-safe direction, which is the one an installer cannot get wrong: it
// is about to replace the files the application is running from. Deciding
// success by scanning for processes that still match the executable path reads
// IDENTICALLY whether everything has closed or nothing could be read — and the
// environment this helper fails in is exactly one where reading fails. So
// success has to be positive proof that the processes identified BEFORE the
// request have gone, by id, and anything unverifiable has to count as alive.
report('a post-request read failure can never be reported as a successful close', () => scenario('legacy', async ({ directory, launcher, child }) => {
  // The legacy fixture never closes, so the application is demonstrably still
  // running while the helper is unable to verify anything about it.
  const result = runHelper(directory, launcher, 8, { breakCommands: ['Get-Process'] })
  assert.equal(result.status, 2, `an unverifiable close was reported as success: status=${result.status} ${result.stdout}`)
  assert.ok(alive(child.pid), 'the application must be left running')
  assert.ok(result.log.includes('step request-graceful-shutdown'), `the request never went out, so this proves nothing about the post-request path:\n${result.log}`)
  assert.doesNotMatch(result.stdout, /closed gracefully/i)
}))

// The same inversion by a different door. If BOTH readings of the process table
// fail, the helper must say so. An empty result can only ever mean "nothing
// matched", never "nothing could be read" — because empty means "already
// closed", and "already closed" means an installer that proceeds to replace the
// files of an application that is, in this scenario, demonstrably still running.
report('a total detection failure is reported, never read as already closed', () => scenario('legacy', async ({ directory, launcher, child }) => {
  // NON-TERMINATING errors specifically. A previous version of the fallback read
  // the table with `Get-Process -Name X -ErrorAction SilentlyContinue`, which
  // discards exactly this kind of failure and hands back an empty collection —
  // indistinguishable from "nothing is running", and therefore reported as
  // "already closed". A terminating `throw` would not have caught that, because
  // no -ErrorAction can swallow one; this is the shape that does.
  for (const breakMode of ['non-terminating', 'throw']) {
    const result = runHelper(directory, launcher, 8, { breakCommands: ['Get-CimInstance', 'Get-Process'], breakMode })
    assert.equal(result.status, 2, `${breakMode}: detection failure did not report failure: status=${result.status} ${result.stdout}`)
    assert.doesNotMatch(result.stdout, /already closed/i, `${breakMode}: an unreadable process table was reported as a closed application`)
    assert.doesNotMatch(result.stdout, /Requesting a graceful/i, `${breakMode}: nothing may be requested when detection failed`)
    assert.match(result.stderr, /\[detect-running-processes\]/, `${breakMode}: the failure did not name the detection step: ${result.stderr}`)
    assert.ok(alive(child.pid), `${breakMode}: the application must be left running`)
  }
}))

report('an application that did close is still not reported closed without proof', () => scenario('modern', async ({ directory, launcher }) => {
  // Same fixture that closes cleanly and exits 0 in the case above. With the
  // exit unverifiable, the answer must degrade to failure — Retry and Cancel
  // both leave the installation intact, and a wrong success does not.
  const result = runHelper(directory, launcher, 8, { breakCommands: ['Get-Process'] })
  assert.equal(result.status, 2, `success was claimed without verifying a single exit: status=${result.status}`)
  assert.doesNotMatch(result.stdout, /closed gracefully/i)
}))

// Why the installer sends a control request instead of a window message. Both
// alternatives are measured here rather than argued about, so that adopting one
// of them later has to start by contradicting a recorded result.
report('no window message is a graceful close for an app that lacks the control argument', () => scenario('legacy', async ({ log, lock, child }) => {
  const enginePid = () => events(log).find(entry => entry.event === 'engine-start')?.detail?.pid

  // WM_CLOSE is what `taskkill` without /F sends. The product hides to the tray.
  const close = sendWindowMessage(child.pid, [{ id: 0x0010 }])
  assert.equal(close.status, 0, `could not enumerate the app's windows: ${close.stderr}`)
  await sleep(3000)
  assert.ok(events(log).some(entry => entry.event === 'window-close-hidden'), 'WM_CLOSE did not reach the window')
  assert.ok(alive(child.pid), 'WM_CLOSE only hides the window; treating it as a close would be wrong')
  assert.ok(alive(enginePid()), 'the engine keeps running after WM_CLOSE')
  assert.ok(fs.existsSync(lock), 'the engine keeps its handle on the install directory after WM_CLOSE')

  // An end-session message does end the process — by skipping its shutdown.
  const end = sendWindowMessage(child.pid, [{ id: 0x0011, wparam: 0, lparam: 1 }, { id: 0x0016, wparam: 1, lparam: 1 }])
  assert.equal(end.status, 0, `could not enumerate the app's windows: ${end.stderr}`)
  assert.ok(await waitForExit(child.pid, 15000), 'end-session did not end the process')
  const seen = events(log)
  assert.ok(!seen.some(entry => entry.event === 'before-quit'), 'end-session ran no shutdown handler, so it is a forced exit in effect')
  assert.ok(!seen.some(entry => entry.event === 'quit-complete'), 'end-session never completes the application quit')
  assert.ok(fs.existsSync(lock), 'end-session strands the managed engine holding the install directory')
  if (alive(enginePid())) { try { process.kill(enginePid(), 'SIGKILL') } catch { /* already gone */ } }
}))

const results = []
for (const item of cases) {
  try { await item.run(); results.push({ name: item.name, ok: true }) } catch (error) { results.push({ name: item.name, ok: false, error }) }
}

if (process.env.ORGTREE_KEEP_WORKSPACE) console.log(`workspace kept at ${workspace}`)
else fs.rmSync(workspace, { recursive: true, force: true })

let failures = 0
for (const result of results) {
  if (result.ok) console.log(`ok - ${result.name}`)
  else { failures++; console.log(`not ok - ${result.name}\n    ${result.error?.message ?? result.error}`) }
}
console.log(`\n${results.length - failures}/${results.length} passed`)
process.exit(failures === 0 ? 0 : 1)
