// Changelog captures (changelog-window-one-row-per-version-pinnable-po): the
// panel on the latest release with its real notes, an older release selected,
// a local alpha's unpublished row on top, and the app menu with Changelog below
// Usage history. Dark and light.
//
// ISOLATION (docs/agents/development-and-verification.md, test-window session
// and clipboard isolation): an offscreen window inherits the launching turn's
// Windows session, so this refuses to open any window unless its own process
// runs in Session 0 (ORGTREE_CAPTURE_PRIVATE_DESKTOP=1 names a never-switched
// private desktop instead). Every permission request and check is denied, the
// clipboard among them; the page replaces its clipboard APIs as well
// (tests/changelog.visual.tsx). Input is executeJavaScript in the owned window
// only, never OS input. The receipt in result.json records the window
// process's PID and session and the clipboard denial.
// Wait two animation frames and a pause before every capture.
const { app, BrowserWindow, session } = require('electron')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const out = process.argv[process.argv.indexOf('--probe-out') + 1]
if (!out || !path.isAbsolute(out)) throw new Error('--probe-out needs an absolute artifact folder')
for (const key of ['userData', 'sessionData', 'logs', 'crashDumps']) {
  const folder = path.join(out, key); fs.mkdirSync(folder, { recursive: true }); app.setPath(key, folder)
}

/** this process's Windows session, measured; null where there are none */
function sessionId(pid) {
  if (process.platform !== 'win32') return null
  const text = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `(Get-Process -Id ${Number(pid)}).SessionId`], { encoding: 'utf8', windowsHide: true, timeout: 20000 }).trim()
  if (!/^\d+$/.test(text)) throw new Error(`unreadable session id for ${pid}: ${text}`)
  return Number(text)
}
const privateDesktop = process.env.ORGTREE_CAPTURE_PRIVATE_DESKTOP === '1'
const receipt = { pid: process.pid, session: sessionId(process.pid), private_desktop: privateDesktop }
if (process.platform === 'win32' && receipt.session !== 0 && !privateDesktop) {
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ passed: false, refused: 'not Session 0', receipt }, null, 2))
  console.error(`refused: this process runs in Windows session ${receipt.session}, not Session 0; no window was opened`)
  process.exit(3)
}

app.disableHardwareAcceleration()
app.on('window-all-closed', () => {})
app.whenReady().then(async () => {
  const denied = []
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => { denied.push(permission); callback(false) })
  session.defaultSession.setPermissionCheckHandler(() => false)
  const win = new BrowserWindow({ width: 900, height: 640, show: false, useContentSize: true,
    webPreferences: { offscreen: true, backgroundThrottling: false, contextIsolation: true, sandbox: true, nodeIntegration: false } })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.session.webRequest.onBeforeRequest((details, done) =>
    done({ cancel: !details.url.startsWith('file:') && !details.url.startsWith('data:') }))
  const js = (code) => win.webContents.executeJavaScript(code)
  const wait = (test, what) => js(`new Promise((resolve,reject)=>{
    const found=()=>{try{return (${test})()}catch{return false}};
    if(found()){resolve(true);return} const observer=new MutationObserver(()=>{if(found()){observer.disconnect();clearTimeout(timer);resolve(true)}});
    observer.observe(document.body,{childList:true,subtree:true,attributes:true,characterData:true});
    const timer=setTimeout(()=>{observer.disconnect();reject(Error('probe missing: '+${JSON.stringify(what)}))},8000);
  })`)
  const settle = async () => {
    await new Promise(resolve => setTimeout(resolve, 250))
    await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(r,120))))')
  }
  const shot = async (name) => { await settle(); fs.writeFileSync(path.join(out, name + '.png'), (await win.webContents.capturePage()).toPNG()) }
  /** what is drawn, with real layout: jsdom's 0x0 boxes prove nothing */
  const panelState = `(()=>{const m=document.querySelector('.changelog-modal');if(!m)return null;
    const box=(el)=>{if(!el)return null;const r=el.getBoundingClientRect();return {x:Math.round(r.left),y:Math.round(r.top),w:Math.round(r.width),h:Math.round(r.height)}};
    const rows=[...m.querySelectorAll('.changelog-row')];
    return {title:m.querySelector('.gallery-head h3')?.textContent.trim(),link:m.querySelector('.changelog-setting-link')?.textContent,
      linkBox:box(m.querySelector('.changelog-setting-link')),
      rows:rows.map(r=>({version:r.querySelector('.mfrom')?.textContent,time:r.querySelector('.mtime')?.textContent,
        on:r.classList.contains('on'),unpublished:r.classList.contains('unpublished'),box:box(r)})),
      meta:m.querySelector('.mailer-read .doc-pane-meta-row')?.textContent,draft:m.querySelector('.changelog-draft')?.textContent??null,
      heading:m.querySelector('.mailer-read .changelog-notes h1')?.textContent??null,
      empty:m.querySelector('.mailer-read .dim.pad')?.textContent??null,pane:box(m.querySelector('.mailer-read'))}})()`
  const clipboardProbe = `(async()=>{let read='allowed';try{await navigator.clipboard.readText()}catch(e){read='refused: '+e.name}
    let write='allowed';try{await navigator.clipboard.writeText('x')}catch(e){write='refused: '+e.name}
    return {read,write,execPaste:document.execCommand('paste'),execCopy:document.execCommand('copy')}})()`
  try {
    await win.loadFile(path.join(out, 'index.html'))
    await wait(`()=>document.querySelector('.changelog-modal .changelog-row.on')`, 'the panel on its latest row')
    receipt.renderer_pid = win.webContents.getOSProcessId()
    receipt.renderer_session = sessionId(receipt.renderer_pid)
    receipt.clipboard = { permissions: 'every request and check denied', page: await js(clipboardProbe) }
    const checks = []
    for (const light of [false, true]) {
      const theme = light ? 'light' : 'dark'
      await js(`window.changelogVisual.contrast(${light})`)
      // 1. a fresh opening: the latest release, its real notes
      await js(`window.changelogVisual.open('release')`)
      await wait(`()=>document.querySelector('.changelog-modal .changelog-notes h1')`, 'the latest notes')
      const latest = await js(panelState)
      await shot(`${theme}-latest`)
      // 2. an older release selected
      await js(`document.querySelector('.changelog-row[data-version="4.4.3"]').click()`)
      await wait(`()=>/4\\.4\\.3/.test(document.querySelector('.changelog-modal .changelog-notes h1')?.textContent||'')`, '4.4.3 notes')
      const older = await js(panelState)
      await shot(`${theme}-older`)
      // 3. a local alpha: its own row on top, open
      await js(`window.changelogVisual.open('alpha')`)
      await wait(`()=>document.querySelector('.changelog-row.on.unpublished')&&/written when/.test(document.querySelector('.changelog-modal .mailer-read')?.textContent||'')`, 'the alpha row open')
      const alpha = await js(panelState)
      await shot(`${theme}-alpha`)
      // 4. the app menu, open
      await js(`window.changelogVisual.menu()`)
      await wait(`()=>document.querySelector('.shell-menu-button')`, 'the menu button')
      await js(`document.querySelector('.shell-menu-button').click()`)
      await wait(`()=>document.querySelector('.shell-menu-panel')`, 'the open menu')
      const menu = await js(`[...document.querySelectorAll('.shell-menu-item .shell-menu-label')].map(e=>{const r=e.getBoundingClientRect();return {label:e.textContent,y:Math.round(r.top),h:Math.round(r.height)}})`)
      await shot(`${theme}-menu`)
      await js(`document.querySelector('.shell-menu-button').click()`)
      checks.push({ theme, latest, older, alpha, menu })
    }
    const sized = (b) => !!b && b.w > 0 && b.h > 0
    const passed = checks.every(({ latest, older, alpha, menu }) => {
      const at = menu.findIndex(m => m.label === 'Changelog…')
      return latest.title === 'Changelog' && latest.link === 'Open after updates: On' && sized(latest.linkBox)
        && latest.rows[0].version === '4.4.4' && latest.rows[0].on && latest.rows.every(r => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(r.time) && sized(r.box))
        && latest.rows.map(r => r.version).join() === '4.4.4,4.4.3,4.4.2,4.4.1,4.4.0,4.3.3,4.3.2'
        && /^4\.4\.4/.test(latest.meta) && /Orgtree 4\.4\.4/.test(latest.heading) && sized(latest.pane)
        && older.rows.find(r => r.on)?.version === '4.4.3' && /Orgtree 4\.4\.3/.test(older.heading)
        && alpha.rows[0].version === '4.4.5-alpha.4' && alpha.rows[0].on && alpha.rows[0].unpublished
        && /Unpublished build/.test(alpha.meta) && /written when it is released/.test(alpha.empty)
        && at > 0 && menu[at - 1].label === 'Usage history…' && menu[at].y > menu[at - 1].y && menu[at].h > 0
    }) && receipt.clipboard.page.read.startsWith('refused') && receipt.clipboard.page.write.startsWith('refused')
      && receipt.clipboard.page.execPaste === false && receipt.clipboard.page.execCopy === false
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ passed, receipt, denied, checks }, null, 2))
    console.log(JSON.stringify({ passed, receipt }))
    win.destroy(); app.exit(passed ? 0 : 1)
  } catch (error) {
    console.error(error)
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ passed: false, error: String(error), receipt, denied }, null, 2))
    win.destroy(); app.exit(1)
  }
}).catch(error => { console.error(error); app.exit(1) })
