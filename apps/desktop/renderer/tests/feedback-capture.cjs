// Real Runtime panel with synthetic services; never opens the live app.
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs'), path = require('node:path'), http = require('node:http')
const out = process.env.FEEDBACK_OUTPUT
if (!/^C:[\\/]orgtree-build[\\/]skilltree-opus[\\/]/i.test(out || '')) throw Error('Expected owned build output')
app.setPath('userData', path.join(out, 'electron-data'))
app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  let win, server
  const timer = setTimeout(() => { console.error('Capture deadline'); app.exit(2) }, 30000)
  try {
    server = http.createServer((req, res) => {
      const file = req.url === '/' ? 'fixture.html' : req.url === '/fixture.js' ? 'fixture.js' : req.url === '/styles.css' ? 'styles.css' : null
      if (!file) { res.writeHead(404); res.end(); return }
      res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html')
      res.end(fs.readFileSync(path.join(out, file)))
    })
    await new Promise(r => server.listen(0, '127.0.0.1', r))
    win = new BrowserWindow({ width: 1000, height: 700, show: false, paintWhenInitiallyHidden: true,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
    await win.loadURL('http://127.0.0.1:' + server.address().port + '/')
    const ready = `new Promise((resolve,reject)=>{let n=0;const tick=()=>{
      const input=document.querySelector('[aria-label="Suggest agents to give feedback to Orgtree"]');
      if(input&&!input.disabled){input.closest('.set-group').scrollIntoView({block:'center'});resolve(true)}
      else if(++n<100)setTimeout(tick,30);else reject(Error('Missing enabled feedback toggle'))};tick()})`
    await win.webContents.executeJavaScript(ready)
    const paint = () => win.webContents.executeJavaScript('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(r,150))))')
    for (const on of [true, false]) {
      if (!on) await win.webContents.executeJavaScript('document.querySelector(\'[aria-label="Suggest agents to give feedback to Orgtree"]\').click(); true')
      await paint()
      const state = await win.webContents.executeJavaScript(`(()=>{const i=document.querySelector('[aria-label="Suggest agents to give feedback to Orgtree"]'),row=i.closest('.set-row'),r=row.getBoundingClientRect();return{checked:i.checked,disabled:i.disabled,text:row.textContent,rect:{x:r.x,y:r.y,w:r.width,h:r.height},viewport:{w:innerWidth,h:innerHeight}}})()`)
      if (state.checked !== on || state.disabled || state.rect.y < 0 || state.rect.y + state.rect.h > state.viewport.h || state.rect.x + state.rect.w > state.viewport.w) throw Error('Invalid setting state/geometry: ' + JSON.stringify(state))
      fs.writeFileSync(path.join(out, on ? 'feedback-on.json' : 'feedback-off.json'), JSON.stringify(state, null, 2))
      const png = await win.webContents.capturePage()
      if (png.isEmpty()) throw Error('Empty capture')
      fs.writeFileSync(path.join(out, on ? 'feedback-on.png' : 'feedback-off.png'), png.toPNG())
      console.log('PASS feedback capture ' + (on ? 'on' : 'off'))
    }
  } catch (e) { console.error(e); process.exitCode = 1 }
  finally { clearTimeout(timer); if (win) win.destroy(); if (server) await new Promise(r => server.close(r)); app.exit(process.exitCode || 0) }
})
