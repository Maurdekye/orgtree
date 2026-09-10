import { app, BrowserWindow, ipcMain } from 'electron'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'

/** Measure wrapping, right alignment, full badge hit areas and fixed native
 * controls in production CSS, before and after the update notice disappears. */
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
    const bar = document.getElementById('native')
    const flow = bar.querySelector('.native-header-main')
    const box = el => {const r = el.getBoundingClientRect(); return {top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height}}
    const wc = box(bar.querySelector('.window-controls'))
    const badgeVisible = [...bar.querySelectorAll('.eye-count')].every(b => {
      const r = b.getBoundingClientRect()
      return r.top >= 0 && [r.top + 1, r.bottom - 1].every(y =>
        b.contains(document.elementFromPoint(r.left + r.width / 2, y)))
    })
    return {wc, flow:box(flow), first:box(bar.querySelector('h2')),
      last:box(document.getElementById('last-action')), spacer:box(document.getElementById('spacer')),
      badgeVisible, overflow:['auto','scroll'].includes(getComputedStyle(flow).overflowX),
      right:document.documentElement.clientWidth - parseFloat(getComputedStyle(document.querySelector('main')).paddingRight),
      barTop:bar.getBoundingClientRect().top}
  })()`
  for (const width of [560, 640, 760, 900, 1400, 2048]) {
    window.setSize(width, 700)
    await waitFor(`Math.abs(window.innerWidth - ${width}) < 2`)
    await new Promise(r => setTimeout(r, 80))
    for (const notice of [true, false]) {
      await window.webContents.executeJavaScript(`document.querySelector('.update-notice').style.display = '${notice ? '' : 'none'}'`)
      const m = await window.webContents.executeJavaScript(measure)
      assert.ok(Math.abs(m.wc.right - m.right) <= 1, `controls right anchored: ${JSON.stringify(m)}`)
      assert.ok(Math.abs(m.wc.top - m.barTop) <= 1, `controls stay at top through wrapping: ${JSON.stringify(m)}`)
      assert.equal(m.overflow, false, `content must wrap, not scroll at ${width}: ${JSON.stringify(m)}`)
      assert.equal(m.badgeVisible, true, `entire badge hit area visible at ${width}: ${JSON.stringify(m)}`)
      if (width <= 760) assert.ok(m.last.top > m.first.bottom, `narrow header actually wraps at ${width}`)
      if (width >= 1400) {
        assert.ok(m.spacer.width > 100, `wide header restores flexible separation: ${JSON.stringify(m)}`)
        assert.ok(Math.abs(m.last.right - m.flow.right) <= 1, 'ordinary actions finish at the right edge')
      }
    }
  }
  console.log('HEADER_WRAP_NATIVE_PASS wrap/alignment/badges/controls with and without notice at six widths')
  window.destroy(); server.close(); app.exit(0)
}).catch(error => { console.error(error); for (const w of BrowserWindow.getAllWindows()) w.destroy(); app.exit(1) })
setTimeout(() => { console.error('Header wrap native probe timed out'); app.exit(1) }, 60000).unref()
