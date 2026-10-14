const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const out = process.argv[process.argv.indexOf('--probe-out') + 1]
if (!out || !path.isAbsolute(out)) throw new Error('--probe-out needs an absolute artifact folder')
for (const key of ['userData', 'sessionData', 'logs', 'crashDumps']) {
  const folder = path.join(out, key); fs.mkdirSync(folder, { recursive: true }); app.setPath(key, folder)
}
app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1100, height: 760, show: false,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.session.webRequest.onBeforeRequest((details, done) =>
    done({ cancel: !details.url.startsWith('file:') && !details.url.startsWith('data:') }))
  const wait = selector => win.webContents.executeJavaScript(`new Promise((resolve,reject)=>{
    const found=()=>document.querySelector(${JSON.stringify(selector)});
    if(found()){resolve(true);return} const observer=new MutationObserver(()=>{if(found()){observer.disconnect();clearTimeout(timer);resolve(true)}});
    observer.observe(document.body,{childList:true,subtree:true,attributes:true});
    const timer=setTimeout(()=>{observer.disconnect();reject(Error('probe element missing'))},5000);
  })`)
  try {
    await win.loadFile(path.join(out, 'index.html'))
    await wait('.attn-panel-desk textarea')
    const checks = []
    for (const light of [false, true]) {
      const theme = light ? 'light' : 'dark'
      await win.webContents.executeJavaScript(`window.deskReclaimVisual.contrast(${light});
        window.reclaimComposer=document.querySelector('.attn-panel-desk textarea');
        window.deskReclaimVisual.open()`)
      await wait('[data-switchboard] textarea')
      await wait('.attn-panel-desk .popout-placeholder')
      await new Promise(resolve => setTimeout(resolve, 100))
      // DOM readiness can precede the compositor frame used by capturePage.
      await win.webContents.executeJavaScript('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
      fs.writeFileSync(path.join(out, `${theme}-open.png`), (await win.webContents.capturePage()).toPNG())
      await win.webContents.executeJavaScript('window.deskReclaimVisual.close()')
      await wait('.attn-panel-desk textarea')
      await new Promise(resolve => setTimeout(resolve, 100))
      const closed = await win.webContents.executeJavaScript(`(()=>{
        const panel=document.querySelector('.attn-panel-desk'),desk=panel.querySelector('.attn-desk'),
          live=desk.querySelector('.desk-body')||desk.querySelector('.eye-chat')||desk.querySelector('.desk-bare');
        const box=e=>{const r=e?.getBoundingClientRect();return r?{x:r.x,y:r.y,w:r.width,h:r.height}:null};
        return {placeholder:panel.querySelectorAll('.popout-placeholder').length,
          sameComposer:panel.querySelector('textarea')===window.reclaimComposer,
          composers:document.querySelectorAll('textarea').length,desk:box(desk),live:box(live),
          pin:box(panel.closest('.modalpin-win')),background:getComputedStyle(document.body).backgroundColor};
      })()`)
      await win.webContents.executeJavaScript('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
      fs.writeFileSync(path.join(out, `${theme}-closed.png`), (await win.webContents.capturePage()).toPNG())
      checks.push({ theme, closed })
    }
    const passed = checks.every(({closed:c}) => c.placeholder === 0 && c.sameComposer && c.composers === 1 &&
      c.pin && c.live && c.desk && c.live.w > 0 && Math.abs(c.live.w-c.desk.w) <= 2) &&
      checks[0].closed.background !== checks[1].closed.background
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ passed, checks }, null, 2))
    win.destroy(); app.exit(passed ? 0 : 1)
  } catch (error) { console.error(error); win.destroy(); app.exit(1) }
}).catch(error => { console.error(error); app.exit(1) })
