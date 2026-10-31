// tools/rig/desktop/main.cjs: the rig's desktop smoke, run by electron.exe
// (tools/rig/desktop.mjs starts it). Loads the scratch engine's real
// renderer bundle in an OFFSCREEN window (reliable captures in session 0),
// signs engine requests with the run's token exactly as the desktop does
// (session.webRequest), and runs a page script with a small driver whose
// clicks, keys and text go through CDP Input.dispatch* (trusted events).
//
// Everything comes from the environment (an http:// argument makes
// electron.exe exit before the script runs): RIG_DESKTOP_URL, _TOKEN, _ORG,
// _SCRIPT, _OUT, _PROFILE, _PRESET (short|tall|wide|WxH), _TIMEOUT_MS.
//
// Always silent and off the real clipboard (guards.cjs): Chromium starts with
// --mute-audio and the window is muted, every clipboard permission request
// and check is denied, an in-memory navigator.clipboard and a no-op
// execCommand copy/cut/paste run at document start, there is no application
// menu (no copy/paste accelerators), and the driver refuses copy/paste keys
// (Shift+Delete too) and clipboard CDP grants. result.json records the guards.
//
// Not covered: the desktop main process (tray, pop-outs, native menus,
// window controls), native <select> popups and OS drag and drop (Chromium
// draws those outside the page), and real Windows DPI (the window runs at
// device scale factor 1).
'use strict'
const { app, BrowserWindow, Menu, session } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const guards = require('./guards.cjs')

const E = process.env
const OUT = E.RIG_DESKTOP_OUT
const BASE = new URL(E.RIG_DESKTOP_URL)
const TOKEN = E.RIG_DESKTOP_TOKEN
fs.mkdirSync(OUT, { recursive: true })
const log = (...a) => { try { fs.appendFileSync(path.join(OUT, 'desktop.log'), `${new Date().toISOString()} ${a.join(' ')}\n`) } catch { /* best effort */ } }
const PRESETS = { short: [1366, 768], tall: [1440, 1600], wide: [1920, 1080] }
const sizeOf = p => PRESETS[p] ?? (/^\d+x\d+$/.test(p ?? '') ? p.split('x').map(Number) : PRESETS.short)

log('main start', process.versions.electron)
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('force-device-scale-factor', '1')
app.commandLine.appendSwitch(guards.MUTE_SWITCH)
for (const k of ['userData', 'sessionData', 'cache', 'crashDumps', 'logs']) {
  try { app.setPath(k, path.join(E.RIG_DESKTOP_PROFILE, k)) } catch (e) { log('setPath', k, e.message) }
}

const sleep = ms => new Promise(r => setTimeout(r, ms))
const KEYS = {
  Enter: { code: 'Enter', key: 'Enter', vk: 13, text: '\r' }, Escape: { code: 'Escape', key: 'Escape', vk: 27 },
  Tab: { code: 'Tab', key: 'Tab', vk: 9 }, Backspace: { code: 'Backspace', key: 'Backspace', vk: 8 },
  ArrowUp: { code: 'ArrowUp', key: 'ArrowUp', vk: 38 }, ArrowDown: { code: 'ArrowDown', key: 'ArrowDown', vk: 40 },
  ArrowLeft: { code: 'ArrowLeft', key: 'ArrowLeft', vk: 37 }, ArrowRight: { code: 'ArrowRight', key: 'ArrowRight', vk: 39 },
  Space: { code: 'Space', key: ' ', vk: 32, text: ' ' }, Delete: { code: 'Delete', key: 'Delete', vk: 46 },
}

function driver(win) {
  const wc = win.webContents
  const dbg = wc.debugger
  const consoleErrors = []
  const shots = []
  let frame = null
  wc.on('paint', (_e, _dirty, image) => { frame = image })
  wc.on('console-message', (_e, level, message) => { if (level >= 2) consoleErrors.push(String(message).slice(0, 500)) })
  wc.on('render-process-gone', (_e, d) => log('RENDERER GONE', JSON.stringify(d)))
  const cdp = (method, params = {}) => {
    if (guards.refusedCdp(method, params)) return Promise.reject(new Error(`refused: ${method} would reach the real clipboard`))
    return dbg.sendCommand(method, params)
  }
  const evaluate = async (fn, ...args) => wc.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`, true)

  // Find one visible element: a CSS selector, {text} (innermost visible element
  // whose trimmed text equals / matches it), or both. Returns its box.
  const locate = target => evaluate((t) => {
    const visible = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' }
    const want = t.text === undefined ? null : t.regex ? new RegExp(t.text, t.flags || '') : null
    const hit = (e) => { if (t.text === undefined) return true; const s = (e.innerText ?? e.textContent ?? '').trim(); return want ? want.test(s) : s === t.text }
    let els = [...document.querySelectorAll(t.selector || '*')].filter((e) => visible(e) && hit(e))
    if (t.text !== undefined) els = els.filter((e) => ![...e.children].some((c) => visible(c) && hit(c)))
    const e = els[t.index || 0]
    if (!e) return null
    // opt-in only: overflow:hidden canvases are scroll containers too, and the
    // app may undo the scroll on its next frame, leaving the box stale
    if (t.scroll === true) e.scrollIntoView({ block: 'center', inline: 'center' })
    const r = e.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, width: r.width, height: r.height, count: els.length,
             tag: e.tagName.toLowerCase(), cls: String(e.className || '').slice(0, 120), text: (e.innerText || '').trim().slice(0, 120) }
  }, typeof target === 'string' ? { selector: target } : target instanceof RegExp ? { text: target.source, flags: target.flags, regex: true } : target)

  let held = null
  const page = {
    win, consoleErrors, shots,
    /** raw CDP, e.g. Page.addScriptToEvaluateOnNewDocument before a goto */
    cdp,
    base: BASE.href,
    async goto(where) {
      const url = new URL(where, BASE).href
      log('goto', url)
      await win.loadURL(url)
    },
    eval: evaluate,
    sleep,
    log: (...a) => log('script:', ...a.map(x => typeof x === 'string' ? x : JSON.stringify(x))),
    locate,
    async waitFor(target, { timeout = 20000, gone = false } = {}) {
      const end = Date.now() + timeout
      let last = null
      while (Date.now() < end) {
        last = typeof target === 'function' ? await evaluate(target) : await locate(target)
        if (gone ? !last : last) return last ?? true
        await sleep(200)
      }
      throw new Error(`waitFor ${gone ? 'gone ' : ''}${JSON.stringify(target instanceof RegExp ? String(target) : target)} timed out after ${timeout} ms`)
    },
    async mouse(type, x, y, { button = 'left', clickCount = 1, modifiers = 0 } = {}) {
      // a move while a button is held carries that button (a drag: without it the page sees a button-less move
      // and releases pointer capture)
      if (type === 'mousePressed') held = button
      const down = type === 'mouseMoved' && held
      const buttons = type === 'mousePressed' || down ? ((down ? held : button) === 'right' ? 2 : 1) : 0
      await cdp('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? (down ? held : 'none') : button, buttons, clickCount, modifiers })
      if (type === 'mouseReleased') held = null
    },
    /** The target's box once it has stopped moving (cards spring into place). */
    async settled(target, opts = {}) {
      let prev = await page.waitFor(target, opts)
      const end = Date.now() + (opts.settle ?? 5000)
      while (Date.now() < end) {
        await sleep(150)
        const cur = await locate(target)
        if (cur && Math.abs(cur.x - prev.x) < 0.5 && Math.abs(cur.y - prev.y) < 0.5) return cur
        prev = cur ?? prev
      }
      return prev
    },
    async hover(target) {
      const b = target.x !== undefined && target.text === undefined && !target.selector ? target : await page.settled(target)
      await page.mouse('mouseMoved', b.x, b.y)
      await sleep(120)
      return b
    },
    async click(target, opts = {}) {
      const b = target.x !== undefined && target.text === undefined && !target.selector ? target : await page.settled(target, opts)
      await page.mouse('mouseMoved', b.x, b.y)
      await sleep(60)
      await page.mouse('mousePressed', b.x, b.y, opts)
      await sleep(40)
      await page.mouse('mouseReleased', b.x, b.y, opts)
      await sleep(opts.after ?? 250)
      return b
    },
    rightClick(target, opts = {}) { return page.click(target, { ...opts, button: 'right' }) },
    async press(name, { modifiers = 0 } = {}) {
      const k = KEYS[name] ?? { code: `Key${name.toUpperCase()}`, key: name, vk: name.toUpperCase().charCodeAt(0), text: name }
      if (guards.refusedKey({ key: k.key, code: k.code, modifiers })) throw new Error(`refused: ${name} with modifiers ${modifiers} would reach the real clipboard`)
      await cdp('Input.dispatchKeyEvent', { type: k.text ? 'keyDown' : 'rawKeyDown', key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk, text: k.text, unmodifiedText: k.text, modifiers })
      await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk, modifiers })
      await sleep(120)
    },
    async type(text) { await cdp('Input.insertText', { text }); await sleep(120) },
    /** The viewport: a preset or WxH. Session 0's display is 1024x768 and
     * Windows clamps windows to it, so the size is a CDP device-metrics
     * override (what layout, events and screenshots see), not a native window size. */
    async resize(preset) {
      const [w, h] = sizeOf(preset)
      await cdp('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false, screenWidth: w, screenHeight: h })
      page.size = [w, h]
      await sleep(500)
    },
    /** A PNG of the viewport (CDP Page.captureScreenshot; capturePage, then the last painted frame, if that fails). */
    async screenshot(name) {
      await sleep(400)
      const file = path.join(OUT, `${name}.png`)
      let how = 'cdp', size = page.size
      try {
        const shot = await cdp('Page.captureScreenshot', { format: 'png', fromSurface: true })
        fs.writeFileSync(file, Buffer.from(shot.data, 'base64'))
      } catch (e) {
        log('cdp screenshot failed:', e.message)
        let img = await wc.capturePage()
        how = 'capturePage'
        if (img.isEmpty() || img.getSize().width < 10) { img = frame; how = 'paint' }
        fs.writeFileSync(file, img.toPNG())
        size = [img.getSize().width, img.getSize().height]
      }
      shots.push({ name, file, how, width: size?.[0], height: size?.[1] })
      log('screenshot', name, how, size?.join('x'))
      return file
    },
    async api(method, route, body) {
      const r = await fetch(new URL(route, BASE).href, { method, headers: { 'X-Orgtree-Desktop-Token': TOKEN, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body) })
      const text = await r.text()
      try { return JSON.parse(text) } catch { return text }
    },
  }
  return page
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null)
  const ses = session.defaultSession
  ses.setPermissionRequestHandler((_wc, permission, cb) => cb(guards.allowPermission(permission)))
  ses.setPermissionCheckHandler((_wc, permission) => guards.allowPermission(permission))
  // the desktop's own rule (main/windows.ts + policy.ts): sign requests to
  // the engine origin only, strip the header everywhere else
  ses.webRequest.onBeforeSendHeaders((d, cb) => {
    const h = { ...d.requestHeaders }
    for (const k of Object.keys(h)) if (k.toLowerCase() === 'x-orgtree-desktop-token') delete h[k]
    try {
      const u = new URL(d.url)
      if ((u.protocol === 'http:' || u.protocol === 'ws:') && u.host === BASE.host) h['X-Orgtree-Desktop-Token'] = TOKEN
    } catch { /* not a URL we sign */ }
    cb({ requestHeaders: h })
  })
  const [w, h] = sizeOf(E.RIG_DESKTOP_PRESET)
  const win = new BrowserWindow({ width: w, height: h, useContentSize: true, show: false, paintWhenInitiallyHidden: true, enableLargerThanScreen: true,
    webPreferences: { offscreen: true, backgroundThrottling: false, contextIsolation: true, sandbox: true } })
  win.webContents.setFrameRate(30)
  win.webContents.setAudioMuted(true)
  const page = driver(win)
  log('window made')
  win.webContents.debugger.attach('1.3')
  log('debugger attached')
  const result = { ok: false, preset: E.RIG_DESKTOP_PRESET || 'short', size: [w, h], contentSize: win.getContentSize(),
    display: require('electron').screen.getPrimaryDisplay().size }
  const deadline = setTimeout(() => {
    result.error = `the page script ran past ${E.RIG_DESKTOP_TIMEOUT_MS} ms`
    finish()
  }, Number(E.RIG_DESKTOP_TIMEOUT_MS || 180000))
  function finish() {
    clearTimeout(deadline)
    result.shots = page.shots
    result.consoleErrors = page.consoleErrors
    result.guards = { ...result.guards, muted: win.webContents.isAudioMuted(), muteSwitch: app.commandLine.hasSwitch(guards.MUTE_SWITCH),
      clipboardPermissions: 'denied', applicationMenu: Menu.getApplicationMenu() === null ? 'none' : 'set' }
    fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(result, null, 2))
    log('done ok=' + result.ok)
    app.exit(0)
  }
  try {
    // the stub must run before the app's own scripts, on every document. CDP
    // sent to the blank initial document hangs offscreen Electron 44
    // (measured), so a first navigation to about:blank makes one, then the
    // stub is registered before the app is loaded
    await win.loadURL('about:blank')
    await Promise.race([win.webContents.debugger.sendCommand('Page.enable')
      .then(() => win.webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: guards.CLIPBOARD_STUB })),
      sleep(10000).then(() => { throw new Error('the clipboard stub could not be registered (CDP did not answer in 10 s)') })])
    log('clipboard stub set')
    await page.goto(E.RIG_DESKTOP_ORG ? `/o/${E.RIG_DESKTOP_ORG}` : '/')
    result.guards = { clipboardStub: await page.eval(() => window.__rigClipboardGuard?.installed === true) }
    if (!result.guards.clipboardStub) throw new Error('the clipboard stub did not run at document start')
    // after the first navigation: an override sent to the blank initial
    // document crashes offscreen Electron 44 (measured)
    await page.resize(E.RIG_DESKTOP_PRESET || 'short')
    log('viewport set', page.size.join('x'))
    const script = require(E.RIG_DESKTOP_SCRIPT)
    const args = E.RIG_DESKTOP_ARGS ? JSON.parse(E.RIG_DESKTOP_ARGS) : {}
    result.value = await (script.default ?? script)(page, { org: E.RIG_DESKTOP_ORG, out: OUT, base: BASE.href, args })
    result.ok = true
  } catch (e) {
    result.error = String(e && e.stack || e)
    log('script failed', result.error)
    try { await page.screenshot('failure') } catch { /* nothing to capture */ }
  }
  finish()
}).catch(e => { log('electron failed', e.stack || e); app.exit(1) })
