// Real-Electron probe for the tray org-list popup (run via
// tools/test-tray-popup.mjs). Three things only real Chromium can prove:
//
// 1. ALIGNMENT IS REAL GEOMETRY. The acceptance is "separate aligned
//    activity/name/n-m columns". The document's rows are SUBGRIDS of one
//    grid; this measures actual getBoundingClientRect edges across rows with
//    deliberately different count widths, and runs the same cells through an
//    independent-per-row-grid CONTROL stylesheet that must misalign —
//    proving the instrument can see the failure it guards.
//
// 1c. THE HIGHLIGHT IS ONE UNBROKEN ROUNDED RECTANGLE (user bug 2026-09-17).
//    A CSS assertion cannot see this: the old per-cell highlight was valid
//    CSS that rendered as two blocks because the empty activity cell was
//    shorter than the text cells. This measures the ROW box against its
//    cells — one painted element, spanning from the first cell's left edge
//    to the last cell's right edge, taller than every cell it contains, with
//    a real border-radius — in BOTH the hover and the focus state.
//
// 2. SELECTION IS A CANCELLED NAVIGATION. A row is an <a>; the probe wires
//    the same will-navigate interception index.ts uses, clicks a row inside
//    the sandboxed page, and asserts the slug arrived while the document
//    never left its data: URL.
import { app, BrowserWindow } from 'electron'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { trayListHtml, trayNavigationSlug, TRAY_LIST_W, TRAY_ROW_H, popupBounds } from '../apps/desktop/main/traylist'

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

interface HighlightBox {
  painted: boolean; cellsPainted: number; left: number; right: number; width: number
  height: number; firstCellLeft: number; lastCellRight: number; maxCellHeight: number
  cellHeights: number[]; radius: string
}
/** Does the ROW carry the highlight, alone, across every column? `painted`
 *  reads the resolved background-color rather than the rule, so a cell that
 *  paints itself is counted however it got there. */
const HIGHLIGHT = `[...document.querySelectorAll('.row')].map(r => {
  const opaque = el => {
    const bg = getComputedStyle(el).backgroundColor
    return !!bg && bg !== 'transparent' && !/^rgba\\(0, 0, 0, 0\\)$/.test(bg)
  }
  const box = r.getBoundingClientRect()
  const cells = [...r.children].map(c => c.getBoundingClientRect())
  return {
    painted: opaque(r),
    cellsPainted: [...r.children].filter(opaque).length,
    left: box.left, right: box.right, width: box.width, height: box.height,
    firstCellLeft: cells[0].left, lastCellRight: cells[cells.length - 1].right,
    maxCellHeight: Math.max(...cells.map(c => c.height)),
    cellHeights: cells.map(c => c.height),
    radius: getComputedStyle(r).borderTopLeftRadius,
  }
})`

/** `String.replace` returns the input unchanged when nothing matched, which
 *  turns an edited control stylesheet into the shipped one and makes the
 *  control pass vacuously. Fail loudly instead. */
function replaceOnce(source: string, find: string, into: string): string {
  assert.ok(source.includes(find), `probe is stale: the document no longer contains ${JSON.stringify(find)}`)
  return source.replace(find, into)
}

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

  // §1b instrument control: INDEPENDENT per-row grids (the shape a naive
  // implementation would produce) MUST misalign under the same measurement,
  // or the assertions above could never fail. Both replacements are asserted
  // to have actually fired — a .replace() that silently matched nothing is
  // exactly how a control "passes" without ever running.
  const shipped = trayListHtml(ROWS)
  const control = replaceOnce(
    replaceOnce(shipped,
      '.list{display:grid;grid-template-columns:18px minmax(0,1fr) max-content', '.list{display:block'),
    'grid-template-columns:subgrid', 'grid-template-columns:18px minmax(0,1fr) max-content')
  await popup.loadURL(dataUrl(control))
  const skewed = await popup.webContents.executeJavaScript(MEASURE) as CellRects[]
  assert.notEqual(skewed[1]!.ctLeft, skewed[0]!.ctLeft,
    'CONTROL FAILURE: per-row grids aligned anyway — the alignment assertions above are vacuous')

  // §1c the highlight is ONE box. Hover cannot be synthesised from script, so
  // the states are forced with a real stylesheet that turns :hover/:focus-
  // visible into a plain class — the same declarations, applied unavoidably.
  for (const [state, rule] of [
    ['hover', '.row:hover'], ['focus-visible', '.row:focus-visible']] as const) {
    const forced = replaceOnce(shipped, rule + '{', '.row.forced{')
      .replace(/class="row"/g, 'class="row forced"')
    await popup.loadURL(dataUrl(forced))
    const boxes = await popup.webContents.executeJavaScript(HIGHLIGHT) as HighlightBox[]
    assert.equal(boxes.length, ROWS.length)
    for (const [i, b] of boxes.entries()) {
      assert.ok(b.painted, `${state} row ${i}: the ROW element is the painted surface`)
      assert.equal(b.cellsPainted, 0,
        `${state} row ${i}: not one cell may carry its own background — that is the two-section split`)
      assert.ok(b.left <= b.firstCellLeft + 0.01 && b.right >= b.lastCellRight - 0.01,
        `${state} row ${i}: the highlight spans activity, name and count in one piece`)
      assert.ok(b.height >= b.maxCellHeight,
        `${state} row ${i}: the highlight is at least as tall as every cell (no short stub)`)
      assert.equal(b.height, TRAY_ROW_H, `${state} row ${i}: rows stay ${TRAY_ROW_H}px, so popupBounds still fits`)
      assert.ok(parseFloat(b.radius) > 0, `${state} row ${i}: rounded, not a square block`)
      assert.equal(b.width, boxes[0]!.width, `${state} row ${i}: every row highlight is the same width`)
    }
  }

  // §1d instrument control for §1c: the SHIPPED document, with an override
  // that restores exactly the pre-fix shape — display:contents rows, a
  // centred (not stretched) grid, a background on each CELL. That is the
  // stylesheet the user photographed, and the measurement above must report
  // it as broken, or §1c is a green light that can never turn red.
  const split = replaceOnce(shipped, '</style>',
    '.list{align-items:center}.row.forced{display:contents}' +
    '.row.forced>span{background:#2b3a4a;padding:5px 5px}</style>')
    .replace(/class="row"/g, 'class="row forced"')
  await popup.loadURL(dataUrl(split))
  const broken = await popup.webContents.executeJavaScript(HIGHLIGHT) as HighlightBox[]
  const idle = broken[1]!   // the idle org: empty activity cell, no spinner
  assert.ok(idle.cellsPainted > 0,
    'CONTROL FAILURE: the per-cell highlight was not detected as per-cell — §1c cannot see it')
  assert.ok(new Set(idle.cellHeights.map(h => Math.round(h))).size > 1,
    'CONTROL FAILURE: the empty activity cell matched the text cells anyway — ' +
    'the short-stub assertion in §1c is vacuous')
  assert.ok(!idle.painted || idle.height < idle.maxCellHeight,
    'CONTROL FAILURE: the split row still measured as one painted box')

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
