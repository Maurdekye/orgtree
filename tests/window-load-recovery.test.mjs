// window-load-recovery.test.mjs — the decisions a FAILED NAVIGATION triggers.
//
// The bug this covers lost a user their whole application on 2026-09-18: the
// renderer was OOM-killed, the desktop reloaded the window 2 ms later (which is
// correct and already tested in process-failure.test.mjs), and the engine —
// which SERVES the window's document — died 1.4 s into that reload. The load
// failed, nothing observed the failure, nothing retried, and nothing
// re-navigated the window when a healthy engine was listening again. The window
// stayed white until the application was killed.
//
// So the test that matters most here is `the 2026-09-18 incident, replayed`
// near the bottom: it drives the whole sequence and asserts the window comes
// back on its own. The rest are the branches around it.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'
import { createRequire } from 'node:module'

const repo = path.resolve(import.meta.dirname, '..')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-window-load-'))
const outfile = path.join(root, 'window-load-recovery.cjs')
await build({ entryPoints: [path.join(repo, 'apps/desktop/main/window-load-recovery.ts')], outfile, bundle: true, format: 'cjs', platform: 'node' })
const { attachWindowLoadRecovery, WindowLoadRecovery, isTerminalLoadFailure, retryDelayMs,
  shouldRecordRetry, holdingPageHtml, RETRY_DELAYS_MS, RETRY_STEADY_MS, ERR_ABORTED,
} = createRequire(import.meta.url)(outfile)

const read = file => fs.readFileSync(path.join(repo, file), 'utf8')

/** Drain every pending microtask. The recovery starts its work with `void
 *  someAsync()` in the handlers — that is deliberate, because a webContents
 *  event listener cannot be awaited — so a test that only awaits one turn sees
 *  a half-finished state and asserts against it. */
const flush = () => new Promise(resolve => setImmediate(resolve))

/** A stand-in for webContents that only does what the handler needs. */
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

/** Drives the recovery with a controllable clock, a controllable engine and a
 *  controllable outcome for the next navigation, so every branch is reachable
 *  without an Electron, a window or a real engine. */
function harness(options = {}) {
  const records = [], loads = [], holding = []
  let timers = [], nextId = 1
  let url = options.startUrl ?? 'http://127.0.0.1:21350/'
  // `serving` is the engine: when false, every navigation to it fails exactly
  // as Electron's loadURL does — by rejecting.
  let serving = options.serving ?? false
  let origin = options.origin ?? 'http://127.0.0.1:21350'
  const builtFor = options.builtFor ?? 'http://127.0.0.1:21350'

  const contents = emitter()
  const hooks = {
    record: (stage, detail) => records.push({ stage, detail }),
    target: () => origin,
    builtFor: () => builtFor,
    load: async target => {
      loads.push(target)
      if (!serving) {
        // ⚠ ELECTRON SIGNALS A FAILED NAVIGATION TWICE: `did-fail-load` fires
        // AND `loadURL` rejects. A harness that only rejected let a mutation
        // removing the in-flight guard survive, because the double signal the
        // guard exists for never happened in the test. Faithful now.
        contents.fire('did-fail-load', -102, 'ERR_CONNECTION_REFUSED', target, true)
        throw new Error('ERR_CONNECTION_REFUSED (-102) loading ' + target)
      }
      url = target
      // A real webContents announces the success; the emitter does too.
      contents.fire('did-finish-load')
      return undefined
    },
    showHolding: async html => { holding.push(html); url = 'data:text/html;charset=utf-8,' + encodeURIComponent(html) },
    suspended: options.suspended,
    setTimer: (fn, ms) => { const id = nextId++; timers.push({ id, fn, ms }); return id },
    clearTimer: id => { timers = timers.filter(t => t.id !== id) },
  }
  const recovery = attachWindowLoadRecovery(contents, hooks, () => url)
  return {
    contents, records, loads, holding, recovery,
    stages: () => records.map(r => r.stage),
    pending: () => timers.map(t => t.ms),
    flush,
    /** Fire every timer that is due, the way a clock would. The recovery's
     *  timer callback kicks off an async retry and returns immediately, so the
     *  drain is what makes the retry's outcome — and the NEXT timer it
     *  schedules — observable to the assertions. */
    tick: async () => { const due = timers; timers = []; for (const t of due) await t.fn(); await flush() },
    setServing: value => { serving = value },
    setOrigin: value => { origin = value },
    url: () => url,
    /** The single question the user cares about. */
    isWhite: () => url === '' || url === 'about:blank',
  }
}

const REAL_FAILURE = { errorCode: -102, errorDescription: 'ERR_CONNECTION_REFUSED', validatedURL: 'http://127.0.0.1:21350/', isMainFrame: true }

// ------------------------------------------------------- what counts as failure

test('a main-frame load failure is a failure', () => {
  assert.equal(isTerminalLoadFailure(REAL_FAILURE), true)
})

test('a SUBFRAME failure is not the window going blank', () => {
  assert.equal(isTerminalLoadFailure({ ...REAL_FAILURE, isMainFrame: false }), false,
    'an image or an iframe failing must not re-navigate a working window')
})

test('ERR_ABORTED is not a failure — it is what a superseded navigation looks like', () => {
  assert.equal(isTerminalLoadFailure({ ...REAL_FAILURE, errorCode: ERR_ABORTED }), false)
  assert.equal(ERR_ABORTED, -3)
})

// ------------------------------------------------------------------- the basics

test('a failed load is RECORDED — the defect was that it left no trace', () => {
  const h = harness()
  h.contents.fire('did-fail-load', -102, 'ERR_CONNECTION_REFUSED', 'http://127.0.0.1:21350/', true)
  const failed = h.records.find(r => r.stage === 'window-load-failed')
  assert.ok(failed, 'the failure is in the durable log')
  assert.match(failed.detail, /errorCode=-102/)
  assert.match(failed.detail, /ERR_CONNECTION_REFUSED/)
})

test('THE WINDOW IS NEVER WHITE: a failed load puts the holding page up at once', async () => {
  const h = harness()
  h.contents.fire('did-fail-load', -102, 'ERR_CONNECTION_REFUSED', 'http://127.0.0.1:21350/', true)
  await h.flush()
  assert.equal(h.holding.length, 1, 'something is rendered instead of nothing')
  assert.match(h.holding[0], /Orgtree lost its connection to the engine/)
  assert.match(h.holding[0], /Reconnecting automatically/)
  assert.ok(h.url().startsWith('data:'), 'the window is showing the holding page, not a blank document')
})

test('a failed load SCHEDULES A RETRY rather than ending there', async () => {
  const h = harness()
  h.contents.fire('did-fail-load', -102, 'ERR_CONNECTION_REFUSED', 'http://127.0.0.1:21350/', true)
  await h.flush()
  assert.deepEqual(h.pending(), [RETRY_DELAYS_MS[0]], 'the first retry is scheduled, and it is the fast one')
})

test('the retry targets the engine\'s CURRENT origin, not the URL that failed', async () => {
  const h = harness()
  h.contents.fire('did-fail-load', -102, 'ERR_CONNECTION_REFUSED', 'http://127.0.0.1:99999/stale', true)
  await h.flush()
  await h.tick()
  assert.deepEqual(h.loads, ['http://127.0.0.1:21350/'],
    'the origin is read live at retry time, never captured from the failure')
})

test('a retry that succeeds records recovery and stops retrying', async () => {
  const h = harness()
  h.contents.fire('did-fail-load', -102, 'ERR_CONNECTION_REFUSED', 'http://127.0.0.1:21350/', true)
  await h.flush()
  h.setServing(true)
  await h.tick()
  assert.ok(h.stages().includes('window-load-recovered'), 'the recovery is recorded')
  assert.deepEqual(h.pending(), [], 'nothing is still scheduled once the window is back')
  assert.equal(h.recovery.isFailed, false)
  assert.equal(h.url(), 'http://127.0.0.1:21350/', 'the window is showing the interface again')
})

test('a retry that fails backs off and keeps going — it never gives up', async () => {
  const h = harness()
  h.contents.fire('did-fail-load', -102, 'ERR_CONNECTION_REFUSED', 'http://127.0.0.1:21350/', true)
  await h.flush()
  for (let i = 0; i < RETRY_DELAYS_MS.length; i++) await h.tick()
  assert.deepEqual(h.pending(), [RETRY_STEADY_MS],
    'after the fast retries it settles to a steady interval and is STILL scheduled')
  // ⚠ the point of the whole fix: there is no state where it has stopped.
  for (let i = 0; i < 40; i++) await h.tick()
  assert.equal(h.pending().length, 1, 'still retrying after 45 attempts')
})

// ------------------------------------------------ the half that makes restart work

test('THE ENGINE COMING BACK recovers the window immediately', async () => {
  const h = harness()
  h.contents.fire('did-fail-load', -102, 'ERR_CONNECTION_REFUSED', 'http://127.0.0.1:21350/', true)
  await h.flush()
  assert.equal(h.loads.length, 0, 'nothing has been retried yet')
  h.setServing(true)
  await h.recovery.onEngineReady()
  await h.flush()
  assert.deepEqual(h.loads, ['http://127.0.0.1:21350/'], 'ready triggered the navigation without waiting for a timer')
  assert.ok(h.stages().includes('window-load-recovered'))
  const retry = h.records.find(r => r.stage === 'window-load-retry')
  assert.match(retry.detail, /engine reported ready/, 'the log says WHY it retried')
})

test('the engine going ready while the window is FINE does nothing', async () => {
  const h = harness({ serving: true })
  await h.recovery.onEngineReady()
  assert.deepEqual(h.loads, [], 'a healthy window is not re-navigated on every engine status')
  assert.deepEqual(h.records, [])
})

// ---------------------------------------------------------------- the loop guard

test('our own retry aborting the previous navigation does NOT schedule a second retry', async () => {
  const h = harness()
  h.contents.fire('did-fail-load', -102, 'ERR_CONNECTION_REFUSED', 'http://127.0.0.1:21350/', true)
  await h.flush()
  const before = h.pending().length
  h.contents.fire('did-fail-load', ERR_ABORTED, 'ERR_ABORTED', 'http://127.0.0.1:21350/', true)
  await h.flush()
  assert.equal(h.pending().length, before, 'an aborted navigation adds no timer')
  assert.equal(h.stages().filter(s => s === 'window-load-failed').length, 1,
    'and it is not recorded as a failure either')
})

test('a failed retry runs the failure path ONCE, though Electron signals it twice', async () => {
  const h = harness()
  h.contents.fire('did-fail-load', -102, 'ERR_CONNECTION_REFUSED', 'http://127.0.0.1:21350/', true)
  await h.flush()
  assert.equal(h.holding.length, 1, 'the initial failure rendered the holding page once')
  await h.tick()   // one retry, which fails — did-fail-load AND a rejection
  assert.equal(h.pending().length, 1, 'exactly one retry is ever outstanding')
  // ⚠ THE IN-FLIGHT GUARD IS WHAT THIS PINS. Without it the retry's own
  // `did-fail-load` runs the whole failure path a second time, re-rendering the
  // holding page on top of itself on every attempt for as long as the outage
  // lasts. (The timer count stays right either way — `schedule()` clears before
  // it sets — so the timer is NOT what proves the guard is doing anything.)
  assert.equal(h.holding.length, 2, 'one more render for the failed retry, not two')
})

// -------------------------------------------------------------------- shutdown

test('nothing is recovered while the application is quitting', async () => {
  const h = harness({ suspended: () => true })
  h.contents.fire('did-fail-load', -102, 'ERR_CONNECTION_REFUSED', 'http://127.0.0.1:21350/', true)
  await h.flush()
  assert.deepEqual(h.records, [], 'a window torn down on purpose is not a failure to recover')
  assert.deepEqual(h.pending(), [])
  assert.deepEqual(h.holding, [])
})

// ------------------------------------------------------------- the moved engine

test('an engine that moved port STRANDS the window and says so, rather than retrying forever', async () => {
  const h = harness()
  h.contents.fire('did-fail-load', -102, 'ERR_CONNECTION_REFUSED', 'http://127.0.0.1:21350/', true)
  await h.flush()
  h.setOrigin('http://127.0.0.1:40001')
  h.setServing(true)
  await h.tick()
  assert.ok(h.stages().includes('window-load-stranded'), 'the situation is named in the log')
  assert.deepEqual(h.loads, [], 'it does NOT navigate a window whose preload origin is baked in')
  assert.deepEqual(h.pending(), [], 'and it stops retrying, because retrying cannot work')
  const last = h.holding[h.holding.length - 1]
  assert.match(last, /Refresh app view restarts Orgtree/,
    'the user is told the one control that does work — and it must actually work (W1)')
  assert.doesNotMatch(last, /Reconnecting automatically/, 'and is NOT told to wait for something that will not happen')
})

test('W1: a stranded recovery says so, and retryNow alone stays inert — the refresh route must rebuild', async () => {
  // The re-review's exact finding: the stranded holding page renders an
  // ENABLED refresh control, but retryNow() returns at its stranded guard, so
  // a handler that only calls retryNow leaves the click doing nothing at all.
  const h = harness()
  h.contents.fire('did-fail-load', -102, 'ERR_CONNECTION_REFUSED', 'http://127.0.0.1:21350/', true)
  await h.flush()
  h.setOrigin('http://127.0.0.1:40001')
  h.setServing(true)
  await h.tick()
  assert.equal(h.recovery.isStranded, true, 'the state the refresh route must branch on is exposed')
  assert.equal(h.recovery.isFailed, true, 'stranded is a failed state, so ordering matters in the handler')
  const loads = h.loads.length, holding = h.holding.length, records = h.records.length
  await h.recovery.retryNow('user clicked refresh')
  await h.flush()
  assert.equal(h.loads.length, loads, 'no navigation — a stranded window must never be re-pointed')
  assert.equal(h.holding.length, holding, 'no re-render')
  assert.equal(h.records.length, records, 'no record')
  assert.deepEqual(h.pending(), [], 'no timer')
  assert.equal(h.recovery.isFailed, true, 'and nothing pretended to recover')
})

test('W1: the refresh route REBUILDS a stranded window instead of calling the guarded retry', () => {
  const main = read('apps/desktop/main/index.ts')
  const preload = read('apps/desktop/preload/index.ts')
  // the holding page's refresh control reaches the main process...
  assert.match(preload, /refreshBtn\.addEventListener\('click', \(\) => \{ void ipcRenderer\.invoke\('desktop:window-refresh'\)/,
    'the holding page control invokes the refresh route')
  // ...and the handler branches on STRANDED before the failed/healthy routes,
  // taking the established changed-origin reconstruction path — persist the
  // layout, relaunch, quit — never navigating the fixed-preload window to a
  // foreign origin. Removing this branch (the inert-refresh mutation the
  // review reproduced) is exactly what makes this match fail.
  assert.match(main,
    /handle\('desktop:window-refresh', async \(\) => \{[\s\S]*?if \(windowLoadRecovery\?\.isStranded\) \{[\s\S]*?await saveWindowLayout\(\)[\s\S]*?app\.relaunch\(\)[\s\S]*?app\.quit\(\)[\s\S]*?return[\s\S]*?\}[\s\S]*?if \(windowLoadRecovery\?\.isFailed\) await windowLoadRecovery\.retryNow\('user refresh'\)/,
    'stranded refresh takes the reconstruction path, checked before the retryNow branch')
  // and the reconstruction path it mirrors is still there to mirror
  assert.match(main, /else \{ await saveWindowLayout\(\); app\.relaunch\(\); app\.quit\(\) \}/,
    'the changed-origin engine recovery this reuses')
})

// ------------------------------------------------------------------ the details

test('backoff is fast first, then steady, and never zero', () => {
  assert.deepEqual(RETRY_DELAYS_MS.map((_, i) => retryDelayMs(i)), RETRY_DELAYS_MS)
  assert.equal(retryDelayMs(RETRY_DELAYS_MS.length), RETRY_STEADY_MS)
  assert.equal(retryDelayMs(9999), RETRY_STEADY_MS)
  for (let i = 0; i < 50; i++) assert.ok(retryDelayMs(i) >= 1000, 'no busy loop at any attempt')
})

test('the log thins out so an overnight outage stays readable', () => {
  assert.equal(shouldRecordRetry(0), true)
  assert.equal(shouldRecordRetry(RETRY_DELAYS_MS.length + 1), false)
  assert.equal(shouldRecordRetry(20), true, 'every tenth is kept so the trail never stops')
})

test('the holding page carries nothing it cannot load without the engine', () => {
  const html = holdingPageHtml('ERR_CONNECTION_REFUSED')
  assert.doesNotMatch(html, /<script/i, 'no script the engine would have to serve')
  assert.doesNotMatch(html, /<link/i, 'no stylesheet either')
  assert.doesNotMatch(html, /https?:\/\//, 'and no external reference of any kind')
})

test('the holding page renders the persistent window controls shell across error states', () => {
  const detail = 'errorCode=-102 ERR_CONNECTION_REFUSED url=http://127.0.0.1:21350/o/orgtree'
  const html = holdingPageHtml(detail)
  assert.match(html, /<header class="orgbar fallback-orgbar native-header">/, 'persistent header')
  assert.match(html, /<h2>Orgtree<\/h2>/, 'header title')
  assert.match(html, /<div class="window-controls" role="group" aria-label="Window controls">/, 'window controls group')
  assert.match(html, /aria-label="Refresh app view"/, 'refresh control')
  assert.match(html, /aria-label="Minimize window"/, 'minimize control')
  assert.match(html, /aria-label="Maximize window"/, 'maximize control')
  assert.match(html, /aria-label="Close window"/, 'close control')
  assert.match(html, /errorCode=-102 ERR_CONNECTION_REFUSED url=http:\/\/127\.0\.0\.1:21350\/o\/orgtree/, 'preserves error detail')
  assert.match(html, /Orgtree lost its connection to the engine\./, 'reconnecting headline')
  assert.match(html, /\.orgbar\{[^}]*-webkit-app-region:drag/, 'header is drag region')
  assert.match(html, /\.window-controls\{[^}]*-webkit-app-region:no-drag/, 'controls are no-drag')
  assert.match(html, /main\{[^}]*-webkit-app-region:no-drag/, 'content is no-drag')
})

test('the holding page escapes the error text it is handed', () => {
  const html = holdingPageHtml('<img src=x onerror=alert(1)>')
  assert.doesNotMatch(html, /<img/, 'an Electron error description is not trusted markup')
  assert.match(html, /&lt;img/)
})

test('WindowLoadRecovery retryNow triggers an immediate navigation retry', async () => {
  const h = harness({ serving: false })
  h.contents.fire('did-fail-load', -102, 'ERR_CONNECTION_REFUSED', 'http://127.0.0.1:21350/', true)
  await h.flush()
  assert.equal(h.recovery.isFailed, true)
  assert.equal(h.recovery.retryAttempt, 0)
  assert.equal(h.pending().length, 1)

  // Triggering retryNow before timer fires resets attempt and navigates
  h.setServing(true)
  await h.recovery.retryNow('user clicked refresh')
  await h.flush()
  assert.equal(h.recovery.isFailed, false, 'recovered via user refresh')
})

// ------------------------------------------------------------ THE INCIDENT

test('the 2026-09-18 incident, replayed: the window comes back on its own', async () => {
  // 20:22:47.843 — the renderer is OOM-killed and the desktop reloads it.
  //                (that half is process-failure.ts and is already correct)
  // 20:22:49.202 — the engine dies 1.4 s into that reload, so the reload fails.
  const h = harness({ serving: false })
  h.contents.fire('did-fail-load', -102, 'ERR_CONNECTION_REFUSED', 'http://127.0.0.1:21350/', true)
  await h.flush()

  // BEFORE THE FIX, THIS WAS THE END OF THE STORY. Assert the two things that
  // were false then: something is on screen, and something is going to happen.
  assert.ok(h.url().startsWith('data:'), 'the window is not white')
  assert.equal(h.pending().length, 1, 'a retry is scheduled')

  // The engine stays down for a while; the user waits and watches.
  await h.tick(); await h.tick(); await h.tick()
  assert.equal(h.recovery.isFailed, true, 'still down, still trying')
  assert.ok(h.pending().length === 1, 'and still scheduled')

  // 20:25:38 — a new engine comes up on the persisted port and reports ready.
  //            THIS is the moment that used to change nothing at all.
  h.setServing(true)
  await h.recovery.onEngineReady()
  await h.flush()

  assert.equal(h.recovery.isFailed, false, 'the window recovered')
  assert.equal(h.url(), 'http://127.0.0.1:21350/', 'and it is showing the real interface')
  assert.ok(h.stages().includes('window-load-recovered'))
  // The user never had to quit and relaunch, which is the whole point.
})

// --------------------------------------------------------------- the wiring
// A module that works and is never called fixes nothing; these read index.ts.

test('index.ts attaches the window-load recovery to the main window', () => {
  const main = read('apps/desktop/main/index.ts')
  // ⚠ ANCHORED TO THE ASSIGNMENT. A looser match for the call alone survived a
  // mutation that left the call in place but short-circuited it away
  // (`= undefined && attachWindowLoadRecovery(...)`), which is exactly the
  // shape a real mistake would take.
  assert.match(main, /windowLoadRecovery = attachWindowLoadRecovery\(main\.webContents, \{/,
    'the recovery is wired to the real window, and its result is what is kept')
  assert.match(main, /import \{ attachWindowLoadRecovery/)
})

test('index.ts drives the recovery from the engine becoming ready', () => {
  const main = read('apps/desktop/main/index.ts')
  assert.match(main, /status\.state === 'ready'\) windowLoadRecovery\?\.onEngineReady\(\)/,
    'the engine returning is what recovers the window — including for a MANAGED engine, '
    + 'which the pre-existing recoverAttached path is gated away from')
})

test('index.ts reads the engine origin LIVE for the retry target', () => {
  const main = read('apps/desktop/main/index.ts')
  assert.match(main, /target: \(\) => engine\.origin/,
    'a captured origin would retry against a port the engine may have left')
})

test('the failed-load record shares the durable log the renderer failures use', () => {
  const main = read('apps/desktop/main/index.ts')
  // A SEPARATE recorder from `recordProcessFailure`, writing the SAME log
  // through the same helper — the two stage unions stay apart so neither
  // recorder can be handed a stage that does not belong to it.
  assert.match(main, /record: recordWindowLoad/)
  assert.match(main, /const recordWindowLoad = \(stage: WindowLoadStage, detail: string\) => \{\s*\n\s*recordToUpdateLog\(stage, detail\)/,
    'and it reaches the same durable log the renderer failures go to')
  const updater = read('apps/desktop/main/updater.ts')
  assert.match(updater, /\| WindowLoadStage/, 'the stages are in the log\'s own union')
})
