// tools/run-probe.mjs — build + run a renderer probe in an isolated Electron.
// Usage: node tools/run-probe.mjs <entry.tsx> <outdir>
// ISOLATION: ORGTREE_DATA, HOME and USERPROFILE all point into <outdir>.
// The live data root is never read or written and the installed app is never launched.
import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'

const entry = process.argv[2]
const root = path.resolve(process.argv[3])
fs.rmSync(root, { recursive: true, force: true })
fs.mkdirSync(path.join(root, 'home'), { recursive: true })
fs.mkdirSync(path.join(root, 'data'), { recursive: true })
await build({
  entryPoints: [entry], outfile: path.join(root, 'probe.js'), bundle: true,
  platform: 'browser', format: 'iife', jsx: 'automatic', logLevel: 'warning',
  minify: false, define: { 'process.env.NODE_ENV': '"development"' },
})
fs.writeFileSync(path.join(root, 'probe.html'),
  '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="probe.css">'
  + '<body class="contrast-charcoal"><div id="root"></div><script src="probe.js"></script></body>')
const main = path.join(root, 'main.cjs')
fs.writeFileSync(main, `const { app, BrowserWindow } = require('electron')
const fs = require('node:fs'); const path = require('node:path')
const O = process.env.PROBE_OUT
const write = (o) => { try { fs.writeFileSync(O, JSON.stringify(o, null, 2)) } catch (e) {} }
const log = (m) => { try { fs.appendFileSync(O + '.log', String(m) + String.fromCharCode(10)) } catch (e) {} }
app.disableHardwareAcceleration()
// ISOLATION, THE PART THAT ACTUALLY WORKS ON THIS HOST. Redirecting
// USERPROFILE breaks Chromium's own path resolution and app.whenReady() never
// fires (measured: exit 0x80000003 with no renderer). So Electron's own state
// is moved with setPath instead, which is the thing USERPROFILE was standing
// in for, and ORGTREE_DATA/HOME still point into the probe root.
for (const k of ['userData', 'sessionData', 'cache', 'temp', 'logs', 'crashDumps']) {
  try { app.setPath(k, path.join(__dirname, 'electron-' + k)) } catch (e) {}
}
log('main start')
app.whenReady().then(async () => {
  log('ready')
  const win = new BrowserWindow({ width: 900, height: 800, show: false,
    webPreferences: { contextIsolation: true, sandbox: false } })
  let gone = null, last = null
  win.webContents.on('render-process-gone', (_e, d) => { gone = d })
  win.webContents.on('console-message', (_e, lvl, msg) => {
    if (lvl >= 2) log('CONSOLE' + lvl + ': ' + String(msg).slice(0, 600)) })
  win.webContents.on('did-finish-load', () => log('did-finish-load'))
  win.webContents.on('did-fail-load', (_e, c, d) => log('did-fail-load ' + c + ' ' + d))
  win.webContents.on('unresponsive', () => log('UNRESPONSIVE'))
  // ⚠ THE ONLY CHANNEL THAT SURVIVES A WEDGED RENDERER. executeJavaScript
  // needs the renderer's main thread, so a runaway render loop makes the probe
  // unreadable exactly when it has the most to say. A title change is PUSHED
  // to this process, so the last phase the page reached is still legible after
  // it stops responding. The probe sets document.title as it advances.
  win.on('page-title-updated', (_e, t) => log('TITLE ' + t))
  win.webContents.on('crashed', () => log('CRASHED'))
  win.loadFile(path.join(__dirname, 'probe.html')).then(() => log('loadFile resolved'),
    (e) => log('loadFile rejected ' + e))
  log('load issued')
  // ⚠ AND WHEN IT WEDGES, THIS IS HOW YOU LEARN WHERE. executeJavaScript needs
  // the renderer's main thread, so a runaway loop makes the page unreadable
  // exactly when it has the most to say. The V8 inspector runs on its own
  // channel and CAN interrupt a spinning script: attach, wait, pause, and the
  // call frames name the loop.
  const dbg = win.webContents.debugger
  try {
    dbg.attach('1.3')
    dbg.on('message', (_e, method, params) => {
      if (method !== 'Debugger.paused') return
      const frames = (params.callFrames || []).slice(0, 30).map((f) =>
        (f.functionName || '(anon)') + ' @' + String(f.url).split('/').pop()
        + ':' + (f.location.lineNumber + 1))
      log('PAUSED reason=' + params.reason)
      for (const f of frames) log('  at ' + f)
      dbg.sendCommand('Debugger.resume').catch(() => {})
    })
    dbg.sendCommand('Debugger.enable').catch((e) => log('dbg enable failed ' + e))
    setTimeout(() => {
      log('watchdog: pausing renderer')
      dbg.sendCommand('Debugger.pause').catch((e) => log('pause failed ' + e))
      setTimeout(() => { log('watchdog: second sample'); dbg.sendCommand('Debugger.pause').catch(() => {}) }, 4000)
      setTimeout(() => { log('watchdog: giving up'); app.exit(9) }, 12000)
    }, Number(process.env.PROBE_WEDGE_MS || 20000))
  } catch (e) { log('debugger attach failed ' + e) }
  const t0 = Date.now()
  while (Date.now() - t0 < 90000 && !gone) {
    const out = await win.webContents
      .executeJavaScript('window.PROBE && JSON.stringify(window.PROBE)')
      .catch((e) => JSON.stringify({ evalError: String(e) }))
    if (out) { last = out; try { write(JSON.parse(out)) } catch (e) {} }
    if (out && JSON.parse(out).done) break
    await new Promise((r) => setTimeout(r, 250))
  }
  if (gone) { log('RENDERER GONE ' + JSON.stringify(gone)); write({ rendererGone: gone, last: last && JSON.parse(last) }) }
  log('exit')
  app.exit(0)
})
`)
const out = path.join(root, 'result.json')
const exe = createRequire(import.meta.url)('electron')
const env = { ...process.env, PROBE_OUT: out, ORGTREE_DATA: path.join(root, 'data'),
  HOME: path.join(root, 'home') }
delete env.ELECTRON_RUN_AS_NODE
const r = spawnSync(exe, [main], { env, encoding: 'utf8', timeout: 240000, windowsHide: true })
console.error('electron status', r.status, r.signal ?? '', String(r.error ?? ''))
if (fs.existsSync(out + '.log')) console.error('--- main log ---\n' + fs.readFileSync(out + '.log', 'utf8'))
console.log(fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : 'NO RESULT FILE')
