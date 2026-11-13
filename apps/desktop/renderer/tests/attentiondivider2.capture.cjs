// attentiondivider2.capture.cjs — the follow-ups of USER 2026-11-13 mb445dc041229, m80a0aa581880, mfc2dce66b9f3,
// me8b3377fe2b4: the divider and its Swap panels button are ONE hover target; a press is a click (swaps) or a drag.
//   1. pointer away: the button is not visible (opacity 0)
//   2. pointer on the divider: the grip is in its hover state and the button is shown
//   3. pointer on the button: the same look as 2 (button opacity, box, grip height and colour)
//   4. a drag that starts on the button moves the divider and does not swap
//   5. a click on the divider swaps and leaves the divider where it is
//   electron.exe attentiondivider2.capture.cjs <outDir> <repoRoot> <node_modules dir> <label>
// Session 0, hidden off-screen window, muted, clipboard stubbed and denied, input only to this script's own web contents.
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
let W = 1100; const H = 760

async function bundle() {
  const esbuild = require(path.join(deps, 'esbuild'))
  try {
    await esbuild.build({
      entryPoints: [path.join(repo, 'apps/desktop/renderer/tests/attentiondivider.visual.tsx')],
      outfile: path.join(out, 'probe.js'), bundle: true, format: 'iife', platform: 'browser', jsx: 'automatic', logLevel: 'warning',
      nodePaths: [deps], loader: { '.png': 'dataurl', '.svg': 'dataurl', '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl' },
      define: { 'process.env.NODE_ENV': '"production"', __SRC_DIR__: '""' },
    })
  } finally { await esbuild.stop() }
  fs.writeFileSync(path.join(out, 'index.html'), '<!doctype html><html lang="en"><meta charset="utf-8"><link rel="stylesheet" href="probe.css"><body style="margin:0"><div id="root"></div><script src="probe.js"></script></body></html>')
}

// Everything the eye would check, read from the document: where each slot, the divider and the button are, whether a
// slot can be seen and reached (a box that intersects the window can still be behind something, so the middle of the
// stage is hit-tested), and what is remembered.
const LOOK = `(() => {
  const box = el => { if (!el) return null; const r = el.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] }
  const slot = name => {
    const el = document.querySelector('.attn-slot-' + name); if (!el) return null
    const cs = getComputedStyle(el)
    return { box: box(el), hiddenClass: el.classList.contains('attn-slot-hidden'), inert: el.hasAttribute('inert'), opacity: cs.opacity,
      panelInside: !!el.querySelector('.attn-panel-' + name) }
  }
  const stage = document.querySelector('.attn-stage'), sr = stage.getBoundingClientRect()
  const at = (x, y) => { const hit = document.elementFromPoint(x, y); const s = hit && hit.closest('.attn-slot')
    return !hit ? null : hit.closest('.attn-swap') ? 'swap' : hit.closest('.attn-divider') ? 'divider' : s ? (s.classList.contains('attn-slot-queue') ? 'queue' : 'desk') : hit.tagName + '.' + String(hit.className).slice(0, 40) }
  const button = document.querySelector('button.attn-swap'), br = button && button.getBoundingClientRect()
  const divider = document.querySelector('.attn-divider')
  return { window: [innerWidth, innerHeight], stage: box(stage), queue: slot('queue'), desk: slot('desk'),
    divider: divider && { box: box(divider), now: divider.getAttribute('aria-valuenow'), text: divider.getAttribute('aria-valuetext') },
    button: button && { box: box(button), label: button.getAttribute('aria-label'), hitsItself: at(br.left + br.width / 2, br.top + br.height / 2) === 'swap',
      whole: br.left >= 0 && br.right <= innerWidth && br.width >= 12, centre: Math.round(br.left + br.width / 2) },
    atLeft: at(sr.left + sr.width * 0.12, sr.top + sr.height * 0.3), atMiddle: at(sr.left + sr.width * 0.5, sr.top + sr.height * 0.3), atRight: at(sr.left + sr.width * 0.88, sr.top + sr.height * 0.3),
    animations: document.getAnimations().filter(a => a.effect && a.effect.target && a.effect.target.classList.contains('attn-slot')).map(a => Math.round(a.effect.getTiming().duration)),
    layout: window.attnLayout(), focusIn: document.activeElement && (document.activeElement.closest('.attn-slot') ? (document.activeElement.closest('.attn-slot-queue') ? 'queue' : 'desk') : document.activeElement.className) }
})()`

app.whenReady().then(async () => {
  const errors = []
  try {
    await bundle()
    const ses = session.fromPartition('attndivider-' + process.pid)
    ses.setPermissionCheckHandler(() => false); ses.setPermissionRequestHandler((_w, _p, done) => done(false))
    ses.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:|about:)/.test(d.url) }))
    const win = new BrowserWindow({ width: W, height: H, useContentSize: true, show: false, frame: false,
      webPreferences: { session: ses, offscreen: true, backgroundThrottling: false, nodeIntegration: false, sandbox: true, contextIsolation: true } })
    const wc = win.webContents
    wc.setAudioMuted(true)
    let child = null
    wc.setWindowOpenHandler(({ url }) => url && url !== 'about:blank' ? { action: 'deny' } : { action: 'allow',
      overrideBrowserWindowOptions: { width: 700, height: 600, useContentSize: true, show: false, frame: false, paintWhenInitiallyHidden: true,
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
    const dragDivider = async (stops) => {
      const d = (await look()).divider.box, y = d[1] + d[3] * 0.25      // away from the button in the middle
      mouse('mouseMove', d[0] + d[2] / 2, y); await pause(40)
      mouse('mouseDown', d[0] + d[2] / 2, y); await pause(60)
      const seen = []
      for (const x of stops) { mouse('mouseMove', x - 1, y, { modifiers: ['leftButtonDown'] }); await pause(60); mouse('mouseMove', x, y, { modifiers: ['leftButtonDown'] }); await pause(160); seen.push({ x, ...(await look()) }) }
      mouse('mouseUp', stops[stops.length - 1], y); await settle()
      return seen
    }
    const clickSwap = async () => {
      const b = (await look()).button.box, x = b[0] + b[2] / 2, y = b[1] + b[3] / 2
      mouse('mouseMove', x, y); await pause(30); mouse('mouseDown', x, y); mouse('mouseUp', x, y)
      await pause(45)
      const during = await look()
      await settle()
      return { during, after: await look() }
    }
    const key = async (keyCode) => { wc.sendInputEvent({ type: 'keyDown', keyCode }); wc.sendInputEvent({ type: 'keyUp', keyCode }); await settle() }
    fs.mkdirSync(path.join(out, 'png'), { recursive: true })
    await within(win.loadFile(path.join(out, 'index.html')), 15000, 'load')
    await until(() => js("!!document.querySelector('.attn-divider') && !!document.querySelector('.attn-panel-desk')"), 'the Attention view')
    await settle()
    const problems = [], steps = {}
    W = await js('innerWidth')          // an off-screen window is the size Chromium gives it
    const need = (ok, what) => { if (!ok) problems.push(what) }
    const vis = s => !!s && !s.hiddenClass && !s.inert && Number(s.opacity) > 0.99
    const gone = s => !!s && s.hiddenClass && s.inert && Number(s.opacity) === 0 && s.panelInside

    const GRIP = `(() => { const g = document.querySelector('.attn-divider-grip'), b = document.querySelector('button.attn-swap')
      const gs = getComputedStyle(g), bs = getComputedStyle(b), r = b.getBoundingClientRect(), d = document.querySelector('.attn-divider').getBoundingClientRect()
      return { gripHeight: Math.round(g.getBoundingClientRect().height), gripBg: gs.backgroundColor, btnOpacity: Number(bs.opacity), btnBg: bs.backgroundColor,
        btnBorder: bs.borderColor, btnColor: bs.color, btnBox: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
        dividerLeft: Math.round(d.left), layout: window.attnLayout() } })()`
    const grip = () => js(GRIP)
    const problems = [], steps = {}
    W = await js('innerWidth')
    const need = (ok, what) => { if (!ok) problems.push(what) }
    const btn = async () => { const b = (await grip()).btnBox; return [b[0] + b[2] / 2, b[1] + b[3] / 2] }

    mouse('mouseMove', 40, 40); await settle()
    const away = steps.away = await grip(); steps.away.png = await shot(wc, '1-pointer-away')
    need(away.btnOpacity === 0, `away from the divider the button is visible: opacity ${away.btnOpacity}`)
    const d = (await look()).divider.box, dy = d[1] + d[3] * 0.25
    mouse('mouseMove', d[0] + d[2] / 2, dy); await settle()
    const onDiv = steps.onDivider = await grip(); steps.onDivider.png = await shot(wc, '2-pointer-on-divider')
    need(onDiv.btnOpacity === 1, `on the divider the button is not shown: ${onDiv.btnOpacity}`)
    need(onDiv.gripHeight > away.gripHeight && onDiv.gripBg !== away.gripBg, `the divider grip has no hover state: ${JSON.stringify([away.gripHeight, onDiv.gripHeight])}`)
    const [bx, by] = await btn()
    mouse('mouseMove', bx, by); await settle()
    const onBtn = steps.onButton = await grip(); steps.onButton.png = await shot(wc, '3-pointer-on-button')
    const same = ['gripHeight', 'gripBg', 'btnOpacity', 'btnBg', 'btnBorder', 'btnColor'].every(k => onBtn[k] === onDiv[k]) && JSON.stringify(onBtn.btnBox) === JSON.stringify(onDiv.btnBox)
    need(same, `the button hover differs from the divider hover: ${JSON.stringify([onDiv, onBtn])}`)

    // 4. a drag that starts on the button
    mouse('mouseDown', bx, by); await pause(60)
    for (const x of [bx - 40, bx - 120, W * 0.3]) { mouse('mouseMove', x, by, { modifiers: ['leftButtonDown'] }); await pause(80) }
    await pause(200)
    const dragging = steps.dragFromButton = await grip(); steps.dragFromButton.png = await shot(wc, '4-drag-from-button')
    mouse('mouseUp', W * 0.3, by); await settle()
    const dragged = steps.afterDrag = await grip()
    need(dragging.btnOpacity === 1, 'the button is not shown during the drag')
    need(!dragged.layout.swapped && Math.abs(dragged.layout.split - 0.3) < 0.02, `a drag from the button did not move the divider without swapping: ${JSON.stringify(dragged.layout)}`)

    // 5. a click on the divider swaps and leaves it in place
    const before = await grip(); const dd = (await look()).divider.box, cy = dd[1] + dd[3] * 0.25, cx = dd[0] + dd[2] / 2
    mouse('mouseMove', cx, cy); await pause(40); mouse('mouseDown', cx, cy); mouse('mouseUp', cx, cy); await settle()
    const clicked = steps.clickDivider = await grip(); steps.clickDivider.png = await shot(wc, '5-after-click-on-divider')
    need(clicked.layout.swapped === true && clicked.dividerLeft === before.dividerLeft, `a click on the divider did not swap in place: ${JSON.stringify([before.dividerLeft, clicked.dividerLeft, clicked.layout])}`)

    const result = { label, status: problems.length ? 'FAIL' : 'PASS', problems, steps, sessionId: sid(process.pid), rendererSessionId: sid(wc.getOSProcessId()),
      muted: wc.isAudioMuted(), clipboardCalls, errors }
    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(result, null, 2))
    console.log(`${result.status}: ${problems.length} problems`)
    for (const p of problems) console.log('  - ' + p)
    console.log('  errors ' + JSON.stringify(errors).slice(0, 600))
    app.exit(problems.length ? 1 : 0)
  } catch (e) {
    console.error(e)
    try { fs.writeFileSync(path.join(out, 'failure.json'), JSON.stringify({ error: String(e), errors }, null, 2)) } catch {}
    app.exit(2)
  }
}).catch(e => { console.error(e); app.exit(2) })
