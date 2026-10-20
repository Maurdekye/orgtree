const { app, BrowserWindow } = require('electron'), fs = require('node:fs'), path = require('node:path'), http = require('node:http')
const out = process.env.MEMBERSHIP_OUT
if (!/^C:[\\/]orgtree-build[\\/]helper-transcript-sol[\\/]/i.test(out || '')) throw Error('Owned output required')
app.setPath('userData', path.join(out, 'user-data')); app.disableHardwareAcceleration()
const paint = w => w.webContents.executeJavaScript('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(r,250))))')
app.whenReady().then(async () => {
  let win, server
  const deadline = setTimeout(() => { if (win && !win.isDestroyed()) win.destroy(); app.exit(2) }, 25000)
  try {
    const files = {
      '/': ['text/html', '<!doctype html><html><head><link rel="stylesheet" href="/styles.css"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>'],
      '/fixture.js': ['text/javascript', fs.readFileSync(path.join(out, 'fixture.js'))],
      '/styles.css': ['text/css', fs.readFileSync(process.env.MEMBERSHIP_STYLE)],
      '/katex/dist/katex.min.css': ['text/css', fs.readFileSync(process.env.MEMBERSHIP_KATEX)],
    }
    server = http.createServer((req, res) => { const f = files[(req.url || '').split('?')[0]]; res.writeHead(f ? 200 : 404, { 'content-type': f?.[0] || 'text/plain' }); res.end(f?.[1] || '') })
    await new Promise(r => server.listen(0, '127.0.0.1', r))
    win = new BrowserWindow({ show: false, width: 1000, height: 700, useContentSize: true, webPreferences: { offscreen: true, backgroundThrottling: false } })
    await win.loadURL('http://127.0.0.1:' + server.address().port + '/')
    await win.webContents.executeJavaScript(`new Promise((resolve,reject)=>{let n=0;const check=()=>{if(document.querySelector('.docket-row'))resolve();else if(++n<100)setTimeout(check,20);else reject(Error('No initial row'))};check()})`)
    await win.webContents.executeJavaScript(`(()=>{[...document.querySelectorAll('label')].find(n=>n.textContent.includes('Show archived')).querySelector('input').click()})()`)
    await paint(win)
    const states = []
    for (const step of ['pending', 'settled', 'refresh']) {
      if(step!=='pending') { await win.webContents.executeJavaScript('window.membershipAnswer();true');await paint(win) }
      let image, state, actual
      for (let retry = 0; retry < 5; retry++) {
        win.webContents.invalidate(); await paint(win)
        state = await win.webContents.executeJavaScript(`(()=>{const panel=document.querySelector('.settings'),r=document.querySelector('.mailer').getBoundingClientRect(),row=document.querySelector('.docket-row');return{step:${JSON.stringify(step)},bg:getComputedStyle(document.body).backgroundColor,pending:document.body.textContent.includes('Checking team membership'),stats:{...window.membershipStats()},row:row?.textContent,rect:{x:r.x,y:r.y,width:r.width,height:r.height},panel:{x:panel.getBoundingClientRect().x,y:panel.getBoundingClientRect().y}}})()`)
        image = await win.webContents.capturePage(); const b = image.toBitmap(); actual = `rgb(${b[2]}, ${b[1]}, ${b[0]})`
        // The overlay is composited over body at the corner.
        if (!image.isEmpty() && image.getSize().width === 1000 && image.getSize().height === 700) break
      }
      if (state.pending !== (step==='pending') || state.stats.reads !== 1) throw Error('Membership did not settle once: '+JSON.stringify(state))
      fs.writeFileSync(path.join(out, `membership-${step}.png`), image.toPNG()); states.push({ ...state, actual })
    }
    if(states.some(s=>JSON.stringify(s.rect)!==JSON.stringify(states[0].rect))) throw Error('Pending hint shifted docket list')
    fs.writeFileSync(path.join(out, 'capture.json'), JSON.stringify(states, null, 2))
  } finally { clearTimeout(deadline); if (win && !win.isDestroyed()) win.destroy(); if (server) await new Promise(r => server.close(r)) }
}).then(() => app.exit(0), e => { console.error(e.stack || e); app.exit(2) })
