// Presented screen captures (tools/rig/presentedwidth-visual.mjs): an agent's Presented view filling the window (the
// desk's Presented tab, also the body of the agent's Presented window) and the centred Presented documents window, each
// at the main window's normal size (1400x900, main/index.ts) and maximised on a 1920x1080 screen (1920x1040 above the
// taskbar). The list column is a third of the panel but never wider than 400px, so the presentation gets the rest (USER
// 2026-10-27 mb56fc243d55d), and every HTML card's chip reads "</> HTML" (mbebb35945cb1). Offscreen windows take those
// sizes even though this Session 0 display is smaller. Refuses outside Session 0; SILENT (muted); every permission
// refused; the page clipboard replaced by a refusal; requests other than file:/data: cancelled; no input at all. Two
// animation frames and a pause before every capture; every check reads real layout.
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
app.commandLine.appendSwitch('force-device-scale-factor', '1')
app.commandLine.appendSwitch('mute-audio')
app.on('window-all-closed', () => {})
const CLIPBOARD = `(() => { if (window.__clipboardCalls) return true
  const calls = []; Object.defineProperty(window, '__clipboardCalls', { value: calls })
  const deny = name => () => { calls.push(name); return Promise.reject(new DOMException('Clipboard denied', 'NotAllowedError')) }
  try { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: Object.freeze({ read: deny('read'), readText: deny('readText'), write: deny('write'), writeText: deny('writeText') }) }) } catch { calls.push('clipboard-unpatched') }
  const exec = Document.prototype.execCommand
  Document.prototype.execCommand = function (command, ...rest) { if (/^(copy|cut|paste)$/i.test(String(command))) { calls.push('execCommand:' + command); return false } return exec.call(this, command, ...rest) }
  return true })()`
// the reading surface's columns, the cards and their format chips, with their on-screen boxes
const PROBE = `(() => {
  const box = e => { if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) } }
  const mailer = document.querySelector('.mailer')
  const cards = [...document.querySelectorAll('.mailer-list .doc-gallery-row')]
  return { window: { width: innerWidth, height: innerHeight }, panel: box(document.querySelector('.gallery-modal')),
    mailer: box(mailer), narrow: !!mailer && mailer.classList.contains('narrow-list'),
    list: box(document.querySelector('.mailer-list')), read: box(document.querySelector('.mailer-read')),
    frame: box(document.querySelector('.mailer-read iframe.html-presentation-frame')),
    selected: document.querySelector('.doc-gallery-row.on .mfrom')?.textContent ?? null,
    cards: cards.map(c => ({ title: c.querySelector('.mfrom')?.textContent ?? '', html: c.classList.contains('doc-mockup'),
      chips: [...c.querySelectorAll('.l2 .mockup-format, .l2 .badge')].map(b => ({ text: b.textContent, label: b.getAttribute('aria-label'), box: box(b) })) })) }
})()`
const SIZES = [['normal', 1400, 900], ['maximised', 1920, 1040]]
const VIEWS = [['agent', "an agent's Presented view filling the window"], ['modal', 'the centred Presented documents window']]

const step = name => console.log(`[presentedwidth] ${new Date().toISOString()} ${name}`)
setTimeout(() => { console.error('[presentedwidth] deadline: no result after 150 s'); app.exit(2) }, 150000).unref()
app.whenReady().then(async () => {
  step('ready')
  const sessionId = Number(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${process.pid}).SessionId`], { encoding: 'utf8', windowsHide: true }).trim())
  if (sessionId !== 0) { console.error(`refusing to run outside Windows Session 0 (this Electron runs in Session ${sessionId})`); app.exit(1); return }
  const permissions = []
  session.defaultSession.setPermissionRequestHandler((_c, p, cb) => { permissions.push(p); cb(false) })
  session.defaultSession.setPermissionCheckHandler((_c, p) => { permissions.push('check:' + p); return false })
  const win = new BrowserWindow({ width: 1400, height: 900, show: false, useContentSize: true, enableLargerThanScreen: true,
    webPreferences: { offscreen: true, backgroundThrottling: false, contextIsolation: true, sandbox: true, nodeIntegration: false } })
  win.webContents.setAudioMuted(true)
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  const cancelled = []
  win.webContents.session.webRequest.onBeforeRequest((details, done) => {
    const cancel = !details.url.startsWith('file:') && !details.url.startsWith('data:')
    if (cancel) cancelled.push(details.url.slice(0, 200))
    done({ cancel })
  })
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
    await new Promise(resolve => setTimeout(resolve, 400))
    await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(r,200))))')
  }
  try {
    await win.loadFile(path.join(out, 'index.html'))
    await js(CLIPBOARD)
    step('fixture loaded')
    const shots = [], checks = []
    for (const [view, about] of VIEWS) {
      for (const [size, width, height] of SIZES) {
        await win.setContentSize(width, height)
        await js(`window.presentedWidthVisual.show(${JSON.stringify(view)})`)
        await wait(`()=>document.querySelectorAll('.mailer-list .doc-gallery-row').length===8`, `${view} ${size}: eight cards`)
        await wait(`()=>document.querySelector('.doc-gallery-row.on') && document.querySelector('.mailer-read iframe.html-presentation-frame')`, `${view} ${size}: the dashboard open`)
        await settle()
        const probe = await js(PROBE)
        const image = await win.webContents.capturePage()
        const name = `${view}-${size}`
        fs.writeFileSync(path.join(out, `${name}.png`), image.toPNG())
        // the sheet shows each capture at half size: a 960px-wide copy keeps its page small
        shots.push({ label: `${about} · ${size} ${width}x${height} · list ${probe.list?.width}px, presentation ${probe.read?.width}px`, url: image.resize({ width: 960 }).toDataURL() })
        checks.push({ view, size, width, height, probe })
        step(`${name}: list ${probe.list?.width}px of ${probe.mailer?.width}px, presentation ${probe.read?.width}px`)
      }
    }
    const failures = []
    for (const c of checks) {
      const p = c.probe, where = `${c.view} ${c.size}`
      if (p.window.width !== c.width || p.window.height !== c.height) failures.push({ where, window: p.window })
      if (!p.mailer || !p.list || !p.read || p.narrow) failures.push({ where, layout: { mailer: p.mailer, list: p.list, read: p.read, narrow: p.narrow } })
      else {
        // a third of the panel, never more than 400px (+1 for its border): the presentation takes the rest
        const third = p.mailer.width / 3
        const want = Math.min(third, 401)
        if (p.list.width > 401 || Math.abs(p.list.width - want) > 3) failures.push({ where, list: p.list.width, third, want })
        if (p.read.width < p.mailer.width - p.list.width - 4) failures.push({ where, read: p.read.width, mailer: p.mailer.width })
        if (!(p.frame && p.frame.width > 0 && p.frame.width <= p.read.width)) failures.push({ where, frame: p.frame })
      }
      const html = p.cards.filter(x => x.html)
      if (html.length !== 3 || !html.every(x => x.chips.some(b => b.text === '</> HTML' && b.label === 'HTML presentation' && b.box && b.box.width > 0))) failures.push({ where, html })
      if (p.cards.some(x => x.chips.some(b => /presentation/i.test(b.text ?? '')))) failures.push({ where, chipsWithTheWord: p.cards })
    }
    // the maximised agent view: the presentation gains what the list no longer takes
    const agent = Object.fromEntries(checks.filter(c => c.view === 'agent').map(c => [c.size, c.probe]))
    if (!(agent.maximised?.read && agent.normal?.read && agent.maximised.list.width === agent.normal.list.width
      && agent.maximised.read.width - agent.normal.read.width >= 500)) failures.push({ maximisedGain: { normal: agent.normal?.read, maximised: agent.maximised?.read } })
    const lookups = await js('window.presentedWidthVisual ? window.presentedWidthVisual.lookups() : []').catch(() => [])
    const clipboard = await js('window.__clipboardCalls ?? []')
    const passed = failures.length === 0 && checks.length === 4 && clipboard.length === 0
    const result = { passed, sessionId, muted: win.webContents.isAudioMuted(), clipboard, permissions, cancelled, failures,
      checks: checks.map(c => ({ ...c, before: c.probe.mailer ? { list_third_px: Math.round(c.probe.mailer.width / 3) } : null })), lookups, sheet: null }
    // the verdict is written before the sheet, which only arranges the four PNGs
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2))
    try {
      await Promise.race([(async () => {
        // the sheet: the 960px copies, two to a row, on a page of its own (the
        // Presented window's frame stays mounted in the fixture and stalls a
        // page whose body is replaced under it)
        await win.loadURL('about:blank')
        await win.setContentSize(1960, 1310)
        step('sheet: page')
        await js(`(() => { const shots = ${JSON.stringify(shots)}
          document.body.replaceChildren(); const grid = document.createElement('div')
          grid.style.cssText = 'display:grid;grid-template-columns:repeat(2,max-content);gap:12px 16px;padding:8px;background:#777;font:12px sans-serif;color:#fff'
          for (const s of shots) { const fig = document.createElement('figure'); fig.style.margin = '0'
            const cap = document.createElement('figcaption'); cap.textContent = s.label; const img = document.createElement('img'); img.src = s.url
            fig.append(cap, img); grid.append(fig) }
          document.body.append(grid); return true })()`)
        await js('Promise.all([...document.images].map(i => i.decode()))')
        step('sheet: decoded')
        await settle()
        fs.writeFileSync(path.join(out, 'sheet.png'), (await win.webContents.capturePage()).toPNG())
        step('sheet: captured')
      })(), new Promise((_, reject) => setTimeout(() => reject(Error('the sheet took over 30 s')), 30000))])
      result.sheet = true
    } catch (error) { result.sheet = String(error && error.message || error); console.error('[presentedwidth] sheet:', result.sheet) }
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2))
    console.log(JSON.stringify({ passed, sessionId, shots: shots.length, failures: failures.length, sheet: result.sheet }))
    win.destroy(); app.exit(passed ? 0 : 1)
  } catch (error) { console.error(error); win.destroy(); app.exit(1) }
}).catch(error => { console.error(error); app.exit(1) })
