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

const buildRoot = path.resolve('C:/orgtree-build')
const out = path.resolve(process.env.CANVASBG_VISUAL_OUT || 'C:/orgtree-build/epic-wonder-full/canvasbg-visual')
if (!out.startsWith(buildRoot + path.sep)) {
  console.error(`refusing to write outside C:/orgtree-build: ${out}`)
  process.exit(2)
}
const shots = path.join(out, 'shots')
fs.mkdirSync(shots, { recursive: true })

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
  { name: 'line-grid-zoomin', query: 'theme=line-grid&z=1.8&x=-520&y=-380' },
  { name: 'measure-dots', query: 'theme=dots', measure: true },
  { name: 'measure-ascii', query: 'theme=ascii', measure: true, wait: 400 },
  { name: 'measure-ascii-pan', query: 'theme=ascii&pan=1', measure: true, wait: 400 },
  { name: 'measure-linegrid-pan', query: 'theme=line-grid&pan=1', measure: true },
]

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function settled(win, extraMs) {
  await win.webContents.executeJavaScript(`new Promise(res => {
    const poll = () => window.__ready ? requestAnimationFrame(() => requestAnimationFrame(res)) : setTimeout(poll, 50)
    poll()
  })`)
  if (extraMs) await sleep(extraMs)
  await win.webContents.executeJavaScript(
    'new Promise(res => requestAnimationFrame(() => requestAnimationFrame(res)))')
}

async function probe(win, scene) {
  return win.webContents.executeJavaScript(`(() => {
    const bg = document.querySelector('.canvas-bg')
    const ascii = document.querySelector('canvas.canvas-bg-ascii')
    const cs = bg ? getComputedStyle(bg) : null
    return {
      ready: window.__ready === true,
      cssLayer: !!bg,
      theme: bg ? (bg.getAttribute('data-canvas-bg') || 'dots') : (ascii ? 'ascii' : 'none'),
      backgroundImage: cs ? cs.backgroundImage.slice(0, 60) : '',
      opacity: cs ? cs.opacity : '',
      asciiCanvas: ascii ? { w: ascii.width, h: ascii.height, motion: ascii.getAttribute('data-motion') } : null,
    }
  })()`)
}

function distinctBytes(image) {
  const bmp = image.toBitmap()
  const seen = new Set()
  for (let i = 0; i < bmp.length; i += 997) seen.add(bmp[i])
  return seen.size
}

async function run() {
  const win = new BrowserWindow({
    width: 1000, height: 700, show: false, backgroundColor: '#1f1f1f',
    // backgroundThrottling off and the window shown inactive (Session 0:
    // nobody's desktop): the ASCII layer rightly pauses while hidden, and
    // the frame measurements should not be throttled rAF either
    webPreferences: { sandbox: true, backgroundThrottling: false },
  })
  win.showInactive()
  const receipts = []
  let failed = 0
  for (const scene of SCENES) {
    const file = 'file:///' + path.join(out, 'index.html').replace(/\\/g, '/') + '?' + scene.query
    await win.loadURL(file)
    await settled(win, scene.wait || 250)
    const info = await probe(win, scene)
    let frames = null
    if (scene.measure) {
      frames = await win.webContents.executeJavaScript('window.__measure()')
      await settled(win, 120)
    }
    const image = await win.webContents.capturePage()
    const png = path.join(shots, scene.name + '.png')
    fs.writeFileSync(png, image.toPNG())
    const distinct = distinctBytes(image)
    const expectTheme = new URLSearchParams(scene.query).get('theme') || 'dots'
    const checks = {
      ready: info.ready === true,
      theme: info.theme === expectTheme,
      painted: distinct > 12,
      asciiSized: expectTheme !== 'ascii' || (!!info.asciiCanvas && info.asciiCanvas.w > 0),
      cssPainted: expectTheme === 'ascii' || expectTheme === 'dots' || info.backgroundImage !== 'none',
    }
    const ok = Object.values(checks).every(Boolean)
    if (!ok) failed++
    receipts.push({ scene: scene.name, png, bytes: fs.statSync(png).size, distinct, info, frames, checks, ok })
    console.log(`${ok ? 'PASS' : 'FAIL'} ${scene.name} distinct=${distinct}${frames ? ` median=${frames.medianMs}ms p95=${frames.p95Ms}ms max=${frames.maxMs}ms` : ''}`)
  }
  fs.writeFileSync(path.join(out, 'receipts.json'), JSON.stringify({ passed: failed === 0, receipts }, null, 2))
  console.log(failed === 0 ? 'ALL SCENES PASS' : `${failed} SCENE(S) FAILED`)
  app.exit(failed === 0 ? 0 : 1)
}

app.whenReady().then(() => {
  run().catch(err => { console.error(err); app.exit(2) })
})
