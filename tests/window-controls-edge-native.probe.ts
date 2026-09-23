import { app, BrowserWindow, ipcMain } from 'electron'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { holdingPageHtml } from '../apps/desktop/main/window-load-recovery'

/** Probe verifying window controls sit flush against the top and right edges,
 *  allowing fast mouse flicks to land on the close button in the top-right corner
 *  and controls to be reachable along the absolute top edge with zero dead gaps.
 *  Tested in real frameless BrowserWindow across restored and maximized states. */
const root = process.env.ORGTREE_EDGE_TEST_ROOT!
app.disableHardwareAcceleration()
app.setPath('userData', path.join(root, 'profile'))

let server: http.Server

app.whenReady().then(async () => {
  const calls: string[] = []
  ipcMain.handle('desktop:window-controls-state', () => ({ visible: true, restoreWindows: false, minimized: false, maximized: false }))
  ipcMain.handle('desktop:window-minimize', () => { calls.push('minimize') })
  ipcMain.handle('desktop:window-toggle-maximize', () => { calls.push('toggle-maximize') })
  ipcMain.handle('desktop:window-close', () => { calls.push('close') })
  ipcMain.handle('desktop:window-refresh', () => { calls.push('refresh') })
  ipcMain.handle('desktop:preferences', () => ({}))

  server = http.createServer((req, res) => {
    if (req.url === '/fixture.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(fs.readFileSync(path.join(root, 'fixture.js'))); return }
    if (req.url === '/fixture.css') { res.setHeader('Content-Type', 'text/css'); res.end(fs.readFileSync(path.join(root, 'fixture.css'))); return }
    res.setHeader('Content-Type', 'text/html')
    res.end('<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`

  const window = new BrowserWindow({
    show: false, width: 1000, height: 700, frame: false, resizable: true, autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(root, 'preload.cjs'),
      additionalArguments: [`--orgtree-ui-origin=${origin}`],
      sandbox: true, nodeIntegration: false, contextIsolation: true,
    },
  })

  await window.loadURL(origin)

  const waitFor = async (code: string) => {
    for (let i = 0; i < 200; i++) {
      if (await window.webContents.executeJavaScript(code)) return
      await new Promise(r => setTimeout(r, 25))
    }
    throw Error(`Timed out waiting for: ${code}`)
  }

  await waitFor(`document.querySelectorAll('.window-control').length >= 4`)

  // Function to evaluate element hit-testing at point (x, y)
  const hitTestScript = `((x, y) => {
    const el = document.elementFromPoint(x, y)
    if (!el) return { found: false, tag: null, className: '', ariaLabel: '', region: 'none' }
    const btn = el.closest('button, [role="button"]') || el
    const region = getComputedStyle(el).getPropertyValue('-webkit-app-region').trim()
    return {
      found: true,
      tag: el.tagName.toLowerCase(),
      btnTag: btn.tagName.toLowerCase(),
      className: el.className || '',
      btnClass: btn.className || '',
      ariaLabel: btn.getAttribute('aria-label') || '',
      region,
    }
  })`

  const verifyEdgeHitTargets = async (stateLabel: string) => {
    const clientWidth = await window.webContents.executeJavaScript(`document.documentElement.clientWidth`) as number

    // 1. Hit test at absolute top-right corner (clientWidth - 1, 0)
    const corner = await window.webContents.executeJavaScript(`${hitTestScript}(${clientWidth - 1}, 0)`)
    assert.ok(corner.found, `[${stateLabel}] element found at top-right corner (${clientWidth - 1}, 0)`)
    assert.equal(corner.ariaLabel, 'Close window', `[${stateLabel}] top-right corner must be Close window, got: ${JSON.stringify(corner)}`)
    assert.equal(corner.region, 'no-drag', `[${stateLabel}] top-right corner must be no-drag to be clickable, got: ${corner.region}`)

    // 2. Hit test along absolute top edge (y = 0) across all 4 controls with zero dead gaps
    // Close button range: [clientWidth - 46, clientWidth - 1]
    const closeMid = await window.webContents.executeJavaScript(`${hitTestScript}(${clientWidth - 23}, 0)`)
    assert.equal(closeMid.ariaLabel, 'Close window', `[${stateLabel}] close mid hit target`)
    assert.equal(closeMid.region, 'no-drag')

    // Maximize/Restore button range: [clientWidth - 92, clientWidth - 47]
    const maxEdge = await window.webContents.executeJavaScript(`${hitTestScript}(${clientWidth - 47}, 0)`)
    assert.match(maxEdge.ariaLabel, /Maximize window|Restore window/, `[${stateLabel}] immediately adjacent to close without dead gap`)
    assert.equal(maxEdge.region, 'no-drag')

    const maxMid = await window.webContents.executeJavaScript(`${hitTestScript}(${clientWidth - 69}, 0)`)
    assert.match(maxMid.ariaLabel, /Maximize window|Restore window/, `[${stateLabel}] maximize mid hit target`)
    assert.equal(maxMid.region, 'no-drag')

    // Minimize button range: [clientWidth - 138, clientWidth - 93]
    const minEdge = await window.webContents.executeJavaScript(`${hitTestScript}(${clientWidth - 93}, 0)`)
    assert.equal(minEdge.ariaLabel, 'Minimize window', `[${stateLabel}] immediately adjacent to maximize without dead gap`)
    assert.equal(minEdge.region, 'no-drag')

    const minMid = await window.webContents.executeJavaScript(`${hitTestScript}(${clientWidth - 115}, 0)`)
    assert.equal(minMid.ariaLabel, 'Minimize window', `[${stateLabel}] minimize mid hit target`)
    assert.equal(minMid.region, 'no-drag')

    // Refresh button range: [clientWidth - 184, clientWidth - 139]
    const refreshEdge = await window.webContents.executeJavaScript(`${hitTestScript}(${clientWidth - 139}, 0)`)
    assert.equal(refreshEdge.ariaLabel, 'Refresh app view', `[${stateLabel}] immediately adjacent to minimize without dead gap`)
    assert.equal(refreshEdge.region, 'no-drag')

    // 3. To the left of controls: draggable title-bar region preserved
    const headerDrag = await window.webContents.executeJavaScript(`${hitTestScript}(50, 0)`)
    assert.equal(headerDrag.region, 'drag', `[${stateLabel}] title-bar dragging preserved outside window controls`)
  }

  // Test across multiple window widths in restored state
  for (const width of [800, 1100, 1400]) {
    window.setSize(width, 700)
    await waitFor(`Math.abs(window.innerWidth - ${width}) < 2`)
    await new Promise(r => setTimeout(r, 60))
    await verifyEdgeHitTargets(`restored width=${width}`)
  }

  // Test in maximized state
  const maximizing = new Promise<void>(resolve => window.once('maximize', resolve))
  window.maximize()
  await maximizing
  await new Promise(r => setTimeout(r, 80))
  assert.equal(window.isMaximized(), true)
  await verifyEdgeHitTargets('maximized window')

  // Unmaximize and verify
  const unmaximizing = new Promise<void>(resolve => window.once('unmaximize', resolve))
  window.unmaximize()
  await unmaximizing
  await new Promise(r => setTimeout(r, 80))
  assert.equal(window.isMaximized(), false)

  // 4. Test clicking close button activates close
  await window.webContents.executeJavaScript(`document.querySelector('[aria-label="Close window"]').click()`)
  await new Promise(r => setTimeout(r, 50))
  assert.ok(calls.includes('close'), 'close control activates close IPC')

  // 5. Test holding page HTML hit testing and geometry
  const holdingHtml = holdingPageHtml('errorCode=-102 ERR_CONNECTION_REFUSED url=http://127.0.0.1:21350/o/orgtree')
  await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(holdingHtml))
  await waitFor(`document.querySelectorAll('.window-control').length === 4`)

  const holdingClientWidth = await window.webContents.executeJavaScript(`document.documentElement.clientWidth`) as number
  const holdingCorner = await window.webContents.executeJavaScript(`${hitTestScript}(${holdingClientWidth - 1}, 0)`)
  assert.equal(holdingCorner.ariaLabel, 'Close window', 'holding page top-right corner hits close control')
  assert.equal(holdingCorner.region, 'no-drag', 'holding page close control is no-drag')

  const holdingMaxEdge = await window.webContents.executeJavaScript(`${hitTestScript}(${holdingClientWidth - 47}, 0)`)
  assert.match(holdingMaxEdge.ariaLabel, /Maximize window|Restore window/, 'holding page maximize adjacent to close')

  // 6. Deliberate mutation proof: inset controls must fail the top-right corner assertion
  await window.webContents.executeJavaScript(`
    document.querySelector('.orgbar').style.paddingTop = '10px';
    document.querySelector('.orgbar').style.paddingRight = '18px';
  `)
  const mutatedCorner = await window.webContents.executeJavaScript(`${hitTestScript}(${holdingClientWidth - 1}, 0)`)
  assert.notEqual(mutatedCorner.ariaLabel, 'Close window', 'MUTATION PROOF: inset header causes top-right corner to miss close button')
  assert.equal(mutatedCorner.region, 'drag', 'MUTATION PROOF: inset header exposes draggable region at corner instead of close control')

  console.log('WINDOW_CONTROLS_EDGE_NATIVE_PASS corner hit-test, edge-to-edge top reach, zero dead gaps, drag preservation across restored/maximized states, and mutation proof')
  window.destroy()
  server.close()
  app.exit(0)
}).catch(error => {
  console.error(error)
  for (const w of BrowserWindow.getAllWindows()) w.destroy()
  app.exit(1)
})

setTimeout(() => {
  console.error('Window controls edge native probe timed out')
  app.exit(1)
}, 60000).unref()
