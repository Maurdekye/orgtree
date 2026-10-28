// wavezoom.capture.cjs — zoom-flicker probe for the "Claude Waves" canvas background (USER 2026-10-28 mfaa7411710fb,
// mf070ca638693 "it tenss to flicker"). Mounts the real AsciiLayer (and, as the control, the real CanvasBackground on another
// theme) in a hidden Electron window (wavezoom.visual.tsx), then measures what the layer paints while the canvas zooms:
//
//   sweep-in / sweep-out   deterministic geometry: the camera steps through zoom at a FIXED field time (one synchronous draw per
//                          step), so the only thing that changes between neighbouring frames is the zoom itself. Reports how much
//                          the painted glyph field changes per step, split into steps where the integer cell size / grid shape
//                          changes and steps where it does not, against the frame-to-frame change of plain animation at rest.
//   live-in-out            real wheel input (CDP Input.dispatchMouseEvent mouseWheel) in a mouse-notch cadence and a
//                          trackpad-like cadence, zooming in and back out; per displayed frame it records the camera the DOM
//                          shows, the camera the layer drew with, whether the layer redrew, and the canvas's opacity/display/state.
//   frames                 window captures of consecutive zoom steps (PNG), for looking at.
//
//   electron.exe wavezoom.capture.cjs <outDir> <repoRoot> <node_modules dir> <label> [scene,scene,...]
//
// Session 0 ONLY (the script refuses otherwise): hidden-desktop window, muted, clipboard stubbed and denied, only file: data: blob:
// requests, input only by CDP to its own window. Writes only under <outDir>/<label>/. Exit 0 = ran, 2 = the capture itself failed.
const { app, BrowserWindow, session, clipboard } = require('electron')
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const [outArg, repoArg, depsArg, label = 'run', scenesArg = ''] = process.argv.slice(2)
const out = path.resolve(outArg, label), repo = path.resolve(repoArg), deps = path.resolve(depsArg)
const sid = pid => Number(execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Process -Id ${Number(pid)}).SessionId`], { encoding: 'utf8', windowsHide: true }).trim())
assert.equal(sid(process.pid), 0, 'Session 0 required before creating a window')
fs.mkdirSync(out, { recursive: true })
for (const stale of ['failure.json', 'results.json', 'analysis.json']) fs.rmSync(path.join(out, stale), { force: true })
app.setPath('userData', path.join(out, 'profile-' + process.pid)); app.setPath('sessionData', path.join(out, 'session-' + process.pid))
app.commandLine.appendSwitch('mute-audio')
// WAVEZOOM_SW=1: no GPU process (Session 0 here crashes it with exit_code=34), so run SwiftShader software WebGL2 and let the fixture
// shim the layer's hardware gate (&sw=1). Geometry and painted pixels are real; frame timing is software timing.
const SW = process.env.WAVEZOOM_SW === '1'
if (SW) {
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('use-gl', 'angle'); app.commandLine.appendSwitch('use-angle', 'swiftshader')
  app.commandLine.appendSwitch('enable-unsafe-swiftshader'); app.commandLine.appendSwitch('ignore-gpu-blocklist')
}
let clipboardCalls = 0
for (const k of Object.keys(clipboard)) if (typeof clipboard[k] === 'function') clipboard[k] = () => { clipboardCalls++; return k === 'availableFormats' ? [] : k === 'has' ? false : '' }
const sleep = ms => new Promise(r => setTimeout(r, ms))
const consoleLines = []
const T0 = Date.now()
const log = (...a) => console.log(`[+${((Date.now() - T0) / 1000).toFixed(1)}s]`, ...a)
const within = async (p, ms, what) => { let t; try { return await Promise.race([p, new Promise((_r, j) => { t = setTimeout(() => j(Error('Deadline: ' + what)), ms) })]) } finally { clearTimeout(t) } }

async function bundle() {
  const esbuild = require(path.join(deps, 'esbuild'))
  try {
    await esbuild.build({
      entryPoints: [path.join(repo, 'apps/desktop/renderer/tests/wavezoom.visual.tsx')],
      outfile: path.join(out, 'probe.js'), bundle: true, format: 'iife', platform: 'browser', jsx: 'automatic', logLevel: 'warning',
      nodePaths: [deps], loader: { '.png': 'dataurl', '.svg': 'dataurl', '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl' },
      define: { 'process.env.NODE_ENV': '"production"', __SRC_DIR__: '""' },
    })
  } finally { await esbuild.stop() }
  fs.writeFileSync(path.join(out, 'index.html'), '<!doctype html><html lang="en"><meta charset="utf-8"><link rel="stylesheet" href="probe.css"><body style="margin:0"><div id="root"></div><script src="probe.js"></script></body></html>')
}

const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN
const pct = (a, p) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))] }
const r3 = v => Number.isFinite(v) ? Math.round(v * 1000) / 1000 : v
// relative change between two ink maps (Bray-Curtis): 0 = identical, 1 = no ink in common; independent of how faint the ink is
const mapDiff = (a, b) => { let d = 0, t = 0; for (let i = 0; i < a.length; i++) { d += Math.abs(a[i] - b[i]); t += a[i] + b[i] } return t > 0 ? d / t : 0 }

function makeWindow() {
  // a FRESH window per scene; visible-but-inactive on the Session 0 desktop with throttling off, as canvasbg-capture.cjs does
  const win = new BrowserWindow({ width: 1000, height: 700, show: false, backgroundColor: '#1f1f1f',
    webPreferences: { sandbox: true, backgroundThrottling: false } })
  win.webContents.setAudioMuted(true)
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 1) consoleLines.push(`[${level}] ${String(message).slice(0, 200)}`) })
  win.webContents.on('render-process-gone', (_e, d) => console.log(`render-process-gone: ${d.reason} exit=${d.exitCode}`))
  win.showInactive()
  return win
}
async function open(query) {
  const win = makeWindow()
  const dbg = win.webContents.debugger
  dbg.attach('1.3')
  log('open', query, 'attached')
  if (SW) query += '&sw=1'
  await within(win.loadURL('file:///' + path.join(out, 'index.html').replace(/\\/g, '/') + '?' + query), 20000, 'load')
  log('loaded')
  // document.hasFocus() without stealing the foreground (the ASCII loop only runs while the document has focus); sent AFTER the
  // load: before it the command never returned under software compositing (measured 2026-10-29)
  try { await within(dbg.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true }), 8000, 'focus emulation'); log('focus emulation set') } catch (e) { log('focus emulation FAILED:', String(e)) }
  const js = c => within(win.webContents.executeJavaScript(c), 30000, 'js: ' + String(c).slice(0, 60))
  const t0 = Date.now()
  for (;;) {
    const ok = await js(query.includes('theme=ascii') || !query.includes('theme=') ? 'window.__asciiReady === true' : 'window.__ready === true')
    if (ok) break
    if (Date.now() - t0 > 15000) {
      // what the page can see: a fresh WebGL2 context (with the gate's own options), the renderer string, the layer's canvas
      const diag = await js(`(() => { const o = {}; try { const c = document.createElement('canvas'); const gl = c.getContext('webgl2', { failIfMajorPerformanceCaveat: true, antialias: false, depth: false, stencil: false, powerPreference: 'low-power' });
        o.gl = !!gl; if (gl) { const d = gl.getExtension('WEBGL_debug_renderer_info'); o.renderer = d ? String(gl.getParameter(d.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER)); o.version = gl.getParameter(gl.VERSION) } } catch (e) { o.err = String(e) }
        o.canvases = document.querySelectorAll('canvas').length; o.layer = !!document.querySelector('[data-canvas-bg="ascii"]'); o.layerCanvas = !!document.querySelector('[data-canvas-bg="ascii"] canvas')
        o.contrastMore = matchMedia('(prefers-contrast: more)').matches; o.forced = matchMedia('(forced-colors: active)').matches; o.hasFocus = document.hasFocus(); o.vis = document.visibilityState; return JSON.stringify(o) })()`).catch(e => 'diag failed: ' + e)
      throw Error('layer not ready: ' + query + ' | ' + diag + ' | console: ' + consoleLines.slice(-6).join(' // '))
    }
    await sleep(120)
  }
  log('layer ready')
  await sleep(400)
  return { win, dbg, js }
}
const paint = js => js('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 60))))')

/* ── scene: deterministic zoom sweep ─────────────────────────────────── */
async function sweepScene(name, query, from, to, steps) {
  const { win, dbg, js } = await open(query)
  try {
    await js('window.__zp.install()')
    await js('window.__zp.reset()')
    const T = 10 // fixed field time (s): the animation is frozen, only the camera changes
    const ax = 500, ay = 350 // screen point the zoom is anchored on (a wheel zoom anchors under the cursor)
    // baseline: plain animation at rest, 60 fps worth of field time per frame
    const costs = []
    for (let i = 0; i <= 24; i++) costs.push(await js(`window.__zp.sweepDraw({ x: 0, y: 0, z: ${from} }, ${T} + ${i} / 60) || 0`))
    log('baseline drawn')
    const base = await js('window.__zp.result()')
    await js('window.__zp.reset()')
    // the sweep: geometric zoom steps with the world point under (ax, ay) held fixed
    const stepMs = []
    for (let i = 0; i <= steps; i++) {
      stepMs.push(await js(`window.__zp.sweepStep(${i}, ${steps}, ${from}, ${to}, ${ax}, ${ay}, ${T})`))
      if (i % 20 === 0) log(`sweep step ${i}/${steps} took ${stepMs[i].toFixed(0)} ms`)
    }
    const res = await js('window.__zp.result()')
    const baseDiffs = []
    for (let i = 1; i < base.draws.length; i++) baseDiffs.push(mapDiff(base.draws[i - 1].coarse, base.draws[i].coarse))
    const rows = []
    for (let i = 1; i < res.draws.length; i++) {
      const a = res.draws[i - 1], b = res.draws[i]
      rows.push({ i, z: r3(b.zRef), cw: b.cw, cwStep: a.cw !== b.cw, shapeStep: a.cols !== b.cols || a.rows !== b.rows, canvasStep: a.canvasW !== b.canvasW || a.canvasH !== b.canvasH,
        diff: r3(mapDiff(a.coarse, b.coarse)), covA: r3(a.cov), covB: r3(b.cov), state: b.state })
    }
    const step = rows.filter(r => r.cwStep || r.shapeStep), flat = rows.filter(r => !(r.cwStep || r.shapeStep))
    const summary = {
      steps, from, to, anchor: [ax, ay], dpr: res.dpr,
      restAnimationDiffPerFrame: { mean: r3(mean(baseDiffs)), max: r3(Math.max(...baseDiffs)) },
      zoomStepDiff: { stepsWithCellOrGridChange: step.length, meanOnChange: r3(mean(step.map(r => r.diff))), maxOnChange: r3(Math.max(0, ...step.map(r => r.diff))),
        stepsWithout: flat.length, meanWithout: r3(mean(flat.map(r => r.diff))), maxWithout: r3(Math.max(0, ...flat.map(r => r.diff))) },
      cellWidthsSeen: [...new Set(res.draws.map(d => d.cw))],
      resizeCalls: res.resizes.length, canvasSizeChanges: rows.filter(r => r.canvasStep).length,
      coverage: { min: r3(Math.min(...res.draws.map(d => d.cov))), max: r3(Math.max(...res.draws.map(d => d.cov))) },
      statesSeen: [...new Set(res.draws.map(d => d.state))],
      drawMs: { median: r3(pct(stepMs, 0.5)), p95: r3(pct(stepMs, 0.95)), max: r3(Math.max(...stepMs)) },
    }
    return { name, query, summary, rows, base: { diffs: baseDiffs.map(r3) } }
  } finally { try { dbg.detach() } catch {} win.destroy(); await sleep(150) }
}

/* ── scene: pan baseline (what plain motion of the same size costs) ──── */
async function panScene(name, query, z, dx, steps) {
  const { win, dbg, js } = await open(query)
  try {
    await js('window.__zp.install()')
    await js('window.__zp.reset()')
    for (let i = 0; i <= steps; i++) await js(`window.__zp.panStep(${i}, ${dx}, ${z}, 10)`)
    const res = await js('window.__zp.result()')
    const diffs = []
    for (let i = 1; i < res.draws.length; i++) diffs.push(mapDiff(res.draws[i - 1].coarse, res.draws[i].coarse))
    return { name, query, summary: { z, panPxPerStep: dx, steps, cellWidthsSeen: [...new Set(res.draws.map(d => d.cw))], diff: { mean: r3(mean(diffs)), p10: r3(pct(diffs, 0.1)), p50: r3(pct(diffs, 0.5)), p90: r3(pct(diffs, 0.9)), max: r3(Math.max(...diffs)) } } }
  } finally { try { dbg.detach() } catch {} win.destroy(); await sleep(150) }
}

/* ── scene: pixel identity (z <= 1 must be byte-identical before and after a layout change) ─────── */
const IDENTITY_VIEWS = []
for (const z of [1, 0.95, 0.8, 0.6, 0.5, 0.35, 0.24]) for (const [x, y] of [[0, 0], [-137.3, -61.9], [-900.7, -433.1], [211.4, 87.6]]) IDENTITY_VIEWS.push({ x, y, z })
for (const z of [1.03, 1.5, 2, 3]) IDENTITY_VIEWS.push({ x: -250.5, y: -111.1, z }) // z > 1 is expected to change; recorded for reference
async function identityScene(name, query) {
  const { win, dbg, js } = await open(query)
  try {
    await js('window.__zp.install()')
    const rowsA = await js(`window.__zp.identity(${JSON.stringify(IDENTITY_VIEWS)}, 10)`)
    const rowsB = await js(`window.__zp.identity(${JSON.stringify(IDENTITY_VIEWS)}, 12.5)`) // a second field time, so the animation is covered too
    return { name, query, summary: { views: IDENTITY_VIEWS.length, fieldTimes: [10, 12.5] }, identity: { t10: rowsA, t12_5: rowsB } }
  } finally { try { dbg.detach() } catch {} win.destroy(); await sleep(150) }
}

/* ── scene: contact sheet (consecutive zoom steps, amplified ink) ─────────────────────────────── */
async function sheetScene(name, query, from, ratio, count, cols) {
  const { win, dbg, js } = await open(query)
  try {
    await js('window.__zp.install()')
    const ax = 500, ay = 350
    const views = []
    let v = { x: 0, y: 0, z: from }
    for (let i = 0; i < count; i++) {
      const z = from * Math.pow(ratio, i)
      const wx = (ax - v.x) / v.z, wy = (ay - v.y) / v.z
      v = { x: ax - wx * z, y: ay - wy * z, z }
      views.push(v)
    }
    const url = await js(`window.__zp.sheet(${JSON.stringify(views)}, 10, ${cols}, 0.5, 40)`)
    const f = path.join(out, `${name}.png`)
    fs.writeFileSync(f, Buffer.from(String(url).replace(/^data:image\/png;base64,/, ''), 'base64'))
    return { name, query, files: [f], summary: { from, ratio, count, cols, gain: 40, note: 'real layer pixels, alpha x40 on black, tile = viewport at 0.5' } }
  } finally { try { dbg.detach() } catch {} win.destroy(); await sleep(150) }
}

/* ── scene: live wheel zoom ──────────────────────────────────────────── */
async function liveScene(name, query, pattern) {
  const { win, dbg, js } = await open(query)
  try {
    const isAscii = query.includes('theme=ascii')
    if (isAscii) await js('window.__zp.install()')
    await js('window.__zp.reset(); window.__zp.startTicks()')
    await sleep(1200) // at rest, for the baseline cadence
    const wheel = (deltaY) => dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 500, y: 350, deltaX: 0, deltaY, modifiers: 0 })
    const tStart = await js('performance.now()')
    for (let i = 0; i < pattern.count; i++) { await wheel(-pattern.delta); await sleep(pattern.gapMs) }
    const tTurn = await js('performance.now()')
    for (let i = 0; i < pattern.count; i++) { await wheel(pattern.delta); await sleep(pattern.gapMs) }
    const tEnd = await js('performance.now()')
    await sleep(1800) // after the zoom: the layer must come back to a steady state
    await js('window.__zp.stopTicks()')
    const res = await js('window.__zp.result()')
    const view = await js('window.__zp.view()')
    const tk = res.ticks, dr = res.draws
    const inZoom = t => t >= tStart && t <= tEnd + 100
    const zoomTicks = tk.filter(x => inZoom(x.t)), restTicks = tk.filter(x => x.t < tStart)
    const cadence = arr => { const g = []; for (let i = 1; i < arr.length; i++) g.push(arr[i].t - arr[i - 1].t); return { n: arr.length, medianMs: r3(pct(g, 0.5)), p95Ms: r3(pct(g, 0.95)), maxMs: r3(Math.max(0, ...g)) } }
    // a tick is STALE when the camera the DOM shows changed since the previous tick but the layer did not redraw in between
    let stale = 0, camMoved = 0, ahead = 0
    for (let i = 1; i < tk.length; i++) {
      if (!inZoom(tk[i].t)) continue
      if (tk[i].zDom !== tk[i - 1].zDom) { camMoved++; if (tk[i].draws === tk[i - 1].draws) stale++ }
      if (tk[i].zRef !== tk[i].zDom) ahead++
    }
    const zoomDraws = dr.filter(d => inZoom(d.t)), restDraws = dr.filter(d => d.t < tStart)
    const covJump = arr => { const j = []; for (let i = 1; i < arr.length; i++) j.push(Math.abs(arr[i].cov - arr[i - 1].cov) / Math.max(1e-6, arr[i - 1].cov)); return { median: r3(pct(j, 0.5)), p95: r3(pct(j, 0.95)), max: r3(Math.max(0, ...j)) } }
    const frameDiff = arr => { const j = []; for (let i = 1; i < arr.length; i++) j.push(mapDiff(arr[i - 1].coarse, arr[i].coarse)); return { n: j.length, median: r3(pct(j, 0.5)), p95: r3(pct(j, 0.95)), max: r3(Math.max(0, ...j)) } }
    const errs = arr => { const e = arr.map(x => x.err).filter(Number.isFinite); return { n: e.length, median: r3(pct(e, 0.5)), p95: r3(pct(e, 0.95)), max: r3(Math.max(0, ...e)), over1px: e.filter(v => v > 1).length } }
    const states = []; for (const x of tk) if (!states.length || states[states.length - 1].state !== x.state) states.push({ atMs: Math.round(x.t - tStart), state: x.state })
    const opac = zoomTicks.map(x => Number(x.opacity)).filter(Number.isFinite), restOp = restTicks.map(x => Number(x.opacity)).filter(Number.isFinite)
    const summary = {
      pattern, wheelEventsSent: pattern.count * 2, zoomWindowMs: Math.round(tEnd - tStart), turnAtMs: Math.round(tTurn - tStart),
      finalView: view,
      displayedFramesCadence: { rest: cadence(restTicks), zoom: cadence(zoomTicks) },
      layerDrawCadence: isAscii ? { rest: cadence(restDraws.map(d => ({ t: d.t }))), zoom: cadence(zoomDraws.map(d => ({ t: d.t }))) } : null,
      canvasVsCardsPx: isAscii ? { rest: errs(restTicks), zoom: errs(zoomTicks) } : null,
      framesWhereCameraMoved: camMoved, staleFramesCameraMovedButLayerNotRedrawn: stale, framesLayerAheadOfDom: ahead,
      drawsDuringZoom: zoomDraws.length, drawsAtRest: restDraws.length,
      coverageJumpBetweenDraws: isAscii ? { rest: covJump(restDraws), zoom: covJump(zoomDraws) } : null,
      glyphFieldChangeBetweenDraws: isAscii ? { rest: frameDiff(restDraws), zoom: frameDiff(zoomDraws) } : null,
      opacity: { rest: restOp.length ? { min: r3(Math.min(...restOp)), max: r3(Math.max(...restOp)) } : null, zoom: opac.length ? { min: r3(Math.min(...opac)), max: r3(Math.max(...opac)) } : null },
      displayNoneFramesDuringZoom: zoomTicks.filter(x => x.display === 'none').length,
      fadedFramesDuringZoom: zoomTicks.filter(x => Number(x.opacity) < 0.05).length,
      // computed opacity of the displayed frames around the layer first reporting no grid ('unseen'): a fade is a ramp, a pop is a step
      opacityAroundNoGrid: (() => { const i = zoomTicks.findIndex(x => x.state === 'unseen'); return i < 0 ? null : zoomTicks.slice(Math.max(0, i - 2), i + 22).map(x => r3(Number(x.opacity))) })(),
      opacityAroundGridBack: (() => { let i = -1; for (let k = 1; k < zoomTicks.length; k++) if (zoomTicks[k - 1].state === 'unseen' && zoomTicks[k].state !== 'unseen') { i = k; break } return i < 0 ? null : zoomTicks.slice(Math.max(0, i - 2), i + 30).map(x => r3(Number(x.opacity))) })(),
      statesTimeline: states.slice(0, 30), resizeCalls: res.resizes.length,
      cellWidthsDuringZoom: [...new Set(zoomDraws.map(d => d.cw))],
    }
    return { name, query, summary }
  } finally { try { dbg.detach() } catch {} win.destroy(); await sleep(150) }
}

/* ── scene: consecutive zoom steps as pictures ───────────────────────── */
async function framesScene(name, query, zs) {
  const { win, dbg, js } = await open(query)
  try {
    const files = []
    for (let i = 0; i < zs.length; i++) {
      const z = zs[i]
      const wx = 500, wy = 350
      await js(`window.__setView({ x: ${wx} - ${wx} * ${z}, y: ${wy} - ${wy} * ${z}, z: ${z} })`)
      await paint(js)
      const img = await win.webContents.capturePage()
      const f = path.join(out, `${name}-${String(i).padStart(2, '0')}-z${z}.png`)
      fs.writeFileSync(f, img.toPNG()); files.push(f)
    }
    return { name, query, files }
  } finally { try { dbg.detach() } catch {} win.destroy(); await sleep(150) }
}

const SCENES = {
  'sweep-in': () => sweepScene('sweep-in', 'theme=ascii&seed=7', 1, 4, 180),
  'sweep-out': () => sweepScene('sweep-out', 'theme=ascii&seed=7', 1, 0.24, 120),
  'identity': () => identityScene('identity', 'theme=ascii&seed=7'),
  'sheet-in': () => sheetScene('sheet-in', 'theme=ascii&seed=7', 2.0, 1.012, 8, 4),
  'sheet-in-low': () => sheetScene('sheet-in-low', 'theme=ascii&seed=7', 1.0, 1.012, 8, 4),
  'pan-4px-z1': () => panScene('pan-4px-z1', 'theme=ascii&seed=7', 1, 4, 120),
  'pan-8px-z1': () => panScene('pan-8px-z1', 'theme=ascii&seed=7', 1, 8, 60),
  'pan-4px-z3': () => panScene('pan-4px-z3', 'theme=ascii&seed=7', 3, 4, 120),
  'sweep-in-dots': () => sweepScene('sweep-in-dots', 'theme=dots', 1, 4, 60),
  'live-notch-ascii': () => liveScene('live-notch-ascii', 'theme=ascii&seed=7', { delta: 100, count: 24, gapMs: 70, label: 'mouse notches (deltaY 100 every 70 ms)' }),
  'live-smooth-ascii': () => liveScene('live-smooth-ascii', 'theme=ascii&seed=7', { delta: 24, count: 90, gapMs: 12, label: 'trackpad-like (deltaY 24 every 12 ms)' }),
  'live-notch-dots': () => liveScene('live-notch-dots', 'theme=dots', { delta: 100, count: 24, gapMs: 70, label: 'mouse notches (control: dot grid)' }),
  'frames-in': () => framesScene('frames-in', 'theme=ascii&seed=7', [1.0, 1.04, 1.08, 1.12, 1.16, 1.2]),
}

app.whenReady().then(async () => {
  app.on('window-all-closed', () => {})
  const results = { label, scenes: {}, sessionId: sid(process.pid), clipboardCalls: 0, errors: [] }
  try {
    await bundle()
    const ses = session.defaultSession
    ses.setPermissionCheckHandler(() => false); ses.setPermissionRequestHandler((_w, _p, done) => done(false))
    ses.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:|about:|devtools:)/.test(d.url) }))
    const only = scenesArg.split(',').map(s => s.trim()).filter(Boolean)
    for (const [k, fn] of Object.entries(SCENES)) {
      if (only.length && !only.includes(k)) continue
      console.log('scene', k)
      try { results.scenes[k] = await within(fn(), 90000, k) } catch (e) { results.scenes[k] = { error: String(e) }; results.errors.push(`${k}: ${e}`); console.log('FAILED', k, String(e)) }
    }
    results.clipboardCalls = clipboardCalls
    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(results, null, 2))
    // a compact view without the per-step rows, for reading
    const compact = JSON.parse(JSON.stringify(results))
    for (const s of Object.values(compact.scenes)) if (s.rows) { s.rowsCount = s.rows.length; delete s.rows; delete s.base }
    fs.writeFileSync(path.join(out, 'analysis.json'), JSON.stringify(compact, null, 2))
    for (const [k, s] of Object.entries(compact.scenes)) console.log(k, JSON.stringify(s.summary ?? s.files ?? s.error).slice(0, 900))
    console.log(results.errors.length ? `DONE with ${results.errors.length} scene error(s)` : 'DONE')
    app.exit(results.errors.length ? 2 : 0)
  } catch (e) {
    console.error(e)
    try { fs.writeFileSync(path.join(out, 'failure.json'), JSON.stringify({ error: String(e), results }, null, 2)) } catch {}
    app.exit(2)
  }
}).catch(e => { console.error(e); app.exit(2) })
