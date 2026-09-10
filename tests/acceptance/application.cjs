// Loads the actual built entrypoint; no replacement engine, renderer or preload.
// Instrumentation selects an isolated profile, observes windows/child readiness,
// acknowledges native informational dialogs and drives Chromium's real DOM.
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const cp = require('node:child_process')
const { app, BrowserWindow, dialog, net } = require('electron')
const root = fs.realpathSync.native(process.env.ORGTREE_ACCEPTANCE_ROOT)
const target = fs.realpathSync.native(process.env.ORGTREE_ACCEPTANCE_APP)
const packaged = process.env.ORGTREE_ACCEPTANCE_PACKAGE
const resources = packaged ? path.join(packaged, 'resources') : target
const appPath = packaged ? path.join(resources, 'app.asar') : target
const loginCalls = []
const phase = process.env.ORGTREE_ACCEPTANCE_PHASE
const visualFixture = process.env.ORGTREE_ACCEPTANCE_VISUAL_FIXTURE === '1'
assert.ok(['initial', 'restart'].includes(phase))
const data = fs.realpathSync.native(path.join(root, 'data'))
// The shell treats an inherited ORGTREE_DATA as a forbidden v1 root and replaces
// it for its child. Point even this inherited selector at a fresh empty fixture.
assert.equal(fs.realpathSync.native(process.env.ORGTREE_DATA), fs.realpathSync.native(path.join(root, 'inherited-v1')))
assert.equal(fs.realpathSync.native(process.env.ORGTREE_V2_DATA), data)
app.setPath('userData', path.join(root, 'profile'))
app.setAppPath(appPath)
if (packaged) {
  Object.defineProperty(app, 'isPackaged', { value: true })
  Object.defineProperty(process, 'resourcesPath', { value: resources })
  app.setLoginItemSettings = settings => { loginCalls.push({ openAtLogin: settings.openAtLogin, args: settings.args }) }
  // Prevent this engineering package from discovering/downloading/applying an
  // external update. Preserve loopback browser transport to its real engine.
  const originalRequest = net.request.bind(net)
  net.request = options => {
    const value = typeof options === 'string' ? options : options.url || `https://${options.hostname || options.host}${options.path || '/'}`
    if (new URL(value).hostname !== '127.0.0.1') throw new Error('Acceptance disables updater network')
    return originalRequest(options)
  }
}
const rows = [], children = [], handshakes = [], diagnostics = []
const screenshots = []
const rendererTiming = { documentLoad: null, rootMounted: null, frameOpportunity: null, rootReady: null, populatedOrg: null }
async function capture(window, name) {
  await new Promise(resolve => setTimeout(resolve, 1000))
  const output = path.join(root, phase + '-' + name + '.png')
  try {
    const page = await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })
    assert.equal(page.isEmpty(), false, 'Screenshot must contain real rendered pixels')
    fs.writeFileSync(output, page.toPNG())
  } catch (error) {
    if (error.message !== 'UnknownVizError') throw error
    // Some adopted about:blank portals have no capturable surface in Electron's
    // API. Ask that same real Chromium view for its screenshot instead.
    const debuggerClient = window.webContents.debugger
    debuggerClient.attach('1.3')
    try {
      const frame = await debuggerClient.sendCommand('Page.captureScreenshot', { format: 'png', fromSurface: false })
      const bytes = Buffer.from(frame.data, 'base64')
      assert.ok(bytes.length > 100, 'Chromium screenshot must contain pixels')
      fs.writeFileSync(output, bytes)
    } finally { debuggerClient.detach() }
  }
  screenshots.push(output)
}
let ready = false, finishing = false, launched = false
const spawn = cp.spawn
cp.spawn = function(command, args, options) {
  if (args?.some(arg => String(arg).endsWith('launch.py'))) {
    if (fs.realpathSync.native(options.env.ORGTREE_DATA) !== data) {
      diagnostics.push('Acceptance instrumentation refused mismatched spawn data root')
      throw new Error('Acceptance spawn root mismatch')
    }
    if (fs.realpathSync.native(args[0]) !== fs.realpathSync.native(path.join(resources, 'engine/launch.py'))) {
      diagnostics.push('Acceptance instrumentation refused mismatched launcher path')
      throw new Error('Acceptance launcher mismatch')
    }
    launched = true
    if (visualFixture) args = [path.join(__dirname, 'visual_engine.py'), ...args.slice(1)]
  }
  const child = spawn.call(this, command, args, options)
  children.push(child)
  child.stderr?.on('data', chunk => {
    fs.appendFileSync(path.join(root, phase + '-private-engine.log'), chunk)
    const missing = chunk.toString().match(/ModuleNotFoundError: No module named '([A-Za-z0-9_.]+)'/)
    if (missing) diagnostics.push('Missing Python module: ' + missing[1])
  })
  let buffered = ''
  child.stdout?.on('data', chunk => {
    buffered = (buffered + chunk.toString()).slice(-65536)
    while (buffered.includes('\n')) {
      const at = buffered.indexOf('\n'), line = buffered.slice(0, at); buffered = buffered.slice(at + 1)
      try {
        const row = JSON.parse(line)
        if (row.type === 'ready') handshakes.push({ protocol: row.protocol, port: row.port, pid: row.pid, dataRootId: row.dataRootId })
      } catch { /* Non-protocol output is deliberately not retained. */ }
    }
  })
  return child
}
dialog.showMessageBox = async (...args) => {
  const options = args.at(-1)
  if (options.type === 'error') {
    const known = ['Python engine has not been packaged', 'Python engine exited before readiness', 'Engine did not become ready in time', 'Python engine could not start', 'Python runtime is missing. Configure ORGTREE_V2_PYTHON for development.', 'V2 data root must be absolute', 'Invalid data root', 'V2 data root overlaps the v1 data root', 'Invalid engine readiness', 'Engine data root mismatch']
    rows.push({ name: 'native-startup-dialog', status: 'FAIL', reason: known.includes(options.detail) ? options.detail : 'Application displayed an error dialog' })
    setImmediate(finish)
  }
  return { response: 0, checkboxChecked: false }
}
async function check(name, action) {
  try { await action(); rows.push({ name, status: 'PASS' }) }
  catch (error) {
    fs.appendFileSync(path.join(root, 'private-errors.log'), name + '\n' + error.stack + '\n')
    rows.push({ name, status: 'FAIL', reason: error instanceof assert.AssertionError ? error.message : 'Runtime operation failed (' + error.name + ')' })
  }
}
function finish() {
  if (finishing) return
  finishing = true
  clearTimeout(deadline)
  const status = ready && rows.length > 0 && rows.every(r => r.status === 'PASS') ? 'PASS' : 'FAIL'
  fs.writeFileSync(path.join(root, phase + '.json'), JSON.stringify({ status, ready, checks: rows, diagnostics, screenshots, rendererTiming, childPids: children.map(c => c.pid).filter(Boolean) }, null, 2))
  app.quit()
  const cleanup = setTimeout(() => {
    for (const child of children) if (child.exitCode === null) child.kill()
    app.exit(1)
  }, 12000)
  cleanup.unref()
}
const deadline = setTimeout(() => {
  rows.push({ name: 'bounded-completion', status: 'FAIL', reason: 'Application did not complete within 120 seconds' })
  finish()
}, 120000)
app.on('browser-window-created', (_event, main) => {
  main.webContents.once('did-finish-load', async () => {
    if (ready || !/^http:\/\/127\.0\.0\.1:\d+\/$/.test(main.webContents.getURL())) return
    ready = true
    const evaluate = code => main.webContents.executeJavaScript(code, true)
    rendererTiming.documentLoad = await evaluate('performance.now()')
    const waitFor = condition => evaluate(`new Promise(resolve => { const start=Date.now(); const timer=setInterval(()=>{if(${condition}){clearInterval(timer);resolve(true)}else if(Date.now()-start>15000){clearInterval(timer);resolve(false)}},100) })`)
    const origin = new URL(main.webContents.getURL()).origin
    await check('real-engine-readiness-root-pid-port', async () => {
      assert.equal(launched, true)
      assert.equal(handshakes.length, 1)
      const h = handshakes[0]
      assert.equal(h.protocol, 1)
      assert.equal(fs.realpathSync.native(h.dataRootId), data)
      assert.ok(children.some(c => c.pid === h.pid))
      assert.equal(Number(new URL(origin).port), h.port)
      assert.notEqual(h.port, 7360)
    })
    if (rows.at(-1).status !== 'PASS') { finish(); return }
    await check('real-renderer-mounted', async () => {
      // Wait for React after the document load; blank pages cannot pass.
      const mounted = await evaluate(`new Promise(resolve => { const start=Date.now(); const timer=setInterval(()=>{ if(document.getElementById('root')?.children.length && document.body.innerText.trim().length>20){clearInterval(timer);resolve(true)}else if(Date.now()-start>15000){clearInterval(timer);resolve(false)} },100) })`)
      assert.equal(mounted, true)
      rendererTiming.rootMounted = await evaluate('performance.now()')
      // Two requestAnimationFrame callbacks mark frame opportunities, not a measured paint.
      rendererTiming.frameOpportunity = await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now()))))')
      // Interactive means the renderer root is mounted after those frame opportunities.
      rendererTiming.rootReady = await evaluate('performance.now()')
    })
    await check('native-bridge-and-defaults', async () => {
      assert.deepEqual(await evaluate('window.orgtreeDesktop.getStatus()'), { state: 'ready' })
      const prefs = await evaluate('window.orgtreeDesktop.getPreferences()')
      assert.equal(prefs.exitOnClose, false)
      assert.equal(prefs.startAtLogin, true)
      assert.equal(await evaluate('typeof require'), 'undefined')
      if (packaged) assert.deepEqual(loginCalls[0], { openAtLogin: true, args: ['--background'] }, 'Packaged first run requests quiet login by default')
    })
    await check('home-window-controls-at-window-corner', async () => {
      // Restart may restore the active organization. Use the real navigation
      // controls to reach the populated home list before measuring it.
      let restoredOrg = null
      if (phase === 'restart' && !await evaluate(`Boolean(document.querySelector('.welcome'))`)) {
        restoredOrg = await evaluate(`document.querySelector('header.orgbar h2')?.textContent`)
        assert.equal(await waitFor(`document.querySelector('header.orgbar button.iconbtn')`), true)
        await evaluate(`document.querySelector('header.orgbar button.iconbtn').click(); true`)
        assert.equal(await waitFor(`[...document.querySelectorAll('button.home')].some(e => e.textContent.includes('all organizations'))`), true)
        await evaluate(`[...document.querySelectorAll('button.home')].find(e => e.textContent.includes('all organizations')).click(); true`)
      }
      assert.equal(await waitFor(`document.querySelector('.welcome') && document.querySelector('.window-controls')`), true,
        'Positive control: the actual home page and native controls must be mounted')
      const measured = await evaluate(`(() => {
        const controls = [...document.querySelectorAll('.window-controls')].filter(e => e.getBoundingClientRect().width > 0);
        return { width: innerWidth, controls: controls.map(e => {
          const r = e.getBoundingClientRect(); return { top: r.top, right: r.right, bottom: r.bottom };
        }) };
      })()`)
      assert.equal(measured.controls.length, 1, 'Exactly one native control group on home')
      const controls = measured.controls[0]
      assert.ok(controls.top >= 0 && controls.bottom <= 64, `Controls belong at the window top: ${JSON.stringify(measured)}`)
        assert.ok(Math.abs(measured.width - controls.right) <= 16, `Controls belong at the window right: ${JSON.stringify(measured)}`)
        const withoutNotice = await evaluate(`(() => {
          const notice = document.querySelector('.home-header .update-notice');
          const display = notice?.style.display;
          if (notice) notice.style.display = 'none';
          const r = document.querySelector('.home-header .window-controls').getBoundingClientRect();
          if (notice) notice.style.display = display;
          return { right: r.right, top: r.top, width: innerWidth };
        })()`)
        assert.ok(Math.abs(withoutNotice.width - withoutNotice.right) <= 16,
          `Home controls stay right after the temporary update notice disappears: ${JSON.stringify(withoutNotice)}`)
      if (restoredOrg) {
        await evaluate(`[...document.querySelectorAll('.org')].find(e => e.textContent.includes(${JSON.stringify(restoredOrg)})).click(); true`)
        assert.equal(await waitFor(`document.querySelector('header.orgbar h2')?.textContent === ${JSON.stringify(restoredOrg)}`), true)
      }
    })
    await check('authenticated-api-positive-and-negative-control', async () => {
      assert.equal(await evaluate(`fetch('/api/orgs').then(r=>r.status)`), 200)
      const stats = await evaluate(`fetch('/api/desktop/status').then(r=>r.json())`)
      assert.equal(typeof stats.idle, 'boolean')
      assert.ok(Number.isInteger(stats.totalAgents) && Number.isInteger(stats.activeAgents))
      const response = await fetch(origin + '/api/orgs', { signal: AbortSignal.timeout(5000) })
      assert.ok([401, 403].includes(response.status), 'Unauthenticated engine request must be denied')
    })
    await check('organization-create-ui-and-restart-persistence', async () => {
      if (phase === 'initial') {
        assert.equal(await evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.includes('new organization'));if(!b)return false;b.click();return true})()`), true)
        assert.equal(await waitFor(`document.querySelector('input[placeholder="organization name"]')`), true)
        await evaluate(`(()=>{const i=document.querySelector('input[placeholder="organization name"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,'Acceptance Runtime');i.dispatchEvent(new Event('input',{bubbles:true}));return true})()`)
        await evaluate(`document.querySelector('input[placeholder="organization name"]').form.requestSubmit();true`)
      }
      if (phase === 'restart' && process.env.ORGTREE_ACCEPTANCE_IMPORT_FIXTURE === '1') {
        assert.equal(await waitFor(`document.querySelector('header.orgbar h2')?.textContent==='Import Demo'`),true,'Last selected imported organization is restored')
        await evaluate(`document.querySelector('header.orgbar button.iconbtn').click();true`)
        assert.equal(await waitFor(`[...document.querySelectorAll('.org')].some(e=>e.textContent.includes('Acceptance Runtime'))`),true)
        await evaluate(`[...document.querySelectorAll('.org')].find(e=>e.textContent.includes('Acceptance Runtime')).click();true`)
      }
      const visibleIdentity = `document.querySelector('header.orgbar h2')?.textContent === 'Acceptance Runtime' || [...document.querySelectorAll('.org')].some(e=>e.textContent.includes('Acceptance Runtime'))`
      assert.equal(await waitFor(visibleIdentity), true, 'Created organization must appear in active header or restored home list')
      rendererTiming.populatedOrg = await evaluate('performance.now()')
      assert.equal(await evaluate(`fetch('/api/orgs/acceptance-runtime').then(r=>r.status)`), 200)
    })
    await check('selected-organization-route-retains-api-and-native-authority', async () => {
      if (phase === 'restart' && !await evaluate(`location.pathname === '/o/acceptance-runtime'`)) await evaluate(`[...document.querySelectorAll('.org')].find(e=>e.textContent.includes('Acceptance Runtime')).click();true`)
      assert.equal(await waitFor(`location.pathname === '/o/acceptance-runtime'`), true)
      assert.equal(await evaluate(`fetch('/api/orgs/acceptance-runtime').then(r=>r.status)`), 200)
      assert.equal((await evaluate('window.orgtreeDesktop.getStatus()')).state, 'ready')
    })
    await check('actual-engine-websocket-handshake', async () => {
      assert.equal(await evaluate(`new Promise(resolve=>{const ws=new WebSocket(location.origin.replace('http:','ws:')+'/api/orgs/acceptance-runtime/ws');const timer=setTimeout(()=>{ws.close();resolve(false)},5000);ws.onopen=()=>{clearTimeout(timer);ws.close();resolve(true)};ws.onerror=()=>{clearTimeout(timer);resolve(false)}})`), true)
    })
    const geometry = () => evaluate(`(()=>{const rect=e=>e?{x:e.getBoundingClientRect().x,y:e.getBoundingClientRect().y,width:e.getBoundingClientRect().width,height:e.getBoundingClientRect().height}:null;return {innerHeight,innerWidth,viewport:rect(document.querySelector('.viewport')),space:{rect:rect(document.querySelector('.space')),transform:document.querySelector('.space')?getComputedStyle(document.querySelector('.space')).transform:null},nodes:[...document.querySelectorAll('.sq')].map(e=>({name:e.querySelector('.name')?.textContent||e.className,rect:rect(e)}))}})()`)
    function assertVisible(measured) {
      assert.ok(measured.nodes.length >= 5, 'Positive control: user, three agents and org inbox must be rendered')
      for(const node of measured.nodes) {
        assert.ok(node.rect.x >= measured.viewport.x - 1 && node.rect.y >= measured.viewport.y - 1 && node.rect.x + node.rect.width <= measured.viewport.x + measured.viewport.width + 1 && node.rect.y + node.rect.height <= measured.viewport.y + measured.viewport.height + 1, `${node.name} must fit inside the graph viewport`)
      }
    }
    if (visualFixture && phase === 'initial') {
      await check('startup-fit-includes-late-org-inbox', async () => {
        assert.equal(await waitFor(`document.querySelector('.sq.orginbox') && [...document.querySelectorAll('.sq .name')].some(e=>e.textContent==='reviewer')`), true)
        await new Promise(resolve => setTimeout(resolve, 1200))
        const before = await geometry()
        fs.writeFileSync(path.join(root, phase + '-geometry-before-fit.json'), JSON.stringify(before,null,2))
        await capture(main, 'organization-before-fit')
        assertVisible(before)
      })
      await check('explicit-fit-positive-control', async () => {
        assert.equal(await evaluate(`(()=>{const button=document.querySelector('button[title="fit the whole org"]');if(!button)return false;button.click();return true})()`), true, 'Actual Fit button must be present and clicked')
        await new Promise(resolve => setTimeout(resolve, 1200))
        const after = await geometry()
        fs.writeFileSync(path.join(root, phase + '-geometry.json'),JSON.stringify(after,null,2))
        await capture(main, 'organization')
        assertVisible(after)
      })
    }
    await check('global-settings-and-org-modal-popout-redock-main-close', async () => {
      if(!visualFixture) await capture(main, 'organization')
      if (!await evaluate(`Boolean(document.querySelector('button[title="App settings"]'))`)) {
        assert.equal(await waitFor(`document.querySelector('header.orgbar button.iconbtn')`), true, 'Active organization menu must be available')
        await evaluate(`document.querySelector('header.orgbar button.iconbtn').click();true`)
      }
      assert.equal(await waitFor(`document.querySelector('button[title="App settings"]')`), true, 'Organization drawer exposes App settings')
      await evaluate(`document.querySelector('button[title="App settings"]').click();true`)
      assert.equal(await waitFor(`document.querySelector('.acct-panel')`), true)
      assert.equal(await evaluate(`Boolean(document.querySelector('.acct-panel button[aria-label="Open in new window"], .acct-panel button[aria-label="Pin"]'))`), false, 'Global app settings cannot pin or pop out')
      if (!visualFixture) await check('managed-account-creation-through-settings', async () => {
        assert.equal(await waitFor(`[...document.querySelectorAll('button')].some(b => b.textContent.trim().toLowerCase() === 'create managed')`), true)
        const before = await evaluate(`fetch('/api/accounts').then(r => r.json()).then(r => r.accounts.length)`)
        await evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.trim().toLowerCase() === 'create managed').click(); true`)
        assert.equal(await waitFor(`document.querySelectorAll('.account-row').length === ${before + 1}`), true,
          'Click must visibly add the managed account row')
        const accounts = await evaluate(`fetch('/api/accounts').then(r => r.json()).then(r => r.accounts)`)
        assert.equal(accounts.length, before + 1, 'Created profile must persist in the actual backend')
        assert.ok(accounts.some(a => a.credential.kind === 'managed'), 'Created account is a managed profile')
      })
      for (const tab of ['Display', 'Import', 'Runtime']) {
        assert.equal(await evaluate(`(()=>{const b=[...document.querySelectorAll('[role="tab"]')].find(b=>b.textContent.startsWith('${tab}'));if(!b)return false;b.click();return true})()`), true)
        await capture(main, 'settings-' + tab.toLowerCase())
        if (tab === 'Display') await check('custom-theme-picker-persists-chosen-color', async () => {
          assert.equal(await waitFor(`document.querySelector('select[aria-label="Visual theme"]:not(:disabled)')`), true)
          const previous = (await evaluate('window.orgtreeDesktop.getPreferences()')).visualTheme
          await evaluate(`(()=>{const s=document.querySelector('select[aria-label="Visual theme"]');s.value='custom';s.dispatchEvent(new Event('change',{bubbles:true}));return true})()`)
          assert.equal(await waitFor(`document.querySelector('input[aria-label="Custom theme color"]:not(:disabled)')`), true)
          await evaluate(`(()=>{const input=document.querySelector('input[aria-label="Custom theme color"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'#8435cf');input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));return true})()`)
          assert.equal(await waitFor(`getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()==='#8435cf'`), true)
          assert.equal((await evaluate('window.orgtreeDesktop.getPreferences()')).visualTheme,'custom:#8435cf')
          await evaluate(`(()=>{const s=document.querySelector('select[aria-label="Visual theme"]');s.value=${JSON.stringify(previous)};s.dispatchEvent(new Event('change',{bubbles:true}));return true})()`)
          assert.equal(await waitFor(`!document.querySelector('input[aria-label="Custom theme color"]')`), true)
        })
        if (tab === 'Display' && visualFixture) await check('native-theme-selector-keeps-provider-status', async () => {
          assert.equal(await waitFor(`document.querySelector('select[aria-label="Visual theme"]:not(:disabled)')`), true)
          const labels = await evaluate(`Array.from(document.querySelectorAll('.sq .name,.sq .status')).map(e=>e.textContent)`)
          for (const theme of ['orgtree','openrouter']) {
            await evaluate(`(()=>{const s=document.querySelector('select[aria-label="Visual theme"]');s.value='${theme}';s.dispatchEvent(new Event('change',{bubbles:true}));return true})()`)
            assert.equal(await waitFor(`!document.querySelector('select[aria-label="Visual theme"]').disabled`), true)
            assert.equal((await evaluate('window.orgtreeDesktop.getPreferences()')).visualTheme,theme)
            assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('.sq .name,.sq .status')).map(e=>e.textContent)`),labels)
            await capture(main,'theme-'+theme+'-display')
          }
        })
        if (tab === 'Import' && phase === 'initial' && process.env.ORGTREE_ACCEPTANCE_IMPORT_FIXTURE === '1') await check('actual-settings-import-copy', () => require('./import_flow.cjs').copy({root,evaluate,waitFor,capture,main,assert}))
      }
      await evaluate(`[...document.querySelectorAll('.acct-panel button')].find(b=>b.textContent==='close').click(); true`)
      assert.equal(await waitFor(`!document.querySelector('.acct-panel')`), true)
      await evaluate(`[...document.querySelectorAll('header.orgbar button')].find(b=>b.textContent==='Connections').click(); true`)
      assert.equal(await waitFor(`document.querySelector('.modalpin-win button[aria-label="Open in new window"]')`), true, 'Org panel retains popout action')
      const before = new Set(BrowserWindow.getAllWindows().map(w => w.id))
      const mainStyle = await evaluate(`(()=>{const s=getComputedStyle(document.querySelector('.modalpin-win'));return {background:s.backgroundColor,color:s.color,font:s.fontFamily}})()`)
      await evaluate(`(()=>{const b=document.querySelector('button[aria-label="Open in new window"]');window.__acceptanceSurface=b.closest('.movable-surface');b.click();return true})()`)
      const child = BrowserWindow.getAllWindows().find(w => !before.has(w.id))
      assert.ok(child, 'Actual modal action must create a native child')
      assert.equal(await waitFor(`window.__acceptanceSurface.ownerDocument !== document`), true)
      assert.equal(await child.webContents.executeJavaScript('typeof window.orgtreeDesktop'), 'undefined')
      fs.writeFileSync(path.join(root, phase + '-popout-state.json'), JSON.stringify({visible:child.isVisible(), bounds:child.getBounds(), loading:child.webContents.isLoading(), url:child.webContents.getURL()}))
      const styleState = await child.webContents.executeJavaScript(`({panel:(()=>{const s=getComputedStyle(document.querySelector('.modalpin-win'));return {background:s.backgroundColor,color:s.color,font:s.fontFamily}})(),bodyStyle:{background:getComputedStyle(document.body).backgroundColor,font:getComputedStyle(document.body).fontFamily},links:[...document.querySelectorAll('link')].map(e=>({href:e.href,rel:e.rel,sheet:Boolean(e.sheet)})),sheets:document.styleSheets.length})`)
      fs.writeFileSync(path.join(root, phase + '-popout-styles.json'), JSON.stringify(styleState, null, 2))
      await check('native-popout-retains-stylesheets', async () => {
        assert.notEqual(mainStyle.font, '"Times New Roman"', 'Main panel positive control must have app styling')
        assert.deepEqual(styleState.panel, mainStyle, 'Adopted Connections must retain its rendered styles')
      })
      await check('capture-native-org-popout', () => capture(child, 'connections-popout'))
      main.close()
      assert.equal(main.isVisible(), false)
      assert.equal(child.isDestroyed(), false)
      assert.equal(await evaluate(`fetch('/api/desktop/status').then(r=>r.status)`), 200)
      await evaluate('window.orgtreeDesktop.showMainWindow()')
      child.close()
      assert.equal(await waitFor(`window.__acceptanceSurface.ownerDocument === document && document.contains(window.__acceptanceSurface)`), true)
      await evaluate(`[...document.querySelectorAll('.modalpin-win button')].find(b=>b.textContent==='close').click(); true`)
    })
    if (visualFixture) await check('populated-graph-desk-document-connections-rendering', async () => {
      await evaluate(`[...document.querySelectorAll('.acct-panel button')].find(b=>b.textContent==='close')?.click();true`)
      await evaluate(`document.querySelector('header.orgbar button.iconbtn')?.click();true`)
      assert.equal(await waitFor(`document.querySelector('[title="open presented documents for planner"]')`), true)
      await evaluate(`document.querySelector('[title="open presented documents for planner"]').click();true`)
      assert.equal(await waitFor(`document.querySelector('.doc-gallery-row')`), true)
      await evaluate(`document.querySelector('.doc-gallery-row').click();true`)
      assert.equal(await waitFor(`document.querySelector('.mailer-body')?.textContent.includes('isolated synthetic organization')`), true)
      await capture(main, 'document-reader')
      await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));true`)
      await evaluate(`[...document.querySelectorAll('header.orgbar button')].find(b=>b.textContent==='Connections')?.click();true`)
      assert.equal(await waitFor(`[...document.querySelectorAll('h3')].some(h=>h.textContent==='Connections')`), true)
      await capture(main, 'connections')
      await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));true`)
      assert.equal(await evaluate(`(()=>{const card=[...document.querySelectorAll('.sq')].find(e=>e.querySelector('.name')?.textContent==='planner');if(!card)return false;const r=card.getBoundingClientRect();card.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:r.x+30,clientY:r.y+30}));return true})()`), true)
      await capture(main, 'agent-context-menu')
      assert.equal(await evaluate(`(()=>{const button=[...document.querySelectorAll('button')].find(b=>b.textContent==='Open desk');if(!button)return false;button.click();return true})()`), true)
      assert.equal(await waitFor(`document.querySelector('.desk-body')`), true)
      await capture(main, 'agent-desk')
    })
    const key = 'orgtree-draft-v2-' + JSON.stringify(['acceptance', 'idle-fixture', 0])
    const values = { [key]: 'Acceptance unsent draft', [key + '-attachments']: JSON.stringify([{ name: 'retained.txt', path: 'uploads/retained.txt', bytes: 8 }]),
      [key + '-reply']: JSON.stringify({ org: 'acceptance', agent: 'idle-fixture', generation: 0, eventId: 'acceptance-source', quote: 'Retained source quote' }) }
    if (phase === 'initial') {
      await check('draft-storage-positive-control', async () => {
        const roundtrip = await evaluate(`(()=>{const v=${JSON.stringify(values)}; for(const [k,s] of Object.entries(v))localStorage.setItem(k,s); return Object.fromEntries(Object.keys(v).map(k=>[k,localStorage.getItem(k)]))})()`)
        assert.deepEqual(roundtrip, values)
        fs.writeFileSync(path.join(root, 'origin.json'), JSON.stringify({ origin }))
      })
    } else {
      await check('draft-text-attachment-reply-survive-engine-restart', async () => {
        const recovered = await evaluate(`Object.fromEntries(${JSON.stringify(Object.keys(values))}.map(k=>[k,localStorage.getItem(k)]))`)
        assert.deepEqual(recovered, values, 'Previously proven draft storage must remain available after a full engine restart')
      })
    }
    await check('main-close-keeps-engine-and-reopen', async () => {
      main.close()
      assert.equal(main.isDestroyed(), false)
      assert.equal(main.isVisible(), false)
      assert.equal(await evaluate(`fetch('/api/desktop/status').then(r=>r.status)`), 200)
      await evaluate('window.orgtreeDesktop.showMainWindow()')
      assert.equal(main.isVisible(), true)
    })
    if (phase === 'initial' && process.env.ORGTREE_ACCEPTANCE_IMPORT_FIXTURE === '1') await check('imported-history-and-document-rendering', () => require('./import_flow.cjs').read({root,evaluate,waitFor,capture,main,assert}))
    finish()
  })
})
require(path.join(appPath, 'dist/main/index.cjs'))
