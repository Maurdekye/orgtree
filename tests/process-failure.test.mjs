// process-failure.test.mjs — the decisions a dying renderer triggers, driven
// rather than described. The native half of this (a REAL renderer really
// killed, through the real handler, in a real Electron) is
// tools/test-renderer-crash.mjs; this file covers the branches that are
// awkward to reach by killing a process — the fourth crash in ten minutes,
// the clean exit, the shutdown — plus the wiring in index.ts.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'
import { createRequire } from 'node:module'

const repo = path.resolve(import.meta.dirname, '..')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-process-failure-'))
const outfile = path.join(root, 'process-failure.cjs')
await build({ entryPoints: [path.join(repo, 'apps/desktop/main/process-failure.ts')], outfile, bundle: true, format: 'cjs', platform: 'node' })
const { attachRendererFailureHandlers, attachChildProcessFailureHandler, describeRendererFailure, describeChildFailure,
  RecoveryBudget, RECOVERY_LIMIT, RECOVERY_WINDOW_MS, CRASH_REPORTER_OPTIONS, ORDINARY_EXIT_REASONS,
  CRASH_REPORT_DISCLOSURE, crashReportDialog, crashReportFolder } = createRequire(import.meta.url)(outfile)

/** A stand-in for webContents that only does what the handler needs: hold the
 *  listeners and let a test fire one. */
function emitter() {
  const listeners = new Map()
  return {
    on(event, listener) { listeners.set(event, listener); return this },
    fire(event, ...args) {
      const listener = listeners.get(event)
      assert.ok(listener, `no listener attached for '${event}'`)
      listener({}, ...args)
    },
    has: event => listeners.has(event),
  }
}

function harness(options = {}) {
  const records = [], announced = [], gaveUp = []
  let reloads = 0, clock = options.start ?? 1_000_000
  const contents = emitter()
  const hooks = {
    record: (stage, detail) => records.push({ stage, detail }),
    reload: () => { reloads++ },
    announce: (title, body) => announced.push({ title, body }),
    giveUp: detail => gaveUp.push(detail),
    suspended: options.suspended,
    now: () => clock,
  }
  attachRendererFailureHandlers(contents, hooks, new RecoveryBudget(options.limit, options.windowMs))
  return { contents, records, announced, gaveUp,
    reloads: () => reloads, advance: ms => { clock += ms },
    stages: () => records.map(r => r.stage) }
}

test('a renderer that goes away records the reason and the exit code', () => {
  const h = harness()
  h.contents.fire('render-process-gone', { reason: 'oom', exitCode: -536870904 })
  const gone = h.records.find(r => r.stage === 'renderer-gone')
  assert.ok(gone, 'the failure is recorded at all — the defect this fixes')
  assert.match(gone.detail, /reason=oom/)
  assert.match(gone.detail, /exitCode=-536870904/)
})

test('a renderer that goes away is reloaded, not reported as unrecoverable', () => {
  const h = harness()
  h.contents.fire('render-process-gone', { reason: 'oom', exitCode: -536870904 })
  assert.equal(h.reloads(), 1, 'the window is reloaded')
  assert.equal(h.gaveUp.length, 0, 'the user is NOT told to restart the application')
  assert.deepEqual(h.stages(), ['renderer-gone', 'renderer-recovered'])
})

test('the user is told the recovery happened rather than seeing the window blink', () => {
  const h = harness()
  h.contents.fire('render-process-gone', { reason: 'crashed', exitCode: 5 })
  assert.equal(h.announced.length, 1)
  assert.match(h.announced[0].title + ' ' + h.announced[0].body, /recovered|reloaded/i)
  // The reason it died is in what the user sees, not only in the log.
  assert.match(h.announced[0].body, /crashed/)
})

test('repeated failures are bounded and fall back to the dialog instead of looping', () => {
  const h = harness()
  for (let i = 0; i < RECOVERY_LIMIT; i++) h.contents.fire('render-process-gone', { reason: 'oom', exitCode: 9 })
  assert.equal(h.reloads(), RECOVERY_LIMIT)
  assert.equal(h.gaveUp.length, 0)
  h.contents.fire('render-process-gone', { reason: 'oom', exitCode: 9 })
  assert.equal(h.reloads(), RECOVERY_LIMIT, 'the bound stops the reload loop')
  assert.equal(h.gaveUp.length, 1, 'and the existing dialog takes over')
  assert.match(h.gaveUp[0], /reason=oom/, 'carrying the diagnosis the old dialog never had')
  assert.ok(h.stages().includes('renderer-recovery-exhausted'))
  // Every one of the five events is still on the record, including the one
  // that was refused — an exhausted budget must not become a new silence.
  assert.equal(h.records.filter(r => r.stage === 'renderer-gone').length, RECOVERY_LIMIT + 1)
})

test('the bound is a rolling window, so a rare failure never exhausts it', () => {
  const h = harness()
  for (let i = 0; i < RECOVERY_LIMIT * 3; i++) {
    h.contents.fire('render-process-gone', { reason: 'oom', exitCode: 9 })
    h.advance(RECOVERY_WINDOW_MS + 1)
  }
  assert.equal(h.reloads(), RECOVERY_LIMIT * 3, 'failures spaced beyond the window each get a recovery')
  assert.equal(h.gaveUp.length, 0)
})

test('an ordinary window teardown is recorded but never recovered', () => {
  const h = harness()
  for (const reason of ORDINARY_EXIT_REASONS) h.contents.fire('render-process-gone', { reason, exitCode: 0 })
  assert.equal(h.reloads(), 0, 'closing a window does not fight the shutdown by reloading it')
  assert.equal(h.gaveUp.length, 0)
  assert.equal(h.records.filter(r => r.stage === 'renderer-gone').length, ORDINARY_EXIT_REASONS.size,
    'but it is still written down')
})

test('a failure during shutdown is recorded and nothing is recovered', () => {
  const h = harness({ suspended: () => true })
  h.contents.fire('render-process-gone', { reason: 'killed', exitCode: 1 })
  assert.equal(h.reloads(), 0)
  assert.equal(h.gaveUp.length, 0, 'no dialog is raised at the user on the way out')
  assert.deepEqual(h.stages(), ['renderer-gone'])
})

test('unresponsive and responsive are both recorded, and neither kills the renderer', () => {
  const h = harness()
  assert.ok(h.contents.has('unresponsive'), 'unresponsive is handled at all')
  h.contents.fire('unresponsive')
  assert.deepEqual(h.stages(), ['renderer-unresponsive'])
  h.contents.fire('responsive')
  assert.deepEqual(h.stages(), ['renderer-unresponsive', 'renderer-responsive'],
    'the pair is what says whether the hang ended')
  assert.equal(h.reloads(), 0, 'a wedged renderer is not reloaded: wedged is not dead')
})

test('child processes are recorded with the type that died', () => {
  const records = []
  const source = emitter()
  attachChildProcessFailureHandler(source, { record: (stage, detail) => records.push({ stage, detail }) })
  source.fire('child-process-gone', { type: 'GPU', reason: 'crashed', exitCode: 133, name: 'GPU Process' })
  assert.deepEqual(records.map(r => r.stage), ['child-process-gone'])
  assert.match(records[0].detail, /type=GPU/)
  assert.match(records[0].detail, /reason=crashed/)
  assert.match(records[0].detail, /exitCode=133/)
  source.fire('child-process-gone', { type: 'Utility', reason: 'clean-exit', exitCode: 0 })
  assert.equal(records.length, 1, 'an ordinary utility shutdown is not noise in the log')
})

test('the described failure always carries reason and exit code', () => {
  assert.equal(describeRendererFailure({ reason: 'launch-failed', exitCode: 18 }), 'reason=launch-failed exitCode=18')
  assert.equal(describeChildFailure({ type: 'Utility', reason: 'oom', exitCode: 3, serviceName: 'Network Service' }),
    'type=Utility reason=oom exitCode=3 name=Network Service')
})

test('RecoveryBudget counts inside a rolling window', () => {
  const budget = new RecoveryBudget(2, 1000)
  assert.deepEqual(budget.consider(0), { recover: true, attempt: 1, limit: 2 })
  assert.deepEqual(budget.consider(100), { recover: true, attempt: 2, limit: 2 })
  assert.deepEqual(budget.consider(200), { recover: false, attempt: 3, limit: 2 })
  assert.deepEqual(budget.consider(1300), { recover: true, attempt: 1, limit: 2 }, 'the window rolls forward')
})

// ⚠ THE WHOLE PRIVACY GUARANTEE RESTS ON ONE BOOLEAN, so it is asserted here
// rather than left to whoever next edits that object. A dump is a memory
// snapshot of the user's own working material; a guarantee nobody tests is one
// careless edit from gone. The live runtime value is asserted too, in
// tools/test-renderer-crash.mjs, via crashReporter.getUploadToServer().
test('the crash reporter is configured to keep everything on this machine', () => {
  assert.equal(CRASH_REPORTER_OPTIONS.uploadToServer, false)
  assert.equal('submitURL' in CRASH_REPORTER_OPTIONS, false, 'there is nowhere for a dump to be sent')
})

test('nothing in the main process can turn uploading back on', () => {
  const main = read('apps/desktop/main/index.ts')
  assert.doesNotMatch(main, /setUploadToServer/, 'the no-upload decision is permanent, not switchable at runtime')
  assert.doesNotMatch(main, /submitURL\s*:/, 'no address is ever configured')
  // The one place a report can go is a folder the user opens themselves.
  assert.match(main, /shell\.openPath\(folder\)/)
  assert.doesNotMatch(main, /uploadCrash|sendCrash|crashReportUpload/)
})

test('a user can reach their crash reports, and is told what one contains first', () => {
  const dialog = crashReportDialog('C:\\data\\Crashpad\\reports', 3)
  assert.match(dialog.message, /3 crash reports/)
  assert.match(dialog.detail, /memory/i, 'the disclosure says it is a memory snapshot, not a log')
  assert.match(dialog.detail, /agent names, message text and file paths/)
  assert.match(dialog.detail, /never sends one anywhere/)
  assert.match(dialog.detail, /C:\\data\\Crashpad\\reports/, 'and says where they are')
  assert.deepEqual(dialog.buttons, ['Open folder', 'Close'])
  assert.equal(dialog.cancelId, 1, 'closing without opening anything is the safe default')
  assert.ok(dialog.detail.includes(CRASH_REPORT_DISCLOSURE))
  assert.match(crashReportDialog('C:\\empty', 0).message, /no crash reports/)
  assert.match(crashReportDialog('C:\\one', 1).message, /1 crash report\b/, 'singular reads as English')
})

test('the folder offered is the one the dumps are actually in', () => {
  const join = (a, b) => `${a}\\${b}`
  assert.equal(crashReportFolder('C:\\dumps', join, p => p === 'C:\\dumps\\reports'), 'C:\\dumps\\reports')
  assert.equal(crashReportFolder('C:\\dumps', join, () => false), 'C:\\dumps',
    'before Crashpad has written anything, the parent is offered rather than a path that does not exist')
})

test('reaching the reports is a deliberate act and never an automatic one', () => {
  const main = read('apps/desktop/main/index.ts')
  // It hangs off a tray entry the user clicks, and off nothing else: not the
  // failure handlers, not the poll, not app start. A hook that ran by itself
  // is what a later change could point at a network.
  assert.match(main, /id: 'crash-reports', label: 'Crash reports\.\.\.', click: \(\) => \{ void showCrashReports\(\)/)
  assert.equal((main.match(/showCrashReports\(\)/g) ?? []).length, 1, 'exactly one caller, and it is the click')
})

// ------------------------------------------------------------ the wiring
// The handlers above are only worth anything if the application actually
// attaches them, and if nothing starts the crash reporter there is nothing to
// write a minidump when a process dies.
const read = file => fs.readFileSync(path.join(repo, file), 'utf8')

test('the application starts Electron\'s crash reporter, locally, before it is ready', () => {
  const main = read('apps/desktop/main/index.ts')
  assert.match(main, /crashReporter\.start\(\{ \.\.\.CRASH_REPORTER_OPTIONS/)
  // Before app.whenReady(): Crashpad has to exist before the processes it
  // catches do. Measured by position in the file, which is execution order at
  // module scope.
  const started = main.indexOf('crashReporter.start(')
  const ready = main.indexOf('app.whenReady().then')
  assert.ok(started > 0 && ready > 0 && started < ready, 'the reporter starts before the app is ready')
})

test('the application attaches both process-failure handlers and no longer discards the details', () => {
  const main = read('apps/desktop/main/index.ts')
  assert.match(main, /attachRendererFailureHandlers\(main\.webContents, \{/)
  assert.match(main, /attachChildProcessFailureHandler\(app, \{ record: recordProcessFailure \}\)/)
  assert.match(main, /reload: \(\) => \{ if \(main && !main\.isDestroyed\(\)\) main\.webContents\.reload\(\) \}/)
  assert.doesNotMatch(main, /on\('render-process-gone', \(\) =>/, 'the argument-less handler is gone')
})

test('the failures are written to the durable log the main process already keeps', () => {
  const main = read('apps/desktop/main/index.ts')
  assert.match(main, /const recordProcessFailure = \(stage: ProcessFailureStage, detail: string\) => \{/)
  assert.match(main, /updateLog\.record\(stage, detail\)/)
  // and the log's own stage union admits them, so a new stage cannot be
  // written by accident or typed wrong.
  assert.match(read('apps/desktop/main/updater.ts'), /\| ProcessFailureStage/)
})
