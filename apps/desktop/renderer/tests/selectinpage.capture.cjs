// selectinpage.capture.cjs — USER 2026-11-19 m6a2395ab50fb "Everywhere": every dropdown draws its option list INSIDE the
// window, never as an OS pop-up (the pop-up took 0 of 20 controller clicks on the Steam Frame); look choices
// mf7601ffdfba7. Measured in a real Chromium window with real mouse and key input, on the fixture
// selectinpage.visual.tsx (the app's stylesheets, key module, modal frame, account select and presentation frame).
//
//  A. in the page: an option of an open list has a box, is what the pointer hits, and a click chooses it with one
//     change. The control: a select forced back to the OS pop-up has no option box in the page.
//  B. keys: closed Up/Down/Home/End change the value and pass over a disabled choice; Alt+Down and Enter open; Escape
//     closes the list and NOT the panel behind it, then closes the panel; Enter in a form opens nothing; Tab and
//     Shift+Tab take the highlighted choice and move focus on.
//  C. the wheel over an open list scrolls the list and does not reach the canvas behind.
//  D. placement: flips up at the bottom edge; a control in a narrow column stays inside it; on a scaled desk the list
//     is drawn at normal size next to its control; a disabled select does not open; a list box is untouched.
//  E. look: the list is the context menu's panel; the closed control follows its current choice with a floor.
//  F. a presentation frame: its select opens in the frame; a page that sets its own appearance keeps it.
//  G. a real popped-out window: opens, chooses and takes the closed-control keys there.
//
//   electron.exe selectinpage.capture.cjs <outDir> <repoRoot> <node_modules dir> <label>
//
// Session 0, hidden off-screen windows (the main one and the pop-out the fixture opens), muted, clipboard stubbed and
// denied, only file: data: blob: about: requests, no OS input: mouse and keys go to this script's own web contents.
// Writes only under <outDir>/<label>/.
const { app, BrowserWindow, session, clipboard } = require('electron')
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const [outArg, repoArg, depsArg, label = 'run'] = process.argv.slice(2)
const out = path.resolve(outArg, label), repo = path.resolve(repoArg), deps = path.resolve(depsArg)
const sid = pid => Number(execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Process -Id ${Number(pid)}).SessionId`], { encoding: 'utf8', windowsHide: true }).trim())
assert.equal(sid(process.pid), 0, 'Session 0 required before creating a window')
fs.mkdirSync(path.join(out, 'png'), { recursive: true })
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
      entryPoints: [path.join(repo, 'apps/desktop/renderer/tests/selectinpage.visual.tsx')],
      outfile: path.join(out, 'probe.js'), bundle: true, format: 'iife', platform: 'browser', jsx: 'automatic', logLevel: 'warning',
      nodePaths: [deps], loader: { '.png': 'dataurl', '.svg': 'dataurl', '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl' },
      define: { 'process.env.NODE_ENV': '"production"', __SRC_DIR__: '""' },
    })
  } finally { await esbuild.stop() }
  fs.writeFileSync(path.join(out, 'index.html'), '<!doctype html><html lang="en"><meta charset="utf-8"><link rel="stylesheet" href="probe.css"><body style="margin:0"><div id="root"></div><script src="probe.js"></script></body></html>')
}

// What the eye would check, read from whichever document it is evaluated in (the window, the pop-out, the frame).
const HELP = `(() => { if (window.__dd) return 1
  const R = r => ({ l: Math.round(r.left), t: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom), w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 })
  window.__dd = {
    state(id) { const s = document.getElementById(id); if (!s) return null
      let open = null; try { open = s.matches(':open') } catch (e) { open = 'n/a' }
      const rs = [...s.options].map(o => o.getBoundingClientRect()).filter(r => r.width > 0 && r.height > 0)
      const opts = rs.length ? { l: Math.round(Math.min(...rs.map(r => r.left))), t: Math.round(Math.min(...rs.map(r => r.top))), r: Math.round(Math.max(...rs.map(r => r.right))), b: Math.round(Math.max(...rs.map(r => r.bottom))), n: rs.length, rowH: Math.round(rs[0].height * 10) / 10 } : null
      const a = document.activeElement, sel = s.selectedOptions[0]
      return { value: s.value, open, focus: a ? (a.id || a.localName + (a.localName === 'option' ? ':' + a.value : '')) : null, ctl: R(s.getBoundingClientRect()), opts,
        selectedTop: sel ? Math.round(sel.getBoundingClientRect().top) : null, vw: innerWidth, vh: innerHeight, appearance: getComputedStyle(s).appearance } },
    optAt(id, value) { const s = document.getElementById(id); const o = [...s.options].find(o => o.value === value); const r = o.getBoundingClientRect()
      const x = r.left + r.width / 2, y = r.top + r.height / 2; const el = r.width > 0 ? document.elementFromPoint(x, y) : null
      return { x, y, w: r.width, h: r.height, hit: el ? el.localName + (el.localName === 'option' ? ':' + el.value : el.id ? '#' + el.id : '') : null } },
    look(id) { const s = document.getElementById(id); const probe = document.createElement('i'); document.body.appendChild(probe)
      const token = name => { probe.style.cssText = 'background:var(' + name + ')'; return getComputedStyle(probe).backgroundColor }
      const p = getComputedStyle(s, '::picker(select)'), icon = getComputedStyle(s, '::picker-icon'), o = s.selectedOptions[0], tick = o ? getComputedStyle(o, '::checkmark') : null
      const out = { panel: token('--panel'), accent: token('--accent'), hover: token('--panel-2'),
        list: { background: p.backgroundColor, radius: p.borderTopLeftRadius, border: p.borderTopWidth + ' ' + p.borderTopColor, shadow: p.boxShadow !== 'none', padding: p.paddingTop, appearance: p.appearance },
        icon: { clip: icon.clipPath.slice(0, 24), w: icon.width }, tick: tick ? { color: tick.color } : null,
        row: o ? { padding: getComputedStyle(o).paddingTop + ' ' + getComputedStyle(o).paddingLeft, radius: getComputedStyle(o).borderTopLeftRadius, size: getComputedStyle(o).fontSize } : null,
        control: { font: getComputedStyle(s).fontSize, minInline: getComputedStyle(s).minInlineSize } }
      probe.remove(); return out },
    centre(sel) { const e = document.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height } },
    app() { try { return JSON.parse(document.getElementById('state').textContent) } catch (e) { return null } },
  }; return 1 })()`

app.whenReady().then(async () => {
  const errors = [], run = { problems: [], facts: {} }
  try {
    await bundle()
    const ses = session.fromPartition('selectinpage-' + process.pid)
    ses.setPermissionCheckHandler(() => false); ses.setPermissionRequestHandler((_w, _p, done) => done(false))
    ses.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:|about:)/.test(d.url) }))
    const win = new BrowserWindow({ width: 1100, height: 760, useContentSize: true, show: false, frame: false,
      webPreferences: { session: ses, offscreen: true, backgroundThrottling: false, nodeIntegration: false, sandbox: true, contextIsolation: true } })
    const wc = win.webContents
    wc.setAudioMuted(true)
    let child = null
    wc.setWindowOpenHandler(({ url }) => url && url !== 'about:blank' ? { action: 'deny' } : { action: 'allow',
      overrideBrowserWindowOptions: { useContentSize: true, show: false, frame: false, paintWhenInitiallyHidden: true, webPreferences: { backgroundThrottling: false } } })
    const quiet = m => /Electron Security Warning/.test(m)
    wc.on('did-create-window', (w) => {
      child = w; w.webContents.setAudioMuted(true); w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      for (const k of ['copy', 'cut', 'paste', 'pasteAndMatchStyle']) w.webContents[k] = () => { throw Error('Clipboard denied') }
      w.webContents.on('console-message', (_e, level, message) => { if (level >= 2 && !quiet(message)) errors.push('popout: ' + message) })
    })
    for (const k of ['copy', 'cut', 'paste', 'pasteAndMatchStyle']) wc[k] = () => { throw Error('Clipboard denied') }
    wc.on('console-message', (_e, level, message) => { if (level >= 2 && !quiet(message)) errors.push(message) })
    const pause = ms => new Promise(r => setTimeout(r, ms))
    const until = async (fn, what, ms = 8000) => { const end = Date.now() + ms; for (;;) { if (await fn()) return; if (Date.now() > end) throw Error('Wait: ' + what); await pause(60) } }
    // one driver per document: the window, the pop-out, the frame
    const driver = (contents, evaluate, origin = { x: 0, y: 0 }) => {
      const js = code => evaluate(`${HELP}; ${code}`)
      const d = {
        js, st: id => js(`__dd.state(${JSON.stringify(id)})`), optAt: (id, v) => js(`__dd.optAt(${JSON.stringify(id)}, ${JSON.stringify(v)})`),
        key: async (keyCode, modifiers = [], ch) => { contents.sendInputEvent({ type: 'keyDown', keyCode, modifiers }); if (ch) contents.sendInputEvent({ type: 'char', keyCode: ch, modifiers }); contents.sendInputEvent({ type: 'keyUp', keyCode, modifiers }); await pause(260) },
        clickAt: async (x, y) => { x = Math.round(x + origin.x); y = Math.round(y + origin.y); contents.sendInputEvent({ type: 'mouseMove', x, y }); await pause(40)
          for (const type of ['mouseDown', 'mouseUp']) contents.sendInputEvent({ type, x, y, button: 'left', clickCount: 1 }); await pause(380) },
        wheel: async (x, y, deltaY) => { contents.sendInputEvent({ type: 'mouseWheel', x: Math.round(x + origin.x), y: Math.round(y + origin.y), deltaX: 0, deltaY, canScroll: true }); await pause(350) },
        open: async id => { const s = await d.st(id); await d.clickAt((s.ctl.l + s.ctl.r) / 2, (s.ctl.t + s.ctl.b) / 2); return d.st(id) },
        focus: id => js(`document.getElementById(${JSON.stringify(id)}).focus(); 0`),
      }
      return d
    }
    const M = driver(wc, code => wc.executeJavaScript(code, true))
    const shot = async (contents, name) => {
      try { await within(contents.executeJavaScript('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 150))))'), 3000, 'paint ' + name) } catch {}
      try { const img = await within(contents.capturePage(), 5000, 'capture ' + name); fs.writeFileSync(path.join(out, 'png', name + '.png'), img.toPNG()); return true } catch (e) { errors.push('capture ' + name + ': ' + e); return false }
    }
    const { problems, facts } = run
    const need = (ok, what) => { if (!ok) problems.push(what) }
    const J = JSON.stringify
    const appState = () => M.js('__dd.app()')

    await within(win.loadFile(path.join(out, 'index.html')), 15000, 'load')
    await until(() => M.js("!!document.getElementById('model')"), 'the settings panel')
    await pause(400)

    // ---- E. look, closed
    facts.look = await M.js(`__dd.look('model')`)
    need(facts.look.list.appearance === 'base-select', `E. the list is not the in-page one: ${J(facts.look.list)}`)
    need(facts.look.list.background === facts.look.panel, `E. the list's background ${facts.look.list.background} is not the panel's ${facts.look.panel}`)
    need(facts.look.list.radius === '8px' && facts.look.list.shadow, `E. the list's radius/shadow: ${J(facts.look.list)}`)
    need(facts.look.tick && facts.look.tick.color === facts.look.accent, `E. the tick is not the accent colour: ${J(facts.look.tick)} vs ${facts.look.accent}`)
    need(/^polygon/.test(facts.look.icon.clip), `E. the arrow is not the drawn chevron: ${J(facts.look.icon)}`)
    await M.focus('perm')
    const widths = {}
    for (const [k, v] of [['End', 'deny'], ['Home', 'ask'], ['Down', 'allow']]) { await M.key(k); const s = await M.st('perm'); need(s.value === v, `E. perm ${k} gave ${s.value}`); widths[v] = s.ctl.w }
    facts.widths = widths
    const floor = parseFloat(facts.look.control.font) * 4.5
    need(widths.allow > widths.ask + 60, `E. the closed control does not follow its choice: ${J(widths)}`)
    need(widths.ask >= floor - 1 && widths.deny >= floor - 1, `E. a short choice is narrower than the floor ${floor}: ${J(widths)}`)
    await M.key('Home')
    await shot(wc, '1-closed-controls-dark')

    // ---- A. in the page, with the mouse
    const before = await appState()
    facts.mouseOpen = await M.open('model')
    need(facts.mouseOpen.open === true && facts.mouseOpen.opts && facts.mouseOpen.opts.n === 7, `A. a click did not open an in-page list: ${J(facts.mouseOpen)}`)
    facts.mouseOption = await M.optAt('model', 'opus')
    need(facts.mouseOption.hit === 'option:opus', `A. the pointer over a choice does not hit it: ${J(facts.mouseOption)}`)
    facts.mouseDisabled = await M.optAt('model', 'sonnet')
    await shot(wc, '2-model-list-open-dark')
    await M.clickAt(facts.mouseOption.x, facts.mouseOption.y)
    { const s = await M.st('model'), a = await appState(); facts.mouseChosen = { value: s.value, open: s.open, changes: a.changes - before.changes, app: a.model }
      need(s.value === 'opus' && s.open === false && a.model === 'opus' && a.changes - before.changes === 1, `A. a click on a choice did not choose it once: ${J(facts.mouseChosen)}`) }

    // ---- B. keys on the closed control
    await M.focus('model')
    const keys = []
    for (const [k, mods, want] of [['Down', [], 'sol'], ['Up', [], 'opus'], ['End', [], 'hydrogen'], ['Home', [], 'fable'], ['PageDown', [], 'hydrogen'], ['PageUp', [], 'fable']]) {
      await M.key(k, mods); const s = await M.st('model'); keys.push({ key: k, value: s.value, open: s.open })
      need(s.value === want && s.open === false, `B. closed ${k}: ${J({ value: s.value, open: s.open })}, wanted ${want} and a closed list`)
    }
    { const a = await appState(); need(a.model === 'fable' && a.changes - before.changes === 7, `B. the app did not hear each key change once: ${J(a)}`) }
    await M.key('Down', ['alt'])
    { const s = await M.st('model'); keys.push({ key: 'Alt+Down', open: s.open, focus: s.focus }); need(s.open === true, `B. Alt+Down did not open the list`) }
    await M.key('Down')
    { const s = await M.st('model'); keys.push({ key: 'open Down', focus: s.focus, value: s.value }); need(s.focus === 'option:opus' && s.value === 'fable', `B. Down in the open list: ${J(s.focus)} / ${s.value}`) }
    await M.key('Escape')
    { const s = await M.st('model'), a = await appState(); keys.push({ key: 'open Escape', open: s && s.open, value: s && s.value, panelOpen: a.open })
      need(!!s && s.open === false && s.value === 'fable' && a.open === true, `B. Escape in the open list must close the list, change nothing and LEAVE THE PANEL: ${J(keys[keys.length - 1])}`) }
    await M.key('Enter')
    { const s = await M.st('model'); keys.push({ key: 'closed Enter', open: s.open }); need(s.open === true, `B. Enter did not open the list`) }
    await M.key('Down'); await M.key('Enter')
    { const s = await M.st('model'); keys.push({ key: 'open Down, Enter', value: s.value, open: s.open }); need(s.value === 'opus' && s.open === false, `B. Enter did not take the highlighted choice: ${J(s.value)}`) }
    await M.focus('inform'); await M.key('Enter')
    { const s = await M.st('inform'), a = await appState(); keys.push({ key: 'Enter in a form', open: s.open, submits: a.submits }); need(s.open === false, `B. Enter in a form opened the list`) }
    // Tab and Shift+Tab from the open list
    await M.focus('model'); await M.key('Home'); await M.key('Down', ['alt']); await M.key('Down'); await M.key('Tab'); await pause(200)
    { const s = await M.st('model'); keys.push({ key: 'open Tab', value: s.value, open: s.open, focus: s.focus })
      need(s.value === 'opus' && s.open === false && s.focus === 'perm', `B. Tab must take the highlighted choice and move to the next field: ${J(keys[keys.length - 1])}`) }
    await M.focus('perm'); await M.key('Down', ['alt']); await M.key('Down'); await M.key('Tab', ['shift']); await pause(200)
    { const s = await M.st('perm'); keys.push({ key: 'open Shift+Tab', value: s.value, open: s.open, focus: s.focus })
      need(s.value === 'allow' && s.open === false && s.focus === 'model', `B. Shift+Tab must take the highlighted choice and move back: ${J(keys[keys.length - 1])}`) }
    // Escape on the closed control is the panel's again
    await M.focus('model'); await M.key('Escape')
    { const a = await appState(); keys.push({ key: 'closed Escape', panelOpen: a.open }); need(a.open === false, `B. Escape on a closed dropdown no longer closes the panel`) }
    facts.keys = keys

    // ---- D. placement, on the canvas (the panel is closed: its backdrop would take these presses)
    { const o = await M.open('bottom'); facts.bottom = { ctl: o.ctl, opts: o.opts, vh: o.vh }
      need(o.open === true && o.opts && o.opts.b <= o.ctl.t + 1 && o.opts.t >= 0, `D. at the bottom edge the list must open upward inside the window: ${J(facts.bottom)}`)
      await shot(wc, '4-bottom-edge-opens-upward'); await M.key('Escape') }
    { await M.focus('narrow'); await M.key('End'); const s = await M.st('narrow'); const col = await M.js(`__dd.centre('#narrow-col')`)
      facts.narrow = { value: s.value, controlWidth: s.ctl.w, column: col.w }
      need(s.value === 'long' && s.ctl.w <= col.w + 0.5, `D. a long choice makes the control wider than its column: ${J(facts.narrow)}`)
      const o = await M.open('narrow'); facts.narrow.list = o.opts; need(o.open && o.opts.r <= o.vw && o.opts.l >= 0, `D. the narrow control's list leaves the window: ${J(o.opts)}`); await M.key('Escape'); await M.key('Home') }
    { const o = await M.open('desk'); const gap = Math.min(Math.abs(o.opts.t - o.ctl.b), Math.abs(o.ctl.t - o.opts.b))
      facts.desk = { ctl: o.ctl, opts: o.opts, gap }
      need(o.open === true && o.opts.rowH >= 24, `D. on a scaled desk the list must be drawn at normal size: ${J(facts.desk)}`)
      need(gap <= 12 && o.opts.t >= 0 && o.opts.b <= o.vh && o.opts.l >= 0 && o.opts.r <= o.vw, `D. on a scaled desk the list is not next to its control inside the window: ${J(facts.desk)}`)
      await shot(wc, '5-scaled-desk-list-normal-size'); await M.key('Escape') }
    { const s = await M.st('multi'); facts.listBox = { appearance: s.appearance, rows: s.opts && s.opts.n }
      need(s.appearance !== 'base-select' && s.opts && s.opts.n === 3, `D. the list box was changed: ${J(facts.listBox)}`) }
    // ---- F. a presentation frame. It is sandboxed, so it runs in its own process, and a hidden window does not route
    // sendInputEvent into such a frame (measured: a plain button in it gets no click, off-screen or not). Its input is
    // therefore dispatched to the frame's own widget through the debugger protocol: still real, trusted mouse and keys.
    { const fwin = new BrowserWindow({ width: 420, height: 300, useContentSize: true, show: false, frame: false, paintWhenInitiallyHidden: true,
        webPreferences: { session: ses, backgroundThrottling: false, nodeIntegration: false, sandbox: true, contextIsolation: true } })
      const fwc = fwin.webContents
      fwc.setAudioMuted(true); fwc.setWindowOpenHandler(() => ({ action: 'deny' }))
      for (const k of ['copy', 'cut', 'paste', 'pasteAndMatchStyle']) fwc[k] = () => { throw Error('Clipboard denied') }
      fwc.on('console-message', (_e, level, message) => { if (level >= 2 && !quiet(message)) errors.push('frame window: ' + message) })
      await within(fwin.loadFile(path.join(out, 'index.html'), { hash: 'frame' }), 15000, 'load the frame window')
      await until(() => fwc.mainFrame.framesInSubtree.length > 1, 'the presentation frame'); await pause(500)
      const frame = fwc.mainFrame.framesInSubtree.find(f => f !== fwc.mainFrame)
      const attached = []
      fwc.debugger.attach('1.3')
      fwc.debugger.on('message', (_e, method, params) => { if (method === 'Target.attachedToTarget') attached.push(params) })
      await fwc.debugger.sendCommand('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true })
      await until(() => attached.some(t => t.targetInfo.type === 'iframe'), 'the frame as a debugger target', 5000)
      const target = attached.find(t => t.targetInfo.type === 'iframe')
      const cdp = (method, params) => fwc.debugger.sendCommand(method, params, target.sessionId)
      const VK = { Down: ['ArrowDown', 40], Enter: ['Enter', 13], Escape: ['Escape', 27] }
      // the same driver, with the frame's own coordinates and its own input channel
      const F = driver({ sendInputEvent() { throw Error('the frame takes its input through the debugger') } }, code => frame.executeJavaScript(code, true))
      F.clickAt = async (x, y) => { x = Math.round(x); y = Math.round(y); await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }); await pause(40)
        await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }); await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }); await pause(380) }
      F.key = async (name, modifiers = []) => { const [key, code] = VK[name]; const m = modifiers.includes('alt') ? 1 : 0
        await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code: key, windowsVirtualKeyCode: code, modifiers: m }); await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: code, modifiers: m }); await pause(260) }
      const s0 = await F.st('fs'), own = await F.st('own')
      // the control for the input itself: a plain button in the frame must get the click
      const fb = await F.js(`__dd.centre('#fb')`); await F.clickAt(fb.x, fb.y)
      const mouseReaches = (await F.js(`Number(document.getElementById('fb').dataset.clicks || 0)`)) > 0
      const o = await F.open('fs'); const hit = await F.optAt('fs', 'two')
      await shot(fwc, '7-presentation-frame-list-open')
      await F.clickAt(hit.x, hit.y); const s1 = await F.st('fs')
      await F.focus('fs'); await F.key('Down', ['alt']); const k1 = await F.st('fs'); await F.key('Down'); await F.key('Enter'); const k2 = await F.st('fs')
      facts.frame = { sandboxedFrameInItsOwnProcess: frame.processId !== fwc.mainFrame.processId, appearance: s0.appearance, ownAppearance: own.appearance, mouseReachesTheFrame: mouseReaches,
        open: o.open, rows: o.opts && o.opts.n, hit: hit.hit, clicked: s1.value, keys: { altDownOpens: k1.open, downEnter: k2.value, open: k2.open } }
      need(mouseReaches, `F. control failed: the mouse does not reach the frame, so F proves nothing`)
      need(s0.appearance === 'base-select' && o.open === true && hit.hit === 'option:two' && s1.value === 'two' && s1.open === false, `F. the frame's dropdown is not in the page: ${J(facts.frame)}`)
      need(k1.open === true && k2.value === 'three' && k2.open === false, `F. the frame's dropdown does not take the keys: ${J(facts.frame.keys)}`)
      need(own.appearance === 'auto', `F. a page's own appearance was overridden: ${own.appearance}`)
      try { fwc.debugger.detach() } catch {}
      fwin.destroy() }

    // ---- the panel again, for what stands in it
    { const c = await M.js(`__dd.centre('#open-modal')`); await M.clickAt(c.x, c.y) }
    await until(() => M.js("!!document.getElementById('model')"), 'the settings panel again')
    await pause(300)

    // ---- C. the wheel
    { const o = await M.open('long'); need(o.open === true, `C. the long list did not open`)
      const a0 = await appState(), mid = { x: (o.opts.l + o.opts.r) / 2, y: o.selectedTop + 12 }   // on the chosen row, wherever the list opened
      await shot(wc, '3-long-list-open-dark')
      await M.wheel(mid.x, mid.y, -240)
      const s = await M.st('long'), a1 = await appState()
      facts.wheel = { selectedTopBefore: o.selectedTop, after: s.selectedTop, canvasSaw: a1.wheel - a0.wheel, stillOpen: s.open, listFrom: o.opts.t, controlBottom: o.ctl.b }
      need(s.open === true && s.selectedTop !== o.selectedTop, `C. the wheel did not scroll the open list: ${J(facts.wheel)}`)
      need(a1.wheel === a0.wheel, `C. a wheel turn over the open list reached the canvas behind it: ${J(facts.wheel)}`)
      need(o.selectedTop >= 0 && o.selectedTop < o.vh - 20, `C. the chosen row is not in view when the long list opens: ${J(facts.wheel)}`)
      await M.key('Escape')
      const c = await M.js(`__dd.centre('#next')`); await M.wheel(c.x - 200, c.y, -120)
      const a2 = await appState(); facts.wheel.controlSawClosed = a2.wheel - a1.wheel
      need(a2.wheel > a1.wheel, `C. control failed: a wheel turn with no list open should reach the canvas (${a2.wheel - a1.wheel})`) }

    // ---- D, in the panel
    { const s0 = await M.st('off'); await M.clickAt((s0.ctl.l + s0.ctl.r) / 2, (s0.ctl.t + s0.ctl.b) / 2); const s = await M.st('off'); facts.disabled = { open: s.open }
      need(s.open === false, `D. a disabled dropdown opened`) }
    // the account select: a long identity in a settings row
    { const acc = await M.js(`(() => { const s = document.querySelector('.account-choice select'); s.id = 'account'; return 1 })()`); void acc
      const o = await M.open('account'); facts.account = { ctl: o.ctl, opts: o.opts }
      need(o.open === true && o.opts.r <= o.vw && o.opts.l >= 0, `D. the account list leaves the window: ${J(facts.account)}`)
      await shot(wc, '6-account-list-open'); await M.key('Escape') }

    // ---- look in the other themes
    for (const [cls, name] of [['contrast-light', '8-model-list-open-light'], ['contrast-obsidian-black', '9-model-list-open-obsidian']]) {
      await M.js(`document.documentElement.className = ${J(cls)}; 0`); await pause(250)
      const o = await M.open('model'); need(o.open === true, `look: the list did not open in ${cls}`)
      const look = await M.js(`__dd.look('model')`); facts['look-' + cls] = { list: look.list.background, panel: look.panel }
      need(look.list.background === look.panel, `look: in ${cls} the list's background ${look.list.background} is not the panel's ${look.panel}`)
      await shot(wc, name); await M.key('Escape')
    }
    await M.js(`document.documentElement.className = ''; 0`); await pause(200)

    // ---- G. a real popped-out window
    { const b = await M.js(`__dd.centre('.modalpin-bar [aria-label="Open in new window"]')`)
      need(!!b, 'G. the panel has no pop-out button')
      if (b) {
        await M.clickAt(b.x, b.y)
        await until(async () => !!child && !child.isDestroyed() && await child.webContents.executeJavaScript("!!document.getElementById('model')").catch(() => false), 'the panel in its own window', 10000)
        await pause(600)
        const cwc = child.webContents
        const C = driver(cwc, code => cwc.executeJavaScript(code, true))
        const a0 = await appState(), s0 = await C.st('model')
        const o = await C.open('model'); const hit = await C.optAt('model', 'sol')
        await shot(cwc, '10-popped-out-window-list-open')
        await C.clickAt(hit.x, hit.y); const s1 = await C.st('model')
        await C.focus('model'); await C.key('Down'); const s2 = await C.st('model')
        await C.key('Down', ['alt']); await C.key('Down'); await C.key('Escape'); const s3 = await C.st('model'); const a1 = await appState()
        facts.popout = { size: [s0.vw, s0.vh], appearance: s0.appearance, open: o.open, rows: o.opts && o.opts.n, hit: hit.hit, clicked: s1.value, afterDown: { value: s2.value, open: s2.open },
          afterEscape: { open: s3 && s3.open, value: s3 && s3.value, panelStillThere: !!s3 }, changesHeard: a1.changes - a0.changes, mainStillHasPanel: await M.js("!!document.getElementById('model')") }
        need(o.open === true && hit.hit === 'option:sol' && s1.value === 'sol', `G. in the popped-out window the list is not in the page: ${J(facts.popout)}`)
        need(s2.value === 'terra' && s2.open === false, `G. the popped-out window lacks the closed-control keys: ${J(facts.popout.afterDown)}`)
        need(!!s3 && s3.open === false && s3.value === 'terra', `G. Escape in the popped-out window's open list closed more than the list: ${J(facts.popout.afterEscape)}`)
        need(a1.changes - a0.changes === 2, `G. the app heard ${a1.changes - a0.changes} changes from the popped-out window, wanted 2`)
      } }

    // ---- the control for A, last: forced back to the OS pop-up, a select has no option box in the page
    { const o = await M.open('native-control'); facts.nativeControl = { appearance: o.appearance, opts: o.opts }
      need(o.appearance === 'auto' && o.opts === null, `control failed: a native select shows option boxes in the page (${J(facts.nativeControl)}), so A proves nothing`)
      await M.key('Escape') }

    const result = { label, status: problems.length ? 'FAIL' : 'PASS', problems, facts, versions: { electron: process.versions.electron, chrome: process.versions.chrome },
      sessionId: sid(process.pid), rendererSessionId: sid(wc.getOSProcessId()), muted: wc.isAudioMuted(), clipboardCalls, errors,
      pngs: fs.readdirSync(path.join(out, 'png')).sort() }
    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(result, null, 2))
    console.log(`${result.status}: ${problems.length} problems (Electron ${process.versions.electron}, Chromium ${process.versions.chrome})`)
    for (const p of problems) console.log('  - ' + p)
    app.exit(problems.length ? 1 : 0)
  } catch (e) {
    console.error(e)
    try { fs.writeFileSync(path.join(out, 'failure.json'), JSON.stringify({ error: String(e && e.stack || e), errors, problems: run.problems, facts: run.facts }, null, 2)) } catch {}
    app.exit(2)
  }
}).catch(e => { console.error(e); app.exit(2) })
