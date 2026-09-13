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

function runHelper (directory, launcher, timeoutSeconds) {
  const done = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper,
    '-InstallDir', directory, '-ExecutablePath', launcher, '-TimeoutSeconds', String(timeoutSeconds)], { encoding: 'utf8', windowsHide: true })
  return { status: done.status, stdout: (done.stdout || '').trim(), stderr: (done.stderr || '').trim() }
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
