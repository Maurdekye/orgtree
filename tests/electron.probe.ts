import { app, BrowserWindow, ipcMain, session } from 'electron'
import http from 'node:http'
import crypto from 'node:crypto'
import path from 'node:path'
import fs from 'node:fs'
import assert from 'node:assert/strict'
import { assertNativeSender, configureArtifactSession, configureEngineSession, configureWindow } from '../apps/desktop/main/windows'

app.setPath('userData', process.env.ORGTREE_ELECTRON_TEST_ROOT!)
const seen: { url: string; token?: string }[] = [], foreign: (string | undefined)[] = []
const token = crypto.randomBytes(32).toString('hex')
let server: http.Server, outsider: http.Server
app.whenReady().then(async () => {
  outsider = http.createServer((req, res) => { foreign.push(req.headers['x-orgtree-desktop-token'] as string | undefined); res.setHeader('Access-Control-Allow-Origin', '*'); res.end('outside') })
  await new Promise<void>(resolve => outsider.listen(0, '127.0.0.1', resolve))
  const foreignOrigin = `http://127.0.0.1:${(outsider.address() as import('node:net').AddressInfo).port}`
  server = http.createServer((req, res) => {
    seen.push({ url: req.url!, token: req.headers['x-orgtree-desktop-token'] as string | undefined })
    if (req.url === '/redirect') { res.writeHead(302, { Location: foreignOrigin }); res.end(); return }
    if (req.url?.startsWith('/asset.css')) { res.setHeader('Content-Type', 'text/css'); res.end('body{background:rgb(12,34,56)}'); return }
    if (req.url === '/api/read') { res.setHeader('Content-Type', 'application/json'); res.end('{"ok":true}'); return }
    if (req.url === '/api/orgs/test/documents/sample/mockup') {
      res.setHeader('Content-Type', 'text/html')
      // Captured by executing only v1 api._mockup_wrapper AST, no storage imports.
      res.end(fs.readFileSync('tests/fixtures/mockup-wrapper.html', 'utf8').replaceAll('__ENGINE__', origin).replaceAll('__FOREIGN__', foreignOrigin))
      return
    }
    res.setHeader('Content-Type', 'text/html')
    res.end('<!doctype html><link rel="stylesheet" href="/asset.css"><body><input id="draft" value="retained answer"><div id="mount"></div></body>')
  })
  server.on('upgrade', (req, socket) => {
    seen.push({ url: 'WS', token: req.headers['x-orgtree-desktop-token'] as string | undefined })
    const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n')
    setTimeout(() => socket.end(), 100)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`
  const ses = session.fromPartition('shell-fixture')
  const register = configureEngineSession(ses, origin, token)
  const options = { show: false, webPreferences: { session: ses, preload: path.resolve('dist/preload/index.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, additionalArguments: [`--orgtree-ui-origin=${origin}`] } }
  const main = new BrowserWindow(options)
  configureWindow(main, origin, true, register)
  ipcMain.handle('desktop:status', event => { assertNativeSender(event, main, origin); return { state: 'ready' } })
  await main.loadURL(origin)
  assert.deepEqual(await main.webContents.executeJavaScript('window.orgtreeDesktop.getStatus()'), { state: 'ready' })
  assert.equal(await main.webContents.executeJavaScript('typeof require'), 'undefined')
  assert.equal(await main.webContents.executeJavaScript('getComputedStyle(document.body).backgroundColor'), 'rgb(12, 34, 56)')
  await main.webContents.executeJavaScript(`(async()=>{await fetch('/api/read'); await fetch('/redirect'); await fetch(${JSON.stringify(foreignOrigin)}); await new Promise((resolve,reject)=>{ const ws=new WebSocket(${JSON.stringify(origin.replace('http:', 'ws:') + '/ws')}); ws.onopen=()=>{ws.close();resolve(true)};ws.onerror=reject }); })()`)
  for (const route of ['/', '/asset.css', '/api/read', '/redirect', 'WS']) assert.ok(seen.some(r => r.url === route && r.token === token), 'authenticated ' + route)
  await main.webContents.executeJavaScript("history.pushState(null, '', '/o/test-org'); true")
  assert.deepEqual(await main.webContents.executeJavaScript('window.orgtreeDesktop.getStatus()'), { state: 'ready' }, 'org history route retains native bridge')
  await main.webContents.executeJavaScript("fetch('/api/org-route').then(r=>r.text())")
  assert.ok(seen.some(r => r.url === '/api/org-route' && r.token === token), 'org history route retains authenticated HTTP')
  await main.loadURL(origin + '/o/test-org')
  assert.deepEqual(await main.webContents.executeJavaScript('window.orgtreeDesktop.getStatus()'), { state: 'ready' }, 'direct org reload exposes bridge')
  assert.ok(seen.some(r => r.url === '/o/test-org' && r.token === token), 'direct org reload authenticates document')
  assert.ok(foreign.length >= 2)
  assert.ok(foreign.every(t => t === undefined), 'token never follows cross-origin redirect or fetch')
  await main.webContents.executeJavaScript(`window.attack=document.createElement('iframe'); attack.src=${JSON.stringify(foreignOrigin + '/frame')}; document.body.appendChild(attack); true`)
  await new Promise(resolve => setTimeout(resolve, 150))
  assert.equal(foreign.length, 2, 'foreign iframe document is refused before loading')
  await main.webContents.executeJavaScript(`window.inline=document.createElement('iframe'); inline.sandbox='allow-scripts'; inline.srcdoc=${JSON.stringify(`<script>fetch('${origin}/api/inline-hostile',{method:'POST',mode:'no-cors'}).catch(()=>{});parent.postMessage('inline-ran','*')<\/script>`)}; window.inlineRan=false;window.addEventListener('message',e=>{if(e.data==='inline-ran')window.inlineRan=true}); document.body.appendChild(inline); true`)
  await new Promise(resolve => setTimeout(resolve, 150))
  assert.equal(await main.webContents.executeJavaScript('inlineRan'), true)
  assert.ok(seen.some(r => r.url === '/api/inline-hostile' && !r.token), 'same-origin srcdoc request executes but is unsigned')
  const childCreated = new Promise<BrowserWindow>(resolve => main.webContents.once('did-create-window', resolve))
  await main.webContents.executeJavaScript(`window.child=window.open('about:blank','owned-portal'); window.node=document.getElementById('draft'); child.document.body.appendChild(node); node.value='same live draft'; true`)
  const child = await childCreated
  assert.equal(await main.webContents.executeJavaScript('child.document.getElementById("draft") === node'), true)
  assert.equal(await main.webContents.executeJavaScript('child.document.getElementById("draft").value'), 'same live draft')
  assert.equal(await child.webContents.executeJavaScript('typeof window.orgtreeDesktop'), 'undefined')
  assert.equal(await child.webContents.executeJavaScript('typeof require'), 'undefined')
  await main.webContents.executeJavaScript(`new Promise((resolve,reject)=>{const css=child.document.createElement('link');css.rel='stylesheet';css.href=${JSON.stringify(origin + '/asset.css?portal=1')};css.onload=()=>resolve(true);css.onerror=reject;child.document.head.appendChild(css)})`)
  assert.equal(await child.webContents.executeJavaScript('getComputedStyle(document.body).backgroundColor'), 'rgb(12, 34, 56)', 'registered portal loads authenticated CSS')
  await child.webContents.executeJavaScript(`fetch(${JSON.stringify(origin + '/api/portal-fetch')}).then(r=>r.text())`)
  // Chromium attributes this same-origin adopted portal to the owning App frame.
  // A portal shares trusted owner authority; artifact sessions are the isolation boundary.
  assert.ok(seen.some(r => r.url === '/api/portal-fetch' && r.token === token))
  await main.webContents.executeJavaScript('document.body.appendChild(node); child.close(); true')
  assert.equal(await main.webContents.executeJavaScript('document.getElementById("draft").value'), 'same live draft')
  const impostor = new BrowserWindow(options)
  await impostor.loadURL(origin)
  assert.equal(await impostor.webContents.executeJavaScript('window.orgtreeDesktop.getStatus().then(()=>false,()=>true)'), true)
  await impostor.loadURL(foreignOrigin)
  assert.equal(await impostor.webContents.executeJavaScript('typeof window.orgtreeDesktop'), 'undefined', 'foreign loopback port never gets a preload bridge')
  const artifact = origin + '/api/orgs/test/documents/sample/mockup'
  const artifactSession = session.fromPartition('artifact-probe')
  configureArtifactSession(artifactSession, artifact, origin, token)
  const viewer = new BrowserWindow({ show: false, webPreferences: { session: artifactSession, sandbox: true, nodeIntegration: false, contextIsolation: true } })
  await viewer.loadURL(artifact)
  await new Promise(resolve => setTimeout(resolve, 200))
  assert.ok(seen.some(r => r.url === '/api/orgs/test/documents/sample/mockup' && r.token === token), 'actual presentation route has its one read capability')
  assert.ok(!seen.some(r => r.url === '/api/hostile'), 'artifact child engine POST refused before send')
  assert.ok(foreign.length > 2, 'artifact internet resource is permitted')
  assert.ok(foreign.every(t => !t), 'artifact internet resource never gets desktop auth')
  assert.equal(await viewer.webContents.executeJavaScript('typeof window.orgtreeDesktop'), 'undefined')
  assert.equal(await main.webContents.executeJavaScript(`window.open(${JSON.stringify(foreignOrigin)}) === null`), true)
  console.log('ELECTRON_PROBE_PASS ' + JSON.stringify({ http: true, assets: true, websocket: true, redirectNoToken: true, portalIdentity: true, draftRetained: true, childNoBridge: true, foreignNativeCallerRefused: true, externalWindowDenied: true, foreignFrameBlocked: true, srcdocUnsigned: true, artifactPostBlocked: true, artifactInternetAllowed: true, preloadExactPort: true, orgHistoryAndReload: true }))
  for (const w of BrowserWindow.getAllWindows()) w.destroy()
  server.close(); outsider.close(); app.exit(0)
}).catch(error => { console.error(error); for (const w of BrowserWindow.getAllWindows()) w.destroy(); server?.close(); outsider?.close(); app.exit(1) })
