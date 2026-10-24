// Real Chromium marker control. Native popup is outside capturePage; the
// pictured preview records production's template, never synthetic spelling.
const { app, BrowserWindow, session, clipboard, Menu } = require('electron')
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const out = path.resolve(process.argv[2])
if (!out.toLowerCase().startsWith('c:\\orgtree-build\\mention-reply-sol\\')) throw Error('Output outside assigned root')
const sessionId = Number(execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Process -Id ${process.pid}).SessionId`], { encoding: 'utf8', windowsHide: true }).trim())
assert.equal(sessionId, 0, 'Session 0 required before creating any window')
app.setPath('userData', path.join(out, 'profile')); app.setPath('sessionData', path.join(out, 'session'))
app.disableHardwareAcceleration()
const clipboardCalls = [], dictionaryCalls = [], popups = []
for (const key of Object.keys(clipboard)) if (typeof clipboard[key] === 'function') {
  Object.defineProperty(clipboard, key, { value: () => { clipboardCalls.push(key); return key === 'availableFormats' ? [] : key === 'has' ? false : '' } })
}
const buildMenu = Menu.buildFromTemplate.bind(Menu)
Menu.buildFromTemplate = template => {
  const menu = buildMenu(template)
  menu.popup = options => popups.push({ template, x: options.x, y: options.y, window: options.window.id })
  return menu
}
fs.writeFileSync(path.join(out, 'index.html'), '<!doctype html><html lang="en"><meta charset="utf-8"><link rel="stylesheet" href="probe.css"><div id="root"></div><script src="probe.js"></script></html>')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
app.whenReady().then(async () => {
  console.log('Isolated Electron ready, PID ' + process.pid)
  const isolated = session.fromPartition('scaled-spelling-' + process.pid)
  isolated.setPermissionCheckHandler(() => false)
  isolated.setPermissionRequestHandler((_wc, _permission, done) => done(false))
  isolated.addWordToSpellCheckerDictionary = word => { dictionaryCalls.push(word); return true }
  const win = new BrowserWindow({ width: 1000, height: 700, show: false, frame: false,
    webPreferences: { offscreen: true, backgroundThrottling: false, contextIsolation: true, sandbox: true, nodeIntegration: false, session: isolated } })
  const wc = win.webContents
  console.log('Owned window created')
  wc.setWindowOpenHandler(() => ({ action: 'deny' }))
  for (const method of ['cut', 'copy', 'paste', 'pasteAndMatchStyle']) wc[method] = () => { throw Error('Clipboard command forbidden in spelling capture') }
  require(path.join(out, 'editmenu.cjs')).attachEditMenu(win)
  console.log('Production menu attached')
  wc.debugger.attach('1.3')
  async function contextMenu(point) {
    const event = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Native context-menu event missing')), 3000)
      wc.once('context-menu', (_event, p) => { clearTimeout(timer); resolve({ isEditable: p.isEditable,
        word: p.misspelledWord, suggestions: p.dictionarySuggestions, x: p.x, y: p.y, selection: p.selectionText }) })
    })
    for (const type of ['mousePressed', 'mouseReleased']) await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: 'right', clickCount: 1 })
    return { params: await event, popup: popups.at(-1) }
  }
  try {
    await Promise.race([win.loadFile(path.join(out, 'index.html')), delay(10000).then(() => { throw Error('Fixture load timeout') })])
    console.log('Loaded isolated canvas fixture')
    await wc.executeJavaScript(`new Promise((resolve,reject)=>{const deadline=Date.now()+5000;function ready(){const el=document.querySelector('.sq.desk textarea');if(el&&el.getBoundingClientRect().height>0)return resolve();if(Date.now()>deadline)return reject(Error('Real canvas composer missing'));setTimeout(ready,25)}ready()})`)
    const geometry = await wc.executeJavaScript(`(() => {const el=document.querySelector('.sq.desk textarea');el.focus();const r=el.getBoundingClientRect(),s=getComputedStyle(el),sx=r.width/el.offsetWidth,sy=r.height/el.offsetHeight;return {rect:r.toJSON(),scaleX:sx,scaleY:sy,x:r.x+(parseFloat(s.paddingLeft)+24)*sx,y:r.y+(parseFloat(s.paddingTop)+parseFloat(s.lineHeight)/2)*sy}})()`)
    assert(geometry.scaleX > .6 && geometry.scaleX < .65 && geometry.rect.height > 0, 'Real scaled layout required')
    // The exact alpha.4 input: one insertion without a final word boundary.
    await wc.debugger.sendCommand('Input.insertText', { text: 'mispellled synthetic' })
    await delay(1500)
    const control = await contextMenu(geometry)
    console.log('No-boundary native event: ' + JSON.stringify(control.params))
    assert.equal(control.params.word, '', 'Control must reproduce missing spelling markers')
    assert(!control.popup.template.some(item => item.label === 'Add to dictionary'))
    // CDP key events, ending with a boundary; never assign a DOM field value.
    await wc.executeJavaScript(`document.querySelector('.sq.desk textarea').select()`)
    for (const key of 'mispellled synthetic ') {
      await wc.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key, text: key, windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0) })
      await wc.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key, windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0) })
      await delay(15)
    }
    await delay(1500)
    const positive = await contextMenu(geometry)
    console.log('Typed-boundary native event: ' + JSON.stringify(positive.params))
    assert.equal(positive.params.word, 'mispellled')
    assert(positive.params.suggestions.includes('misspelled'), 'Real OS suggestion required')
    assert.equal(positive.popup.window, win.id)
    assert(Math.abs(positive.popup.x - geometry.x) <= 1 && Math.abs(positive.popup.y - geometry.y) <= 1)
    const model = positive.popup.template.map(({ label, type, accelerator, enabled }) => ({ label, type, accelerator, enabled }))
    await wc.executeJavaScript(`(() => {const panel=document.createElement('aside');panel.style.cssText='position:absolute;left:670px;top:65px;width:300px;font:13px Segoe UI;color:#ddd';const title=document.createElement('p');title.textContent='Real native event menu preview (native popup is outside capturePage)';panel.append(title);for(const item of ${JSON.stringify(model)}){const row=document.createElement(item.type==='separator'?'hr':'div');row.style.cssText='padding:4px 8px;background:#333';row.textContent=item.label||'';panel.append(row)}document.body.append(panel)})()`)
    await wc.executeJavaScript(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(resolve,150))))`)
    console.log('Paint settled; capturing')
    fs.writeFileSync(path.join(out, 'scaled-spelling.png'), (await wc.capturePage()).toPNG())
    positive.popup.template.find(item => item.label === 'Add to dictionary').click()
    assert.deepEqual(dictionaryCalls, ['mispellled'])
    positive.popup.template.find(item => item.label === 'misspelled').click()
    await delay(100)
    const corrected = await wc.executeJavaScript(`document.querySelector('.sq.desk textarea').value`)
    assert.equal(corrected, 'misspelled synthetic ', 'Production replacement edits real composer')
    assert.deepEqual(clipboardCalls, [])
    const receipt = { source: 'Production NodeSquare, DeskChat and attachEditMenu; real Chromium/OS spellchecker',
      pid: process.pid, sessionId, geometry, languages: isolated.getSpellCheckerLanguages(),
      clipboardInitiallyEmpty: true, clipboardPermissionsDenied: true, nativeClipboardStubbed: true, clipboardCalls,
      dictionaryStubbed: true, dictionaryCalls, noBoundaryControl: control.params, typedBoundaryPositive: positive.params,
      nativeMenuTemplate: model, corrected, nativePopupLayout: 'Not measured; preview is actual native event/template only', status: 'PASS' }
    fs.writeFileSync(path.join(out, 'receipt.json'), JSON.stringify(receipt, null, 2))
    console.log(JSON.stringify(receipt)); app.exit(0)
  } catch (error) { console.error(error); app.exit(1) }
})
