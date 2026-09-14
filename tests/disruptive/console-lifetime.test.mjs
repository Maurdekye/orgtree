// console-lifetime.test.mjs — DOES CLOSING A CONSOLE KILL A PROCESS THAT DID
// NOT OPEN IT?
//
// The user reported that closing a console window they had not created made
// Orgtree exit immediately, and could not say how that Orgtree had been
// started. Reading the code got me as far as "the installed shape should be
// unreachable" and no further, so this measures it instead of arguing about it.
//
// ⚠ THE POSITIVE CONTROL IS THE POINT. A negative control that says "the
// process survived" proves nothing on its own — a harness that cannot detect
// death at all would say exactly the same thing. §1 therefore closes a console
// a process IS attached to and requires it to die. Only once that fires does
// §2's survival mean anything.
//
// ⚠ AND IT TOUCHES NOTHING REAL. Every console and every process here is one
// this file spawned. It never looks for, signals, or closes a running agent's
// console — those belong to other agents' live work.
//
// The close is a genuine WM_CLOSE posted to the console window, which is what
// the user's mouse does. Killing the process instead would prove something
// else entirely.
//
// Run: THIS PROBE IS OPT-IN AND WILL DISTURB THE DESKTOP.
//   set ORGTREE_DISRUPTIVE_PROBES=1  and then  npm run test:disruptive
//   (or: node --test tests/disruptive/console-lifetime.test.mjs, same variable set)
//   Without that variable every test here SKIPS and measures nothing.

import test from 'node:test'
import assert from 'node:assert/strict'
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
const DISRUPTIVE_OK = requireDisruptiveOptIn('console lifetime')
const gatedTest = DISRUPTIVE_OK ? test : test.skip

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

/** ⚠ POLL, DO NOT SLEEP, for anything that has to APPEAR or to DIE. A fixed
 *  wait is a guess about machine load, and `npm test` runs every file in this
 *  directory concurrently: a 1.5s wait for a console to open was measured
 *  failing under that load, which reads as "the probe never started" and has
 *  nothing to do with the property under test. The await is load-bearing —
 *  a Promise is truthy, so an un-awaited predicate would pass on the first
 *  tick. A survival claim still waits a fixed time first: there is nothing to
 *  poll for when the expected answer is "nothing happened". */
const waitFor = async (predicate, ms = 10000) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) { if (await predicate()) return true; await sleep(200) }
  return await predicate()
}

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

const PROBE_TITLE = 'orgtree-lifetime-probe'

/** Post WM_CLOSE to the probe console's window — the same thing clicking the X
 *  does. NOT a kill: a kill would prove the harness can end a process, which is
 *  not the question.
 *
 *  ⚠ FOUND BY THE HOST'S WINDOW TITLE, not by the probe's pid and not by
 *  FindWindow on an exact title. Two things make the obvious approaches fail
 *  here, both measured rather than guessed:
 *
 *  - A console application's own MainWindowHandle is 0. The window belongs to
 *    whatever is HOSTING the console, not to the process sitting in it, so
 *    asking the probe for its window returns nothing.
 *  - The host on this machine is WINDOWS TERMINAL, not conhost.exe, and it
 *    does not use the requested title verbatim — the observed title came back
 *    as \orgtree-lifetime-probe\, quoting and all. An exact FindWindow match
 *    therefore finds nothing even when the window is plainly on screen.
 *
 *  A substring match against the host's title survives both. */
const closeConsoleWindowOf = () => ps(`
  $sig = '[DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);'
  $u = Add-Type -MemberDefinition $sig -Name W -Namespace T -PassThru
  $w = Get-Process | Where-Object { $_.MainWindowTitle -like '*${PROBE_TITLE}*' } | Select-Object -First 1
  if ($w) { [void]$u::PostMessage($w.MainWindowHandle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero); 'posted' } else { 'no-window' }
`)

/** A process sitting in its OWN new console window — the shape an engine-spawned
 *  agent console has. `start` gives it a console of its own; the ping loop just
 *  keeps it alive without busy-waiting. */
function spawnInOwnConsole() {
  const child = spawn('cmd.exe', ['/c', 'start', `"${PROBE_TITLE}"`, 'cmd.exe', '/c', 'ping -n 60 127.0.0.1 >nul'],
    { windowsHide: false, stdio: 'ignore', detached: true })
  child.unref()
  return child
}

/** Find the pid of the console process this file just started, by window title. */
const probePid = () => ps(`
  $p = Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" |
       Where-Object { $_.CommandLine -like '*ping -n 60 127.0.0.1*' } |
       Select-Object -First 1
  if ($p) { $p.ProcessId } else { '' }
`)

/** Wait for the console probe this file just started to exist and be findable.
 *  Its window also has to be up before a close can be posted to it, which is
 *  why the caller does not race ahead on a fixed wait. */
const waitForProbePid = async () => {
  let pid = ''
  await waitFor(async () => !!(pid = await probePid()))
  return pid
}

const cleanup = (pids) => ps(pids.filter(Boolean).map(p => `Stop-Process -Id ${p} -Force -ErrorAction SilentlyContinue`).join('; '))

gatedTest('§1 POSITIVE CONTROL: a process attached to a console DIES when that console is closed', async (t) => {
  // Serialised against the other console-window tests: see
  // fixtures/console-window-lock.mjs — a tabbed host makes concurrent probes
  // invisible to each other, and one close can end the other's probe.
  t.after(await acquireConsoleWindowLock())
  // Without this firing, §2 below is worthless: a harness that cannot observe
  // a console-close death would report "survived" for everything.
  spawnInOwnConsole()
  const pid = await waitForProbePid()
  assert.ok(pid, 'the probe console started and was found')
  t.after(() => cleanup([pid]))
  assert.equal(await alive(pid), true, 'precondition: it is running')

  const posted = await closeConsoleWindowOf()
  assert.equal(posted, 'posted', 'the console window was found and WM_CLOSE was posted to it')
  assert.equal(await waitFor(async () => !(await alive(pid))), true,
    'CONTROL: closing the console a process is attached to ends it — so this '
    + 'harness can detect exactly the failure being investigated')
})

gatedTest('§2 a process that did NOT open the console is untouched when it closes', async (t) => {
  // Serialised against the other console-window tests: see
  // fixtures/console-window-lock.mjs — a tabbed host makes concurrent probes
  // invisible to each other, and one close can end the other's probe.
  t.after(await acquireConsoleWindowLock())
  // The installed Orgtree shape: a child of the shell, no console of its own.
  // `windowsHide` plus piped stdio is what the app's own engine spawn uses.
  const bystander = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'],
    { windowsHide: true, stdio: 'pipe' })
  const bystanderPid = bystander.pid
  spawnInOwnConsole()
  const consolePid = await waitForProbePid()
  assert.ok(consolePid, 'the unrelated console started')
  t.after(() => { try { bystander.kill() } catch { /* already gone */ } })
  t.after(() => cleanup([consolePid]))

  assert.equal(await alive(bystanderPid), true, 'precondition: the bystander is running')
  assert.equal(await closeConsoleWindowOf(), 'posted')
  assert.equal(await waitFor(async () => !(await alive(consolePid))), true,
    'the console really did close (§1 s mechanism)')
  // a survival claim gets a settle wait rather than a poll: there is nothing to
  // poll for when the expected answer is that nothing happened
  await sleep(1500)
  assert.equal(await alive(bystanderPid), true,
    'THE TICKET S REQUIREMENT: closing an unrelated visible console leaves a '
    + 'process that did not open it alive')
})

gatedTest('§3 a PARENT is untouched when a console belonging to its CHILD is closed', async (t) => {
  // Serialised against the other console-window tests: see
  // fixtures/console-window-lock.mjs — a tabbed host makes concurrent probes
  // invisible to each other, and one close can end the other's probe.
  t.after(await acquireConsoleWindowLock())
  // The measured Orgtree topology: Orgtree -> engine -> agent consoles. Closing
  // an agent console must not cascade up. The parent here spawns a child into
  // its own console exactly as the engine spawns agents.
  const parent = spawn(process.execPath, ['-e', `
    const { spawn } = require('node:child_process')
    spawn('cmd.exe', ['/c', 'start', '"${PROBE_TITLE}"', 'cmd.exe', '/c', 'ping -n 60 127.0.0.1 >nul'],
      { windowsHide: false, stdio: 'ignore', detached: true }).unref()
    setTimeout(() => {}, 60000)
  `], { windowsHide: true, stdio: 'pipe' })
  const parentPid = parent.pid
  const childConsolePid = await waitForProbePid()
  assert.ok(childConsolePid, 'the child console started')
  t.after(() => { try { parent.kill() } catch { /* already gone */ } })
  t.after(() => cleanup([childConsolePid]))

  assert.equal(await alive(parentPid), true, 'precondition: the parent is running')
  assert.equal(await closeConsoleWindowOf(), 'posted')
  assert.equal(await waitFor(async () => !(await alive(childConsolePid))), true, 'the child console closed')
  await sleep(1500)
  assert.equal(await alive(parentPid), true,
    'closing a console owned by a CHILD does not reach the parent — so the '
    + 'engine s agent consoles cannot, by this mechanism, end Orgtree')
})
