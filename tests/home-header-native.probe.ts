import { app, BrowserWindow, ipcMain } from 'electron'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'

/** Home-page window-controls anchoring (user report 2026-09-10): on the
 * org-list home page the native frame replacement must sit at the WINDOW's
 * top-right corner while the welcome card stays centered. Real frameless
 * window, production styles.css, real WindowControls; a second card built
 * in the OLD shape (controls inside the card's h1) is the positive control
 * proving the detector can tell card-attached from corner-anchored. */
const root = process.env.ORGTREE_HOME_TEST_ROOT!
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
  await waitFor(`document.querySelectorAll('#home .window-control').length === 4`)
  const measure = `(() => {
    const box = (el) => { const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, top: r.top } }
    const home = document.getElementById('home')
    const wc = box(home.querySelector('.window-controls'))
    const card = box(document.getElementById('goodcard'))
    const bad = box(document.querySelector('#badcard .window-controls'))
    const badCard = box(document.getElementById('badcard'))
    // clientWidth, not innerWidth: the fixture's positive-control section
    // adds a scrollbar the real single-viewport home page does not have
    return { wc, card, bad, badCard, inner: document.documentElement.clientWidth,
             headerRegion: getComputedStyle(home).getPropertyValue('-webkit-app-region').trim(),
             buttons: home.querySelectorAll('.window-control').length }
  })()`
  for (const width of [700, 1000, 1400]) {
    window.setSize(width, 700)
    await waitFor(`Math.abs(window.innerWidth - ${width}) < 2`)
    await new Promise(r => setTimeout(r, 80))
    for (const notice of [true, false]) {
    await window.webContents.executeJavaScript(`document.querySelector('#home .update-notice').style.display = '${notice ? '' : 'none'}'`)
    const m = await window.webContents.executeJavaScript(measure)
    assert.equal(m.buttons, 4, `home header controls present at ${width}`)
    // corner-anchored: flush with the window's right edge and top
    assert.ok(m.wc.right >= m.inner - 4,
      `controls flush right at ${width}: ${JSON.stringify(m.wc)} inner=${m.inner}`)
    assert.ok(m.wc.top <= 8, `controls at the top edge at ${width}: ${JSON.stringify(m.wc)}`)
    // the card stays CENTERED and does not carry the controls
    const cardCenter = m.card.x + m.card.w / 2
    assert.ok(Math.abs(cardCenter - m.inner / 2) <= 2,
      `welcome card centered at ${width}: center ${cardCenter} vs ${m.inner / 2}`)
    const overlaps = m.wc.x < m.card.x + m.card.w && m.wc.right > m.card.x
      && m.wc.top < m.card.y + m.card.h && m.wc.y + m.wc.h > m.card.y
    assert.equal(overlaps, false, `controls detached from the card at ${width}`)
    // the header itself is the page's drag region
    assert.equal(m.headerRegion, 'drag', `home header is a drag region at ${width}`)
    // POSITIVE CONTROL: the old shape (controls inside the centered card's
    // h1) IS card-attached and far from the corner — the detector can fail
    const badInside = m.bad.x >= m.badCard.x - 1 && m.bad.right <= m.badCard.right + 1
    assert.equal(badInside, true, `old-shape controls sit inside their card at ${width}`)
    assert.ok(m.bad.right < m.inner - 80,
      `old-shape controls are far from the corner at ${width}: ${JSON.stringify(m.bad)}`)
  }
    }
  console.log('HOME_HEADER_NATIVE_PASS ' + JSON.stringify({ widths: [700, 1000, 1400],
    control: 'old in-card shape detected as card-attached' }))
  window.destroy(); server.close(); app.exit(0)
}).catch(error => { console.error(error); for (const w of BrowserWindow.getAllWindows()) w.destroy(); app.exit(1) })
setTimeout(() => { console.error('Home header native probe timed out'); app.exit(1) }, 60000).unref()
