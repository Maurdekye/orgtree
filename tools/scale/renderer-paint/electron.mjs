import { app, BrowserWindow, ipcMain } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import net from 'node:net'
import zlib from 'node:zlib'
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
const archiveSamples = [], treeSamples = [], treeReads = [], profileSamples = [], returnSamples = []
let paints = 0, clock, controls, finishing = false
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
// Opt-in attribution for a measured click: CPU profile, renderer counters,
// long tasks and resource loads between arming and the painted proof. The
// sampling profiler adds overhead, so these timings attribute, not qualify.
async function profiled(tag, run, cpu = true) {
  const cdp = (method, params) => win.webContents.debugger.sendCommand(method, params)
  await cdp('Performance.enable', { timeDomain: 'timeTicks' })
  if (cpu) { await cdp('Profiler.enable'); await cdp('Profiler.setSamplingInterval', { interval: 100 }) }
  await js(`(()=>{window.__perfRows=[];try{const o=new PerformanceObserver(l=>{for(const e of l.getEntries())window.__perfRows.push({type:e.entryType,name:String(e.name).slice(0,160),start:performance.timeOrigin+e.startTime,duration:e.duration,size:e.transferSize??null})});o.observe({entryTypes:['longtask','resource']});window.__perfObs=o}catch(e){window.__perfRows.push({error:String(e)})}})()`)
  const metrics = async () => Object.fromEntries((await cdp('Performance.getMetrics')).metrics.map(m => [m.name, m.value]))
  const before = await metrics()
  if (cpu) await cdp('Profiler.start')
  let row
  try { row = await run() } finally {
    if (cpu) {
      const { profile } = await cdp('Profiler.stop')
      fs.writeFileSync(path.join(run_output(), `profile-${tag}.cpuprofile`), JSON.stringify(profile))
    }
  }
  const after = await metrics()
  const entries = await js('(()=>{window.__perfObs?.disconnect();return window.__perfRows})()')
  const delta = Object.fromEntries(Object.keys(after).map(k => [k, after[k] - (before[k] ?? 0)]))
  profileSamples.push({ tag, cpu, heapBefore: before.JSHeapUsedSize, heapAfter: after.JSHeapUsedSize, ms: row.ms, start: row.start, painted: row.painted,
    readyAt: row.batch?.rows.find(r => r.name === tag)?.readyAt ?? null, delta,
    longTasks: entries.filter(e => e.type === 'longtask' && e.start + e.duration >= row.start && e.start <= row.painted),
    resources: entries.filter(e => e.type === 'resource' && e.start + e.duration >= row.start - 50 && e.start <= row.painted) })
  save('profile.json', { samples: profileSamples, limitations: ['Sampling profiler at 100us adds overhead: attribution, not qualification timing.'] })
  return row
}
const run_output = () => run.output
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
        // Tree reads only: keep the wire body to count the rows it carried.
        const orgPath = '/api/orgs/' + encodeURIComponent(run.org)
        const treePath = new URL(req.url, 'http://x').pathname
        const isTree = run.treeMeasurement && (treePath === orgPath || treePath.startsWith(orgPath + '/foreground-tree'))
        const chunks = []
        if (isTree) response.on('data', b => { chunks.push(b) })
        response.on('end', () => {
          journal({ http: req.url, status: response.statusCode, bytes, at: begin, ms: epoch() - begin })
          if (!isTree) return
          let rows = null, kind = null, decoded = 0
          try {
            let body = Buffer.concat(chunks)
            if (/gzip/.test(response.headers['content-encoding'] || '')) body = zlib.gunzipSync(body)
            decoded = body.length
            if (response.statusCode === 200 && body.length) {
              const value = JSON.parse(body.toString('utf8'))
              kind = value.kind || value.format || 'legacy'
              const count = nodes => (nodes || []).reduce((n, node) => n + 1 + count(node.children), 0)
              rows = value.nodes ? Object.keys(value.nodes).length
                : value.references ? Object.keys(value.references).length
                  : Array.isArray(value.tree?.roots) ? count(value.tree.roots)
                    : Array.isArray(value.roots) && typeof value.roots[0] === 'object' ? count(value.roots) : null
            }
          } catch (error) { kind = 'unparsed:' + String(error).slice(0, 80) }
          const row = { url: treePath, query: new URL(req.url, 'http://x').search.length, status: response.statusCode,
            wireBytes: bytes, decodedBytes: decoded, rows, kind, at: begin }
          treeReads.push(row); journal({ treeRead: row })
        })
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
  if (finishing) return
  finishing = true
  clearTimeout(startupDeadline)
  for (const s of sockets) s.destroy()
  proxy?.close()
  if (win && !win.isDestroyed()) {
    if (win.webContents.debugger.isAttached()) win.webContents.debugger.detach()
    win.destroy()
  }
  app.exit(code)
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
    if (run.treeMeasurement) {
      // Canvas at rest: the selected tree, the steady heap after forced GC,
      // and the retired pile's click-to-feedback paint. Observation only.
      const memory = async () => {
        // ORGTREE_PAINT_NO_FORCED_GC tests whether these forced collections
        // disturb the clicks that follow; heap then reads without a GC.
        if (!run.noForcedGc) await win.webContents.debugger.sendCommand('HeapProfiler.collectGarbage')
        return { heap: await win.webContents.debugger.sendCommand('Runtime.getHeapUsage'),
          processes: app.getAppMetrics(), forcedGc: !run.noForcedGc }
      }
      await until(() => js('!!document.querySelector(".pile-count")'))
      await sleep(3000)   // declared settle: startup reads and first heartbeat
      const startupReads = treeReads.length
      // Unmeasured setup, identical in both arms: at the fit-all camera the
      // pile badge is ~12px and a real pointer can miss it. Zoom in on it
      // with real wheel input, then wait for the camera to settle.
      const badge = () => js(`(()=>{const c=[...document.querySelectorAll('.pile-count')].sort((a,b)=>+b.textContent - +a.textContent)[0].getBoundingClientRect();return{x:Math.round(c.left+c.width/2),y:Math.round(c.top+c.height/2),h:c.height}})()`)
      // The probe's scrollIntoView on a target near the viewport edge scrolls
      // the canvas container, which the canvas then restores, so the press
      // lands on empty space. Pan the pile to the middle first with a real
      // drag that starts on verified empty canvas.
      const middle = await js('(()=>{const r=document.querySelector(".viewport").getBoundingClientRect();return{x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()')
      const pans = []
      for (let step = 0; step < 6; step++) {
        const at = await badge()
        const dx = Math.max(-400, Math.min(400, middle.x - at.x)), dy = Math.max(-300, Math.min(300, middle.y - at.y))
        if (Math.abs(middle.x - at.x) <= 40 && Math.abs(middle.y - at.y) <= 40) break
        // an empty start whose end also stays inside the viewport
        const start = await js(`(()=>{const v=document.querySelector('.viewport').getBoundingClientRect();
          const inside=(x,y)=>x>v.left+20&&x<v.right-20&&y>v.top+20&&y<v.bottom-20
          for(let y=v.top+30;y<v.bottom-30;y+=30)for(let x=v.left+30;x<v.right-30;x+=30){
            if(!inside(x+${dx},y+${dy}))continue
            const e=document.elementFromPoint(x,y);if(e&&(e.classList.contains('space')||e.classList.contains('viewport')))return{x:Math.round(x),y:Math.round(y)}}
          return null})()`)
        if (!start) throw Error('no empty canvas point to pan from')
        const end = { x: start.x + dx, y: start.y + dy }
        win.webContents.sendInputEvent({ type: 'mouseMove', ...start })
        win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...start })
        for (let k = 1; k <= 10; k++) {
          win.webContents.sendInputEvent({ type: 'mouseMove', button: 'left',
            x: Math.round(start.x + dx * k / 10), y: Math.round(start.y + dy * k / 10) })
          await sleep(30)
        }
        win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...end })
        await sleep(600)
        pans.push({ at, start, end })
      }
      await sleep(400)
      const first = await badge()
      journal({ pilePan: { middle, pans, after: first } })
      if (Math.abs(first.x - middle.x) > 80 || Math.abs(first.y - middle.y) > 80) throw Error('pile could not be panned to the middle')
      const zoom = async (delta, notches) => {
        for (let k = 0; k < notches; k++) {
          const at = await badge()
          win.webContents.sendInputEvent({ type: 'mouseMove', x: at.x, y: at.y })
          win.webContents.sendInputEvent({ type: 'mouseWheel', x: at.x, y: at.y, deltaX: 0, deltaY: delta })
          await sleep(250)
        }
        await sleep(1000)
        return badge()
      }
      let zoomed = await zoom(300, 4)
      if (zoomed.h < first.h * 1.5) zoomed = await zoom(-300, 8)
      journal({ pileZoom: { first, zoomed } })
      if (zoomed.h < 24) throw Error('pile badge could not be enlarged for a reliable click')
      for (let i = 0; i < run.repeats; i++) {
        const suffix = '-' + i
        const pileTotal = await js(`(()=>{const c=[...document.querySelectorAll('.pile-count')].sort((a,b)=>+b.textContent - +a.textContent)[0];c.dataset.paintPile='chosen';return c.textContent.trim()})()`)
        const steady = await memory()
        // Observation only: what the pointer lands on and when the picker
        // appears or disappears, retained if the measured click fails.
        await js(`(()=>{window.__pileTrace=[];const t=window.__pileTrace;let last=null;
          const at=()=>performance.timeOrigin+performance.now()
          new MutationObserver(()=>{const has=!!document.querySelector('.pile-picker');if(has!==last){last=has;t.push({at:at(),picker:has})}}).observe(document.body,{childList:true,subtree:true})
          for(const type of ['pointerdown','pointerup','click'])document.addEventListener(type,e=>t.push({at:at(),type,target:String(e.target?.className||e.target?.tagName).slice(0,80),trusted:e.isTrusted}),true)
          const c=document.querySelector('[data-paint-pile=chosen]').getBoundingClientRect(),x=c.left+c.width/2,y=c.top+c.height/2,top=document.elementFromPoint(x,y)
          t.push({badge:{x,y,w:c.width,h:c.height},top:String(top?.className||top?.tagName).slice(0,80)})})()`)
        let open
        try {
          open = await action('open-pile' + suffix, '[data-paint-pile=chosen]', 'visible(document.querySelector(".pile-picker"))')
        } catch (error) {
          save('pile-trace.json', { suffix, trace: await js('window.__pileTrace'), reads: treeReads })
          throw error
        }
        await until(() => js('document.querySelectorAll(".pile-picker .pile-row").length > 0 && !document.querySelector(".pile-picker [role=status]")'))
        const readyAt = epoch()
        const rowsShown = await js('document.querySelectorAll(".pile-picker .pile-row").length')
        const opened = await memory()
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
        await until(() => js('!document.querySelector(".pile-picker")'))
        await sleep(1000)
        const closed = await memory()
        treeSamples.push({ suffix, pileTotal, rowsShown, steady, opened, closed,
          inputAt: open.start, feedbackPaintMs: open.ms, completeViewObservedMs: readyAt - open.start })
      }
      save('tree.json', { samples: treeSamples, startupReads: treeReads.slice(0, startupReads), reads: treeReads,
        limitations: ['Heap samples force GC outside click timing; process memory also includes non-JS allocations.',
          'Complete-view observation polls DOM at25ms; feedback latency has compositor proof.',
          'Tree rows are counted from the wire body the proxy relayed (nodes, references or legacy roots).',
          'N10 queued-mail synthetic demand; not N1000 or completed provider turns.'] })
    }
    // 1c arms, harness only. B: an unmeasured real click on the canvas's own
    // fit control. C: the candidate rule injected as a page style (no product
    // source change); `.canvas-world` is display:contents, so it targets the
    // world's children, which have boxes. The pin layer lives outside it.
    if (run.fitBeforeAttention) {
      const fit = await js(`(()=>{const r=document.querySelector('button[title="fit the whole org"]').getBoundingClientRect();return{x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()`)
      win.webContents.sendInputEvent({ type: 'mouseMove', ...fit })
      win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...fit })
      win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...fit })
      await sleep(1500)
      journal({ fitBeforeAttention: true })
    }
    if (run.injectContentVisibility) {
      await js(`(()=>{const s=document.createElement('style');s.id='paint-candidate-cv';s.textContent='.canvas-world-hidden > * { content-visibility: hidden !important; }';document.head.appendChild(s)})()`)
      journal({ injectContentVisibility: true })
    }
    const canvasState = () => js(`(()=>{const sp=document.querySelector('.space');const layer=document.querySelector('.pin-layer');const c=document.querySelector('.pile-count');
      return {camera:sp?.style.transform??null,pinLayerInViewport:!!layer&&layer.parentElement===document.querySelector('.viewport'),
        pileVisible:!!c&&window.__paintProbe.visible(c),worldHidden:!!document.querySelector('.canvas-world-hidden')}})()`)
    for (let i = 0; i < run.repeats; i++) {
      const suffix = '-' + i
      const canvasBefore = await canvasState()
      await action('open-attention' + suffix, '[data-paint-mode=attention]', 'document.querySelector(".attn-stage")?.dataset.attentionActive === "yes" && visible(document.querySelector(".attn-desk .desk-body"))')
      await until(() => js('!!document.querySelector(".attn-desk textarea")'))
      const other = descriptor.live_agents.find(n => n !== agent)
      async function select(n, tag, measured) {
        await js(`document.querySelector('[data-attn-agent=${JSON.stringify(n)}]')?.setAttribute('data-paint-target','${tag}')`)
        const isSelected = await js(`document.querySelector('[data-attn-agent=${JSON.stringify(n)}]')?.getAttribute('aria-selected')==='true'`)
        if (isSelected) return
        const opened = await js('!!document.querySelector(".attn-agents-wrap.list-open")')
        if (!opened) await action('agents-list-' + tag, '.attn-agents-toggle', '!!document.querySelector(".attn-agents-wrap.list-open")', { measured: false })
        const click = () => action(tag, '[data-paint-target=' + tag + ']', `document.querySelector('[data-attn-agent=${JSON.stringify(n)}]')?.getAttribute('aria-selected')==='true' && visible(document.querySelector('.attn-desk textarea')) && document.querySelector('.attn-desk textarea')?.placeholder.startsWith(${JSON.stringify('message ' + n)})`, { measured })
        if ((run.profile || run.metricsOnly) && measured) await profiled(tag, click, run.profile); else await click()
      }
      await select(other, 'prepare-agent' + suffix, false)
      await select(agent, 'select-agent' + suffix, true)
      // The agents list can stay open from both its pin and the native pointer /
      // focus left on the selected row. Dismiss it using real input before tabs.
      if (await js('document.querySelector(".attn-agents-toggle")?.getAttribute("aria-expanded")==="true"'))
        await action('close-agents' + suffix, '.attn-agents-toggle', 'document.querySelector(".attn-agents-toggle")?.getAttribute("aria-expanded")==="false"', { measured: false })
      win.webContents.sendInputEvent({ type: 'mouseMove', x: 1300, y: 70 })
      win.webContents.sendInputEvent({ type: 'mouseDown', x: 1300, y: 70, button: 'left', clickCount: 1 })
      win.webContents.sendInputEvent({ type: 'mouseUp', x: 1300, y: 70, button: 'left', clickCount: 1 })
      await until(() => js('!document.querySelector(".attn-agents-wrap.list-open")'))
      await action('switch-tab' + suffix, '.attn-desk [data-tab=inbox]', '!!document.querySelector(".attn-desk [data-tab=inbox].on") && visible(document.querySelector(".attn-desk .desk-tabpanel"))')
      await action('open-chat' + suffix, '.attn-desk [data-tab=chat]', '!!document.querySelector(".attn-desk [data-tab=chat].on") && visible(document.querySelector(".attn-desk .msgs")) && !!document.querySelector(".attn-desk [data-transcript-row]")')
      await action('open-work' + suffix, '.docket-bell', 'visible(document.querySelector(".docket-row"))', { measured: false })
      const title = await js(`(()=>{const r=document.querySelector('.docket-row');r.dataset.paintItem='chosen';return r.getAttribute('data-copy-ticket-title')})()`)
      await action('open-docket-item' + suffix, '[data-paint-item=chosen]', `visible(document.querySelector('.docket-pane-head')) && document.querySelector('.docket-pane-head')?.getAttribute('data-copy-ticket-title')===${JSON.stringify(title)}`)
      if (run.archiveMeasurement) {
        // Observe the production UI and browser heap; do not inspect React
        // state or substitute network results. Collection is outside timing.
        if (!win.webContents.debugger.isAttached()) win.webContents.debugger.attach('1.3')
        const memory = async () => {
          await win.webContents.debugger.sendCommand('HeapProfiler.collectGarbage')
          return { heap: await win.webContents.debugger.sendCommand('Runtime.getHeapUsage'),
            processes: app.getAppMetrics() }
        }
        const before = await memory()
        const open = await action('open-archive' + suffix, '.docket-showarchived input',
          'document.querySelector(".docket-showarchived input")?.checked===true')
        await until(() => js('![...document.querySelectorAll("[role=status]")].some(e=>/Loading docket|Could not refresh docket/.test(e.textContent))'))
        const readyAt = epoch()
        const listPoint = await js('(()=>{const r=document.querySelector(".docket-modal .mailer-list").getBoundingClientRect();return{x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()')
        // Chromium's injected wheel uses a negative delta to move down.
        // This unmeasured setup only brings the loaded archive into view.
        win.webContents.sendInputEvent({ type: 'mouseMove', ...listPoint })
        win.webContents.sendInputEvent({ type: 'mouseWheel', ...listPoint, deltaX: 0, deltaY: -100000 })
        await until(() => js('!!document.querySelector(".docket-section.tone-archive .docket-row")'))
        journal({ archiveScroll: await js('(()=>{const e=document.querySelector(".docket-modal .mailer-list");return{top:e.scrollTop,height:e.scrollHeight,viewport:e.clientHeight}})()') })
        const archivedCount = await js('document.querySelector(".docket-section.tone-archive .docket-group-n")?.textContent')
        const opened = await memory()
        await action('close-archive' + suffix, '.docket-showarchived input',
          'document.querySelector(".docket-showarchived input")?.checked===false', { measured: false })
        await until(() => js('!document.querySelector(".docket-section.tone-archive")'))
        const closed = await memory()
        archiveSamples.push({ suffix, before, opened, closed, archivedCount,
          inputAt: open.start, feedbackPaintMs: open.ms, completeViewObservedMs: readyAt - open.start })
        save('archive.json', { samples: archiveSamples,
          limitations: ['Heap samples force GC outside click timing; process memory also includes non-JS allocations.',
            'Complete-view observation polls DOM at25ms; feedback latency has compositor proof.',
            'N10 queued-mail synthetic demand; not N1000 or completed provider turns.'] })
      }
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
      await until(() => js('!document.querySelector(".docket-modal")'))
      if (i + 1 < run.repeats) {
        // The way back is timed to the canvas actually showing again.
        const back = await action('prepare-canvas' + suffix, '[data-paint-mode=canvas]', 'document.querySelector(".attn-stage")?.dataset.attentionActive !== "yes" && !document.querySelector(".canvas-world-hidden")', { measured: false })
        await sleep(300)
        const canvasAfter = await canvasState()
        returnSamples.push({ suffix, ms: back.ms, before: canvasBefore, after: canvasAfter,
          cameraKept: canvasBefore.camera === canvasAfter.camera, pinLayerKept: canvasAfter.pinLayerInViewport,
          pileVisibleAgain: canvasAfter.pileVisible })
        save('return.json', { samples: returnSamples, arms: { fitBeforeAttention: !!run.fitBeforeAttention,
          injectContentVisibility: !!run.injectContentVisibility } })
      }
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
