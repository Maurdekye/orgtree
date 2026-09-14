// failure-report-lifecycle.test.mjs — THE TWO PROPERTIES THE FAILURE REPORT HAS
// TO HAVE AT THE SAME TIME, measured in real Electron rather than argued.
//
// The branch that reports a failed update went through three shapes, and the
// first two each satisfied one property while breaking the other:
//
//   1. `void dialog.showMessageBox(...)` then `app.exit(0)` — never presented
//      anything. app.exit force-exits on the next statement. A failure the user
//      never sees is the original complaint wearing a quieter hat.
//   2. `await dialog.showMessageBox(...)` then `app.relaunch(); app.exit(0)` —
//      presents it, and BLOCKS THE RELAUNCH until somebody clicks. That branch
//      is reachable from the automatic idle path, so on an unattended machine it
//      means: engine already stopped, a modal nobody can see, and Orgtree gone
//      until morning.
//   3. What ships: the dying instance records and relaunches, telling nobody,
//      and the instance that comes back reports it out of the durable log.
//
// So the requirement is a CONJUNCTION, and this file measures both halves with a
// control for each:
//
//   (a) AN UNATTENDED FAILURE STILL RELAUNCHES — no human click on the critical
//       path. §1 proves the block is real (an awaited dialog does hold the exit
//       open), §2 proves the shipped statements do not.
//   (b) A PRESENT HUMAN IS TOLD — §3 proves the report really renders in a live
//       app, with a control showing the window observation is not always true.
//
// Every process here is an Electron this file spawned on a throwaway main
// script. No installer runs, no update is applied, and the real app is never
// started.
//
// Run: node --test tests/failure-report-lifecycle.test.mjs

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)
/** The real Electron binary, resolved the way the repo's other native probes
 *  resolve it — through node_modules, because this worktree has none of its own
 *  and resolves upward to a shared tree. */
const electron = (() => { try { return require_('electron') } catch { return '' } })()

const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-failure-report-'))
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

const ps = (script) => new Promise((resolve) => {
  execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', script],
    { windowsHide: true, timeout: 20000 }, (error, stdout) => resolve(error ? null : String(stdout).trim()))
})

/** ⚠ THROWS RATHER THAN GUESSING, for the same reason the other lifetime files
 *  do: an instrument that cannot answer must fail the test, never report a
 *  verdict. "Could not ask" scored as "it exited" would make every exit
 *  assertion here satisfiable by a broken probe. */
/** Count VISIBLE TOP-LEVEL WINDOWS owned by a process or any of its
 *  descendants.
 *
 *  ⚠ NOT `Get-Process -Id <pid>).MainWindowHandle`, which was the obvious thing
 *  and answered 0 for a process that plainly had a dialog on screen. Measured:
 *  the window belongs to a DESCENDANT of the electron.exe that was spawned, so
 *  asking the spawned pid alone reports no window and the section fails for a
 *  reason that has nothing to do with the dialog. Enumerating real windows
 *  across the process subtree is what actually answers the question. */
const visibleWindows = async (pid) => {
  const answer = await ps(`
    $sig = @"
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
"@
    $u = Add-Type -MemberDefinition $sig -Name WEnumOrgtree -Namespace OrgtreeProbe -PassThru
    $all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId
    $family = New-Object System.Collections.Generic.HashSet[int]
    [void]$family.Add(${pid})
    # walk down the tree until it stops growing: renderer/gpu children are one
    # level down, and the dialog's window may belong to any of them
    for ($pass = 0; $pass -lt 6; $pass++) {
      foreach ($row in $all) { if ($family.Contains([int]$row.ParentProcessId)) { [void]$family.Add([int]$row.ProcessId) } }
    }
    $script:count = 0
    $cb = [OrgtreeProbe.WEnumOrgtree+EnumWindowsProc]{ param($h, $l)
      $owner = 0
      [void][OrgtreeProbe.WEnumOrgtree]::GetWindowThreadProcessId($h, [ref]$owner)
      if ($family.Contains([int]$owner) -and [OrgtreeProbe.WEnumOrgtree]::IsWindowVisible($h)) { $script:count++ }
      return $true }
    [void][OrgtreeProbe.WEnumOrgtree]::EnumWindows($cb, [IntPtr]::Zero)
    "windows=$($script:count)"`)
  const count = /^windows=(\d+)$/.exec(answer ?? '')?.[1]
  // ⚠ THROWS RATHER THAN GUESSING. An instrument that cannot answer must fail
  // the test, never report a verdict — "could not ask" scored as "no window"
  // would make §3 fail mysteriously and §3b pass vacuously.
  if (count === undefined) {
    throw new Error(`the window probe could not answer for pid ${pid}: ${answer === null ? 'powershell failed' : JSON.stringify(answer)}`)
  }
  return Number(count)
}

/** Run a throwaway Electron main script and report how it behaved.
 *
 *  ⚠ ELECTRON_RUN_AS_NODE IS DELETED. Inherited from a parent that set it, the
 *  binary runs as plain Node, `require('electron')` yields a path instead of the
 *  API, and every assertion here would be measuring the wrong program. */
const runElectron = (name, source, { waitMs, showWindows = false }) => {
  const script = path.join(workdir, `${name}.cjs`)
  fs.writeFileSync(script, source)
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const started = Date.now()
  // ⚠ OUTPUT IS CAPTURED, NOT DISCARDED. With stdio 'ignore' a probe that
  // crashed on startup was indistinguishable from one that ran and exited
  // quickly, and this environment does emit real Electron noise — GPU and
  // network-service crash lines — which is exactly what a failure here needs to
  // be read against. Every assertion below reports this text when it fails.
  // ⚠ ITS OWN USER-DATA DIRECTORY, PER PROBE. Without this every probe in this
  // file shares Electron's default profile, and a previous Electron that was
  // killed rather than closed can leave state that makes the NEXT one exit at
  // once — which reads as "the awaited dialog did not block" and is nothing of
  // the kind. Measured: §1 passed three times in isolation and failed in a run
  // that followed a killed probe. A separate profile makes each section
  // independent of whatever ran before it.
  // ⚠ windowsHide MUST BE FALSE FOR ANYTHING THAT HAS TO BE SEEN. It sets
  // STARTF_USESHOWWINDOW/SW_HIDE on the child, and Windows applies that to the
  // process's first top-level window — so a dialog really is created and really
  // is invisible. Measured: the same probe found a visible window when launched
  // without it and none with it, three runs each. The real app is not launched
  // with SW_HIDE, so hiding it here would be measuring a shape that does not
  // ship. Sections that only care about EXIT keep it, to stay quiet.
  const child = spawn(electron, [script, `--user-data-dir=${path.join(workdir, `${name}-profile`)}`],
    { windowsHide: !showWindows, stdio: ['ignore', 'pipe', 'pipe'], env })
  let output = ''
  child.stdout?.on('data', chunk => { output += chunk })
  child.stderr?.on('data', chunk => { output += chunk })
  let exitedAfter, exitCode
  child.on('exit', (code) => { exitedAfter = Date.now() - started; exitCode = code })
  return {
    child,
    log: () => output.trim(),
    /** Wait out the window and report whether it exited, and how quickly. */
    settle: async () => {
      const deadline = Date.now() + waitMs
      while (Date.now() < deadline && exitedAfter === undefined) await sleep(150)
      return { exited: exitedAfter !== undefined, exitedAfter, exitCode, log: output.trim() }
    },
  }
}

const marker = (name) => path.join(workdir, `${name}.log`)
const wrote = (file) => { try { return fs.readFileSync(file, 'utf8').trim() } catch { return '' } }

test.after(() => { try { fs.rmSync(workdir, { recursive: true, force: true }) } catch { /* temp */ } })

test('real Electron is available to measure this at all', () => {
  // Asserted rather than skipped: without it the sections below are not
  // evidence, and that has to be visible rather than inferred from a green run.
  assert.ok(electron, 'the electron binary must be resolvable from node_modules')
  assert.equal(fs.existsSync(electron), true, `and must exist on disk: ${electron}`)
})

test('§1 POSITIVE CONTROL: an AWAITED dialog really does hold the exit open', async (t) => {
  // The shape that was one edit away from shipping. Nobody clicks this dialog,
  // which is exactly the unattended case: if the process is still alive at the
  // end of the window, the block is real and §2 is measuring something.
  const probe = runElectron('awaited-blocks', `
    const { app, dialog } = require('electron')
    const fs = require('node:fs')
    app.whenReady().then(async () => {
      fs.appendFileSync(${JSON.stringify(marker('awaited'))}, 'reached\\n')
      // No parent window, nobody present: precisely the 3am automatic path.
      await dialog.showMessageBox({ type: 'warning', message: 'Orgtree did not install the update.' })
      fs.appendFileSync(${JSON.stringify(marker('awaited'))}, 'past-dialog\\n')
      app.exit(0)
    })
  `, { waitMs: 7000 })
  t.after(() => { try { probe.child.kill('SIGKILL') } catch { /* already gone */ } })

  const { exited, exitCode, log } = await probe.settle()
  assert.equal(wrote(marker('awaited')).includes('reached'), true,
    `the probe got as far as the dialog. Probe output: ${log}`)
  assert.equal(exited, false,
    'CONTROL: it is STILL RUNNING seven seconds later, with the exit sitting '
    + 'behind a modal nobody will dismiss. This is the property that makes the '
    + 'awaited form unusable on the automatic path, and it is why §2 below is a '
    + `measurement rather than a formality. Exit code ${exitCode}; probe output: ${log}`)
  assert.equal(wrote(marker('awaited')).includes('past-dialog'), false,
    'and it never got past the dialog, so nothing after it could have run — '
    + 'app.relaunch() included')
})

test('§2 THE SHIPPED SHAPE EXITS AT ONCE, with nobody present', async (t) => {
  // The statements the failure branch actually executes: record, then exit.
  // Nothing is put on screen, so nothing can hold the process open.
  const probe = runElectron('records-and-exits', `
    const { app } = require('electron')
    const fs = require('node:fs')
    app.whenReady().then(() => {
      fs.appendFileSync(${JSON.stringify(marker('shipped'))}, 'not-installed\\n')
      // ⚠ app.relaunch() IS DELIBERATELY OMITTED. It would start another copy
      // of this very probe with the same arguments, and that copy would start
      // another: a relaunch loop in a test. The property under test here is
      // that NOTHING BLOCKS THE EXIT; that the exit is preceded by a relaunch
      // is pinned textually by lifetime-wiring.test.mjs instead.
      app.exit(0)
    })
  `, { waitMs: 7000 })
  t.after(() => { try { probe.child.kill('SIGKILL') } catch { /* already gone */ } })

  const { exited, exitedAfter } = await probe.settle()
  assert.equal(wrote(marker('shipped')), 'not-installed',
    'the outcome is recorded first, because the log is the only thing that '
    + 'outlives this process')
  assert.equal(exited, true,
    'and then it EXITS — no click is on the critical path to the app coming '
    + 'back, which is the binding unattended property')
  assert.ok(exitedAfter < 5000, `and promptly: ${exitedAfter}ms`)
})

test('§3 THE REPORT DOES RENDER, in an instance that stays running', async (t) => {
  // The other half. Reporting from a live app means the dialog is presented
  // without anything waiting on it — so this must show a real window, and the
  // process must still be there afterwards rather than exiting behind it.
  const probe = runElectron('report-renders', `
    const { app, dialog } = require('electron')
    const fs = require('node:fs')
    app.whenReady().then(() => {
      fs.appendFileSync(${JSON.stringify(marker('report'))}, 'shown\\n')
      // Un-awaited on purpose, and correct HERE precisely because nothing after
      // it is load-bearing: the app goes on running either way. Delivery is
      // recorded when it resolves, which is the user dismissing it.
      dialog.showMessageBox({ type: 'warning', message: 'Orgtree did not install the update.',
        detail: 'The full record is in update-log.json beside Orgtree\\'s data.' })
        .then(() => { fs.appendFileSync(${JSON.stringify(marker('report'))}, 'dismissed\\n') })
        .catch(() => {})
      setInterval(() => {}, 1000)
    })
  `, { waitMs: 1, showWindows: true })
  t.after(() => { try { probe.child.kill('SIGKILL') } catch { /* already gone */ } })

  // Poll for the window: dialog creation is not instant and a fixed sleep is a
  // guess about machine load.
  let seen = 0
  for (const _attempt of Array.from({ length: 40 })) {
    seen = await visibleWindows(probe.child.pid)
    if (seen > 0) break
    await sleep(250)
  }
  assert.ok(seen > 0,
    'a real visible top-level window belonging to that process tree is on '
    + 'screen — the report is genuinely presented, not merely requested')
  assert.equal(wrote(marker('report')).includes('shown'), true, 'and it recorded that it showed it')
  assert.equal(wrote(marker('report')).includes('dismissed'), false,
    'DELIVERY IS NOT RECORDED YET, because nobody has dismissed it. That is the '
    + 'distinction the shipped code keeps: shown bounds the repeats, dismissed '
    + 'ends them, and writing "reported" up front would have marked a message '
    + 'delivered that no human ever saw')
})

test('§3b CONTROL: the window probe does not report a window for an app that shows none', async (t) => {
  // Without this, §3 would pass against a probe that answers "window" for any
  // live Electron process — the observation has to be capable of saying no.
  const probe = runElectron('no-dialog', `
    const { app } = require('electron')
    app.whenReady().then(() => { setInterval(() => {}, 1000) })
  `, { waitMs: 1, showWindows: true })
  t.after(() => { try { probe.child.kill('SIGKILL') } catch { /* already gone */ } })

  await sleep(3000)
  assert.equal(await visibleWindows(probe.child.pid), 0,
    'CONTROL: a live Electron app with no dialog and no window reports ZERO, so '
    + "§3's observation distinguishes a presented dialog from a running process "
    + 'rather than answering yes to anything alive')
})
