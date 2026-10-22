// One PNG contains both real surfaces, each in an isolated synthetic frame.
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), assert = require('node:assert/strict')
const out = process.env.PROJECT_EVENTS_OUTPUT
if (!/^C:[\\/]orgtree-build[\\/]ordering-sol[\\/]project-events-labels[\\/]capture$/i.test(out || '')) throw Error('Owned capture output required')
app.setPath('userData', path.join(out, 'electron-data'))
app.disableHardwareAcceleration()
app.whenReady().then(async () => {
 let server, win
 const timer = setTimeout(() => app.exit(2), 45000)
 try {
  const frame = '<!doctype html><html data-theme="dark"><head><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>'
  const parent = '<!doctype html><html style="background:#111827;color:#eef2ff;font:15px system-ui"><body style="margin:12px"><h2 style="margin:0 0 12px">Project Events setting and events desk tab</h2><main style="display:grid;grid-template-columns:560px 1fr;gap:12px;height:780px"><iframe title="Project settings" id="settings" src="/frame.html?surface=settings" style="width:100%;height:100%;border:1px solid #475569"></iframe><iframe title="Project desk" id="desk" src="/frame.html?surface=desk" style="width:100%;height:100%;border:1px solid #475569"></iframe></main></body></html>'
  server = http.createServer((req, res) => {
   const pathname = new URL(req.url, 'http://localhost').pathname
   if (pathname === '/') { res.setHeader('Content-Type', 'text/html'); res.end(parent); return }
   if (pathname === '/frame.html') { res.setHeader('Content-Type', 'text/html'); res.end(frame); return }
   if (!['/fixture.js','/fixture.css'].includes(pathname)) { res.writeHead(404); res.end(); return }
   res.setHeader('Content-Type', pathname.endsWith('.js') ? 'text/javascript' : 'text/css')
   res.end(fs.readFileSync(path.join(out, pathname.slice(1))))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  win = new BrowserWindow({ width: 1440, height: 860, show: false, paintWhenInitiallyHidden: true,
   webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  await win.loadURL('http://127.0.0.1:' + server.address().port + '/')
  await win.webContents.executeJavaScript(`new Promise((resolve,reject)=>{let tries=0;const tick=()=>{const a=document.querySelector('#settings').contentDocument,b=document.querySelector('#desk').contentDocument,s=a?.querySelector('input[aria-label="Project Events"]'),t=b?.querySelector('[data-tab="listeners"]');if(s&&!s.disabled&&t){s.scrollIntoView({block:'center'});t.scrollIntoView({block:'nearest'});resolve(true)}else if(++tries<200)setTimeout(tick,40);else reject(Error('Missing project event labels'))};tick()})`)
  await win.webContents.executeJavaScript(`Promise.all([...document.querySelectorAll('iframe')].map(f=>new Promise(r=>f.contentWindow.requestAnimationFrame(()=>f.contentWindow.requestAnimationFrame(()=>setTimeout(r,200))))))`)
  const state = await win.webContents.executeJavaScript(`(()=>{const a=document.querySelector('#settings').contentDocument,b=document.querySelector('#desk').contentDocument,s=a.querySelector('input[aria-label="Project Events"]'),t=b.querySelector('[data-tab="listeners"]'),box=e=>{const r=e.getBoundingClientRect();return{x:r.x,y:r.y,w:r.width,h:r.height}};return{setting:s.getAttribute('aria-label'),checked:s.checked,hint:s.closest('.set-row').textContent,tab:t.textContent.trim(),tabId:t.dataset.tab,settingBox:box(s),tabBox:box(t),settingsHeight:a.defaultView.innerHeight,deskHeight:b.defaultView.innerHeight,eventsView:!!b.querySelector('.project-listeners')}})()`)
  assert.equal(state.setting, 'Project Events'); assert.equal(state.checked, true)
  assert.equal(state.tab, 'events'); assert.equal(state.tabId, 'listeners'); assert.equal(state.eventsView, true)
  assert.match(state.hint, /desk shows the events tab/)
  assert(state.settingBox.y >= 0 && state.settingBox.y + state.settingBox.h <= state.settingsHeight)
  assert(state.tabBox.h >= 16 && state.tabBox.w >= 30, 'desk label must be readable at window scale')
  assert(state.tabBox.y >= 0 && state.tabBox.y + state.tabBox.h <= state.deskHeight)
  const png = await win.webContents.capturePage(); assert(!png.isEmpty())
  fs.writeFileSync(path.join(out, 'project-events.png'), png.toPNG())
  fs.writeFileSync(path.join(out, 'capture.json'), JSON.stringify({ passed: true, ...state }, null, 2))
  console.log('PASS real settings and desk labels in one synthetic capture')
 } finally { clearTimeout(timer); if(win)win.destroy(); if(server)await new Promise(resolve=>server.close(resolve)) }
}).then(()=>app.exit(0), error=>{console.error(error.stack || error);app.exit(1)})
