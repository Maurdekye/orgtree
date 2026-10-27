'use strict'
// Session 0 capture for a popped-out panel that is powered off and opened
// again (docket 4-5-0-quick-zoom-animation-when-a-panel-starts-z; USER
// 2026-10-27 m1a23cd457070 "if i shut down a popped panel and reopen it, it
// doesnt appear as popped out, and is undraggable", m4691725be7a7 "it appears
// as though pinned, but the pin button is unhighlighed").
//
// Electron main process: serves the Apps workspace fixture (panelmotion-ui.tsx)
// with a stateful synthetic apps API from a local server, installs the
// desktop's own session guard (main/windows.ts configureEngineSession, bundled
// from this checkout) and drives one offscreen main window and the pop-outs it
// opens by CDP input. The sequence:
//   1. a window-pinned panel pops out; its window is moved and resized with
//      setBounds (a title-bar drag of a native window needs OS input, which
//      test isolation forbids), and the main window is probed where the panel
//      was;
//   2. Power off inside the pop-out (shutdown);
//   3. opened again from the Apps list (reopen): where it shows, its window's
//      bounds against where it was left, and every frame the main window
//      paints meanwhile; then moved again, powered off and opened again, to
//      show nothing builds up (docket 4-5-0-a-saved-pop-out-window-reopens-8-px-off-an);
//   4. its title bar's drag region; Return to main window; a CDP drag of its
//      title bar that moves it (drag);
//   5. a floating and a window-pinned panel powered off and opened again, and
//      a drag of the pinned one.
// The pop-outs go through the desktop's own wiring, bundled from the checkout
// like the session guard: configureWindow's open handler and exact placement,
// and a popoutRegistry whose reports (state, with the window's own box) the
// bridge stand-in hands to the page, as main/index.ts and the preload do.
// The same file also runs against an older checkout (kept outside the tree):
// it records what that checkout does instead of stopping at the first gap.
//
// Evidence in PANELR_OUT: capture.json (states, bounds, samples, requests,
// checks), frames/<scenario>/ (every painted frame, named by milliseconds
// after the action) and sheet-<scenario>.png.
//
// Run from the repository root, in Session 0 under the build permit
// (docs/agents/development-and-verification.md, test-window isolation):
//   set PANELR_OUT=C:\orgtree-build\<agent>\<folder>   (required, owned)
//   set PANELR_NODE_MODULES=<existing node_modules>   (default ./node_modules)
//   <node_modules>\electron\dist\electron.exe apps\desktop\renderer\tests\panelreopen-capture.cjs
// No clipboard use; permissions follow the real guard; audio is muted
// (--mute-audio and setAudioMuted) and the fixture plays no media.
const { app, BrowserWindow, nativeImage, session } = require('electron')
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), cp = require('node:child_process')

const REPO = process.cwd()
const OUT = process.env.PANELR_OUT || ''
const NM = process.env.PANELR_NODE_MODULES || path.join(REPO, 'node_modules')
const SLUG = 'synthetic-panels', TOKEN = 'capture-token-' + process.pid
const WINDOW_MS = 700
// Where the user leaves the pop-out: inside the 1024x768 Session 0 display.
const MOVED = { x: 340, y: 180, width: 560, height: 400 }
// and where it is left the second time
const MOVED2 = { x: 200, y: 120, width: 600, height: 440 }
const receipt = { started: new Date().toISOString(), requests: [], static: [], scenarios: {}, console: [], problems: [], knownGaps: [], pops: [] }
const fail = (e) => { console.error(e && e.stack || e); app.exit(1) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const PANEL_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%}body{display:grid;place-items:center;font:600 22px system-ui,sans-serif;color:#fff;background:linear-gradient(135deg,#3b6fe0,#7a3be0)}
.face{display:flex;flex-direction:column;align-items:center;gap:8px;text-align:center}.face small{font:400 13px system-ui;opacity:.85;max-width:300px}
</style></head><body><div class="face"><span>Synthetic panel</span><small>Static content: frames differ only by the window's own motion</small></div></body></html>`
const AT = '2026-10-27T08:00:00Z'
const appDef = { id: 'timer', name: 'Timer', description: 'Synthetic panel app', rev: 1, permission_rev: 1, width: 420, height: 300,
  capabilities: [], permissions: {}, created_by: 'capture', created_at: AT, updated_at: AT, is_new: false,
  definition: { name: 'Timer', description: 'Synthetic panel app', html: PANEL_HTML, initial_state: {}, capabilities: [], width: 420, height: 300 } }
const copy = (id, label, placement, minute, on) => ({ id, app: 'timer', label, rev: 1, open: on, running: on, run_generation: 1,
  state: {}, event_seq: 0, placement, created_at: `2026-10-27T08:0${minute}:00Z`, used_at: AT, updated_at: AT })
const panels = [
  // pinned to the window and running at launch: the panel that pops out
  copy('popped', 'Popped out', { mode: 'window', x: 80, y: 60, width: 420, height: 300 }, 1, true),
  copy('float', 'Floating', { mode: 'float', x: 40, y: 40, width: 420, height: 300 }, 2, false),
  copy('pinned', 'Pinned', { mode: 'window', x: 560, y: 320, width: 400, height: 280 }, 3, false),
]
const find = (id) => panels.find((p) => p.id === id)
// A stand-in for the preload's window.orgtreeDesktop, with what the Apps
// workspace and its pop-outs ask of it: without a bridge the renderer neither
// saves pop-out windows nor restores them. Like the preload's
// ipcRenderer.invoke, the window state answers later (20 ms here). Main's
// events reach onEvent listeners through window.__orgtreeEmit.
const BRIDGE_JS = `window.__orgtreeListeners = new Set()
window.__orgtreeEmit = (event) => { for (const fn of [...window.__orgtreeListeners]) fn(event); return true }
window.orgtreeDesktop = {
  getWindowState: () => new Promise((resolve) => setTimeout(() => resolve({ visible: true, restoreWindows: true }), 20)),
  onEvent: (fn) => { window.__orgtreeListeners.add(fn); return () => { window.__orgtreeListeners.delete(fn) } },
  getPreferences: () => Promise.resolve({}),
  setPreferences: () => Promise.resolve(),
  focusPopout: () => Promise.resolve(),
  hidePopout: () => Promise.resolve(),
}`

function startServer(files) {
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      const url = new URL(req.url, 'http://fixture'), p = url.pathname
      const send = (status, type, body) => {
        const buf = Buffer.isBuffer(body) ? body : Buffer.from(body)
        res.writeHead(status, { 'Content-Type': type, 'Content-Length': buf.length, 'Cache-Control': 'no-store' }); res.end(buf)
      }
      const json = (v, status = 200) => send(status, 'application/json', JSON.stringify(v))
      if (p === '/') return send(200, 'text/html; charset=utf-8', '<!doctype html><meta charset="utf-8"><title>Panel reopen capture</title>'
        + '<link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/shell.css"><link rel="stylesheet" href="/fixture.css">'
        + '<div id="root"></div><script src="/bridge.js"></script><script type="module" src="/fixture.js"></script>')
      if (p === '/bridge.js') return send(200, 'text/javascript', BRIDGE_JS)
      if (files[p] || !p.startsWith('/api/')) {
        const ok = !!files[p] && fs.existsSync(files[p].file)
        receipt.static.push({ path: p, status: ok ? 200 : 404 })
        return ok ? send(200, files[p].type, fs.readFileSync(files[p].file)) : send(404, 'text/plain', 'none')
      }
      const base = `/api/orgs/${SLUG}/apps`
      let input = {}
      try { input = req.method === 'POST' ? JSON.parse(raw || '{}') : JSON.parse(url.searchParams.get('request') || '{}') } catch { /* bad input */ }
      if (p === base + '/runtime') return json(input.action === 'heartbeat' ? { stop: [], sample_epoch: 0 } : {})
      if (p === base + '/bridge') return json({ closed: true })
      receipt.requests.push({ at: Math.round(performance.now()), action: input.action || null, panel: input.panel || null,
        ...(input.placement ? { placement: input.placement } : {}), ...('open' in input ? { open: input.open } : {}), token: req.headers['x-orgtree-desktop-token'] === TOKEN })
      if (p !== base) return json({ detail: 'not in this fixture' }, 404)
      const panel = input.panel ? find(input.panel) : null
      switch (input.action) {
        case 'list':
          if (input.kind === 'apps') return json({ kind: 'apps', items: [appDef], next_cursor: null, new_count: 0 })
          return json({ kind: 'panels', items: panels.filter((x) => (input.running === undefined || x.running === input.running) && (input.open === undefined || x.open === input.open)), next_cursor: null })
        case 'app_get': return json(appDef)
        case 'panel_get': return panel ? json(panel) : json({ detail: 'no such panel' }, 404)
        case 'events': return json({ panel: input.panel, events: [], next_cursor: null, oldest_retained: null })
        // Like the engine: opening starts a stopped copy and never moves one; Power off keeps the placement.
        case 'panel_open': if (!panel.running) panel.run_generation++; Object.assign(panel, { open: true, running: true, used_at: new Date().toISOString() }); panel.rev++; return json(panel)
        case 'panel_update':
          if (input.expected_rev !== panel.rev) return json({ detail: 'revision conflict' }, 409)
          for (const k of ['open', 'placement', 'label']) if (k in input) panel[k] = input[k]; panel.rev++; return json(panel)
        case 'panel_stop': Object.assign(panel, { running: false, open: false }); panel.run_generation++; panel.rev++; return json(panel)
        default: return json({ detail: 'not in this fixture: ' + input.action }, 400)
      }
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)))
}

// Every animation frame in one document: is the panel there, its marker, its
// computed scale, its effective opacity and its box (which includes the scale).
const SAMPLER = `window.__motion=(sel,ms)=>new Promise(resolve=>{const out=[];let t0=null;window.__actAt=null
const down=()=>{window.__actAt=performance.now()};document.addEventListener('pointerdown',down,true)
const eff=el=>{let o=1;for(let n=el;n&&n.nodeType===1;n=n.parentElement)o*=Number(getComputedStyle(n).opacity);return Math.round(o*1000)/1000}
const step=now=>{if(t0===null)t0=now;const el=document.querySelector(sel),cs=el&&getComputedStyle(el)
out.push({t:Math.round(now-t0),present:!!el,motion:el?el.dataset.motion||null:null,scale:cs?cs.scale:null,opacity:el?eff(el):null,box:el?(r=>[Math.round(r.left),Math.round(r.top),Math.round(r.width),Math.round(r.height)])(el.getBoundingClientRect()):null})
window.__sofar={actAt:window.__actAt===null?null:Math.round(window.__actAt-t0),samples:out}
if(now-t0<ms)requestAnimationFrame(step);else{document.removeEventListener('pointerdown',down,true);resolve({actAt:window.__actAt===null?null:Math.round(window.__actAt-t0),samples:out})}}
requestAnimationFrame(step)});true`
// One panel as the user sees it: where it is, its pin and its outer wrapper.
const STATE = (id) => `(()=>{const el=document.querySelector('section[data-custom-panel="${id}"]');if(!el)return null
const r=el.getBoundingClientRect(),pin=el.querySelector('[aria-label="Pin to window"],[aria-label="Unpin"]'),outer=el.closest('.custom-app-placeholder,.custom-app-centered,.custom-app-parked')
return {box:[Math.round(r.left),Math.round(r.top),Math.round(r.width),Math.round(r.height)],inPinLayer:!!el.closest('[data-pin-layer]'),centered:el.hasAttribute('data-centered'),
pinned:el.hasAttribute('data-pinned'),detached:el.hasAttribute('data-detached'),motion:el.dataset.motion||null,
pin:pin?{label:pin.getAttribute('aria-label'),pressed:pin.getAttribute('aria-pressed')}:null,outer:outer?outer.className:null,outerStyle:outer?outer.getAttribute('style'):null}})()`

let windows
try {
  if (!/^C:[\\/]orgtree-build[\\/][^\\/]+[\\/]/i.test(OUT)) throw Error('PANELR_OUT must be an owned C:\\orgtree-build\\<agent>\\ folder')
  fs.mkdirSync(OUT, { recursive: true })
  const esbuild = require(path.join(NM, 'esbuild'))
  // CSS the components import (apps.css) lands in fixture.css.
  esbuild.buildSync({ entryPoints: [path.join(REPO, 'apps/desktop/renderer/tests/panelmotion-ui.tsx')], bundle: true,
    platform: 'browser', format: 'esm', jsx: 'automatic', outfile: path.join(OUT, 'fixture.js'), nodePaths: [NM],
    loader: { '.woff': 'empty', '.woff2': 'empty', '.ttf': 'empty', '.png': 'dataurl', '.svg': 'dataurl', '.gif': 'dataurl', '.jpg': 'dataurl' },
    define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'warning' })
  esbuild.buildSync({ entryPoints: [path.join(REPO, 'apps/desktop/main/windows.ts')], bundle: true, platform: 'node',
    format: 'cjs', outfile: path.join(OUT, 'windows.cjs'), external: ['electron'], nodePaths: [NM], logLevel: 'warning' })
  windows = require(path.join(OUT, 'windows.cjs'))
  for (const key of ['userData', 'sessionData', 'logs', 'crashDumps']) {
    const dir = path.join(OUT, 'profile', key); fs.mkdirSync(dir, { recursive: true }); app.setPath(key, dir)
  }
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('force-device-scale-factor', '1')
  // silent by rule (coordinator 2026-10-26 m0f2fd7b119d6): no test window plays audio
  app.commandLine.appendSwitch('mute-audio')
} catch (e) { fail(e) }

const sessionOf = (pid) => {
  try { return Number(cp.execFileSync('powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${pid}).SessionId`]).toString().trim()) } catch { return null }
}

/** Keeps every frame a webContents presents between start() and stop(): paint
 *  events when it renders offscreen, a frame subscription otherwise. */
function recorder(wc) {
  const offscreen = wc.isOffscreen()
  const rec = { on: false, frames: [], mode: offscreen ? 'offscreen paint events' : 'frame subscription' }
  const keep = (image) => { if (rec.on) rec.frames.push({ t: performance.now(), size: image.getSize(), bitmap: image.toBitmap() }) }
  if (offscreen) wc.on('paint', (_e, _dirty, image) => keep(image))
  rec.start = () => { rec.frames = []; rec.on = true; if (!offscreen) wc.beginFrameSubscription(false, (image) => keep(image)) }
  rec.stop = () => { if (!rec.on) return; rec.on = false; if (!offscreen) try { wc.endFrameSubscription() } catch { /* window gone */ } }
  return rec
}
const log = (m) => console.log(new Date().toISOString().slice(11, 23) + ' ' + m)

app.whenReady().then(async () => {
  const css = (name) => ({ type: 'text/css', file: path.join(REPO, 'apps/desktop/renderer/src', name) })
  const server = await startServer({ '/fixture.js': { type: 'text/javascript', file: path.join(OUT, 'fixture.js') },
    '/fixture.css': { type: 'text/css', file: path.join(OUT, 'fixture.css') }, '/styles.css': css('styles.css'), '/shell.css': css('shell.css'),
    // styles.css @imports it; a failed import fails the stylesheet, and a pop-out
    // then gives up on its styling (vite bundles it in the real app).
    '/katex/dist/katex.min.css': { type: 'text/css', file: path.join(NM, 'katex/dist/katex.min.css') } })
  const origin = `http://127.0.0.1:${server.address().port}`
  const register = windows.configureEngineSession(session.defaultSession, origin, TOKEN)
  const prefs = { contextIsolation: true, sandbox: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false }
  const win = new BrowserWindow({ width: 1024, height: 760, useContentSize: true, show: false, paintWhenInitiallyHidden: true, webPreferences: prefs })
  const wc = win.webContents
  wc.setFrameRate(60)
  wc.setAudioMuted(true)
  const mainRec = recorder(wc)
  // Main's reports of each pop-out (popout-state, with its own box), handed to
  // the page as the preload delivers events.
  const reported = []
  receipt.reported = reported
  const registry = windows.popoutRegistry((state) => {
    reported.push({ at: Math.round(performance.now()), ...state })
    if (!wc.isDestroyed()) wc.executeJavaScript(`window.__orgtreeEmit(${JSON.stringify({ type: 'popout-state', data: { ...state, reason: 'user' } })})`, true).catch(() => {})
  })
  // Every open request's features, as the desktop's own handler answers them.
  const setOpenHandler = wc.setWindowOpenHandler.bind(wc)
  wc.setWindowOpenHandler = (handler) => setOpenHandler((details) => {
    const answer = handler(details)
    receipt.pops.push({ asked: Math.round(performance.now()), frameName: details.frameName, features: details.features, allowed: answer.action === 'allow' })
    return answer
  })
  // The desktop's own wiring: the session guard registers the windows, the open
  // handler allows the renderer's named about:blank pop-outs (ordinary frameless
  // windows; an offscreen window.open child kept a 0x0 viewport, measured
  // 2026-10-27) and places exact ones, and each pop-out is tracked.
  windows.configureWindow(win, () => origin, true, register, undefined, undefined, (name, child) => registry.track(name, child))
  const pops = []
  let recordNext = false
  wc.on('did-create-window', (w, details) => {
    const cwc = w.webContents
    const entry = { win: w, wc: cwc, name: details.frameName, createdAt: performance.now(), closedAt: null }
    if (!w.isVisible()) w.showInactive()
    cwc.setAudioMuted(true)
    entry.rec = recorder(cwc)
    if (recordNext) { recordNext = false; entry.rec.start(); entry.fromCreation = true }
    entry.dbg = cwc.debugger; entry.dbg.attach('1.3')
    w.on('closed', () => { entry.closedAt = performance.now() })
    pops.push(entry)
    log(`pop-out window ${pops.length} created at ${JSON.stringify(w.getBounds())}`)
  })
  wc.on('console-message', (e, level, message) => {
    const text = String(message ?? e?.message ?? '')
    if (receipt.console.length < 80) receipt.console.push(text.slice(0, 300))
  })
  const dbg = wc.debugger
  dbg.attach('1.3')
  const js = (code, target = wc) => target.executeJavaScript(code, true)
  // Bounded: a document that paints no frames must not stall the run.
  const settle = (target = wc) => Promise.race([js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(r,250))))', target), sleep(1500)])
  const until = async (probe, what, ms = 10000) => {
    const end = Date.now() + ms
    for (;;) {
      let value; try { value = await Promise.race([probe(), sleep(2000).then(() => null)]) } catch { value = null }
      if (value) return value
      if (Date.now() > end) throw Error('timed out waiting for ' + what)
      await sleep(40)
    }
  }
  const maybe = (probe, what, ms) => until(probe, what, ms).catch(() => null)
  const box = (code, target = wc) => js(`(()=>{const el=${code};const r=el&&el.getBoundingClientRect();return r&&r.width>0&&r.height>0?{x:r.left,y:r.top,w:r.width,h:r.height}:null})()`, target)
  const press = async (code, what, target = wc, debug = dbg) => {
    const b = await until(() => box(code, target), what)
    const x = Math.round(b.x + b.w / 2), y = Math.round(b.y + b.h / 2)
    await debug.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    const at = performance.now()
    await debug.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
    await debug.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
    return at
  }
  /** A drag of the panel's title (its name, clear of the buttons) by dx,dy in ten steps. */
  const drag = async (id, dx, dy, target = wc, debug = dbg) => {
    const b = await until(() => box(`${q(panelSel(id))}?.querySelector('.custom-app-title strong')`, target), id + ' title')
    const x = Math.round(b.x + Math.min(40, b.w / 2)), y = Math.round(b.y + b.h / 2)
    await debug.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    const at = performance.now()
    await debug.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 })
    for (let i = 1; i <= 10; i++) {
      await debug.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + Math.round(dx * i / 10), y: y + Math.round(dy * i / 10), button: 'left', buttons: 1 })
      await sleep(16)
    }
    await debug.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x + dx, y: y + dy, button: 'left', buttons: 1, clickCount: 1 })
    return at
  }
  const panelSel = (id) => `section[data-custom-panel="${id}"]`
  const q = (sel) => `document.querySelector(${JSON.stringify(sel)})`
  const row = (label) => `[...document.querySelectorAll('.custom-apps-saved')].find(b=>(b.getAttribute('aria-label')||'').startsWith(${JSON.stringify(label + ',')}))`
  const openMenu = async () => {
    if (!await js(`!!document.querySelector('.custom-apps-menu')`)) await press(q('.apps-button'), 'Apps button')
    await until(() => js(`!!document.querySelector('.custom-apps-menu .custom-apps-saved')`), 'Apps menu rows')
    await settle()
  }
  const problems = receipt.problems
  const expect = (ok, what) => { if (!ok) problems.push(what) }
  const numeric = (s) => s === 'none' || s === null ? 1 : Number(String(s).split(' ')[0])
  const zoomed = (s) => s.some((x) => x.present && numeric(x.scale) > 0.5 && numeric(x.scale) < 0.95)
  const near = (a, b) => !!a && !!b && ['x', 'y', 'width', 'height'].every((k) => Math.abs(a[k] - b[k]) <= 2)
  const writesSince = (at) => receipt.requests.filter((r) => r.at >= at && !['list', 'app_get', 'panel_get', 'events'].includes(r.action))

  /** Frames from a recorder, named by milliseconds after `at`, and a sheet. */
  async function keep(name, rec, at, samples = []) {
    rec.stop()
    const dir = path.join(OUT, 'frames', name); fs.mkdirSync(dir, { recursive: true })
    const shots = rec.frames.map((f, i) => {
      const ms = Math.round(f.t - at), file = `${String(i).padStart(2, '0')}_${ms >= 0 ? '+' : ''}${ms}ms.png`
      const image = nativeImage.createFromBitmap(f.bitmap, { width: f.size.width, height: f.size.height, scaleFactor: 1 })
      fs.writeFileSync(path.join(dir, file), image.toPNG())
      return { file, ms, image }
    })
    receipt.scenarios[name] = { recorder: rec.mode, frames: shots.map((x) => x.file), samples }
    await sheet(name, shots, samples)
    fs.writeFileSync(path.join(OUT, 'capture.json'), JSON.stringify(receipt, null, 2))
    log(`  ${name}: ${shots.length} frames, ${samples.length} samples`)
  }
  /** Records one action in one document: its frames and the sampler's frames. */
  async function scenario(name, sel, act, { target = wc, rec = mainRec, stream = false } = {}) {
    log('scenario ' + name)
    await js(SAMPLER, target)
    rec.start()
    const sampling = js(`window.__motion(${JSON.stringify(sel)},${WINDOW_MS})`, target)
    // A document that closes during the window (a pop-out) never resolves its
    // promise: keep its samples so far, read every 30 ms while it lives.
    let sofar = null, polling = stream
    const poll = async () => { while (polling) { let v = null; try { v = await Promise.race([js('window.__sofar||null', target), sleep(200).then(() => null)]) } catch { /* closed */ } if (v) sofar = v; await sleep(30) } }
    const reading = poll()
    await sleep(60)
    const at = await act()
    let sampled = await Promise.race([sampling, sleep(WINDOW_MS + 4000).then(() => null)])
    polling = false; await reading
    if (!sampled && sofar) sampled = sofar
    if (!sampled) { problems.push(name + ': the page drew no animation frames to sample'); sampled = { actAt: null, samples: [] } }
    await sleep(Math.max(0, WINDOW_MS + 60 - (performance.now() - at)))
    const rel = sampled.samples.map((x) => ({ ...x, t: sampled.actAt === null ? x.t : x.t - sampled.actAt }))
    await keep(name, rec, at, rel)
    receipt.scenarios[name].actionAtMain = Math.round(at)
    return { samples: rel, at }
  }
  /** A contact sheet of the frames from just before to 420 ms after the action:
   *  cropped to the panel's boxes when the samples have them, else whole. */
  async function sheet(name, shots, samples) {
    if (!shots.length) return
    const W = shots[0].image.getSize().width, H = shots[0].image.getSize().height
    const boxes = samples.filter((x) => x.box).map((x) => x.box)
    const crop = boxes.length ? { x0: Math.max(0, Math.min(...boxes.map((b) => b[0])) - 24), y0: Math.max(0, Math.min(...boxes.map((b) => b[1])) - 24),
      x1: Math.min(W, Math.max(...boxes.map((b) => b[0] + b[2])) + 24), y1: Math.min(H, Math.max(...boxes.map((b) => b[1] + b[3])) + 24) } : { x0: 0, y0: 0, x1: W, y1: H }
    const picked = shots.filter((x) => x.ms >= -40 && x.ms <= 420).slice(0, 24)
    if (!picked.length) return
    const dir = path.join(OUT, 'sheets', name); fs.mkdirSync(dir, { recursive: true })
    // A window cannot outgrow the display (1024x768 in Session 0): the widest
    // cells whose grid fits in 1000x728.
    const aspect = (crop.y1 - crop.y0) / (crop.x1 - crop.x0), n = picked.length
    let fit = null
    for (let cols = 2; cols <= 8; cols++) {
      const w = Math.min(320, Math.floor(984 / cols) - 8), h = Math.round(w * aspect) + 22, rows = Math.ceil(n / cols)
      if (rows * (h + 8) + 40 <= 728 && (!fit || w > fit.w)) fit = { cols, w, h, rows }
    }
    if (!fit) { const w = Math.floor(984 / 8) - 8; fit = { cols: 8, w, h: Math.round(w * aspect) + 22, rows: Math.ceil(n / 8) } }
    const cells = picked.map((x, i) => {
      const image = x.image.getSize().width === W ? x.image.crop({ x: crop.x0, y: crop.y0, width: crop.x1 - crop.x0, height: crop.y1 - crop.y0 }) : x.image
      const file = `${i}.png`; fs.writeFileSync(path.join(dir, file), image.resize({ width: fit.w }).toPNG())
      return `<figure><img src="${file}"><figcaption>${x.ms >= 0 ? '+' : ''}${x.ms} ms</figcaption></figure>`
    })
    const width = fit.cols * (fit.w + 8) + 16, height = fit.rows * (fit.h + 8) + 40
    fs.writeFileSync(path.join(dir, 'sheet.html'), `<!doctype html><meta charset="utf-8"><style>body{margin:8px;background:#1b1d22;color:#e8e8e8;font:12px system-ui;overflow:hidden}
h1{font-size:13px;margin:0 0 8px}main{display:grid;grid-template-columns:repeat(${fit.cols},${fit.w}px);gap:8px}figure{margin:0}img{display:block;width:${fit.w}px;border:1px solid #444;box-sizing:border-box}figcaption{text-align:center;padding-top:3px}</style>
<h1>${name}: frames by time after the action</h1><main>${cells.join('')}</main>`)
    const sw = new BrowserWindow({ width, height, useContentSize: true, show: false, paintWhenInitiallyHidden: true, webPreferences: { offscreen: true, sandbox: true, contextIsolation: true } })
    try {
      await sw.loadFile(path.join(dir, 'sheet.html'))
      await Promise.race([sw.webContents.executeJavaScript('Promise.all([...document.images].map(i=>i.decode())).then(()=>new Promise(r=>requestAnimationFrame(()=>setTimeout(r,200))))', true), sleep(3000)])
      const image = await sw.webContents.capturePage()
      if (!image.isEmpty()) fs.writeFileSync(path.join(OUT, `sheet-${name}.png`), image.toPNG())
    } finally { sw.destroy() }
  }

  try {
    await wc.loadURL(origin + '/')
    receipt.processes = { main: { pid: process.pid, session: sessionOf(process.pid) } }
    const rendererPid = wc.getOSProcessId()
    receipt.processes.renderer = { pid: rendererPid, session: sessionOf(rendererPid) }
    receipt.clipboard = 'not used; the real session guard decided permissions'
    await until(() => js(`!!document.querySelector('.apps-button')&&!!${q(panelSel('popped'))}?.querySelector('iframe')`), 'the pinned panel restored at launch')
    await settle()
    receipt.launch = await js(STATE('popped'))

    // 1. Pop the pinned panel out, then move and resize its window.
    await press(`${q(panelSel('popped'))}.querySelector('.popout-button')`, 'pop-out button')
    const first = await until(() => pops[0], 'the pop-out window')
    await until(() => js(`!!${q(panelSel('popped'))}?.querySelector('iframe')`, first.wc), 'the panel in its pop-out')
    await settle(first.wc)
    receipt.popout = { opened: first.win.getBounds(), placement: { ...find('popped').placement } }
    first.win.setBounds(MOVED)
    await sleep(700) // the renderer samples its pop-outs' bounds every 250 ms
    receipt.popout.moved = first.win.getBounds()
    receipt.popout.reportedAfterMove = reported.filter((r) => r.name === first.name).at(-1)?.bounds ?? null
    // what the renderer samples into the saved row (windowlayout.ts captureWindow)
    receipt.popout.rendererSees = await js('({screenX,screenY,outerWidth,outerHeight,innerWidth,innerHeight})', first.wc)
    // the main window where the pinned panel was: the canvas, or a box left there?
    receipt.popout.leftBehind = await js(`(()=>{const o=document.querySelector('.custom-app-placeholder');const hit=document.elementFromPoint(290,250)
      return {placeholder:o?o.className:null,style:o?o.getAttribute('style'):null,box:o?(r=>[Math.round(r.left),Math.round(r.top),Math.round(r.width),Math.round(r.height)])(o.getBoundingClientRect()):null,hitAt290x250:hit?(typeof hit.className==='string'&&hit.className||hit.tagName):null}})()`)

    // 2. Shutdown: Power off inside the pop-out.
    const shut = await scenario('shutdown', panelSel('popped'), () => press(`${q(panelSel('popped'))}.querySelector('[aria-label="Power off Popped out"]')`, 'Power off in the pop-out', first.wc, first.dbg),
      { target: first.wc, rec: first.rec, stream: true })
    expect(shut.samples.some((x) => x.motion === 'stop') && zoomed(shut.samples), 'shutdown: no zoom-out inside the pop-out')
    await until(() => first.closedAt !== null, 'the pop-out to close', 3000)
    receipt.shutdown = { closedMsAfterAction: Math.round(first.closedAt - shut.at), placement: { ...find('popped').placement }, open: find('popped').open, running: find('popped').running }

    // 3. Reopen from the Apps list. The main window is recorded and sampled
    //    throughout; a new pop-out records from its creation.
    await openMenu()
    recordNext = true
    const mark = Math.round(performance.now())
    const re = await scenario('reopen-main-window', panelSel('popped'), () => press(row('Popped out'), 'Popped out row (off)'))
    recordNext = false
    const second = await maybe(() => pops[1], 'its own window again', 2000)
    receipt.reopen = { ownWindow: !!second, inMainWindowAtAnyFrame: re.samples.some((x) => x.present), mainSamples: re.samples.length }
    if (second) {
      await until(() => js(`!!${q(panelSel('popped'))}`, second.wc), 'the panel in its window again')
      receipt.reopen.state = await js(STATE('popped'), second.wc)
      await sleep(Math.max(0, WINDOW_MS - (performance.now() - re.at)))
      await keep('reopen-own-window', second.rec, re.at)
      receipt.reopen.bounds = second.win.getBounds()
      receipt.reopen.wanted = MOVED
      receipt.reopen.features = receipt.pops.at(-1)?.features
      receipt.reopen.createdMsAfterAction = Math.round(second.createdAt - re.at)
      // the native drag region a user drags the pop-out by (every pop-out's title bar)
      receipt.reopen.dragRegion = await js(`(()=>{const h=document.querySelector('section[data-custom-panel="popped"] .custom-app-title');const b=h&&h.querySelector('button')
        const region=e=>{const s=getComputedStyle(e);return s.getPropertyValue('-webkit-app-region')||s.webkitAppRegion||null};return h?{title:region(h),button:b?region(b):null}:null})()`, second.wc)
    } else {
      receipt.reopen.state = await js(STATE('popped'))
      receipt.reopen.frontAt290x250 = await js(`(()=>{const hit=document.elementFromPoint(290,250);return hit?(typeof hit.className==='string'&&hit.className||hit.tagName):null})()`)
    }
    receipt.reopen.placement = { ...find('popped').placement }
    receipt.reopen.writes = writesSince(mark)
    receipt.reopen.notice = await js(`(()=>{const n=document.querySelector('.popout-notices');return n?n.textContent:null})()`)

    // 3b. Moved once more, powered off and opened again: nothing builds up.
    let last = second
    if (second) {
      second.win.setBounds(MOVED2)
      await sleep(700)
      receipt.again = { moved: second.win.getBounds(), reportedAfterMove: reported.filter((r) => r.name === second.name).at(-1)?.bounds ?? null }
      await press(`${q(panelSel('popped'))}.querySelector('[aria-label="Power off Popped out"]')`, 'Power off in the pop-out (again)', second.wc, second.dbg)
      await until(() => second.closedAt !== null, 'the second pop-out to close', 3000)
      await sleep(300)
      await openMenu()
      await press(row('Popped out'), 'Popped out row (off, again)')
      const third = await maybe(() => pops[2], 'its own window a third time', 3000)
      receipt.again.ownWindow = !!third
      if (third) {
        await until(() => js(`!!${q(panelSel('popped'))}?.querySelector('iframe')`, third.wc), 'the panel in its window (third)')
        await settle(third.wc)
        receipt.again.bounds = third.win.getBounds()
        receipt.again.features = receipt.pops.at(-1)?.features
        last = third
      }
    }

    // 4. Back to the main window (its earlier place: the window pin), then a drag.
    if (last) {
      const back = await scenario('return', panelSel('popped'), () => press(`${q(panelSel('popped'))}.querySelector('.popout-button')`, 'Return to main window', last.wc, last.dbg))
      // every box the panel had in the main window while it came back: one means straight to its pin
      receipt.returned = { boxes: [...new Set(back.samples.filter((x) => x.box).map((x) => x.box.join()))] }
      await until(() => js(`!!${q(panelSel('popped'))}?.querySelector('iframe')`), 'the panel back in the main window')
      await until(() => last.closedAt !== null, 'the last pop-out to close', 3000)
      await settle()
    }
    receipt.beforeDrag = { state: await js(STATE('popped')), placement: { ...find('popped').placement } }
    const dragMark = Math.round(performance.now())
    const dr = await scenario('drag', panelSel('popped'), () => drag('popped', 150, 90))
    await sleep(400)
    receipt.afterDrag = { state: await js(STATE('popped')), placement: { ...find('popped').placement }, writes: writesSince(dragMark) }
    const before = receipt.beforeDrag.state?.box, after = receipt.afterDrag.state?.box
    receipt.afterDrag.movedBy = before && after ? [after[0] - before[0], after[1] - before[1]] : null
    receipt.afterDrag.duringDrag = dr.samples.filter((x) => x.box).map((x) => x.box.slice(0, 2)).filter((b, i, all) => i === 0 || b.join() !== all[i - 1].join())
    // Off again, so it does not overlap the window pin dragged below.
    await press(`${q(panelSel('popped'))}.querySelector('[aria-label="Power off Popped out"]')`, 'Power off Popped out')
    await until(() => js(`!${q(panelSel('popped'))}`), 'Popped out gone')

    // 5. Floating and window-pinned panels: Power off, open again, where they are; drag the pinned one.
    receipt.docked = {}
    for (const [id, label] of [['float', 'Floating'], ['pinned', 'Pinned']]) {
      await openMenu(); await press(row(label), label + ' row')
      await until(() => js(`!!${q(panelSel(id))}?.querySelector('iframe')&&!${q(panelSel(id))}.dataset.motion`), label + ' shown')
      await settle()
      const shown = await js(STATE(id))
      await press(`${q(panelSel(id))}.querySelector('[aria-label="Power off ${label}"]')`, 'Power off ' + label)
      await until(() => js(`!${q(panelSel(id))}`), label + ' gone')
      await openMenu(); await press(row(label), label + ' row (off)')
      await until(() => js(`!!${q(panelSel(id))}?.querySelector('iframe')&&!${q(panelSel(id))}.dataset.motion`), label + ' shown again')
      await settle()
      receipt.docked[id] = { first: shown, reopened: await js(STATE(id)), placement: { ...find(id).placement } }
      // the centred backdrop covers the Apps button: off again before the next one
      if (id === 'float') {
        await press(`${q(panelSel(id))}.querySelector('[aria-label="Power off ${label}"]')`, 'Power off ' + label + ' (again)')
        await until(() => js(`!${q(panelSel(id))}`), label + ' gone again')
      }
    }
    const pinBefore = receipt.docked.pinned.reopened?.box
    await scenario('pinned-drag', panelSel('pinned'), () => drag('pinned', -120, -80))
    await sleep(400)
    const pinAfter = (await js(STATE('pinned')))?.box
    receipt.docked.pinned.movedBy = pinBefore && pinAfter ? [pinAfter[0] - pinBefore[0], pinAfter[1] - pinBefore[1]] : null
    receipt.docked.pinned.dragged = { ...find('pinned').placement }

    // The checks.
    expect(receipt.shutdown.placement.mode === 'popout' && !receipt.shutdown.open && !receipt.shutdown.running, 'shutdown: the record should be off and still say popout')
    expect(receipt.reopen.ownWindow, 'reopen: no window of its own was opened')
    expect(!receipt.reopen.inMainWindowAtAnyFrame, 'reopen: the panel showed in the main window')
    // Where it was left, within 1 px, both times: the saved row is the window's
    // own box as main reported it, and main places it exactly. (The renderer's
    // own view, rendererSees, includes Windows' invisible frame.)
    const rectOf = (f) => { const v = (k) => Number(new RegExp('(?:^|,)' + k + '=(-?\\d+)').exec(f || '')?.[1]); return { x: v('left'), y: v('top'), width: v('width'), height: v('height') } }
    const within1 = (a, b) => !!a && !!b && ['x', 'y', 'width', 'height'].every((k) => Math.abs(a[k] - b[k]) <= 1)
    receipt.reopen.asked = rectOf(receipt.reopen.features)
    expect(within1(receipt.popout.reportedAfterMove, MOVED), 'main did not report the moved window\'s own box')
    expect(/(?:^|,)orgtreeNativeRect=1(?:,|$)/.test(receipt.reopen.features || '') && within1(receipt.reopen.asked, MOVED), 'reopen: the restore did not ask for the window\'s own box')
    expect(within1(receipt.reopen.bounds, MOVED), 'reopen: its window is not where it was left (within 1 px)')
    expect(receipt.again?.ownWindow && within1(receipt.again?.bounds, MOVED2), 'second reopen: its window is not where it was left (within 1 px)')
    expect(receipt.reopen.state?.detached === true, 'reopen: the panel is not in its own window')
    expect(receipt.reopen.dragRegion?.title === 'drag' && receipt.reopen.dragRegion?.button === 'no-drag', 'reopen: the title bar is not the window drag region')
    expect(JSON.stringify(receipt.reopen.writes.map((w) => w.action)) === '["panel_open"]', 'reopen: wrote more than the open')
    expect(!receipt.popout.leftBehind?.style, 'popped out: the main window keeps a sized box where the panel was')
    expect(receipt.beforeDrag.state?.inPinLayer && receipt.beforeDrag.state?.pin?.pressed === 'true', 'return: not back as the window pin with its pin lit')
    expect(receipt.returned?.boxes?.length === 1, 'return: the panel showed somewhere else before its pin')
    expect(receipt.afterDrag.movedBy?.[0] === 150 && receipt.afterDrag.movedBy?.[1] === 90, 'drag: the title drag did not move it by 150,90')
    expect(receipt.afterDrag.placement.mode === 'window' && receipt.afterDrag.placement.x === 80 + 150 && receipt.afterDrag.placement.y === 60 + 90, 'drag: the moved place was not saved')
    expect(receipt.docked.float.reopened?.centered && receipt.docked.float.reopened?.outer?.includes('custom-app-centered'), 'floating: not centered when opened again')
    expect(receipt.docked.pinned.reopened?.inPinLayer && receipt.docked.pinned.reopened?.box?.join() === receipt.docked.pinned.first?.box?.join() && receipt.docked.pinned.reopened?.pin?.pressed === 'true', 'pinned: not at its spot with its pin lit when opened again')
    expect(receipt.docked.pinned.movedBy?.[0] === -120 && receipt.docked.pinned.movedBy?.[1] === -80, 'pinned: the drag after reopening did not move it')
    expect(!receipt.requests.some((r) => !r.token), 'an unsigned request reached the server')
  } catch (e) {
    problems.push(String(e && e.stack || e))
    try { const image = await wc.capturePage(); if (!image.isEmpty()) fs.writeFileSync(path.join(OUT, 'failure.png'), image.toPNG()) } catch { /* nothing to capture */ }
  } finally {
    receipt.ok = problems.length === 0
    receipt.finished = new Date().toISOString()
    for (const p of pops) for (const k of ['win', 'wc', 'rec', 'dbg']) delete p[k]
    receipt.popWindows = pops
    fs.writeFileSync(path.join(OUT, 'capture.json'), JSON.stringify(receipt, null, 2))
    console.log(JSON.stringify({ ok: receipt.ok, problems, knownGaps: receipt.knownGaps, processes: receipt.processes, popout: receipt.popout, shutdown: receipt.shutdown,
      reopen: { ...receipt.reopen, writes: receipt.reopen?.writes?.map((w) => w.action) }, afterDrag: receipt.afterDrag && { movedBy: receipt.afterDrag.movedBy, placement: receipt.afterDrag.placement },
      docked: receipt.docked && Object.fromEntries(Object.entries(receipt.docked).map(([k, v]) => [k, { reopened: v.reopened && { outer: v.reopened.outer, box: v.reopened.box, pin: v.reopened.pin }, movedBy: v.movedBy }])) }))
    for (const w of BrowserWindow.getAllWindows()) try { w.destroy() } catch { /* gone */ }
    server.close()
  }
  app.exit(receipt.ok ? 0 : 1)
}).catch(fail)
