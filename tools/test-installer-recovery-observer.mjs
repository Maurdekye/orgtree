// Boundary regression: the installer meets the desktop's core-recovery observer
// (docket installer-can-t-replace-a-running-orgtree-an-ins, 2026-10-14).
//
// Two real upgrades from 4.3.0-alpha.0 to alpha.1 failed in Prepare with "did
// not stop within 150 seconds": after Setup closed the desktop, its observer
// (`resources\engine\orgtree-engine.exe core-recovery watch ...`) waited out the
// 180-second installer allowance from the engine folder, then relaunched the
// old application. This builds that boundary for real, in miniature: a scratch
// installation folder holding a real engine binary, a scratch data root with a
// lifecycle journal, the native stand-in desktop and engine
// (tools/rig/core-recovery-fixture.rs), the observer armed by the binary itself,
// and the REAL installer scripts (boot-engine-task.ps1 Stop-OwnedBootTask and
// installer-upgrade.ps1). Only the scheduled task is a test double. Nothing
// touches the live installation, its data root, tasks or processes: every path
// is under --out, and the close helper is pinned to the scratch data root.
//
//   node tools/test-installer-recovery-observer.mjs --out <empty dir>
//     --fixture <core-recovery-fixture.exe> --old <engine.exe> --new <engine.exe>
//     --base <tree holding the base tools/> --tip <tree holding the tip tools/>
//     [--diag <tree holding an intermediate tools/>] [--only S1,S3,...]
//
// --old is an engine whose observer waits out the allowance (alpha.0/alpha.1
// source); --new one that stands down. The allowance here is 30 s against a
// 20 s installer budget, the same shape as 180 s against 150 s.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'

if (process.platform !== 'win32') { console.log('SKIP: Windows only'); process.exit(0) }
const arg = name => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : undefined }
const out = path.resolve(arg('out') || '')
const fixture = arg('fixture'), oldEngine = arg('old'), newEngine = arg('new')
const trees = { base: arg('base'), tip: arg('tip'), diag: arg('diag') }
const only = arg('only')?.split(',')
for (const [k, v] of Object.entries({ out, fixture, old: oldEngine, new: newEngine, base: trees.base, tip: trees.tip })) {
  if (!v || !fs.existsSync(v)) throw new Error(`--${k} is required and must exist: ${v}`)
}
if (fs.readdirSync(out).length) throw new Error(`--out must be empty: ${out}`)
const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32\\WindowsPowerShell\\v1.0\\powershell.exe')
const ALLOWANCE_MS = 30000, BUDGET_S = 20
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const alive = pid => { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }
const ps = (script, timeout = 120000) => {
  const r = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout })
  if (r.status !== 0) throw new Error(`powershell failed (${r.status}): ${r.stderr || r.stdout}`)
  return r.stdout.trim()
}
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'))
const wait = async (fn, ms, step = 100) => { const until = Date.now() + ms; while (Date.now() < until) { try { const v = fn(); if (v) return v } catch {} await sleep(step) } return null }

// The engine's own reading of this operator's sessions (core_process.rs
// Sessions::read: WTS sessions other than 0 owned by this account, with
// WTSINFOW.LogonTime). The observer only stays when the journal names one.
const psFile = (name, script) => {
  const file = path.join(out, name); fs.writeFileSync(file, script)
  const r = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], { encoding: 'utf8', windowsHide: true, timeout: 120000 })
  if (r.status !== 0) throw new Error(`${name} failed (${r.status}): ${r.stderr || r.stdout}`)
  return r.stdout.trim()
}
const sessions = JSON.parse(psFile('sessions.ps1', String.raw`
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class OrgtreeRigWts {
  [DllImport("wtsapi32.dll", SetLastError=true)] static extern bool WTSEnumerateSessionsW(IntPtr server, int reserved, int version, out IntPtr info, out int count);
  [DllImport("wtsapi32.dll", SetLastError=true)] static extern bool WTSQuerySessionInformationW(IntPtr server, int session, int infoClass, out IntPtr buffer, out int bytes);
  [DllImport("wtsapi32.dll")] static extern void WTSFreeMemory(IntPtr memory);
  [StructLayout(LayoutKind.Sequential)] struct Row { public int SessionId; public IntPtr Name; public int State; }
  static string Text(int id, int cls) { IntPtr b; int n; if (!WTSQuerySessionInformationW(IntPtr.Zero, id, cls, out b, out n)) return null; string s = Marshal.PtrToStringUni(b); WTSFreeMemory(b); return s; }
  public static string Read(string user, string domain) {
    IntPtr rows; int count;
    if (!WTSEnumerateSessionsW(IntPtr.Zero, 0, 1, out rows, out count)) return null;
    var found = new System.Collections.Generic.List<string>();
    int size = Marshal.SizeOf(typeof(Row));
    for (int i = 0; i < count; i++) {
      var row = (Row)Marshal.PtrToStructure(new IntPtr(rows.ToInt64() + i * size), typeof(Row));
      if (row.SessionId == 0) continue;
      if (!String.Equals(Text(row.SessionId, 5), user, StringComparison.OrdinalIgnoreCase)) continue;
      if (!String.Equals(Text(row.SessionId, 7), domain, StringComparison.OrdinalIgnoreCase)) continue;
      IntPtr b; int n;
      if (!WTSQuerySessionInformationW(IntPtr.Zero, row.SessionId, 24, out b, out n)) continue;
      long logon = n >= 216 ? Marshal.ReadInt64(b, 200) : 0; WTSFreeMemory(b);
      if (logon > 0) found.Add("{\"id\":" + row.SessionId + ",\"logon\":\"" + logon + "\"}");
    }
    WTSFreeMemory(rows);
    return "[" + String.Join(",", found.ToArray()) + "]";
  }
}
'@
[OrgtreeRigWts]::Read($env:USERNAME, $env:USERDOMAIN)`))
if (!sessions.length) throw new Error('no signed-in session of this account was found; the observer would stand down for that reason alone')
const stamp = pid => JSON.parse(ps(`$p=Get-Process -Id ${pid}; @{pid=$p.Id;created=$p.StartTime.ToUniversalTime().ToFileTimeUtc().ToString()}|ConvertTo-Json -Compress`))
const sid = ps('[Security.Principal.WindowsIdentity]::GetCurrent().User.Value')

// Stop-OwnedBootTask of the given tree against the scratch installation, with
// real process readings and kills and a test-double task that is owned, idle
// and disabled-able. Request-BootEngineShutdown has no engine to ask here.
function bootStep (tree, inst, logFile) {
  const harness = path.join(path.dirname(logFile), 'boot-harness.ps1')
  fs.writeFileSync(harness, String.raw`
$ErrorActionPreference='Stop'
. '${path.join(tree, 'tools', 'boot-engine-task.ps1')}'
$script:log=@()
function Write-BootLog([string]$Message) { $script:log += $Message }
function Request-BootEngineShutdown($Record,[string]$InstallDir) { return $false }
# This reading is not elevated, so it cannot read every path, and this machine's
# own Orgtree and agents start short-lived orgtree-engine.exe and python.exe all
# the time (an exiting process loses its path too). Refusing unverifiable
# processes is covered by tests/boot-installer.test.ps1; here an unreadable
# process that does not name the scratch installation is left out of the reading.
$script:realProcesses=(Get-Item Function:Get-BootProcesses).ScriptBlock
function Get-BootProcesses { @(& $script:realProcesses | Where-Object { $_.ExecutablePath -or ($_.CommandLine -and $_.CommandLine.IndexOf('${inst}', [StringComparison]::OrdinalIgnoreCase) -ge 0) }) }
$record=@{InstallDir='${inst}'; OperatorSid='${sid}'; Id='${crypto.randomUUID()}'}
$task=[pscustomobject]@{Xml=(New-BootTaskXml $record); Enabled=$true; State=3; Definition=[pscustomobject]@{Principal=[pscustomobject]@{RunLevel=0}}}
$task | Add-Member ScriptMethod GetSecurityDescriptor { param($f) 'O:BAG:BAD:P(A;;GA;;;SY)(A;;GA;;;BA)' }
$task | Add-Member ScriptMethod Stop { param($f) }
$task | Add-Member ScriptMethod GetInstances { param($f) [pscustomobject]@{Count=0} }
$script:task=$task
function Find-BootTask($Folder) { return $script:task }
$clock=[Diagnostics.Stopwatch]::StartNew(); $result=@{ok=$false}
try { Stop-OwnedBootTask ([pscustomobject]@{}) $record '${inst}' ${BUDGET_S}; $result.ok=$true }
catch { $result.error=$_.Exception.Message }
$result.seconds=[math]::Round($clock.Elapsed.TotalSeconds,1); $result.log=@($script:log)
$result | ConvertTo-Json -Compress -Depth 4 | Set-Content -LiteralPath '${logFile}' -Encoding UTF8
`)
  const r = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', harness], { encoding: 'utf8', windowsHide: true, timeout: 180000 })
  if (!fs.existsSync(logFile)) throw new Error(`boot harness wrote nothing (${r.status}): ${r.stderr}`)
  return JSON.parse(fs.readFileSync(logFile, 'utf8').replace(/^\uFEFF/, ''))
}

// The real close helper, pinned to the scratch data root (so it can never ask
// the live engine anything), in the "already closed" state the elevated Setup
// instance met: the desktop is gone, its observer is not.
function closeStep (tree, inst, data, dir, bootManaged) {
  const log = path.join(dir, 'upgrade.log')
  const started = Date.now()
  const r = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(tree, 'tools', 'installer-upgrade.ps1'),
    '-InstallDir', inst, '-ExecutablePath', path.join(inst, 'Orgtree.exe'), '-TimeoutSeconds', String(BUDGET_S), '-EngineStopSeconds', '10',
    '-LogPath', log, '-DataRoot', data, ...(bootManaged ? ['-BootManaged'] : [])], { encoding: 'utf8', windowsHide: true, timeout: 180000 })
  return { ok: r.status === 0, exit: r.status, seconds: Math.round((Date.now() - started) / 100) / 10, stdout: r.stdout.trim(), stderr: r.stderr.trim(), log: fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split(/\r?\n/) : [] }
}

const results = []
async function scenario (name, title, opts) {
  if (only && !only.includes(name)) return
  const dir = path.join(out, name), inst = path.join(dir, 'Orgtree'), data = path.join(dir, 'data')
  const engineDir = path.join(inst, 'resources', 'engine'), engineExe = path.join(engineDir, 'orgtree-engine.exe')
  fs.mkdirSync(engineDir, { recursive: true }); fs.mkdirSync(data)
  fs.writeFileSync(path.join(data, '.orgtree-rig-root'), '{}')
  fs.copyFileSync(opts.engine, engineExe)
  fs.copyFileSync(fixture, path.join(inst, 'Orgtree.exe'))
  fs.copyFileSync(fixture, path.join(dir, 'engine-standin.exe'))
  const env = { ...process.env, ORGTREE_RECOVERY_FIXTURE_ROOT: data }
  for (const k of ['ORGTREE_V2_DATA', 'ORGTREE_CORE_MODE', 'ORGTREE_ENGINE_RIG', 'ORGTREE_ENGINE_SAFE_START']) delete env[k]
  const pids = new Set(), r = { name, title, checks: [] }
  const check = (label, ok, detail) => { r.checks.push({ label, ok: !!ok, ...(detail === undefined ? {} : { detail }) }) }
  try {
    const engine = spawn(path.join(dir, 'engine-standin.exe'), ['engine'], { env, windowsHide: true, stdio: 'ignore' }); pids.add(engine.pid)
    const desktop = spawn(path.join(inst, 'Orgtree.exe'), ['desktop'], { env, windowsHide: true, stdio: 'ignore' }); pids.add(desktop.pid)
    if (!await wait(() => fs.existsSync(path.join(data, 'desktop.pid')) && fs.existsSync(path.join(data, 'engine.pid')), 15000)) throw new Error('stand-ins did not start')
    const snap = { generation: crypto.randomBytes(16).toString('hex'), engine: stamp(engine.pid), host: null, desktop: stamp(desktop.pid), helper: null,
      sessions, transition_until: 0, transition_desktop: null, installing: false, completion_requested: false }
    const save = () => fs.writeFileSync(path.join(data, 'core-lifecycle.json'), JSON.stringify(snap))
    save()
    for (let i = 0; i < 2; i++) spawnSync(engineExe, ['core-recovery', 'arm', data, String(desktop.pid)], { env, windowsHide: true, encoding: 'utf8', timeout: 10000 })
    const watcher = await wait(() => read(path.join(data, 'core-recovery-watcher.json')), 15000)
    if (!watcher) throw new Error('the observer did not start')
    const observer = watcher[1].pid; pids.add(observer)
    r.pids = { desktop: desktop.pid, engine: engine.pid, observer }
    check('the observer runs from the scratch installation\'s engine folder', ps(`(Get-CimInstance Win32_Process -Filter 'ProcessId = ${observer}').ExecutablePath`).toLowerCase() === engineExe.toLowerCase())
    let until = 0
    if (opts.transition) {
      until = Date.now() + ALLOWANCE_MS
      Object.assign(snap, { transition_until: until, transition_desktop: snap.desktop, installing: opts.transition === 'install' }); save()
    }
    process.kill(engine.pid)
    if (!opts.keepDesktop) process.kill(desktop.pid)
    const exitedAt = Date.now()
    await sleep(3000)
    r.observerAliveAfter3s = alive(observer)
    if (opts.expectStandDown !== undefined) check(opts.expectStandDown ? 'the observer stood down within 3 s of its desktop closing' : 'the observer is still waiting 3 s after its desktop closed', r.observerAliveAfter3s !== opts.expectStandDown)
    if (opts.step) {
      r.step = opts.step === 'boot' ? bootStep(trees[opts.tree], inst, path.join(dir, 'boot-result.json')) : closeStep(trees[opts.tree], inst, data, dir, opts.step === 'close-boot')
      opts.verify?.(r.step, { observer, desktop: desktop.pid, check })
    }
    r.observerAliveAfterStep = alive(observer)
    if (opts.expectObserverAfterStep !== undefined) check(opts.expectObserverAfterStep ? 'the observer is still there after the installer step' : 'the observer is gone after the installer step', r.observerAliveAfterStep === opts.expectObserverAfterStep)
    if (opts.step && !r.observerAliveAfterStep) {
      // What Setup does next: overwrite the engine binary. Measured from the
      // end of the step until the image opens for writing.
      const from = Date.now()
      r.imageWritableMs = await wait(() => { const fd = fs.openSync(engineExe, 'r+'); fs.closeSync(fd); return Date.now() - from }, 60000, 50)
      check('the observer\'s image can be replaced right after the installer step', r.imageWritableMs !== null && r.imageWritableMs < 2000, { imageWritableMs: r.imageWritableMs })
    }
    if (opts.expectRelaunch !== undefined) {
      // A launch also needs 3 GiB of available memory (core_recovery.rs
      // resources), so an expected one gets longer than a refused one needs.
      const deadline = (until || exitedAt) + (opts.expectRelaunch ? 45000 : 8000)
      const relaunched = await wait(() => fs.existsSync(path.join(data, 'recovered.pid')), Math.max(1000, deadline - Date.now()))
      if (relaunched) pids.add(Number(fs.readFileSync(path.join(data, 'recovered.pid'), 'utf8')))
      check(opts.expectRelaunch ? 'the observer relaunched the desktop' : 'nothing relaunched the old desktop', !!relaunched === opts.expectRelaunch,
        relaunched ? { afterDesktopExitSeconds: Math.round((Date.now() - exitedAt) / 1000) } : undefined)
    }
    const diag = path.join(data, 'diagnostics', 'core-exits.jsonl')
    r.events = fs.existsSync(diag) ? fs.readFileSync(diag, 'utf8').trim().split(/\r?\n/).map(l => JSON.parse(l).event) : []
    if (opts.expectEvent) check(`the observer recorded ${opts.expectEvent}`, r.events.includes(opts.expectEvent))
  } catch (error) { check('scenario completed', false, String(error.message)) } finally {
    fs.writeFileSync(path.join(data, 'fixture-stop'), 'stop')
    for (const pid of pids) {
      if (alive(pid)) await wait(() => !alive(pid), 3000)
      if (alive(pid)) { try { process.kill(pid) } catch {} await wait(() => !alive(pid), 10000) }
    }
    const left = [...pids].filter(alive)
    check('every process this scenario started has exited', left.length === 0, left.length ? left : undefined)
    // An observer this harness had to end itself can keep its image locked for
    // a while; measured, and only a failure past three minutes counts.
    const from = Date.now()
    r.removedMs = await wait(() => { for (const target of [inst, path.join(dir, 'engine-standin.exe')]) fs.rmSync(target, { recursive: true, force: true }); return Date.now() - from }, 180000, 500)
    check('the scratch installation could be removed', r.removedMs !== null, { removedMs: r.removedMs })
    r.passed = r.checks.every(c => c.ok)
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(r, null, 2))
    results.push(r)
    console.log(`${r.passed ? 'PASS' : 'FAIL'} ${name} ${title}${r.passed ? '' : ': ' + r.checks.filter(c => !c.ok).map(c => c.label).join('; ')}`)
  }
}

const failed = (step, re) => !step.ok && re.test(step.error ?? step.stderr ?? '')
await scenario('S1', 'red: alpha.1 observer, alpha.1 boot step (the incident)', {
  engine: oldEngine, transition: 'install', expectStandDown: false, step: 'boot', tree: 'base', expectObserverAfterStep: true, expectRelaunch: true,
  verify: (s, { check }) => check(`Prepare's stop times out at the ${BUDGET_S} s budget`, failed(s, /did not stop within 20 seconds/) && s.seconds >= BUDGET_S, s)
})
if (trees.diag) await scenario('S2', 'diagnostics: the timeout names the observer', {
  engine: oldEngine, transition: 'install', step: 'boot', tree: 'diag', expectObserverAfterStep: true,
  verify: (s, { observer, check }) => check('the message names the observer, its mode and its path', failed(s, new RegExp(`Still running: orgtree-engine\\.exe pid ${observer} \\(core-recovery watch, parent \\d+\\) at .*orgtree-engine\\.exe`)), s)
})
await scenario('S3', 'green: alpha.1 observer, fixed boot step', {
  engine: oldEngine, transition: 'install', expectStandDown: false, step: 'boot', tree: 'tip', expectObserverAfterStep: false, expectRelaunch: false,
  verify: (s, { observer, check }) => {
    check('the stop completes well inside its budget', s.ok && s.seconds < 10, s)
    check('the boot log names the observer it ended and its gone desktop', s.log.some(l => l.startsWith(`watcher: ended orgtree-engine.exe pid ${observer} (core-recovery watch,`) && /the desktop it watched \(pid \d+\) is gone$/.test(l)))
  }
})
await scenario('S4', 'green: fixed observer stands down; alpha.1 boot step passes unchanged', {
  engine: newEngine, transition: 'install', expectStandDown: true, step: 'boot', tree: 'base', expectRelaunch: false, expectEvent: 'desktop-recovery-stood-down-for-install',
  verify: (s, { check }) => check('the unchanged stop completes at once', s.ok && s.seconds < 5, s)
})
await scenario('S5', 'green: fixed observer and fixed boot step', {
  engine: newEngine, transition: 'install', expectStandDown: true, step: 'boot', tree: 'tip', expectRelaunch: false,
  verify: (s, { check }) => check('the stop completes at once and ends nothing', s.ok && s.seconds < 5 && !s.log.some(l => l.startsWith('watcher: ended')), s)
})
await scenario('S6', 'red: alpha.1 observer, alpha.1 close helper (per-user)', {
  engine: oldEngine, transition: 'install', step: 'close', tree: 'base', expectObserverAfterStep: true,
  verify: (s, { check }) => check('the close helper times out on the observer', !s.ok && s.exit === 2 && /background engine is still running/.test(s.stderr), s)
})
await scenario('S7', 'green: alpha.1 observer, fixed close helper (per-user)', {
  engine: oldEngine, transition: 'install', step: 'close', tree: 'tip', expectObserverAfterStep: false, expectRelaunch: false,
  verify: (s, { observer, check }) => {
    check('the close helper reports Orgtree closed', s.ok && /Orgtree is already closed/.test(s.stdout), s)
    check('its log names the observer it ended', s.log.some(l => l.includes(`observer: orgtree-engine.exe(${observer}) core-recovery watch of closed desktop pid `) && l.endsWith(': ended')))
  }
})
await scenario('S8', 'green: alpha.1 observer, fixed close helper (all-users)', {
  engine: oldEngine, transition: 'install', step: 'close-boot', tree: 'tip', expectObserverAfterStep: false,
  verify: (s, { check }) => check('the close helper reports Orgtree closed and leaves nothing to the boot step', s.ok && !s.log.some(l => /left to the installer's boot step/.test(l)), s)
})
await scenario('R1', 'regression: fixed observer still recovers a crashed desktop', {
  engine: newEngine, expectStandDown: false, expectRelaunch: true, expectEvent: 'desktop-recovery-launched'
})
await scenario('R2', 'regression: fixed observer keeps a restart transition\'s allowance', {
  engine: newEngine, transition: 'restart', expectStandDown: false, expectRelaunch: true
})
await scenario('R3', 'regression: an observer whose desktop is running is never ended', {
  engine: oldEngine, transition: 'install', keepDesktop: true, step: 'boot', tree: 'tip', expectObserverAfterStep: true,
  verify: (s, { observer, check }) => check('the stop refuses and names the observer instead', failed(s, new RegExp(`Still running: orgtree-engine\\.exe pid ${observer} \\(core-recovery watch`)), s)
})
const summary = { passed: results.every(r => r.passed), scenarios: results.map(r => ({ name: r.name, passed: r.passed, checks: r.checks.length })), fixture, oldEngine, newEngine, trees, sessions: sessions.length,
  sha256: Object.fromEntries([['fixture', fixture], ['old', oldEngine], ['new', newEngine]].map(([k, f]) => [k, crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')])) }
fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2))
console.log(JSON.stringify(summary))
process.exit(summary.passed ? 0 : 1)
