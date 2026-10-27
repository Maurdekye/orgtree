// Question notification captures (docket 4-5-0-clicking-a-question-s-desktop-
// notification; USER 2026-10-27 13:25:36Z m007c48d12f28). For each scene of
// tests/questionnotificationdesk.visual.tsx (the asker's desk on a desk pin,
// in the floating Open desk modal, on its own zoomed canvas card, in its
// zoomed switchboard panel, in the Attention agent desk, in the pinned Attention
// agent desk, and open nowhere) it captures the window before and
// after the question's notification click, outlines whatever then has the
// focus, and writes each scene's facts and verdict to result.json.
//
// ISOLATION (docs/agents/development-and-verification.md, test-window session
// and clipboard isolation): an offscreen window inherits the launching turn's
// Windows session, so this refuses to open any window unless its own process
// runs in Session 0 (ORGTREE_CAPTURE_PRIVATE_DESKTOP=1 names a never-switched
// private desktop instead). Every permission request and check is denied, the
// clipboard among them; the page replaces its clipboard APIs as well. Audio is
// muted. Input is executeJavaScript in the owned window only, never OS input.
// Network is refused except file: and data:. The receipt records the window
// process's PID and session and the clipboard denial.
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

// what each scene must show after the click; `before` checks its own setup
const EXPECT = {
  'pin': {
    before: f => f.askerPinOnTop === false && f.questionCards.includes('desk pin'),
    after: f => !f.inboxOpen && f.askerPinOnTop === true && f.focusedQuestion && f.focusedIn === 'desk pin',
  },
  'floating': {
    before: f => f.floatingOpen && f.questionCards.includes('floating desk'),
    after: f => !f.inboxOpen && f.floatingOpen && f.focusedQuestion && f.focusedIn === 'floating desk',
  },
  'card': {
    before: f => !f.inboxOpen && f.questionCards.includes('canvas card'),
    after: f => !f.inboxOpen && f.focusedQuestion && f.focusedIn === 'canvas card',
  },
  'switchboard': {
    before: f => !f.inboxOpen && f.questionCards.includes('switchboard panel'),
    after: f => !f.inboxOpen && f.focusedQuestion && f.focusedIn === 'switchboard panel',
  },
  'attention': {
    before: f => f.queueSelection === 'ticket:flagged' && f.questionCards.includes('Attention agent desk'),
    after: f => !f.inboxOpen && f.queueSelection === 'ticket:flagged' && f.focusedQuestion
      && f.focusedIn === 'Attention agent desk',
  },
  'attention-pinned': {
    before: f => f.attentionDeskOnTop === false && f.questionCards.includes('Attention agent desk'),
    after: f => !f.inboxOpen && f.attentionDeskOnTop === true && f.focusedQuestion
      && f.focusedIn === 'Attention agent desk',
  },
  'none': {
    before: f => !f.inboxOpen && !f.questionCards.some(p => p === 'desk pin' || p === 'floating desk'
      || p === 'Attention agent desk' || p === 'canvas card' || p === 'switchboard panel'),
    after: f => f.inboxOpen && !['desk pin', 'floating desk', 'Attention agent desk', 'canvas card',
      'switchboard panel'].includes(f.focusedIn),
  },
}

app.commandLine.appendSwitch('mute-audio')
app.disableHardwareAcceleration()
app.on('window-all-closed', () => {})
app.on('web-contents-created', (_e, contents) => { try { contents.setAudioMuted(true) } catch { /* gone */ } })
app.whenReady().then(async () => {
  const denied = []
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => { denied.push(permission); callback(false) })
  session.defaultSession.setPermissionCheckHandler(() => false)
  session.defaultSession.webRequest.onBeforeRequest((details, done) =>
    done({ cancel: !details.url.startsWith('file:') && !details.url.startsWith('data:') }))
  const scenes = []
  let passed = true
  // 1024 x 740 stays within Session 0's 1024 x 768 display
  const win = new BrowserWindow({ width: 1024, height: 740, show: false, useContentSize: true,
    webPreferences: { offscreen: true, backgroundThrottling: false, contextIsolation: true, sandbox: true, nodeIntegration: false } })
  win.webContents.setAudioMuted(true)
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  const consoleErrors = []
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 3) consoleErrors.push(String(message).slice(0, 400)) })
  const js = (code) => win.webContents.executeJavaScript(code)
  const wait = (test, what) => js(`new Promise((resolve,reject)=>{
    const found=()=>{try{return (${test})()}catch{return false}};
    if(found()){resolve(true);return} const observer=new MutationObserver(()=>{if(found()){observer.disconnect();clearTimeout(timer);resolve(true)}});
    observer.observe(document.body,{childList:true,subtree:true,attributes:true,characterData:true});
    const timer=setTimeout(()=>{observer.disconnect();reject(Error('probe missing: '+${JSON.stringify(what)}))},10000);
  })`)
  const settle = async () => {
    await new Promise(resolve => setTimeout(resolve, 300))
    await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(r,120))))')
  }
  const shot = async (name) => fs.writeFileSync(path.join(out, name), (await win.webContents.capturePage()).toPNG())
  const clipboardProbe = `(async()=>{let read='allowed';try{await navigator.clipboard.readText()}catch(e){read='refused: '+e.name}
    let write='allowed';try{await navigator.clipboard.writeText('x')}catch(e){write='refused: '+e.name}
    return {read,write,execPaste:document.execCommand('paste'),execCopy:document.execCommand('copy')}})()`
  try {
    for (const scene of Object.keys(EXPECT)) {
      await session.defaultSession.clearStorageData({ storages: ['localstorage', 'indexdb', 'cachestorage'] })
      await win.loadFile(path.join(out, 'index.html'), { query: { scene } })
      await wait(`()=>window.questionDeskVisual && (document.querySelector('.sq[data-copy-agent-name="asker"]')
        || document.querySelector('.attn-desk'))`, `${scene}: the organization on screen`)
      if (!receipt.renderer_pid) {
        receipt.renderer_pid = win.webContents.getOSProcessId()
        receipt.renderer_session = sessionId(receipt.renderer_pid)
        receipt.clipboard = { permissions: 'every request and check denied', page: await js(clipboardProbe) }
        receipt.muted = win.webContents.isAudioMuted()
      }
      await settle()
      await js('window.questionDeskVisual.arrange()')
      await settle()
      const before = await js('window.questionDeskVisual.facts()')
      await shot(`${scene}-1-before.png`)
      await js('window.questionDeskVisual.click()')
      await new Promise(resolve => setTimeout(resolve, 700))
      await settle()
      const after = await js('window.questionDeskVisual.facts()')
      const marked = await js('window.questionDeskVisual.mark()')
      await settle()
      await shot(`${scene}-2-after.png`)
      const ok = EXPECT[scene].before(before) && EXPECT[scene].after(after)
      passed &&= ok
      scenes.push({ scene, passed: ok, before, after, marked })
    }
    receipt.denied_permissions = denied
    const isolated = receipt.clipboard.page.read.startsWith('refused') && receipt.clipboard.page.write.startsWith('refused')
      && receipt.clipboard.page.execPaste === false && receipt.clipboard.page.execCopy === false && receipt.muted === true
    passed &&= isolated
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ passed, scenes, receipt, consoleErrors: consoleErrors.slice(0, 20) }, null, 2))
    win.destroy(); app.exit(passed ? 0 : 1)
  } catch (error) {
    console.error(error)
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ passed: false, error: String(error?.stack ?? error),
      scenes, receipt, consoleErrors: consoleErrors.slice(0, 20) }, null, 2))
    try { await shot('error.png') } catch { /* no page */ }
    win.destroy(); app.exit(1)
  }
}).catch(error => { console.error(error); app.exit(1) })
