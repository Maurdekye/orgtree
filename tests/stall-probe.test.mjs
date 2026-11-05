// UI stall probes in the main process (apps/desktop/main/stall-probe.ts; spec ui-stall-tooling-spec rev 1.3 section M):
// ST8 main event-loop lag, ST9 the renderer ping watchdog, ST10 the kill switch, ST11 sync-IPC, ST12 stack fallbacks.
// Everything runs on a fake clock with fake ports, timers and inspector sessions. Item ui-freezes-intermittently-for-several-seconds-at.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'

const temp = fs.mkdtempSync(path.join(tmpdir(), 'orgtree-stall-probe-'))
const bundle = path.join(temp, 'stall-probe.cjs')
await build({ entryPoints: ['apps/desktop/main/stall-probe.ts'], outfile: bundle, bundle: true, platform: 'node', format: 'cjs' })
const P = createRequire(import.meta.url)(bundle)
test.after(() => fs.rmSync(temp, { recursive: true, force: true }))

/** a hand-cranked clock with setTimeout/setInterval; `advance(ms)` runs everything due, in order */
function fake() {
  let now = 1_000_000, id = 0
  const timers = new Map()
  const api = {
    now: () => now,
    setTimeout: (fn, ms) => { timers.set(++id, { fn, at: now + ms, every: 0 }); return id },
    setInterval: (fn, ms) => { timers.set(++id, { fn, at: now + ms, every: ms }); return id },
    clearTimeout: h => timers.delete(h), clearInterval: h => timers.delete(h),
    advance(ms) {
      const end = now + ms
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        const [h, t] = due
        now = Math.max(now, t.at)
        if (t.every) t.at += t.every; else timers.delete(h)
        t.fn()
      }
      now = end
    },
    /** the clock jumps while nothing runs: the main thread was blocked */
    block(ms) { now += ms },
    count: () => timers.size,
  }
  return api
}

test('ST8 a main tick 600 ms late is one main-lag record naming the pending handler; 400 ms late is nothing', () => {
  const f = fake(), tracker = new P.IpcTracker(f.now), reports = []
  const probe = new P.MainLagProbe({ ...f, tracker, mainStack: () => 'unavailable:none-captured', report: r => reports.push(r) })
  probe.start()
  f.advance(1000)
  assert.equal(reports.length, 0, 'healthy ticks write nothing')
  f.block(500); f.advance(100)
  assert.equal(reports.length, 0, 'a tick 400 ms late is below the threshold')
  const end = tracker.begin('desktop:window-state', 'w1')
  f.block(700); f.advance(100)
  assert.equal(reports.length, 1)
  assert.ok(reports[0].lag_ms >= 600 && reports[0].lag_ms < 700, String(reports[0].lag_ms))
  assert.deepEqual(reports[0].ipc.map(i => i.channel), ['desktop:window-state'], 'the pending invoke handler is named')
  assert.equal(reports[0].main_stack, 'unavailable:none-captured')
  end()
  probe.stop()
  assert.equal(f.count(), 0, 'stop clears the interval')
})

function pingRig(extra = {}) {
  const f = fake(), tracker = new P.IpcTracker(f.now), reports = [], stacks = []
  const wd = new P.PingWatchdog({ ...f, tracker, report: (src, w, rec) => reports.push({ src, w: w.id, rec }) })
  const sent = []
  const win = { id: 'w1', org: true, port: { postMessage: m => sent.push(m) }, visible: () => true,
    collectStack: () => { stacks.push(f.now()); return Promise.resolve('at busy (app:/x.js:1:1)') }, ...extra }
  wd.add(win)
  wd.start()
  return { f, wd, sent, reports, stacks, win }
}

test('ST9 no pong for 3 s: stacks at 400 ms and 2000 ms, never a third, then one renderer-ping record after the pong', async () => {
  const { f, wd, sent, reports, stacks } = pingRig()
  f.advance(500)
  assert.equal(sent.length, 1); assert.ok(sent[0].ping > 0)
  const seq = sent[0].ping, t0 = f.now()
  f.advance(3000)
  assert.deepEqual(stacks.map(t => t - t0), [400, 2000], 'exactly two stacks, at 400 ms and 2000 ms')
  assert.equal(sent.length, 1, 'no new ping while one is outstanding')
  wd.pong('w1', seq)
  await Promise.resolve(); await Promise.resolve(); await new Promise(r => setImmediate(r))
  assert.equal(reports.length, 1); assert.equal(reports[0].src, 'renderer-ping')
  assert.ok(reports[0].rec.blocked_ms >= 3000)
  assert.equal(reports[0].rec.stacks.length, 2)
  assert.equal(stacks.length, 2, 'never a third stack for this stall')
})

test('ST9b a pong in time writes nothing; a hidden window is not pinged', async () => {
  const quick = pingRig()
  quick.f.advance(500)
  quick.f.advance(100)
  quick.wd.pong('w1', quick.sent[0].ping)
  await new Promise(r => setImmediate(r))
  assert.equal(quick.reports.length, 0); assert.equal(quick.stacks.length, 0)
  const hidden = pingRig({ visible: () => false })
  hidden.f.advance(5000)
  assert.equal(hidden.sent.length, 0, 'hidden or minimized: no pings')
  const wrong = pingRig()
  wrong.f.advance(500)
  wrong.wd.pong('w1', 99999)
  wrong.f.advance(1000)
  assert.equal(wrong.reports.length, 0, 'a pong for another ping does not settle this one')
})

test('ST9c Chromium unresponsive also writes a record with the stack and the same context', async () => {
  const { wd, reports } = pingRig({ context: () => ({ screen: 'desk', panel: 'none', popout: null }) })
  wd.unresponsive('w1')
  await new Promise(r => setImmediate(r))
  assert.equal(reports.length, 1); assert.equal(reports[0].src, 'renderer-unresponsive')
  assert.deepEqual(reports[0].rec.ctx, { screen: 'desk', panel: 'none', popout: null })
  assert.deepEqual(reports[0].rec.stacks, ['at busy (app:/x.js:1:1)'])
})

test('ST10 ORGTREE_STALLWATCH=0 turns every part off: no switch, no header, and the helpers say disabled', () => {
  assert.equal(P.stallWatchEnabled({}), true); assert.equal(P.stallWatchEnabled({ ORGTREE_STALLWATCH: '1' }), true)
  assert.equal(P.stallWatchEnabled({ ORGTREE_STALLWATCH: '0' }), false)
  assert.deepEqual(P.stallSwitches({}), ['enable-features=DocumentPolicyIncludeJSCallStacksInCrashReports'])
  assert.deepEqual(P.stallSwitches({ ORGTREE_STALLWATCH: '0' }), [])
  const headers = { 'Content-Type': ['text/html'] }
  assert.deepEqual(P.withStackPolicy(headers, 'http://127.0.0.1:9/x', 'http://127.0.0.1:9', {})['Document-Policy'], ['include-js-call-stacks-in-crash-reports'])
  assert.equal(P.withStackPolicy(headers, 'https://example.com/x', 'http://127.0.0.1:9', {}), headers, 'only the app origin gets it')
  assert.equal(P.withStackPolicy(headers, 'http://127.0.0.1:9/x', 'http://127.0.0.1:9', { ORGTREE_STALLWATCH: '0' }), headers, 'off: no header')
  assert.equal(P.withStackPolicy(headers, 'http://127.0.0.1:99/x', 'http://127.0.0.1:9', {}), headers, 'a different port is a different origin')
})

test('ST11 a sendSync handler taking 150 ms is reported; one taking 50 ms is not; invoke handlers are tracked until they settle', async () => {
  const f = fake(), tracker = new P.IpcTracker(f.now), slow = []
  const registered = {}
  const ipc = { handle: (c, l) => { registered['h:' + c] = l }, on: (c, l) => { registered['o:' + c] = l } }
  P.trackIpc(ipc, tracker, f.now, (channel, ms) => slow.push({ channel, ms }), e => e.w)
  ipc.on('sync-slow', e => { f.block(150); e.returnValue = 1 })
  ipc.on('sync-fast', e => { f.block(50); e.returnValue = 1 })
  registered['o:sync-slow']({ w: 'w1' }); registered['o:sync-fast']({ w: 'w1' })
  assert.deepEqual(slow, [{ channel: 'sync-slow', ms: 150 }])
  let release
  ipc.handle('later', () => new Promise(r => { release = r }))
  const result = registered['h:later']({ w: 'w2' })
  assert.deepEqual(tracker.overlapping(f.now(), f.now(), 'w2').map(i => i.channel), ['later'], 'pending while unsettled')
  release('done'); assert.equal(await result, 'done')
  f.block(1000)
  assert.deepEqual(tracker.overlapping(f.now(), f.now() + 10, 'w2'), [], 'settled: not in flight any more')
  ipc.handle('throws', () => { throw new Error('boom') })
  assert.throws(() => registered['h:throws']({ w: 'w2' }), /boom/, 'the wrapped handler still throws what the original threw')
})

test('ST12 stack failures become unavailable:<reason>; a capture always disables the debugger; the main stack is attempted once a minute', async () => {
  const calls = []
  const session = (over = {}) => ({
    connectToMainThread() { calls.push('connect') },
    on(ev, cb) { this.paused = cb },
    post(method, params, cb) {
      calls.push(method)
      if (method === 'Debugger.pause') setImmediate(() => this.paused({ params: { callFrames: [{ functionName: 'busy', url: 'file:///x/app/m.js', lineNumber: 9, columnNumber: 2 }] } }))
      cb(null, {})
    },
    disconnect() { calls.push('disconnect') }, ...over,
  })
  const ok = await P.captureMainStack(session())
  assert.deepEqual(ok, ['busy (file:///x/app/m.js:10:3)'])
  assert.deepEqual(calls.slice(-3), ['Debugger.resume', 'Debugger.disable', 'disconnect'], 'resumed, disabled and disconnected after a capture')
  calls.length = 0
  const failed = await P.captureMainStack(session({ connectToMainThread() { throw new Error('inspector not available') } }))
  assert.equal(failed, 'unavailable:inspector not available'); assert.ok(!calls.includes('Debugger.enable'), 'the debugger was never enabled')
  calls.length = 0
  const rejected = await P.captureMainStack(session({ post(m, p, cb) { calls.push(m); cb(new Error('no debugger')) } }))
  assert.equal(rejected, 'unavailable:no debugger'); assert.ok(!calls.includes('Debugger.pause'))
  const gate = new P.StackGate()
  assert.equal(gate.allow(0), true); assert.equal(gate.allow(59_999), false); assert.equal(gate.allow(60_000), true)
  const store = new P.MainStackStore()
  assert.equal(store.near(0, 10), 'unavailable:none-captured')
  store.put(5000, ['a']); assert.deepEqual(store.near(4000, 6000), ['a']); assert.equal(store.near(100_000, 100_500), 'unavailable:none-captured')
  const noApi = pingRig({ collectStack: () => Promise.reject(new Error('collectJavaScriptCallStack is not a function')) })
  noApi.f.advance(500); const seq = noApi.sent[0].ping
  noApi.f.advance(2500); noApi.wd.pong('w1', seq)
  await new Promise(r => setImmediate(r))
  assert.deepEqual(noApi.reports[0].rec.stacks, ['unavailable:collectJavaScriptCallStack is not a function', 'unavailable:collectJavaScriptCallStack is not a function'])
})

test('ST12b the worker source: a stale heartbeat triggers one capture a minute; an inspector failure is posted as unavailable:<reason>', async () => {
  const wbundle = path.join(temp, 'worker-source.cjs')
  await build({ entryPoints: ['apps/desktop/main/stall-worker-source.ts'], outfile: wbundle, bundle: true, platform: 'node', format: 'cjs' })
  const { MAIN_STACK_WORKER_SOURCE } = createRequire(import.meta.url)(wbundle)
  const run = (inspector, heartbeat) => {
    const posts = [], sab = new SharedArrayBuffer(8), view = new Float64Array(sab)
    view[0] = heartbeat
    let tick
    const modules = { 'node:worker_threads': { parentPort: { postMessage: m => posts.push(m) }, workerData: { sab } }, 'node:inspector': inspector }
    new Function('require', 'setInterval', MAIN_STACK_WORKER_SOURCE)(n => modules[n], fn => { tick = fn })
    return { posts, tick }
  }
  const broken = run({ Session: class { connectToMainThread() { throw new Error('no inspector here') } disconnect() {} } }, 0)
  broken.tick()
  assert.equal(broken.posts.length, 1); assert.equal(broken.posts[0].stack, 'unavailable:no inspector here')
  broken.tick(); broken.tick()
  assert.equal(broken.posts.length, 1, 'at most one capture a minute')
  const healthy = run({ Session: class { connectToMainThread() {} disconnect() {} on() {} post(m, p, cb) { cb(null) } } }, Date.now())
  healthy.tick()
  assert.equal(healthy.posts.length, 0, 'a fresh heartbeat: nothing to capture')
})

test('ST13 the main-stack worker costs about 8 MB resident, so it is lazy: not started at launch, started by the first stall signal, stopped after 10 quiet minutes', () => {
  const f = fake(), spawned = [], stopped = []
  const lazy = new P.LazyStackWorker({ ...f, spawn: () => { const w = { n: spawned.length }; spawned.push(w); return { stop: () => stopped.push(w) } } })
  f.advance(3_600_000)
  assert.equal(spawned.length, 0, 'an hour of quiet: no worker was ever created')
  lazy.wake()
  assert.equal(spawned.length, 1, 'the first stall signal starts it')
  f.advance(5 * 60_000); lazy.wake()
  assert.equal(spawned.length, 1, 'a second signal reuses it')
  f.advance(9 * 60_000)
  assert.equal(stopped.length, 0, 'the quiet clock restarted at the second signal')
  f.advance(2 * 60_000)
  assert.equal(stopped.length, 1, '10 minutes after the last signal it is stopped')
  lazy.wake()
  assert.equal(spawned.length, 2, 'a later stall starts a fresh one')
  const failing = new P.LazyStackWorker({ ...f, spawn: () => { throw new Error('no worker') } })
  assert.doesNotThrow(() => failing.wake(), 'a failed start is swallowed: main_stack stays unavailable')
})
