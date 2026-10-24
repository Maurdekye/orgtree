const { app, BrowserWindow, session, clipboard } = require('electron')
const fs = require('node:fs'), path = require('node:path'), { execFileSync } = require('node:child_process')
const out = path.resolve(process.argv[2])
if (!out.toLowerCase().startsWith('c:\\orgtree-build\\mention-reply-sol\\')) throw new Error('Output is outside assigned root')
const sessionId = Number(execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Process -Id ${process.pid}).SessionId`], { encoding: 'utf8', windowsHide: true }).trim())
if (sessionId !== 0) throw new Error(`Capture requires Session 0; actual ${sessionId}`)
app.setPath('userData', path.join(out, 'profile')); app.setPath('sessionData', path.join(out, 'session'))
app.disableHardwareAcceleration()
// Never call the native clipboard implementations. This private clipboard starts empty.
const clipboardCalls = []
for (const name of Object.keys(clipboard)) {
  if (typeof clipboard[name] !== 'function') continue
  const value = name === 'availableFormats' ? [] : name === 'has' ? false : ''
  Object.defineProperty(clipboard, name, { configurable: true, value: () => { clipboardCalls.push(name); return value } })
}
app.whenReady().then(async () => {
  const isolated = session.fromPartition('textmenu-isolated-' + process.pid)
  isolated.setPermissionRequestHandler((_webContents, _permission, done) => done(false))
  isolated.setPermissionCheckHandler(() => false)
  const { editMenuTemplate } = require(path.join(out, 'editmenu.cjs'))
  const noop = () => {}
  const model = editMenuTemplate({ isEditable: true, selectionText: 'mispeling', misspelledWord: 'mispeling', dictionarySuggestions: ['misspelling'],
    editFlags: { canUndo: true, canRedo: false, canCut: true, canCopy: true, canPaste: true, canDelete: true, canSelectAll: true, canEditRichly: true } },
  { undo: noop, redo: noop, cut: noop, copy: noop, paste: noop, pasteAndMatchStyle: noop, delete: noop, selectAll: noop, replaceMisspelling: noop, addWordToDictionary: noop })
    .map(({ label, type, accelerator, enabled }) => ({ label, type, accelerator, enabled }))
  fs.writeFileSync(path.join(out, 'index.html'), '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\' data:; script-src \'self\' \'unsafe-inline\'; style-src \'self\' \'unsafe-inline\'; font-src data:"><link rel="stylesheet" href="probe.css"><div id="root"></div><script>window.textMenuPreview=' + JSON.stringify(model) + '</script><script src="probe.js"></script>')
  const win = new BrowserWindow({ width: 1000, height: 700, frame: false, show: false, webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false, session: isolated } })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  try {
    await win.loadFile(path.join(out, 'index.html'))
    const receipt = await win.webContents.executeJavaScript(`(async () => {
      const deadline=Date.now()+5000; let text;
      while(!(text=[...document.querySelectorAll('.pinwin .selection-source p')].find(el=>el.textContent.includes('beside this passage')))){
        if(Date.now()>deadline)throw Error('Pinned transcript did not render');await new Promise(resolve=>setTimeout(resolve,25));
      }
      const range=document.createRange();range.setStart(text.firstChild,4);range.setEnd(text.firstChild,18);
      const selected=getSelection();selected.removeAllRanges();selected.addRange(range);
      const rect=range.getBoundingClientRect(),point={x:Math.round(rect.left+rect.width/2),y:Math.round(rect.top+rect.height/2)};
      text.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2,clientX:point.x,clientY:point.y}));
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(resolve,150))));
      const menu=document.querySelector('.ctxmenu'),box=menu.getBoundingClientRect();
      const entries=[...menu.querySelectorAll('[role="menuitem"]')].map(el=>el.getAttribute('aria-label')||el.textContent);
      if(entries.join('|')!=='Reply to selection|Copy|Select All')throw Error(JSON.stringify(entries));
      if(box.x!==point.x||box.y!==point.y)throw Error('Selection menu left the pointer');
      let blocked=false;try{await navigator.clipboard.writeText('synthetic')}catch{blocked=true}
      return {point,menu:{x:box.x,y:box.y,width:box.width,height:box.height},entries,rendererClipboardBlocked:blocked,viewport:{width:innerWidth,height:innerHeight}};
    })()`)
    if (!receipt.rendererClipboardBlocked) throw new Error('Clipboard was not blocked')
    const result = { ...receipt, pid: process.pid, sessionId, privateDesktop: null, clipboardInitiallyEmpty: true, clipboardPermissionsDenied: true, nativeClipboardStubbed: true, clipboardCalls, nativeMenuTemplate: model }
    fs.writeFileSync(path.join(out, 'receipt.json'), JSON.stringify(result, null, 2))
    fs.writeFileSync(path.join(out, 'text-menus.png'), (await win.webContents.capturePage()).toPNG())
    console.log(JSON.stringify(result)); app.exit(0)
  } catch (error) { console.error(error); app.exit(1) }
})
