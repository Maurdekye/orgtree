// lifetime-wiring.test.mjs — the PROCESS-LIFETIME wiring in the main process.
//
// Two defects, deliberately kept apart because they do not share a cause:
//
//   OBS-A  the self-update quit on silence. `install()` returning true means
//          electron-updater got a pid back; a process that starts and then
//          dies emits no 'error' at all, so three quiet seconds and an
//          app.quit() is how an update disappeared.
//   OBS-B  a console closing killed the process cold, because there was no
//          SIGHUP/SIGINT/SIGBREAK listener anywhere in the main process and the
//          default disposition terminates.
//
// The DECISIONS in each are unit-tested where they live (installer-proof.test.mjs
// drives the verdict and the wait with everything injected). What cannot be
// reached that way is whether index.ts actually CALLS any of it — index.ts
// requires Electron and runs an application — so this file asserts the wiring at
// source level, which is the same idiom updater-wiring.test.mjs already uses for
// the update controller.
//
// Run: node --test tests/lifetime-wiring.test.mjs

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { createRequire } from 'node:module'

const root = path.resolve(import.meta.dirname, '..')
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')
// ⚠ NOT path.join(root, 'node_modules', ...). A review worktree may carry no
// node_modules of its own and resolve upward to a shared tree, which is exactly
// how this repo's worktrees are set up — a path join finds nothing there.
const readDep = (spec) => fs.readFileSync(createRequire(import.meta.url).resolve(spec), 'utf8')

test('OBS-A: the update exit waits for a PROVEN installer, and never quits on silence', () => {
  const main = read('apps/desktop/main/index.ts')
  const updater = read('apps/desktop/main/updater.ts')

  const updaterImport = main.match(/import \{([^}]*)\} from '\.\/updater'/)
  assert.ok(updaterImport, 'the main process must import from ./updater')
  assert.ok(updaterImport[1].split(',').map(s => s.trim()).includes('awaitInstallerProof'),
    'main must import awaitInstallerProof — the whole fix is that the exit waits for it')

  assert.match(main, /const proof = await awaitInstallerProof\(/,
    'the handoff must be followed by a wait for the verdict')
  assert.match(main, /if \(proof\.verdict === 'failed'\)/,
    'and the failure branch must be taken on the verdict, not on a timeout')

  // ⚠ THE REGRESSION GUARD, AND IT DID NOT GUARD. The old shape was
  // `awaitInstallError(grace)` followed by an unconditional app.quit(); if that
  // pairing comes back as the primary path, silence means success again.
  //
  // The first version of this used indexOf, which finds only the FIRST
  // occurrence. staffing-flow put the old defect back VERBATIM just before the
  // proof wait and this file came back 4/4 PASS: the legitimate call still
  // satisfied the ordering, so a second call anywhere after it was invisible.
  // It pinned where one call sits; it never bounded how many there are.
  //
  // COUNTING is what makes it a guard. There must be EXACTLY ONE, and it must
  // be inside the cannot-identify fallback.
  const occurrences = (text, needle) => text.split(needle).length - 1
  const proofIndex = main.indexOf('await awaitInstallerProof(')
  const guardIndex = main.indexOf('const exitWithoutProof = async () => {')
  const graceIndex = main.indexOf('await awaitInstallError(UPDATE_SPAWN_GRACE_MS)')
  assert.ok(proofIndex > 0, 'the proof wait is present')
  assert.equal(occurrences(main, 'awaitInstallError(UPDATE_SPAWN_GRACE_MS)'), 1,
    'there must be EXACTLY ONE grace wait in the whole file. A second one is how '
    + 'the old "quit on silence" defect returns, and counting is the only way to '
    + 'see it — an ordering check is satisfied by the legitimate call and blind '
    + 'to everything after it')
  assert.ok(guardIndex > 0 && graceIndex > guardIndex,
    'and that one must sit INSIDE exitWithoutProof — the shared fallback for '
    + 'when no proof is obtainable, never the primary path')
  // The fallback is reached from BOTH unprovable states, and from nowhere else.
  assert.equal(occurrences(main, 'await exitWithoutProof()'), 2,
    'exactly two callers: the installer that cannot be named, and the process '
    + 'table that cannot be read')
  assert.match(main, /if \(proof\.verdict === 'unknown'\)/,
    'the unreadable-process-table verdict must take that fallback rather than '
    + 'being reported to the user as a failed update')
  assert.match(main, /installer-proof-unavailable/,
    'and that fallback must record why nobody checked, so an unproven exit is '
    + 'distinguishable from a proven one')

  // The watchdog ends in app.exit(1) and was sized for a sequence with no human
  // in it; a UAC prompt outlasts it. Cancelling it before the wait is load-
  // bearing, not tidying.
  // Pinned to the start of the proof machinery rather than to one specific next
  // line: the shared unprovable-exit helper is now defined in between, and a
  // brittle line-pairing here would break on every edit while still not saying
  // what matters.
  assert.match(main, /cancelUpdateWatchdog\(\)\s*\n\s*\/\*\* ⚠ NO PROOF IS OBTAINABLE/,
    'the watchdog must be cancelled immediately before the proof machinery '
    + 'begins, or it kills the app during a Windows permission prompt')
  const cancelIndex = main.lastIndexOf('cancelUpdateWatchdog()', proofIndex)
  assert.ok(cancelIndex > 0 && cancelIndex < proofIndex,
    'and the cancellation must precede the wait, which is the whole reason it '
    + 'may outlast the old deadline safely')
  assert.equal(main.slice(cancelIndex, proofIndex).includes('await engine'), false,
    'with nothing else awaited in between that could push the wait past a bound '
    + 'the watchdog is no longer covering')

  // ⚠ THE FAILURE PATH MUST NOT TALK TO ANYBODY, and that is the opposite of
  // what this asserted a round ago. It required a dialog on this branch; the
  // dialog was never presented (app.exit force-exits on the next statement), and
  // awaiting it instead blocks app.relaunch() until a human clicks — which on
  // the automatic idle path leaves an unattended machine down indefinitely.
  const failureBranch = main.slice(main.indexOf("if (proof.verdict === 'failed')"))
  // ⚠ CODE ONLY. This assertion is about what the branch DOES, and the branch
  // explains its own history in a comment that names `void
  // dialog.showMessageBox(...)` as the shape it used to have. Matched against
  // the raw text it failed on its own documentation — a source-level guard has
  // to distinguish code from prose or it polices the wrong thing.
  const codeOnly = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const failureBody = codeOnly(failureBranch.slice(0, 2600))
  assert.doesNotMatch(failureBody, /dialog\.showMessageBox/,
    'NOTHING may be put on screen here: no click may be on the critical path to '
    + 'the app coming back')
  assert.match(failureBody, /app\.relaunch\(\); app\.exit\(0\)/,
    'it relaunches immediately, since the engine is confirmed stopped')
  assert.match(failureBody, /updateLog\.record\('not-installed'/,
    'and records the outcome first, because the log is the only thing that '
    + 'outlives this process')

  // ...AND THE REPORT MUST EXIST SOMEWHERE ELSE, or "do not talk here" is just
  // the silent relaunch that was filed against in the first place.
  assert.match(main, /const failedUpdate = updateFailureToReport\(updateLog\.lastAttempt\(\), app\.getVersion\(\)\)/,
    'the relaunched instance must ask whether there is a failure to report')
  const reportSite = main.slice(main.indexOf('const failedUpdate = updateFailureToReport('))
  const reportBody = reportSite.slice(0, 1400)
  assert.match(reportBody, /updateLog\.record\('failure-report-shown'/,
    'showing it is recorded, which is what bounds the repeats')
  assert.match(reportBody, /dialog\.showMessageBox/, 'it is actually shown')
  assert.match(reportBody, /\.then\(\(\) => \{ updateLog\.record\('failure-reported'/,
    'and DELIVERY is recorded only when the user dismisses it — recording that '
    + 'up front would mark a message delivered that nobody saw')
  assert.match(reportBody, /update-log\.json/,
    'the message must name where the durable record is')
  // The report is derived from the log, not from a flag set by the dying run:
  // that is what makes it survive a crash, a reboot, and the exit itself.
  assert.match(main, /import \{[^}]*updateFailureToReport/,
    'and the decision lives in updater.ts as a pure function rather than inline '
    + 'here, which is the only reason its edge cases are testable at all')

  // elevate.exe is alive for the whole time a UAC prompt is on screen, so it can
  // never be the proof. This is the single easiest thing to "simplify" wrongly.
  assert.match(updater, /elevate\.exe IS NOT A SUBSTITUTE|NEVER elevate\.exe/,
    'the reason elevate.exe is not proof must stay written down where the rule lives')
})

test('OBS-A: the sampler identifies the INSTALLER, not merely something we spawned', () => {
  const main = read('apps/desktop/main/index.ts')
  assert.match(main, /const installerImageName = \(\)/,
    'the installer is identified by its own image name')
  assert.match(main, /installerRunning: !!installerImage && running\.has\(installerImage\)/,
    'installerRunning must mean the installer image, not the elevator')
  assert.match(main, /elevatorRunning: running\.has\('elevate\.exe'\)/,
    'the elevator is tracked separately, because its absence is what turns '
    + '"no installer yet" into a refusal')
  // An unreadable listing must not manufacture a verdict.
  assert.match(main, /resolve\(error \? '' : String\(stdout\)\)/,
    'a failed process listing yields "nothing seen", which can only delay a '
    + 'verdict and never invent one')
})

test('OBS-B: a console close shuts down in order instead of killing the process cold', () => {
  const main = read('apps/desktop/main/index.ts')

  assert.match(main, /for \(const signal of \['SIGHUP', 'SIGINT', 'SIGBREAK'\] as const\)/,
    'all three console signals must be handled — there were previously NO signal '
    + 'handlers at all, so the default disposition terminated the process')
  assert.match(main, /process\.on\(signal, \(\) => \{/, 'each one gets a listener')

  // Routed through the one shutdown sequence rather than duplicating teardown,
  // so this cannot drift from what a tray Quit does.
  const handler = main.slice(main.indexOf("for (const signal of ['SIGHUP'"))
  assert.match(handler.slice(0, 1400), /app\.quit\(\)/,
    'the handler must route into the existing quit, not reimplement teardown')
  assert.match(handler.slice(0, 1400), /updateLog\.record\(/,
    'and must leave a durable record — an exit nobody could explain is how this '
    + 'arrived, and the log is the only thing that outlives it')

  // The honest limits belong next to the code, because a later reader will
  // otherwise assume this makes the process immortal. It does not.
  assert.match(main, /does NOT make the process immortal|WHAT THIS CAN AND CANNOT DO/,
    'the limits of this defence must stay stated where the defence is')
})

test('OBS-A and OBS-B are not treated as one cause', () => {
  // The installer is spawned detached + unref by electron-updater, in its own
  // process group with no inherited console, so no console close or parent exit
  // can reach it. Recorded here so a later change that "unifies" the two
  // defences has to argue with a test rather than with a comment.
  const baseUpdater = readDep('electron-updater/out/BaseUpdater.js')
  assert.match(baseUpdater, /detached: true/,
    'the installer is detached — console-close hardening is NOT what fixes OBS-A')
  assert.match(baseUpdater, /p\.unref\(\)/,
    'and unref\'d, so the parent exiting cannot take it down either')
  assert.match(baseUpdater, /if \(p\.pid !== undefined\) \{\s*resolve\(true\)/,
    'and it resolves on pid EXISTENCE — the fact the whole OBS-A fix exists for. '
    + 'If this ever changes upstream, the proof wait should be revisited')
})
