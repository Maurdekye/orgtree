'use strict'
// Frame-sequence capture for the panel start/stop zoom (docket
// 4-5-0-quick-zoom-animation-when-a-panel-starts-z). Electron main process:
// serves the Apps workspace fixture (panelmotion-ui.tsx) with a stateful
// synthetic apps API from a local server, installs the desktop's own session
// guard (main/windows.ts configureEngineSession, bundled from this checkout)
// and drives one offscreen window, and the pop-out it opens, by CDP input.
//
// Evidence in PANELZ_OUT: per scenario, frames/<scenario>/ holds every frame
// painted from just before the action to 700 ms after it, named by
// milliseconds after the action, and sheet-<scenario>.png lays them out.
// capture.json has the in-page samples (computed scale, effective opacity,
// backdrop colour and box at every animation frame), process session IDs and
// the checks.
//
// Run from the repository root, in Session 0 under the build permit
// (docs/agents/development-and-verification.md, test-window isolation):
//   set PANELZ_OUT=C:\orgtree-build\<agent>\<folder>   (required, owned)
//   set PANELZ_NODE_MODULES=<existing node_modules>   (default ./node_modules)
//   <node_modules>\electron\dist\electron.exe apps\desktop\renderer\tests\panelmotion-capture.cjs
// No clipboard use; permissions follow the real guard; audio is muted
// (--mute-audio and setAudioMuted) and the fixture plays no media.
const { app, BrowserWindow, nativeImage, session } = require('electron')
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), cp = require('node:child_process')

const REPO = process.cwd()
const OUT = process.env.PANELZ_OUT || ''
const NM = process.env.PANELZ_NODE_MODULES || path.join(REPO, 'node_modules')
const SLUG = 'synthetic-panels', TOKEN = 'capture-token-' + process.pid
const WINDOW_MS = 700
const receipt = { started: new Date().toISOString(), requests: [], static: [], scenarios: {}, console: [], problems: [] }
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
const copy = (id, label, placement, minute) => ({ id, app: 'timer', label, rev: 1, open: false, running: false, run_generation: 1,
  state: {}, event_seq: 0, placement, created_at: `2026-10-27T08:0${minute}:00Z`, used_at: AT, updated_at: AT })
const panels = [
  copy('float', 'Floating', { mode: 'float', x: 120, y: 120, width: 420, height: 300 }, 1),
  copy('pinned', 'Pinned', { mode: 'window', x: 560, y: 300, width: 400, height: 280 }, 2),
  copy('popped', 'Popped out', { mode: 'float', x: 120, y: 120, width: 420, height: 300 }, 3),
]
const find = (id) => panels.find((p) => p.id === id)

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
      if (p === '/') return send(200, 'text/html; charset=utf-8', '<!doctype html><meta charset="utf-8"><title>Panel motion capture</title>'
        + '<link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/shell.css"><link rel="stylesheet" href="/fixture.css">'
        + '<div id="root"></div><script type="module" src="/fixture.js"></script>')
      if (files[p] || !p.startsWith('/api/')) {
        const ok = !!files[p] && fs.existsSync(files[p].file)
        receipt.static.push({ path: p, status: ok ? 200 : 404, dest: req.headers['sec-fetch-dest'] || '' })
        return ok ? send(200, files[p].type, fs.readFileSync(files[p].file)) : send(404, 'text/plain', 'none')
      }
      const base = `/api/orgs/${SLUG}/apps`
      let input = {}
      try { input = req.method === 'POST' ? JSON.parse(raw || '{}') : JSON.parse(url.searchParams.get('request') || '{}') } catch { /* bad input */ }
      receipt.requests.push({ at: Date.now(), path: p, action: input.action || null, panel: input.panel || null, token: req.headers['x-orgtree-desktop-token'] === TOKEN })
      if (p === base + '/runtime') return json(input.action === 'heartbeat' ? { stop: [], sample_epoch: 0 } : {})
      if (p === base + '/bridge') return json({ closed: true })
      if (p !== base) return json({ detail: 'not in this fixture' }, 404)
      const panel = input.panel ? find(input.panel) : null
      switch (input.action) {
        case 'list':
          if (input.kind === 'apps') return json({ kind: 'apps', items: [appDef], next_cursor: null, new_count: 0 })
          return json({ kind: 'panels', items: panels.filter((x) => (input.running === undefined || x.running === input.running) && (input.open === undefined || x.open === input.open)), next_cursor: null })
        case 'app_get': return json(appDef)
        case 'panel_get': return panel ? json(panel) : json({ detail: 'no such panel' }, 404)
        case 'events': return json({ panel: input.panel, events: [], next_cursor: null, oldest_retained: null })
        case 'panel_open': if (!panel.running) panel.run_generation++; Object.assign(panel, { open: true, running: true, used_at: new Date().toISOString() }); panel.rev++; return json(panel)
        case 'panel_update': for (const k of ['open', 'placement', 'label']) if (k in input) panel[k] = input[k]; panel.rev++; return json(panel)
        case 'panel_start': panel.running = true; panel.rev++; return json(panel)
        case 'panel_stop': Object.assign(panel, { running: false, open: false }); panel.run_generation++; panel.rev++; return json(panel)
        default: return json({ detail: 'not in this fixture: ' + input.action }, 400)
      }
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)))
}

// Every animation frame in one document: is the panel there, its marker, its
// computed scale, its effective opacity (its own times its ancestors'), the
// centred backdrop's colour and its box (which includes the scale).
const SAMPLER = `window.__motion=(sel,ms)=>new Promise(resolve=>{const out=[];let t0=null;window.__actAt=null
const down=()=>{window.__actAt=performance.now()};document.addEventListener('pointerdown',down,true)
const eff=el=>{let o=1;for(let n=el;n&&n.nodeType===1;n=n.parentElement)o*=Number(getComputedStyle(n).opacity);return Math.round(o*1000)/1000}
const step=now=>{if(t0===null)t0=now;const el=document.querySelector(sel),cs=el&&getComputedStyle(el),bd=el&&el.closest('.custom-app-centered')
out.push({t:Math.round(now-t0),present:!!el,motion:el?el.dataset.motion||null:null,parked:el?!!el.dataset.parked:null,inert:el?el.hasAttribute('inert'):null,scale:cs?cs.scale:null,opacity:el?eff(el):null,backdrop:bd?getComputedStyle(bd).backgroundColor:null,box:el?(r=>[Math.round(r.left),Math.round(r.top),Math.round(r.width),Math.round(r.height)])(el.getBoundingClientRect()):null})
window.__sofar={actAt:window.__actAt===null?null:Math.round(window.__actAt-t0),samples:out}
if(now-t0<ms)requestAnimationFrame(step);else{document.removeEventListener('pointerdown',down,true);resolve({actAt:window.__actAt===null?null:Math.round(window.__actAt-t0),samples:out})}}
requestAnimationFrame(step)});true`

let windows
try {
  if (!/^C:[\\/]orgtree-build[\\/][^\\/]+[\\/]/i.test(OUT)) throw Error('PANELZ_OUT must be an owned C:\\orgtree-build\\<agent>\\ folder')
  fs.mkdirSync(OUT, { recursive: true })
  const esbuild = require(path.join(NM, 'esbuild'))
  // CSS the components import (apps.css with the keyframes) lands in fixture.css.
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
  rec.stop = () => { rec.on = false; if (!offscreen) try { wc.endFrameSubscription() } catch { /* window gone */ } }
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
  register(win)
  const wc = win.webContents
  wc.setFrameRate(60)
  wc.setAudioMuted(true)
  const mainRec = recorder(wc)
  let child = null, childRec = null, childDbg = null
  receipt.popout = {}
  // The renderer's named about:blank pop-outs only. An offscreen window.open
  // child kept a 0x0 viewport even after a resize (measured 2026-10-27), so the
  // pop-out is an ordinary frameless window, shown inactive in Session 0.
  wc.setWindowOpenHandler(({ url, frameName }) => url === 'about:blank' && /^orgtree-popout-/.test(frameName)
    ? { action: 'allow', overrideBrowserWindowOptions: { show: false, frame: false, paintWhenInitiallyHidden: true, webPreferences: { ...prefs, offscreen: false } } }
    : { action: 'deny' })
  wc.on('did-create-window', (w) => {
    child = w; register(w, true)
    const cwc = w.webContents
    receipt.popout.offscreen = cwc.isOffscreen()
    log('pop-out window created, offscreen ' + cwc.isOffscreen())
    if (cwc.isOffscreen()) cwc.setFrameRate(60)
    // An ordinary window paints only while shown: in Session 0 that shows nobody anything.
    else { w.showInactive(); receipt.popout.shownInSession0 = true }
    cwc.setAudioMuted(true)
    childRec = recorder(cwc)
    childDbg = cwc.debugger; childDbg.attach('1.3')
    w.on('closed', () => { receipt.popout.closedAt = performance.now(); child = null })
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

  /** Records one action: frames from its document and the sampler's frames. */
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
    if (!sampled && sofar) { sampled = sofar; receipt.scenarios[name + ':sampling'] = 'read while the document lived; it closed before the window ended' }
    if (!sampled) { problems.push(name + ': the page drew no animation frames to sample'); sampled = { actAt: null, samples: [] } }
    await sleep(Math.max(0, WINDOW_MS + 60 - (performance.now() - at)))
    rec.stop()
    const dir = path.join(OUT, 'frames', name); fs.mkdirSync(dir, { recursive: true })
    const shots = rec.frames.map((f, i) => {
      const ms = Math.round(f.t - at), file = `${String(i).padStart(2, '0')}_${ms >= 0 ? '+' : ''}${ms}ms.png`
      const image = nativeImage.createFromBitmap(f.bitmap, { width: f.size.width, height: f.size.height, scaleFactor: 1 })
      fs.writeFileSync(path.join(dir, file), image.toPNG())
      return { file, ms, image }
    })
    const s = sampled.samples, act0 = sampled.actAt
    const rel = s.map((x) => ({ ...x, t: act0 === null ? x.t : x.t - act0 }))
    receipt.scenarios[name] = { recorder: rec.mode, actionInPage: act0, actionAtMain: at, frames: shots.map((x) => x.file), samples: rel }
    await sheet(name, shots, rel)
    fs.writeFileSync(path.join(OUT, 'capture.json'), JSON.stringify(receipt, null, 2))
    log(`  ${shots.length} frames, ${rel.length} samples`)
    return rel
  }

  /** A contact sheet: the frames from just before to 400 ms after the action,
   *  cropped to the area the panel covered, each labelled with its time. */
  async function sheet(name, shots, samples) {
    const boxes = samples.filter((x) => x.box).map((x) => x.box)
    if (!boxes.length || !shots.length) return
    const W = shots[0].image.getSize().width, H = shots[0].image.getSize().height
    const x0 = Math.max(0, Math.min(...boxes.map((b) => b[0])) - 24), y0 = Math.max(0, Math.min(...boxes.map((b) => b[1])) - 24)
    const x1 = Math.min(W, Math.max(...boxes.map((b) => b[0] + b[2])) + 24), y1 = Math.min(H, Math.max(...boxes.map((b) => b[1] + b[3])) + 24)
    const picked = shots.filter((x) => x.ms >= -40 && x.ms <= 420).slice(0, 24)
    const dir = path.join(OUT, 'sheets', name); fs.mkdirSync(dir, { recursive: true })
    // A window cannot outgrow the display (1024x768 in Session 0): the widest
    // cells whose grid fits in 1000x728.
    const aspect = (y1 - y0) / (x1 - x0), n = picked.length
    let fit = null
    for (let cols = 2; cols <= 8; cols++) {
      const w = Math.min(320, Math.floor(984 / cols) - 8), h = Math.round(w * aspect) + 22, rows = Math.ceil(n / cols)
      if (rows * (h + 8) + 40 <= 728 && (!fit || w > fit.w)) fit = { cols, w, h, rows }
    }
    if (!fit) { const w = Math.floor(984 / 8) - 8; fit = { cols: 8, w, h: Math.round(w * aspect) + 22, rows: Math.ceil(n / 8) } }
    const cells = picked.map((x, i) => {
      const crop = x.image.crop({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 }).resize({ width: fit.w })
      const file = `${i}.png`; fs.writeFileSync(path.join(dir, file), crop.toPNG())
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

  const zoomed = (s) => s.some((x) => x.present && numeric(x.scale) > 0.5 && numeric(x.scale) < 0.95)
  const atRest = (x) => x.present && (x.scale === 'none' || numeric(x.scale) === 1)
  try {
    await wc.loadURL(origin + '/')
    receipt.processes = { main: { pid: process.pid, session: sessionOf(process.pid) } }
    const rendererPid = wc.getOSProcessId()
    receipt.processes.renderer = { pid: rendererPid, session: sessionOf(rendererPid) }
    receipt.clipboard = 'not used; the real session guard decided permissions'
    await until(() => js(`!!document.querySelector('.apps-button')`), 'Apps button')
    await settle()

    // 1. Floating: start (zoom in), Hide and show (instant controls), Power off (zoom out)
    await openMenu()
    let s = await scenario('float-start', panelSel('float'), () => press(row('Floating'), 'Floating row'))
    expect(s.some((x) => x.motion === 'start') && zoomed(s), 'float-start did not zoom in')
    expect(s.some((x) => x.backdrop && /rgba\(0, 0, 0, 0\.[0-3]/.test(x.backdrop)), 'float-start backdrop did not fade in')
    expect(atRest(s.at(-1)) && s.at(-1).opacity === 1 && s.at(-1).motion === null, 'float-start did not end at rest')
    await until(() => js(`!!document.querySelector('${panelSel('float')} iframe')`), 'Floating frame')
    await settle()
    s = await scenario('float-hide', panelSel('float'), () => press(`${q(panelSel('float'))}.querySelector('[aria-label="Hide Floating"]')`, 'Hide Floating'))
    expect(!zoomed(s) && s.every((x) => x.motion === null), 'Hide animated')
    expect(s.filter((x) => x.opacity > 0 && x.opacity < 1).length === 0, 'Hide faded instead of hiding at once')
    await openMenu()
    s = await scenario('float-show', panelSel('float'), () => press(row('Floating'), 'Floating row (hidden)'))
    expect(!zoomed(s) && s.every((x) => x.motion === null) && s.filter((x) => x.opacity > 0 && x.opacity < 1).length === 0, 'show animated')
    await settle()
    s = await scenario('float-stop', panelSel('float'), () => press(`${q(panelSel('float'))}.querySelector('[aria-label="Power off Floating"]')`, 'Power off Floating'))
    expect(s.some((x) => x.motion === 'stop' && x.inert) && zoomed(s), 'float-stop did not zoom out')
    expect(!s.at(-1).present, 'float-stop left the window behind')
    receipt.scenarios['float-stop'].removedAfterMs = s.find((x, i) => i > 0 && !x.present && s[i - 1].present)?.t ?? null

    // 2. Window-pinned: start and Power off in the pin layer
    await openMenu()
    s = await scenario('pinned-start', panelSel('pinned'), () => press(row('Pinned'), 'Pinned row'))
    expect(s.some((x) => x.motion === 'start') && zoomed(s), 'pinned-start did not zoom in')
    receipt.scenarios['pinned-start'].inPinLayer = await js(`!!${q(panelSel('pinned'))}?.closest('[data-pin-layer]')`)
    await settle()
    s = await scenario('pinned-stop', panelSel('pinned'), () => press(`${q(panelSel('pinned'))}.querySelector('[aria-label="Power off Pinned"]')`, 'Power off Pinned'))
    expect(s.some((x) => x.motion === 'stop') && zoomed(s) && !s.at(-1).present, 'pinned-stop did not zoom out')

    // 3. Popped out: start (centred), pop out, Power off inside the pop-out, then open again
    await openMenu()
    await scenario('popout-first-start', panelSel('popped'), () => press(row('Popped out'), 'Popped out row'))
    await until(() => js(`!!document.querySelector('${panelSel('popped')} iframe')`), 'Popped out frame')
    await settle()
    await press(`${q(panelSel('popped'))}.querySelector('.popout-button')`, 'pop-out button')
    await until(() => child && js(`!!${q(panelSel('popped'))}`, child.webContents), 'the pop-out window')
    await settle(child.webContents)
    receipt.popout.viewport = await js('[innerWidth,innerHeight]', child.webContents)
    log('pop-out holds the panel; recorder ' + (childRec && childRec.mode) + ', viewport ' + receipt.popout.viewport)
    receipt.popout.placement = find('popped').placement.mode
    receipt.popout.size = child.getContentSize()
    if (childRec) {
      s = await scenario('popout-stop', panelSel('popped'), () => press(`${q(panelSel('popped'))}.querySelector('[aria-label="Power off Popped out"]')`, 'Power off in the pop-out', child.webContents, childDbg),
        { target: child.webContents, rec: childRec, stream: true })
      expect(s.some((x) => x.motion === 'stop') && zoomed(s), 'popout-stop did not zoom out inside the pop-out')
    } else problems.push('no recorder for the pop-out window')
    await until(() => !child, 'the pop-out window to close', 3000)
    receipt.popout.closedMsAfterAction = receipt.scenarios['popout-stop'] ? Math.round(receipt.popout.closedAt - receipt.scenarios['popout-stop'].actionAtMain) : null
    await openMenu()
    s = await scenario('popout-reopen', panelSel('popped'), () => press(row('Popped out'), 'Popped out row (stopped)'))
    receipt.popout.reopened = await js(`(()=>{const el=${q(panelSel('popped'))};const o=el&&el.closest('.custom-app-placeholder,.custom-app-centered,.pin-layer');return el?{outer:o?o.className:null,detached:!!el.dataset.detached,box:(r=>[Math.round(r.left),Math.round(r.top),Math.round(r.width),Math.round(r.height)])(el.getBoundingClientRect())}:null})()`)
    receipt.popout.reopenedInNewWindow = !!child
    expect(s.some((x) => x.motion === 'start') && zoomed(s), 'popout-reopen did not zoom in')
    await settle()
    await press(`${q(panelSel('popped'))}.querySelector('[aria-label="Power off Popped out"]')`, 'Power off Popped out (docked)')
    await until(() => js(`!${q(panelSel('popped'))}`), 'Popped out gone')

    // 4. Reduced motion: the same start and Power off fade only
    await dbg.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
    receipt.reducedMotion = await js(`matchMedia('(prefers-reduced-motion: reduce)').matches`)
    await openMenu()
    s = await scenario('reduced-start', panelSel('float'), () => press(row('Floating'), 'Floating row (reduced)'))
    expect(s.some((x) => x.motion === 'start') && s.every((x) => !x.present || numeric(x.scale) === 1) && s.some((x) => x.opacity > 0 && x.opacity < 1), 'reduced-start was not a fade only')
    await settle()
    s = await scenario('reduced-stop', panelSel('float'), () => press(`${q(panelSel('float'))}.querySelector('[aria-label="Power off Floating"]')`, 'Power off Floating (reduced)'))
    expect(s.some((x) => x.motion === 'stop') && s.every((x) => !x.present || numeric(x.scale) === 1) && s.some((x) => x.opacity > 0 && x.opacity < 1) && !s.at(-1).present, 'reduced-stop was not a fade only')
    await dbg.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] })

    // 5. Stopped elsewhere (Stop all, an agent): the next listing drops it
    await openMenu()
    await press(row('Floating'), 'Floating row (again)')
    await until(() => js(`!!document.querySelector('${panelSel('float')} iframe')&&!${q(panelSel('float'))}.dataset.motion`), 'Floating shown again')
    await settle()
    s = await scenario('elsewhere-stop', panelSel('float'), async () => {
      Object.assign(find('float'), { running: false, open: false }); find('float').run_generation++; find('float').rev++
      const at = performance.now(); await js('window.__actAt=performance.now();refreshPanels();true'); return at
    })
    expect(s.some((x) => x.motion === 'stop') && zoomed(s) && !s.at(-1).present, 'elsewhere-stop did not zoom out')
    expect(!receipt.requests.some((r) => !r.token), 'an unsigned request reached the server')
  } catch (e) {
    problems.push(String(e && e.stack || e))
    try { const image = await wc.capturePage(); if (!image.isEmpty()) fs.writeFileSync(path.join(OUT, 'failure.png'), image.toPNG()) } catch { /* nothing to capture */ }
  } finally {
    receipt.ok = problems.length === 0
    receipt.finished = new Date().toISOString()
    fs.writeFileSync(path.join(OUT, 'capture.json'), JSON.stringify(receipt, null, 2))
    const brief = Object.fromEntries(Object.entries(receipt.scenarios).map(([k, v]) => [k, { frames: v.frames.length, samples: v.samples.length }]))
    console.log(JSON.stringify({ ok: receipt.ok, problems, processes: receipt.processes, popout: receipt.popout, reducedMotion: receipt.reducedMotion, scenarios: brief }))
    try { child?.destroy() } catch { /* gone */ }
    win.destroy()
    server.close()
  }
  app.exit(receipt.ok ? 0 : 1)
}).catch(fail)
