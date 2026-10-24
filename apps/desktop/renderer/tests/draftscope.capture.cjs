const { app, BrowserWindow, clipboard, Menu } = require('electron')
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const out = path.resolve(process.argv[2])
assert(/^C:[\\/]orgtree-build[\\/]native-tools-sol[\\/]draft-tools-layout[\\/]capture-[a-z0-9-]+$/i.test(out), 'own capture output required')
const sessionId = pid => Number(execFileSync('powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${pid}).SessionId`], { encoding: 'utf8', windowsHide: true }).trim())
assert.equal(sessionId(process.pid), 0, 'Capture must run in Session 0')
fs.mkdirSync(out, { recursive: true })
for (const key of ['userData', 'sessionData', 'logs', 'crashDumps']) {
  fs.mkdirSync(path.join(out, key), { recursive: true }); app.setPath(key, path.join(out, key))
}
// Stub every clipboard bridge before creating a window; never call the native
// clipboard even to clear it. Permission handlers also deny renderer access.
const blockedClipboard = []
for (const key of new Set([...Object.keys(clipboard), 'readText', 'writeText', 'clear', 'readHTML', 'writeHTML', 'readRTF', 'readImage', 'readBuffer', 'writeBuffer', 'readFindText', 'writeFindText', 'availableFormats', 'readBookmark', 'writeBookmark', 'write'])) {
  if (typeof clipboard[key] !== 'function') continue
  clipboard[key] = () => {
    blockedClipboard.push(key)
    return key === 'availableFormats' ? [] : key.startsWith('read') ? '' : undefined
  }
}
assert.equal(clipboard.readText(), '', 'Clipboard stub starts empty without native access')
Menu.setApplicationMenu(null)
app.disableHardwareAcceleration()
const settle = 'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 100))))'
app.whenReady().then(async () => {
  const esbuild = require('E:/Libraries/Desktop/orgtree/node_modules/esbuild')
  try {
    esbuild.buildSync({ entryPoints: ['apps/desktop/renderer/tests/draftscope.visual.tsx'], bundle: true,
      jsx: 'automatic', platform: 'browser', format: 'esm', outfile: path.join(out, 'fixture.js'),
      nodePaths: ['E:/Libraries/Desktop/orgtree/node_modules'], define: { 'process.env.NODE_ENV': '"production"' } })
    esbuild.buildSync({ stdin: { contents: '@import "./styles.css"; @import "./shell.css";',
      resolveDir: path.resolve('apps/desktop/renderer/src'), loader: 'css' }, bundle: true,
      outfile: path.join(out, 'fixture.css'), nodePaths: ['E:/Libraries/Desktop/orgtree/node_modules'],
      loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl', '.svg': 'dataurl', '.png': 'dataurl' } })
  } finally { esbuild.stop() }
  fs.writeFileSync(path.join(out, 'index.html'), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><div id="root"></div><script type="module" src="fixture.js"></script>')
  const win = new BrowserWindow({ width: 960, height: 700, show: false, useContentSize: true,
    webPreferences: { offscreen: true, contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } })
  const receipts = [], errors = []
  win.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  win.webContents.session.setPermissionCheckHandler(() => false)
  win.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !/^(file:|data:)/.test(details.url) }))
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('before-input-event', (event, input) => {
    if ((input.control || input.meta) && /^[cvx]$/i.test(input.key) || input.shift && input.key === 'Insert') event.preventDefault()
  })
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 2) errors.push({ level, message }) })
  const rendererPid = win.webContents.getOSProcessId.bind(win.webContents)
  try {
    await win.loadFile(path.join(out, 'index.html'))
    assert.equal(sessionId(rendererPid()), 0, 'Window renderer must also run in Session 0')
    await win.webContents.executeJavaScript(settle)
    await win.webContents.executeJavaScript("document.querySelector('.df-gear').click()")
    await win.webContents.executeJavaScript(settle)
    await win.webContents.executeJavaScript("document.querySelector('[aria-label=\"Disabled by Orgtree\"]').click()")
    await win.webContents.executeJavaScript(settle)
    assert.equal(await win.webContents.executeJavaScript('window.draftToolsState().scope.tools.orgtree_disabled'), true)
    for (const [name, width] of [['default', 960], ['narrow', 400]]) {
      win.setContentSize(width, 700)
      await win.webContents.executeJavaScript(settle)
      const geometry = await win.webContents.executeJavaScript(`(() => {
        const panel = document.querySelector('.draft-scope');
        const rect = el => { const r = el.getBoundingClientRect(); return { x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom,right:r.right }; };
        const rows = [...panel.querySelectorAll('.set-row')].map(row => ({ label:row.querySelector('.set-label')?.textContent, row:rect(row), hint:row.querySelector('.set-hint') ? rect(row.querySelector('.set-hint')) : null }));
        const groups = [...panel.querySelectorAll('.set-group')].map(group => ({ title:group.querySelector('.set-group-head').textContent, group:rect(group), header:rect(group.querySelector('.set-group-head')), intro:rect(group.querySelector(':scope > .set-hint')) }));
        const native = panel.querySelector('[aria-label="Disabled by Orgtree"]').closest('.set-row');
        panel.scrollTop += native.getBoundingClientRect().top-panel.getBoundingClientRect().top-105;
        const overflow = [...panel.querySelectorAll('*')].filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.right > panel.getBoundingClientRect().right; }).map(el => ({tag:el.tagName, className:el.className, rect:rect(el)}));
        return { viewport:[innerWidth,innerHeight], panel:rect(panel), clientWidth:panel.clientWidth, scrollWidth:panel.scrollWidth, rows, groups, overflow, noApply:![...panel.querySelectorAll('button')].some(b=>b.textContent==='apply') };
      })()`)
      fs.writeFileSync(path.join(out, `${name}-geometry.json`), JSON.stringify(geometry, null, 2))
      await win.webContents.executeJavaScript(settle)
      const png = await win.webContents.capturePage()
      fs.writeFileSync(path.join(out, `${name}.png`), png.toPNG())
      assert(geometry.rows.length >= 10)
      assert(geometry.panel.width > 0 && geometry.panel.height > 0)
      assert(geometry.noApply)
      assert.equal(geometry.overflow.length, 0, `No controls outside panel: ${JSON.stringify(geometry.overflow)}`)
      for (const row of geometry.rows) {
        assert(row.row.height > 0, row.label)
        if (row.hint) assert(row.hint.bottom <= row.row.bottom + 1, `Hint stays inside ${row.label}`)
      }
      for (let i = 0; i < geometry.groups.length; i++) {
        const group = geometry.groups[i]
        assert(group.intro.y >= group.header.bottom - 1, `${group.title} intro follows its header`)
        if (i) assert(group.group.y >= geometry.groups[i-1].group.bottom - 1, `${group.title} does not overlap prior section`)
      }
      receipts.push({ name, mainPid:process.pid, mainSessionId:sessionId(process.pid), rendererPid:rendererPid(), rendererSessionId:sessionId(rendererPid()),
        clipboard:{ initiallyEmptyStub:true,nativeBridgesStubbed:true,permissionsDenied:true,pasteBlocked:true }, input:'executeJavaScript on owned synthetic window only', geometry, image:png.getSize() })
      console.log('CAPTURE', name, JSON.stringify({ viewport:geometry.viewport, rows:geometry.rows.length, groups:geometry.groups.length, image:png.getSize() }))
    }
    await require('./draftclose.capture-helper.cjs')(win, '.draft-scope', settle)
    await win.webContents.executeJavaScript(settle)
    assert.equal(await win.webContents.executeJavaScript("document.querySelector('.draft-scope') === null"), true)
    await win.webContents.executeJavaScript("document.querySelector('.df-gear').click()")
    await win.webContents.executeJavaScript(settle)
    assert.equal(await win.webContents.executeJavaScript('document.querySelector(\'[aria-label="Disabled by Orgtree"]\').checked'), true)
    assert.equal(errors.length, 0, JSON.stringify(errors))
    fs.writeFileSync(path.join(out, 'receipt.json'), JSON.stringify({ receipts, consoleErrors:errors, blockedClipboard }, null, 2))
  } finally { win.destroy() }
}).then(() => app.exit(0), error => { console.error(error.stack || error); app.exit(1) })
