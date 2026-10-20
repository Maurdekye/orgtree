const { app, BrowserWindow } = require('electron')
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict')
const out = process.env.ORGTREE_PROJECT_HOVER_CAPTURE_ROOT
assert.match(out || '', /^C:[\\/]orgtree-build[\\/]taskbar-orgs-sol[\\/]/i)
for (const key of ['userData', 'sessionData', 'logs', 'crashDumps']) {
  const dir = path.join(out, key); fs.mkdirSync(dir, { recursive: true }); app.setPath(key, dir)
}
app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1000, height: 650, show: false, useContentSize: true,
    webPreferences: { offscreen: true, backgroundThrottling: false, sandbox: true, contextIsolation: true, nodeIntegration: false } })
  try {
    win.webContents.session.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:)/.test(d.url) }))
    await win.loadFile(path.join(out, 'index.html'))
    await win.webContents.executeJavaScript(`document.querySelector('.sq.project').focus()`)
    await win.webContents.executeJavaScript('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 350))))')
    const state = await win.webContents.executeJavaScript(`(() => {
      const el = document.querySelector('.sq-far-ghost.on .sq-far-name'), style = getComputedStyle(el);
      return { text: el.textContent, width: el.clientWidth, scrollWidth: el.scrollWidth,
        maxWidth: style.maxWidth, opacity: style.opacity, box: el.getBoundingClientRect().toJSON() };
    })()`)
    fs.writeFileSync(path.join(out, 'capture.json'), JSON.stringify(state, null, 2))
    assert.equal(state.maxWidth, '600px'); assert.equal(state.opacity, '1')
    assert.equal(state.text, 'project-transparency-complete-reporting-and-placement')
    assert.ok(state.width > 180); assert.ok(state.scrollWidth <= state.width, 'full long name fits')
    assert.ok(state.box.left >= 0 && state.box.right <= 1000)
    fs.writeFileSync(path.join(out, 'project-hover.png'), (await win.webContents.capturePage()).toPNG())
    console.log(JSON.stringify(state))
  } finally { win.destroy() }
}).then(() => app.exit(0), e => { console.error(e.stack || e); app.exit(1) })
