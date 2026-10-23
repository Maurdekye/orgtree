const { app, BrowserWindow } = require('electron')
const fs = require('node:fs'), path = require('node:path')
const out = path.resolve(process.argv[2])
if (!out.toLowerCase().startsWith('c:\\orgtree-build\\canvas-sol\\')) throw new Error('outside owned output')
app.setPath('userData', path.join(out, 'electron-profile'))
app.setPath('sessionData', path.join(out, 'electron-session'))
app.disableHardwareAcceleration()
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 760, height: 480, show: false,
    webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false } })
  const errors = []
  win.webContents.on('console-message', (_event, details) => { if (details.level === 'error') errors.push(details.message) })
  try {
    await win.loadFile(path.join(out, 'index.html')); await wait(300)
    const points = await win.webContents.executeJavaScript(`(() => {
      const track = document.querySelector('.effort-bar-track').getBoundingClientRect();
      return { high: Math.round(track.left + 10 + (track.width - 20) / 2),
        medium: Math.round(track.left + 10 + (track.width - 20) / 4), y: Math.round(track.top + track.height / 2) };
    })()`)
    for (const [type, x] of [['mouseMove', points.high], ['mouseDown', points.high],
      ['mouseMove', points.medium], ['mouseUp', points.medium]]) {
      win.webContents.sendInputEvent({ type, x, y: points.y, ...(type === 'mouseMove' ? {} : { button: 'left', clickCount: 1 }) })
      await wait(60)
    }
    // No mouse event after release: allow React and Chromium to paint the saved state.
    await win.webContents.executeJavaScript('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))')
    await wait(100)
    const receipt = await win.webContents.executeJavaScript(`(() => ({
      label: document.querySelector('.effort-bar-label').textContent,
      pip: document.querySelector('.effort-bar-pip').dataset.level,
      aria: document.querySelector('.effort-bar-track').getAttribute('aria-valuetext'),
      saved: document.querySelector('[data-saved-effort]').textContent,
      commits: Number(document.querySelector('[data-commits]').textContent),
      width: innerWidth, height: innerHeight, dpr: devicePixelRatio
    }))()`)
    fs.writeFileSync(path.join(out, 'receipt.json'), JSON.stringify({ ...receipt, points, errors }, null, 2))
    if (receipt.label !== 'Effort (medium)' || receipt.pip !== 'medium' || receipt.aria !== 'medium'
      || receipt.saved !== 'medium' || receipt.commits !== 1 || errors.length) throw new Error('release did not reconcile effort')
    fs.writeFileSync(path.join(out, 'effortbar.png'), (await win.webContents.capturePage()).toPNG())
    console.log(JSON.stringify(receipt)); app.exit(0)
  } catch (error) { console.error(error); app.exit(1) }
})
