// attentionswapedge.capture.cjs — Swap edge in the attention divider's menu (USER 2026-11-14 mc82a540f42fd): an
// entry that is there only while the divider stands at the left or right edge; it takes the divider to the opposite
// edge and the same panel stays in view.
//   1. both panels shown: the menu has Swap panels and Reset to center, no Swap edge
//   2. the divider dragged to the left edge: the menu has Swap edge between them
//   3. Swap edge chosen: the divider is at the right edge, the Agent desk still fills the view, nothing slid
//   4. the menu at the right edge has Swap edge too; chosen again, the divider is back at the left edge
//   5. dragged back in from the edge: both panels, and the menu has no Swap edge
//   electron.exe attentionswapedge.capture.cjs <outDir> <repoRoot> <node_modules dir> <label>
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
app.disableHardwareAcceleration(); app.commandLine.appendSwitch('mute-audio'); app.commandLine.appendSwitch('blink-settings', 'primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4')
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
    const ses = session.fromPartition('attnswapedge-' + process.pid)
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
    // a hidden off-screen Chromium may report (hover: none), which would pin the button visible: ask for a hovering device
    try { wc.debugger.attach('1.3'); await wc.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'hover', value: 'hover' }, { name: 'pointer', value: 'fine' }] }) } catch (e) { errors.push('emulate: ' + e) }
    steps.hoverNone = await js("matchMedia('(hover: none)').matches")
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
    const btn = async () => { const b = (await grip()).btnBox; return [b[0] + b[2] / 2, b[1] + b[3] / 2] }

    const menuNow = () => js("[...document.querySelectorAll('.ctxmenu button')].map(b => b.textContent.trim())")
    const closeMenu = async () => { await js("document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))"); await settle() }
    // a REAL right-click on the divider, away from the button in its middle
    const rightClick = async () => {
      const g = (await look()).divider.box, x = g[0] + g[2] / 2, y = g[1] + g[3] * 0.25
      mouse('mouseMove', x, y); await pause(100)
      mouse('mouseDown', x, y, { button: 'right' }); mouse('mouseUp', x, y, { button: 'right' }); await settle()
      return menuNow()
    }
    // a REAL click on the entry of that name; what the stage looks like right after it, and settled
    const choose = async (name) => {
      const b = await js(`(() => { const e = [...document.querySelectorAll('.ctxmenu button')].find(b => b.textContent.trim() === ${JSON.stringify(name)}); if (!e) return null
        const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2] })()`)
      if (!b) throw Error('no menu entry ' + name)
      mouse('mouseMove', b[0], b[1]); await pause(60); mouse('mouseDown', b[0], b[1]); mouse('mouseUp', b[0], b[1])
      await pause(45)
      const during = await look()
      await settle()
      return { during, after: await look() }
    }
    const TWO = JSON.stringify(['Swap panels', 'Reset to center']), THREE = JSON.stringify(['Swap panels', 'Swap edge', 'Reset to center'])
    const edgeOf = l => { const d = l.divider.box, s = l.stage; return d[0] - s[0] <= 2 ? 'left' : (s[0] + s[2]) - (d[0] + d[2]) <= 2 ? 'right' : 'inside' }

    // 1. both panels shown
    steps.bothShown = { entries: await rightClick(), look: await look() }
    steps.bothShown.png = await shot(wc, '1-both-shown-menu')
    need(JSON.stringify(steps.bothShown.entries) === TWO, `with both panels shown the menu is ${JSON.stringify(steps.bothShown.entries)}`)
    need(vis(steps.bothShown.look.queue) && vis(steps.bothShown.look.desk), 'the two panels are not both shown at the start')
    await closeMenu()

    // 2. dragged to the left edge
    await dragDivider([W * 0.3, W * 0.15, 12])
    const atLeft = steps.atLeftEdge = { look: await look() }
    need(gone(atLeft.look.queue) && vis(atLeft.look.desk) && atLeft.look.layout.hidden === 'left' && edgeOf(atLeft.look) === 'left',
      `the drag did not hide the left panel: ${JSON.stringify([atLeft.look.layout, edgeOf(atLeft.look)])}`)
    atLeft.entries = await rightClick()
    atLeft.png = await shot(wc, '2-left-edge-menu')
    need(JSON.stringify(atLeft.entries) === THREE, `at the left edge the menu is ${JSON.stringify(atLeft.entries)}`)

    // 3. Swap edge
    const first = steps.swapEdge = await choose('Swap edge')
    first.png = await shot(wc, '3-after-swap-edge')
    need(edgeOf(first.after) === 'right', `the divider is not at the right edge: ${JSON.stringify([first.after.divider, first.after.stage])}`)
    need(gone(first.after.queue) && vis(first.after.desk), 'the Agent desk is not the panel in view after Swap edge')
    need(first.after.layout.hidden === 'right' && first.after.layout.swapped === true, `remembered: ${JSON.stringify(first.after.layout)}`)
    need(first.after.atLeft === 'desk' && first.after.atMiddle === 'desk', `what is under the pointer on the stage: ${JSON.stringify([first.after.atLeft, first.after.atMiddle, first.after.atRight])}`)
    need(first.during.animations.length === 0, `Swap edge slid a panel: ${JSON.stringify(first.during.animations)}`)
    need(first.after.divider.text === 'Needs attention hidden', `the divider says ${first.after.divider.text}`)

    // 4. the menu at the right edge, and back
    const atRight = steps.atRightEdge = { entries: await rightClick() }
    atRight.png = await shot(wc, '4-right-edge-menu')
    need(JSON.stringify(atRight.entries) === THREE, `at the right edge the menu is ${JSON.stringify(atRight.entries)}`)
    const second = steps.swapEdgeBack = await choose('Swap edge')
    second.png = await shot(wc, '5-swap-edge-again')
    need(edgeOf(second.after) === 'left' && gone(second.after.queue) && vis(second.after.desk)
      && second.after.layout.hidden === 'left' && second.after.layout.swapped === false,
      `a second Swap edge did not go back: ${JSON.stringify([second.after.layout, edgeOf(second.after)])}`)

    // 5. dragged back in: no Swap edge
    await dragDivider([W * 0.2, W * 0.4])
    const back = steps.backIn = { look: await look() }
    need(vis(back.look.queue) && vis(back.look.desk) && back.look.layout.hidden === null, `dragging back in did not show both: ${JSON.stringify(back.look.layout)}`)
    back.entries = await rightClick()
    back.png = await shot(wc, '6-back-in-menu')
    need(JSON.stringify(back.entries) === TWO, `after dragging back in the menu is ${JSON.stringify(back.entries)}`)
    await closeMenu()

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
