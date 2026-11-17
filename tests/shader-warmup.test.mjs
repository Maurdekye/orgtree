// shader-warmup.test.mjs - main/shader-warmup.ts: compile the desk/node GPU shaders once, offscreen,
// before the user's first desk switch. Item hang-every-time-a-new-desk-loads-especially-whil,
// option B (USER 2026-11-16 20:03:34Z m67c841ee83a3 "Add a warm-up"; constraints @coordinator-opus m55a760cd62fa).
//
// SW1 the window is never seen: offscreen rendering, not shown, no taskbar, no focus, sandboxed, no preload;
//     its own persistent partition (in-memory sessions persist no shaders), storage cleared after
// SW2 skip: the same key (app, Chromium, GPU) with GrShaderCache present runs nothing; a new key or a missing cache runs;
//     software raster skips, read at the skip check (after the delay), never at app ready
// SW3 timing: nothing before the launch delay; waits for the user to be idle; gives up while they stay busy
// SW4 the end: the scene's done title destroys the window and writes the marker; the deadline destroys it and writes none
// SW5 stop (quit) mid-run destroys the window and writes no marker; a failed load ends it too
// SW6 the session serves only plain UI files under the UI folder, from the warm-up origin
// SW7 the stall log keeps a shader-warmup line as an outcome enum and durations, never error text
// SW8 the page: its own Vite build after the app's (no shared chunk), its entry mounts the scene, its done title matches
// SW9 a cache folder recreated since the marker (Chromium wiped it; measured on the user's 4.6.1-alpha.2 at 2026-11-16 21:03Z)
//     runs again: the marker records the folder's creation time; an older marker without it runs once
// SW10 it can finish on a slow-compiling GPU: 4.6.1-alpha.3 hit the 8 s deadline (compiles of 200-850 ms each);
//     the deadline is 45 s and the scene moves to the next desk only once frames are quick again
// SW11 every outcome line records the cache folder's creation time and size, so the next reset is measured
// Run: node --test tests/shader-warmup.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'

const temp = fs.mkdtempSync(path.join(tmpdir(), 'orgtree-shader-warmup-'))
const bundle = path.join(temp, 'shader-warmup.cjs'), logBundle = path.join(temp, 'stall-log.cjs')
await build({ entryPoints: ['apps/desktop/main/shader-warmup.ts'], outfile: bundle, bundle: true, platform: 'node', format: 'cjs' })
await build({ entryPoints: ['apps/desktop/main/stall-log.ts'], outfile: logBundle, bundle: true, platform: 'node', format: 'cjs' })
const req = createRequire(import.meta.url)
const { ShaderWarmup, WARMUP_WINDOW_OPTIONS, WARMUP_DONE_TITLE, WARMUP_ORIGIN, warmupKey, warmupFile } = req(bundle)
const { StallLog } = req(logBundle)
test.after(() => fs.rmSync(temp, { recursive: true, force: true }))

const OPTS = { delayMs: 15_000, idleS: 5, retryMs: 10_000, giveUpMs: 60_000, deadlineMs: 8_000 }
const PARTS = { app: '4.6.1', chrome: '146.0', vendor: 4318, device: 7, driver: '32.0.15' }
const tick = () => new Promise(r => setImmediate(r))

function rig({ marker = null, cache = true, birth = 1_000, idle = [60], load = 'ok', gpu = [true] } = {}) {
  let now = 0, seq = 0
  const timers = new Map(), logs = [], windows = [], writes = []
  const idles = [...idle]
  const deps = {
    now: () => now,
    setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { fn, at: now + ms }); return id },
    clearTimeout: id => timers.delete(id),
    idleSeconds: () => (idles.length > 1 ? idles.shift() : idles[0]),
    gpuRasters: () => (gpu.length > 1 ? gpu.shift() : gpu[0]),
    keyParts: async () => PARTS,
    readMarker: async () => marker,
    writeMarker: async text => { writes.push(text) },
    cacheInfo: async () => (cache ? { birth, bytes: 10_548_908 } : null),
    createWindow: () => {
      const w = { title: null, gone: null, destroyed: false, url: null,
        loadURL: async url => { w.url = url; if (load === 'fail') throw new Error('load failed') },
        onTitle: fn => { w.title = fn }, onGone: fn => { w.gone = fn },
        destroy: () => { w.destroyed = true; w.gone?.() }, isDestroyed: () => w.destroyed }
      windows.push(w); return w
    },
    url: WARMUP_ORIGIN + '/shader-warmup.html',
    log: line => logs.push(line),
  }
  /** move the clock forward, firing due timers in order */
  const advance = async ms => {
    const end = now + ms
    for (;;) {
      await tick()
      const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      timers.delete(due[0]); now = due[1].at; due[1].fn(); await tick(); await tick()
    }
    now = end; await tick()
  }
  return { deps, advance, logs, windows, writes, timers, get now() { return now } }
}

test('SW1 the window is never seen: offscreen, not shown, no taskbar, no focus, sandboxed, no preload', () => {
  const o = WARMUP_WINDOW_OPTIONS
  assert.equal(o.show, false)
  assert.equal(o.skipTaskbar, true)
  assert.equal(o.focusable, false)
  assert.equal(o.webPreferences.offscreen, true, 'offscreen rendering: no native window is ever composited on a screen')
  assert.equal(o.webPreferences.sandbox, true)
  assert.equal(o.webPreferences.contextIsolation, true)
  assert.equal(o.webPreferences.nodeIntegration, false)
  assert.equal('preload' in o.webPreferences, false, 'no preload: the scene has no way to the engine')
  // the Electron side passes these through and adds only its in-memory session
  const glue = fs.readFileSync('apps/desktop/main/shader-warmup-window.ts', 'utf8')
  assert.match(glue, /new BrowserWindow\(\{ \.\.\.WARMUP_WINDOW_OPTIONS, webPreferences: \{ \.\.\.WARMUP_WINDOW_OPTIONS\.webPreferences, session: warmupSession\(/)
  assert.doesNotMatch(glue, /\.show\(|showInactive|focus\(\)|setSkipTaskbar\(false/, 'nothing ever shows or focuses it')
  // its own PERSISTENT partition: Chromium keeps no shaders compiled for an in-memory session (measured 2026-11-16)
  assert.match(glue, /const PARTITION = 'persist:orgtree-shader-warmup'/)
  assert.match(glue, /session\.fromPartition\(PARTITION/)
  assert.match(glue, /win\.destroy\(\)[\s\S]{0,200}void ses\.clearStorageData\(\)/, 'the synthetic scene leaves no storage behind')
  assert.match(glue, /setAudioMuted\(true\)/)
  assert.match(glue, /setPermissionRequestHandler\(\(_wc, _permission, done\) => done\(false\)\)/, 'clipboard and every other permission refused')
})

test('SW2 skip on the same key with the cache present; run on a new key or a missing cache', async () => {
  const key = warmupKey(PARTS)
  assert.equal(key, '4.6.1|146.0|4318|7|32.0.15')
  const same = rig({ marker: JSON.stringify({ key, cache_birth: 1_000 }) })
  const w1 = new ShaderWarmup(same.deps, OPTS)
  const o1 = w1.start(); await same.advance(OPTS.delayMs)
  assert.equal(await o1, 'skipped-warm'); assert.equal(same.windows.length, 0)
  const soft = rig({ gpu: [false] })
  const ws = new ShaderWarmup(soft.deps, OPTS); const os = ws.start(); await soft.advance(OPTS.delayMs)
  assert.equal(await os, 'skipped-no-gpu'); assert.equal(soft.windows.length, 0)
  const glue = fs.readFileSync('apps/desktop/main/shader-warmup-window.ts', 'utf8')
  assert.equal((glue.match(/getGPUFeatureStatus\(\)/g) || []).length, 1)
  assert.match(glue, /gpuRasters: \(\) => \{\s*const status = app\.getGPUFeatureStatus\(\)/, 'read when asked, not when started')
  for (const [name, r] of [['new driver', rig({ marker: JSON.stringify({ key: key.replace('32.0.15', '33.0') }) })],
    ['cache deleted', rig({ marker: JSON.stringify({ key, cache_birth: 1_000 }), cache: false })], ['no marker', rig()], ['garbled marker', rig({ marker: '{' })]]) {
    const w = new ShaderWarmup(r.deps, OPTS); w.start(); await r.advance(OPTS.delayMs)
    assert.equal(r.windows.length, 1, name)
    w.stop()
  }
})

test('SW3 timing: nothing before the delay, waits for idle, gives up while the user stays busy', async () => {
  const r = rig({ idle: [0, 1, 2, 30] })
  const w = new ShaderWarmup(r.deps, OPTS); w.start()
  await r.advance(OPTS.delayMs - 1)
  assert.equal(r.windows.length, 0, 'nothing before the launch delay')
  await r.advance(1)
  assert.equal(r.windows.length, 0, 'busy at the first check')
  await r.advance(OPTS.retryMs * 2)
  assert.equal(r.windows.length, 0, 'still busy')
  await r.advance(OPTS.retryMs)
  assert.equal(r.windows.length, 1, 'idle: runs')
  w.stop()
  const busy = rig({ idle: [0] })
  const wb = new ShaderWarmup(busy.deps, OPTS); const ob = wb.start()
  await busy.advance(OPTS.giveUpMs + OPTS.retryMs)
  assert.equal(await ob, 'gave-up-busy'); assert.equal(busy.windows.length, 0); assert.equal(busy.timers.size, 0, 'no timer left behind')
})

test('SW4 done destroys the window and writes the marker; the deadline destroys it and writes none', async () => {
  const r = rig()
  const w = new ShaderWarmup(r.deps, OPTS); const o = w.start()
  await r.advance(OPTS.delayMs)
  const win = r.windows[0]
  assert.equal(win.url, WARMUP_ORIGIN + '/shader-warmup.html')
  win.title('something else'); await r.advance(1)
  assert.equal(win.destroyed, false)
  win.title(WARMUP_DONE_TITLE)
  assert.equal(await o, 'done')
  assert.equal(win.destroyed, true)
  assert.deepEqual(r.writes.map(t => JSON.parse(t).key), [warmupKey(PARTS)])
  assert.deepEqual(r.logs.map(l => l.outcome), ['done'], 'one outcome line, even though destroying fires the window\'s own gone')
  assert.equal(r.timers.size, 0, 'the deadline timer is cleared')

  const slow = rig()
  const ws = new ShaderWarmup(slow.deps, OPTS); const os = ws.start()
  await slow.advance(OPTS.delayMs + OPTS.deadlineMs)
  assert.equal(await os, 'deadline')
  assert.equal(slow.windows[0].destroyed, true)
  assert.deepEqual(slow.writes, [], 'a cut-off scene runs again next launch')
})

test('SW5 stop mid-run destroys the window and writes no marker; a failed load ends it', async () => {
  const r = rig()
  const w = new ShaderWarmup(r.deps, OPTS); const o = w.start()
  await r.advance(OPTS.delayMs)
  w.stop()
  assert.equal(await o, 'stopped')
  assert.equal(r.windows[0].destroyed, true); assert.deepEqual(r.writes, []); assert.equal(r.timers.size, 0)
  r.windows[0].title?.(WARMUP_DONE_TITLE); await tick()
  assert.deepEqual(r.writes, [], 'a late title after stop writes nothing')

  const early = rig()
  const we = new ShaderWarmup(early.deps, OPTS); const oe = we.start(); we.stop()
  assert.equal(await oe, 'stopped'); assert.equal(early.timers.size, 0); await early.advance(OPTS.delayMs * 2); assert.equal(early.windows.length, 0)

  const bad = rig({ load: 'fail' })
  const wf = new ShaderWarmup(bad.deps, OPTS); const of = wf.start()
  await bad.advance(OPTS.delayMs)
  assert.equal(await of, 'failed'); assert.equal(bad.windows[0].destroyed, true); assert.deepEqual(bad.writes, [])
})

test('SW6 the session serves only plain UI files under the UI folder', () => {
  const ui = path.resolve(temp, 'ui')
  assert.equal(warmupFile(ui, WARMUP_ORIGIN + '/shader-warmup.html'), path.join(ui, 'shader-warmup.html'))
  assert.equal(warmupFile(ui, WARMUP_ORIGIN + '/assets/shader-warmup-abc.js'), path.join(ui, 'assets', 'shader-warmup-abc.js'))
  assert.equal(warmupFile(ui, WARMUP_ORIGIN + '/assets/x.css?v=1'), path.join(ui, 'assets', 'x.css'))
  // the URL parser already folds /../ back under the root
  assert.equal(warmupFile(ui, WARMUP_ORIGIN + '/../index.html'), path.join(ui, 'index.html'))
  for (const bad of [WARMUP_ORIGIN + '/assets/..%5c..%5c..%5cx.js', WARMUP_ORIGIN + '/%5c..%5cx.js',
    'https://example.com/shader-warmup.html', 'http://orgtree-shader-warmup.invalid/shader-warmup.html', WARMUP_ORIGIN + '/',
    WARMUP_ORIGIN + '/data/db.sqlite', WARMUP_ORIGIN + '/x.exe', 'not a url']) {
    assert.equal(warmupFile(ui, bad), null, bad)
  }
})

test('SW7 the stall log keeps an outcome enum and durations, never error text', async () => {
  const file = path.join(temp, 'ui-stalls.jsonl')
  const log = new StallLog({ file: () => file, app: () => '4.6.1-test', clock: () => new Date('2026-11-16T20:30:00Z') })
  log.write('shader-warmup', { outcome: 'done', ms: 23000, window_ms: 2400, error: 'C:\\Users\\someone\\secret' })
  log.write('shader-warmup', { outcome: 'whatever', ms: 1 })
  await log.flush()                                // the stall log appends asynchronously (main-thread fix)
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l))
  assert.equal(lines.length, 2)
  assert.equal(lines[0].src, 'shader-warmup'); assert.equal(lines[0].outcome, 'done'); assert.equal(lines[0].window_ms, 2400); assert.equal(lines[0].ms, 23000)
  assert.equal(JSON.stringify(lines).includes('secret'), false)
  assert.equal(lines[1].outcome, 'other')
  // SW11: the cache folder's creation time (an ISO time, nothing else) and its size
  log.write('shader-warmup', { outcome: 'skipped-warm', ms: 15000, cache_birth: '2026-11-16T21:03:02.000Z', cache_bytes: 10548908 })
  log.write('shader-warmup', { outcome: 'done', ms: 15000, cache_birth: 'C:\\Users\\someone\\GrShaderCache', cache_bytes: 'big' })
  log.write('shader-warmup', { outcome: 'done', ms: 15000, cache_birth: null, cache_bytes: null })
  await log.flush()
  const more = fs.readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l)).slice(2)
  assert.equal(more[0].cache_birth, '2026-11-16T21:03:02.000Z'); assert.equal(more[0].cache_bytes, 10548908)
  assert.equal('cache_birth' in more[1], false, 'not a time: dropped'); assert.equal('cache_bytes' in more[1], false)
  assert.equal(more[2].cache_birth, null, 'no folder yet'); assert.equal(more[2].cache_bytes, null)
  assert.equal(JSON.stringify(more).includes('someone'), false)
})

test('SW8 the page is its own Vite build, mounts the scene, and its done title matches', () => {
  const b = fs.readFileSync('tools/build.mjs', 'utf8')
  // its own Vite build after the app's, into the same folder: no chunk shared with the app's entry
  const calls = b.split('await renderer(').slice(1).map(c => c.slice(0, c.indexOf('} })') + 4))
  assert.equal(calls.length, 2)
  assert.doesNotMatch(calls[0], /rollupOptions|shader-warmup/, 'the app build is unchanged')
  assert.match(calls[0], /emptyOutDir: true/)
  assert.match(calls[1], /emptyOutDir: false/, 'the second build keeps the app')
  assert.match(calls[1], /input: path\.resolve\('apps\/desktop\/renderer\/shader-warmup\.html'\)/)
  assert.match(fs.readFileSync('apps/desktop/renderer/shader-warmup.html', 'utf8'), /src="\/src\/shaderwarmup-main\.tsx"/)
  assert.match(fs.readFileSync('apps/desktop/renderer/src/shaderwarmup-main.tsx', 'utf8'), /mountShaderWarmup\(document\.getElementById\('root'\)!\)/)
  const scene = fs.readFileSync('apps/desktop/renderer/src/shaderwarmup.tsx', 'utf8')
  assert.ok(scene.includes(`export const WARMUP_DONE_TITLE = '${WARMUP_DONE_TITLE}'`))
  assert.match(scene, /window\.fetch = /, 'the scene answers its own reads')
  assert.match(scene, /window\.WebSocket = /)
  const main = fs.readFileSync('apps/desktop/main/index.ts', 'utf8')
  assert.equal((main.match(/startShaderWarmup\(/g) || []).length, 1, 'started once, from app ready')
})

test('SW9 a recreated cache folder runs again; the marker records the folder creation time', async () => {
  const key = warmupKey(PARTS)
  for (const [name, marker, birth, runs] of [
    ['same folder', { key, cache_birth: 1_000 }, 1_000, false],
    ['folder recreated since', { key, cache_birth: 1_000 }, 5_000, true],
    ['marker from before SW9', { key }, 1_000, true]]) {
    const r = rig({ marker: JSON.stringify(marker), birth })
    const w = new ShaderWarmup(r.deps, OPTS); const o = w.start(); await r.advance(OPTS.delayMs)
    assert.equal(r.windows.length, runs ? 1 : 0, name)
    if (!runs) { assert.equal(await o, 'skipped-warm', name); continue }
    r.windows[0].title(WARMUP_DONE_TITLE); assert.equal(await o, 'done', name)
    assert.deepEqual(JSON.parse(r.writes[0]).cache_birth, birth, name + ': the marker names the folder it warmed')
  }
})

test('SW10 a slow-compiling GPU can finish: 45 s deadline, desks advance on quick frames', async () => {
  const { WARMUP_DEFAULTS } = req(bundle)
  assert.ok(WARMUP_DEFAULTS.deadlineMs >= 45_000, `deadline ${WARMUP_DEFAULTS.deadlineMs} ms`)
  const scene = fs.readFileSync('apps/desktop/renderer/src/shaderwarmup.tsx', 'utf8')
  assert.match(scene, /const settle = /, 'a settle step: frames quick again')
  assert.match(scene, /for \(const id of DESKS\) \{[^}]*await settle\(step\)/, 'every desk waits for settle, not a fixed time')
  assert.doesNotMatch(scene, /await wait\(step\)/)
})

test('SW11 every outcome line records the cache folder creation time and size', async () => {
  const key = warmupKey(PARTS)
  const skip = rig({ marker: JSON.stringify({ key, cache_birth: 1_000 }) })
  const ws = new ShaderWarmup(skip.deps, OPTS); const os = ws.start(); await skip.advance(OPTS.delayMs); await os
  assert.equal(skip.logs[0].cache_birth, new Date(1_000).toISOString()); assert.equal(skip.logs[0].cache_bytes, 10_548_908)
  const none = rig({ cache: false })
  const wn = new ShaderWarmup(none.deps, OPTS); const on = wn.start(); await none.advance(OPTS.delayMs)
  none.windows[0].title(WARMUP_DONE_TITLE); await on
  assert.equal(none.logs[0].cache_birth, null, 'no cache folder yet'); assert.equal(none.logs[0].cache_bytes, null)
})
