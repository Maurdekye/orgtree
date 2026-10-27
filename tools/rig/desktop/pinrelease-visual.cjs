// Pinned panel release frames (tools/rig/pinrelease-visual.mjs): the Apps workspace with one window-pinned panel.
// Two scenarios, each on a fresh page: "save" drags the panel's title bar by CDP and releases it while the save
// answers 150 ms later; "stale" does the same while a panel list read that began before the release answers 450 ms
// after it, holding the placement the drag began from. The panel's painted rectangle is sampled on every animation
// frame from just before the release until 900 ms after; no frame after the release may show the panel where the
// drag began, and it must not move again after it lands. Screenshots during the save and after. The page is served
// from this process on loopback (a panel's frame needs an http page origin for its media source), only the build's
// own files. Refuses outside Session 0; SILENT (muted); every permission refused; the page clipboard replaced by a
// refusal; requests other than that loopback origin and data: cancelled; input only through CDP to this window.
const { app, BrowserWindow, session } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const http = require('node:http')
const out = process.argv[process.argv.indexOf('--probe-out') + 1]
if (!out || !path.isAbsolute(out)) throw new Error('--probe-out needs an absolute artifact folder')
for (const key of ['userData', 'sessionData', 'logs', 'crashDumps']) {
  const folder = path.join(out, key); fs.mkdirSync(folder, { recursive: true }); app.setPath(key, folder)
}
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('mute-audio')
app.on('window-all-closed', () => {})
const CLIPBOARD = `(() => { if (window.__clipboardCalls) return true
  const calls = []; Object.defineProperty(window, '__clipboardCalls', { value: calls })
  const deny = name => () => { calls.push(name); return Promise.reject(new DOMException('Clipboard denied', 'NotAllowedError')) }
  try { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: Object.freeze({ read: deny('read'), readText: deny('readText'), write: deny('write'), writeText: deny('writeText') }) }) } catch { calls.push('stub-failed') }
  const exec = Document.prototype.execCommand
  Document.prototype.execCommand = function (command, ...rest) { if (/^(copy|cut|paste)$/i.test(String(command))) { calls.push('execCommand:' + command); return false } return exec.call(this, command, ...rest) }
  return true })()`

const step = name => console.log(`[pinrelease] ${new Date().toISOString()} ${name}`)
setTimeout(() => { console.error('[pinrelease] deadline: no result after 110 s'); app.exit(2) }, 110000).unref()
app.whenReady().then(async () => {
  step('ready')
  const sessionId = Number(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${process.pid}).SessionId`], { encoding: 'utf8', windowsHide: true }).trim())
  if (sessionId !== 0) { console.error(`refusing to run outside Windows Session 0 (this Electron runs in Session ${sessionId})`); app.exit(1); return }
  const permissions = []
  session.defaultSession.setPermissionRequestHandler((_c, p, cb) => { permissions.push(p); cb(false) })
  session.defaultSession.setPermissionCheckHandler((_c, p) => { permissions.push('check:' + p); return false })
  // Session 0's display is 1024 x 768: a larger window is clamped to it
  const win = new BrowserWindow({ width: 1000, height: 680, show: false, useContentSize: true,
    webPreferences: { offscreen: true, backgroundThrottling: false, contextIsolation: true, sandbox: true, nodeIntegration: false } })
  win.webContents.setAudioMuted(true)
  win.webContents.setFrameRate(60)
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  // the page's own errors, for the result
  const consoleLines = []
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 2) consoleLines.push(message.slice(0, 400)) })
  // the build's own files, by name, on loopback only
  const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.png': 'image/png', '.svg': 'image/svg+xml' }
  const server = http.createServer((req, res) => {
    const name = decodeURIComponent((req.url || '/').split('?')[0]).split('/').filter(Boolean).pop() || 'index.html'
    const file = path.join(out, name)
    if (path.basename(name) !== name || !TYPES[path.extname(name)] || !fs.existsSync(file)) { res.writeHead(404); res.end(); return }
    res.writeHead(200, { 'content-type': TYPES[path.extname(name)] }); res.end(fs.readFileSync(file))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}/`
  win.webContents.session.webRequest.onBeforeRequest((details, done) =>
    done({ cancel: !details.url.startsWith(origin) && !details.url.startsWith('data:') && details.url !== 'about:blank' }))
  await win.loadURL('about:blank')
  const cdp = win.webContents.debugger
  cdp.attach('1.3')
  await cdp.sendCommand('Page.enable')
  await cdp.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: CLIPBOARD })
  step(`session ${sessionId}, debugger attached`)
  const js = (code) => win.webContents.executeJavaScript(code)
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
  const frames = n => js(`new Promise(r=>{let i=0;const f=()=>{if(++i>=${n})r(true);else requestAnimationFrame(f)};requestAnimationFrame(f)})`)
  const mouse = (type, x, y) => cdp.sendCommand('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : 'left',
    buttons: type === 'mouseReleased' ? 0 : 1, clickCount: type === 'mouseMoved' ? 0 : 1 })
  const results = []
  try {
    for (const scenario of ['save', 'stale']) {
      await win.loadURL(origin + 'index.html')
      await js(CLIPBOARD)
      await js(`new Promise((resolve,reject)=>{const t=Date.now();const f=()=>{if(window.pinReleaseVisual?.rect()?.w>0)resolve(true);else if(Date.now()-t>10000)reject(Error('no panel'));else setTimeout(f,50)};f()})`)
      await frames(4)
      const pre = await js('window.pinReleaseVisual.rect()'), bar = await js('window.pinReleaseVisual.bar()')
      step(`${scenario}: panel at ${JSON.stringify(pre)}`)
      // press the title bar, move 100,50 in steps, as a hand does
      await mouse('mouseMoved', bar.x, bar.y); await mouse('mousePressed', bar.x, bar.y)
      for (let i = 1; i <= 10; i++) { await mouse('mouseMoved', bar.x + i * 10, bar.y + i * 5); await frames(1) }
      await frames(2)
      const dragged = await js('window.pinReleaseVisual.rect()')
      if (scenario === 'stale') {
        // a change elsewhere starts a list read now; it finds the panel where the drag began and answers late
        await js('window.pinReleaseVisual.knobs.listDelay = 450; window.pinReleaseVisual.invalidate(); true')
        await sleep(30)
      }
      await js('window.pinReleaseVisual.start(); true')
      await frames(2)
      const releasedAt = await js('performance.now()')
      await mouse('mouseReleased', bar.x + 100, bar.y + 50)
      await sleep(70)
      fs.writeFileSync(path.join(out, `${scenario}-during-save.png`), (await win.webContents.capturePage()).toPNG())
      await sleep(scenario === 'stale' ? 830 : 830)
      const samples = await js('window.pinReleaseVisual.stop()')
      fs.writeFileSync(path.join(out, `${scenario}-after.png`), (await win.webContents.capturePage()).toPNG())
      const saved = await js('window.pinReleaseVisual.saved()')
      const after = samples.filter(s => s.t >= releasedAt)
      const near = (s, r) => Math.abs(s.x - r.x) <= 2 && Math.abs(s.y - r.y) <= 2
      const atStart = after.filter(s => near(s, pre))
      const final = after.at(-1)
      const moves = after.filter((s, i) => i > 0 && (s.x !== after[i - 1].x || s.y !== after[i - 1].y))
      const verdict = { scenario, pre, dragged, saved, frames: after.length,
        framesAtDragStart: atStart.length, firstAtDragStart: atStart[0] ? Math.round(atStart[0].t - releasedAt) : null,
        landed: final ?? null, movesAfterRelease: moves.length, spanMs: after.length ? Math.round(after.at(-1).t - after[0].t) : 0,
        ok: after.length >= 20 && atStart.length === 0 && !!final && near(final, dragged) && moves.length === 0 && saved.rev === 2 }
      results.push(verdict)
      fs.writeFileSync(path.join(out, `${scenario}-frames.json`), JSON.stringify({ releasedAt, samples }, null, 2))
      step(`${scenario}: ${after.length} frames after release, ${atStart.length} at the drag start, ${moves.length} moves, ok=${verdict.ok}`)
    }
    const clipboard = await js('window.__clipboardCalls ?? []')
    const passed = results.every(r => r.ok) && clipboard.length === 0
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ passed, sessionId, muted: win.webContents.isAudioMuted(), clipboard,
      permissions, results }, null, 2))
    console.log(JSON.stringify({ passed, sessionId, results: results.map(r => ({ scenario: r.scenario, ok: r.ok, frames: r.frames,
      framesAtDragStart: r.framesAtDragStart, movesAfterRelease: r.movesAfterRelease })) }))
    win.destroy(); server.close(); app.exit(passed ? 0 : 1)
  } catch (error) {
    console.error(error)
    try { fs.writeFileSync(path.join(out, 'failure-dom.html'), await js('document.body.outerHTML')) } catch { /* the page is gone */ }
    fs.writeFileSync(path.join(out, 'failure-console.json'), JSON.stringify(consoleLines, null, 2))
    win.destroy(); server.close(); app.exit(1)
  }
}).catch(error => { console.error(error); app.exit(1) })
