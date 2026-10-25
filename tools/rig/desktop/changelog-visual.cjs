// Changelog captures (changelog-window-one-row-per-version-pinnable-po): the
// panel on the latest release with its real notes and GitHub publish times, an
// older release selected, the header's "Show this every time" checkbox cleared
// by a CDP pointer click, and the app menu with Changelog below Usage history.
// Dark and light.
//
// ISOLATION (docs/agents/development-and-verification.md, test-window session
// and clipboard isolation): an offscreen window inherits the launching turn's
// Windows session, so this refuses to open any window unless its own process
// runs in Session 0 (ORGTREE_CAPTURE_PRIVATE_DESKTOP=1 names a never-switched
// private desktop instead). Every permission request and check is denied, the
// clipboard among them; the page replaces its clipboard APIs as well
// (tests/changelog.visual.tsx). Input is executeJavaScript and CDP
// Input.dispatchMouseEvent in the owned window only, never OS input. The
// receipt in result.json records the window process's PID and session and the
// clipboard denial.
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
  // the list column collapses below 896 px of list-and-pane (canvas/narrowlist.tsx NARROW_DOCS_WIDTH), which a 1000 px
  // window leaves at about 884; 1024 x 700 keeps it open and stays within Session 0's 1024 x 768 display
  const win = new BrowserWindow({ width: 1024, height: 700, show: false, useContentSize: true,
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
    const every=m.querySelector('.gallery-head > label.checkline.gallery-showretired.changelog-every-time');
    const tick=every?.querySelector('input[type=checkbox]');
    const at=(el)=>{if(!el)return false;const r=el.getBoundingClientRect();return el.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2))};
    const v=window.changelogVisual;
    return {title:m.querySelector('.gallery-head h3')?.textContent.trim(),
      every:every?{text:every.textContent.trim(),checked:!!tick?.checked,label:box(every),input:box(tick),hit:at(tick),
        h3:box(m.querySelector('.gallery-head h3'))}:null,
      stored:localStorage.getItem('orgtree-changelog-after-update'),link:!!m.querySelector('.changelog-setting-link'),
      listed:v.listed.map(r=>r.version),published:v.listed.map(r=>v.stamp(r.published_at)),tagged:v.listed.map(r=>v.stamp(r.tagged_at)),
      rows:rows.map(r=>({version:r.querySelector('.mfrom')?.textContent,time:r.querySelector('.mtime')?.textContent,
        on:r.classList.contains('on'),box:box(r)})),
      meta:m.querySelector('.mailer-read .doc-pane-meta-row')?.textContent,
      heading:m.querySelector('.mailer-read .changelog-notes h1')?.textContent??null,
      empty:m.querySelector('.mailer-read .dim.pad')?.textContent??null,pane:box(m.querySelector('.mailer-read')),
      narrow:!!m.querySelector('.mailer.narrow-list'),list:box(m.querySelector('.mailer-list')),
      listShown:(()=>{const l=m.querySelector('.mailer-list');if(!l)return false;const s=getComputedStyle(l);
        return s.visibility!=='hidden'&&s.display!=='none'&&!l.closest('[inert]')})()}})()`
  /** a real Chromium pointer click on the header checkbox: CDP into this window, never OS input */
  const clickEveryTime = async () => {
    const target = await js(`(()=>{const i=document.querySelector('.changelog-modal .changelog-every-time input');
      const r=i.getBoundingClientRect();window.__everyTimeTrusted=null;
      i.addEventListener('click',e=>{window.__everyTimeTrusted=e.isTrusted},{once:true});
      return {x:r.left+r.width/2,y:r.top+r.height/2}})()`)
    const debug = win.webContents.debugger
    debug.attach('1.3')
    try {
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
        await debug.sendCommand('Input.dispatchMouseEvent', { type, x: target.x, y: target.y,
          ...(type === 'mouseMoved' ? {} : { button: 'left', clickCount: 1 }) })
      }
    } finally { debug.detach() }
    return { ...target, input: 'CDP Input.dispatchMouseEvent', trusted: await js('window.__everyTimeTrusted') }
  }
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
      await js(`window.changelogVisual.open()`)
      await wait(`()=>document.querySelector('.changelog-modal .changelog-notes h1')`, 'the latest notes')
      const latest = await js(panelState)
      await shot(`${theme}-latest`)
      // 2. an older release selected
      await js(`document.querySelector('.changelog-row[data-version="4.4.3"]').click()`)
      await wait(`()=>/4\\.4\\.3/.test(document.querySelector('.changelog-modal .changelog-notes h1')?.textContent||'')`, '4.4.3 notes')
      const older = await js(panelState)
      await shot(`${theme}-older`)
      // 3. the header's "Show this every time" cleared by a pointer click: the setting itself, in place
      const click = await clickEveryTime()
      await wait(`()=>!document.querySelector('.changelog-modal .changelog-every-time input').checked`, 'the checkbox cleared')
      const unticked = { ...(await js(panelState)), click }
      await shot(`${theme}-unticked`)
      // 4. the app menu, open
      await js(`window.changelogVisual.menu()`)
      await wait(`()=>document.querySelector('.shell-menu-button')`, 'the menu button')
      await js(`document.querySelector('.shell-menu-button').click()`)
      await wait(`()=>document.querySelector('.shell-menu-panel')`, 'the open menu')
      const menu = await js(`[...document.querySelectorAll('.shell-menu-item .shell-menu-label')].map(e=>{const r=e.getBoundingClientRect();return {label:e.textContent,y:Math.round(r.top),h:Math.round(r.height)}})`)
      await shot(`${theme}-menu`)
      await js(`document.querySelector('.shell-menu-button').click()`)
      checks.push({ theme, latest, older, unticked, menu })
    }
    const sized = (b) => !!b && b.w > 0 && b.h > 0
    // inline: the checkbox line shares the title's line, to its right
    const inline = (e) => !!e && sized(e.label) && sized(e.input) && e.hit && e.label.x >= e.h3.x + e.h3.w
      && e.label.y < e.h3.y + e.h3.h && e.label.y + e.label.h > e.h3.y
    const passed = checks.every(({ latest, older, unticked, menu }) => {
      const at = menu.findIndex(m => m.label === 'Changelog…')
      const stacked = menu.every((m, i) => i === 0 || m.y > menu[i - 1].y)
      return latest.title === 'Changelog' && !latest.link
        && latest.every?.text === 'Show this every time' && latest.every.checked && inline(latest.every)
        && [latest, older, unticked].every(s => !s.narrow && s.listShown && sized(s.list))
        && latest.rows[0].version === '4.4.4' && latest.rows[0].on && latest.rows.every(r => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(r.time) && sized(r.box))
        && latest.rows.map(r => r.version).join() === latest.listed.join() && latest.listed[0] === '4.4.4'
        && latest.rows.every((r, i) => r.time === latest.published[i]) && latest.published[0] !== latest.tagged[0]
        && /^4\.4\.4/.test(latest.meta) && /Orgtree 4\.4\.4/.test(latest.heading) && sized(latest.pane)
        && older.rows.find(r => r.on)?.version === '4.4.3' && /Orgtree 4\.4\.3/.test(older.heading)
        && unticked.click.trusted === true && unticked.every?.checked === false && unticked.stored === '0'
        && unticked.title === 'Changelog' && unticked.rows.find(r => r.on)?.version === '4.4.3'
        && at > 0 && menu[at - 1].label === 'Usage history…' && stacked && menu[at].h > 0
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
