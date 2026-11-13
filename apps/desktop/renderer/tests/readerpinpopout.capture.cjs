// readerpinpopout.capture.cjs — USER 2026-11-12 md15fcb3a298e: "when the presentations reader is opened for a presentation
// by clicking its card in the header of a popped-out agent desk, it works, but trying to pin it makes it invisible and
// unable to be interacted with". In a REAL second window (window.open, as the app's pop-out does):
//   1. the desk is popped out with the real pop-out button; its content is in the new window
//   2. the presentation card is clicked there: the reader opens in that window (control: this worked before)
//   3. the reader's real pin button is clicked: the reader is STILL in that window, dressed as a pinned window, its box
//      inside the window, and the point at its middle hit-tests to the reader itself (drawn on top, not behind the desk)
//   4. a button inside the pinned reader, found by hit-testing its middle, takes a click (interactive)
//   5. a point beside the pinned reader hit-tests to the desk's window content, where the centred reader's backdrop was
//      (control, measured in step 2): the pin is not a modal
//   6. control: a reader opened and pinned in the MAIN window sits in the org's pin layer there, visible, as before
// Before the fix step 3 fails: the pinned reader has left the popped-out window for the main window's pin layer.
//
//   electron.exe readerpinpopout.capture.cjs <outDir> <repoRoot> <node_modules dir> <label>
//
// Session 0, hidden windows (the main one off-screen-rendered), muted, clipboard stubbed and denied, only file: data:
// blob: about: requests, no OS input: every click is a DOM event sent to this script's own windows.
// Writes only under <outDir>/<label>/.
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
      entryPoints: [path.join(repo, 'apps/desktop/renderer/tests/readerpinpopout.visual.tsx')],
      outfile: path.join(out, 'probe.js'), bundle: true, format: 'iife', platform: 'browser', jsx: 'automatic', logLevel: 'warning',
      nodePaths: [deps], loader: { '.png': 'dataurl', '.svg': 'dataurl', '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl' },
      define: { 'process.env.NODE_ENV': '"production"', __SRC_DIR__: '""' },
    })
  } finally { await esbuild.stop() }
  fs.writeFileSync(path.join(out, 'index.html'), '<!doctype html><html lang="en"><meta charset="utf-8"><link rel="stylesheet" href="probe.css"><body style="margin:0"><div id="root"></div><script src="probe.js"></script></body></html>')
}

// Where one panel is in THIS document and whether it can be seen and reached there: its box, the window's size, what
// the middle of the box hit-tests to (a box that intersects the window can still sit behind something), its classes.
const LOOK = name => `(() => {
  const p = document.querySelector('.${name}')
  if (!p) return { here: false }
  const r = p.getBoundingClientRect(), cs = getComputedStyle(p)
  const mid = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
  const count = p.querySelector('[data-count]'), cr = count.getBoundingClientRect()
  const atCount = document.elementFromPoint(cr.left + cr.width / 2, cr.top + cr.height / 2)
  return { here: true, box: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)], window: [innerWidth, innerHeight],
    inside: r.width > 0 && r.height > 0 && r.left >= 0 && r.top >= 0 && r.right <= innerWidth + 0.5 && r.bottom <= innerHeight + 0.5,
    midHitsPanel: !!mid && p.contains(mid), midHit: mid ? mid.tagName + '.' + String(mid.className).slice(0, 60) : null,
    pinned: p.parentElement.classList.contains('overlay-pinned'), inPinLayer: !!p.closest('.pin-layer'),
    visibility: cs.visibility, opacity: cs.opacity, display: cs.display,
    countHitsItself: atCount === count, countText: count.textContent }
})()`
// a click as a person makes it: the pointer goes down where the thing is, then the click lands on WHAT IS THERE
const CLICK_AT = sel => `(() => {
  const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return 'missing'
  const r = el.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2
  const hit = document.elementFromPoint(x, y); if (!hit) return 'nothing there'
  // the pointer going down is what tells the app which window an action came from; sent to the document itself so
  // that no title bar takes it for the start of a drag
  document.documentElement.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: x, clientY: y, button: 0 }))
  hit.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 })) // an icon inside a button is an SVG node: no .click()
  return hit === el || el.contains(hit) ? 'ok' : 'covered by ' + hit.tagName + '.' + String(hit.className).slice(0, 60)
})()`

app.whenReady().then(async () => {
  const errors = []
  try {
    await bundle()
    const ses = session.fromPartition('readerpin-' + process.pid)
    ses.setPermissionCheckHandler(() => false); ses.setPermissionRequestHandler((_w, _p, done) => done(false))
    ses.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:|about:)/.test(d.url) }))
    const win = new BrowserWindow({ width: 1100, height: 800, show: false, frame: false,
      webPreferences: { session: ses, offscreen: true, backgroundThrottling: false, nodeIntegration: false, sandbox: true, contextIsolation: true } })
    const wc = win.webContents
    wc.setAudioMuted(true)
    // the pop-out: a real second window of the same renderer, hidden, as small as a popped-out desk
    let child = null
    wc.setWindowOpenHandler(({ url }) => url && url !== 'about:blank' ? { action: 'deny' } : { action: 'allow',
      overrideBrowserWindowOptions: { width: 820, height: 640, useContentSize: true, show: false, frame: false, paintWhenInitiallyHidden: true,
        webPreferences: { backgroundThrottling: false } } })
    wc.on('did-create-window', (w) => {
      child = w; w.webContents.setAudioMuted(true); w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      for (const k of ['copy', 'cut', 'paste', 'pasteAndMatchStyle']) w.webContents[k] = () => { throw Error('Clipboard denied') }
      w.webContents.on('console-message', (_e, level, message) => { if (level >= 2) errors.push('popout: ' + message) })
    })
    for (const k of ['copy', 'cut', 'paste', 'pasteAndMatchStyle']) wc[k] = () => { throw Error('Clipboard denied') }
    wc.on('console-message', (_e, level, message) => { if (level >= 2) errors.push(message) })
    const js = (s, gesture = false) => wc.executeJavaScript(s, gesture)
    const cjs = s => child.webContents.executeJavaScript(s, true)
    const until = async (fn, what, ms = 8000) => { const end = Date.now() + ms; for (;;) { if (await fn()) return; if (Date.now() > end) throw Error('Wait: ' + what); await new Promise(r => setTimeout(r, 60)) } }
    const settle = () => new Promise(r => setTimeout(r, 350))
    const shot = async (contents, name) => {
      // a hidden window hands back its LAST painted frame: let this one paint first
      try { await within(contents.executeJavaScript('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 200))))'), 3000, 'paint ' + name) } catch {}
      try { const img = await within(contents.capturePage(), 5000, 'capture ' + name); const png = img.toPNG(); fs.writeFileSync(path.join(out, 'png', name + '.png'), png); return { bytes: png.length, size: img.getSize() } }
      catch (e) { return { error: String(e) } }
    }
    fs.mkdirSync(path.join(out, 'png'), { recursive: true })
    await within(win.loadFile(path.join(out, 'index.html')), 15000, 'load')
    await until(() => js("!!document.querySelector('#card') && !!document.querySelector('.popout-button')"), 'the desk')
    const problems = [], steps = {}

    // 1. pop the desk out with its own button
    await js("document.querySelector('[data-desk] .popout-button').click()", true)
    await until(() => !!child, 'a second window')
    await until(() => cjs("!!document.querySelector('#card')"), 'the desk inside the second window')
    await settle()
    steps.poppedOut = { deskInChild: await cjs("!!document.querySelector('[data-desk]')"), deskInMain: await js("!!document.querySelector('[data-desk]')"),
      childWindow: await cjs('[innerWidth, innerHeight]'), childSession: sid(child.webContents.getOSProcessId()) }
    if (!steps.poppedOut.deskInChild || steps.poppedOut.deskInMain) problems.push('the desk is not in the popped-out window')

    // 2. the presentation card, clicked in the popped-out window
    const card = await cjs(CLICK_AT('#card'))
    await until(async () => (await cjs("!!document.querySelector('.rp-panel')")) || (await js("!!document.querySelector('.rp-panel')")), 'the reader')
    await settle()
    // what is at a point just left of the reader, half way down
    const BESIDE = `(() => { const p = document.querySelector('.rp-panel').getBoundingClientRect(), x = Math.max(2, p.left / 2), y = p.top + p.height / 2
      const hit = document.elementFromPoint(x, y)
      return { at: [Math.round(x), Math.round(y)], hit: hit ? hit.tagName + '.' + String(hit.className).slice(0, 40) : null, backdrop: !!hit && hit.classList.contains('overlay'),
        inDeskWindowContent: !!hit && (!!hit.closest('.popout-mount') || hit === document.body || hit === document.documentElement) } })()`
    steps.opened = { click: card, child: await cjs(LOOK('rp-panel')), main: await js(LOOK('rp-panel')) }
    if (steps.opened.child.here) steps.opened.beside = await cjs(BESIDE)
    steps.opened.png = await shot(child.webContents, '1-opened-in-popout')
    if (!(steps.opened.child.here && steps.opened.child.midHitsPanel && !steps.opened.child.pinned)) problems.push('control: the reader did not open, centred and on top, in the popped-out window')

    // 3. pin it with its own pin button
    const where = steps.opened.child.here ? cjs : js
    const pin = await where(CLICK_AT('.rp-panel .modalpin-btn'))
    await settle()
    steps.pinned = { click: pin, child: await cjs(LOOK('rp-panel')), main: await js(LOOK('rp-panel')) }
    steps.pinned.png = await shot(child.webContents, '2-pinned-in-popout')
    steps.pinned.mainPng = await shot(wc, '2-main-window-after-pin')
    const c = steps.pinned.child
    if (!c.here) problems.push(`the pinned reader left the popped-out window (in the main window: ${steps.pinned.main.here}, in its pin layer: ${steps.pinned.main.inPinLayer ?? false})`)
    else {
      if (!c.pinned) problems.push('the reader in the popped-out window is not dressed as a pinned window')
      if (!c.inside) problems.push(`the pinned reader's box ${c.box} is not inside the window ${c.window}`)
      if (!c.midHitsPanel) problems.push(`the pinned reader is not what is at its own middle: ${c.midHit} is`)
      if (c.visibility !== 'visible' || Number(c.opacity) < 0.99 || c.display === 'none') problems.push(`the pinned reader is ${c.visibility}, opacity ${c.opacity}, display ${c.display}`)
      if (steps.pinned.main.here) problems.push('the reader is in the main window as well')

      // 4. interactive: a click on the button inside the pinned reader, found by hit-testing
      const before = c.countText
      const click = await cjs(CLICK_AT('.rp-panel [data-count]'))
      await settle()
      const after = await cjs("document.querySelector('.rp-panel [data-count]').textContent")
      steps.interactive = { click, before, after }
      if (click !== 'ok' || before !== 'clicked 0 times' || after !== 'clicked 1 times') problems.push(`a click inside the pinned reader did not land: ${click}, "${before}" -> "${after}"`)

      // 5. the desk behind is still reachable where the reader is not
      const desk = await cjs(BESIDE)
      steps.deskBehind = desk
      if (!steps.opened.beside.backdrop) problems.push(`control: beside the CENTRED reader there was no backdrop (${steps.opened.beside.hit})`)
      if (desk.backdrop || !desk.inDeskWindowContent) problems.push(`beside the pinned reader the window's own content is not reachable: ${desk.hit} is there`)
      steps.interactive.png = await shot(child.webContents, '3-clicked-inside-pinned')
    }

    // 6. control: the main window's own reader, opened and pinned there
    // (not by hit-testing: before the fix the reader that left the popped-out window may lie over this button)
    await js("document.documentElement.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); document.querySelector('#card-main').click()")
    await until(() => js("!!document.querySelector('.rm-panel')"), 'the main window reader')
    await settle()
    const mpin = await js(CLICK_AT('.rm-panel .modalpin-btn'))
    await settle()
    steps.mainControl = { click: mpin, main: await js(LOOK('rm-panel')), child: await cjs(LOOK('rm-panel')) }
    steps.mainControl.png = await shot(wc, '4-main-window-reader-pinned')
    const m = steps.mainControl.main
    if (!(m.here && m.pinned && m.inPinLayer && m.inside && m.midHitsPanel) || steps.mainControl.child.here)
      problems.push('control: a reader pinned in the main window is not a visible pinned window in the org\'s pin layer there')

    const result = { label, status: problems.length ? 'FAIL' : 'PASS', problems, steps, sessionId: sid(process.pid), rendererSessionId: sid(wc.getOSProcessId()),
      muted: wc.isAudioMuted() && child.webContents.isAudioMuted(), clipboardCalls, errors }
    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(result, null, 2))
    console.log(`${result.status}: ${problems.length} problems`)
    for (const p of problems) console.log('  - ' + p)
    console.log('  opened  child ' + JSON.stringify(steps.opened.child))
    console.log('  pinned  child ' + JSON.stringify(steps.pinned.child))
    console.log('  pinned  main  ' + JSON.stringify(steps.pinned.main))
    if (steps.interactive) console.log('  inside  ' + JSON.stringify(steps.interactive) + ' desk ' + JSON.stringify(steps.deskBehind))
    console.log('  control main  ' + JSON.stringify(steps.mainControl.main))
    app.exit(problems.length ? 1 : 0)
  } catch (e) {
    console.error(e)
    try { fs.writeFileSync(path.join(out, 'failure.json'), JSON.stringify({ error: String(e), errors }, null, 2)) } catch {}
    app.exit(2)
  }
}).catch(e => { console.error(e); app.exit(2) })
