const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const root = process.env.WATCHDOG_CAPTURE_ROOT
if (!/^C:[\\/]orgtree-build[\\/]helper-transcript-sol[\\/]/i.test(root || '')) throw Error('Expected assigned C build scope')
app.setPath('userData', path.join(root, 'user-data'))
app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1000, height: 700, show: false, useContentSize: true, paintWhenInitiallyHidden: true,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } })
  try {
    await win.loadFile(path.join(root, 'fixture.html'))
    const receipts = []
    for (const name of ['queue', 'command', 'silence', 'event']) for (const theme of ['dark', 'light']) {
      let state, image, actualBackground
      await win.webContents.executeJavaScript(`window.setWatchdogCase(${JSON.stringify(name)})`)
      for (let attempt = 0; attempt < 5; attempt++) {
        win.webContents.invalidate()
        state = await win.webContents.executeJavaScript(`new Promise(resolve=>{
          document.documentElement.classList.toggle('contrast-light',${theme === 'light'});
          requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(()=>resolve({
            text:document.body.innerText,type:document.querySelector('.wd-type')?.textContent,
            description:document.querySelector('.wd-description')?.textContent,
            panels:document.querySelectorAll('.wd-cmd').length,
            background:getComputedStyle(document.body).backgroundColor}),250)))})`)
        image = await win.webContents.capturePage()
        if (image.isEmpty()) throw Error('Empty screenshot')
        const bitmap = image.toBitmap()
        actualBackground = `rgb(${bitmap[2]}, ${bitmap[1]}, ${bitmap[0]})`
        if (actualBackground === state.background) break
      }
      if (actualBackground !== state.background) throw Error('Stale capture '+name+'/'+theme)
      if (state.panels < 1 || !state.text.includes('test-proj-worker-b')) throw Error('Panel not rendered')
      if (process.env.WATCHDOG_CAPTURE_RICH === 'true' && (!state.type || !state.description)) throw Error('Missing explanation')
      fs.writeFileSync(path.join(root, name+'-'+theme+'.png'), image.toPNG())
      receipts.push({ name, theme, ...state, actualBackground })
    }
    fs.writeFileSync(path.join(root, 'capture.json'), JSON.stringify(receipts, null, 2))
  } finally { win.destroy() }
}).then(() => app.exit(0), error => { console.error(error.stack || error); app.exit(1) })
