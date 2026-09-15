// tools/docketfold-probe.mjs — run the docket-description fold in a REAL browser.
//
// Answers the one question jsdom cannot: with a real ResizeObserver and real
// layout, can the unguarded `setMeasure(foldAt(...))` be re-triggered by the
// re-render it caused, or does it settle?
//
// ISOLATED BY CONSTRUCTION: ORGTREE_DATA, HOME and USERPROFILE all point at a
// fresh temp tree, so the live data root is never read or written and the
// installed app is never launched.
//
//   node tools/docketfold-probe.mjs            # build + run, prints the result
//   PROBE_OUT=<file> node tools/docketfold-probe.mjs
//
// ⚠ On this host the Bash tool swallows a spawned Electron child's stdout. The
// result is therefore ALSO written to PROBE_OUT (default: <root>/result.json),
// and the root is printed on stderr so the run can be repeated by hand.
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-docketfold-'))
await build({
  entryPoints: ['apps/desktop/renderer/tests/docketfold-probe.tsx'],
  outfile: path.join(root, 'probe.js'), bundle: true, platform: 'browser',
  format: 'iife', jsx: 'automatic', logLevel: 'warning', minify: false,
  // development React, so a render-loop warning is legible rather than a code
  define: { 'process.env.NODE_ENV': '"development"' },
})
fs.writeFileSync(path.join(root, 'probe.html'),
  '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="probe.css">'
  + '<body class="contrast-charcoal"><div id="root"></div><script src="probe.js"></script></body>')

const main = path.join(root, 'main.cjs')
fs.writeFileSync(main, `
const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 900, height: 800, show: false,
    webPreferences: { contextIsolation: true, sandbox: false } })
  await win.loadFile(path.join(__dirname, 'probe.html'))
  const t0 = Date.now()
  let out = null
  while (Date.now() - t0 < 40000) {
    out = await win.webContents.executeJavaScript(
      'window.PROBE && JSON.parse(JSON.stringify(window.PROBE))'
    ).catch(e => ({ evalError: String(e) }))
    if (out && out.done) break
    await new Promise(r => setTimeout(r, 250))
  }
  fs.writeFileSync(process.env.PROBE_OUT, JSON.stringify(out, null, 2))
  console.log('PROBE_RESULT ' + JSON.stringify(out, null, 2))
  app.exit(0)
})
`)

process.env.PROBE_OUT = process.env.PROBE_OUT || path.join(root, 'result.json')
const executable = process.env.ORGTREE_HISTORY_ELECTRON || createRequire(import.meta.url)('electron')
const env = { ...process.env, PROBE_OUT: process.env.PROBE_OUT,
  ORGTREE_DATA: path.join(root, 'data'),
  HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home') }
delete env.ELECTRON_RUN_AS_NODE
console.error('probe root:', root)
console.error('result file:', env.PROBE_OUT)
const child = spawn(executable, [main], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env })
child.stdout.on('data', (d) => process.stdout.write(d))
child.stderr.on('data', (d) => process.stderr.write(d))
child.on('error', (e) => { console.error(e); process.exitCode = 1 })
child.on('exit', (code) => { process.exitCode = code ?? 1 })
