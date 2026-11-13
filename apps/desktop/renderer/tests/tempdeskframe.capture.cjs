// tempdeskframe.capture.cjs — USER 2026-11-13 mf430d688fdcb: the temporary agent desk moves onto the shared modal system
// (design A of m2672b93c2df8: pin and pop-out hand over to the agent's real windows). Measured in a real Chromium window:
//   1. opened: the shared dim backdrop covers the window; the panel is centred, on top at its own middle; its title bar
//      names the agent and carries, in order, pop-out, pin and X; the agent's ONE desk is inside (the canvas slot no
//      longer holds it); focus is inside the panel; nothing is saved
//   2. Escape closes it; the desk is back in its canvas slot and focus is back on the button that opened it
//   3. a click on the backdrop closes it; a click on the X closes it
//   4. the bar's right-click menu reads Open in new window, Pin to window, Close
//   5. with no pin on offer (the agent's desk is already pinned), the bar has pop-out and X only
//   6. Pin hands over: the host's pin action gets the panel's box and the modal closes; no pinned modal exists
//   7. Pop-out hands over: a real second window opens holding the desk (one composer), the modal and its backdrop are
//      gone from the main window, and the temporary desk itself is not in that window
//
//   electron.exe tempdeskframe.capture.cjs <outDir> <repoRoot> <node_modules dir> <label>
//
// Session 0, hidden windows (the main one off-screen-rendered), muted, clipboard stubbed and denied, only file: data:
// blob: about: requests, no OS input: mouse and keys go to this script's own web contents. Writes only under
// <outDir>/<label>/.
const { app, BrowserWindow, session, clipboard } = require('electron')
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const [outArg, repoArg, depsArg, label = 'run'] = process.argv.slice(2)
const out = path.resolve(outArg, label), repo = path.resolve(repoArg), deps = path.resolve(depsArg)
const sid = pid => Number(execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Process -Id ${Number(pid)}).SessionId`], { encoding: 'utf8', windowsHide: true }).trim())
assert.equal(sid(process.pid), 0, 'Session 0 required before creating a window')
fs.mkdirSync(out, { recursive: true })
for (const stale of ['failure.json', 'results.json']) fs.rmSync(path.join(out, stale), { force: true })
app.setPath('userData', path.join(out, 'profile-' + process.pid)); app.setPath('sessionData', path.join(out, 'session-' + process.pid))
app.disableHardwareAcceleration(); app.commandLine.appendSwitch('mute-audio')
let clipboardCalls = 0
for (const k of Object.keys(clipboard)) if (typeof clipboard[k] === 'function') clipboard[k] = () => { clipboardCalls++; return k === 'availableFormats' ? [] : k === 'has' ? false : '' }
const within = async (p, ms, what) => { let t; try { return await Promise.race([p, new Promise((_r, j) => { t = setTimeout(() => j(Error('Deadline: ' + what)), ms) })]) } finally { clearTimeout(t) } }

async function bundle() {
  const esbuild = require(path.join(deps, 'esbuild'))
  try {
    await esbuild.build({
      entryPoints: [path.join(repo, 'apps/desktop/renderer/tests/tempdeskframe.visual.tsx')],
      outfile: path.join(out, 'probe.js'), bundle: true, format: 'iife', platform: 'browser', jsx: 'automatic', logLevel: 'warning',
      nodePaths: [deps], loader: { '.png': 'dataurl', '.svg': 'dataurl', '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl' },
      define: { 'process.env.NODE_ENV': '"production"', __SRC_DIR__: '""' },
    })
  } finally { await esbuild.stop() }
  fs.writeFileSync(path.join(out, 'index.html'), '<!doctype html><html lang="en"><meta charset="utf-8"><link rel="stylesheet" href="probe.css"><body style="margin:0"><div id="root"></div><script src="probe.js"></script></body></html>')
}

// What the eye would check, read from the document.
const LOOK = `(() => {
  const box = el => { if (!el) return null; const r = el.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] }
  const panel = document.querySelector('.tempdesk-panel'), over = panel && panel.parentElement
  const canvas = document.querySelector('[data-which="canvas"]')
  const active = document.activeElement
  const out = { window: [innerWidth, innerHeight], open: !!panel, composers: document.querySelectorAll('textarea').length,
    deskInCanvas: !!canvas.querySelector('textarea'),
    pinnedAt: document.querySelector('#pinned-at').textContent, pinnedModal: !!document.querySelector('.overlay-pinned'),
    saved: Object.keys(localStorage), focus: active ? (active.id || active.tagName + '.' + String(active.className).slice(0, 40)) : null,
    menu: [...document.querySelectorAll('.ctxmenu button')].map(b => b.textContent.trim()) }
  if (!panel) return out
  const r = panel.getBoundingClientRect(), or = over.getBoundingClientRect()
  const mid = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
  const beside = document.elementFromPoint(Math.max(2, r.left / 2), r.top + r.height / 2)
  const bar = panel.querySelector(':scope > .modalpin-bar')
  return { ...out, panel: box(panel), overlay: box(over), overlayClass: over.className,
    overlayCovers: or.left <= 0 && or.top <= 0 && or.width >= innerWidth && or.height >= innerHeight,
    centred: Math.abs((r.left + r.width / 2) - innerWidth / 2) <= 2 && Math.abs((r.top + r.height / 2) - innerHeight / 2) <= 2,
    midHitsPanel: !!mid && panel.contains(mid), besideHitsBackdrop: beside === over,
    role: panel.getAttribute('role'), modal: panel.getAttribute('aria-modal'), label: panel.getAttribute('aria-label'),
    bar: bar && { box: box(bar), deskTitle: bar.classList.contains('desk-title'), name: (bar.querySelector('.modalpin-name') || {}).textContent,
      buttons: [...bar.querySelectorAll('button')].map(b => ({ label: b.getAttribute('aria-label'), box: box(b) })) },
    deskInside: !!panel.querySelector('textarea'), focusInside: panel.contains(active) || active === panel,
    popoutsInPanel: [...panel.querySelectorAll('[aria-label="Open in new window"]')].filter(b => b.getClientRects().length > 0).length, popoutParents: [...panel.querySelectorAll('[aria-label="Open in new window"]')].map(b => b.parentElement.className) }
})()`

app.whenReady().then(async () => {
  const errors = []
  try {
    await bundle()
    const ses = session.fromPartition('tempdesk-' + process.pid)
    ses.setPermissionCheckHandler(() => false); ses.setPermissionRequestHandler((_w, _p, done) => done(false))
    ses.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:|about:)/.test(d.url) }))
    const win = new BrowserWindow({ width: 1100, height: 760, useContentSize: true, show: false, frame: false,
      webPreferences: { session: ses, offscreen: true, backgroundThrottling: false, nodeIntegration: false, sandbox: true, contextIsolation: true } })
    const wc = win.webContents
    wc.setAudioMuted(true)
    let child = null
    // the desk's real window: whatever size the app asks for (it asks for the panel's box)
    wc.setWindowOpenHandler(({ url }) => url && url !== 'about:blank' ? { action: 'deny' } : { action: 'allow',
      overrideBrowserWindowOptions: { useContentSize: true, show: false, frame: false, paintWhenInitiallyHidden: true,
        webPreferences: { backgroundThrottling: false } } })
    wc.on('did-create-window', (w) => {
      child = w; w.webContents.setAudioMuted(true); w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      for (const k of ['copy', 'cut', 'paste', 'pasteAndMatchStyle']) w.webContents[k] = () => { throw Error('Clipboard denied') }
      w.webContents.on('console-message', (_e, level, message) => { if (level >= 2) errors.push('popout: ' + message) })
    })
    for (const k of ['copy', 'cut', 'paste', 'pasteAndMatchStyle']) wc[k] = () => { throw Error('Clipboard denied') }
    wc.on('console-message', (_e, level, message) => { if (level >= 2) errors.push(message) })
    const js = (s, gesture = false) => wc.executeJavaScript(s, gesture)
    const until = async (fn, what, ms = 8000) => { const end = Date.now() + ms; for (;;) { if (await fn()) return; if (Date.now() > end) throw Error('Wait: ' + what); await new Promise(r => setTimeout(r, 60)) } }
    const pause = ms => new Promise(r => setTimeout(r, ms))
    const settle = () => pause(380)
    const look = () => js(LOOK)
    const shot = async (contents, name) => {
      try { await within(contents.executeJavaScript('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 200))))'), 3000, 'paint ' + name) } catch {}
      try { const img = await within(contents.capturePage(), 5000, 'capture ' + name); const png = img.toPNG(); fs.writeFileSync(path.join(out, 'png', name + '.png'), png); return { bytes: png.length, size: img.getSize() } }
      catch (e) { return { error: String(e) } }
    }
    // real input, to this window only
    const mouse = (type, x, y, extra = {}) => wc.sendInputEvent({ type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1, ...extra })
    const clickAt = async (x, y) => { mouse('mouseMove', x, y); await pause(30); mouse('mouseDown', x, y); mouse('mouseUp', x, y); await settle() }
    const clickBox = b => clickAt(b[0] + b[2] / 2, b[1] + b[3] / 2)
    const key = async (keyCode) => { wc.sendInputEvent({ type: 'keyDown', keyCode }); wc.sendInputEvent({ type: 'keyUp', keyCode }); await settle() }
    const boxOf = sel => js(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return [r.left, r.top, r.width, r.height] })()`)
    const button = (state, name) => state.bar.buttons.find(b => b.label === name)
    const names = state => JSON.stringify(state.bar ? state.bar.buttons.map(b => b.label) : null)
    fs.mkdirSync(path.join(out, 'png'), { recursive: true })
    await within(win.loadFile(path.join(out, 'index.html')), 15000, 'load')
    await until(() => js(`!!document.querySelector('#open-temp') && !!document.querySelector('[data-which="canvas"] textarea')`), 'the canvas desk')
    await settle()
    const problems = [], steps = {}
    const need = (ok, what) => { if (!ok) problems.push(what) }
    wc.focus()
    const openIt = async () => { await clickBox(await boxOf('#open-temp')); await until(async () => (await look()).open, 'the temporary desk'); await settle(); return look() }
    const closed = s => !s.open && s.deskInCanvas && s.composers === 1

    const before = steps.before = await look()
    need(closed(before), 'control: the desk does not start in its canvas slot')

    // 1. opened
    const o = steps.opened = await openIt()
    steps.openedPng = await shot(wc, '1-temporary-desk-open')
    need(/(^| )overlay( |$)/.test(o.overlayClass) && o.overlayCovers && o.besideHitsBackdrop, `not inside the shared backdrop: ${o.overlayClass} ${JSON.stringify(o.overlay)}`)
    need(o.centred && o.midHitsPanel, `the panel is not centred and on top: ${JSON.stringify(o.panel)}`)
    need(o.role === 'dialog' && o.modal === 'true' && o.label === 'scout · desk, opened temporarily', `not a named modal dialog: ${[o.role, o.modal, o.label]}`)
    need(o.bar && o.bar.deskTitle && /scout/.test(o.bar.name || ''), `the shared title bar does not name the agent: ${JSON.stringify(o.bar)}`)
    need(names(o) === JSON.stringify(['Open in new window', 'pin this to the window', 'close this window']), `the bar buttons are ${names(o)}`)
    need(o.bar && o.bar.buttons.every((b, i, a) => b.box[2] >= 12 && (i === 0 || b.box[0] >= a[i - 1].box[0] + a[i - 1].box[2] - 1)), 'the bar buttons overlap or have no size')
    need(o.deskInside && o.composers === 1 && !o.deskInCanvas, `the one desk is not the one inside: composers ${o.composers}, in canvas ${o.deskInCanvas}`)
    need(o.popoutsInPanel === 1, `pop-out buttons in the panel: ${o.popoutsInPanel} ${JSON.stringify(o.popoutParents)}`)
    need(o.focusInside, `focus is not inside the panel: ${o.focus}`)
    need(o.saved.length === 0, `something was saved: ${o.saved}`)

    // 2. Escape
    await key('Escape')
    const esc = steps.escape = await look()
    need(closed(esc), 'Escape did not close it and return the desk')
    need(esc.focus === 'open-temp', `focus did not return to the opener: ${esc.focus}`)

    // 3. backdrop, then X
    const o2 = await openIt()
    await clickAt(Math.max(4, o2.panel[0] / 2), o2.panel[1] + o2.panel[3] / 2)
    steps.backdrop = await look()
    need(closed(steps.backdrop), 'a click on the backdrop did not close it')
    const o3 = await openIt()
    await clickBox(button(o3, 'close this window').box)
    steps.x = await look()
    need(closed(steps.x), 'the X did not close it')

    // 4. the bar's menu (a real right click; a DOM contextmenu event if the off-screen window does not raise one)
    const o4 = await openIt()
    const bx = Math.round(o4.bar.box[0] + 120), by = Math.round(o4.bar.box[1] + o4.bar.box[3] / 2)
    mouse('mouseMove', bx, by); await pause(30)
    wc.sendInputEvent({ type: 'mouseDown', x: bx, y: by, button: 'right', clickCount: 1 })
    wc.sendInputEvent({ type: 'mouseUp', x: bx, y: by, button: 'right', clickCount: 1 })
    await settle()
    let m = await look()
    steps.menuVia = 'right click'
    if (!m.menu.length) {
      await js(`document.querySelector('.tempdesk-panel > .modalpin-bar').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: ${bx}, clientY: ${by} }))`)
      await settle(); m = await look(); steps.menuVia = 'DOM contextmenu event'
    }
    steps.menu = m.menu
    steps.menuPng = await shot(wc, '2-bar-menu')
    need(JSON.stringify(m.menu) === JSON.stringify(['Open in new window', 'Pin to window', 'Close']), `the bar menu reads ${JSON.stringify(m.menu)}`)
    await key('Escape')
    if ((await look()).open) await key('Escape')
    need(closed(await look()), 'Escape did not close the menu and then the desk')

    // 5. no pin on offer
    await clickBox(await boxOf('#toggle-pin'))
    const o5 = steps.noPin = await openIt()
    need(names(o5) === JSON.stringify(['Open in new window', 'close this window']), `with no pin offered the bar has ${names(o5)}`)
    await key('Escape')
    await clickBox(await boxOf('#toggle-pin'))

    // 6. Pin hands over
    const o6 = await openIt()
    await clickBox(button(o6, 'pin this to the window').box)
    const pinned = steps.pin = await look()
    need(closed(pinned) && pinned.pinnedAt === `pin asked at ${o6.panel[2]}x${o6.panel[3]}` && !pinned.pinnedModal,
      `Pin did not hand over the panel's box and close: ${JSON.stringify([pinned.pinnedAt, o6.panel, pinned.pinnedModal, pinned.open])}`)
    need(pinned.saved.length === 0, `the frame saved something on pin: ${pinned.saved}`)

    // 7. Pop-out hands over
    const o7 = await openIt()
    await clickBox(button(o7, 'Open in new window').box)
    await until(() => !!child, 'a second window')
    const cjs = s => child.webContents.executeJavaScript(s, true)
    await until(() => cjs("!!document.querySelector('textarea')"), 'the desk inside the second window')
    await settle()
    const inChild = await cjs("({ composers: document.querySelectorAll('textarea').length, tempPanel: !!document.querySelector('.tempdesk-panel'), backdrop: !!document.querySelector('.overlay'), window: [innerWidth, innerHeight] })")
    const mainAfter = await look()
    steps.popout = { child: inChild, childSession: sid(child.webContents.getOSProcessId()), main: mainAfter, askedFrom: o7.panel }
    steps.popout.childPng = await shot(child.webContents, '3-desk-in-its-own-window')
    steps.popout.mainPng = await shot(wc, '4-main-window-after-pop-out')
    need(inChild.composers === 1 && !inChild.tempPanel && !inChild.backdrop, `the new window is not the desk alone: ${JSON.stringify(inChild)}`)
    need(!mainAfter.open && mainAfter.composers === 0, `the main window still holds the modal or a second composer: ${JSON.stringify([mainAfter.open, mainAfter.composers])}`)

    const result = { label, status: problems.length ? 'FAIL' : 'PASS', problems, steps, sessionId: sid(process.pid), rendererSessionId: sid(wc.getOSProcessId()),
      muted: wc.isAudioMuted() && (!child || child.webContents.isAudioMuted()), clipboardCalls, errors }
    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(result, null, 2))
    console.log(`${result.status}: ${problems.length} problems`)
    for (const p of problems) console.log('  - ' + p)
    console.log('  menu via ' + steps.menuVia + '; errors ' + JSON.stringify(errors).slice(0, 400))
    app.exit(problems.length ? 1 : 0)
  } catch (e) {
    console.error(e)
    try { fs.writeFileSync(path.join(out, 'failure.json'), JSON.stringify({ error: String(e), errors }, null, 2)) } catch {}
    app.exit(2)
  }
}).catch(e => { console.error(e); app.exit(2) })
