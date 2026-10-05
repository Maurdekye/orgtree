// Isolated hidden Electron, fake data, no engine or installed profile.
import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
const ratio = Number(process.argv[2] ?? 1.25)
if (![1, 1.25, 1.5, 2].includes(ratio)) throw Error('Unsupported DPR')
fs.mkdirSync('artifacts', {recursive: true})
const root = fs.mkdtempSync(path.resolve('artifacts/edgejump-geometry-'))
await build({entryPoints: ['apps/desktop/renderer/tests/edgejump-geometry-probe.tsx'],
  outfile: path.join(root, 'probe.js'), bundle: true, platform: 'browser', format: 'iife',
  jsx: 'automatic', define: {'process.env.NODE_ENV': '"development"'}, logLevel: 'warning'})
fs.writeFileSync(path.join(root, 'probe.html'), '<!doctype html><link rel="stylesheet" href="probe.css"><div id="root"></div><script src="probe.js"></script>')
const main = path.join(root, 'main.cjs')
fs.writeFileSync(main, `
const {app, BrowserWindow} = require('electron')
const fs = require('node:fs'), path = require('node:path')
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('force-device-scale-factor', '${ratio}')
for (const key of ['userData','sessionData','cache','temp','logs','crashDumps'])
  app.setPath(key, path.join(__dirname, 'electron-' + key))
const result = {ratio: ${ratio}, cases: []}
const timeout = setTimeout(() => app.exit(2), 90000)
app.whenReady().then(async () => {
  const server = require('node:http').createServer((req, res) => {
    const name = {'/':'probe.html','/probe.js':'probe.js','/probe.css':'probe.css'}[req.url]
    if (!name) {res.writeHead(404); res.end(); return}
    res.setHeader('Content-Type', name.endsWith('.css') ? 'text/css' : name.endsWith('.js') ? 'text/javascript' : 'text/html')
    res.end(fs.readFileSync(path.join(__dirname, name)))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const win = new BrowserWindow({width: 1280, height: 900, frame: false, show: false,
    webPreferences: {contextIsolation: true, sandbox: true, backgroundThrottling: false}})
  await win.loadURL('http://127.0.0.1:' + server.address().port + '/')
  for (const [width, height] of [[1280,900],[900,520],[900,220]]) {
    win.setContentSize(width,height)
    result.cases.push(await win.webContents.executeJavaScript('edgeProbe.run()', true))
  }
  result.passed = true
}).catch(error => {result.error = String(error.stack || error)}).finally(() => {
  clearTimeout(timeout)
  fs.writeFileSync(path.join(__dirname, 'result.json'), JSON.stringify(result, null, 2))
  app.exit(result.passed ? 0 : 1)
})
`)
const env = {...process.env, ORGTREE_DATA: path.join(root, 'data'), HOME: path.join(root, 'home')}
delete env.ELECTRON_RUN_AS_NODE
const outcome = spawnSync(createRequire(import.meta.url)('electron'), [main], {
  env, encoding: 'utf8', timeout: 100000, windowsHide: true})
console.log(root)
const resultFile = path.join(root, 'result.json')
const result = fs.existsSync(resultFile) ? JSON.parse(fs.readFileSync(resultFile, 'utf8')) : {error: outcome.stderr}
console.log(JSON.stringify({...result, cases: result.cases?.map(c => ({width:c.width,height:c.height,measurements:c.measured.length}))}, null, 2))
process.exitCode = outcome.status ?? 1
