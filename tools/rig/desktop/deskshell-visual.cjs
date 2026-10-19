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
  const win = new BrowserWindow({ width: 1320, height: 720, show: false,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.session.webRequest.onBeforeRequest((details, done) =>
    done({ cancel: !details.url.startsWith('file:') && !details.url.startsWith('data:') }))
  const wait = selector => win.webContents.executeJavaScript(`new Promise((resolve,reject)=>{
    const found=()=>document.querySelector(${JSON.stringify(selector)});
    if(found()){resolve(true);return} const observer=new MutationObserver(()=>{if(found()){observer.disconnect();clearTimeout(timer);resolve(true)}});
    observer.observe(document.body,{childList:true,subtree:true,attributes:true});
    const timer=setTimeout(()=>{observer.disconnect();reject(Error('probe element missing: '+${JSON.stringify(selector)}))},8000);
  })`)
  const settle = async () => {
    await new Promise(resolve => setTimeout(resolve, 150))
    await win.webContents.executeJavaScript('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
  }
  try {
    await win.loadFile(path.join(out, 'index.html'))
    await wait('[data-fixture="agent-desk"] .cc-head')
    await wait('[data-fixture="project-desk"] .cc-head')
    const checks = []
    for (const light of [false, true]) {
      const theme = light ? 'light' : 'dark'
      await win.webContents.executeJavaScript(`window.deskShellVisual.contrast(${light})`)
      await settle()
      const probe = await win.webContents.executeJavaScript(`(()=>{
        const head = s => { const e = document.querySelector(s); if (!e) return null
          const r = e.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } }
        const tabs = s => [...document.querySelectorAll(s)].map(e => e.dataset.tab + ':' + e.textContent.trim())
        return {
          agentHead: head('[data-fixture="agent-desk"] .cc-head'),
          projectHead: head('[data-fixture="project-desk"] .cc-head'),
          agentTabs: tabs('[data-fixture="agent-desk"] .cc-tabs button[data-tab]'),
          projectTabs: tabs('[data-fixture="project-desk"] .cc-tabs button[data-tab]'),
          meta: [...document.querySelectorAll('[data-fixture="project-desk"] .cc-head-meta')].map(e => e.textContent.trim()),
        }
      })()`)
      fs.writeFileSync(path.join(out, `${theme}-docked.png`), (await win.webContents.capturePage()).toPNG())
      await win.webContents.executeJavaScript('window.deskShellVisual.modal(true)')
      await wait('.project-desk-modal .cc-head')
      await settle()
      fs.writeFileSync(path.join(out, `${theme}-modal.png`), (await win.webContents.capturePage()).toPNG())
      await win.webContents.executeJavaScript('window.deskShellVisual.modal(false)')
      await settle()
      checks.push({ theme, probe })
    }
    const passed = checks.every(({ probe: p }) => p.agentHead && p.projectHead &&
      p.agentTabs.length >= 3 && p.projectTabs.length >= 5)
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ passed, checks }, null, 2))
    win.destroy(); app.exit(passed ? 0 : 1)
  } catch (error) { console.error(error); win.destroy(); app.exit(1) }
}).catch(error => { console.error(error); app.exit(1) })
