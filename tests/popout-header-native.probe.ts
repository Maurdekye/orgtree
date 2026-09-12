// A popped-out desk or modal is a frameless window whose own header is its
// title bar. Several things have to be true at once or the window is unusable:
// the native frame must really be gone, the header must really be a drag region
// with every control in it still clickable, and the window controls must stay
// one row at the right edge however narrow the window gets. None of that is
// visible to a jsdom test - `-webkit-app-region` has no meaning without a
// compositor, and nothing has a layout - so it is all measured here, in real
// windows, through the real window-open path.
//
// No engine, no app data, no network beyond a loopback server that exists only
// to give the opener a trusted origin. Exits through app.exit() so the process
// cannot outlive its assertions, and holds its own deadline so a hang reports
// rather than waiting to be killed.
import { app, BrowserWindow } from 'electron'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { configureWindow, popoutRegistry } from '../apps/desktop/main/windows'

const styles = fs.readFileSync(process.env.ORGTREE_POPOUT_STYLES!, 'utf8')

/** One of every element kind the drag-region rules name, so a rule that stops
 *  applying is measured rather than assumed. */
const DESK_HEADER = `
<div class="cc-head"><div class="cc-head-top">
  <span class="cc-head-left"><span class="tier">O</span><span class="cc-name">a-fairly-long-agent-name</span></span>
  <span class="spacer"></span>
  <span class="cc-head-right">
    <button class="cc-icon" id="d-button">settings</button>
    <a href="#" id="d-a">link</a>
    <input id="d-input">
    <select id="d-select"><option>option</option></select>
    <textarea id="d-textarea"></textarea>
    <label id="d-label">label</label>
    <span role="button" id="d-role">role</span>
    <span tabindex="0" id="d-tabindex">tabindex</span>
  </span>
  <span class="window-controls popout-window-controls" id="d-controls">
    <button class="window-control" id="d-min">-</button>
    <button class="window-control" id="d-max">+</button>
    <button class="window-control close" id="d-control">x</button>
  </span>
</div></div>`

// ⚠ THE PANEL AROUND IT IS PART OF THE FIXTURE. A popped-out modal's bar is
// `.modalpin-bar.detached` inside `.settings.modalpin-detached`, and its
// width comes from cancelling that panel's padding — measure the bar without
// the panel and the geometry means nothing. An earlier version of this file
// wrote the bar on its own WITH a title in it, which is how a real popped-out
// modal came to have a 46px title bar with every pixel excluded (user report
// 2026-09-12) while this probe stayed green.
const MODAL_BAR = `
<div class="overlay overlay-detached"><div class="settings modalpin-detached">
<div class="modalpin-bar detached">
  <span class="modalpin-name" role="heading" aria-level="3">title</span>
  <span class="spacer"></span>
  <button class="modalpin-btn" id="m-button">pin</button>
  <span class="window-controls popout-window-controls" id="m-controls">
    <button class="window-control" id="m-min">-</button>
    <button class="window-control" id="m-max">+</button>
    <button class="window-control close" id="m-control">x</button>
  </span>
</div>
<h3 id="m-own-title">title</h3>
</div></div>`

const DRAG = ['.cc-head-top', '.cc-head-top .tier', '.cc-head-top .cc-name', '.cc-head-top .spacer',
  '.modalpin-bar', '.modalpin-bar .modalpin-name', '.modalpin-bar .spacer']
const NO_DRAG = ['#d-button', '#d-a', '#d-input', '#d-select', '#d-textarea', '#d-label', '#d-role',
  '#d-tabindex', '#d-control', '#m-button', '#m-control']

const measure = (window: BrowserWindow, selectors: string[]) => window.webContents.executeJavaScript(
  `Object.fromEntries(${JSON.stringify(selectors)}.map(s => {
    const el = document.querySelector(s)
    return [s, el ? getComputedStyle(el).getPropertyValue('-webkit-app-region') : 'MISSING']
  }))`) as Promise<Record<string, string>>

const boxes = (window: BrowserWindow, selectors: string[]) => window.webContents.executeJavaScript(
  `Object.fromEntries(${JSON.stringify(selectors)}.map(s => {
    const el = document.querySelector(s)
    if (!el) return [s, null]
    const r = el.getBoundingClientRect()
    return [s, { top: Math.round(r.top), right: Math.round(r.right), height: Math.round(r.height), width: Math.round(r.width) }]
  }))`) as Promise<Record<string, { top: number; right: number; height: number; width: number } | null>>

const display = (window: BrowserWindow, selector: string) => window.webContents.executeJavaScript(
  `(() => { const el = document.querySelector(${JSON.stringify(selector)})
     return el ? getComputedStyle(el).display : 'MISSING' })()`) as Promise<string>

const padding = (window: BrowserWindow, selector: string) => window.webContents.executeJavaScript(
  `(() => { const el = document.querySelector(${JSON.stringify(selector)})
     return el ? getComputedStyle(el).padding : 'MISSING' })()`) as Promise<string>

function write(window: BrowserWindow, bodyClass: string, mountClass: string, body: string) {
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>${styles}</style></head>`
    + `<body class="${bodyClass}"><div class="${mountClass}">${body}</div></body></html>`
  return window.webContents.executeJavaScript(`document.open(); document.write(${JSON.stringify(html)}); document.close(); true`)
}

async function main() {
  app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-popout-probe-')))
  app.disableHardwareAcceleration()
  await app.whenReady()

  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end('<!doctype html><title>opener</title><body>')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`

  const registry = popoutRegistry<BrowserWindow>(() => {})
  const opener = new BrowserWindow({ show: false, frame: false, width: 1000, height: 700 })
  configureWindow(opener, () => origin, true, undefined, undefined, undefined, registry.track)
  await opener.loadURL(origin + '/')

  // ---- the window the renderer opens is the window the registry hands back
  const created = new Promise<BrowserWindow>(resolve => opener.webContents.once('did-create-window', window => resolve(window)))
  await opener.webContents.executeJavaScript(`window.open('', 'orgtree-popout-1', 'popup,width=900,height=600'); true`)
  const child = await created
  assert.equal(registry.window('orgtree-popout-1'), child, 'the frame name must pair to the window that was created')
  assert.equal(registry.window('orgtree-popout-2'), undefined, 'and only to that one')

  // ---- it is really frameless, measured rather than assumed
  const framed = new BrowserWindow({ show: false, frame: true, width: 400, height: 300 })
  const chrome = (window: BrowserWindow) => {
    const outer = window.getBounds(), inner = window.getContentBounds()
    return outer.height - inner.height + (outer.width - inner.width)
  }
  assert.ok(chrome(framed) > 0, 'POSITIVE CONTROL: a framed window measurably has chrome, so 0 below means something')
  assert.equal(chrome(child), 0, 'the popout must have no native frame: its header is the title bar')
  framed.destroy()

  // ---- the header is the drag region, and everything in it stays clickable
  child.setContentSize(900, 600)
  await write(child, 'popout-document', 'popout-mount', DESK_HEADER + MODAL_BAR)
  const popout = await measure(child, [...DRAG, ...NO_DRAG])
  for (const selector of DRAG) assert.equal(popout[selector], 'drag', `${selector} must drag the window`)
  for (const selector of NO_DRAG) assert.equal(popout[selector], 'no-drag', `${selector} must stay clickable`)

  // ---- the check can fail: without the exclusions every control is swallowed.
  // The window controls are excluded twice over - .window-control carries its
  // own no-drag independently of anything scoped to a popout - so they are the
  // one thing this mutation must NOT break, and saying so keeps the rest honest.
  await child.webContents.executeJavaScript(
    `for (const sheet of document.styleSheets) {
       for (let i = sheet.cssRules.length - 1; i >= 0; i--) {
         const rule = sheet.cssRules[i]
         if (rule.selectorText && rule.selectorText.includes('.popout-mount') && rule.style.getPropertyValue('-webkit-app-region') === 'no-drag') sheet.deleteRule(i)
       }
     } true`)
  const broken = await measure(child, NO_DRAG)
  for (const selector of NO_DRAG.filter(s => !s.endsWith('-control'))) {
    assert.equal(broken[selector], 'drag', `MUTATION: ${selector} would be swallowed without its exclusion`)
  }
  for (const selector of NO_DRAG.filter(s => s.endsWith('-control'))) {
    assert.equal(broken[selector], 'no-drag', `${selector} is excluded by .window-control in its own right`)
  }

  // ---- a popped-out DESK's header is a HANDLE, not a corner cluster
  const content = child.getContentBounds()
  const deskBar = (await boxes(child, ['.cc-head-top']))['.cc-head-top']!
  assert.ok(deskBar.width >= content.width - 40,
    `the desk header must span the window to be grabbable (${deskBar.width} of ${content.width})`)
  assert.ok(deskBar.top <= 12, `and sit at the top of it (${deskBar.top})`)

  // ---- narrow: the rest of the header wraps, the controls do not
  await write(child, 'popout-document', 'popout-mount', DESK_HEADER + MODAL_BAR)
  child.setContentSize(380, 600)
  await new Promise(resolve => setTimeout(resolve, 150))
  const narrow = await boxes(child, ['.cc-head-top', '.cc-head-left', '.cc-head-right', '#d-controls',
    '#d-min', '#d-max', '#d-control', '.modalpin-bar', '#m-controls', '#m-min', '#m-control'])
  const head = narrow['.cc-head-top']!, left = narrow['.cc-head-left']!, right = narrow['.cc-head-right']!
  assert.ok(right.top > left.top, 'POSITIVE CONTROL: the rest of the header must actually wrap here, or nothing below is a test')
  const controls = narrow['#d-controls']!
  assert.ok(Math.abs(controls.right - head.right) <= 2, `the controls must sit at the header's right edge (${controls.right} vs ${head.right})`)
  assert.ok(Math.abs(controls.top - head.top) <= 2, 'and on its first row, not carried down by the wrap')
  for (const id of ['#d-min', '#d-max', '#d-control']) {
    assert.equal(narrow[id]!.top, narrow['#d-min']!.top, `${id} must share one row with the other controls`)
    assert.ok(narrow[id]!.right <= head.right + 2, `${id} must not be pushed past the right edge`)
  }
  assert.ok(controls.height <= narrow['#d-min']!.height + 2, 'the group is one row high, not two')
  // the modal bar is a single nowrap cluster: same guarantee, reached differently
  const bar = narrow['.modalpin-bar']!, barControls = narrow['#m-controls']!
  // ⚠ 6, NOT 2: a detached bar is a title bar with the same `padding: 0 4px`
  // the pinned one has, so its controls sit just inside its edge rather than
  // flush with it. The claim is unchanged — they are at the RIGHT end of the
  // bar, not carried anywhere else.
  assert.ok(Math.abs(barControls.right - bar.right) <= 6,
    `the modal bar's controls sit at its right edge (${barControls.right} vs ${bar.right})`)
  assert.equal(narrow['#m-control']!.top, narrow['#m-min']!.top, 'and in one row')

  // ---- a popped-out DESK gets room off the glass; nothing else does
  assert.equal(await padding(child, '.popout-mount'), '8px', 'a popped-out desk needs a little room inside a frameless window')
  // back to a normal window before measuring a title bar against it: the
  // section above left this one at 380px on purpose
  child.setContentSize(900, 600)
  await new Promise(resolve => setTimeout(resolve, 200))
  await write(child, 'popout-document', 'popout-mount', MODAL_BAR)
  assert.equal(await padding(child, '.popout-mount'), '0px', 'a popped-out modal keeps its own panel padding and gains none here')

  // ---- ...and a popped-out MODAL's title bar spans its window too. THE
  // REPORTED DEFECT (2026-09-12): unpinned, `.modalpin-bar` is
  // `margin-left: auto`, so a popped-out modal's title bar was a ~46px
  // cluster of excluded controls in the top-right corner and the window could
  // not be moved at all. `.detached` is what makes it a title bar.
  await new Promise(resolve => setTimeout(resolve, 200))
  const modalBox = (await boxes(child, ['.modalpin-bar']))['.modalpin-bar']!
  const modalRoom = await child.webContents.executeJavaScript('({ width: innerWidth, height: innerHeight })') as { width: number; height: number }
  assert.ok(modalBox.width >= modalRoom.width - 40,
    `the modal title bar must span the window (${modalBox.width} of ${modalRoom.width})`)
  assert.ok(modalBox.top <= 12, `and sit at the top of it (${modalBox.top})`)
  // it is the window's ONE title: the panel's own heading stands down
  assert.equal(await display(child, '#m-own-title'), 'none',
    'a popped-out panel must not say its name twice')
  // THE CONTROL FOR BOTH, and they are two separate classes: the BAR's
  // `.detached` is what makes it a title bar, and the PANEL's
  // `.modalpin-detached` is what stands its own heading down.
  await child.webContents.executeJavaScript(
    `document.querySelector('.modalpin-bar').classList.remove('detached'); true`)
  await new Promise(resolve => setTimeout(resolve, 100))
  const cluster = (await boxes(child, ['.modalpin-bar']))['.modalpin-bar']!
  assert.ok(cluster.width < modalRoom.width / 2,
    `MUTATION: without .detached the bar must collapse to a corner cluster (${cluster.width})`)
  await child.webContents.executeJavaScript(
    `document.querySelector('.settings').classList.remove('modalpin-detached'); true`)
  assert.notEqual(await display(child, '#m-own-title'), 'none',
    'MUTATION: without .modalpin-detached the panel takes its own heading back')
  await write(child, 'popout-document', 'popout-mount', MODAL_BAR)

  // ---- and the same headers anywhere else are untouched
  const inCanvas = new BrowserWindow({ show: false, frame: false, width: 800, height: 600 })
  // Loaded before it is scripted: executeJavaScript on a webContents that has
  // never navigated never settles, which is exactly how this probe hung.
  await inCanvas.loadURL('about:blank')
  await write(inCanvas, 'app', 'canvas-stage', DESK_HEADER + MODAL_BAR)
  const ordinary = await measure(inCanvas, [...DRAG, ...NO_DRAG])
  for (const selector of DRAG) assert.equal(ordinary[selector], 'none', `${selector} must not become a drag region outside a popout`)
  for (const selector of NO_DRAG.filter(s => !s.endsWith('-control'))) {
    assert.equal(ordinary[selector], 'none', `${selector} must be untouched outside a popout`)
  }
  assert.equal(await padding(inCanvas, '.canvas-stage'), '0px', 'and an in-canvas desk gains no padding')
  const canvasBoxes = await boxes(inCanvas, ['.cc-head-top', '#d-controls'])
  assert.ok(canvasBoxes['.cc-head-top']!.width >= 790, 'an in-canvas header reserves no room for controls it does not have')
  inCanvas.destroy()

  return 'PASS popout is frameless; its header drags, spans the window and is its one title; its controls stay clickable, one row and right-aligned when narrow; only a popped-out desk gains padding; ordinary surfaces are untouched'
}

/** Never outlive the assertions: app.exit(), not app.quit(), so no lingering
 *  window, socket or renderer can hold the process open. */
const finish = (code: number) => {
  try { for (const window of BrowserWindow.getAllWindows()) window.destroy() } catch { /* already gone */ }
  app.exit(code)
}
const deadline = setTimeout(() => { console.error('popout probe exceeded its own deadline'); finish(1) }, 40000)
main().then(
  message => { clearTimeout(deadline); console.log(message); finish(0) },
  error => { clearTimeout(deadline); console.error(error); finish(1) })
