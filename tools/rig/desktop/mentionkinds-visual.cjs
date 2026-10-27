// Mention kind captures (tools/rig/mentionkinds-visual.mjs): in an agent desk, one
// transcript message naming an agent (model badge), a project (folder), a docket
// item, a document, an app and a panel, each wearing its own mark on the left.
// Every visual theme in every contrast gets one PNG; the app chip is hovered once
// per contrast; then one contact sheet holds them all. Refuses outside Session 0;
// SILENT (muted); every permission refused; the page clipboard replaced by a
// refusal; requests other than file:/data: cancelled; input only through CDP to
// this window. Two animation frames and a pause before every capture.
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
  try { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: Object.freeze({ read: deny('read'), readText: deny('readText'), write: deny('write'), writeText: deny('writeText') }) }) } catch { calls.push('stub-failed') }
  const exec = Document.prototype.execCommand
  Document.prototype.execCommand = function (command, ...rest) { if (/^(copy|cut|paste)$/i.test(String(command))) { calls.push('execCommand:' + command); return false } return exec.call(this, command, ...rest) }
  return true })()`
// what each chip of the message shows: its leading element, its colours
const PROBE = `(() => {
  const msg = document.querySelector('[data-fixture="agent-desk"] [data-transcript-row]')
  const box = e => { const r = e.getBoundingClientRect(); return { x: Math.floor(r.x), y: Math.floor(r.y), width: Math.ceil(r.width), height: Math.ceil(r.height) } }
  const chips = [...msg.querySelectorAll('[data-ref-token]')].map(c => { const lead = c.firstElementChild, s = getComputedStyle(c)
    return { token: c.getAttribute('data-ref-token'), text: c.textContent, outcome: c.getAttribute('data-ref-outcome') ?? 'ready',
      lead: lead ? lead.getAttribute('class') : null, leadBox: lead ? [box(lead).width, box(lead).height] : null,
      ink: s.color, underline: s.textDecorationLine, mark: lead ? getComputedStyle(lead).color : null, box: box(c) } })
  return { message: box(msg), chips }
})()`

// a hang reports where it stopped instead of being killed silently
const step = name => console.log(`[mentionkinds] ${new Date().toISOString()} ${name}`)
setTimeout(() => { console.error('[mentionkinds] deadline: no result after 150 s'); app.exit(2) }, 150000).unref()
app.whenReady().then(async () => {
  step('ready')
  const sessionId = Number(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${process.pid}).SessionId`], { encoding: 'utf8', windowsHide: true }).trim())
  if (sessionId !== 0) { console.error(`refusing to run outside Windows Session 0 (this Electron runs in Session ${sessionId})`); app.exit(1); return }
  const permissions = []
  session.defaultSession.setPermissionRequestHandler((_c, p, cb) => { permissions.push(p); cb(false) })
  session.defaultSession.setPermissionCheckHandler((_c, p) => { permissions.push('check:' + p); return false })
  const win = new BrowserWindow({ width: 780, height: 440, show: false, useContentSize: true,
    webPreferences: { offscreen: true, backgroundThrottling: false, contextIsolation: true, sandbox: true, nodeIntegration: false } })
  win.webContents.setAudioMuted(true)
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.session.webRequest.onBeforeRequest((details, done) =>
    done({ cancel: !details.url.startsWith('file:') && !details.url.startsWith('data:') }))
  // a page first: the debugger needs a renderer to answer
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
  const mouse = (x, y) => cdp.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' })
  const pad = r => ({ x: Math.max(0, r.x - 6), y: Math.max(0, r.y - 6), width: r.width + 12, height: r.height + 12 })
  try {
    await win.loadFile(path.join(out, 'index.html'))
    await js(CLIPBOARD)
    step('fixture loaded')
    await wait(`()=>document.querySelector('[data-transcript-row] [data-ref-token="@panel:org/one"]')?.textContent==='Caption board · Panel 1'`, 'the resolved panel chip')
    const { themes, contrasts, labels } = await js('({ themes: window.mentionKindsVisual.themes, contrasts: window.mentionKindsVisual.contrasts, labels: window.mentionKindsVisual.labels })')
    const shots = [], checks = []
    step('chips resolved')
    for (const contrast of contrasts) {
      for (const visual of themes) {
        await mouse(770, 430)
        await js(`window.mentionKindsVisual.apply(${JSON.stringify(visual)}, ${JSON.stringify(contrast)})`)
        await settle()
        const probe = await js(PROBE)
        const image = await win.webContents.capturePage(pad(probe.message))
        const name = `${contrast}-${visual}`
        fs.writeFileSync(path.join(out, name + '.png'), image.toPNG())
        shots.push({ name, label: `${contrast} · ${labels[visual]}`, url: image.toDataURL(), size: image.getSize() })
        checks.push({ contrast, visual, ...probe })
      }
      // the app chip hovered: the link colour and an underline, like an agent name
      await js(`window.mentionKindsVisual.apply('claude', ${JSON.stringify(contrast)})`)
      await settle()
      const before = await js(PROBE), chip = before.chips.find(c => c.token === '@app:org/notes')
      await mouse(chip.box.x + chip.box.width / 2, chip.box.y + chip.box.height / 2)
      await settle()
      const hovered = (await js(PROBE)).chips.find(c => c.token === '@app:org/notes')
      const image = await win.webContents.capturePage(pad(before.message))
      fs.writeFileSync(path.join(out, `${contrast}-claude-hover.png`), image.toPNG())
      checks.push({ contrast, visual: 'claude', hover: { rest: chip, hovered } })
    }
    step(`${shots.length} theme captures`)
    // one contact sheet: every theme, every contrast
    const cell = shots[0].size, columns = 3, rows = Math.ceil(shots.length / columns)
    await win.setContentSize(columns * (cell.width + 16) + 16, rows * (cell.height + 34) + 16)
    await js(`(() => { const shots = ${JSON.stringify(shots.map(({ label, url }) => ({ label, url })))}
      document.body.replaceChildren(); const grid = document.createElement('div')
      grid.style.cssText = 'display:grid;grid-template-columns:repeat(${columns},max-content);gap:12px 16px;padding:8px;background:#777;font:12px sans-serif;color:#fff'
      for (const s of shots) { const fig = document.createElement('figure'); fig.style.margin = '0'
        const cap = document.createElement('figcaption'); cap.textContent = s.label; const img = document.createElement('img'); img.src = s.url
        fig.append(cap, img); grid.append(fig) }
      document.body.append(grid); return true })()`)
    await js('Promise.all([...document.images].map(i => i.decode()))')
    await settle()
    fs.writeFileSync(path.join(out, 'all-kinds-every-theme.png'), (await win.webContents.capturePage()).toPNG())
    const expected = ['tier', 'project-mark', 'ref-mark ref-mark-item', 'ref-mark ref-mark-doc', 'ref-mark ref-mark-app', 'ref-mark ref-mark-panel']
    const themed = checks.filter(c => c.chips)
    const failures = []
    for (const c of themed) {
      const leads = c.chips.map(x => (x.lead ?? '').split(' ').filter(k => k === 'tier' || k === 'project-mark' || k.startsWith('ref-mark')).join(' '))
      if (JSON.stringify(leads) !== JSON.stringify(expected)) failures.push({ theme: `${c.contrast}/${c.visual}`, leads })
      if (!c.chips.every(x => x.outcome === 'ready' && x.leadBox && x.leadBox[0] > 0 && x.leadBox[1] > 0)) failures.push({ theme: `${c.contrast}/${c.visual}`, unresolvedOrEmpty: c.chips })
      // the name reads like an agent's, the mark in the accent like the project's folder
      const agent = c.chips[0], project = c.chips[1]
      for (const x of c.chips.slice(2)) {
        if (x.ink !== agent.ink) failures.push({ theme: `${c.contrast}/${c.visual}`, token: x.token, ink: x.ink, agent: agent.ink })
        if (x.mark !== project.mark) failures.push({ theme: `${c.contrast}/${c.visual}`, token: x.token, mark: x.mark, folder: project.mark })
        if (x.underline !== 'none') failures.push({ theme: `${c.contrast}/${c.visual}`, token: x.token, underline: x.underline })
      }
    }
    for (const c of checks.filter(c => c.hover)) {
      const { rest, hovered } = c.hover
      if (!(hovered && hovered.underline === 'underline' && hovered.ink !== rest.ink)) failures.push({ hover: c.contrast, rest, hovered })
    }
    const marks = new Set(themed.map(c => c.chips.map(x => x.mark)[2]))
    const clipboard = await js('window.__clipboardCalls ?? []')
    const passed = failures.length === 0 && themed.length === themes.length * contrasts.length && marks.size > 1 && clipboard.length === 0
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ passed, sessionId, muted: win.webContents.isAudioMuted(), clipboard, permissions,
      themes, contrasts, accents: [...marks], failures, checks }, null, 2))
    console.log(JSON.stringify({ passed, sessionId, shots: shots.length, failures: failures.length }))
    win.destroy(); app.exit(passed ? 0 : 1)
  } catch (error) { console.error(error); win.destroy(); app.exit(1) }
}).catch(error => { console.error(error); app.exit(1) })
