// tools/run-alloc-probe.mjs — measure ALLOCATION, not latency, in a real
// Electron renderer.
//
// WHY THIS EXISTS AND WHY IT IS NOT run-probe.mjs. `run-probe.mjs` reads a
// result object out of a page that has finished. The question here is a rate:
// how many bytes does the renderer allocate per streamed token, and which code
// allocates them. Retained-size tools (`memoryUsage`, a heap snapshot) cannot
// see that at all — the ticket's whole point is that nothing is retained.
// V8's SAMPLING HEAP PROFILER can: it attributes allocated bytes to the stack
// that allocated them, garbage included, and it is reachable over CDP, which
// the main process already attaches for the wedge watchdog.
//
// Usage: node tools/run-alloc-probe.mjs <entry.tsx> <outdir> [scenario,...]
// The page must expose window.__alloc = { setup(name), run(n), idle(ms) }.
// ISOLATION is exactly run-probe.mjs's: ORGTREE_DATA and HOME point into
// <outdir> and Electron's own paths are moved with app.setPath. USERPROFILE is
// deliberately NOT redirected — on this host that breaks Chromium's path
// resolution and app.whenReady() never fires.
import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'

const entry = process.argv[2]
const root = path.resolve(process.argv[3])
const scenarios = (process.argv[4] || '').trim()
fs.rmSync(root, { recursive: true, force: true })
fs.mkdirSync(path.join(root, 'home'), { recursive: true })
fs.mkdirSync(path.join(root, 'data'), { recursive: true })
await build({
  entryPoints: [entry], outfile: path.join(root, 'probe.js'), bundle: true,
  platform: 'browser', format: 'iife', jsx: 'automatic', logLevel: 'warning',
  minify: false, define: { 'process.env.NODE_ENV': '"production"' },
})
// the real stylesheet, so layout and paint cost what they cost in the app
const css = path.resolve('apps/desktop/renderer/src/styles.css')
await build({
  entryPoints: [css], outfile: path.join(root, 'probe.css'), bundle: true,
  loader: { '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl',
            '.png': 'dataurl', '.svg': 'dataurl', '.jpg': 'dataurl' },
  logLevel: 'silent',
}).catch(() => fs.writeFileSync(path.join(root, 'probe.css'), ''))
fs.writeFileSync(path.join(root, 'probe.html'),
  '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="probe.css">'
  + '<body class="contrast-charcoal"><div id="root"></div><script src="probe.js"></script></body>')
const main = path.join(root, 'main.cjs')
fs.writeFileSync(main, `const { app, BrowserWindow } = require('electron')
const fs = require('node:fs'); const path = require('node:path')
const O = process.env.PROBE_OUT
const SCENARIOS = (process.env.PROBE_SCENARIOS || '').split(',').filter(Boolean)
const write = (o) => { try { fs.writeFileSync(O, JSON.stringify(o, null, 2)) } catch (e) {} }
const log = (m) => { try { fs.appendFileSync(O + '.log', String(m) + String.fromCharCode(10)) } catch (e) {} }
app.disableHardwareAcceleration()
for (const k of ['userData', 'sessionData', 'cache', 'temp', 'logs', 'crashDumps']) {
  try { app.setPath(k, path.join(__dirname, 'electron-' + k)) } catch (e) {}
}
// ⚠ THE FLAGS ARE THE MEASUREMENT.
//  --expose-gc         the probe collects between phases, so one phase's
//                      survivors are not counted as the next phase's garbage.
//  --max-semi-space-size=64   a 64 MB young generation. A phase allocates far
//                      less than that, so NO scavenge runs inside a
//                      measurement window and the used-heap delta is the
//                      allocation, exactly, rather than an estimate.
//  --max-old-space-size=4096  the renderer under test is the one that OOMs in
//                      production; give it room so the probe measures
//                      allocation instead of reproducing the crash.
// enable-precise-memory-info makes performance.memory.usedJSHeapSize report
// real bytes instead of the 100 KB privacy buckets the web platform quantises
// it to — without it the per-event numbers are noise.
app.commandLine.appendSwitch('js-flags',
  '--expose-gc --max-semi-space-size=64 --max-old-space-size=4096')
app.commandLine.appendSwitch('enable-precise-memory-info')

/** Sum every selfSize in a sampling profile, and attribute the total to the
 *  nearest named frame. The profiler reports a TREE of call frames with
 *  selfSize in bytes, already scaled up from the sample interval — so the sum
 *  is an estimate of bytes allocated during the window, garbage included. */
function summarize(profile) {
  let total = 0
  const byFunction = new Map()
  const walk = (node) => {
    const f = node.callFrame || {}
    const name = (f.functionName || '(anonymous)') + ' @'
      + String(f.url || '?').split('/').pop() + ':' + ((f.lineNumber || 0) + 1)
    total += node.selfSize || 0
    if (node.selfSize) byFunction.set(name, (byFunction.get(name) || 0) + node.selfSize)
    for (const c of node.children || []) walk(c)
  }
  walk(profile.head)
  const top = [...byFunction.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)
    .map(([name, bytes]) => ({ name, bytes }))
  return { total, top }
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1200, height: 900, show: false,
    webPreferences: { contextIsolation: true, sandbox: false,
                      backgroundThrottling: false } })
  let gone = null
  win.webContents.on('render-process-gone', (_e, d) => { gone = d })
  win.webContents.on('console-message', (_e, lvl, msg) => {
    if (lvl >= 1) log('CONSOLE' + lvl + ': ' + String(msg).slice(0, 900)) })
  win.webContents.on('did-fail-load', (_e, c, d) => log('did-fail-load ' + c + ' ' + d))
  win.on('page-title-updated', (_e, t) => log('TITLE ' + t))
  await win.loadFile(path.join(__dirname, 'probe.html')).catch((e) => log('loadFile rejected ' + e))
  log('loaded')
  const dbg = win.webContents.debugger
  dbg.attach('1.3')
  await dbg.sendCommand('HeapProfiler.enable')
  const evalIn = (src) => win.webContents.executeJavaScript(src, true)
  // wait for the bundle to install its API
  for (let i = 0; i < 80; i++) {
    if (await evalIn('!!(window.__alloc)').catch(() => false)) break
    await new Promise((r) => setTimeout(r, 250))
  }
  const names = SCENARIOS.length ? SCENARIOS
    : await evalIn('window.__alloc.scenarios()')
  log('scenarios: ' + JSON.stringify(names))
  const results = []
  for (const name of names) {
    try {
      log('--- ' + name + ': setup')
      const setup = await evalIn('window.__alloc.setup(' + JSON.stringify(name) + ')')
      log('    setup -> ' + JSON.stringify(setup))
      // settle, then collect: the sampling window must start on a quiet heap
      await evalIn('window.__alloc.idle(600)')
      await evalIn('(window.gc && window.gc(), true)').catch(() => {})
      // A 1024-byte sampling interval is fine-grained; the profiler's own
      // overhead is real but it falls on every scenario equally.
      await dbg.sendCommand('HeapProfiler.startSampling', { samplingInterval: 1024 })
      // CDP's own view of the same isolate, read either side of the window.
      // This is the cross-check on the in-page performance.memory reading:
      // two instruments that disagree about a scenario whose arithmetic is
      // known mean one of them is not measuring what its name says.
      const before = await dbg.sendCommand('Runtime.getHeapUsage').catch(() => null)
      const ran = await evalIn('window.__alloc.run(' + JSON.stringify(name) + ')')
      const after = await dbg.sendCommand('Runtime.getHeapUsage').catch(() => null)
      if (before && after) {
        ran.cdpUsedStart = Math.round(before.usedSize)
        ran.cdpUsedEnd = Math.round(after.usedSize)
        ran.cdpUsedDelta = Math.round(after.usedSize - before.usedSize)
      }
      const { profile } = await dbg.sendCommand('HeapProfiler.stopSampling')
      const s = summarize(profile)
      // ⚠ "bytes" IS THE FIGURE TO QUOTE. "sampledBytes" IS NOT AN ALLOCATION
      // RATE AND MUST NEVER BE READ AS ONE.
      //
      // The fixture's sampler-retained / sampler-dropped pair settles what
      // HeapProfiler.getSamplingProfile actually reports. Both allocate the
      // same 26 MB by the same code path and differ only in whether the result
      // is kept. Measured here: 26,446,680 sampled when it survives, 3,452
      // when it does not — a factor of seven thousand for identical
      // allocation. It reports sampled allocations that are still RETAINED, so
      // for churning code, which is all the code this ticket is about, it
      // reports almost nothing.
      //
      // The same pair validates "bytes": it reported ~34.5 MB for BOTH
      // variants, which is what an allocation instrument must do, and CDP's
      // own retained delta agreed with the survivors (26.3 MB and 76 KB).
      //
      // "top" is kept because it is the only attribution available, but it
      // names what SURVIVED — treat it as a hint, never as a share of cost,
      // and never compare it between scenarios with different survival rates.
      log('    ran -> ' + JSON.stringify(ran) + ' sampled=' + s.total)
      results.push({ scenario: name, ...ran, sampledBytes: s.total, top: s.top })
      write({ results })
    } catch (e) {
      log('    FAILED ' + String(e && e.stack || e))
      results.push({ scenario: name, error: String(e && e.message || e) })
      write({ results })
    }
    if (gone) { log('RENDERER GONE ' + JSON.stringify(gone)); break }
  }
  write({ results, rendererGone: gone })
  log('exit')
  app.exit(0)
})
`)
const out = path.join(root, 'result.json')
const exe = createRequire(import.meta.url)('electron')
const env = { ...process.env, PROBE_OUT: out, PROBE_SCENARIOS: scenarios,
  ORGTREE_DATA: path.join(root, 'data'), HOME: path.join(root, 'home') }
delete env.ELECTRON_RUN_AS_NODE
const r = spawnSync(exe, [main], { env, encoding: 'utf8', timeout: 600000, windowsHide: true })
console.error('electron status', r.status, r.signal ?? '', String(r.error ?? ''))
if (fs.existsSync(out + '.log')) console.error('--- main log ---\n' + fs.readFileSync(out + '.log', 'utf8'))
console.log(fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : 'NO RESULT FILE')
