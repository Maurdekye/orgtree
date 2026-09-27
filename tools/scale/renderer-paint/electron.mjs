import { app, BrowserWindow, ipcMain } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import net from 'node:net'
import { installPaintProbe } from './instrument.mjs'
import { decodePixel, percentiles, validateLoad } from './model.mjs'

const run = JSON.parse(fs.readFileSync(process.env.ORGTREE_PAINT_RUN, 'utf8'))
const epoch = () => performance.timeOrigin + performance.now()
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const save = (name, value) => fs.writeFileSync(path.join(run.output, name), JSON.stringify(value, null, 2))
const journal = value => fs.appendFileSync(path.join(run.output, 'events.jsonl'), JSON.stringify(value) + '\n')
app.setPath('userData', path.join(run.output, 'profile'))
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-background-timer-throttling')
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
let win, proxy, descriptor, agent
const sockets = new Set(), paintTimes = new Map(), actions = [], errors = [], ipcCalls = {}
let paints = 0, clock, controls
let startupDeadline = setTimeout(() => {
  save('renderer.json', { complete: false, error: 'Electron startup exceeded45s', paints, actions, errors });finish(1)
}, 45000)
const identity = { windowId: 'renderer-paint-probe', kind: 'org', org: run.org, notificationOwner: true }
const preferences = { visualTheme: 'dark', contrastTheme: 'default', agentColorSource: 'model',
  startupMode: 'restore', onboarded: true, automaticUpdates: false, routineNotifications: false,
  exitOnClose: false, startAtLogin: false }
// Native shell only; never substitute HTTP data, React state or the renderer entrypoint.
const handlers = {
  'window-identity': () => identity, 'open-orgs': () => [run.org], 'preferences': () => preferences,
  'set-preferences': p => Object.assign(preferences, p), 'status': () => ({ state: 'ready' }),
  'app-version': () => 'renderer-paint-harness', 'window-state': () => ({ maximized: false }),
  'window-controls-state': () => ({ maximized: false }), 'update-status': () => ({ state: 'idle' }),
  'update-capability': () => ({ supported: false }), 'maintenance-status': () => ({ state: 'idle' }),
  'take-pending-events': () => [], 'pending-attention': () => undefined, 'sync-notifications': () => undefined,
  'set-effective-theme': () => undefined, 'harnesses': () => [], 'notify': () => false,
  'request-org': org => ({ action: 'focused', identity: { ...identity, org } }),
}
ipcMain.on('desktop:window-identity-sync', e => { e.returnValue = { identity, token: 'isolated-paint-document' } })
ipcMain.on('desktop:events-listening', () => {})
for (const [key, fn] of Object.entries(handlers)) ipcMain.handle('desktop:' + key, (_, ...args) => {
  ipcCalls[key] = (ipcCalls[key] || 0) + 1; return fn(...args)
})
const js = source => win.webContents.executeJavaScript(source, true)
async function until(fn, timeout = 30000) {
  const end = performance.now() + timeout
  while (performance.now() < end) { const value = await fn(); if (value) return value; await sleep(25) }
  throw Error('readiness/paint deadline exceeded')
}
function loadNow() {
  if (run.mode === 'selfcheck') return null
  const current = JSON.parse(fs.readFileSync(run.descriptor, 'utf8'))
  if (current.serve.pid !== descriptor.serve.pid || current.origin !== descriptor.origin) throw Error('Engine identity changed')
  return validateLoad(current, run.label)
}
async function action(name, selector, ready, { delayMs = 0, timeout = 15000, suppressed = false, measured = true } = {}) {
  const load = loadNow()
  const point = await js(`window.__paintProbe.arm(${JSON.stringify(name)},${JSON.stringify(selector)},${JSON.stringify(ready)},${delayMs})`)
  const start = epoch()
  win.webContents.sendInputEvent({ type: 'mouseMove', ...point })
  win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point })
  win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point })
  let batch = null, painted = null
  try {
    await until(async () => {
      batch = await js(`window.__paintProbe.state.batches.find(b=>b.rows.some(r=>r.name===${JSON.stringify(name)})) || null`)
      painted = batch && paintTimes.get(batch.id)
      return painted != null
    }, timeout)
  } catch (e) {
    if (!suppressed || !batch || paintTimes.has(batch.id)) throw e
  } finally { await js('window.__paintProbe.finish()') }
  if (suppressed && painted != null) throw Error('Suppressed paint control falsely passed')
  const row = { name, measured, start, inputPoint: point, painted, ms: painted == null ? null : painted - start,
    batch, load: load && { label: load.label, since: load.since }, suppressed }
  if (!suppressed && (row.ms < 0 || !batch?.rows.some(r => r.clicked != null))) throw Error('Unproven click')
  actions.push(row); journal({ action: row }); return row
}
async function calibrate() {
  const pings = []
  for (let n = 0; n < 12; n++) {
    const before = epoch(), renderer = await js('performance.timeOrigin+performance.now()'), after = epoch()
    pings.push({ offset: (before + after) / 2 - renderer, error: (after - before) / 2 })
  }
  const best = pings.sort((a, b) => a.error - b.error)[0]
  if (best.error > 10) throw Error('Clock calibration uncertainty exceeds10ms')
  return best
}
async function selfcheck() {
  await js(`(()=>{const b=document.createElement('button');b.id='paint-control';b.textContent='Paint timing control';
    b.style.cssText='position:fixed;top:15px;left:15px;z-index:2147483646;background:white;color:black;padding:8px';
    window.__paintControl=0;b.onclick=()=>{window.__paintControl++;b.textContent='Paint control '+window.__paintControl};document.body.appendChild(b)})()`)
  // Fixed warmup, then three retained baseline samples. The first OS-dispatched
  // input can pay target startup; never use that single cold sample as baseline.
  let count = 0
  const click = (name, options = {}) => action(name, '#paint-control', 'window.__paintControl===' + (++count), { measured: false, ...options })
  for (let i = 0; i < 2; i++) await click('warm-paint-control-' + i)
  const baseline = []
  for (let i = 0; i < 3; i++) baseline.push(await click('paint-control-' + i))
  const fastMs = percentiles(baseline.map(row => row.ms)).p50
  const delayed = await click('delayed-paint-control', { delayMs: 250 })
  const absent = await click('suppressed-paint-control', { suppressed: true, timeout: 500 })
  const delays = await js('window.__paintProbe.state.delayExecutions')
  if (delayed.ms < 240 || delayed.ms - fastMs < 180 || delays.length !== 1 || delays[0].elapsed < 250)
    throw Error('Deliberate250ms paint delay was not measured')
  if (!absent.batch || absent.painted != null) throw Error('Missing paint did not fail closed')
  await js('document.querySelector("#paint-control").remove()')
  return { baselineMs: baseline.map(row => row.ms), fastMs, delayedMs: delayed.ms, deltaMs: delayed.ms - fastMs,
    actualDelay: delays[0], suppressedPaintDetected: true }
}
async function makeProxy() {
  const upstream = new URL(descriptor.origin)
  proxy = http.createServer((req, res) => {
    if (req.url.startsWith('/api/')) {
      // Read-only renderer harness; UI callbacks must never issue product mutations.
      if (!['GET', 'HEAD'].includes(req.method)) { errors.push('blocked HTTP mutation:' + req.method + ' ' + req.url); res.writeHead(405);res.end();return }
      const begin = epoch()
      const request = http.request({ hostname: upstream.hostname, port: upstream.port, path: req.url, method: req.method,
        headers: { ...req.headers, host: upstream.host, 'x-orgtree-desktop-token': descriptor.token } }, response => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.statusCode !== 304) {
          res.writeHead(502);res.end('redirect refused');response.resume();return
        }
        let bytes = 0; response.on('data', b => { bytes += b.length })
        response.on('end', () => journal({ http: req.url, status: response.statusCode, bytes, at: begin, ms: epoch() - begin }))
        res.writeHead(response.statusCode, response.headers); response.pipe(res)
      })
      request.setTimeout(30000, () => request.destroy(Error('upstream deadline')))
      request.on('error', e => { if (!res.headersSent) res.writeHead(502);res.end('upstream failed'); errors.push(String(e)) })
      req.pipe(request); return
    }
    const pathname = new URL(req.url, 'http://localhost').pathname
    const ui = path.join(run.build, 'ui')
    const file = pathname.startsWith('/assets/') ? path.resolve(ui, '.' + pathname) : path.join(ui, 'index.html')
    if (!file.startsWith(ui + path.sep) || !fs.existsSync(file)) { res.writeHead(404);res.end();return }
    res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' })[path.extname(file)] || 'application/octet-stream')
    fs.createReadStream(file).pipe(res)
  })
  proxy.on('connection', s => { sockets.add(s);s.on('close', () => sockets.delete(s)) })
  proxy.on('upgrade', (req, socket, head) => {
    if (!req.url.startsWith('/api/orgs/' + encodeURIComponent(run.org) + '/ws?')) { socket.destroy();return }
    const target = net.connect(Number(upstream.port), upstream.hostname, () => {
      const headers = { ...req.headers, host: upstream.host, 'x-orgtree-desktop-token': descriptor.token }
      target.write(`${req.method} ${req.url} HTTP/1.1\r\n` + Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n\r\n')
      if (head.length) target.write(head)
      socket.pipe(target).pipe(socket)
    })
    sockets.add(target);target.on('close', () => sockets.delete(target))
    target.on('error', () => socket.destroy());socket.on('error', () => target.destroy());socket.on('close', () => target.destroy())
  })
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve))
  return 'http://127.0.0.1:' + proxy.address().port
}
function finish(code) {
  clearTimeout(startupDeadline)
  if (win && !win.isDestroyed()) win.destroy()
  for (const s of sockets) s.destroy()
  proxy?.close();app.exit(code)
}
app.whenReady().then(async () => {
  let origin = 'http://127.0.0.1:1'
  if (run.mode !== 'selfcheck') {
    descriptor = JSON.parse(fs.readFileSync(run.descriptor, 'utf8'))
    agent = validateLoad(descriptor, run.label).stream_nodes[0]
    origin = await makeProxy()
  }
  win = new BrowserWindow({ show: false, width: 1440, height: 1000, webPreferences: {
    preload: path.join(run.build, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false,
    offscreen: true, backgroundThrottling: false, additionalArguments: ['--orgtree-ui-origin=' + origin] } })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(origin + '/')) e.preventDefault() })
  win.webContents.setFrameRate(60)
  win.webContents.on('paint', (_, dirty, image) => {
    const at = epoch(); paints++
    const size = image.getSize(), bounds = win.getContentBounds()
    const x = Math.floor(5 * size.width / bounds.width), y = Math.floor(5 * size.height / bounds.height)
    const id = decodePixel(image.crop({ x, y, width: 1, height: 1 }).toBitmap())
    if ((id & 0xff0000) === 0xb70000 && !paintTimes.has(id)) {
      paintTimes.set(id, at);journal({ proofPaint: id, at, dirty, size })
    }
  })
  win.webContents.on('console-message', event => { if (event.level === 'error' && errors.length < 50) errors.push(event.message) })
  win.webContents.on('render-process-gone', (_, detail) => { save('crash.json', detail);finish(1) })
  // Create a renderer target before enabling CDP domains. Enabling Page on a
  // never-navigated hidden offscreen WebContents can wait forever on Windows.
  await win.loadURL('about:blank')
  win.webContents.debugger.attach('1.3')
  await win.webContents.debugger.sendCommand('Page.enable')
  await win.webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
    source: `(${installPaintProbe.toString()})(${JSON.stringify({ agent })})` })
  if (run.mode === 'selfcheck') await win.loadURL('data:text/html,<html><body>Renderer compositor control</body></html>')
  else await win.loadURL(origin + '/o/' + encodeURIComponent(run.org))
  await until(() => js('!!window.__paintProbe && !!document.body'))
  clearTimeout(startupDeadline)
  await sleep(700)
  clock = await calibrate()
  controls = await selfcheck()
  const raf = percentiles(await js('window.__paintProbe.state.frames'))
  if (raf.n < 10 || raf.p50 > 40 || paints < 3) throw Error('Renderer frame-production calibration failed')
  if (run.mode !== 'selfcheck') {
    await until(() => js('!!document.querySelector(".shell-mode")'))
    // Label stable mode controls locally without changing behavior or React state.
    await js(`document.querySelectorAll('.shell-mode').forEach(e=>e.dataset.paintMode=e.textContent.trim().startsWith('Attention')?'attention':'canvas')`)
    for (let i = 0; i < run.repeats; i++) {
      const suffix = '-' + i
      await action('open-attention' + suffix, '[data-paint-mode=attention]', 'document.querySelector(".attn-stage")?.dataset.attentionActive === "yes" && visible(document.querySelector(".attn-desk .desk-body"))')
      await until(() => js('!!document.querySelector(".attn-desk textarea")'))
      const other = descriptor.live_agents.find(n => n !== agent)
      async function select(n, tag, measured) {
        await js(`document.querySelector('[data-attn-agent=${JSON.stringify(n)}]')?.setAttribute('data-paint-target','${tag}')`)
        const isSelected = await js(`document.querySelector('[data-attn-agent=${JSON.stringify(n)}]')?.getAttribute('aria-selected')==='true'`)
        if (isSelected) return
        const opened = await js('!!document.querySelector(".attn-agents-wrap.list-open")')
        if (!opened) await action('agents-list-' + tag, '.attn-agents-toggle', '!!document.querySelector(".attn-agents-wrap.list-open")', { measured: false })
        await action(tag, '[data-paint-target=' + tag + ']', `document.querySelector('[data-attn-agent=${JSON.stringify(n)}]')?.getAttribute('aria-selected')==='true' && visible(document.querySelector('.attn-desk textarea')) && document.querySelector('.attn-desk textarea')?.placeholder.startsWith(${JSON.stringify('message ' + n)})`, { measured })
      }
      await select(other, 'prepare-agent' + suffix, false)
      await select(agent, 'select-agent' + suffix, true)
      await action('switch-tab' + suffix, '.attn-desk [data-tab=inbox]', '!!document.querySelector(".attn-desk [data-tab=inbox].on") && visible(document.querySelector(".attn-desk .desk-tabpanel"))')
      await action('open-chat' + suffix, '.attn-desk [data-tab=chat]', '!!document.querySelector(".attn-desk [data-tab=chat].on") && visible(document.querySelector(".attn-desk .msgs")) && !!document.querySelector(".attn-desk [data-transcript-row]")')
      await action('open-work' + suffix, '[aria-label=Work]', 'visible(document.querySelector(".docket-row"))', { measured: false })
      const title = await js(`(()=>{const r=document.querySelector('.docket-row');r.dataset.paintItem='chosen';return r.getAttribute('data-copy-ticket-title')})()`)
      await action('open-docket-item' + suffix, '[data-paint-item=chosen]', `visible(document.querySelector('.docket-pane-head')) && document.querySelector('.docket-pane-head')?.getAttribute('data-copy-ticket-title')===${JSON.stringify(title)}`)
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
      await until(() => js('!document.querySelector(".docket-modal")'))
      if (i + 1 < run.repeats) await action('prepare-canvas' + suffix, '[data-paint-mode=canvas]', 'document.querySelector(".attn-stage")?.dataset.attentionActive !== "yes"', { measured: false })
    }
    loadNow()
    const from = await js('window.__paintProbe.feedStart()')
    save('feed-ready.json', { from, agent })
    const end = performance.now() + run.seconds * 1000
    while (performance.now() < end) { loadNow();await sleep(Math.min(500, end - performance.now())) }
    const untilAt = await js('window.__paintProbe.feedEnd()')
    await sleep(5000) // All emitted markers get an explicit tail; late stays late.
    journal({ feedWindow: { agent, from, until: untilAt } })
  }
  const clockEnd = await calibrate()
  if (Math.abs(clock.offset - clockEnd.offset) > 10) throw Error('Renderer/main clock drift exceeds10ms')
  const state = await js('window.__paintProbe.snapshot()')
  save('renderer.json', { complete: true, controls, raf, clock, clockEnd, paints, agent, state,
    paintTimes: [...paintTimes], actions, errors, ipcCalls, processes: app.getAppMetrics(),
    versions: process.versions, limitations: ['Offscreen compositor production, not physical display.',
      'Proof tile is painted after visible postcondition; conservative upper bound, with probe overhead.',
      'Production renderer/preload; native window-management shell is a fixture.'] })
  finish(errors.length || state.errors.length ? 1 : 0)
}).catch(async error => {
  if (win && !win.isDestroyed()) {
    try { save('failure-state.json', await js(`({url:location.href, text:document.body?.innerText, probe:window.__paintProbe?.snapshot()})`)) } catch {}
    try { fs.writeFileSync(path.join(run.output, 'failure.png'), (await win.webContents.capturePage()).toPNG()) } catch {}
  }
  save('renderer.json', { complete: false, error: String(error), actions, errors, controls, paints, ipcCalls })
  console.error(String(error));finish(1)
})
