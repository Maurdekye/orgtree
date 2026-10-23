const { app, BrowserWindow } = require('electron')
const fs = require('node:fs'), path = require('node:path')
const out = path.resolve(process.argv[2])
if (!out.toLowerCase().startsWith('c:\\orgtree-build\\canvas-sol\\')) throw new Error('outside owned output')
app.setPath('userData', path.join(out, 'electron-profile'))
app.setPath('sessionData', path.join(out, 'electron-session'))
app.disableHardwareAcceleration()
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1000, height: 700, show: false,
    webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false } })
  const errors = []
  win.webContents.on('console-message', (_event, details) => { if (details.level === 'error') errors.push(details.message) })
  try {
    await win.loadFile(path.join(out, 'index.html'))
    await sleep(3200)
    const drag = await win.webContents.executeJavaScript('window.startPreview()')
    await sleep(150)
    await win.webContents.executeJavaScript('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))')
    await sleep(100)
    const receipt = await win.webContents.executeJavaScript(`(() => {
      const g = document.querySelector('[data-move-ghost]'), t = document.querySelector('[data-first-use-agent="new-superior"]');
      return {ghost:g ? {x:+g.getAttribute('x'), y:+g.getAttribute('y')} : null, targetTransform:t?.style.transform,
        viewportHeight:document.querySelector('.viewport')?.clientHeight}; })()`)
    fs.writeFileSync(path.join(out, 'receipt.json'), JSON.stringify({drag,...receipt,errors},null,2))
    if (!receipt.ghost || !receipt.viewportHeight) throw new Error('preview or canvas missing')
    fs.writeFileSync(path.join(out, 'drag-preview.png'), (await win.webContents.capturePage()).toPNG())
    console.log(JSON.stringify(receipt)); app.exit(0)
  } catch(error) { console.error(error); app.exit(1) }
})
