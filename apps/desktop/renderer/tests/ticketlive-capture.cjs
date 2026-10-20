const { app, BrowserWindow } = require('electron'), fs = require('node:fs'), path = require('node:path'), http = require('node:http')
const out = process.env.TICKET_LIVE_OUT
if (!/^C:[\\/]orgtree-build[\\/]helper-transcript-sol[\\/]/i.test(out || '')) throw Error('Owned output required')
app.setPath('userData', path.join(out, 'user-data')); app.disableHardwareAcceleration()
const paint = w => w.webContents.executeJavaScript('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(r,250))))')
const wait = (w, status) => w.webContents.executeJavaScript(`new Promise((resolve,reject)=>{let tries=0;const check=()=>{if(document.querySelector('.tool-ticket.status-${status}'))resolve();else if(++tries<100)setTimeout(check,20);else reject(Error('Current ticket did not become ${status}'))};check()})`)
app.whenReady().then(async () => {
  let win, server
  const deadline = setTimeout(() => { if (win && !win.isDestroyed()) win.destroy(); app.exit(2) }, 20000)
  try {
    const files = {
      '/': ['text/html', '<!doctype html><html><head><link rel="stylesheet" href="/styles.css"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>'],
      '/fixture.js': ['text/javascript', fs.readFileSync(path.join(out, 'fixture.js'))],
      '/styles.css': ['text/css', fs.readFileSync(process.env.TICKET_LIVE_STYLE)],
      '/katex/dist/katex.min.css': ['text/css', fs.readFileSync(process.env.TICKET_LIVE_KATEX)],
    }
    server = http.createServer((req, res) => { const f = files[(req.url || '').split('?')[0]]; res.writeHead(f ? 200 : 404, { 'content-type': f?.[0] || 'text/plain' }); res.end(f?.[1] || '') })
    await new Promise(r => server.listen(0, '127.0.0.1', r))
    win = new BrowserWindow({ show: false, width: 1000, height: 650, useContentSize: true, webPreferences: { offscreen: true, backgroundThrottling: false } })
    await win.loadURL('http://127.0.0.1:' + server.address().port + '/')
    await wait(win, 'blocked')
    await win.webContents.executeJavaScript('window.originalTicketCard=document.querySelector(".tool-ticket");true')
    const states = []
    for (const theme of ['dark', 'light']) {
      await win.webContents.executeJavaScript(`document.documentElement.classList.toggle('contrast-light',${theme === 'light'});window.ticketLiveChange('blocked');true`)
      for (const [step, status] of [['before', 'blocked'], ['after', 'done']]) {
        if (step === 'after') await win.webContents.executeJavaScript("window.ticketLiveChange('done');true")
        await wait(win, status)
        let image, state, actual
        for (let retry = 0; retry < 5; retry++) {
          win.webContents.invalidate(); await paint(win)
          state = await win.webContents.executeJavaScript(`(()=>{const card=document.querySelector('.tool-ticket'),r=card.getBoundingClientRect();return{theme:${JSON.stringify(theme)},step:${JSON.stringify(step)},status:${JSON.stringify(status)},bg:getComputedStyle(document.body).backgroundColor,shadow:getComputedStyle(card).boxShadow,expected:getComputedStyle(document.querySelector('.tool-work-transition .status-${status}')).color,history:document.querySelector('.tool-work-transition').textContent,sameCard:card===window.originalTicketCard,reads:window.ticketLiveReads(),rect:{x:r.x,y:r.y,width:r.width,height:r.height}}})()`)
          image = await win.webContents.capturePage(); const b = image.toBitmap(); actual = `rgb(${b[2]}, ${b[1]}, ${b[0]})`
          if (actual === state.bg) break
        }
        if (actual !== state.bg || image.isEmpty() || !state.shadow.includes(state.expected) || !state.sameCard || state.history !== 'Blocked → Done') throw Error('Live edge/history/paint mismatch')
        fs.writeFileSync(path.join(out, `ticket-live-${theme}-${step}.png`), image.toPNG()); states.push({ ...state, actual })
      }
    }
    for (let i = 0; i < states.length; i += 2) {
      if (states[i].shadow === states[i + 1].shadow || states[i].reads >= states[i + 1].reads || JSON.stringify(states[i].rect) !== JSON.stringify(states[i + 1].rect)) throw Error('Status did not refresh in place')
    }
    fs.writeFileSync(path.join(out, 'capture.json'), JSON.stringify(states, null, 2))
  } finally { clearTimeout(deadline); if (win && !win.isDestroyed()) win.destroy(); if (server) await new Promise(r => server.close(r)) }
}).then(() => app.exit(0), e => { console.error(e.stack || e); app.exit(2) })
