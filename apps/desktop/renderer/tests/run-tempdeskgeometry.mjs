// Isolated Electron probe. No engine, installed app, or live profile is opened.
// Usage: node apps/desktop/renderer/tests/run-tempdeskgeometry.mjs [DPR] [height]
import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'

const ratio = Number(process.argv[2] ?? 1.25)
if (![1, 1.25, 1.5, 2].includes(ratio)) throw Error('Unsupported probe DPR')
const height = Number(process.argv[3] ?? 800)
if (!Number.isInteger(height) || height < 220 || height > 2000) throw Error('Invalid probe height')
const artifacts = path.resolve('artifacts')
fs.mkdirSync(artifacts, {recursive: true})
const root = fs.mkdtempSync(path.join(artifacts, 'tempdesk-geometry-'))
for (const dir of ['home', 'data']) fs.mkdirSync(path.join(root, dir))
await build({entryPoints: ['apps/desktop/renderer/tests/tempdeskgeometry-probe.tsx'],
  outfile: path.join(root, 'probe.js'), bundle: true, platform: 'browser', format: 'iife',
  jsx: 'automatic', define: {'process.env.NODE_ENV': '"development"'}, logLevel: 'warning'})
await build({entryPoints: ['apps/desktop/main/windows.ts'], outfile: path.join(root, 'windows.cjs'),
  bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'warning'})
fs.writeFileSync(path.join(root, 'probe.html'), '<!doctype html><link rel="stylesheet" href="probe.css"><div id="root"></div><script src="probe.js"></script>')
const main = path.join(root, 'main.cjs')
fs.writeFileSync(main, `
const {app, BrowserWindow} = require('electron')
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict')
const {configureWindow} = require('./windows.cjs')
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('force-device-scale-factor', '${ratio}')
for (const key of ['userData','sessionData','cache','temp','logs','crashDumps'])
  app.setPath(key, path.join(__dirname, 'electron-' + key))
const wait = ms => new Promise(r => setTimeout(r, ms))
const result = {ratio: ${ratio}}
const timeout = setTimeout(() => { console.error('probe timeout'); app.exit(2) }, 60000)
app.whenReady().then(async () => {
  const server = require('node:http').createServer((req, res) => {
    const name = {'/':'probe.html','/probe.js':'probe.js','/probe.css':'probe.css'}[req.url]
    if (!name) {res.writeHead(404); res.end(); return}
    res.setHeader('Content-Type', name.endsWith('.css') ? 'text/css' : name.endsWith('.js') ? 'text/javascript' : 'text/html')
    res.end(fs.readFileSync(path.join(__dirname, name)))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = 'http://127.0.0.1:' + server.address().port
  const win = new BrowserWindow({x: 80, y: 100, width: 1100, height: ${height}, frame: false,
    show: false, webPreferences: {contextIsolation: true, sandbox: true, backgroundThrottling: false}})
  let child
  // Keep the real production handler and bounds correction, hiding only the
  // test window that would otherwise be shown by window.open.
  const setHandler = win.webContents.setWindowOpenHandler.bind(win.webContents)
  win.webContents.setWindowOpenHandler = handler => setHandler(details => {
    const result = handler(details)
    return {...result, overrideBrowserWindowOptions: {...result.overrideBrowserWindowOptions, show: false}}
  })
  configureWindow(win, origin, true)
  win.webContents.on('did-create-window', (w, details) => { child = w; w.webContents.setBackgroundThrottling(false)
    result.creation = {features: details.features, bounds: w.getBounds(), options: {
      width: details.options.width, height: details.options.height, x: details.options.x, y: details.options.y}}
  })
  await win.loadURL(origin + '/')
  const run = code => win.webContents.executeJavaScript(code, true)
  result.beforePin = await run('geometryProbe.open()')
  result.pin = await run('geometryProbe.pin()')
  for (const key of ['x','y','width','height']) assert.ok(
    Math.abs(result.beforePin.rect[key] - result.pin.rect[key]) * ${ratio} <= 1,
    'PIN changed ' + key + ': ' + JSON.stringify(result))
  assert.equal(result.pin.modal, false)
  assert.equal(result.pin.visible, true, 'PIN chrome is clipped or covered')
  assert.equal(result.pin.composer, true)
  await run('geometryProbe.unpin()'); await wait(100)
  result.beforePopout = await run('geometryProbe.open()')
  await run('geometryProbe.popout()'); await wait(300)
  assert.ok(child && !child.isDestroyed(), 'no native pop-out')
  result.native = child.getBounds()
  result.afterPopout = await run('geometryProbe.state()')
  result.childComposers = await child.webContents.executeJavaScript('document.querySelectorAll("textarea").length')
  const expected = {...result.beforePopout.rect,
    x: result.beforePopout.screenX + result.beforePopout.rect.x,
    y: result.beforePopout.screenY + result.beforePopout.rect.y}
  for (const key of ['x','y','width','height']) assert.ok(
    Math.abs(expected[key] - result.native[key]) * ${ratio} <= 1,
    'POP OUT changed ' + key + ': ' + JSON.stringify(result))
  assert.deepEqual(result.afterPopout, {modal: false, backdrop: false, composers: 0})
  assert.equal(result.childComposers, 1)
  child.setBounds({x: 333, y: 234, width: 550, height: 400})
  const oldChild = child
  result.borrowed = await run('geometryProbe.open()')
  assert.equal(oldChild.isDestroyed(), true, 'the temporary modal borrows the existing window')
  await run('geometryProbe.popout()'); await wait(300)
  result.reopened = child.getBounds()
  const again = {...result.borrowed.rect,
    x: result.borrowed.screenX + result.borrowed.rect.x,
    y: result.borrowed.screenY + result.borrowed.rect.y}
  for (const key of ['x','y','width','height']) assert.ok(
    Math.abs(again[key] - result.reopened[key]) * ${ratio} <= 1,
    'borrowed POP OUT reused old geometry for ' + key + ': ' + JSON.stringify(result))
  assert.deepEqual(await run('geometryProbe.state()'), {modal: false, backdrop: false, composers: 0})
  result.passed = true
}).catch(error => { result.error = String(error.stack || error) }).finally(() => {
  clearTimeout(timeout)
  fs.writeFileSync(path.join(__dirname, 'result.json'), JSON.stringify(result, null, 2))
  app.exit(result.passed ? 0 : 1)
})
`)
const env = {...process.env, ORGTREE_DATA: path.join(root, 'data'), HOME: path.join(root, 'home')}
delete env.ELECTRON_RUN_AS_NODE
const outcome = spawnSync(createRequire(import.meta.url)('electron'), [main], {
  env, encoding: 'utf8', timeout: 90000, windowsHide: true})
console.log(root)
const resultFile = path.join(root, 'result.json')
console.log(fs.existsSync(resultFile) ? fs.readFileSync(resultFile, 'utf8') : outcome.stderr)
process.exitCode = outcome.status ?? 1
