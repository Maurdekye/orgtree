// Photographs every canvas background theme in a hidden Electron window
// and measures rAF frame times for the animated one.
//
//   node tests/canvasbg-build.mjs                       (bundle first)
//   node_modules/.bin/electron tests/canvasbg-capture.cjs
//
// Reads the bundle from CANVASBG_VISUAL_OUT (default the author's
// C:/orgtree-build scope) and writes PNGs + receipts.json beside it. A
// checkout without node_modules can point both scripts at shared deps via
// BATCH_NODE_MODULES (use that tree's electron binary to launch this).
//
// Team-note rules honoured: capturePage() after two rAFs plus a settle
// delay (a DOM check passing does not mean the PNG shows that state), and
// the window stays within the Session-0 1024x768 clamp.
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

// No ANGLE override and no probe-time WebGL contexts: creating a
// throwaway webgl2 context in probe() killed the Viz/GPU process at the
// next capturePage (UnknownVizError, measured 2026-10-16). Whether the
// ASCII renderer's hardware-GL gate passed is already observable via
// asciiReady + the GL canvas in probe().

const buildRoot = path.resolve('C:/orgtree-build')
const out = path.resolve(process.env.CANVASBG_VISUAL_OUT || 'C:/orgtree-build/epic-wonder-full/canvasbg-visual')
if (!out.startsWith(buildRoot + path.sep)) {
  console.error(`refusing to write outside C:/orgtree-build: ${out}`)
  process.exit(2)
}
const shots = path.join(out, 'shots')
fs.mkdirSync(shots, { recursive: true })

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function waitAscii(win, timeoutMs = 15000) {
  const t0 = Date.now()
  for (;;) {
    const ready = await win.webContents.executeJavaScript('window.__asciiReady === true')
    if (ready) return true
    if (Date.now() - t0 > timeoutMs) return false
    await sleep(120)
  }
}
const js = (win, code) => win.webContents.executeJavaScript(code)

/* The seeded numerical proof + behaviour probes for the ASCII theme.
 * Each `run` returns extra receipt fields and a `checks` map. Thresholds
 * are recorded from measured runs (see the visual README): the wind
 * texture is fp32 GL against a float64 mirror, so channel R (thresholded
 * strength) may flip a few edge samples while GB/A track tightly. */
async function compareScene(win, t) {
  const ready = await waitAscii(win)
  const cmp = ready ? await js(win, `window.__compareWind(${t})`) : { error: 'not ready' }
  const R = cmp.channels?.R, G = cmp.channels?.G, A = cmp.channels?.A
  return {
    compare: cmp,
    checks: {
      windCompared: !cmp.error && cmp.samples > 1000,
      windR: !!R && R.mean < 2 && R.within2 > 0.98 && R.p99 <= 16,
      windDir: !!G && G.mean < 1 && G.within2 > 0.99,
      windGate: !!A && A.mean < 1 && A.within2 > 0.99,
    },
  }
}

const SCENES = [
  { name: 'dots', query: 'theme=dots' },
  { name: 'line-grid', query: 'theme=line-grid' },
  { name: 'hex-dots', query: 'theme=hex-dots' },
  { name: 'hex-lines', query: 'theme=hex-lines' },
  { name: 'square-tiles', query: 'theme=square-tiles' },
  { name: 'triangle-tiles', query: 'theme=triangle-tiles' },
  { name: 'hex-tiles', query: 'theme=hex-tiles' },
  { name: 'ascii-a', query: 'theme=ascii', wait: 1200 },
  { name: 'ascii-b', query: 'theme=ascii', wait: 5200 },
  { name: 'ascii-zoomout', query: 'theme=ascii&z=0.35&x=-60&y=-40', wait: 1500 },
  { name: 'ascii-pinned-t8', query: 'theme=ascii&seed=42&pool=mixed&x=0&y=0&z=1', run: win => compareScene(win, 8) },
  { name: 'ascii-pinned-t40', query: 'theme=ascii&seed=42&pool=mixed&x=0&y=0&z=1', run: win => compareScene(win, 40) },
  {
    name: 'ascii-tap', query: 'theme=ascii&seed=42&pool=mixed&x=0&y=0&z=1',
    run: async win => {
      await waitAscii(win)
      await js(win, 'window.__asciiTap(320, 240)')
      await sleep(650)
      const state = await js(win, 'window.__asciiState()')
      return { state, checks: { tapBusy: !!state?.touchBusy, tapRunning: !!state?.running } }
    },
  },
  {
    name: 'ascii-heart', query: 'theme=ascii&seed=42&pool=mixed&x=0&y=0&z=1',
    run: async win => {
      await waitAscii(win)
      await js(win, 'window.__asciiTap(500, 320); window.__asciiTap(500, 320); window.__asciiTap(500, 320)')
      await sleep(800)
      const state = await js(win, 'window.__asciiState()')
      return { state, checks: { heartBusy: !!state?.touchBusy } }
    },
  },
  {
    name: 'ascii-clicks', query: 'theme=ascii&seed=42&pool=mixed&x=0&y=0&z=1',
    run: async win => {
      await waitAscii(win)
      await sleep(4000) // let mount taps/wakes (none) and reveal settle; touch must be idle
      const click = async (x, y) => {
        win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
        await sleep(60)
        win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
        await sleep(120)
      }
      const card = await js(win, `(() => {
        const el = document.querySelector('[data-card="coordinator-opus"]')
        const r = el.getBoundingClientRect()
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
      })()`)
      await click(card.x, card.y)
      const afterCard = await js(win, '({ clicks: window.__cardClicks || 0, state: window.__asciiState() })')
      const floorWhat = await js(win, `(() => {
        const el = document.elementFromPoint(120, 120)
        return el ? el.tagName + '.' + el.className : 'none'
      })()`)
      await click(120, 120)
      const afterFloor = await js(win, 'window.__asciiState()')
      return {
        afterCard, afterFloor, floorWhat,
        checks: {
          cardClickDelivered: afterCard.clicks === 1,
          cardClickNoRipple: afterCard.state?.touchBusy === false,
          floorClickRipples: afterFloor?.touchBusy === true,
        },
      }
    },
  },
  {
    name: 'ascii-hidden-pause', query: 'theme=ascii&seed=42&pool=mixed&x=0&y=0&z=1',
    run: async win => {
      await waitAscii(win)
      await sleep(600)
      const before = await js(win, 'window.__asciiState()')
      // Focus emulation also pins page visibility to visible, which would
      // mask the very pause under test — drop it for the hidden stretch.
      await withTimeout(win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: false }), 5000, null)
      win.hide()
      await sleep(200) // let any in-flight frame land
      const hidden1 = await js(win, 'window.__asciiState()')
      await sleep(800)
      const hiddenState = await js(win, 'window.__asciiState()')
      win.showInactive()
      await withTimeout(win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true }), 5000, null)
      await sleep(700)
      const after = await js(win, 'window.__asciiState()')
      return {
        before, hidden1, hiddenState, after,
        checks: {
          wasRunning: before?.running === true && (before?.animTime ?? 0) > 0,
          // While hidden the rAF-starved loop cannot draw: animation and
          // field time must not advance at all (GPU/CPU idle).
          pausedHidden: hiddenState?.animTime === hidden1?.animTime
            && hiddenState?.fieldTime === hidden1?.fieldTime,
          resumedShown: after?.running === true && (after?.animTime ?? 0) > (hiddenState?.animTime ?? 0),
        },
      }
    },
  },
  {
    name: 'ascii-still', query: 'theme=ascii&seed=42&pool=mixed&x=0&y=0&z=1', reduced: true,
    run: async win => {
      const ready = await waitAscii(win)
      await sleep(400)
      const state = ready ? await js(win, 'window.__asciiState()') : null
      return {
        state,
        checks: {
          stillDrawn: state?.datasetState === 'still',
          stillNotLooping: state?.running === false,
          stillRevealed: (state?.reveal ?? 0) === 1,
        },
      }
    },
  },
  {
    name: 'ascii-calm', query: 'theme=ascii&seed=42&pool=mixed&budget=2&x=0&y=0&z=1',
    run: async win => {
      await waitAscii(win)
      const t0 = Date.now()
      let state = null
      for (;;) {
        state = await js(win, 'window.__asciiState()')
        if (state?.calm || Date.now() - t0 > 20000) break
        await sleep(400)
      }
      const frames = await js(win, 'window.__measure()')
      return {
        state, frames, waitedMs: Date.now() - t0,
        checks: {
          settledCalm: state?.calm === true && state?.running === false && state?.datasetState === 'calm',
          calmRevealGone: (state?.reveal ?? 1) < 0.01,
        },
      }
    },
  },
  { name: 'line-grid-zoomin', query: 'theme=line-grid&z=1.8&x=-520&y=-380' },
  { name: 'measure-dots', query: 'theme=dots', measure: true },
  { name: 'measure-ascii', query: 'theme=ascii', measure: true, wait: 400 },
  { name: 'measure-ascii-pan', query: 'theme=ascii&pan=1', measure: true, wait: 400 },
  { name: 'measure-linegrid-pan', query: 'theme=line-grid&pan=1', measure: true },
]

const withTimeout = (promise, ms, fallback) => Promise.race([
  promise.catch(() => fallback), new Promise(res => setTimeout(() => res(fallback), ms)),
])

async function settled(win, extraMs) {
  await withTimeout(win.webContents.executeJavaScript(`new Promise(res => {
    const poll = () => window.__ready ? requestAnimationFrame(() => requestAnimationFrame(res)) : setTimeout(poll, 50)
    poll()
  })`), 8000, null)
  if (extraMs) await sleep(extraMs)
  await withTimeout(win.webContents.executeJavaScript(
    'new Promise(res => requestAnimationFrame(() => requestAnimationFrame(res)))'), 4000, null)
}

async function probe(win, scene) {
  return withTimeout(win.webContents.executeJavaScript(`(() => {
    const bg = document.querySelector('.canvas-bg')
    const host = document.querySelector('.canvas-bg-ascii')
    const gl = host ? host.querySelector('canvas') : null
    const cs = bg ? getComputedStyle(bg) : null
    return {
      ready: window.__ready === true,
      cssLayer: !!bg,
      theme: bg ? (bg.getAttribute('data-canvas-bg') || 'dots') : (host ? 'ascii' : 'none'),
      backgroundImage: cs ? cs.backgroundImage.slice(0, 60) : '',
      maskImage: cs ? (cs.maskImage || cs.webkitMaskImage || '').slice(0, 40) : '',
      maskSize: bg ? (bg.style.maskSize || bg.style.webkitMaskSize || '') : '',
      opacity: cs ? cs.opacity : '',
      asciiCanvas: gl ? { w: gl.width, h: gl.height, state: gl.getAttribute('data-state') } : null,
      asciiMotion: host ? host.getAttribute('data-motion') : null,
      asciiReady: window.__asciiReady === true,
      docFocus: document.hasFocus(),
      docHidden: document.hidden,
      visibility: document.visibilityState,
    }
  })()`), 6000, { ready: false, cssLayer: false, theme: 'probe-timeout', backgroundImage: '', maskImage: '', maskSize: '', opacity: '', asciiCanvas: null, asciiMotion: null, asciiReady: false })
}

function distinctBytes(image) {
  const bmp = image.toBitmap()
  const seen = new Set()
  for (let i = 0; i < bmp.length; i += 997) seen.add(bmp[i])
  return seen.size
}

function makeWindow() {
  // A FRESH window per scene: measured 2026-10-16, reusing one window lost
  // the renderer/Viz surface after the first capture (UnknownVizError,
  // then every later scene dead) while the machine's GPU was contended.
  // backgroundThrottling off and shown inactive (Session 0: nobody's
  // desktop): the ASCII layer rightly pauses while hidden, and the frame
  // measurements should not be throttled rAF either.
  const win = new BrowserWindow({
    width: 1000, height: 700, show: false, backgroundColor: '#1f1f1f',
    webPreferences: { sandbox: true, backgroundThrottling: false },
  })
  win.webContents.on('render-process-gone', (_e, details) => {
    console.log(`render-process-gone: ${details.reason} exit=${details.exitCode}`)
  })
  win.showInactive()
  return win
}

async function run() {
  // Per-scene windows are destroyed between scenes; without this handler
  // Electron's default window-all-closed quit ends the run after scene 1.
  app.on('window-all-closed', () => {})
  app.on('child-process-gone', (_e, details) => {
    console.log(`child-process-gone: ${details.type}/${details.name} ${details.reason} exit=${details.exitCode}`)
  })
  const only = (process.env.CANVASBG_SCENES || '').split(',').map(s => s.trim()).filter(Boolean)
  const scenes = only.length ? SCENES.filter(s => only.includes(s.name)) : SCENES
  const receipts = []
  let failed = 0
  for (const scene of scenes) {
    console.log(`scene ${scene.name}: window`)
    const win = makeWindow()
    const file = 'file:///' + path.join(out, 'index.html').replace(/\\/g, '/') + '?' + scene.query
    // The ASCII scheduler (like the reference's) only runs while the
    // document has focus; an inactive Session-0 window never gets OS
    // focus, so emulate it over CDP (document.hasFocus() === true without
    // stealing the real foreground).
    try {
      win.webContents.debugger.attach('1.3')
      await withTimeout(win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true }), 5000, null)
      if (scene.reduced) {
        await withTimeout(win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
          media: '', features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
        }), 5000, null)
      }
    } catch (err) {
      console.log(`scene ${scene.name}: debugger attach failed: ${err.message}`)
    }
    console.log(`scene ${scene.name}: load`)
    await withTimeout(win.loadURL(file), 20000, null)
    await settled(win, scene.wait || 250)
    let extra = null
    if (scene.run) {
      console.log(`scene ${scene.name}: run`)
      extra = await withTimeout(scene.run(win), 60000, { error: 'scene run timed out', checks: { runTimedOut: false } })
      await settled(win, 80)
    }
    const info = await probe(win, scene)
    let frames = extra?.frames ?? null
    if (scene.measure) {
      frames = await withTimeout(win.webContents.executeJavaScript('window.__measure()'), 20000, null)
      await settled(win, 120)
    }
    console.log(`scene ${scene.name}: capture`)
    const image = await withTimeout(win.webContents.capturePage(), 15000, null)
    const png = path.join(shots, scene.name + '.png')
    if (image) fs.writeFileSync(png, image.toPNG())
    const distinct = image ? distinctBytes(image) : 0
    const expectTheme = new URLSearchParams(scene.query).get('theme') || 'dots'
    const checks = {
      ready: info.ready === true,
      theme: info.theme === expectTheme,
      painted: distinct > 12,
      asciiSized: expectTheme !== 'ascii' || (!!info.asciiCanvas && info.asciiCanvas.w > 0),
      cssPainted: expectTheme === 'ascii' || expectTheme === 'dots'
        || info.backgroundImage !== 'none' || (info.maskImage !== '' && info.maskImage !== 'none'),
      ...(extra?.checks || {}),
    }
    const ok = Object.values(checks).every(Boolean)
    if (!ok) failed++
    receipts.push({ scene: scene.name, png, bytes: image ? fs.statSync(png).size : 0, distinct, info, frames, extra, checks, ok })
    console.log(`${ok ? 'PASS' : 'FAIL'} ${scene.name} distinct=${distinct}${frames ? ` median=${frames.medianMs}ms p95=${frames.p95Ms}ms max=${frames.maxMs}ms` : ''}`)
    try { win.webContents.debugger.detach() } catch { /* already gone */ }
    win.destroy()
    await sleep(150)
  }
  fs.writeFileSync(path.join(out, 'receipts.json'), JSON.stringify({ passed: failed === 0, receipts }, null, 2))
  console.log(failed === 0 ? 'ALL SCENES PASS' : `${failed} SCENE(S) FAILED`)
  app.exit(failed === 0 ? 0 : 1)
}

app.whenReady().then(() => {
  run().catch(err => { console.error(err); app.exit(2) })
})
