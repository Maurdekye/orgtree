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
// ⚠ THE MAIN-PROCESS SOURCE BELOW IS A TEMPLATE LITERAL. A backtick anywhere
// inside it — including in a comment, which is where it is easy to reach for
// one — ENDS the template, and the failure surfaces as a SyntaxError in THIS
// file at the line where the template starts, nowhere near the backtick. Use
// plain quotes in that block. (Cost one confusing failure; noted so the next
// person does not spend the same minutes.)
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
const TARGETS = [
  { x: 137, y: 163, width: 561, height: 421 },
  { x: 241, y: 271, width: 487, height: 389 },
  { x: 189, y: 227, width: 523, height: 357 },
]

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 900, height: 800, show: false,
    webPreferences: { contextIsolation: true, sandbox: false } })
  let gone = null, child = null, moved = null, moves = 0
  // ⚠ EVERY child window this page has opened, in order, and how many there
  // have been. The borrow→dismiss case needs the window that comes BACK, which
  // is a DIFFERENT BrowserWindow from the one that was borrowed: the borrow
  // closes the original and 'restore()' opens a new one. Counting births is how
  // the renderer knows the return really happened rather than never closing.
  const children = []
  let born = 0
  win.webContents.on('render-process-gone', (_e, d) => { gone = d })
  win.webContents.on('console-message', (_e, lvl, msg) => {
    if (lvl >= 2) log('CONSOLE' + lvl + ': ' + String(msg).slice(0, 600)) })

  // ⚠ THE WHOLE REASON FOR A BESPOKE DRIVER. The surface's pop-out is a
  // window.open from page script; this is where the main process gets a
  // handle on it so it can be moved.
  win.webContents.setWindowOpenHandler(() => ({ action: 'allow' }))
  win.webContents.on('did-create-window', (w) => {
    child = w
    born++
    children.push(w)
    // ⚠⚠ THE ONE LINE THAT MAKES THIS HARNESS RESEMBLE THE PRODUCT.
    // configureWindow (main/windows.ts) recurses into every popout and turns
    // background throttling OFF, because Chromium can leave an adopted
    // about:blank document 'hidden' while its native window is visible.
    // THROTTLING SUPPRESSES THE RENDERER'S SCREEN-RECT UPDATES: without this
    // call, screenX/outerWidth stay frozen at the opener's rect forever, and
    // this driver measures a window the renderer cannot see. That artefact
    // cost v3-native-opus and me an hour and a wrong conclusion each.
    try { w.webContents.setBackgroundThrottling(false) } catch (e) { log('throttle off failed ' + e) }
    log('did-create-window (throttling disabled)')
  })

  // The renderer asks for the move by setting document.title, which is PUSHED
  // to this process and therefore works even while the page is busy.
  win.on('page-title-updated', (_e, t) => {
    log('TITLE ' + t)
    // ⚠ THE NATIVE TRUTH ABOUT THE WINDOW THAT CAME BACK. The renderer cannot
    // answer this for itself: after a borrow the ORIGINAL window is closed and
    // 'restore()' opens a NEW one, so the only party that can say where the
    // returned window really sits is this process, reading the live
    // BrowserWindow. Asked for by title, with a unique suffix each time —
    // 'page-title-updated' does not fire when the title is unchanged, so a
    // repeated bare request would silently answer nothing.
    if (String(t).startsWith('BOUNDS-NOW')) {
      const live = children.filter((w) => !w.isDestroyed())
      const last = live[live.length - 1]
      const payload = { born, live: live.length, rect: last ? last.getBounds() : null }
      log('BOUNDS ' + JSON.stringify(payload))
      void win.webContents.executeJavaScript(
        'window.__BOUNDS = ' + JSON.stringify(payload) + ';true').catch((e) => log('inject failed ' + e))
      return
    }
    // ⚠ REPEATABLE. The settle diagnostic is a SECOND move in the same run,
    // and a one-shot guard here silently refused it — the phase reported
    // 'main process never reported a move' and measured nothing. Each move
    // uses its own target so a stale value cannot be mistaken for a fresh one.
    if (t !== 'MOVE-NOW' || !child) return
    try {
      const TARGET = TARGETS[Math.min(moves, TARGETS.length - 1)]
      moves++
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
    if (out) { last = out; try { write({ ...JSON.parse(out), requestedBounds: TARGETS, grantedBounds: moved }) } catch (e) {} }
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
