// Standalone Electron test surface; launched only by the visual runner.
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
    await wait('button[title="/fixture/01-missing.json"]')
    const checks = []
    for (const light of [false, true]) {
      await win.webContents.executeJavaScript(`window.presetVisual.contrast(${light});window.presetVisual.select('')`)
      await wait('.tp-row.collapsed')
      await new Promise(resolve => setTimeout(resolve, 100))
      const list = await win.webContents.executeJavaScript(`(()=>{
        const rows=[...document.querySelectorAll('.tp-row')],missing=rows[1],ready=rows[2];
        return {compact:missing.classList.contains('collapsed'),selectable:!missing.disabled,
          noDetails:!missing.querySelector('.tp-mini,.tp-desc,.tp-count'),
          dim:getComputedStyle(missing.querySelector('.tp-name')).color!==getComputedStyle(ready.querySelector('.tp-name')).color,
          order:rows.map(row=>row.querySelector('.tp-name').textContent),background:getComputedStyle(document.body).backgroundColor};
      })()`)
      // DOM readiness can precede the compositor frame used by capturePage.
      await win.webContents.executeJavaScript('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
      fs.writeFileSync(path.join(out, `${light ? 'light' : 'dark'}-list.png`), (await win.webContents.capturePage()).toPNG())
      await win.webContents.executeJavaScript("window.presetVisual.select('missing')")
      await wait('.tp-unusable-warning')
      await new Promise(resolve => setTimeout(resolve, 100))
      await win.webContents.executeJavaScript('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
      const selected = await win.webContents.executeJavaScript(`({warning:document.querySelector('.tp-unusable-warning').textContent,
        models:document.querySelectorAll('.tp-preview select').length,expanded:!document.querySelector('.tp-row.sel').classList.contains('collapsed')})`)
      fs.writeFileSync(path.join(out, `${light ? 'light' : 'dark'}-selected.png`), (await win.webContents.capturePage()).toPNG())
      checks.push({ theme: light ? 'light' : 'dark', list, selected })
    }
    const passed = checks.every(c => c.list.compact && c.list.selectable && c.list.noDetails && c.list.dim &&
      c.selected.expanded && c.selected.models === 2 && c.selected.warning.includes('unless you change their models')) &&
      checks[0].list.background !== checks[1].list.background
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ passed, checks }, null, 2))
    win.destroy(); app.exit(passed ? 0 : 1)
  } catch (error) { console.error(error); win.destroy(); app.exit(1) }
}).catch(error => { console.error(error); app.exit(1) })
