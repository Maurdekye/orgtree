// Desk tab memory captures (desks-remember-their-last-tab-and-the-inbox-tab-i):
// an agent desk beside a project desk opened from remembered tabs, as after a
// restart; then new picks, a full unmount and mount, and the project's mail
// window, in dark and light.
// Run only in Session 0 or on a never-switched private desktop. Offscreen
// inherits the launching turn session; use an isolated/empty clipboard, deny
// clipboard permissions, and target owned windows with CDP/PostMessage only
// (no OS input). Record child window SessionId and clipboard-denial state.
// Wait two animation frames and a pause before every capture (team notes,
// round 439).
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const out = process.argv[process.argv.indexOf('--probe-out') + 1]
if (!out || !path.isAbsolute(out)) throw new Error('--probe-out needs an absolute artifact folder')
for (const key of ['userData', 'sessionData', 'logs', 'crashDumps']) {
  const folder = path.join(out, key); fs.mkdirSync(folder, { recursive: true }); app.setPath(key, folder)
}
app.disableHardwareAcceleration()
app.on('window-all-closed', () => {})
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1000, height: 700, show: false, useContentSize: true,
    webPreferences: { offscreen: true, backgroundThrottling: false, contextIsolation: true, sandbox: true, nodeIntegration: false } })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.session.webRequest.onBeforeRequest((details, done) =>
    done({ cancel: !details.url.startsWith('file:') && !details.url.startsWith('data:') }))
  const js = (code) => win.webContents.executeJavaScript(code)
  const wait = selector => js(`new Promise((resolve,reject)=>{
    const found=()=>document.querySelector(${JSON.stringify(selector)});
    if(found()){resolve(true);return} const observer=new MutationObserver(()=>{if(found()){observer.disconnect();clearTimeout(timer);resolve(true)}});
    observer.observe(document.body,{childList:true,subtree:true,attributes:true});
    const timer=setTimeout(()=>{observer.disconnect();reject(Error('probe element missing: '+${JSON.stringify(selector)}))},8000);
  })`)
  const settle = async () => {
    await new Promise(resolve => setTimeout(resolve, 250))
    await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(r,120))))')
  }
  const shot = async (name) => { await settle(); fs.writeFileSync(path.join(out, name + '.png'), (await win.webContents.capturePage()).toPNG()) }
  const A = '[data-fixture="agent-desk"]', P = '[data-fixture="project-desk"]'
  const click = (selector) => js(`document.querySelector(${JSON.stringify(selector)}).click()`)
  const folder = (name) => js(`[...document.querySelectorAll('${P} .mail-folders button')]
    .find(b => b.textContent.trim().startsWith(${JSON.stringify(name)})).click()`)
  const ready = async () => { await wait(`${A} .cc-head`); await wait(`${P} .cc-head`); await settle() }
  const probe = () => js(`(()=>{
    const labels = root => [...document.querySelectorAll(root + ' .cc-tabs button')].map(b => b.textContent.replace(/\\s+\\d+$/, '').trim())
    const on = root => document.querySelector(root + ' .cc-tabs button.on')?.getAttribute('data-tab') ?? null
    return { agentLabels: labels('${A}'), projectLabels: labels('${P}'), agentTab: on('${A}'), projectTab: on('${P}'),
      projectFolder: document.querySelector('${P} .mail-folders button.on')?.textContent.replace(/\\s+\\d+$/, '').trim() ?? null,
      projectFolders: [...document.querySelectorAll('${P} .mail-folders button')].map(b => b.textContent.replace(/\\s+\\d+$/, '').trim()),
      stored: localStorage.getItem('orgtree-desk-tabs:org') }
  })()`)
  try {
    await win.loadFile(path.join(out, 'index.html'))
    await ready()
    const checks = []
    for (const light of [false, true]) {
      const theme = light ? 'light' : 'dark'
      await js(`window.deskTabMemoryVisual.contrast(${light})`)
      await js('window.deskTabMemoryVisual.reseed()')
      await ready()
      await wait(`${P} .mail-folders button.on`)
      await shot(`${theme}-reopened`)
      const reopened = await probe()
      // new picks: the project's Sent folder, then Summary and Mail again; the
      // agent's Mail tab. Then both desks unmount and mount again.
      await folder('sent')
      await click(`${P} .cc-tabs button[data-tab="desk"]`)
      await click(`${P} .cc-tabs button[data-tab="inbox"]`)
      await wait(`${P} .mail-folders button.on`)
      const tabStrip = await probe()
      await click(`${A} .cc-tabs button[data-tab="inbox"]`)
      await js('window.deskTabMemoryVisual.remount()')
      await ready()
      await wait(`${A} .mail-folders`)
      await wait(`${P} .mail-folders button.on`)
      await shot(`${theme}-remounted`)
      const remounted = await probe()
      await js("window.deskTabMemoryVisual.window('project')")
      await wait('.overlay .settings .mail-folders')
      await js("document.querySelector('.overlay .settings .mailer-listtoggle')?.click()")
      await shot(`${theme}-mail-window`)
      const mailWindow = await js(`({ heads: [...document.querySelectorAll('.overlay h3')].map(h => h.textContent.replace(/\\s+/g, ' ').trim()),
        folders: [...document.querySelectorAll('.overlay .mail-folders button')].map(b => b.textContent.replace(/\\s+\\d+$/, '').trim()) })`)
      await js('window.deskTabMemoryVisual.window(null)')
      checks.push({ theme, reopened, tabStrip, remounted, mailWindow })
    }
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
    const passed = checks.every(({ reopened, tabStrip, remounted, mailWindow }) =>
      same(reopened.agentLabels, ['chat', 'mail', 'docket', 'presented', 'team'])
      && same(reopened.projectLabels.slice(0, 4), ['summary', 'mail', 'docket', 'presented'])
      && !reopened.agentLabels.includes('inbox') && !reopened.projectLabels.includes('inbox')
      // the earlier session's memory: boss on Docket, inner's Mail on Listeners
      && reopened.agentTab === 'docket' && reopened.projectTab === 'inbox' && reopened.projectFolder === 'listeners'
      && same(reopened.projectFolders, ['inbox', 'sent', 'listeners'])
      // the tab strip reopens the folder last picked
      && tabStrip.projectTab === 'inbox' && tabStrip.projectFolder === 'sent'
      // a fresh mount reopens each desk's last pick
      && remounted.agentTab === 'inbox' && remounted.projectTab === 'inbox' && remounted.projectFolder === 'sent'
      && mailWindow.heads.some(h => /inner · mail$/.test(h)) && !mailWindow.heads.some(h => /· inbox/.test(h))
      && same(mailWindow.folders, ['inbox', 'sent', 'listeners']))
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ passed, checks }, null, 2))
    console.log(JSON.stringify({ passed }))
    win.destroy(); app.exit(passed ? 0 : 1)
  } catch (error) { console.error(error); win.destroy(); app.exit(1) }
}).catch(error => { console.error(error); app.exit(1) })
