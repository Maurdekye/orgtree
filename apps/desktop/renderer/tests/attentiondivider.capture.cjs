// attentiondivider.capture.cjs — USER 2026-11-13 m525fd3e66e99: "let me drag the divider for one of the attention panels
// all the way to the side. in doing so, hide the panel that's shrunk to zero, and add a little button on the divider
// that when clicked, swaps the two windows visibly." Measured in a real Chromium window, with real mouse and key input
// sent to this script's own window:
//   1. both panels shown: the Swap panels button is on the divider, on top at its own middle
//   2. a drag to 15% stops the left panel at its 20% minimum; on to 5% it is hidden: out of sight (opacity 0), inert,
//      and the middle of the stage hit-tests to the OTHER panel, which now spans the stage; the button is whole
//      inside the window
//   3. the button, clicked: a slide is running (two animations of about 150 ms), then the hidden panel is the one in
//      view and the other is hidden; the divider did not move. Clicked again: back
//   4. a drag back in restores the hidden panel at its minimum, then on to 40%
//   5. both shown, the button: the panels trade places and the divider stays where it is (to the pixel)
//   6. keyboard on the divider: End hides the right panel, ArrowLeft brings it back, Home hides the left one
//   7. a reload shows the same hidden side (remembered)
//   8. reduced motion: the button swaps with no animation at all
//   9. the Agent desk popped out with its real button into a real second window: that window has no divider and no
//      button; the main window keeps its divider, the empty slot can be hidden so Needs attention spans the stage;
//      the panel returned to the main window comes back in view
//
//   electron.exe attentiondivider.capture.cjs <outDir> <repoRoot> <node_modules dir> <label>
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

    // 1. both shown
    const first = steps.initial = await look()
    steps.initial.png = await shot(wc, '1-both-shown')
    need(vis(first.queue) && vis(first.desk), 'at the start both panels are not in view')
    need(!!first.button, 'no Swap panels button on the divider')
    if (first.button) {
      need(first.button.label === 'Swap panels' && first.button.hitsItself && first.button.whole, `the button is not on top or not whole: ${JSON.stringify(first.button)}`)
      need(Math.abs(first.button.centre - (first.divider.box[0] + first.divider.box[2] / 2)) <= 1, `the button is not centred on the divider: ${first.button.centre} vs ${JSON.stringify(first.divider.box)}`)
    }

    // 2. drag to 15% (stops at 20%), then to 5% (hidden)
    const [at15, at5] = await dragDivider([W * 0.15, W * 0.05])
    const hiddenLeft = await look()
    steps.dragLeft = { at15: { queue: at15.queue, divider: at15.divider }, at5: { queue: at5.queue, layout: at5.layout }, after: hiddenLeft }
    steps.dragLeft.png = await shot(wc, '2-left-panel-hidden')
    need(vis(at15.queue) && Math.abs(at15.queue.box[2] - W * 0.2) <= 2, `at 15% the left panel is not held at its 20% minimum: ${JSON.stringify(at15.queue)}`)
    need(gone(at5.queue) && at5.layout.hidden == null, `at 5% the left panel is not hidden while dragging, or it was stored mid-drag: ${JSON.stringify([at5.queue, at5.layout])}`)
    need(gone(hiddenLeft.queue) && vis(hiddenLeft.desk) && hiddenLeft.layout.hidden === 'left', `after the drag the left panel is not hidden: ${JSON.stringify(hiddenLeft.layout)}`)
    need(hiddenLeft.atLeft === 'desk' && hiddenLeft.atMiddle === 'desk' && hiddenLeft.atRight === 'desk', `the visible panel does not span the stage: ${[hiddenLeft.atLeft, hiddenLeft.atMiddle, hiddenLeft.atRight]}`)
    need(hiddenLeft.desk.box[2] >= W - 8 && hiddenLeft.divider.box[0] <= 1, `the divider is not at the left edge: ${JSON.stringify([hiddenLeft.desk.box, hiddenLeft.divider.box])}`)
    need(hiddenLeft.button && hiddenLeft.button.whole && hiddenLeft.button.hitsItself, `the button is cut off or covered at the edge: ${JSON.stringify(hiddenLeft.button)}`)
    need(hiddenLeft.divider.text === 'Needs attention hidden', `the divider does not say what is hidden: ${hiddenLeft.divider.text}`)

    // 3. the button with one panel hidden, twice
    const s1 = await clickSwap()
    steps.swapHidden = { during: { animations: s1.during.animations }, after: s1.after }
    steps.swapHidden.png = await shot(wc, '3-swapped-while-hidden')
    need(s1.during.animations.length === 2 && s1.during.animations.every(ms => ms >= 120 && ms <= 200), `no slide of about 150 ms was running after the click: ${JSON.stringify(s1.during.animations)}`)
    need(vis(s1.after.queue) && gone(s1.after.desk) && s1.after.atMiddle === 'queue', `the hidden panel did not come into view: ${JSON.stringify([s1.after.queue, s1.after.desk, s1.after.atMiddle])}`)
    need(s1.after.layout.hidden === 'left' && s1.after.divider.box[0] === hiddenLeft.divider.box[0], 'the divider moved on swap')
    need(s1.after.animations.length === 0, 'the slide did not end')
    const s2 = await clickSwap()
    steps.swapHiddenBack = s2.after
    need(gone(s2.after.queue) && vis(s2.after.desk) && s2.after.atMiddle === 'desk', 'a second click did not go back')

    // 4. drag back in: 5% still hidden, 15% back at the minimum, then 40%
    const [in5, in15, in40] = await dragDivider([W * 0.05, W * 0.15, W * 0.4])
    const restored = await look()
    steps.dragBack = { in5: in5.queue, in15: in15.queue, in40: in40.queue, after: restored }
    need(gone(in5.queue), 'within 10% of the edge the panel came back early')
    need(vis(in15.queue) && Math.abs(in15.queue.box[2] - W * 0.2) <= 2, `dragged back in, the panel is not at its 20% minimum: ${JSON.stringify(in15.queue)}`)
    need(vis(restored.queue) && vis(restored.desk) && restored.layout.hidden == null && Math.abs(restored.queue.box[2] - W * 0.4) <= 2, `after dragging back the panels are not both shown at 40%: ${JSON.stringify([restored.queue, restored.layout])}`)
    need(restored.atLeft === 'queue' && restored.atRight === 'desk', 'the restored panel cannot be reached')

    // 5. the button with both shown
    const s3 = await clickSwap()
    steps.swapShown = { during: { animations: s3.during.animations }, after: s3.after }
    steps.swapShown.png = await shot(wc, '4-swapped-both-shown')
    need(s3.during.animations.length === 2, `no slide with both panels shown: ${JSON.stringify(s3.during.animations)}`)
    need(s3.after.atLeft === 'desk' && s3.after.atRight === 'queue', `the panels did not trade places: ${[s3.after.atLeft, s3.after.atRight]}`)
    need(JSON.stringify(s3.after.divider.box) === JSON.stringify(restored.divider.box), `the divider moved: ${JSON.stringify([restored.divider.box, s3.after.divider.box])}`)
    need(s3.after.button.centre === restored.button.centre, 'the button moved from under the pointer')

    // 6. keyboard
    wc.focus()
    await js("document.querySelector('.attn-divider').focus()")
    await key('End')
    const end = await look()
    await key('Left')
    const left = await look()
    await key('Home')
    const home = await look()
    steps.keys = { end: { layout: end.layout, queue: end.queue }, left: { layout: left.layout }, home: { layout: home.layout, desk: home.desk } }
    need(end.layout.hidden === 'right' && gone(end.queue) && vis(end.desk), `End did not hide the right panel: ${JSON.stringify(end.layout)}`)
    need(left.layout.hidden == null && vis(left.queue) && Math.abs(left.queue.box[2] - W * 0.2) <= 8, `ArrowLeft did not bring it back at its minimum: ${JSON.stringify([left.layout, left.queue])}`)
    need(home.layout.hidden === 'left' && gone(home.desk) && vis(home.queue), `Home did not hide the left panel: ${JSON.stringify(home.layout)}`)
    steps.keys.png = await shot(wc, '5-home-key-left-hidden-swapped')

    // 7. remembered across a reload
    await within(new Promise(r => { wc.once('did-finish-load', r); wc.reload() }), 15000, 'reload')
    await until(() => js("!!document.querySelector('.attn-divider')"), 'the view after a reload')
    await settle()
    const reloaded = steps.reloaded = await look()
    need(reloaded.layout.hidden === 'left' && reloaded.layout.swapped === true && gone(reloaded.desk) && vis(reloaded.queue), `the hidden side was not remembered: ${JSON.stringify(reloaded.layout)}`)

    // 8. reduced motion
    wc.debugger.attach('1.3')
    await wc.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
    const s4 = await clickSwap()
    await wc.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] })
    wc.debugger.detach()
    steps.reducedMotion = { during: { animations: s4.during.animations, queue: s4.during.queue, desk: s4.during.desk } }
    need(s4.during.animations.length === 0 && gone(s4.during.queue) && vis(s4.during.desk), `reduced motion still animated, or did not swap: ${JSON.stringify(steps.reducedMotion)}`)

    // 9. the Agent desk popped out into a real second window
    await js("document.querySelector('.attn-divider').focus()")
    await key('Right')                                    // both panels shown again: Needs attention left, Agent desk right
    const both = await look()
    need(both.layout.hidden == null && vis(both.queue) && vis(both.desk), `ArrowRight did not bring the hidden panel back: ${JSON.stringify(both.layout)}`)
    await js("document.querySelector('.attn-panel-desk .popout-button').click()", true)
    await until(() => !!child, 'a second window')
    const cjs = s => child.webContents.executeJavaScript(s, true)
    await until(() => cjs("!!document.querySelector('.attn-panel-desk')"), 'the Agent desk inside the second window')
    await settle()
    const inChild = await cjs("({ desk: !!document.querySelector('.attn-panel-desk'), divider: !!document.querySelector('.attn-divider'), swap: !!document.querySelector('.attn-swap'), window: [innerWidth, innerHeight] })")
    const mainOut = await look()
    steps.poppedOut = { child: inChild, childSession: sid(child.webContents.getOSProcessId()), main: mainOut }
    steps.poppedOut.childPng = await shot(child.webContents, '6-popped-out-desk-window')
    need(inChild.desk && !inChild.divider && !inChild.swap, `the popped-out window is not the desk alone: ${JSON.stringify(inChild)}`)
    need(!!mainOut.divider && !!mainOut.button && !mainOut.desk.panelInside, 'the main window lost its divider, or still holds the desk')
    // the empty slot is on the right: take the divider to the right edge
    await dragDivider([W * 0.97])
    const emptyHidden = await look()
    steps.poppedOut.emptySlotHidden = emptyHidden
    steps.poppedOut.mainPng = await shot(wc, '7-main-window-empty-slot-hidden')
    need(emptyHidden.layout.hidden === 'right' && emptyHidden.atLeft === 'queue' && emptyHidden.atRight === 'queue' && emptyHidden.queue.box[2] >= W - 8,
      `with the desk popped out, hiding its empty slot did not give Needs attention the stage: ${JSON.stringify([emptyHidden.layout, emptyHidden.queue.box])}`)
    need(await cjs("!!document.querySelector('.attn-panel-desk')"), 'hiding the empty slot disturbed the popped-out desk')
    // return it with its own button, in its own window
    await cjs("document.querySelector('.attn-panel-desk .popout-button').click()")
    await until(async () => (await look()).desk.panelInside, 'the desk back in the main window')
    await settle()
    const returned = steps.poppedOut.returned = await look()
    steps.poppedOut.returnedPng = await shot(wc, '8-desk-returned-in-view')
    need(returned.layout.hidden == null && vis(returned.desk) && vis(returned.queue) && returned.atRight === 'desk', `the returned desk is not in view: ${JSON.stringify([returned.layout, returned.desk])}`)

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
