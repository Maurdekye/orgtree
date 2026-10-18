const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const root = process.env.TOOL_FILE_LINK_CAPTURE_ROOT
if (!/^C:[\\/]orgtree-build[\\/]agent-tooltip-luna[\\/]/i.test(root || '')) {
  throw new Error('Expected assigned C:/orgtree-build/agent-tooltip-luna output')
}

app.setPath('userData', path.join(root, 'user-data'))
app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1000,
    height: 420,
    show: false,
    useContentSize: true,
    paintWhenInitiallyHidden: true,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false },
  })
  try {
    await win.loadFile(path.join(root, 'index.html'))
    await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('fixture timeout')), 5000)
      const ready = () => {
        const link = document.querySelector('.tline a[data-local-path]')
        if (!document.body.dataset.ready || !link) return setTimeout(ready, 20)
        requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => {
          clearTimeout(timeout)
          resolve({ label: document.querySelector('.tline')?.textContent, path: link.dataset.localPath })
        }, 250)))
      }
      ready()
    })`)
    const image = await win.webContents.capturePage()
    if (image.isEmpty()) throw new Error('Empty screenshot')
    fs.writeFileSync(path.join(root, 'tool-file-link.png'), image.toPNG())
  } finally {
    win.destroy()
  }
}).then(() => app.exit(0), error => {
  console.error(error.stack || error)
  app.exit(1)
})
