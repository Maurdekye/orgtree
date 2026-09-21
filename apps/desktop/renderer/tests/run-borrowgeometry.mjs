// run-borrowgeometry.mjs — a TEST-ONLY Electron driver for the one borrow
// case the renderer cannot exercise on its own.
//
// WHY THIS EXISTS RATHER THAN tools/run-probe.mjs. The geometry correction
// says a borrow captures where the window REALLY is, not the last 250 ms
// sample. Proving that needs the child window to MOVE, and a renderer cannot
// move an Electron child window — `moveTo`/`resizeTo` from page script had no
// effect, which is why the phase in borrowlifecycle-probe reports NOT
// EXERCISED rather than a vacuous pass. The main process can, through
// `did-create-window` + `setBounds`.
//
// ⚠ THIS IS TEST-ONLY AND ADDS NOTHING TO THE PRODUCT. No bridge capability,
// no preload change, no product code path. The driver reaches the child the
// way a test harness does and the renderer under test is unmodified — which
// is the point: the thing being measured must not be aware it is being
// measured.
//
// ISOLATION, same as the shared runner: ORGTREE_DATA and HOME point into the
// out directory and Electron's own state is moved with app.setPath. The live
// data root is never read or written and the installed app is never launched.
//
// Usage: node apps/desktop/renderer/tests/run-borrowgeometry.mjs <entry.tsx> <outdir>
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
for (const k of ['userData', 'sessionData', 'cache', 'temp', 'logs', 'crashDumps']) {
  try { app.setPath(k, path.join(__dirname, 'electron-' + k)) } catch (e) {}
}

// THE TARGET BOUNDS. Deliberately not round numbers that a default could
// coincide with, and deliberately far from the parent's own geometry.
const TARGET = { x: 137, y: 163, width: 561, height: 421 }

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 900, height: 800, show: false,
    webPreferences: { contextIsolation: true, sandbox: false } })
  let gone = null, child = null, moved = null
  win.webContents.on('render-process-gone', (_e, d) => { gone = d })
  win.webContents.on('console-message', (_e, lvl, msg) => {
    if (lvl >= 2) log('CONSOLE' + lvl + ': ' + String(msg).slice(0, 600)) })

  // ⚠ THE WHOLE REASON FOR A BESPOKE DRIVER. The surface's pop-out is a
  // window.open from page script; this is where the main process gets a
  // handle on it so it can be moved.
  win.webContents.setWindowOpenHandler(() => ({ action: 'allow' }))
  win.webContents.on('did-create-window', (w) => {
    child = w
    log('did-create-window')
  })

  // The renderer asks for the move by setting document.title, which is PUSHED
  // to this process and therefore works even while the page is busy.
  win.on('page-title-updated', (_e, t) => {
    log('TITLE ' + t)
    if (t !== 'MOVE-NOW' || !child || moved) return
    try {
      child.setBounds(TARGET)
      // read BACK what the window manager actually granted — a monitor-fit or
      // a minimum size may adjust the request, and the assertion must be
      // against what happened rather than what was asked for
      const actual = child.getBounds()
      moved = actual
      log('setBounds -> ' + JSON.stringify(actual))
      void win.webContents.executeJavaScript(
        'window.__MOVED = ' + JSON.stringify(actual) + ';true').catch((e) => log('inject failed ' + e))
    } catch (e) { log('setBounds failed ' + e) }
  })

  win.loadFile(path.join(__dirname, 'probe.html'))
  const t0 = Date.now()
  let last = null
  while (Date.now() - t0 < 120000 && !gone) {
    const out = await win.webContents
      .executeJavaScript('window.PROBE && JSON.stringify(window.PROBE)')
      .catch((e) => JSON.stringify({ evalError: String(e) }))
    if (out) { last = out; try { write({ ...JSON.parse(out), requestedBounds: TARGET, grantedBounds: moved }) } catch (e) {} }
    if (out && JSON.parse(out).done) break
    await new Promise((r) => setTimeout(r, 100))
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
// ⚠ or you get Node rather than Electron, and the failure is confusing
delete env.ELECTRON_RUN_AS_NODE
const r = spawnSync(exe, [main], { env, encoding: 'utf8', timeout: 240000, windowsHide: true })
console.error('electron status', r.status, r.signal ?? '', String(r.error ?? ''))
if (fs.existsSync(out + '.log')) console.error('--- main log ---\n' + fs.readFileSync(out + '.log', 'utf8'))
console.log(fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : 'NO RESULT FILE')
