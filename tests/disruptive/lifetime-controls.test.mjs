// lifetime-controls.test.mjs — THE REMAINING NEGATIVE CONTROLS FROM THE TICKET,
// measured with real processes: parent-shell exit, desktop kill, engine kill,
// helper launch failure, exactly-once install, exactly-once relaunch, and
// whether the console-signal handlers this branch added actually FIRE.
//
// console-lifetime.test.mjs answers "can closing a console kill a bystander".
// This file answers the other six, and it answers one more thing that had only
// ever been argued from source: §8 MEASURES electron-updater's defect —
// a process that starts and then dies hands back a pid and emits no error at
// all — instead of asserting it from reading the library.
//
// ⚠ EVERY SECTION CARRIES A POSITIVE CONTROL, and that is not ceremony. "It
// survived" is the default answer of a harness that cannot observe death at
// all, and "no error arrived" is the default answer of a harness that cannot
// observe errors. Each survival claim below is therefore paired with a case
// where the same probe, the same wiring and the same timings DO report the
// death or the error. Where a control does not fire, the section it supports
// proves nothing and says so in its own failure message.
//
// ⚠ AND IT TOUCHES NOTHING REAL. Every process, console and file here is one
// this file created, under its own temp directory. Nothing looks for, signals
// or closes a running agent's console or window; nothing installs anything;
// no real installer, updater or packaged Orgtree is launched.
//
// Run: THIS PROBE IS OPT-IN AND WILL DISTURB THE DESKTOP.
//   set ORGTREE_DISRUPTIVE_PROBES=1  and then  npm run test:disruptive
//   (or: node --test tests/disruptive/lifetime-controls.test.mjs, same variable set)
//   Without that variable every test here SKIPS and measures nothing.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, execFile } from 'node:child_process'
import { acquireConsoleWindowLock } from '../fixtures/console-window-lock.mjs'
import { requireDisruptiveOptIn } from './gate.mjs'

// DISRUPTIVE PROBE — SECOND BARRIER. This file opens consoles or windows,
// or drives the real installer toolchain, so it must never run because
// somebody typed `npm test`. Barrier one is the folder: the default glob
// `tests/*.test.mjs` does not recurse, so it cannot reach this file.
// Barrier two is this gate: without an explicit opt-in every test below is
// SKIPPED, which node:test reports as skipped rather than as a pass — a
// probe that was never asked for must never read as one that ran and was
// fine. Run these deliberately with `npm run test:disruptive` after setting
// ORGTREE_DISRUPTIVE_PROBES=1, on a machine you are willing to have
// interrupted.
const DISRUPTIVE_OK = requireDisruptiveOptIn('lifetime controls')
const gatedTest = DISRUPTIVE_OK ? test : test.skip

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

/** ⚠ AN UNANSWERABLE QUESTION RESOLVES TO null, NOT TO ''. This used to
 *  collapse both into '', and `alive()` then read that as "the process is
 *  dead" — so every death assertion in this file was satisfiable by an
 *  instrument that measured NOTHING. Proven by mutation: pointing this helper
 *  at an executable that does not exist left the parent-exit control passing,
 *  1 pass 0 fail. An unanswered gate is not a passed gate. */
const ps = (script) => new Promise((resolve) => {
  execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', script],
    { windowsHide: true, timeout: 20000 }, (error, stdout) => resolve(error ? null : String(stdout).trim()))
})

/** Is this pid running? The one observation every survival claim rests on, so
 *  each section that uses it also makes it report `false` at least once. */
/** ⚠ THROWS RATHER THAN GUESSING. The probe must answer exactly 'yes' or
 *  'no'; anything else — a failed powershell, a timeout, unexpected output —
 *  is the instrument being broken, and that must fail the test rather than be
 *  scored as a verdict. This is the only reason a death assertion here means
 *  anything at all. */
const alive = async (pid) => {
  const answer = await ps(`if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { 'yes' } else { 'no' }`)
  if (answer !== 'yes' && answer !== 'no') {
    throw new Error(`the liveness probe could not answer for pid ${pid}: `
      + (answer === null ? 'powershell failed or timed out' : JSON.stringify(answer)))
  }
  return answer === 'yes'
}

/** Force-kill by pid WITHOUT /T. The tree flag is deliberately absent: killing
 *  the tree would also end the detached child, which is the very thing under
 *  test. This kills the originator alone, which is what "the desktop was killed"
 *  actually means. */
const killOnly = (pid) => ps(`Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`)

const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-lifetime-'))
const at = (name) => path.join(workdir, name)
/** A script on disk rather than `node -e`: these go through `cmd /c start`,
 *  and a multi-line program quoted through cmd is a guessing game. */
const writeScript = (name, body) => { const file = at(name); fs.writeFileSync(file, body); return file }
const lines = (file) => { try { return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean) } catch { return [] } }
/** A real batch file as the parent shell.
 *
 *  ⚠ NOT `cmd /c <node> <script>` with the arguments passed individually.
 *  Measured: node.exe lives under "C:\Program Files\nodejs", and cmd.exe
 *  re-parses its own command line, so the space defeats the quoting and cmd
 *  reports `'C:\Program' is not recognized`. A .cmd file quotes normally, and
 *  a shell script is the more faithful "parent shell" anyway. */
const writeShell = (name, command) => writeScript(name, `@echo off\r\n${command}\r\n`)
/** ⚠ THE AWAIT IS LOAD-BEARING. Several predicates below are async (they ask
 *  the process table), and a Promise is truthy — an un-awaited `if (predicate())`
 *  would return true on the first tick and quietly make every control that uses
 *  it vacuous. */
const waitFor = async (predicate, ms = 8000) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) { if (await predicate()) return true; await sleep(150) }
  return await predicate()
}
/** The pid a probe wrote about itself. Read from its own output rather than
 *  guessed from the process table, so a stray `node.exe` from another test can
 *  never be mistaken for this one. */
const startedPid = (file) => {
  const row = lines(file).find(l => l.startsWith('started '))
  return row ? Number(row.slice('started '.length)) : 0
}

const PROBE_TITLE = 'orgtree-signal-probe'

/** Post WM_CLOSE to the probe console's window — what clicking the X does.
 *  NOT a kill: a kill bypasses the console control handler entirely, which is
 *  the thing being measured.
 *
 *  ⚠ Matched as a SUBSTRING of the HOST's window title, for two reasons
 *  measured in console-lifetime.test.mjs and re-stated here because they look
 *  like bugs in this test otherwise: a console process's own MainWindowHandle
 *  is 0 (the window belongs to the host), and Windows Terminal — the default
 *  host on this machine — does not use a requested title verbatim. */
const closeProbeConsole = () => ps(`
  $sig = '[DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);'
  $u = Add-Type -MemberDefinition $sig -Name W2 -Namespace T2 -PassThru
  $w = Get-Process | Where-Object { $_.MainWindowTitle -like '*${PROBE_TITLE}*' } | Select-Object -First 1
  if ($w) { [void]$u::PostMessage($w.MainWindowHandle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero); 'posted' } else { 'no-window' }
`)

/** THE SIGNAL LIST READ OUT OF THE APPLICATION ITSELF, not copied by hand.
 *
 *  ⚠ This is what couples §2 to the shipped code. index.ts cannot be imported
 *  (it requires Electron and runs an app), so the probe below cannot BE the
 *  app — but it can be built from the app's own list. Drop SIGHUP from index.ts
 *  and the probe stops registering it, the console close goes unhandled, and §2
 *  fails. A hand-copied list would have kept passing. */
const appSignals = (() => {
  const main = fs.readFileSync(path.join(path.resolve(import.meta.dirname, '..', '..'),
    'apps/desktop/main/index.ts'), 'utf8')
  const found = /for \(const signal of \[([^\]]*)\] as const\)/.exec(main)
  return found ? found[1].split(',').map(s => s.trim().replace(/^'|'$/g, '')).filter(Boolean) : []
})()

/** A console probe: records its pid, optionally installs the app's own handler
 *  shape, and then stays alive. The marker file is the only thing that outlives
 *  it — exactly as the update log is for the real app. */
const consoleProbe = (marker, withHandlers) => `
const fs = require('node:fs')
const file = ${JSON.stringify(marker)}
fs.appendFileSync(file, 'started ' + process.pid + '\\n')
${withHandlers ? `
// the wiring under test, built from apps/desktop/main/index.ts's own list
for (const signal of ${JSON.stringify(appSignals)}) {
  try {
    process.on(signal, () => {
      try { fs.appendFileSync(file, 'orderly ' + signal + '\\n') } catch {}
      process.exit(0)
    })
  } catch {}
}` : '// NO handlers: the default disposition, which is what main/ had'}
setInterval(() => {}, 1000)
`

/** Start a script in a console window of its own — the shape the engine's
 *  visible agent consoles have. */
const spawnInOwnConsole = (script) => {
  const child = spawn('cmd.exe', ['/c', 'start', `"${PROBE_TITLE}"`, process.execPath, script],
    { windowsHide: false, stdio: 'ignore', detached: true })
  child.unref()
  return child
}

test.after(() => { try { fs.rmSync(workdir, { recursive: true, force: true }) } catch { /* temp dir */ } })

// --------------------------------------------------------------- console signals

gatedTest('§1 POSITIVE CONTROL: with NO signal handler, a console close leaves no orderly record', async (t) => {
  // Serialised against the other console-window tests: see
  // fixtures/console-window-lock.mjs — a tabbed host makes concurrent probes
  // invisible to each other, and one close can end the other's probe.
  t.after(await acquireConsoleWindowLock())
  // This is the state apps/desktop/main was in before 7218d78: not one
  // SIGHUP/SIGINT/SIGBREAK listener anywhere. Without this control firing, §2
  // would pass against a process that simply happened to write its marker.
  const marker = at('nohandler.log')
  spawnInOwnConsole(writeScript('nohandler.cjs', consoleProbe(marker, false)))
  assert.ok(await waitFor(() => startedPid(marker) > 0), 'the probe started and named itself')
  const pid = startedPid(marker)
  t.after(() => killOnly(pid))
  assert.equal(await alive(pid), true, 'precondition: it is running')

  assert.equal(await closeProbeConsole(), 'posted', 'the probe console window was found and WM_CLOSE posted')
  await sleep(3000)
  assert.equal(await alive(pid), false, 'the close really did end it')
  assert.deepEqual(lines(marker).filter(l => l.startsWith('orderly')), [],
    'CONTROL: with no handler installed the process is terminated cold — nothing '
    + 'is written on the way out, which is the defect OBS-B describes')
})

gatedTest('§2 the handler shape index.ts installs DOES fire, and the shutdown grace is used', async (t) => {
  // Serialised against the other console-window tests: see
  // fixtures/console-window-lock.mjs — a tabbed host makes concurrent probes
  // invisible to each other, and one close can end the other's probe.
  t.after(await acquireConsoleWindowLock())
  // §1 having fired, this is a real measurement rather than a tautology: same
  // probe, same console, same close, the only difference being the handlers.
  assert.ok(appSignals.includes('SIGHUP'),
    'index.ts must register SIGHUP — it is the signal a Windows console close '
    + `produces, and the app's list is currently [${appSignals.join(', ')}]`)
  const marker = at('handler.log')
  spawnInOwnConsole(writeScript('handler.cjs', consoleProbe(marker, true)))
  assert.ok(await waitFor(() => startedPid(marker) > 0), 'the probe started and named itself')
  const pid = startedPid(marker)
  t.after(() => killOnly(pid))
  assert.equal(await alive(pid), true, 'precondition: it is running')

  assert.equal(await closeProbeConsole(), 'posted')
  assert.ok(await waitFor(() => lines(marker).some(l => l.startsWith('orderly')), 6000),
    'a console close must reach the handler, so the exit is an orderly one rather '
    + 'than a cold kill — this is what 7218d78 buys, measured rather than asserted')
  assert.deepEqual(lines(marker).filter(l => l.startsWith('orderly')), ['orderly SIGHUP'],
    'exactly once, and as SIGHUP — the signal Windows console closure produces')
  await sleep(1500)
  assert.equal(await alive(pid), false,
    'and it still exits: the handler uses the grace, it does not make the process immortal')
})

// ------------------------------------------------- parent exit and parent kill

/** Spawn a child with the given options from a parent that then EXITS, and
 *  report whether the child outlived it.
 *
 *  ⚠ THE CHILD NEVER READS ITS STDIN, deliberately. An earlier version of §3
 *  told a story about pipes: the child read stdin, saw EOF when the parent
 *  exited, and exited itself. It passed — and it was measuring the child's own
 *  cooperation rather than anything Windows does. Removing that coupling left
 *  the section passing anyway, which is how staffing-flow found it. With the
 *  read gone, `detached` is the only variable left. */
const outlivesParent = async ({ detached, stdio, label }) => {
  const marker = at(`matrix-${label}.log`)
  const child = writeScript(`matrix-child-${label}.cjs`, `
    const fs = require('node:fs')
    const file = ${JSON.stringify(marker)}
    fs.appendFileSync(file, 'started ' + process.pid + '\\n')
    // If this child is asked to leave, it records it. Nothing writes this when
    // the process is force-terminated, which is how we can tell the two apart.
    process.on('exit', () => { try { fs.appendFileSync(file, 'orderly-exit\\n') } catch {} })
    setInterval(() => {}, 1000)
  `)
  const parent = writeScript(`matrix-parent-${label}.cjs`, `
    const { spawn } = require('node:child_process')
    const c = spawn(process.execPath, [${JSON.stringify(child)}],
      { windowsHide: true, stdio: ${JSON.stringify(stdio)}, detached: ${detached} })
    ${detached ? 'c.unref()' : ''}
    setTimeout(() => process.exit(0), 700)
  `)
  await new Promise(resolve => execFile(process.execPath, [parent], { windowsHide: true, timeout: 20000 }, () => resolve()))
  assert.ok(await waitFor(() => startedPid(marker) > 0), `${label}: the child started`)
  const pid = startedPid(marker)
  // the parent is already gone — execFile resolved on its exit
  await sleep(1500)
  const survived = await alive(pid)
  if (survived) await killOnly(pid)
  return { survived, pid, orderly: lines(marker).includes('orderly-exit') }
}

gatedTest('§3 THE DISCRIMINATOR IS `detached`, and this is the control for §4 and §5', async () => {
  // A four-way matrix, because §4 and §5 differ from a dying child in TWO
  // properties at once (detached AND stdio) and so cannot say which one keeps
  // the installer alive. If a later reader drops `detached` from the installer
  // spawn on the strength of a pipe story, this is what stops them.
  //
  // It is also the POSITIVE CONTROL the two sections below depend on: the
  // bottom two rows are real parent-exit deaths, so the harness demonstrably
  // detects exactly the failure §4 and §5 claim does not happen.
  const matrix = [
    { detached: true, stdio: 'ignore', label: 'detached-ignore', expect: true },
    { detached: true, stdio: 'pipe', label: 'detached-pipe', expect: true },
    { detached: false, stdio: 'ignore', label: 'attached-ignore', expect: false },
    { detached: false, stdio: 'pipe', label: 'attached-pipe', expect: false },
  ]
  const results = []
  for (const row of matrix) results.push({ ...row, ...await outlivesParent(row) })

  for (const row of results) {
    assert.equal(row.survived, row.expect,
      `detached:${row.detached} stdio:${row.stdio} — expected the child to `
      + `${row.expect ? 'OUTLIVE' : 'DIE WITH'} its parent`)
  }
  // The property stated once, plainly, so it cannot be read off the rows wrongly:
  const byDetached = new Map(results.map(r => [r.detached, r.survived]))
  assert.equal(byDetached.get(true), true, 'every detached child survived, whatever its stdio')
  assert.equal(byDetached.get(false), false, 'every attached child died, whatever its stdio')
  assert.deepEqual(results.filter(r => !r.survived).map(r => r.orderly), [false, false],
    'and the ones that died were FORCE-TERMINATED — their own exit handler never '
    + 'ran, so this is Windows ending them rather than the child noticing '
    + 'anything and leaving politely')
})

gatedTest('§4 PARENT-SHELL EXIT: an installer-shaped child outlives the shell that launched it', async (t) => {
  // The ticket's parent-shell-exit control. The options are electron-updater's
  // own (BaseUpdater.spawnLog: detached + ignore + unref), and the launching
  // shell is a real cmd.exe that exits normally, as a script or a launcher does.
  const marker = at('shell-child.log')
  const child = writeScript('shell-child.cjs', `
    const fs = require('node:fs')
    fs.appendFileSync(${JSON.stringify(marker)}, 'started ' + process.pid + '\\n')
    setTimeout(() => { fs.appendFileSync(${JSON.stringify(marker)}, 'survived\\n') }, 4000)
    setInterval(() => {}, 1000)
  `)
  const spawner = writeScript('shell-spawner.cjs', `
    const { spawn } = require('node:child_process')
    spawn(process.execPath, [${JSON.stringify(child)}], { detached: true, stdio: 'ignore' }).unref()
    process.exit(0)
  `)
  // cmd.exe is the shell; it runs the spawner and then exits, so BOTH the shell
  // and the process that did the spawning are gone.
  const script = writeShell('shell-parent.cmd', `"${process.execPath}" "${spawner}"`)
  const shell = spawn('cmd.exe', ['/c', script], { windowsHide: true, stdio: 'ignore' })
  assert.ok(await waitFor(() => startedPid(marker) > 0), 'the detached child started')
  const pid = startedPid(marker)
  t.after(() => killOnly(pid))
  assert.ok(await waitFor(async () => !(await alive(shell.pid)), 8000), 'the shell exited')

  assert.ok(await waitFor(() => lines(marker).includes('survived'), 8000),
    'a detached + unref child must keep RUNNING and keep WORKING after its '
    + 'launching shell and its spawning parent have both exited')
  assert.equal(await alive(pid), true, 'and it is still there')
})

gatedTest('§5 DESKTOP KILL: the same child survives its parent being force-killed, not merely exiting', async () => {
  // Distinct from §4 on purpose: a normal exit and a TerminateProcess are
  // different events, and only one of them is what "the desktop was killed"
  // means. Stop-Process without -Tree kills the originator alone.
  const marker = at('kill-child.log')
  const child = writeScript('kill-child.cjs', `
    const fs = require('node:fs')
    fs.appendFileSync(${JSON.stringify(marker)}, 'started ' + process.pid + '\\n')
    setTimeout(() => { fs.appendFileSync(${JSON.stringify(marker)}, 'survived\\n') }, 4000)
    setInterval(() => {}, 1000)
  `)
  const desktop = spawn(process.execPath, ['-e', `
    const { spawn } = require('node:child_process')
    spawn(process.execPath, [${JSON.stringify(child)}], { detached: true, stdio: 'ignore' }).unref()
    setInterval(() => {}, 1000)
  `], { windowsHide: true, stdio: 'ignore' })
  assert.ok(await waitFor(() => startedPid(marker) > 0), 'the detached child started')
  const pid = startedPid(marker)

  assert.equal(await alive(desktop.pid), true, 'precondition: the "desktop" is running')
  await killOnly(desktop.pid)
  assert.ok(await waitFor(async () => !(await alive(desktop.pid)), 8000), 'the "desktop" was killed')

  assert.ok(await waitFor(() => lines(marker).includes('survived'), 8000),
    'killing the originating process must not reach the detached child')
  assert.equal(await alive(pid), true, 'it is still running')
  // CONTROL FOR THIS SECTION'S OWN PROBE: the same liveness check must be able
  // to report death, or "it is still running" is unfalsifiable here.
  await killOnly(pid)
  assert.ok(await waitFor(async () => !(await alive(pid)), 8000),
    'CONTROL: the probe reports death when the child really is killed')
})

// ---------------------------------------------- the whole handoff, end to end

gatedTest('§6 a detached updater completes after EVERY originator is gone, installing once and relaunching once', async (t) => {
  // The ticket's composite requirement. The topology mirrors the real one:
  //   cmd.exe (shell)  ->  "desktop" (spawns, records, quits)  ->  detached "installer"
  // The desktop quits IMMEDIATELY after the handoff, which is the app's real
  // behaviour, so the installer does all of its work with no ancestor alive.
  //
  // Exactly-once is asserted by COUNTING durable phase lines rather than by
  // watching, because a second install or a second relaunch would be exactly
  // the kind of thing that happens after the observer has stopped looking.
  const phases = at('phases.log')
  const installer = writeScript('fake-installer.cjs', `
    const fs = require('node:fs')
    const file = ${JSON.stringify(phases)}
    const mark = (stage) => fs.appendFileSync(file, stage + '\\n')
    mark('installer-started')
    // long enough that both ancestors are certainly gone before the work runs
    setTimeout(() => {
      mark('installer-completed')     // "installed", once
      mark('relaunch-scheduled')      // "relaunched", once
      mark('done')
    }, 3000)
  `)
  const desktop = writeScript('fake-desktop.cjs', `
    const fs = require('node:fs')
    const { spawn } = require('node:child_process')
    const file = ${JSON.stringify(phases)}
    fs.appendFileSync(file, 'requested\\n')
    const c = spawn(process.execPath, [${JSON.stringify(installer)}], { detached: true, stdio: 'ignore' })
    c.unref()
    fs.appendFileSync(file, 'helper-started\\n')
    process.exit(0)                   // the app.quit() the real defect happened around
  `)
  const script = writeShell('desktop-parent.cmd', `"${process.execPath}" "${desktop}"`)
  const shell = spawn('cmd.exe', ['/c', script], { windowsHide: true, stdio: 'ignore' })
  t.after(() => { try { shell.kill() } catch { /* already gone */ } })

  assert.ok(await waitFor(() => lines(phases).includes('helper-started'), 8000), 'the handoff happened')
  assert.ok(await waitFor(async () => !(await alive(shell.pid)), 8000),
    'both originators exited before the installer did its work')

  assert.ok(await waitFor(() => lines(phases).includes('done'), 12000),
    'the detached updater must RUN TO COMPLETION with no ancestor alive')
  const recorded = lines(phases)
  // the ticket's phase vocabulary, in order, each exactly once
  assert.deepEqual(recorded, ['requested', 'helper-started', 'installer-started',
    'installer-completed', 'relaunch-scheduled', 'done'],
    'durable phase markers distinguish requested, helper-started, installer-started, '
    + 'installer-completed and relaunch-scheduled — and each appears EXACTLY ONCE, '
    + 'so the install is once and the relaunch is once')
  assert.equal(recorded.filter(l => l === 'installer-completed').length, 1, 'installed exactly once')
  assert.equal(recorded.filter(l => l === 'relaunch-scheduled').length, 1, 'relaunched exactly once')
  // CONTROL: the counting is capable of seeing a repeat. Without this, the two
  // assertions above would also pass against a file nobody could append to.
  fs.appendFileSync(phases, 'installer-completed\n')
  assert.equal(lines(phases).filter(l => l === 'installer-completed').length, 2,
    'CONTROL: a second install WOULD have been counted')
})

// ------------------------------------------------------------------ engine kill

gatedTest('§7 ENGINE KILL: the app observes its engine dying and stays up', async (t) => {
  // engine.ts childExited only clears the endpoint and sets state 'stopped';
  // nothing in main/ quits the app on engine exit. That is load-bearing — it is
  // why OBS-B is not engine-death propagation — so it gets a control of its own.
  // The child's options are engine.ts:181's: windowsHide + piped stdio.
  const marker = at('engine-observer.log')
  const observer = spawn(process.execPath, ['-e', `
    const fs = require('node:fs')
    const { spawn } = require('node:child_process')
    const file = ${JSON.stringify(marker)}
    const engine = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true, stdio: 'pipe' })
    fs.appendFileSync(file, 'engine ' + engine.pid + '\\n')
    engine.on('exit', () => { fs.appendFileSync(file, 'engine-exited\\n') })
    setInterval(() => {}, 1000)
  `], { windowsHide: true, stdio: 'ignore' })
  t.after(() => killOnly(observer.pid))
  assert.ok(await waitFor(() => lines(marker).some(l => l.startsWith('engine ')), 8000), 'the engine child started')
  const enginePid = Number(lines(marker).find(l => l.startsWith('engine ')).slice('engine '.length))

  await killOnly(enginePid)
  assert.ok(await waitFor(() => lines(marker).includes('engine-exited'), 8000),
    'the parent must OBSERVE the exit — a parent that noticed nothing would also '
    + 'trivially survive, and that is not the property being claimed')
  await sleep(1200)
  assert.equal(await alive(observer.pid), true,
    'and must stay up: engine death alone does not end the app, which is exactly '
    + 'why the console-close report is not engine-death propagation')
})

gatedTest('§7b POSITIVE CONTROL: a parent WIRED to exit on engine death really does die', async (t) => {
  // Without this, §7 passes against a harness that cannot kill anything or
  // cannot see a parent exit at all.
  const marker = at('engine-coupled.log')
  const coupled = spawn(process.execPath, ['-e', `
    const fs = require('node:fs')
    const { spawn } = require('node:child_process')
    const file = ${JSON.stringify(marker)}
    const engine = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true, stdio: 'pipe' })
    fs.appendFileSync(file, 'engine ' + engine.pid + '\\n')
    engine.on('exit', () => process.exit(0))   // the coupling main/ does NOT have
    setInterval(() => {}, 1000)
  `], { windowsHide: true, stdio: 'ignore' })
  // ⚠ CLEANUP THE SECTION USED TO LACK, and its absence was worse than a
  // failure: when the coupling is broken this parent never exits, the live
  // spawn handle keeps the test process alive, and `npm test` HANGS with no
  // verdict at all. A failure is information; a hang is not. §7 always had this.
  t.after(() => killOnly(coupled.pid))
  assert.ok(await waitFor(() => lines(marker).some(l => l.startsWith('engine ')), 8000), 'the engine child started')
  const enginePid = Number(lines(marker).find(l => l.startsWith('engine ')).slice('engine '.length))

  assert.equal(await alive(coupled.pid), true, 'precondition: the coupled parent is running')
  await killOnly(enginePid)
  assert.ok(await waitFor(async () => !(await alive(coupled.pid)), 8000),
    'CONTROL: with the coupling present the parent dies — so §7 is a measurement '
    + 'of the wiring and not of the harness')
})

// -------------------------------------------- helper launch failure, and the defect

gatedTest('§8 HELPER LAUNCH FAILURE is reported — and the failure that is NOT reported is the whole OBS-A defect', async () => {
  // Measured here rather than read out of the library, because everything the
  // fix does rests on it.
  //
  // (a) A helper that cannot be launched at all DOES report: no pid, and an
  //     asynchronous ENOENT on the 'error' event. This is the case the old
  //     3-second grace was written for, and it still works.
  const missing = path.join(workdir, 'no-such-orgtree-helper.exe')
  const failure = await new Promise(resolve => {
    const child = spawn(missing, [], { detached: true, stdio: 'ignore' })
    child.on('error', error => resolve({ pid: child.pid, code: error.code }))
    setTimeout(() => resolve({ pid: child.pid, code: 'NONE' }), 4000)
  })
  assert.equal(failure.code, 'ENOENT',
    'a helper that cannot be launched reports asynchronously on the error event')
  assert.equal(failure.pid, undefined, 'and hands back no pid at all')

  // (b) THE DEFECT. A helper that launches and then dies at once hands back a
  //     pid and emits NOTHING. electron-updater's spawnLog resolves on
  //     `p.pid !== undefined`, so install() returns true; the only failure it
  //     can ever surface is the 'error' above, which never comes. The app
  //     therefore waited out a silent grace and quit having installed nothing —
  //     "shut Orgtree down but never visibly proceeded", exactly.
  const instantDeath = await new Promise(resolve => {
    const child = spawn('cmd.exe', ['/c', 'exit 1'], { detached: true, stdio: 'ignore' })
    child.unref()
    const seen = { pid: child.pid, code: 'NONE' }
    child.on('error', error => { seen.code = error.code || 'ERROR' })
    setTimeout(() => resolve(seen), 4000)
  })
  assert.equal(typeof instantDeath.pid, 'number',
    'a process that dies instantly still hands back a pid — which is all '
    + 'electron-updater ever waits for')
  assert.equal(instantDeath.code, 'NONE',
    'AND NO ERROR IS EVER EMITTED FOR IT. This is why proof of life had to be '
    + 'positive observation of the installer process: there is nothing to listen '
    + 'for. Compare (a), where the harness DID see an error — so this is a real '
    + 'absence, not a deaf listener')
  assert.notEqual(failure.code, instantDeath.code,
    'the two cases are distinguishable only by asking the process table, never '
    + 'by waiting for an event')
})
