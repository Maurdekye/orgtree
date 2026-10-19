// Desk parity captures: an agent desk beside a nested project desk, each
// project tab the parity pass touches, and the project's inbox window, in
// dark and light. Offscreen and within Session 0's 1024x768 display; two
// animation frames and a pause before every capture (team notes, round 439).
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
  const P = '[data-fixture="project-desk"]'
  const tab = (t) => js(`document.querySelector('${P} .cc-tabs button[data-tab="${t}"]').click()`)
  try {
    await win.loadFile(path.join(out, 'index.html'))
    await wait('[data-fixture="agent-desk"] .cc-head')
    await wait(`${P} .cc-head`)
    const checks = []
    for (const light of [false, true]) {
      const theme = light ? 'light' : 'dark'
      await js(`window.deskParityVisual.contrast(${light})`)
      await tab('desk')
      await shot(`${theme}-desks`)
      const desks = await js(`(()=>{
        const names = s => [...document.querySelectorAll(s)].map(e => e.getAttribute('data-copy-agent-name') || e.textContent.trim())
        return { up: names('${P} .cc-head .project-head-cards button.desk-nav-chip'),
          down: names('${P} .desk-nav button.desk-nav-chip'),
          agentDown: names('[data-fixture="agent-desk"] .desk-nav button.desk-nav-chip') }
      })()`)
      await tab('inbox')
      await wait(`${P} .mailrow`)
      await js(`document.querySelector('${P} .mailrow').click()`)
      await shot(`${theme}-inbox`)
      const inbox = await js(`(()=>{
        const c = document.querySelector('${P} .mail-folders .tab-count')
        return { wait: document.querySelector('${P} .mailer-head .wait')?.textContent ?? null,
          count: c ? { text: c.textContent, cls: c.className, color: getComputedStyle(c).color } : null,
          retract: !!document.querySelector('${P} .mailrow button.chip-x[title="retract (undelivered)"]') }
      })()`)
      await tab('docket')
      await wait(`${P} .docket-row`)
      await shot(`${theme}-docket`)
      const docket = await js(`({ badge: document.querySelector('${P} .cc-tabs button[data-tab="docket"] .tab-count')?.textContent ?? null,
        rows: document.querySelectorAll('${P} .docket-row').length })`)
      await tab('desk')
      let windowProbe = null
      if (await js('window.deskParityVisual.hasInboxWindow()')) {
        await js('window.deskParityVisual.inboxWindow(true)')
        await wait('.modalpin-win .mail-folders, [role="dialog"] .mail-folders')
        await shot(`${theme}-inbox-window`)
        windowProbe = await js(`(()=>{ const w = document.querySelector('.modalpin-win, [role="dialog"]')
          return { folders: [...w.querySelectorAll('.mail-folders button')].map(b => b.textContent.trim()),
            purge: !!w.querySelector('button[data-action="purge-queue"]'), projectRows: w.querySelectorAll('.mailrow.project-mail').length } })()`)
        await js('window.deskParityVisual.inboxWindow(false)')
      }
      checks.push({ theme, desks, inbox, docket, inboxWindow: windowProbe })
    }
    const passed = checks.every(({ desks, inbox, docket, inboxWindow }) =>
      JSON.stringify(desks.up) === JSON.stringify(['boss', 'outer'])
      && desks.down.join(',') === 'dev1,ui,dev2,show 2 retired'
      && inbox.wait === 'waiting in the project queue' && inbox.count && !/prov-/.test(inbox.count.cls) && inbox.retract
      && docket.badge === '2' && docket.rows === 4
      && inboxWindow && inboxWindow.purge && inboxWindow.projectRows > 0 && inboxWindow.folders.some(f => f.startsWith('listeners')))
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ passed, checks }, null, 2))
    console.log(JSON.stringify({ passed }))
    win.destroy(); app.exit(passed ? 0 : 1)
  } catch (error) { console.error(error); win.destroy(); app.exit(1) }
}).catch(error => { console.error(error); app.exit(1) })
