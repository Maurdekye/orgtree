// Presentation slug captures (tools/rig/presentationslugs-visual.mjs): in an agent desk, a transcript message
// mentioning a presentation by its slug and another by its old generic id, both shown by the presentation's
// title; then the desk composer completing "@weekly", whose @ list offers presentations by title with the document
// icon, and Tab inserting @doc:<org>/<slug>. Two visual themes, one contact sheet. Refuses outside Session 0;
// SILENT (muted); every permission refused; the page clipboard replaced by a refusal; requests other than
// file:/data: cancelled; input only through the page's own events in this window. Two animation frames and a
// pause before every capture; every on-screen check reads real layout.
const { app, BrowserWindow, session } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const out = process.argv[process.argv.indexOf('--probe-out') + 1]
if (!out || !path.isAbsolute(out)) throw new Error('--probe-out needs an absolute artifact folder')
for (const key of ['userData', 'sessionData', 'logs', 'crashDumps']) {
  const folder = path.join(out, key); fs.mkdirSync(folder, { recursive: true }); app.setPath(key, folder)
}
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('mute-audio')
app.on('window-all-closed', () => {})
const CLIPBOARD = `(() => { if (window.__clipboardCalls) return true
  const calls = []; Object.defineProperty(window, '__clipboardCalls', { value: calls })
  const deny = name => () => { calls.push(name); return Promise.reject(new DOMException('Clipboard denied', 'NotAllowedError')) }
  try { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: Object.freeze({ read: deny('read'), readText: deny('readText'), write: deny('write'), writeText: deny('writeText') }) }) } catch { calls.push('clipboard-unpatched') }
  const exec = Document.prototype.execCommand
  Document.prototype.execCommand = function (command, ...rest) { if (/^(copy|cut|paste)$/i.test(String(command))) { calls.push('execCommand:' + command); return false } return exec.call(this, command, ...rest) }
  return true })()`
// the message's presentation chips and the open @ list, with their on-screen boxes
const PROBE = `(() => {
  const box = e => { const r = e.getBoundingClientRect(); return { x: Math.floor(r.x), y: Math.floor(r.y), width: Math.ceil(r.width), height: Math.ceil(r.height) } }
  const msg = document.querySelector('[data-fixture="agent-desk"] [data-transcript-row]')
  const chips = msg ? [...msg.querySelectorAll('[data-ref-token^="@doc:"]')].map(c => ({ token: c.getAttribute('data-ref-token'),
    text: c.textContent, live: c.tagName === 'BUTTON', mark: c.firstElementChild ? c.firstElementChild.getAttribute('class') : null, box: box(c) })) : []
  const composer = document.querySelector('[data-fixture="agent-desk"] textarea[data-first-use-chat]')
  const menu = document.querySelector('.agent-mentions')
  const rows = menu ? [...menu.querySelectorAll('.agent-mention-item')].map(r => ({ kind: r.classList.contains('mention-presentation') ? 'presentation' : 'other',
    name: r.querySelector('.agent-mention-name')?.textContent ?? '', icon: !!r.querySelector('.mention-presentation-mark svg'),
    active: r.classList.contains('active'), label: r.getAttribute('aria-label'), box: box(r) })) : []
  return { message: msg ? box(msg) : null, chips, composer: composer ? { value: composer.value, box: box(composer) } : null,
    menu: menu ? box(menu) : null, rows }
})()`

const step = name => console.log(`[presentationslugs] ${new Date().toISOString()} ${name}`)
setTimeout(() => { console.error('[presentationslugs] deadline: no result after 150 s'); app.exit(2) }, 150000).unref()
app.whenReady().then(async () => {
  step('ready')
  const sessionId = Number(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${process.pid}).SessionId`], { encoding: 'utf8', windowsHide: true }).trim())
  if (sessionId !== 0) { console.error(`refusing to run outside Windows Session 0 (this Electron runs in Session ${sessionId})`); app.exit(1); return }
  const permissions = []
  session.defaultSession.setPermissionRequestHandler((_c, p, cb) => { permissions.push(p); cb(false) })
  session.defaultSession.setPermissionCheckHandler((_c, p) => { permissions.push('check:' + p); return false })
  const win = new BrowserWindow({ width: 780, height: 500, show: false, useContentSize: true,
    webPreferences: { offscreen: true, backgroundThrottling: false, contextIsolation: true, sandbox: true, nodeIntegration: false } })
  win.webContents.setAudioMuted(true)
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.session.webRequest.onBeforeRequest((details, done) =>
    done({ cancel: !details.url.startsWith('file:') && !details.url.startsWith('data:') }))
  await win.loadURL('about:blank')
  const cdp = win.webContents.debugger
  cdp.attach('1.3')
  await cdp.sendCommand('Page.enable')
  await cdp.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: CLIPBOARD })
  step(`session ${sessionId}, debugger attached`)
  const js = (code) => win.webContents.executeJavaScript(code)
  const wait = (test, what) => js(`new Promise((resolve,reject)=>{
    const found=()=>{try{return (${test})()}catch{return false}};
    if(found()){resolve(true);return} const observer=new MutationObserver(()=>{if(found()){observer.disconnect();clearTimeout(timer);resolve(true)}});
    observer.observe(document.body,{childList:true,subtree:true,attributes:true,characterData:true});
    const timer=setTimeout(()=>{observer.disconnect();reject(Error('probe missing: '+${JSON.stringify(what)}))},10000);
  })`)
  const settle = async () => {
    await new Promise(resolve => setTimeout(resolve, 200))
    await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(r,120))))')
  }
  const around = rects => {
    const xs = rects.filter(Boolean)
    const x = Math.max(0, Math.min(...xs.map(r => r.x)) - 8), y = Math.max(0, Math.min(...xs.map(r => r.y)) - 8)
    return { x, y, width: Math.max(...xs.map(r => r.x + r.width)) - x + 8, height: Math.max(...xs.map(r => r.y + r.height)) - y + 8 }
  }
  try {
    await win.loadFile(path.join(out, 'index.html'))
    await js(CLIPBOARD)
    step('fixture loaded')
    await wait(`()=>document.querySelector('[data-transcript-row] [data-ref-token="@doc:org/d00000000c001"]')?.textContent?.includes('Weekly status, week 43')`, 'the old-id chip by title')
    const { themes, labels } = await js('({ themes: window.presentationSlugsVisual.themes, labels: window.presentationSlugsVisual.labels })')
    const shots = [], checks = []
    for (const visual of themes) {
      await js(`window.presentationSlugsVisual.apply(${JSON.stringify(visual)})`)
      await js(`window.presentationSlugsVisual.type('')`)
      await settle()
      const chips = await js(PROBE)
      let image = await win.webContents.capturePage(around([chips.message]))
      fs.writeFileSync(path.join(out, `${visual}-chips.png`), image.toPNG())
      shots.push({ label: `${labels[visual]} · mentions by title`, url: image.toDataURL() })
      await js(`window.presentationSlugsVisual.type('Compare with @weekly')`)
      await wait(`()=>document.querySelectorAll('.agent-mentions .mention-presentation').length===2`, 'two presentation rows')
      await settle()
      const menu = await js(PROBE)
      image = await win.webContents.capturePage(around([menu.menu, menu.composer && menu.composer.box]))
      fs.writeFileSync(path.join(out, `${visual}-menu.png`), image.toPNG())
      shots.push({ label: `${labels[visual]} · @weekly`, url: image.toDataURL() })
      await js(`window.presentationSlugsVisual.press('Tab')`)
      await settle()
      // the completion lands with the next render, not inside the key event
      const completed = await js(`document.querySelector('[data-fixture="agent-desk"] textarea[data-first-use-chat]').value`)
      checks.push({ visual, chips: chips.chips, menu: menu.menu, rows: menu.rows, composer: menu.composer, completed })
    }
    step(`${shots.length} captures`)
    // one column: a chips shot is nearly as wide as the window
    await win.setContentSize(800, 760)
    await js(`(() => { const shots = ${JSON.stringify(shots)}
      document.body.replaceChildren(); const grid = document.createElement('div')
      grid.style.cssText = 'display:grid;grid-template-columns:max-content;gap:12px 16px;padding:8px;background:#777;font:12px sans-serif;color:#fff'
      for (const s of shots) { const fig = document.createElement('figure'); fig.style.margin = '0'
        const cap = document.createElement('figcaption'); cap.textContent = s.label; const img = document.createElement('img'); img.src = s.url
        fig.append(cap, img); grid.append(fig) }
      document.body.append(grid); return true })()`)
    await js('Promise.all([...document.images].map(i => i.decode()))')
    await settle()
    fs.writeFileSync(path.join(out, 'sheet.png'), (await win.webContents.capturePage()).toPNG())
    const failures = []
    for (const c of checks) {
      const titles = c.chips.map(x => [x.token, x.text, x.live])
      if (JSON.stringify(titles) !== JSON.stringify([['@doc:org/launch-plan', 'Launch plan for the 4.5.0 release', true],
        ['@doc:org/d00000000c001', 'Weekly status, week 43', true]])) failures.push({ visual: c.visual, chips: titles })
      if (!c.chips.every(x => x.box.width > 0 && x.box.height > 0 && (x.mark ?? '').includes('ref-mark-doc'))) failures.push({ visual: c.visual, chipLayout: c.chips })
      const rows = c.rows.filter(r => r.kind === 'presentation')
      if (JSON.stringify(rows.map(r => r.name)) !== JSON.stringify(['Weekly status, week 43', 'Weekly status, week 44'])) failures.push({ visual: c.visual, rows: c.rows })
      if (!rows.every(r => r.icon && r.box.width > 0 && r.box.height > 0)) failures.push({ visual: c.visual, rowLayout: rows })
      // on screen: the list sits above the composer, inside the window, not at a corner
      if (!(c.menu && c.composer && c.menu.width > 0 && c.menu.y + c.menu.height <= c.composer.box.y + 2 && c.menu.y >= 0
        && Math.abs(c.menu.x - c.composer.box.x) < 40)) failures.push({ visual: c.visual, menu: c.menu, composer: c.composer })
      if (c.completed !== 'Compare with @doc:org/weekly-status-2 ') failures.push({ visual: c.visual, completed: c.completed })
    }
    const lookups = await js('window.presentationSlugsVisual ? window.presentationSlugsVisual.lookups() : []').catch(() => [])
    const clipboard = await js('window.__clipboardCalls ?? []')
    const passed = failures.length === 0 && checks.length === themes.length && clipboard.length === 0
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ passed, sessionId, muted: win.webContents.isAudioMuted(), clipboard, permissions,
      themes, failures, checks, lookups }, null, 2))
    console.log(JSON.stringify({ passed, sessionId, shots: shots.length, failures: failures.length }))
    win.destroy(); app.exit(passed ? 0 : 1)
  } catch (error) { console.error(error); win.destroy(); app.exit(1) }
}).catch(error => { console.error(error); app.exit(1) })
