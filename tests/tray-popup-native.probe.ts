// Real-Electron probe for the tray org-list popup (run via
// tools/test-tray-popup.mjs). Two things only real Chromium can prove:
//
// 1. ALIGNMENT IS REAL GEOMETRY. The acceptance is "separate aligned
//    activity/name/n-m columns". The document's rows are display:contents
//    cells inside ONE grid; this measures actual getBoundingClientRect
//    edges across rows with deliberately different count widths, and runs
//    the same cells through a per-row-grid CONTROL stylesheet that must
//    misalign — proving the instrument can see the failure it guards.
//
// 2. SELECTION IS A CANCELLED NAVIGATION. A row is an <a display:contents>;
//    the probe wires the same will-navigate interception index.ts uses,
//    clicks a row inside the sandboxed page, and asserts the slug arrived
//    while the document never left its data: URL.
import { app, BrowserWindow } from 'electron'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { trayListHtml, trayNavigationSlug, TRAY_LIST_W, popupBounds } from '../apps/desktop/main/traylist'

app.setPath('userData', path.join(os.tmpdir(), `orgtree-tray-popup-${process.pid}`))

const ROWS = [
  { slug: 'alpha', name: 'Alpha Org', working: 10, live: 300 },   // wide count
  { slug: 'idle-org', name: 'Idle', working: 0, live: 3 },        // narrow count
  { slug: 'third', name: 'A Rather Long Organization Name That Ellipsizes', working: 0, live: 41 },
]

interface CellRects { nameX: number; ctLeft: number; ctRight: number; spin: boolean }
const MEASURE = `[...document.querySelectorAll('.row')].map(r => {
  const [act, name, ct] = r.children
  const n = name.getBoundingClientRect(), c = ct.getBoundingClientRect()
  return { nameX: n.x, ctLeft: c.x, ctRight: c.right, spin: !!act.querySelector('.spin') }
})`

const dataUrl = (html: string) => 'data:text/html;charset=utf-8,' + encodeURIComponent(html)

app.whenReady().then(async () => {
  const bounds = popupBounds({ x: 500, y: 900, width: 24, height: 24 }, { x: 0, y: 0, width: 1600, height: 860 }, ROWS.length)
  assert.equal(bounds.width, TRAY_LIST_W)
  const popup = new BrowserWindow({ ...bounds, frame: false, show: false, resizable: false,
    skipTaskbar: true, alwaysOnTop: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false } })

  // §1 geometry: the shipped document aligns all three columns across rows
  await popup.loadURL(dataUrl(trayListHtml(ROWS)))
  const cells = await popup.webContents.executeJavaScript(MEASURE) as CellRects[]
  assert.equal(cells.length, ROWS.length)
  for (const c of cells.slice(1)) {
    assert.equal(c.nameX, cells[0]!.nameX, 'every name cell starts at the same x')
    assert.equal(c.ctLeft, cells[0]!.ctLeft, 'the n/m column has ONE left edge across rows')
    assert.equal(c.ctRight, cells[0]!.ctRight, 'and one right edge')
  }
  assert.deepEqual(cells.map(c => c.spin), [true, false, false], 'spinner only where agents are active')

  // §1b instrument control: per-row grids (the shape a naive implementation
  // would produce) MUST misalign under the same measurement, or the
  // assertions above could never fail
  const control = trayListHtml(ROWS)
    .replace('.list{display:grid;grid-template-columns:18px minmax(0,1fr) max-content;align-items:center', '.list{display:block')
    .replace('.row{display:contents', '.row{display:grid;grid-template-columns:18px minmax(0,1fr) max-content;align-items:center')
  await popup.loadURL(dataUrl(control))
  const skewed = await popup.webContents.executeJavaScript(MEASURE) as CellRects[]
  assert.notEqual(skewed[1]!.ctLeft, skewed[0]!.ctLeft,
    'CONTROL FAILURE: per-row grids aligned anyway — the alignment assertions above are vacuous')

  // §2 selection: a click inside the sandboxed page becomes a cancelled
  // navigation carrying the slug, and the document never leaves its data: URL
  await popup.loadURL(dataUrl(trayListHtml(ROWS)))
  const selected = new Promise<string | null>(resolve => {
    popup.webContents.on('will-navigate', (event, url) => { event.preventDefault(); resolve(trayNavigationSlug(url)) })
  })
  await popup.webContents.executeJavaScript(`document.querySelectorAll('.row')[1].click()`)
  assert.equal(await selected, 'idle-org', 'the clicked row resolves to its org slug')
  await new Promise(resolve => setTimeout(resolve, 150))
  assert.match(popup.webContents.getURL(), /^data:text\/html/, 'the popup never actually navigated')

  console.log('tray-popup-native.probe: PASS')
  app.exit(0)
}).catch(error => { console.error(error); app.exit(1) })
