const { app, BrowserWindow } = require('electron'), fs = require('node:fs'), path = require('node:path'), http = require('node:http')
const out = process.env.CLOCK_MINUTES_OUT
if (!/^C:[\\/]orgtree-build[\\/]helper-transcript-sol[\\/]/i.test(out || '')) throw Error('Owned output required')
app.setPath('userData', path.join(out, 'user-data')); app.disableHardwareAcceleration()
const paint = w => w.webContents.executeJavaScript('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(r,250))))')
app.whenReady().then(async () => {
  let win, server
  const deadline = setTimeout(() => { if (win && !win.isDestroyed()) win.destroy(); app.exit(2) }, 20000)
  try {
    const files = {
      '/': ['text/html', '<!doctype html><html><head><link rel="stylesheet" href="/styles.css"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>'],
      '/fixture.js': ['text/javascript', fs.readFileSync(path.join(out, 'fixture.js'))],
      '/styles.css': ['text/css', fs.readFileSync(process.env.CLOCK_MINUTES_STYLE)],
      '/katex/dist/katex.min.css': ['text/css', fs.readFileSync(process.env.CLOCK_MINUTES_KATEX)],
    }
    server = http.createServer((req, res) => { const f = files[(req.url || '').split('?')[0]]; res.writeHead(f ? 200 : 404, { 'content-type': f?.[0] || 'text/plain' }); res.end(f?.[1] || '') })
    await new Promise(r => server.listen(0, '127.0.0.1', r))
    win = new BrowserWindow({ show: false, width: 1000, height: 650, useContentSize: true, webPreferences: { offscreen: true, backgroundThrottling: false } })
    await win.loadURL('http://127.0.0.1:' + server.address().port + '/')
    let image, state, actual
    for (let retry = 0; retry < 5; retry++) {
      win.webContents.invalidate(); await paint(win)
      state = await win.webContents.executeJavaScript(`({bg:getComputedStyle(document.body).backgroundColor,running:document.querySelector('.tool-running')?.textContent,writing:document.querySelector('.tool-writing')?.textContent,thought:document.querySelector('.thoughtline')?.textContent})`)
      image = await win.webContents.capturePage(); const b = image.toBitmap(); actual = `rgb(${b[2]}, ${b[1]}, ${b[0]})`
      if (actual === state.bg && [state.running,state.writing,state.thought].every(s=>s?.includes('2m 05s'))) break
    }
    if (actual !== state.bg || image.isEmpty() || ![state.running,state.writing,state.thought].every(s=>s?.includes('2m 05s'))) throw Error('Clock text/paint mismatch: '+JSON.stringify(state))
    fs.writeFileSync(path.join(out, 'clock-minutes.png'), image.toPNG())
    fs.writeFileSync(path.join(out, 'capture.json'), JSON.stringify({ ...state, actual }, null, 2))
  } finally { clearTimeout(deadline); if (win && !win.isDestroyed()) win.destroy(); if (server) await new Promise(r => server.close(r)) }
}).then(() => app.exit(0), e => { console.error(e.stack || e); app.exit(2) })
