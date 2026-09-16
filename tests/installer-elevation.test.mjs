// 2.1.3-RC4 FIELD FAILURE: the installer stopped at "Installing", 3%, forever.
//
// The graceful close worked perfectly — the lifecycle log recorded
// `result: closed gracefully` 2.2 seconds after it asked — and then nothing
// else ever happened. Setup had reached the boot preflight section and called
// UAC_RunElevated *there*, which starts a SECOND complete installer wizard and
// blocks the first one until that one finishes. The first window was never
// hidden, so what the user saw was a frozen installer with another Setup
// window behind it. Not one byte was written to the installation directory,
// and the boot task was left enabled, which is how we know the section never
// got past that line.
//
// Two separate defects came out of it, and this file pins both:
//   1. WHERE elevation happens. It belongs at install-mode selection, which is
//      where electron-builder does it, not inside a section half way through
//      "Installing".
//   2. WHAT "closed" means. The close helper only ever matched the image name
//      `Orgtree.exe`, so the engine running from the installation directory —
//      the thing that actually blocks replacing files — was never checked.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { spawn, spawnSync } from 'node:child_process'
import { setTimeout } from 'node:timers/promises'

const root = path.resolve(import.meta.dirname, '..')
const installer = fs.readFileSync(path.join(root, 'build/installer.nsh'), 'utf8')
const helper = fs.readFileSync(path.join(root, 'tools/installer-upgrade.ps1'), 'utf8')

function macro(name) {
  const found = installer.match(new RegExp(`!macro ${name}[\\s\\S]*?!macroend`))
  assert.ok(found, `${name} macro not found`)
  return found[0]
}

// The sections carry long comments explaining why they do NOT elevate, and
// those comments name the instruction they are warning about. Strip them, or
// the explanation of the defect reads as the defect.
function withoutComments(text) {
  return text.replace(/^[ \t]*#.*$/gm, '')
}

test('elevation happens at install-mode selection, never from inside a section', () => {
  // electron-builder's own rule, stated in templates/nsis/installer.nsi: "For
  // a non-silent install, the elevation will be triggered when the install
  // mode is selected in the UI". The Upgrade choice reaches customInstallMode
  // and then Aborts the mode page, so if it does not elevate there, nothing
  // does — and the first thing to notice is the boot preflight section.
  const customInstallMode = macro('customInstallMode')
  assert.match(customInstallMode, /\$\{ifNot\} \$\{UAC_IsAdmin\}[\s\S]*?!insertmacro UAC_RunElevated/)

  // Every elevation site in electron-builder hides its own window first. That
  // is the difference between the outer instance disappearing and the outer
  // instance impersonating a hung installer, which is what RC4 did.
  assert.match(
    customInstallMode,
    /ShowWindow \$HWNDPARENT \$\{SW_HIDE\}\s*\n\s*!insertmacro UAC_RunElevated/,
    'UAC_RunElevated must be immediately preceded by hiding this window',
  )

  // And no Section may elevate. This is the RC4 defect itself.
  const sections = [...installer.matchAll(/\n[ \t]*Section [^\n]*\n[\s\S]*?\n[ \t]*SectionEnd/g)]
  assert.ok(sections.length, 'no sections found to check')
  for (const section of sections) {
    assert.doesNotMatch(
      withoutComments(section[0]),
      /UAC_RunElevated/,
      'a Section elevates: that starts a second wizard behind the Installing page',
    )
  }
})

test('a failed or declined elevation never continues unelevated', () => {
  const customInstallMode = macro('customInstallMode')
  // Exactly one outcome proceeds: $0 == 0 AND $1 == 1, meaning an elevated
  // instance actually ran the upgrade and this process is only its wrapper.
  // (`==` rather than `=`: LogicLib's numeric form does not expand here, and
  // the NSIS fixture suite catches that as a compile error.)
  assert.match(customInstallMode, /\$\{if\} \$0 == 0\s*\r?\n\s*\$\{andif\} \$1 == 1\s*\r?\n[\s\S]*?Quit/)
  // Every other outcome restores this window, says what happened, and stops.
  // Continuing without admin would only move the failure to the point where
  // files are being replaced.
  assert.match(customInstallMode, /ShowWindow \$HWNDPARENT \$\{SW_SHOW\}/)
  assert.match(customInstallMode, /\$\{if\} \$0 == 1223/)
  assert.match(customInstallMode, /SetErrorLevel 2\s*\n\s*Quit/)
  // The boot preflight is now a fail-closed assertion rather than a second
  // elevation point.
  assert.match(installer, /Boot preflight reached without administrator rights/)
})

test('an elevated instance inherits the choice instead of asking for it again', () => {
  // UAC_RunElevated starts a brand new installer process that re-runs onInit
  // and every page from the beginning. Without carrying the selection across,
  // the user is shown the entire wizard a second time — the other half of what
  // made RC4 look broken rather than merely slow.
  const preInit = macro('preInit')
  assert.match(preInit, /\$\{if\} \$\{UAC_IsInnerInstance\}/)
  for (const variable of [
    '$OrgUpgradeSelected',
    '$OrgUpgradeChoice',
    '$OrgUpgradeAvailable',
    '$OrgUpgradeInstallMode',
    '$OrgUpgradeInstallDir',
    '$OrgUpgradeExe',
  ]) {
    assert.ok(
      preInit.includes(`UAC_AsUser_GetGlobalVar ${variable}`),
      `the elevated instance does not inherit ${variable}`,
    )
  }

  // And it must not re-derive them. An elevated process does not read the same
  // per-user registry as the one that made the choice, so re-detecting could
  // point the install at a different directory than the user was shown.
  const show = installer.match(/Function orgtreeUpgradePageShow[\s\S]*?FunctionEnd/)
  assert.ok(show, 'orgtreeUpgradePageShow not found')
  const alreadyChosen = show[0].indexOf('$OrgUpgradeSelected == "1"')
  const detect = show[0].indexOf('Call orgtreeDetectUpgradeInstall')
  assert.ok(alreadyChosen >= 0 && detect >= 0, 'the upgrade page lost a check it needs')
  assert.ok(
    alreadyChosen < detect,
    'the already-chosen check must come before detection re-reads the registry',
  )
})

test('the close helper verifies the whole installation tree, not just Orgtree.exe', () => {
  assert.match(helper, /function Assert-InstallTreeQuiet/)
  assert.match(helper, /function Get-InstallTreeProcesses/)
  // Membership is by image path under the installation root, plus descendants.
  assert.match(helper, /StartsWith\(\$script:TreePrefix\.ToUpperInvariant\(\)\)/)
  assert.match(helper, /descendant/)

  // Both success paths are gated on it. The already-closed path is the
  // dangerous one: "no Orgtree.exe is running" says nothing whatsoever about
  // the engine, and that is the path a second invocation always takes.
  assert.match(
    helper,
    /if \(\$running\.Count -eq 0\) \{[\s\S]*?Assert-InstallTreeQuiet \$overallDeadline[\s\S]*?result: already closed/,
  )
  assert.match(
    helper,
    /desktop: every watched process verifiably exited[\s\S]*?Assert-InstallTreeQuiet \$overallDeadline[\s\S]*?result: closed gracefully/,
  )
  // Including the recovery path, or an error raised mid-run would become the
  // one way to skip the check entirely.
  assert.match(helper, /if \(\$script:Requested[\s\S]*?Assert-InstallTreeQuiet \$overallDeadline/)

  // It still never kills, stops or signals anything.
  assert.doesNotMatch(helper, /Stop-Process|taskkill|\.Kill\(\)/)

  // An unreadable image path alone must not condemn an unrelated process: a
  // readable command line that does not name this installation is positive
  // evidence it is something else. Without that step the rule degenerates to
  // "is it called python.exe", and any unrelated Python stalls every upgrade.
  assert.match(helper, /if \(\$CommandReadable -and -not \(Test-Blank \$Command\)\)/)
})

test('both tree readings report a parent, and neither answering fails closed', () => {
  // `Get-Process` answers the image half of the question and nothing else. It
  // is the fallback for single-image detection and must NOT be the fallback
  // here, because "no installed image is running" reported as "the tree is
  // quiet" is a narrower answer presented as the whole one.
  assert.match(helper, /function Get-TreeReadingsFromWmi/)
  assert.doesNotMatch(withoutComments(helper), /function Get-TreeReadingsFromTable/)

  // The enumeration lives in Get-InstallTreeReadings, separately from the
  // membership rules, because Get-InstallTreeHolders needs the same reading
  // twice over: once to decide who is in the tree, and once to decide whether a
  // process id the snapshot recorded still belongs to the process it recorded.
  const readings = helper.match(/function Get-InstallTreeReadings[\s\S]*?\r?\n  \}\r?\n/)
  assert.ok(readings, 'Get-InstallTreeReadings not found')
  assert.match(readings[0], /Get-TreeReadingsFromCim[\s\S]*?Get-TreeReadingsFromWmi[\s\S]*?throw /)
  assert.match(helper, /could not be enumerated/)

  // The closure over parent ids is unconditional now. It used to sit behind a
  // flag that the image-only fallback turned off, which is what allowed an
  // empty result to be reported as success.
  assert.doesNotMatch(helper, /descendantsAnswerable/)
})

test('the installation tree is captured before anything is asked to close', () => {
  // A fresh scan cannot see an external-image child whose in-tree parent has
  // already exited: the child keeps a parent id that is no longer in the table,
  // so the closure has no root to walk from. The pre-close snapshot is the only
  // reading that ever saw that relationship.
  const snapshot = helper.indexOf("Set-Step 'snapshot-install-tree'")
  const detect = helper.indexOf("Set-Step 'detect-running-processes'")
  const request = helper.indexOf("Set-Step 'request-graceful-shutdown'")
  assert.ok(snapshot >= 0, 'the install tree is never snapshotted')
  assert.ok(snapshot < detect && detect < request, 'the snapshot must be taken before the close is requested')

  // And every success path is held to BOTH readings, because they answer
  // different halves: the fresh scan catches what started after the snapshot,
  // the snapshot catches what the fresh scan can no longer reach.
  const holders = helper.match(/function Get-InstallTreeHolders[\s\S]*?\r?\n  \}\r?\n/)
  assert.ok(holders, 'Get-InstallTreeHolders not found')
  assert.match(holders[0], /Get-InstallTreeMembers[\s\S]*?\$script:TreeSnapshot[\s\S]*?Test-TargetAlive/)
  assert.match(helper, /function Assert-InstallTreeQuiet[\s\S]*?Get-InstallTreeHolders/)

  // And the snapshot is an ancestry SEED in every later reading, not only a
  // list of ids to re-check for liveness. Without that, a child started after
  // the snapshot by a parent that then exits is reachable from neither half.
  const members = helper.match(/function Get-InstallTreeMembers[\s\S]*?\r?\n  \}\r?\n/)
  assert.ok(members, 'Get-InstallTreeMembers not found')
  assert.match(
    members[0],
    /foreach \(\$member in @\(\$script:TreeSnapshot\)\) \{\s*\r?\n\s*\$inTree\[\[int\]\$member\.Id\] = \$true/,
    'the snapshot must seed the closure',
  )
  // Seeds are seeds only. A seed that this reading did not observe must not be
  // reported as holding the installation, or quiet stops being an observation.
  const seedAt = members[0].indexOf('$script:TreeSnapshot')
  const closureAt = members[0].indexOf('$added = $true')
  assert.ok(seedAt >= 0 && closureAt > seedAt, 'the seeds must be added before the closure runs')
  assert.doesNotMatch(
    members[0].slice(seedAt, closureAt),
    /\$held \+=/,
    'a snapshot seed must not be reported as a holder by itself',
  )
})

// THE MUTATION-PROVABLE ONE. Take Assert-InstallTreeQuiet out of the
// already-closed path and this reports success while a process is running from
// the installation folder — which is the defect, exactly.
test(
  'the helper refuses while anything still runs from the installation folder',
  { skip: process.platform !== 'win32' ? 'Windows only' : false },
  () => {
    const system32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32')
    const shell = path.join(system32, 'WindowsPowerShell/v1.0/powershell.exe')
    const ping = path.join(system32, 'PING.EXE')
    assert.ok(fs.existsSync(shell), 'no Windows PowerShell 5.1 host')
    assert.ok(fs.existsSync(ping), 'no standalone executable to stand in for the engine')

    // A disposable fixture installation. Nothing here reads, touches or
    // signals any real Orgtree: the helper is path-bound, so an installation
    // anywhere else can never match this root.
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TEMP || '.'), 'orgtree-tree-'))
    const runtime = path.join(dir, 'resources/engine/runtime')
    fs.mkdirSync(runtime, { recursive: true })
    fs.writeFileSync(path.join(dir, 'Orgtree.exe'), 'fixture')
    // Stands in for the packaged engine runtime: a real, long-running
    // executable whose image lives inside the installation directory. Its own
    // name matters — the point is that it is NOT called Orgtree.exe.
    const engine = path.join(runtime, 'python.exe')
    fs.copyFileSync(ping, engine)

    const runHelper = () =>
      spawnSync(
        shell,
        [
          '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
          '-File', path.join(root, 'tools/installer-upgrade.ps1'),
          '-InstallDir', dir,
          '-ExecutablePath', path.join(dir, 'Orgtree.exe'),
          '-TimeoutSeconds', '5',
        ],
        { encoding: 'utf8', windowsHide: true },
      )

    const started = spawnSync(
      shell,
      ['-NoProfile', '-NonInteractive', '-Command',
        `$p = Start-Process -FilePath '${engine}' -ArgumentList '-n','30','127.0.0.1' -WindowStyle Hidden -PassThru; [Console]::Out.Write($p.Id)`],
      { encoding: 'utf8', windowsHide: true },
    )
    const enginePid = Number.parseInt((started.stdout || '').trim(), 10)
    assert.ok(Number.isInteger(enginePid) && enginePid > 0, `could not start the fixture engine: ${started.stderr}`)

    try {
      const blocked = runHelper()
      // No Orgtree.exe is running anywhere near this fixture, so before the
      // fix the helper answered "Orgtree is already closed" here and the
      // installer went on to replace files underneath a live engine.
      assert.equal(
        blocked.status, 2,
        `expected a refusal, got ${blocked.status}: ${blocked.stdout}${blocked.stderr}`,
      )
      assert.match(blocked.stderr, /still running from the installation folder/)
      assert.match(blocked.stderr, /python\.exe/)
      assert.doesNotMatch(blocked.stdout || '', /already closed/)
    } finally {
      // Only ever this fixture's own process, by the id we started.
      spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command',
        `Stop-Process -Id ${enginePid} -Force -ErrorAction SilentlyContinue`], { windowsHide: true })
    }

    // And once the tree is genuinely quiet it reports success — so the check
    // is refusing the right thing rather than refusing everything.
    const quiet = runHelper()
    assert.equal(
      quiet.status, 0,
      `expected success once quiet, got ${quiet.status}: ${quiet.stdout}${quiet.stderr}`,
    )
    assert.match(quiet.stdout, /already closed/)
    fs.rmSync(dir, { recursive: true, force: true })
  },
)

// ---------------------------------------------------------------------------
// The two failure modes the direct-image fixture above never exercises. Both
// run the real helper, in the real Windows PowerShell 5.1 host the installer
// uses, against a disposable fixture installation. Nothing here reads, touches
// or signals any real Orgtree: the helper is path-bound to the fixture root.
// ---------------------------------------------------------------------------

const windows = process.platform === 'win32'
const system32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32')
const shell = path.join(system32, 'WindowsPowerShell/v1.0/powershell.exe')
const pingExe = path.join(system32, 'PING.EXE')
const helperPath = path.join(root, 'tools/installer-upgrade.ps1')

function fixtureInstall() {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TEMP || '.'), 'orgtree-tree-'))
  fs.mkdirSync(path.join(dir, 'resources/engine/runtime'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'Orgtree.exe'), 'fixture')
  return dir
}

// Runs the helper with `prelude` evaluated first in the same session. A
// function beats a cmdlet in PowerShell's command resolution and a called
// script sees its caller's functions, so this is how an enumeration is made to
// fail on a machine where it works — without putting a test hook in the helper.
function runHelper(dir, { prelude = '', timeout = 5 } = {}) {
  const log = path.join(dir, `log-${Math.random().toString(36).slice(2)}.txt`)
  const invoke = `& '${helperPath}' -InstallDir '${dir}' -ExecutablePath '${path.join(dir, 'Orgtree.exe')}' -TimeoutSeconds ${timeout} -LogPath '${log}'`
  const result = spawnSync(
    shell,
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `${prelude}\n${invoke}\nexit $LASTEXITCODE`],
    { encoding: 'utf8', windowsHide: true },
  )
  // Safe to read: spawnSync has already reaped the helper, so nothing holds it.
  result.log = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : ''
  return result
}

const BREAK_CIM = "function Get-CimInstance { throw 'forced CIM failure' }"
const BREAK_WMI = "function Get-WmiObject { throw 'forced WMI failure' }"

test(
  'when CIM cannot answer, WMI answers the descendant question rather than the process table',
  { skip: !windows ? 'Windows only' : false },
  () => {
    const dir = fixtureInstall()
    const engine = path.join(dir, 'resources/engine/runtime/python.exe')
    fs.copyFileSync(pingExe, engine)

    const started = spawnSync(
      shell,
      ['-NoProfile', '-NonInteractive', '-Command',
        `$p = Start-Process -FilePath '${engine}' -ArgumentList '-n','30','127.0.0.1' -WindowStyle Hidden -PassThru; [Console]::Out.Write($p.Id)`],
      { encoding: 'utf8', windowsHide: true },
    )
    const enginePid = Number.parseInt((started.stdout || '').trim(), 10)
    assert.ok(Number.isInteger(enginePid) && enginePid > 0, `could not start the fixture engine: ${started.stderr}`)

    try {
      const blocked = runHelper(dir, { prelude: BREAK_CIM })
      assert.equal(blocked.status, 2, `expected a refusal, got ${blocked.status}: ${blocked.stdout}${blocked.stderr}`)
      assert.match(blocked.stderr, /still running from the installation folder/)
      assert.match(blocked.stderr, /python\.exe/)
      // It must be the parent-capable reading that answered, not the image-only
      // one: the whole point is that descendants stay answerable.
      assert.match(blocked.log, /WMI answered; descendants remain answerable/)
    } finally {
      spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command',
        `Stop-Process -Id ${enginePid} -Force -ErrorAction SilentlyContinue`], { windowsHide: true })
    }

    // And WMI can still report quiet, so this is a working reading rather than
    // a path that only ever refuses.
    const quiet = runHelper(dir, { prelude: BREAK_CIM })
    assert.equal(quiet.status, 0, `expected success once quiet, got ${quiet.status}: ${quiet.stdout}${quiet.stderr}`)
    assert.match(quiet.stdout, /already closed/)
    assert.match(quiet.log, /WMI answered/)
    fs.rmSync(dir, { recursive: true, force: true })
  },
)

test(
  'when no parent-capable reading can answer, the helper refuses instead of reporting quiet',
  { skip: !windows ? 'Windows only' : false },
  () => {
    // The tree is genuinely quiet here — no fixture process at all. Before the
    // fix this reported "Orgtree is already closed", because the image-only
    // fallback returned an empty list and an empty list read as success. An
    // enumeration that explicitly cannot see descendants cannot establish that
    // there are none.
    const dir = fixtureInstall()
    const refused = runHelper(dir, { prelude: `${BREAK_CIM}\n${BREAK_WMI}` })
    assert.equal(refused.status, 2, `expected a refusal, got ${refused.status}: ${refused.stdout}${refused.stderr}`)
    assert.match(refused.stderr, /could not be enumerated/)
    assert.match(refused.stderr, /snapshot-install-tree/)
    // Both failures are named, so the user is told what actually broke.
    assert.match(refused.stderr, /forced CIM failure/)
    assert.match(refused.stderr, /forced WMI failure/)
    assert.doesNotMatch(refused.stdout || '', /already closed/)
    fs.rmSync(dir, { recursive: true, force: true })
  },
)

// ---------------------------------------------------------------------------
// THE TWO SNAPSHOT REGRESSIONS.
//
// Both need a specific ordering around a moment inside the helper's run — the
// pre-close snapshot — and that moment is not externally observable. The log
// line announcing it is NOT usable as a live handshake: the helper appends with
// `Add-Content`, which opens the file exclusively, and its logging is
// deliberately best-effort, so a test polling that file makes the helper
// silently DROP the very lines it is waiting for. (Measured, not assumed: two
// consecutive lines went missing from a run whose behaviour was otherwise
// correct.)
//
// So nothing here reads the log while the helper is running. Each attempt lets
// the helper settle for a bounded interval, drives the fixture, waits for the
// helper to exit, and only THEN reads the log to establish whether the ordering
// it needed actually happened. If it did not, the attempt is discarded and
// retried with a longer settle; the assertions only ever run against an attempt
// whose premise is established. Process-state polling is used freely — that
// goes through CIM and cannot disturb anything.
// ---------------------------------------------------------------------------

async function until(predicate, description, limitMs = 30000) {
  const deadline = Date.now() + limitMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await setTimeout(100)
  }
  assert.fail(`timed out waiting for ${description}`)
}

function childrenOf(parentPid, name) {
  const listed = spawnSync(
    shell,
    ['-NoProfile', '-NonInteractive', '-Command',
      `@(Get-CimInstance Win32_Process -Filter "Name='${name}' AND ParentProcessId=${parentPid}") | ForEach-Object { $_.ProcessId }`],
    { encoding: 'utf8', windowsHide: true },
  )
  return (listed.stdout || '').split(/\s+/).map((value) => Number.parseInt(value, 10)).filter(Number.isInteger)
}

function alive(pid) {
  const probe = spawnSync(
    shell,
    ['-NoProfile', '-NonInteractive', '-Command',
      `if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { [Console]::Out.Write('yes') } else { [Console]::Out.Write('no') }`],
    { encoding: 'utf8', windowsHide: true },
  )
  return (probe.stdout || '').trim() === 'yes'
}

function stop(pid) {
  spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command',
    `Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`], { windowsHide: true })
}

// Starts the helper against a fixture install and returns a handle. Its log is
// NOT read until `exit` has resolved.
function startHelper(dir, log, timeoutSeconds) {
  const child = spawn(
    shell,
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helperPath,
      '-InstallDir', dir, '-ExecutablePath', path.join(dir, 'Orgtree.exe'),
      '-TimeoutSeconds', String(timeoutSeconds), '-LogPath', log],
    { windowsHide: true },
  )
  const handle = { stdout: '', stderr: '', done: false }
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => { handle.stdout += chunk })
  child.stderr.on('data', (chunk) => { handle.stderr += chunk })
  handle.exit = new Promise((resolve) => child.on('close', (code) => { handle.done = true; resolve(code) }))
  return handle
}

function snapshotLineOf(log) {
  const text = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : ''
  return text.split(/\r?\n/).find((line) => line.includes('install-tree: snapshot of')) || ''
}

// Four attempts, each settling twice as long as the last. A premise that never
// holds fails the test loudly rather than passing on a scenario that did not
// happen.
async function withGrowingSettle(attempt) {
  const reasons = []
  for (let settleMs = 1500, n = 0; n < 4; settleMs *= 2, n += 1) {
    const outcome = await attempt(settleMs)
    if (outcome.premise) return outcome
    reasons.push(`settle ${settleMs}ms: ${outcome.premiseFailure}`)
  }
  assert.fail(`the ordering this test needs was never established:\n  ${reasons.join('\n  ')}`)
}

test(
  'a child left behind by an exited in-tree process still blocks the upgrade',
  { skip: !windows ? 'Windows only' : false },
  async () => {
    // The engine starts helpers whose own images live outside the installation
    // — agent CLIs, node, uv. If such a child outlives the process that started
    // it, a fresh scan cannot recognise it: its image is not under the root and
    // its parent id points at a process that is gone. Only the reading taken
    // before the close ever saw the two of them connected.
    const outcome = await withGrowingSettle(async (settleMs) => {
      const dir = fixtureInstall()
      // A copy of cmd.exe standing in for the packaged runtime: an in-tree
      // image that can start a child and then exit, which PING.EXE cannot do.
      const engine = path.join(dir, 'resources/engine/runtime/python.exe')
      fs.copyFileSync(path.join(system32, 'cmd.exe'), engine)
      const release = path.join(dir, 'release.flag')
      const script = path.join(dir, 'spawn.cmd')
      fs.writeFileSync(
        script,
        [
          '@echo off',
          // The child exists from the outset, so the snapshot records it.
          `start "" "${pingExe}" -n 120 127.0.0.1`,
          ':wait',
          `if exist "${release}" goto done`,
          `"${pingExe}" -n 2 127.0.0.1 > nul`,
          'goto wait',
          ':done',
          '',
        ].join('\r\n'),
      )

      const started = spawnSync(
        shell,
        ['-NoProfile', '-NonInteractive', '-Command',
          `$p = Start-Process -FilePath '${engine}' -ArgumentList '/c','${script}' -WindowStyle Hidden -PassThru; [Console]::Out.Write($p.Id)`],
        { encoding: 'utf8', windowsHide: true },
      )
      const parentPid = Number.parseInt((started.stdout || '').trim(), 10)
      assert.ok(Number.isInteger(parentPid) && parentPid > 0, `could not start the fixture engine: ${started.stderr}`)

      let orphan = 0
      let helper = { done: false, exit: null }
      try {
        await until(() => {
          const candidates = childrenOf(parentPid, 'PING.EXE')
          if (!candidates.length) return false
          orphan = candidates[0]
          return true
        }, 'the fixture child to start')

        const log = path.join(dir, 'orphan.log')
        helper = startHelper(dir, log, Math.round(settleMs / 1000) + 8)
        await setTimeout(settleMs)
        const helperFinishedEarly = helper.done

        fs.writeFileSync(release, '')
        await until(() => !alive(parentPid), 'the fixture parent to exit')
        const status = await helper.exit

        const snapshot = snapshotLineOf(log)
        if (helperFinishedEarly) {
          return { premise: false, premiseFailure: 'the helper finished before the parent was released' }
        }
        if (!snapshot) return { premise: false, premiseFailure: 'the helper logged no snapshot' }
        if (!new RegExp(`PING\\.EXE\\(${orphan},descendant\\)`, 'i').test(snapshot)) {
          return { premise: false, premiseFailure: `the snapshot did not record the child: ${snapshot}` }
        }
        return { premise: true, dir, orphan, status, stdout: helper.stdout, stderr: helper.stderr }
      } finally {
        if (orphan) stop(orphan)
        if (!fs.existsSync(release)) fs.writeFileSync(release, '')
        if (helper.exit) await helper.exit
      }
    })

    // The child was in the snapshot and outlived its in-tree parent, so only
    // the retained snapshot identity can still account for it.
    assert.equal(outcome.status, 2, `expected a refusal, got ${outcome.status}: ${outcome.stdout}${outcome.stderr}`)
    assert.match(outcome.stderr, new RegExp(`PING\\.EXE\\(${outcome.orphan},descendant\\)\\(pre-close\\)`, 'i'))
    // The parent really was gone by then, so nothing but the snapshot could
    // have produced that entry.
    assert.doesNotMatch(outcome.stderr, /python\.exe/i)
    assert.doesNotMatch(outcome.stdout, /already closed/)

    // And once the tree is genuinely quiet the same fixture reports success, so
    // the check is refusing this process rather than refusing everything.
    await until(() => !alive(outcome.orphan), 'the fixture child to be cleaned up')
    const quiet = runHelper(outcome.dir)
    assert.equal(quiet.status, 0, `expected success once quiet, got ${quiet.status}: ${quiet.stdout}${quiet.stderr}`)
    assert.match(quiet.stdout, /already closed/)
    fs.rmSync(outcome.dir, { recursive: true, force: true })
  },
)

test(
  'a child created AFTER the snapshot by a parent that then exits still blocks the upgrade',
  { skip: !windows ? 'Windows only' : false },
  async () => {
    // The narrower race. Above, the child already existed when the snapshot was
    // taken, so the snapshot knew its id. Here it does not exist yet:
    //   1. the snapshot sees the in-tree parent alone;
    //   2. the parent starts an external-image child and exits;
    //   3. the fresh reading sees the child, pointing at a parent id that is no
    //      longer in the table and was never an installation image;
    //   4. so the child is seeded by nothing and recorded by nothing.
    // It is caught only because every snapshotted id stays an ancestry seed in
    // every later reading, whether or not that process still exists.
    const outcome = await withGrowingSettle(async (settleMs) => {
      const dir = fixtureInstall()
      const runtime = path.join(dir, 'resources/engine/runtime')
      const engine = path.join(runtime, 'python.exe')
      fs.copyFileSync(path.join(system32, 'cmd.exe'), engine)
      // The parent has to wait without spawning anything named PING.EXE, or the
      // premise "the snapshot does not yet know the child" would be answered by
      // the waiting itself. An in-tree copy under its own name is a legitimate
      // member of the tree and is expected in the snapshot.
      const waiter = path.join(runtime, 'waiter.exe')
      fs.copyFileSync(pingExe, waiter)
      const spawnFlag = path.join(dir, 'spawn.flag')
      const script = path.join(dir, 'spawn.cmd')
      fs.writeFileSync(
        script,
        [
          '@echo off',
          ':wait',
          `if exist "${spawnFlag}" goto go`,
          `"${waiter}" -n 2 127.0.0.1 > nul`,
          'goto wait',
          ':go',
          // Started only now — after the snapshot — and the parent exits the
          // moment this returns.
          `start "" /B "${pingExe}" -n 120 127.0.0.1`,
          '',
        ].join('\r\n'),
      )

      const started = spawnSync(
        shell,
        ['-NoProfile', '-NonInteractive', '-Command',
          `$p = Start-Process -FilePath '${engine}' -ArgumentList '/c','${script}' -WindowStyle Hidden -PassThru; [Console]::Out.Write($p.Id)`],
        { encoding: 'utf8', windowsHide: true },
      )
      const parentPid = Number.parseInt((started.stdout || '').trim(), 10)
      assert.ok(Number.isInteger(parentPid) && parentPid > 0, `could not start the fixture engine: ${started.stderr}`)

      let child = 0
      let helper = { done: false, exit: null }
      try {
        const log = path.join(dir, 'late-child.log')
        helper = startHelper(dir, log, Math.round(settleMs / 1000) + 8)
        await setTimeout(settleMs)
        const helperFinishedEarly = helper.done

        fs.writeFileSync(spawnFlag, '')
        await until(() => {
          const candidates = childrenOf(parentPid, 'PING.EXE')
          if (!candidates.length) return false
          child = candidates[0]
          return true
        }, 'the late child to start')
        await until(() => !alive(parentPid), 'the fixture parent to exit')
        const status = await helper.exit

        const snapshot = snapshotLineOf(log)
        if (helperFinishedEarly) {
          return { premise: false, premiseFailure: 'the helper finished before the child was created' }
        }
        if (!snapshot) return { premise: false, premiseFailure: 'the helper logged no snapshot' }
        if (!/python\.exe\(\d+,image\)/i.test(snapshot)) {
          return { premise: false, premiseFailure: `the snapshot did not record the in-tree parent: ${snapshot}` }
        }
        if (/PING\.EXE/i.test(snapshot)) {
          return { premise: false, premiseFailure: `the child already existed at snapshot time: ${snapshot}` }
        }
        return { premise: true, dir, child, status, stdout: helper.stdout, stderr: helper.stderr }
      } finally {
        if (child) stop(child)
        if (!fs.existsSync(spawnFlag)) fs.writeFileSync(spawnFlag, '')
        if (helper.exit) await helper.exit
      }
    })

    assert.equal(outcome.status, 2, `expected a refusal, got ${outcome.status}: ${outcome.stdout}${outcome.stderr}`)
    // Reached by the closure in a FRESH reading, seeded by the snapshot — so it
    // is named as a descendant, not as a retained snapshot member.
    assert.match(outcome.stderr, new RegExp(`PING\\.EXE\\(${outcome.child},descendant\\)`, 'i'))
    assert.doesNotMatch(outcome.stdout, /already closed/)

    await until(() => !alive(outcome.child), 'the late child to be cleaned up')
    const quiet = runHelper(outcome.dir)
    assert.equal(quiet.status, 0, `expected success once quiet, got ${quiet.status}: ${quiet.stdout}${quiet.stderr}`)
    assert.match(quiet.stdout, /already closed/)
    fs.rmSync(outcome.dir, { recursive: true, force: true })
  },
)

// ---------------------------------------------------------------------------
// THE PARENT-ID REUSE REGRESSIONS.
//
// 2.1.6-beta.1 FIELD FAILURE. An upgrade was refused naming eight processes
// with no connection to Orgtree — Microsoft.CmdPal.UI.exe, M365Copilot.exe and
// six msedgewebview2.exe. Retrying worked, which is what made it read as a
// phantom.
//
// MEASURED, not inferred. Every one of those eight was still running the next
// day, and the process table says why: CmdPal recorded parent id 12264 and
// M365Copilot recorded 27340, both processes that had exited the day before,
// and the six webview hosts are M365Copilot's own children. The failing
// snapshot lists python.exe(12264,image) and python.exe(27340,image) — the
// engine was holding both of those numbers by then. Windows writes a parent id
// once and never revises it, so two day-old orphans were pointing at ids that
// now belonged to the installation, and the closure walked straight down them.
// CmdPal was created 2026-09-15 08:05:32, a full day before the python.exe that
// was supposedly its parent existed.
//
// Neither case can be staged by starting real processes, because no test can
// make Windows hand out a chosen process id. They are staged where the defect
// actually lives: the enumeration. `runHelper`'s prelude replaces
// Get-CimInstance in the calling session, so the REAL helper — the real closure,
// the real snapshot, the real holder logic — runs over a process table written
// by the test. No hook is added to the helper for this.
// ---------------------------------------------------------------------------

// The classification these tests are about is the pre-close snapshot line. The
// refusal message is a weaker instrument for it: a snapshot member that a later
// reading did not re-observe is only named there if its id is still alive, and
// whether some unrelated id happens to be alive is a property of the machine the
// test runs on, not of the helper.
function snapshotLine(log) {
  const line = String(log).split(/\r?\n/).find((entry) => entry.includes('install-tree: snapshot of'))
  assert.ok(line, `the helper logged no install-tree snapshot:\n${log}`)
  return line
}

// One fixture process record, shaped exactly as Win32_Process hands one over.
// `age` is seconds relative to the fixture clock: negative is older.
function fixtureProcess({ pid, ppid, name, path: image, age }) {
  return `New-FixtureProcess ${pid} ${ppid} '${name}' '${image}' ${age}`
}

function cimPrelude(tables) {
  const emit = (rows) => `@(\n${rows.map((row) => `      ${fixtureProcess(row)}`).join('\n')}\n    )`
  // Calls 1 and 2 are the pre-close snapshot and the Orgtree.exe detection;
  // everything after them is Assert-InstallTreeQuiet re-reading the table.
  const body = tables.length === 1
    ? `    return ${emit(tables[0])}`
    : [
      `    if ($global:fixtureCall -le 2) { return ${emit(tables[0])} }`,
      `    return ${emit(tables[1])}`,
    ].join('\n')
  // GLOBAL, not script-scoped. These functions are invoked from inside the
  // helper, so `$script:` there resolves to the HELPER's scope — where the
  // variable does not exist, and under its Set-StrictMode that is a terminating
  // error the helper reads as "CIM is unavailable" and quietly answers from WMI
  // instead. The fixture would then never be consulted at all.
  return [
    '$global:fixtureClock = (Get-Date).AddHours(-4)',
    '$global:fixtureCall = 0',
    'function New-FixtureProcess([int]$Id,[int]$Parent,[string]$Name,[string]$Image,[double]$Age) {',
    '  return [pscustomobject]@{',
    '    ProcessId = $Id; ParentProcessId = $Parent; Name = $Name',
    '    ExecutablePath = $Image; CommandLine = $Image',
    '    CreationDate = $global:fixtureClock.AddSeconds($Age)',
    '  }',
    '}',
    'function Get-CimInstance {',
    '  param([string]$ClassName, $Filter, $ErrorAction)',
    "  if ($ClassName -ne 'Win32_Process') { throw ('unexpected fixture query: ' + $ClassName) }",
    '  $global:fixtureCall = $global:fixtureCall + 1',
    body,
    '}',
  ].join('\n')
}

test(
  'a process that merely inherited an installation process id is not a descendant',
  { skip: !windows ? 'Windows only' : false },
  () => {
    const dir = fixtureInstall()
    const engine = path.join(dir, 'resources\\engine\\runtime\\python.exe')
    // The field failure, in miniature. 12264 is the engine now; the orphan
    // recorded 12264 four hours before the engine existed, and dragged its own
    // child in behind it. 20000 is a genuine engine child and must survive the
    // correction, or this would be a fix that simply stops looking.
    const table = [
      { pid: 12264, ppid: 800, name: 'python.exe', path: engine, age: 0 },
      { pid: 20000, ppid: 12264, name: 'node.exe', path: 'C:\\Program Files\\nodejs\\node.exe', age: 5 },
      { pid: 16440, ppid: 12264, name: 'Microsoft.CmdPal.UI.exe', path: 'C:\\Windows\\CmdPal\\Microsoft.CmdPal.UI.exe', age: -14400 },
      { pid: 2984, ppid: 16440, name: 'msedgewebview2.exe', path: 'C:\\Program Files\\WebView2\\msedgewebview2.exe', age: -14400 },
    ]
    const blocked = runHelper(dir, { prelude: cimPrelude([table]) })

    // The engine is genuinely there, so the upgrade is still refused — this
    // corrects the classification, it does not stop the check blocking.
    assert.equal(blocked.status, 2, `expected a refusal, got ${blocked.status}: ${blocked.stdout}${blocked.stderr}`)
    assert.match(blocked.stderr, /python\.exe\(12264,image\)/)

    // The classification itself is the snapshot line, so that is what is read
    // here. A real child of the engine, started after it, is still a descendant.
    const snapshot = snapshotLine(blocked.log)
    assert.match(snapshot, /python\.exe\(12264,image\)/)
    assert.match(snapshot, /node\.exe\(20000,descendant\)/)

    // And the two that only ever had a recycled number in common with it are
    // gone — from the classification, and from what the user is told.
    assert.doesNotMatch(blocked.log, /Microsoft\.CmdPal\.UI\.exe/)
    assert.doesNotMatch(blocked.log, /msedgewebview2\.exe/)
    assert.doesNotMatch(blocked.stderr, /Microsoft\.CmdPal\.UI\.exe/)
    assert.doesNotMatch(blocked.stderr, /msedgewebview2\.exe/)
    fs.rmSync(dir, { recursive: true, force: true })
  },
)

test(
  'the reused-id guard rejects an impossible parent, not an unfamiliar name',
  { skip: !windows ? 'Windows only' : false },
  () => {
    // THE NEGATIVE CONTROL for the test above. Identical table, identical
    // names, identical parent ids — the ONLY change is that the two processes
    // were created after the engine rather than before it, so 12264 really
    // could be their parent. They must be classified as descendants and named.
    // If this stops reproducing, the test above is passing because something
    // recognised `msedgewebview2.exe`, which would be worthless.
    const dir = fixtureInstall()
    const engine = path.join(dir, 'resources\\engine\\runtime\\python.exe')
    const table = [
      { pid: 12264, ppid: 800, name: 'python.exe', path: engine, age: 0 },
      { pid: 20000, ppid: 12264, name: 'node.exe', path: 'C:\\Program Files\\nodejs\\node.exe', age: 5 },
      { pid: 16440, ppid: 12264, name: 'Microsoft.CmdPal.UI.exe', path: 'C:\\Windows\\CmdPal\\Microsoft.CmdPal.UI.exe', age: 5 },
      { pid: 2984, ppid: 16440, name: 'msedgewebview2.exe', path: 'C:\\Program Files\\WebView2\\msedgewebview2.exe', age: 6 },
    ]
    const blocked = runHelper(dir, { prelude: cimPrelude([table]) })

    assert.equal(blocked.status, 2, `expected a refusal, got ${blocked.status}: ${blocked.stdout}${blocked.stderr}`)
    const snapshot = snapshotLine(blocked.log)
    assert.match(snapshot, /Microsoft\.CmdPal\.UI\.exe\(16440,descendant\)/)
    // Two hops down, so the closure is still transitive through a child whose
    // own image lives outside the installation.
    assert.match(snapshot, /msedgewebview2\.exe\(2984,descendant\)/)
    fs.rmSync(dir, { recursive: true, force: true })
  },
)

test(
  'a snapshotted id handed to a different process stops holding the upgrade',
  { skip: !windows ? 'Windows only' : false },
  () => {
    // The other half of the same defect. The snapshot records a descendant by
    // id, and the later check asks only whether that id is still alive — which
    // an id Windows has since handed to something else also answers yes to. The
    // exit is established POSITIVELY: this reading can see id 5000, and the
    // process holding it was created three hours after the snapshot recorded
    // the one that used to, so the recorded process is verifiably gone.
    const dir = fixtureInstall()
    const engine = path.join(dir, 'resources\\engine\\runtime\\python.exe')
    const before = [
      { pid: 12264, ppid: 800, name: 'python.exe', path: engine, age: 0 },
      { pid: 5000, ppid: 12264, name: 'uv.exe', path: 'C:\\Users\\someone\\.local\\bin\\uv.exe', age: 1 },
    ]
    const after = [
      { pid: 5000, ppid: 800, name: 'svchost.exe', path: 'C:\\Windows\\System32\\svchost.exe', age: 10800 },
    ]
    // The liveness probe is deliberately independent of the enumeration, so it
    // has to be answered separately: id 5000 IS in use, which is exactly the
    // answer that used to be mistaken for "the snapshotted process is still
    // there".
    const aliveProbe = [
      'function Get-Process {',
      '  param([int]$Id, $ErrorAction, [string]$Name)',
      "  if (-not $PSBoundParameters.ContainsKey('Id')) { throw 'the fixture answers only single-id probes' }",
      "  if ($Id -eq 5000) { return [pscustomobject]@{ Id = 5000; Name = 'svchost' } }",
      '  return $null',
      '}',
    ].join('\n')

    const quiet = runHelper(dir, { prelude: `${cimPrelude([before, after])}\n${aliveProbe}` })
    assert.equal(quiet.status, 0, `expected success, got ${quiet.status}: ${quiet.stdout}${quiet.stderr}`)
    assert.match(quiet.stdout, /already closed/)
    // The snapshot did record it, so this is the re-check clearing it rather
    // than the snapshot never having seen it.
    assert.match(quiet.log, /uv\.exe\(5000,descendant\)/)
    assert.doesNotMatch(quiet.log, /uv\.exe\(5000,descendant\)\(pre-close\)/)
    assert.doesNotMatch(quiet.stderr || '', /svchost/)
    fs.rmSync(dir, { recursive: true, force: true })
  },
)

test(
  'a snapshotted id still held by the same process keeps blocking the upgrade',
  { skip: !windows ? 'Windows only' : false },
  () => {
    // THE NEGATIVE CONTROL for the test above, and the guard that matters most:
    // the reuse rule must never become a way for a process that is genuinely
    // still there to be written off. Same shape, same id, same liveness answer
    // — the only change is that id 5000 still carries the creation time the
    // snapshot recorded, so nothing has been established about it exiting.
    const dir = fixtureInstall()
    const engine = path.join(dir, 'resources\\engine\\runtime\\python.exe')
    const before = [
      { pid: 12264, ppid: 800, name: 'python.exe', path: engine, age: 0 },
      { pid: 5000, ppid: 12264, name: 'uv.exe', path: 'C:\\Users\\someone\\.local\\bin\\uv.exe', age: 1 },
    ]
    // The engine has gone, so nothing roots the closure any more and only the
    // retained snapshot identity can still account for the child.
    const after = [
      { pid: 5000, ppid: 12264, name: 'uv.exe', path: 'C:\\Users\\someone\\.local\\bin\\uv.exe', age: 1 },
    ]
    const aliveProbe = [
      'function Get-Process {',
      '  param([int]$Id, $ErrorAction, [string]$Name)',
      "  if (-not $PSBoundParameters.ContainsKey('Id')) { throw 'the fixture answers only single-id probes' }",
      "  if ($Id -eq 5000) { return [pscustomobject]@{ Id = 5000; Name = 'uv' } }",
      '  return $null',
      '}',
    ].join('\n')

    const blocked = runHelper(dir, { prelude: `${cimPrelude([before, after])}\n${aliveProbe}` })
    assert.equal(blocked.status, 2, `expected a refusal, got ${blocked.status}: ${blocked.stdout}${blocked.stderr}`)
    assert.match(blocked.stderr, /uv\.exe\(5000,descendant\)\(pre-close\)/)
    assert.doesNotMatch(blocked.stdout || '', /already closed/)
    fs.rmSync(dir, { recursive: true, force: true })
  },
)
