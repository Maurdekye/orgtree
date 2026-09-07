// Loads the actual built entrypoint; no replacement engine, renderer or preload.
// Instrumentation selects an isolated profile, observes windows/child readiness,
// acknowledges native informational dialogs and drives Chromium's real DOM.
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const cp = require('node:child_process')
const { app, BrowserWindow, dialog } = require('electron')
const root = fs.realpathSync.native(process.env.ORGTREE_ACCEPTANCE_ROOT)
const target = fs.realpathSync.native(process.env.ORGTREE_ACCEPTANCE_APP)
const phase = process.env.ORGTREE_ACCEPTANCE_PHASE
assert.ok(['initial', 'restart'].includes(phase))
const data = fs.realpathSync.native(path.join(root, 'data'))
// The shell treats an inherited ORGTREE_DATA as a forbidden v1 root and replaces
// it for its child. Point even this inherited selector at a fresh empty fixture.
assert.equal(fs.realpathSync.native(process.env.ORGTREE_DATA), fs.realpathSync.native(path.join(root, 'inherited-v1')))
assert.equal(fs.realpathSync.native(process.env.ORGTREE_V2_DATA), data)
app.setPath('userData', path.join(root, 'profile'))
app.setAppPath(target)
const rows = [], children = [], handshakes = [], diagnostics = []
let ready = false, finishing = false, launched = false
const spawn = cp.spawn
cp.spawn = function(command, args, options) {
  if (args?.some(arg => String(arg).endsWith('launch.py'))) {
    if (fs.realpathSync.native(options.env.ORGTREE_DATA) !== data) {
      diagnostics.push('Acceptance instrumentation refused mismatched spawn data root')
      throw new Error('Acceptance spawn root mismatch')
    }
    if (fs.realpathSync.native(args[0]) !== fs.realpathSync.native(path.join(target, 'engine/launch.py'))) {
      diagnostics.push('Acceptance instrumentation refused mismatched launcher path')
      throw new Error('Acceptance launcher mismatch')
    }
    launched = true
  }
  const child = spawn.call(this, command, args, options)
  children.push(child)
  child.stderr?.on('data', chunk => {
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
  catch (error) { rows.push({ name, status: 'FAIL', reason: error instanceof assert.AssertionError ? error.message : 'Runtime operation failed (' + error.name + ')' }) }
}
function finish() {
  if (finishing) return
  finishing = true
  clearTimeout(deadline)
  const status = ready && rows.length > 0 && rows.every(r => r.status === 'PASS') ? 'PASS' : 'FAIL'
  fs.writeFileSync(path.join(root, phase + '.json'), JSON.stringify({ status, ready, checks: rows, diagnostics, childPids: children.map(c => c.pid).filter(Boolean) }, null, 2))
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
    })
    await check('native-bridge-and-defaults', async () => {
      assert.deepEqual(await evaluate('window.orgtreeDesktop.getStatus()'), { state: 'ready' })
      const prefs = await evaluate('window.orgtreeDesktop.getPreferences()')
      assert.equal(prefs.exitOnClose, false)
      assert.equal(prefs.startAtLogin, true)
      assert.equal(await evaluate('typeof require'), 'undefined')
    })
    await check('authenticated-api-positive-and-negative-control', async () => {
      assert.equal(await evaluate(`fetch('/api/orgs').then(r=>r.status)`), 200)
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
      assert.equal(await waitFor(`[...document.querySelectorAll('.org')].some(e=>e.textContent.includes('Acceptance Runtime'))`), true)
      assert.equal(await evaluate(`fetch('/api/orgs/acceptance-runtime').then(r=>r.status)`), 200)
    })
    await check('selected-organization-route-retains-api-and-native-authority', async () => {
      if (phase === 'restart') await evaluate(`[...document.querySelectorAll('.org')].find(e=>e.textContent.includes('Acceptance Runtime')).click();true`)
      assert.equal(await waitFor(`location.pathname === '/o/acceptance-runtime'`), true)
      assert.equal(await evaluate(`fetch('/api/orgs/acceptance-runtime').then(r=>r.status)`), 200)
      assert.equal((await evaluate('window.orgtreeDesktop.getStatus()')).state, 'ready')
    })
    await check('actual-engine-websocket-handshake', async () => {
      assert.equal(await evaluate(`new Promise(resolve=>{const ws=new WebSocket(location.origin.replace('http:','ws:')+'/api/orgs/acceptance-runtime/ws');const timer=setTimeout(()=>{ws.close();resolve(false)},5000);ws.onopen=()=>{clearTimeout(timer);ws.close();resolve(true)};ws.onerror=()=>{clearTimeout(timer);resolve(false)}})`), true)
    })
    await check('actual-settings-modal-popout-redock-main-close', async () => {
      assert.equal(await evaluate(`(()=>{const b=document.querySelector('button[title="App settings"]');if(!b)return false;b.click();return true})()`), true)
      assert.equal(await waitFor(`document.querySelector('button[aria-label="Open in new window"]')`), true)
      const before = new Set(BrowserWindow.getAllWindows().map(w => w.id))
      await evaluate(`(()=>{const b=document.querySelector('button[aria-label="Open in new window"]');window.__acceptanceSurface=b.closest('.movable-surface');b.click();return true})()`)
      const child = BrowserWindow.getAllWindows().find(w => !before.has(w.id))
      assert.ok(child, 'Actual modal action must create a native child')
      assert.equal(await waitFor(`window.__acceptanceSurface.ownerDocument !== document`), true)
      assert.equal(await child.webContents.executeJavaScript('typeof window.orgtreeDesktop'), 'undefined')
      main.close()
      assert.equal(main.isVisible(), false)
      assert.equal(child.isDestroyed(), false)
      assert.equal(await evaluate(`fetch('/api/desktop/status').then(r=>r.status)`), 200)
      await evaluate('window.orgtreeDesktop.showMainWindow()')
      child.close()
      assert.equal(await waitFor(`window.__acceptanceSurface.ownerDocument === document && document.contains(window.__acceptanceSurface)`), true)
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
    finish()
  })
})
require(path.join(target, 'dist/main/index.cjs'))
