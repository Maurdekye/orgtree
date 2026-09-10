import { app, BrowserWindow, ipcMain } from 'electron'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'

/** Real rendered GEOMETRY check for the native header's window controls
 * (user report, installed alpha.6: the frame-replacement buttons wrapped to
 * a second row). Production styles.css + the real WindowControls component
 * in a real frameless window, measured by bounding rects across widths —
 * with a browser-style header beside it as the POSITIVE CONTROL: that one
 * wraps by design, proving the detector can actually report a wrap. */
const root = process.env.ORGTREE_HEADER_TEST_ROOT!
app.disableHardwareAcceleration()
app.setPath('userData', path.join(root, 'profile'))
let server: http.Server
app.whenReady().then(async () => {
  ipcMain.handle('desktop:window-controls-state',
    () => ({ visible: true, restoreWindows: false, minimized: false, maximized: false }))
  ipcMain.handle('desktop:preferences', () => ({}))
  server = http.createServer((req, res) => {
    if (req.url === '/fixture.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(fs.readFileSync(path.join(root, 'fixture.js'))); return }
    if (req.url === '/fixture.css') { res.setHeader('Content-Type', 'text/css'); res.end(fs.readFileSync(path.join(root, 'fixture.css'))); return }
    res.setHeader('Content-Type', 'text/html')
    res.end('<link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script>')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`
  const window = new BrowserWindow({ show: false, width: 1000, height: 700, frame: false, autoHideMenuBar: true,
    webPreferences: { preload: path.join(root, 'preload.cjs'), additionalArguments: [`--orgtree-ui-origin=${origin}`],
      sandbox: true, nodeIntegration: false, contextIsolation: true } })
  window.webContents.on('console-message', event => console.log('renderer', event.message))
  await window.loadURL(origin)
  const waitFor = async (code: string) => {
    for (let i = 0; i < 200; i++) { if (await window.webContents.executeJavaScript(code)) return; await new Promise(r => setTimeout(r, 25)) }
    throw Error(`Timed out ${code}`)
  }
  await waitFor(`document.querySelectorAll('#native .window-control').length === 4`)
  const measure = `(() => {
    const rowCheck = (id) => {
      const bar = document.getElementById(id)
      const h2 = bar.querySelector('h2')
      const wc = bar.querySelector('.window-controls')
      const hb = h2.getBoundingClientRect(), wb = wc.getBoundingClientRect()
      const cy = (wb.top + wb.bottom) / 2
      return { sameRow: cy >= hb.top && cy <= hb.bottom,
               visible: wb.width > 1 && wb.right <= innerWidth + 0.5 && wb.left >= 0,
               buttons: wc.querySelectorAll('.window-control').length,
               wcTop: wb.top, wcRight: wb.right,
               h2Top: hb.top, h2Bottom: hb.bottom, inner: innerWidth }
    }
    return { native: rowCheck('native'), browser: rowCheck('browser') }
  })()`
  // widths straddle the OLD media band (600–780) where the fix used to
  // stop: the wrap reproduced at >780 before this change
  for (const width of [560, 640, 700, 760, 900, 1000, 1400]) {
    window.setSize(width, 700)
    await waitFor(`Math.abs(window.innerWidth - ${width}) < 2`)
    await new Promise(r => setTimeout(r, 80))
    const m = await window.webContents.executeJavaScript(measure)
    assert.equal(m.native.buttons, 4, `native controls all present at ${width}`)
    assert.equal(m.native.sameRow, true,
      `native window controls stay on the first row at ${width}: ${JSON.stringify(m.native)}`)
    assert.equal(m.native.visible, true,
      `native window controls visible and unclipped at ${width}: ${JSON.stringify(m.native)}`)
    // positive control: the browser-style header (wrap by design) DOES
    // wrap under the same content pressure — the detector can fail
    if (width <= 900) assert.equal(m.browser.sameRow, false,
      `positive control: browser header wraps at ${width}: ${JSON.stringify(m.browser)}`)
  }
  console.log('HEADER_WRAP_NATIVE_PASS ' + JSON.stringify({
    widths: [560, 640, 700, 760, 900, 1000, 1400],
    control: 'browser-style header wrap detected at <=900',
  }))
  window.destroy(); server.close(); app.exit(0)
}).catch(error => { console.error(error); for (const w of BrowserWindow.getAllWindows()) w.destroy(); app.exit(1) })
setTimeout(() => { console.error('Header wrap native probe timed out'); app.exit(1) }, 60000).unref()
