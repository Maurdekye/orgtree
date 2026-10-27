// Reference flare captures (tools/rig/refflares-visual.mjs): an agent desk whose transcript mentions tickets in six
// statuses and presentations unread, modified since read and read, with an orgtree_work tool row's ticket chip,
// three orgtree_present cards and the desk's presentation badges; beside it a docket description's ticket names, an
// idle-docket card and a Presented list. Every visual theme in every contrast gets one PNG and a probe of each link's
// computed edge, classes and tooltip; the hover text is read once through the shared object tooltip; then one
// contact sheet holds them all. Refuses outside Session 0; SILENT (muted); every permission refused; the page
// clipboard replaced by a refusal; requests other than file:/data: cancelled; input only through CDP to this window.
// Two animation frames and a pause before every capture.
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
// every link and card the item changes: classes, computed edge and colours, tooltip, layout
const PROBE = `(() => {
  const q = (sel, root = document) => [...root.querySelectorAll(sel)]
  const box = e => { const r = e.getBoundingClientRect(); return { x: Math.floor(r.x), y: Math.floor(r.y), width: Math.ceil(r.width), height: Math.ceil(r.height) } }
  const desk = document.querySelector('[data-fixture="agent-desk"]')
  // the first transcript row holds the six ticket and three presentation mentions
  const row1 = desk.querySelector('[data-transcript-row]')
  const look = c => { const s = getComputedStyle(c); return { token: c.getAttribute('data-ref-token') ?? c.getAttribute('data-ref-mention'),
    text: c.textContent, cls: c.className, title: c.getAttribute('title'), shadow: s.boxShadow, border: s.borderTopColor, bg: s.backgroundColor,
    status: s.getPropertyValue('--docket-status-color').trim(), box: box(c) } }
  const mfrom = r => r.querySelector('.l1 .mfrom')
  return {
    tickets: q('.ref-chip.ref-item', row1).map(look),
    docs: q('.ref-chip.ref-doc', row1).map(look),
    tool: q('.tool-ref .ref-chip.ref-item', desk).map(c => ({ ...look(c), name: c.textContent, font: getComputedStyle(c).font,
      markup: c.innerHTML })),
    inline: (c => c && { ...look(c), font: getComputedStyle(c).font, markup: c.innerHTML })(q('.ref-chip.ref-item', row1)[0]),
    cards: q('.presentation-chat-card', desk).map(c => ({ ...look(c), state: c.getAttribute('data-doc-unread') })),
    badges: q('.doc-badge', desk).map(c => ({ ...look(c), state: c.getAttribute('data-doc-unread') })),
    bare: q('[data-fixture="docket-desc"] .docket-ref').map(look),
    idle: q('[data-fixture="idle-card"] .idle-ticket .ref-chip').map(c => ({ ...look(c), tag: c.tagName })),
    gallery: q('[data-fixture="gallery"] .doc-gallery-row').map(r => ({ name: mfrom(r)?.textContent, title: r.getAttribute('title'), cls: r.className,
      dot: mfrom(r) ? getComputedStyle(mfrom(r), '::before').content : null, dotOpacity: mfrom(r) ? getComputedStyle(mfrom(r), '::before').opacity : null,
      dotWidth: mfrom(r) ? parseFloat(getComputedStyle(mfrom(r), '::before').width) : null, box: box(r) })),
    area: box(document.querySelector('#root > *')),
  }
})()`

// a hang reports where it stopped instead of being killed silently
const step = name => console.log(`[refflares] ${new Date().toISOString()} ${name}`)
setTimeout(() => { console.error('[refflares] deadline: no result after 170 s'); app.exit(2) }, 170000).unref()
app.whenReady().then(async () => {
  step('ready')
  const sessionId = Number(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${process.pid}).SessionId`], { encoding: 'utf8', windowsHide: true }).trim())
  if (sessionId !== 0) { console.error(`refusing to run outside Windows Session 0 (this Electron runs in Session ${sessionId})`); app.exit(1); return }
  const permissions = []
  session.defaultSession.setPermissionRequestHandler((_c, p, cb) => { permissions.push(p); cb(false) })
  session.defaultSession.setPermissionCheckHandler((_c, p) => { permissions.push('check:' + p); return false })
  // Session 0's display is 1024 x 768: a larger window is clamped to it
  const win = new BrowserWindow({ width: 1024, height: 670, show: false, useContentSize: true,
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
  try {
    await win.loadFile(path.join(out, 'index.html'))
    await js(CLIPBOARD)
    step('fixture loaded')
    const ROW1 = `document.querySelector('[data-fixture="agent-desk"] [data-transcript-row]')`
    await wait(`()=>${ROW1}.querySelectorAll('.ref-chip.ref-item.ref-flare').length===6`, 'six flared ticket mentions')
    await wait(`()=>${ROW1}.querySelectorAll('.ref-chip.ref-doc.ref-ready').length===3`, 'three presentation mentions')
    await wait(`()=>document.querySelector('[data-fixture="agent-desk"] .tool-ref .ref-chip.ref-item')?.textContent==='Build the docs site from main'`, 'the titled tool-call ticket link')
    await wait(`()=>document.querySelectorAll('[data-fixture="agent-desk"] .presentation-chat-card[data-doc-unread]').length===2`, 'two highlighted tool-row cards')
    await wait(`()=>document.querySelectorAll('[data-fixture="gallery"] .doc-gallery-row').length===4`, 'the Presented list')
    const { themes, contrasts, labels } = await js('({ themes: window.refFlaresVisual.themes, contrasts: window.refFlaresVisual.contrasts, labels: window.refFlaresVisual.labels })')
    const shots = [], checks = []
    step('surfaces resolved')
    for (const contrast of contrasts) {
      for (const visual of themes) {
        await mouse(1020, 665)
        await js(`window.refFlaresVisual.apply(${JSON.stringify(visual)}, ${JSON.stringify(contrast)})`)
        await settle()
        const probe = await js(PROBE)
        const image = await win.webContents.capturePage({ x: 0, y: 0, width: probe.area.width + 16, height: probe.area.height + 16 })
        const name = `${contrast}-${visual}`
        fs.writeFileSync(path.join(out, name + '.png'), image.toPNG())
        shots.push({ name, label: `${contrast} · ${labels[visual]}`, url: image.resize({ width: Math.round(image.getSize().width * 0.45) }).toDataURL(), size: image.getSize() })
        checks.push({ contrast, visual, ...probe })
      }
    }
    step(`${shots.length} theme captures`)
    // the shared hover, read fresh on pointer-over, in one theme: it leads with the state
    await js(`window.refFlaresVisual.apply('claude', 'charcoal')`)
    await settle()
    const hovers = {}
    const base = await js(PROBE)
    for (const [key, target] of [['ticket', base.tickets[0]], ['unread', base.docs[0]], ['modified', base.docs[1]], ['read', base.docs[2]],
      ['tool', base.tool[0]], ['card', base.cards[1]]]) {
      await mouse(target.box.x + Math.min(12, target.box.width / 2), target.box.y + target.box.height / 2)
      await new Promise(resolve => setTimeout(resolve, 350))
      hovers[key] = await js(`(document.elementFromPoint(${target.box.x + Math.min(12, target.box.width / 2)}, ${target.box.y + target.box.height / 2})?.closest('[data-object-tooltip-kind]')?.getAttribute('title')) ?? null`)
      await mouse(1020, 665)
      await new Promise(resolve => setTimeout(resolve, 80))
    }
    // one contact sheet: every theme, every contrast
    const cell = { width: Math.round(shots[0].size.width * 0.45), height: Math.round(shots[0].size.height * 0.45) }, columns = 4, rows = Math.ceil(shots.length / columns)
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
    fs.writeFileSync(path.join(out, 'all-themes.png'), (await win.webContents.capturePage()).toPNG())
    // what every theme must show
    const STATUS = ['in_progress', 'blocked', 'review', 'open', 'backlogged', 'done']
    const failures = []
    const fail = (c, what, detail) => failures.push({ theme: `${c.contrast}/${c.visual}`, what, detail })
    const laidOut = x => x && x.box && x.box.width > 0 && x.box.height > 0
    for (const c of checks) {
      if (c.tickets.length !== 6) fail(c, 'six ticket mentions', c.tickets.length)
      c.tickets.forEach((x, i) => {
        if (!x.cls.split(' ').includes('ref-flare') || !x.cls.split(' ').includes('status-' + STATUS[i])) fail(c, 'ticket flare class', x)
        if (!/3px/.test(x.shadow) || !x.status || !laidOut(x)) fail(c, 'ticket edge drawn and laid out', x)
        if (!x.title || !x.title.endsWith(' · ' + x.text)) fail(c, 'ticket tooltip names the status, then the title', x)
      })
      if (new Set(c.tickets.map(x => x.shadow)).size !== 6) fail(c, 'six statuses, six edge colours', c.tickets.map(x => x.shadow))
      const [unread, modified, read] = c.docs
      if (!unread?.cls.includes('ref-flare doc-new') || !modified?.cls.includes('ref-flare doc-updated') || read?.cls.includes('ref-flare')) fail(c, 'presentation flares', c.docs)
      if (!unread || !modified || !read || unread.shadow === modified.shadow || read.shadow !== 'none' || !/3px/.test(unread.shadow)) fail(c, 'presentation edges: accent, duller, none', c.docs.map(x => x.shadow))
      if (unread?.title !== 'Unread · Launch plan' || modified?.title !== 'Modified since you last read it · Release notes' || read?.title !== 'Old notes') fail(c, 'presentation tooltips', c.docs.map(x => x.title))
      const tool = c.tool[0]
      if (!tool || tool.name !== 'Build the docs site from main' || !tool.cls.includes('status-in_progress') || !/3px/.test(tool.shadow) || !laidOut(tool)) fail(c, 'tool-call ticket link', tool)
      // the same link an inline mention of the same ticket is (USER m0baa7d0b5a61, mffa2a51ed1b1)
      if (!tool || !c.inline || tool.cls !== c.inline.cls || tool.markup !== c.inline.markup || tool.shadow !== c.inline.shadow
        || tool.title !== c.inline.title || /desk-nav-chip/.test(tool.cls)) fail(c, 'tool-call link is the inline mention link', { tool, inline: c.inline })
      if (JSON.stringify(c.cards.map(x => x.state)) !== JSON.stringify(['new', 'updated', null]) || c.cards[0]?.border === c.cards[2]?.border
        || c.cards[0]?.shadow === 'none' || c.cards[2]?.shadow !== 'none' || !c.cards.every(laidOut)) fail(c, 'tool-row presentation cards', c.cards)
      if (JSON.stringify(c.badges.map(x => x.state).sort()) !== JSON.stringify(['new', 'updated', null].sort())) fail(c, 'desk badges', c.badges.map(x => x.state))
      if (c.bare.length !== 3 || !c.bare.every(x => x.cls.includes('ref-flare') && laidOut(x))) fail(c, 'docket names flare', c.bare)
      if (c.idle[0]?.text !== 'Fix the login redirect' || !laidOut(c.idle[0]) || !c.idle[0].cls.includes('ref-flare status-blocked')
        || c.idle[0].tag !== 'BUTTON') fail(c, 'reminder card links by the mention link, with its flare', c.idle)
      const row = name => c.gallery.find(r => r.name === name)
      if (row('New budget')?.dot === 'none' || row('Updated metrics')?.dot === 'none' || row('Read summary')?.dot !== 'none'
        || Number(row('Updated metrics')?.dotOpacity) >= Number(row('New budget')?.dotOpacity)
        || !(row('New budget')?.dotWidth >= 5) || !(row('Updated metrics')?.dotWidth >= 5)) fail(c, 'Presented dots: full, duller, none, never squeezed', c.gallery)
      if (row('New budget')?.title !== 'Unread · New budget' || row('Updated metrics')?.title !== 'Modified since you last read it · Updated metrics') fail(c, 'Presented row tooltips', c.gallery.map(r => r.title))
    }
    const expectedHovers = { ticket: 'In progress · Build the docs site from main', unread: 'Unread · Launch plan',
      modified: 'Modified since you last read it · Release notes', read: 'Old notes', tool: 'In progress · Build the docs site from main',
      card: 'Modified since you last read it · Release notes' }
    for (const [key, want] of Object.entries(expectedHovers)) if (hovers[key] !== want) failures.push({ hover: key, got: hovers[key], want })
    const accents = new Set(checks.map(c => c.docs[0]?.shadow))
    const clipboard = await js('window.__clipboardCalls ?? []')
    const passed = failures.length === 0 && checks.length === themes.length * contrasts.length && accents.size > 1 && clipboard.length === 0
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ passed, sessionId, muted: win.webContents.isAudioMuted(), clipboard, permissions,
      themes, contrasts, hovers, accents: [...accents], failures, checks }, null, 2))
    console.log(JSON.stringify({ passed, sessionId, shots: shots.length, failures: failures.length, hovers }))
    win.destroy(); app.exit(passed ? 0 : 1)
  } catch (error) {
    console.error(error)
    // what was on screen when it stopped, for the next attempt
    try { fs.writeFileSync(path.join(out, 'failure-dom.html'), await js('document.body.outerHTML')) } catch { /* the page is gone */ }
    win.destroy(); app.exit(1)
  }
}).catch(error => { console.error(error); app.exit(1) })
