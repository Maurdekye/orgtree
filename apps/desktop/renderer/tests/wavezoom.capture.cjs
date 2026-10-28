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
let clipboardCalls = 0
for (const k of Object.keys(clipboard)) if (typeof clipboard[k] === 'function') clipboard[k] = () => { clipboardCalls++; return k === 'availableFormats' ? [] : k === 'has' ? false : '' }
const sleep = ms => new Promise(r => setTimeout(r, ms))
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
const mapDiff = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length / 255 }

function makeWindow() {
  // a FRESH window per scene; visible-but-inactive on the Session 0 desktop with throttling off, as canvasbg-capture.cjs does
  const win = new BrowserWindow({ width: 1000, height: 700, show: false, backgroundColor: '#1f1f1f',
    webPreferences: { sandbox: true, backgroundThrottling: false } })
  win.webContents.setAudioMuted(true)
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('render-process-gone', (_e, d) => console.log(`render-process-gone: ${d.reason} exit=${d.exitCode}`))
  win.showInactive()
  return win
}
async function open(query) {
  const win = makeWindow()
  const dbg = win.webContents.debugger
  dbg.attach('1.3')
  await dbg.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true }) // document.hasFocus() without stealing the foreground
  await within(win.loadURL('file:///' + path.join(out, 'index.html').replace(/\\/g, '/') + '?' + query), 20000, 'load')
  const js = c => win.webContents.executeJavaScript(c)
  const t0 = Date.now()
  for (;;) {
    const ok = await js(query.includes('theme=ascii') || !query.includes('theme=') ? 'window.__asciiReady === true' : 'window.__ready === true')
    if (ok) break
    if (Date.now() - t0 > 15000) throw Error('layer not ready (no hardware WebGL2?): ' + query)
    await sleep(120)
  }
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
    await js(`(() => { window.__zp.sweepDraw({ x: 0, y: 0, z: ${from} }, ${T}); for (let i = 1; i <= 24; i++) window.__zp.sweepDraw({ x: 0, y: 0, z: ${from} }, ${T} + i / 60) })()`)
    const base = await js('window.__zp.result()')
    await js('window.__zp.reset()')
    // the sweep: geometric zoom steps with the world point under (ax, ay) held fixed
    await js(`(() => {
      let v = { x: 0, y: 0, z: ${from} }
      for (let i = 0; i <= ${steps}; i++) {
        const z = ${from} * Math.pow(${to} / ${from}, i / ${steps})
        const wx = (${ax} - v.x) / v.z, wy = (${ay} - v.y) / v.z
        v = { x: ${ax} - wx * z, y: ${ay} - wy * z, z }
        window.__zp.sweepDraw(v, ${T})
      }
    })()`)
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
    }
    return { name, query, summary, rows, base: { diffs: baseDiffs.map(r3) } }
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
    const frameDiff = arr => { const j = []; for (let i = 1; i < arr.length; i++) if (arr[i].cols === arr[i - 1].cols && arr[i].rows === arr[i - 1].rows) j.push(mapDiff(arr[i - 1].coarse, arr[i].coarse)); return { n: j.length, median: r3(pct(j, 0.5)), p95: r3(pct(j, 0.95)), max: r3(Math.max(0, ...j)) } }
    const states = []; for (const x of tk) if (!states.length || states[states.length - 1].state !== x.state) states.push({ atMs: Math.round(x.t - tStart), state: x.state })
    const opac = zoomTicks.map(x => Number(x.opacity)).filter(Number.isFinite), restOp = restTicks.map(x => Number(x.opacity)).filter(Number.isFinite)
    const summary = {
      pattern, wheelEventsSent: pattern.count * 2, zoomWindowMs: Math.round(tEnd - tStart), turnAtMs: Math.round(tTurn - tStart),
      finalView: view,
      displayedFramesCadence: { rest: cadence(restTicks), zoom: cadence(zoomTicks) },
      layerDrawCadence: isAscii ? { rest: cadence(restDraws.map(d => ({ t: d.t }))), zoom: cadence(zoomDraws.map(d => ({ t: d.t }))) } : null,
      framesWhereCameraMoved: camMoved, staleFramesCameraMovedButLayerNotRedrawn: stale, framesLayerAheadOfDom: ahead,
      drawsDuringZoom: zoomDraws.length, drawsAtRest: restDraws.length,
      coverageJumpBetweenDraws: isAscii ? { rest: covJump(restDraws), zoom: covJump(zoomDraws) } : null,
      glyphFieldChangeBetweenDraws: isAscii ? { rest: frameDiff(restDraws), zoom: frameDiff(zoomDraws) } : null,
      opacity: { rest: restOp.length ? { min: r3(Math.min(...restOp)), max: r3(Math.max(...restOp)) } : null, zoom: opac.length ? { min: r3(Math.min(...opac)), max: r3(Math.max(...opac)) } : null },
      displayNoneFramesDuringZoom: zoomTicks.filter(x => x.display === 'none').length,
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
