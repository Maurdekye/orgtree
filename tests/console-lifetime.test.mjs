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
// Run: node --test tests/console-lifetime.test.mjs

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

const ps = (script) => new Promise((resolve) => {
  execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', script],
    { windowsHide: true, timeout: 20000 }, (error, stdout) => resolve(error ? '' : String(stdout).trim()))
})

const alive = async (pid) => (await ps(`if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { 'yes' } else { 'no' }`)) === 'yes'

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

const cleanup = (pids) => ps(pids.filter(Boolean).map(p => `Stop-Process -Id ${p} -Force -ErrorAction SilentlyContinue`).join('; '))

test('§1 POSITIVE CONTROL: a process attached to a console DIES when that console is closed', async (t) => {
  // Without this firing, §2 below is worthless: a harness that cannot observe
  // a console-close death would report "survived" for everything.
  spawnInOwnConsole()
  await sleep(1200)
  const pid = await probePid()
  assert.ok(pid, 'the probe console started and was found')
  t.after(() => cleanup([pid]))
  assert.equal(await alive(pid), true, 'precondition: it is running')

  const posted = await closeConsoleWindowOf()
  assert.equal(posted, 'posted', 'the console window was found and WM_CLOSE was posted to it')
  await sleep(2500)
  assert.equal(await alive(pid), false,
    'CONTROL: closing the console a process is attached to ends it — so this '
    + 'harness can detect exactly the failure being investigated')
})

test('§2 a process that did NOT open the console is untouched when it closes', async (t) => {
  // The installed Orgtree shape: a child of the shell, no console of its own.
  // `windowsHide` plus piped stdio is what the app's own engine spawn uses.
  const bystander = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'],
    { windowsHide: true, stdio: 'pipe' })
  const bystanderPid = bystander.pid
  spawnInOwnConsole()
  await sleep(1200)
  const consolePid = await probePid()
  assert.ok(consolePid, 'the unrelated console started')
  t.after(() => { try { bystander.kill() } catch { /* already gone */ } })
  t.after(() => cleanup([consolePid]))

  assert.equal(await alive(bystanderPid), true, 'precondition: the bystander is running')
  assert.equal(await closeConsoleWindowOf(), 'posted')
  await sleep(2500)
  assert.equal(await alive(consolePid), false, 'the console really did close (§1 s mechanism)')
  assert.equal(await alive(bystanderPid), true,
    'THE TICKET S REQUIREMENT: closing an unrelated visible console leaves a '
    + 'process that did not open it alive')
})

test('§3 a PARENT is untouched when a console belonging to its CHILD is closed', async (t) => {
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
  await sleep(1500)
  const childConsolePid = await probePid()
  assert.ok(childConsolePid, 'the child console started')
  t.after(() => { try { parent.kill() } catch { /* already gone */ } })
  t.after(() => cleanup([childConsolePid]))

  assert.equal(await alive(parentPid), true, 'precondition: the parent is running')
  assert.equal(await closeConsoleWindowOf(), 'posted')
  await sleep(2500)
  assert.equal(await alive(childConsolePid), false, 'the child console closed')
  assert.equal(await alive(parentPid), true,
    'closing a console owned by a CHILD does not reach the parent — so the '
    + 'engine s agent consoles cannot, by this mechanism, end Orgtree')
})
