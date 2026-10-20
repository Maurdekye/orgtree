const { app, BrowserWindow } = require('electron'), fs = require('node:fs'), path = require('node:path'), http = require('node:http')
const out = process.env.TICKET_EDGE_OUT
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
      '/styles.css': ['text/css', fs.readFileSync(process.env.TICKET_EDGE_STYLE)],
      '/katex/dist/katex.min.css': ['text/css', fs.readFileSync(process.env.TICKET_EDGE_KATEX)],
    }
    server = http.createServer((req, res) => { const f = files[(req.url || '').split('?')[0]]; res.writeHead(f ? 200 : 404, { 'content-type': f?.[0] || 'text/plain' }); res.end(f?.[1] || '') })
    await new Promise(r => server.listen(0, '127.0.0.1', r))
    win = new BrowserWindow({ show: false, width: 1000, height: 700, useContentSize: true, webPreferences: { offscreen: true, backgroundThrottling: false } })
    await win.loadURL('http://127.0.0.1:' + server.address().port + '/')
    const states = []
    for (const theme of ['dark', 'light']) {
      await win.webContents.executeJavaScript(`document.documentElement.classList.toggle('contrast-light',${theme === 'light'});true`)
      let image, state, actual
      for (let retry = 0; retry < 5; retry++) {
        win.webContents.invalidate(); await paint(win)
        state = await win.webContents.executeJavaScript(`({theme:${JSON.stringify(theme)},bg:getComputedStyle(document.body).backgroundColor,rows:[...document.querySelectorAll('[data-state]')].map(row=>{const card=row.querySelector('.tool-ticket'),label=row.querySelector('.docket-status'),r=card?.getBoundingClientRect();return{status:row.dataset.state,className:card?.className,shadow:card&&getComputedStyle(card).boxShadow,color:getComputedStyle(label).color,rect:r&&{x:r.x,y:r.y,width:r.width,height:r.height}}})})`)
        image = await win.webContents.capturePage(); const b = image.toBitmap(); actual = `rgb(${b[2]}, ${b[1]}, ${b[0]})`
        if (actual === state.bg) break
      }
      if (actual !== state.bg || image.isEmpty() || state.rows.length !== 8) throw Error('Invalid capture')
      for (const row of state.rows) if (!row.className?.includes('status-' + row.status) || !row.shadow.includes(row.color) || !row.shadow.includes('3px') || row.rect.y + row.rect.height > 700) throw Error('Palette/status/bounds mismatch: ' + row.status)
      // Resolve --warn in Chromium rather than inferring pixels from CSS text.
      state.warn = await win.webContents.executeJavaScript(`(()=>{const probe=document.createElement('span');probe.style.color='var(--warn)';document.body.append(probe);const color=getComputedStyle(probe).color;probe.remove();return color})()`)
      const waiting = state.rows.find(row => row.status === 'waiting'), open = state.rows.find(row => row.status === 'open')
      if (!waiting || !open || waiting.color !== state.warn || waiting.color === open.color) throw Error('Computed Waiting must use --warn and differ from Open')
      fs.writeFileSync(path.join(out, `ticket-edge-${theme}.png`), image.toPNG()); states.push({ ...state, actual })
    }
    if (states[0].bg === states[1].bg) throw Error('Themes did not change')
    fs.writeFileSync(path.join(out, 'capture.json'), JSON.stringify(states, null, 2))
  } finally { clearTimeout(deadline); if (win && !win.isDestroyed()) win.destroy(); if (server) await new Promise(r => server.close(r)) }
}).then(() => app.exit(0), e => { console.error(e.stack || e); app.exit(2) })
