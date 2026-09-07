// Loads the actual built entrypoint; no replacement engine, renderer or preload.
// Instrumentation selects an isolated profile, observes windows/child readiness,
// acknowledges native informational dialogs and drives Chromium's real DOM.
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const cp = require('node:child_process')
const { app, BrowserWindow, dialog } = require('electron')
const root = fs.realpathSync(process.env.ORGTREE_ACCEPTANCE_ROOT)
const target = fs.realpathSync(process.env.ORGTREE_ACCEPTANCE_APP)
const phase = process.env.ORGTREE_ACCEPTANCE_PHASE
assert.ok(['initial', 'restart'].includes(phase))
const data = fs.realpathSync(path.join(root, 'data'))
assert.equal(fs.realpathSync(process.env.ORGTREE_DATA), data)
assert.equal(fs.realpathSync(process.env.ORGTREE_V2_DATA), data)
app.setPath('userData', path.join(root, 'profile'))
app.setAppPath(target)
const rows = [], children = [], handshakes = []
let ready = false, finishing = false, launched = false
const spawn = cp.spawn
cp.spawn = function(command, args, options) {
  if (args?.some(arg => String(arg).endsWith('launch.py'))) {
    assert.equal(fs.realpathSync(options.env.ORGTREE_DATA), data)
    assert.equal(fs.realpathSync(args[0]), fs.realpathSync(path.join(target, 'engine/launch.py')))
    launched = true
  }
  const child = spawn.call(this, command, args, options)
  children.push(child)
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
    rows.push({ name: 'native-startup-dialog', status: 'FAIL', reason: 'Application displayed an error dialog' })
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
  fs.writeFileSync(path.join(root, phase + '.json'), JSON.stringify({ status, ready, checks: rows }, null, 2))
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
    const origin = new URL(main.webContents.getURL()).origin
    await check('real-engine-readiness-root-pid-port', async () => {
      assert.equal(launched, true)
      assert.equal(handshakes.length, 1)
      const h = handshakes[0]
      assert.equal(h.protocol, 1)
      assert.equal(fs.realpathSync(h.dataRootId), data)
      assert.ok(children.some(c => c.pid === h.pid))
      assert.equal(Number(new URL(origin).port), h.port)
      assert.notEqual(h.port, 7360)
    })
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
