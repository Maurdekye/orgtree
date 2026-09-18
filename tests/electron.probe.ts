import { app, BrowserWindow, clipboard, ipcMain, session, Menu } from 'electron'
import http from 'node:http'
import crypto from 'node:crypto'
import path from 'node:path'
import fs from 'node:fs'
import assert from 'node:assert/strict'
import { refreshTrayUpdateMenu } from '../apps/desktop/main/updater'
import { refreshTrayEngineMenu } from '../apps/desktop/main/engine'
import { editMenuTemplate } from '../apps/desktop/main/editmenu'
import { assertNativeSender, configureArtifactSession, configureEngineSession, configureWindow } from '../apps/desktop/main/windows'

app.setPath('userData', process.env.ORGTREE_ELECTRON_TEST_ROOT!)
const seen: { url: string; token?: string }[] = [], foreign: (string | undefined)[] = [], openedExternal: string[] = []
const token = crypto.randomBytes(32).toString('hex')
let server: http.Server, outsider: http.Server
app.whenReady().then(async () => {
  const updateMenu = Menu.buildFromTemplate([
    { id: 'update-status', label: 'initial', enabled: false },
    { id: 'update-install', label: 'Update now', visible: false },
    { id: 'update-check', label: 'Check for updates' },
  ])
  const statusItem = updateMenu.getMenuItemById('update-status')!
  refreshTrayUpdateMenu(updateMenu, { state: 'downloading', version: '2.0.3', percent: 37 }, false, false)
  assert.match(statusItem.label, /37%/)
  assert.equal(updateMenu.getMenuItemById('update-install')!.visible, false)
  refreshTrayUpdateMenu(updateMenu, { state: 'pending-idle', version: '2.0.3' }, true, false)
  assert.equal(updateMenu.getMenuItemById('update-status'), statusItem)
  assert.match(statusItem.label, /ready to install/)
  assert.equal(updateMenu.getMenuItemById('update-install')!.visible, true)
  assert.equal(updateMenu.getMenuItemById('update-install')!.enabled, true)
  // A PREPARED UPDATE NO LONGER DISABLES CHECKING (user 2026-09-11, updater.ts
  // `trayUpdateState`): being able to replace it with a newer release is the
  // point. This probe still asserted the old rule and so aborted before
  // anything below it ever ran.
  assert.equal(updateMenu.getMenuItemById('update-check')!.enabled, true)

  // The engine row, through REAL Electron menu items - `visible` and `enabled`
  // on a native MenuItem are the properties the whole rule rests on, and a
  // hand-written double cannot prove Electron accepts them.
  //
  // USER RULING 2026-09-17, superseding 2026-09-15: the row is ALWAYS VISIBLE,
  // in every engine state, and communicates availability by being enabled or
  // greyed rather than by appearing and disappearing. It used to be hidden
  // while the engine was healthy, which is the case the user most wants it in.
  //
  // The seed below is deliberately `visible: false`: it is the WORST case for
  // the assertion that follows, since Electron must be seen to turn a hidden
  // native item back on. (index.ts now seeds it `visible: true`; that seed is
  // asserted at source level in tests/engine-restart.test.mjs.)
  const engineMenu = Menu.buildFromTemplate([
    { id: 'engine-restart', label: 'Restart engine', visible: false, enabled: false },
    { label: 'Quit Orgtree' },
  ])
  const restartItem = engineMenu.getMenuItemById('engine-restart')!
  assert.equal(restartItem.visible, false, 'the native item really did start hidden')
  refreshTrayEngineMenu(engineMenu, { state: 'ready' }, false, false)
  assert.equal(restartItem.visible, true, 'a HEALTHY engine still shows the restart row')
  assert.equal(restartItem.enabled, true, 'and it is clickable — the case the user asked to reach')
  assert.equal(restartItem.label, 'Restart engine')
  refreshTrayEngineMenu(engineMenu, { state: 'stopped', message: 'Engine exited.' }, false, false)
  assert.equal(restartItem.visible, true, 'a stopped engine shows the restart row')
  assert.equal(restartItem.enabled, true)
  assert.equal(restartItem.label, 'Restart engine')
  refreshTrayEngineMenu(engineMenu, { state: 'starting' }, false, false)
  assert.equal(restartItem.visible, true, 'boot shows the row too')
  refreshTrayEngineMenu(engineMenu, { state: 'starting' }, true, false)
  assert.equal(engineMenu.getMenuItemById('engine-restart'), restartItem, 'the row is refreshed in place')
  assert.equal(restartItem.visible, true, 'a restart in flight keeps its row on screen')
  assert.equal(restartItem.enabled, false, 'a restart in flight cannot be clicked again')
  assert.match(restartItem.label, /Restarting engine/)
  // A quit, an update install or an installer upgrade greys it WITHOUT hiding
  // it — including over a healthy engine, which is the new normal case.
  refreshTrayEngineMenu(engineMenu, { state: 'ready' }, false, true)
  assert.equal(restartItem.visible, true, 'a blocked shutdown greys the row in place')
  assert.equal(restartItem.enabled, false)
  // A failed restart lands here, and must still offer the user a retry.
  refreshTrayEngineMenu(engineMenu, { state: 'unavailable', message: 'port in use' }, false, false)
  assert.equal(restartItem.visible, true)
  assert.equal(restartItem.enabled, true)
  // The whole matrix through the NATIVE item: no state hides it, and
  // enablement is exactly "a restart can be run".
  for (const state of ['ready', 'starting', 'stopped', 'unavailable'] as const) {
    for (const restarting of [true, false]) for (const blocked of [true, false]) {
      refreshTrayEngineMenu(engineMenu, { state }, restarting, blocked)
      assert.equal(restartItem.visible, true, `hidden at ${state}/${restarting}/${blocked}`)
      assert.equal(restartItem.enabled, !restarting && !blocked, `wrong enablement at ${state}/${restarting}/${blocked}`)
    }
  }

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
  // Live getters, as production wires them since boot-engine recovery: every
  // existing assertion below now also proves the getter path signs requests.
  let liveToken = token
  const register = configureEngineSession(ses, () => origin, () => liveToken)
  const options = { show: false, webPreferences: { session: ses, preload: path.resolve('dist/preload/index.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, additionalArguments: [`--orgtree-ui-origin=${origin}`] } }
  const main = new BrowserWindow(options)
  configureWindow(main, () => origin, true, register, undefined, url => { openedExternal.push(url) })
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
  // Exercise the renderer-only Refresh action that the native header now owns.
  // The callback is intentionally injected as a plain location.reload() so this
  // probe proves a real renderer click does not route through the external-open
  // callback or launch a browser while the document reloads.
  assert.equal(openedExternal.length, 0, 'refresh starts with no external-browser opens')
  const refreshed = new Promise<void>(resolve => main.webContents.once('did-finish-load', () => resolve()))
  await main.webContents.executeJavaScript(`(()=>{const b=document.createElement('button');b.id='probe-refresh';b.onclick=()=>window.location.reload();document.body.appendChild(b);b.click();return true})()`)
  await refreshed
  assert.equal(openedExternal.length, 0, 'renderer Refresh reload does not invoke external browser')
  assert.ok(seen.filter(r => r.url === '/o/test-org' && r.token === token).length >= 2, 'renderer Refresh performs an authenticated reload')
  const externalBeforeRefreshFollowup = openedExternal.length
  await main.webContents.executeJavaScript(`(()=>{const a=document.createElement('a');a.href=${JSON.stringify(foreignOrigin + '/refresh-followup')};document.body.appendChild(a);a.click();return true})()`)
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(openedExternal.length, externalBeforeRefreshFollowup + 1, 'genuine external click increments controlled browser opens')
  assert.ok(openedExternal.includes(foreignOrigin + '/refresh-followup'), 'genuine external click reaches controlled browser callback')
  // Boot-engine recovery rotates the per-boot token: the session hook must
  // sign with the CURRENT value, not the one captured at configure time.
  const rotated = crypto.randomBytes(32).toString('hex')
  liveToken = rotated
  await main.webContents.executeJavaScript("fetch('/api/rotated').then(r=>r.text())")
  assert.ok(seen.some(r => r.url === '/api/rotated' && r.token === rotated), 'live getter signs with the rotated token')
  assert.ok(!seen.some(r => r.url === '/api/rotated' && r.token === token), 'the stale token is not used after rotation')
  liveToken = token
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
  child.show()
  const visibility = async () => ({ visible: child.isVisible(), value: await child.webContents.executeJavaScript(`Promise.race([new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve({visibility:document.visibilityState,raf:true})))),new Promise(resolve=>setTimeout(()=>resolve({visibility:document.visibilityState,raf:false}),1500))])`) })
  assert.equal((await visibility()).value.raf, true, 'visible adopted portal must receive animation frames')
  child.hide()
  assert.equal(child.webContents.getBackgroundThrottling(), true, 'hidden portal restores throttling')
  child.show()
  assert.equal(child.webContents.getBackgroundThrottling(), false, 'visible portal disables stale hidden-document throttling')
  child.hide(); child.show()
  assert.equal((await visibility()).value.raf, true, 'show resumes frames after hiding')
  const minimized = new Promise<void>(resolve => child.once('minimize', () => resolve()))
  child.minimize(); await minimized
  assert.equal(child.webContents.getBackgroundThrottling(), true, 'minimized portal restores throttling')
  const restored = new Promise<void>(resolve => child.once('restore', () => resolve()))
  child.restore(); await restored
  assert.equal(child.webContents.getBackgroundThrottling(), false, 'restored portal receives frames again')
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
  await child.webContents.executeJavaScript(`(()=>{const a=document.createElement('a');a.href=${JSON.stringify(foreignOrigin + '/popout')};a.target='_blank';document.body.appendChild(a);a.click();return true})()`)
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.ok(openedExternal.includes(foreignOrigin + '/popout'), 'registered popout external link launches through the controlled browser callback')
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
  const externalCountBeforeInternal = openedExternal.length
  const internalObjectUrl = origin + '/o/internal-agent'
  const internalArtifactUrl = origin + '/api/orgs/test/documents/sample/mockup'
  assert.equal(await main.webContents.executeJavaScript(`window.open(${JSON.stringify(internalObjectUrl)}) === null`), true)
  assert.equal(await main.webContents.executeJavaScript(`window.open(${JSON.stringify(internalArtifactUrl)}) === null`), true)
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(openedExternal.length, externalCountBeforeInternal, 'internal app and artifact links never launch the external browser')
  assert.equal(await main.webContents.executeJavaScript(`window.open(${JSON.stringify(foreignOrigin)}) === null`), true)
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.ok(openedExternal.some(url => url === foreignOrigin || url === foreignOrigin + '/'), 'target blank external link launches through the controlled browser callback')
  await main.webContents.executeJavaScript(`(()=>{const a=document.createElement('a');a.href=${JSON.stringify(foreignOrigin + '/same-tab')};document.body.appendChild(a);a.click();return true})()`)
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.ok(openedExternal.includes(foreignOrigin + '/same-tab'), 'same-tab external navigation launches through the controlled browser callback')
  assert.equal(await main.webContents.executeJavaScript('location.origin'), origin, 'external navigation is prevented in the app window')
  // ── CUT/COPY/PASTE IN A TEXT FIELD ───────────────────────────────────────
  // ticket right-click-cut-copy-paste-in-every-textbox-in-t. The RULES are
  // tested without Electron in tests/edit-menu.test.mjs. What only real
  // Chromium can settle is here, and none of it is simulated: a right-click on
  // a real input raises the event, Chromium's own editFlags gate the entries,
  // and choosing Paste puts actual characters into the actual field.
  assert.equal(main.webContents.listenerCount('context-menu'), 1, 'configureWindow gave the app window its editing menu')
  const raised: Electron.ContextMenuParams[] = []
  main.webContents.on('context-menu', (_event, params) => raised.push(params))
  const rightClickField = async (prepare = '') => {
    const box = await main.webContents.executeJavaScript(`(() => {
      const el = document.getElementById('draft'); el.focus(); ${prepare}
      const r = el.getBoundingClientRect()
      return { x: Math.round(r.left + 4), y: Math.round(r.top + r.height / 2) } })()`)
    const before = raised.length
    for (const type of ['mouseDown', 'mouseUp'] as const) {
      main.webContents.sendInputEvent({ type, button: 'right', x: box.x, y: box.y, clickCount: 1 })
    }
    for (let i = 0; i < 100 && raised.length === before; i++) await new Promise(resolve => setTimeout(resolve, 20))
    assert.ok(raised.length > before, 'a right-click in the field raised the context-menu event')
    // the same template the app's own handler built from these very params
    return Menu.buildFromTemplate(editMenuTemplate(raised[raised.length - 1], main.webContents)!)
  }
  const entry = (menu: Menu, label: string) => menu.items.find(candidate => candidate.label === label)!

  // AN EMPTY FIELD AND AN EMPTY CLIPBOARD — the gates, through real MenuItems.
  clipboard.clear()
  const emptyMenu = await rightClickField("el.value = ''")
  assert.deepEqual(emptyMenu.items.filter(i => i.type !== 'separator').map(i => i.label),
    ['Cut', 'Copy', 'Paste', 'Select All'], 'a text field offers all four')
  assert.equal(entry(emptyMenu, 'Paste').enabled, false, 'an empty clipboard really disables Paste')
  assert.equal(entry(emptyMenu, 'Select All').enabled, false, 'an empty field really disables Select All')
  assert.equal(entry(emptyMenu, 'Copy').enabled, false, 'no selection really disables Copy')
  // and the real popup call is well formed on a real window
  emptyMenu.popup({ window: main, x: 10, y: 10 })
  emptyMenu.closePopup(main)

  // PASTE, END TO END. Not "the item was enabled" — the characters arrive.
  clipboard.writeText('pasted through the menu')
  const pasteMenu = await rightClickField()
  assert.equal(entry(pasteMenu, 'Paste').enabled, true, 'a clipboard with text really enables Paste')
  entry(pasteMenu, 'Paste').click!()
  for (let i = 0; i < 100; i++) {
    if (await main.webContents.executeJavaScript('document.getElementById("draft").value') === 'pasted through the menu') break
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.equal(await main.webContents.executeJavaScript('document.getElementById("draft").value'),
    'pasted through the menu', 'choosing Paste put the clipboard text into the field')

  // CUT, END TO END: the characters leave the field and reach the clipboard.
  const cutMenu = await rightClickField('el.setSelectionRange(0, 6)')
  assert.equal(entry(cutMenu, 'Cut').enabled, true, 'a selection really enables Cut')
  assert.equal(entry(cutMenu, 'Copy').enabled, true, 'a selection really enables Copy')
  entry(cutMenu, 'Cut').click!()
  // ⚠ MEASURED, and it contradicts the shipped typings: in Electron 44
  // `clipboard.readText()` returns a PROMISE, though @types says `string`. An
  // unawaited call compares a pending Promise against text and is never equal,
  // which reads as "Cut did nothing" — it is the assertion that is broken, not
  // the menu. `writeText` and `clear` are still synchronous.
  const clipboardText = async () => await (clipboard.readText() as unknown as string | Promise<string>)
  for (let i = 0; i < 100 && await clipboardText() !== 'pasted'; i++) await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(await clipboardText(), 'pasted', 'choosing Cut put the selected text on the clipboard')
  assert.equal(await main.webContents.executeJavaScript('document.getElementById("draft").value'),
    ' through the menu', 'and removed it from the field')

  // SELECT ALL, END TO END.
  const selectMenu = await rightClickField()
  assert.equal(entry(selectMenu, 'Select All').enabled, true, 'a filled field really enables Select All')
  const remaining = ' through the menu'                   // what Cut left behind
  assert.equal(await main.webContents.executeJavaScript('document.getElementById("draft").value'), remaining)
  entry(selectMenu, 'Select All').click!()
  const selection = async () => await main.webContents.executeJavaScript(
    '(()=>{const el=document.getElementById("draft");return [el.selectionStart, el.selectionEnd]})()') as [number, number]
  for (let i = 0; i < 100 && (await selection())[1] !== remaining.length; i++) await new Promise(resolve => setTimeout(resolve, 20))
  assert.deepEqual(await selection(), [0, remaining.length], 'choosing Select All really selected the whole field')

  // KEYBOARD RAISE — Shift+F10, as real key input rather than a synthesised DOM
  // event (a synthetic `contextmenu` is untrusted and Chromium raises no menu
  // for it, so it would prove nothing).
  //
  // ⚠ THE ContextMenu KEY CANNOT BE DRIVEN FROM HERE, measured in Electron 44:
  // `sendInputEvent` accepts no keyCode that produces it — 'ContextMenu',
  // 'Apps' and 'Menu' all arrive in the page as a keydown with an EMPTY `key`
  // and raise nothing. What stands in for it is `menuSourceType`, asserted
  // below: Chromium reports 'keyboard' for BOTH keys, and this handler reads
  // only `params` and does no key handling at all, so it cannot tell them
  // apart. Assert the class, not the one key the harness happens to reach.
  await main.webContents.executeJavaScript('document.getElementById("draft").focus()')
  const beforeKey = raised.length
  main.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'F10', modifiers: ['shift'] })
  main.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'F10', modifiers: ['shift'] })
  for (let i = 0; i < 100 && raised.length === beforeKey; i++) await new Promise(resolve => setTimeout(resolve, 20))
  assert.ok(raised.length > beforeKey, 'Shift+F10 raised the context-menu event')
  const keyParams = raised[raised.length - 1]
  assert.equal(keyParams.menuSourceType, 'keyboard', 'and Chromium reports it as a keyboard raise')
  const keyMenu = Menu.buildFromTemplate(editMenuTemplate(keyParams, main.webContents)!)
  assert.deepEqual(keyMenu.items.filter(i => i.type !== 'separator').map(i => i.label),
    ['Cut', 'Copy', 'Paste', 'Select All'], 'a keyboard raise produced the same menu as a right-click')
  clipboard.clear()

  console.log('ELECTRON_PROBE_PASS ' + JSON.stringify({ http: true, assets: true, websocket: true, redirectNoToken: true, portalIdentity: true, draftRetained: true, childNoBridge: true, foreignNativeCallerRefused: true, externalWindowRouted: true, externalNavigationRouted: true, foreignFrameBlocked: true, srcdocUnsigned: true, artifactPostBlocked: true, artifactInternetAllowed: true, preloadExactPort: true, orgHistoryAndReload: true, liveTokenRotation: true, engineRestartRow: true, editMenuPasteLanded: true, editMenuKeyboardRaise: 'shift+f10' }))
  for (const w of BrowserWindow.getAllWindows()) w.destroy()
  server.close(); outsider.close(); app.exit(0)
}).catch(error => { console.error(error); for (const w of BrowserWindow.getAllWindows()) w.destroy(); server?.close(); outsider?.close(); app.exit(1) })
