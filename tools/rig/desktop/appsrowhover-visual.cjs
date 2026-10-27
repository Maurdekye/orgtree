// Apps list + and gear hover (tools/rig/appsrowhover-visual.mjs): the app's Apps button and list with two apps, each
// with one panel. The list is opened by a CDP click; then in every visual theme and every contrast the pointer rests
// away, on the first app row, on its + (new panel), on its gear (app settings) and on its panel's gear (panel
// settings), and Tab moves keyboard focus onto +. Each state is read from the painted screenshot (the button's
// padding next to the row or menu behind it) and from the computed styles. A hovered button must stand out from what
// it sits on by at least the app's own hover step in that theme (a hovered row against the menu). One crop per state
// and theme, and contact sheets. The page is served from this process on loopback, only the build's own files.
// Refuses outside Session 0; SILENT (muted); every permission refused; the page clipboard replaced by a refusal;
// requests other than that loopback origin and data: cancelled; input only through CDP to this window.
const { app, BrowserWindow, session } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const http = require('node:http')
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

// WCAG relative luminance and contrast ratio of two [r, g, b]
const lum = ([r, g, b]) => [r, g, b].map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 })
  .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0)
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return Math.round(((x + 0.05) / (y + 0.05)) * 1000) / 1000 }
const same = (a, b, tolerance = 3) => a.every((v, i) => Math.abs(v - b[i]) <= tolerance)
const hex = c => '#' + c.slice(0, 3).map(v => v.toString(16).padStart(2, '0')).join('')

const step = name => console.log(`[appsrowhover] ${new Date().toISOString()} ${name}`)
setTimeout(() => { console.error('[appsrowhover] deadline: no result after 240 s'); app.exit(2) }, 240000).unref()
app.whenReady().then(async () => {
  step('ready')
  const sessionId = Number(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${process.pid}).SessionId`], { encoding: 'utf8', windowsHide: true }).trim())
  if (sessionId !== 0) { console.error(`refusing to run outside Windows Session 0 (this Electron runs in Session ${sessionId})`); app.exit(1); return }
  const permissions = []
  session.defaultSession.setPermissionRequestHandler((_c, p, cb) => { permissions.push(p); cb(false) })
  session.defaultSession.setPermissionCheckHandler((_c, p) => { permissions.push('check:' + p); return false })
  // Session 0's display is 1024 x 768: a larger window is clamped to it
  const win = new BrowserWindow({ width: 1000, height: 700, show: false, useContentSize: true,
    webPreferences: { offscreen: true, backgroundThrottling: false, contextIsolation: true, sandbox: true, nodeIntegration: false } })
  win.webContents.setAudioMuted(true)
  win.webContents.setFrameRate(60)
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  const consoleLines = []
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 2) consoleLines.push(message.slice(0, 400)) })
  // the build's own files, by name, on loopback only
  const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.png': 'image/png', '.svg': 'image/svg+xml' }
  const server = http.createServer((req, res) => {
    const name = decodeURIComponent((req.url || '/').split('?')[0]).split('/').filter(Boolean).pop() || 'index.html'
    const file = path.join(out, name)
    if (path.basename(name) !== name || !TYPES[path.extname(name)] || !fs.existsSync(file)) { res.writeHead(404); res.end(); return }
    res.writeHead(200, { 'content-type': TYPES[path.extname(name)] }); res.end(fs.readFileSync(file))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}/`
  win.webContents.session.webRequest.onBeforeRequest((details, done) =>
    done({ cancel: !details.url.startsWith(origin) && !details.url.startsWith('data:') && details.url !== 'about:blank' }))
  await win.loadURL('about:blank')
  const cdp = win.webContents.debugger
  cdp.attach('1.3')
  await cdp.sendCommand('Page.enable')
  await cdp.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: CLIPBOARD })
  // a hidden offscreen window never has OS focus, and an unfocused page matches no :focus; the page is told it has
  // focus, with no OS input
  await cdp.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
  step(`session ${sessionId}, debugger attached`)
  const js = (code) => win.webContents.executeJavaScript(code)
  const frames = n => js(`new Promise(r=>{let i=0;const f=()=>{if(++i>=${n})r(true);else requestAnimationFrame(f)};requestAnimationFrame(f)})`)
  const settle = async () => { await frames(2); await js('window.appsRowHover.settled()'); await frames(2) }
  const mouse = (type, x, y) => cdp.sendCommand('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : 'left',
    buttons: type === 'mousePressed' ? 1 : 0, clickCount: type === 'mouseMoved' ? 0 : 1 })
  const key = async (code, keyCode) => { for (const type of ['keyDown', 'keyUp']) await cdp.sendCommand('Input.dispatchKeyEvent', { type, key: code, code, windowsVirtualKeyCode: keyCode }) }
  const center = b => ({ x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) })
  const AWAY = { x: 900, y: 620 }
  try {
    await win.loadURL(origin + 'index.html')
    await js(CLIPBOARD)
    await js(`new Promise((resolve,reject)=>{const t=Date.now();const f=()=>{if(document.querySelector('.apps-button'))resolve(true);else if(Date.now()-t>10000)reject(Error('no Apps button'));else setTimeout(f,50)};f()})`)
    await frames(4)
    // open the list as a hand does: a click on the Apps button
    const appsButton = await js(`(()=>{const r=document.querySelector('.apps-button').getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height}})()`)
    const at = center(appsButton)
    await mouse('mouseMoved', at.x, at.y); await mouse('mousePressed', at.x, at.y); await mouse('mouseReleased', at.x, at.y)
    await js(`new Promise((resolve,reject)=>{const t=Date.now();const f=()=>{if(window.appsRowHover.ready())resolve(true);else if(Date.now()-t>10000)reject(Error('the Apps list did not open'));else setTimeout(f,50)};f()})`)
    await mouse('mouseMoved', AWAY.x, AWAY.y)
    await settle()
    step('Apps list open')
    const { themes, contrasts, labels } = await js('({ themes: window.appsRowHover.themes, contrasts: window.appsRowHover.contrasts, labels: window.appsRowHover.labels })')
    // the screenshot's byte order, from the red swatch
    let BGRA = false
    // one copy of a screenshot's pixels, read many times
    const read = image => { const size = image.getSize(); return { size, bitmap: image.toBitmap(), scale: size.width / win.getContentSize()[0] } }
    const pixel = ({ size, bitmap, scale }, x, y) => {
      const i = (Math.round(y * scale) * size.width + Math.round(x * scale)) * 4
      return BGRA ? [bitmap[i + 2], bitmap[i + 1], bitmap[i], bitmap[i + 3]] : [bitmap[i], bitmap[i + 1], bitmap[i + 2], bitmap[i + 3]]
    }
    {
      const image = await win.webContents.capturePage(), size = image.getSize(), bitmap = image.toBitmap(), scale = size.width / win.getContentSize()[0]
      const i = (Math.round((win.getContentSize()[1] - 3) * scale) * size.width + Math.round(3 * scale)) * 4
      if (bitmap[i + 2] >= 250 && bitmap[i] <= 5) BGRA = true
      else if (!(bitmap[i] >= 250 && bitmap[i + 2] <= 5)) throw new Error(`the red swatch reads ${[...bitmap.subarray(i, i + 4)]}`)
    }
    const STATES = ['rest', 'row', 'plus', 'gear', 'panelGear', 'focus']
    const shots = [], checks = []
    for (const contrast of contrasts) {
      for (const visual of themes) {
        await mouse('mouseMoved', AWAY.x, AWAY.y)
        await js(`document.activeElement?.blur?.(); window.appsRowHover.apply(${JSON.stringify(visual)}, ${JSON.stringify(contrast)}); true`)
        await settle()
        const layout = await js('window.appsRowHover.probe()')
        const states = {}
        for (const state of STATES) {
          if (state === 'focus') {
            await mouse('mouseMoved', AWAY.x, AWAY.y)
            await js('window.appsRowHover.focusBeforePlus()')
            await key('Tab', 9)
          } else {
            await js('document.activeElement?.blur?.(); true')
            const target = state === 'rest' ? AWAY : state === 'row' ? center(layout.name) : center(layout[state].box)
            await mouse('mouseMoved', target.x, target.y)
          }
          await settle()
          const probe = await js('window.appsRowHover.probe()')
          const image = await win.webContents.capturePage(), shot = read(image)
          const mid = b => b.y + b.height / 2
          // painted: each button's left padding, the row between + and gear, and the panel row just left of its gear
          const painted = {
            plus: pixel(shot, probe.plus.box.x + 2.5, mid(probe.plus.box)),
            plusRight: pixel(shot, probe.plus.box.x + probe.plus.box.width - 2.5, mid(probe.plus.box)),
            gear: pixel(shot, probe.gear.box.x + 2.5, mid(probe.gear.box)),
            panelGear: pixel(shot, probe.panelGear.box.x + 2.5, mid(probe.panelGear.box)),
            row: pixel(shot, (probe.plus.box.x + probe.plus.box.width + probe.gear.box.x) / 2, mid(probe.plus.box)),
            behindPanelGear: pixel(shot, probe.panelGear.box.x - 3, mid(probe.panelGear.box)),
            menu: pixel(shot, probe.menu.x + 4, probe.menu.y + probe.menu.height / 2),
            // an outline is painted on whole pixels: its first column is the box's rounded left edge
            plusRing: pixel(shot, probe.plus.box.x, mid(probe.plus.box)),
          }
          const left = Math.floor(Math.min(probe.plus.box.x, probe.panelGear.box.x) - 70), top = Math.floor(probe.row.y - 4)
          const crop = { x: left, y: top, width: Math.min(140, Math.ceil(probe.menu.x + probe.menu.width + 2 - left)), height: Math.ceil(probe.panelRow.y + probe.panelRow.height + 4 - top) }
          const cropped = image.crop(crop)
          const name = `${contrast}-${visual}-${state}`
          fs.writeFileSync(path.join(out, name + '.png'), cropped.toPNG())
          shots.push({ name, contrast, visual, state, url: cropped.toDataURL(), size: cropped.getSize() })
          states[state] = { painted, active: await js('window.appsRowHover.activeLabel()'), hover: { row: probe.rowHover, plus: probe.plus.hover, gear: probe.gear.hover, panelGear: probe.panelGear.hover },
            computed: { row: probe.rowBackground, plus: probe.plus.background, gear: probe.gear.background, panelGear: probe.panelGear.background,
              plusColor: probe.plus.color, plusOutline: probe.plus.outline, focusVisible: probe.plus.focusVisible }, titles: { plus: probe.plus.title, gear: probe.gear.title, panelGear: probe.panelGear.title } }
        }
        checks.push({ contrast, visual, accent: layout.accent, boxes: { plus: layout.plus.box, gear: layout.gear.box, panelGear: layout.panelGear.box }, states })
      }
    }
    step(`${checks.length} themes x ${STATES.length} states read`)
    // what every theme must show
    const failures = []
    const fail = (c, what, detail) => failures.push({ theme: `${c.contrast}/${c.visual}`, what, detail })
    const summary = []
    for (const c of checks) {
      const s = c.states, P = st => s[st].painted
      // the app's own hover step in this theme: a hovered row against the menu
      const appStep = ratio(P('row').row, P('row').menu)
      const lift = { plus: ratio(P('plus').plus, P('plus').row), gear: ratio(P('gear').gear, P('gear').row), panelGear: ratio(P('panelGear').panelGear, P('panelGear').behindPanelGear) }
      summary.push({ theme: `${c.contrast}/${c.visual}`, appStep, lift, rowFill: hex(P('row').row), plusFill: hex(P('plus').plus), gearFill: hex(P('gear').gear),
        panelGearFill: hex(P('panelGear').panelGear), menu: hex(P('rest').menu), ring: hex(P('focus').plusRing), accent: hex(c.accent) })
      if (!(appStep > 1.02)) fail(c, 'a hovered row stands out from the menu (the reference step)', appStep)
      for (const b of ['plus', 'gear', 'panelGear']) {
        if (!s[b].hover[b]) fail(c, `${b} is hovered when the pointer is on it`, s[b].hover)
        if (!(lift[b] >= appStep - 0.005)) fail(c, `${b} hovered stands out from what it sits on at least as much as the app's hover step`, { lift: lift[b], appStep })
      }
      if (!same(P('plus').plus, P('plus').plusRight)) fail(c, '+ is filled evenly', [P('plus').plus, P('plus').plusRight])
      // at rest and with only the row hovered the buttons show no fill of their own
      for (const [st, under] of [['rest', 'row'], ['row', 'row']]) for (const b of ['plus', 'gear'])
        if (!same(P(st)[b], P(st)[under])) fail(c, `${b} has no fill of its own (${st})`, { button: P(st)[b], row: P(st)[under] })
      if (!same(P('rest').panelGear, P('rest').behindPanelGear)) fail(c, 'the panel gear has no fill at rest', P('rest'))
      // keyboard focus on + lights it as hover does, inside the app's own button focus ring
      if (s.focus.active !== 'New panel for Caption placement' || !s.focus.computed.focusVisible) fail(c, 'Tab puts keyboard focus on +', s.focus.active)
      if (!same(P('focus').plus, P('plus').plus)) fail(c, 'keyboard focus on + shows the hover fill', { focus: P('focus').plus, hover: P('plus').plus })
      if (!s.focus.computed.plusOutline || !same(P('focus').plusRing, s.focus.computed.plusOutline.color, 12)) fail(c, 'keyboard focus on + shows the focus ring', { outline: s.focus.computed.plusOutline, ring: P('focus').plusRing })
      if (s.plus.titles.plus !== 'New panel' || s.gear.titles.gear !== 'App settings: Caption placement' || s.panelGear.titles.panelGear !== 'Panel settings: Lower third') fail(c, 'tooltips stay', s.plus.titles)
      if (Math.round(c.boxes.plus.width) !== Math.round(c.boxes.gear.width) || Math.round(c.boxes.plus.height) !== Math.round(c.boxes.gear.height)) fail(c, '+ and the app gear are the same size, so their fills match', c.boxes)
    }
    fs.writeFileSync(path.join(out, 'checks.json'), JSON.stringify(checks, null, 2))
    // contact sheets: every contrast x every state (first theme); every theme with + hovered; every theme with + focused
    const sheet = async (file, cells, columns) => {
      const cell = cells[0].size, rows = Math.ceil(cells.length / columns)
      await win.setContentSize(Math.min(1000, columns * (cell.width + 14) + 16), Math.min(740, rows * (cell.height + 30) + 16))
      await js(`(() => { const shots = ${JSON.stringify(cells.map(({ label, url }) => ({ label, url })))}
        document.body.replaceChildren(); const grid = document.createElement('div')
        grid.style.cssText = 'display:grid;grid-template-columns:repeat(${columns},max-content);gap:10px 14px;padding:8px;background:#777;font:11px sans-serif;color:#fff'
        for (const s of shots) { const fig = document.createElement('figure'); fig.style.margin = '0'
          const cap = document.createElement('figcaption'); cap.textContent = s.label; const img = document.createElement('img'); img.src = s.url
          fig.append(cap, img); grid.append(fig) }
        document.body.append(grid); return true })()`)
      await js('Promise.all([...document.images].map(i => i.decode()))')
      await frames(3)
      fs.writeFileSync(path.join(out, file), (await win.webContents.capturePage()).toPNG())
    }
    const first = themes[0]
    const pick = (fn, label) => shots.filter(fn).map(s => ({ ...s, label: label(s) }))
    await sheet('states.png', pick(s => s.visual === first, s => `${s.contrast} · ${s.state}`), STATES.length)
    await sheet('all-themes-plus-hover.png', pick(s => s.state === 'plus', s => `${s.contrast} · ${labels[s.visual]}`), contrasts.length)
    await sheet('all-themes-plus-focus.png', pick(s => s.state === 'focus', s => `${s.contrast} · ${labels[s.visual]}`), contrasts.length)
    const clipboard = await js('window.__clipboardCalls ?? []')
    const passed = failures.length === 0 && checks.length === themes.length * contrasts.length && clipboard.length === 0
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ passed, sessionId, muted: win.webContents.isAudioMuted(), clipboard, permissions,
      byteOrder: BGRA ? 'BGRA' : 'RGBA', themes, contrasts, failures, summary }, null, 2))
    console.log(JSON.stringify({ passed, sessionId, themes: checks.length, failures: failures.length, first: failures.slice(0, 6) }))
    win.destroy(); server.close(); app.exit(passed ? 0 : 1)
  } catch (error) {
    console.error(error)
    try { fs.writeFileSync(path.join(out, 'failure-dom.html'), await js('document.body.outerHTML')) } catch { /* the page is gone */ }
    fs.writeFileSync(path.join(out, 'failure-console.json'), JSON.stringify(consoleLines, null, 2))
    win.destroy(); server.close(); app.exit(1)
  }
}).catch(error => { console.error(error); app.exit(1) })
