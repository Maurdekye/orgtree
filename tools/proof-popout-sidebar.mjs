// Renderer-only real Chromium proof. A synthetic panel uses production
// MovableSurface and CollapsibleMailer; no engine, live data or app build.
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
const repo = process.cwd(), out = process.env.POPOUT_SIDEBAR_OUT
const deps = process.env.BATCH_NODE_MODULES
if (!out || !/^C:[\\/]orgtree-build[\\/]/i.test(out) || !process.env.ORGTREE_AGENT || !deps)
  throw Error('Run within assigned FIFO/kernel Job with C output and dependencies read in place')
const require = createRequire(path.join(deps, '../package.json'))
if (process.argv[2] !== '--electron') {
  fs.mkdirSync(out, { recursive: true })
  const esbuild = require('esbuild')
  try {
    await esbuild.build({ entryPoints: [path.join(repo, 'apps/desktop/renderer/tests/narrowlist-popout-fixture.tsx')],
      outfile: path.join(out, 'fixture.js'), bundle: true, format: 'iife', platform: 'browser', jsx: 'automatic',
      nodePaths: [deps], loader: { '.md': 'text' } })
  } finally { esbuild.stop() }
  const html = '<!doctype html><html><head><link rel="stylesheet" href="/fixture.css"><style>' +
    'html,body,#root{margin:0;width:100%;height:100%;overflow:hidden}body{background:#171717;color:#ddd}' +
    '.proof-panel{width:100%;height:100%;display:flex;flex-direction:column}.proof-panel header{height:32px;flex:none}' +
    '.proof-panel .mailer{flex:1;min-height:0}.proof-panel .mailer-read{padding:24px}' +
    '.proof-panel .mailer-list{width:240px;overflow:auto}.proof-panel .mailer-list input{width:90%}' +
    '</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>'
  fs.writeFileSync(path.join(out, 'index.html'), html)
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  // Electron waits for ESM main evaluation before ready. Awaiting ready at
  // that module's top level deadlocks; a CJS bootstrap returns immediately.
  const bootstrap = path.join(out, 'electron-main.cjs')
  fs.writeFileSync(bootstrap, `const {app}=require('electron');app.setPath('userData',${JSON.stringify(path.join(out, 'electron-profile'))});app.commandLine.appendSwitch('disable-gpu');app.whenReady().then(()=>import(${JSON.stringify(pathToFileURL(path.join(repo, 'tools/proof-popout-sidebar.mjs')).href)})).catch(e=>{console.error(e);app.exit(1)});`)
  const run = spawnSync(require('electron'), [bootstrap, '--electron'],
    { env, stdio: 'inherit', windowsHide: true, timeout: 90000 })
  if (run.error) console.error(run.error)
  process.exitCode = run.status ?? 1
} else {
  const { app, BrowserWindow } = require('electron')
  app.setPath('userData', path.join(out, 'electron-profile'))
  app.commandLine.appendSwitch('disable-gpu')
  const checks = [], samples = []
  const check = (name, ok) => { checks.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`) }
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
  const within = async (promise, label) => {
    let timer
    try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Timed out: ' + label)), 8000) })]) }
    finally { clearTimeout(timer) }
  }
  const server = http.createServer((req, res) => {
    const name = req.url === '/fixture.js' ? 'fixture.js' : req.url === '/fixture.css' ? 'fixture.css' : 'index.html'
    res.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html')
    res.end(fs.readFileSync(path.join(out, name)))
  })
  let main
  try {
    await app.whenReady()
    console.log('Electron ready')
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    main = new BrowserWindow({ show: false, width: 1000, height: 700,
      webPreferences: { contextIsolation: false, nodeIntegration: false, sandbox: false, backgroundThrottling: false } })
    main.webContents.setWindowOpenHandler(() => ({ action: 'allow', overrideBrowserWindowOptions: {
      show: false, width: 1000, height: 680, webPreferences: { backgroundThrottling: false } } }))
    const evaluate = code => main.webContents.executeJavaScript(code, true)
    const childEvaluate = async (win, expression) => {
      if (!win.webContents.debugger.isAttached()) win.webContents.debugger.attach('1.3')
      const result = await win.webContents.debugger.sendCommand('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
      if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails))
      return result.result.value
    }
    const settle = async win => {
      await within(childEvaluate(win, 'new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))'), 'two painted frames')
      await delay(100)
    }
    await within(main.loadURL(`http://127.0.0.1:${server.address().port}/`), 'fixture load')
    await settle(main)
    const sample = async (name, win, width) => {
      await settle(win)
      const s = await evaluate('window.__sidebarProof.snapshot()')
      samples.push({ name, ...s, nativeBounds: win.getBounds() })
      check(name + ' reaches requested content width', Math.abs(s.width - width) <= 1)
      check(name + ' list breakpoint follows content width', s.narrow === (width <= 896) && s.toggle === (width <= 896))
      check(name + ' retains list input and filter', s.sameInput && s.filter === 'Retained filter')
      await settle(win)
      fs.writeFileSync(path.join(out, name + '.png'), (await win.webContents.capturePage()).toPNG())
    }
    await evaluate('window.__sidebarProof.contentWidth(960)')
    await sample('home-wide', main, 960)
    const childReady = new Promise(resolve => main.webContents.once('did-create-window', resolve))
    await evaluate('document.querySelector(".popout-button").click()')
    const child = await within(childReady, 'native popout creation')
    child.webContents.setBackgroundThrottling(false)
    console.log('Child ready', JSON.stringify({ url: child.webContents.getURL(), loading: child.webContents.isLoading(), destroyed: child.isDestroyed() }))
    await delay(150)
    await sample('popout-wide', child, 960)
    // Only the native popout changes size. The opener's viewport is untouched.
    await evaluate('window.__sidebarProof.contentWidth(null)')
    for (const [name, width] of [['native-narrow', 800], ['native-wide', 980]]) {
      child.setContentBounds({ ...child.getContentBounds(), width, height: 620 })
      await sample(name, child, width)
    }
    // Content-only delivery, even when no native/window resize fires.
    for (const [name, width] of [['content-at-boundary', 896], ['content-above-boundary', 897], ['content-narrow', 650]]) {
      await evaluate(`window.__sidebarProof.contentWidth(${width})`)
      await sample(name, child, width)
    }
    await evaluate('window.__sidebarProof.contentWidth(960)')
    try { await childEvaluate(child, '[...document.querySelectorAll("button")].find(b=>b.textContent==="Return panel").click()') }
    catch (error) {
      // Redock synchronously closes its own native target while CDP is still
      // replying. Only accept that error after verifying the window did close.
      await delay(100)
      if (!child.isDestroyed()) throw error
    }
    await sample('returned-wide', main, 960)
    await evaluate('window.__sidebarProof.contentWidth(650)')
    await sample('returned-narrow', main, 650)
  } catch (error) {
    console.error(error)
    checks.push({ name: 'proof executes completely', ok: false, error: String(error) })
  } finally {
    const result = { checks, samples, failed: checks.filter(c => !c.ok).length,
      limits: 'Synthetic production surface, real Electron adoption/setContentBounds/content resize. Real Windows snap divider, maximize/restore and DPI-change gestures unmeasured in Session 0.' }
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2))
    console.log(JSON.stringify({ checks: checks.length, failed: result.failed }))
    for (const win of BrowserWindow.getAllWindows()) win.destroy()
    server.close()
    app.exit(result.failed ? 1 : 0)
  }
}
