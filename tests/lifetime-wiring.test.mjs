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

  // THE REGRESSION GUARD. The old shape was `awaitInstallError(grace)` followed
  // by an unconditional app.quit(). If that pairing ever comes back as the
  // primary path, silence means success again.
  const proofIndex = main.indexOf('await awaitInstallerProof(')
  const guardIndex = main.indexOf('if (!installerImage) {')
  const graceIndex = main.indexOf('await awaitInstallError(UPDATE_SPAWN_GRACE_MS)')
  assert.ok(proofIndex > 0, 'the proof wait is present')
  assert.ok(guardIndex > 0 && graceIndex > guardIndex && graceIndex < proofIndex,
    'the only remaining awaitInstallError must sit INSIDE the "installer cannot '
    + 'be identified" guard — it is the fallback for when no proof is obtainable, '
    + 'never the primary path')
  assert.match(main, /installer-proof-unavailable/,
    'and that fallback must record why nobody checked, so an unproven exit is '
    + 'distinguishable from a proven one')

  // The watchdog ends in app.exit(1) and was sized for a sequence with no human
  // in it; a UAC prompt outlasts it. Cancelling it before the wait is load-
  // bearing, not tidying.
  assert.match(main, /cancelUpdateWatchdog\(\)\s*\n\s*const installerImage/,
    'the watchdog must be cancelled immediately before the wait, or it kills the '
    + 'app during a Windows permission prompt')

  // A failure the user never sees is the same defect wearing a quieter hat.
  const failureBranch = main.slice(main.indexOf("if (proof.verdict === 'failed')"))
  assert.match(failureBranch.slice(0, 1200), /dialog\.showMessageBox/,
    'a failed update must SAY so rather than relaunching silently')
  assert.match(failureBranch.slice(0, 1200), /app\.relaunch\(\); app\.exit\(0\)/,
    'and must put the app back, since the engine is confirmed stopped')

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
