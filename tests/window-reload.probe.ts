/** Real Electron ordering with production preload, held handlers, registry,
 * outbox, navigation lifecycle and recovery. The renderer is a receipt-only
 * listener; full App action evidence belongs to app-composition.probe.ts.
 * No engine, installed application or live profile is used. */
import { app, BrowserWindow, ipcMain } from 'electron'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { registerHeldEventChannels } from '../apps/desktop/main/held-events'
import { orgWindowRegistry } from '../apps/desktop/main/org-windows'
import { windowOutbox } from '../apps/desktop/main/window-outbox'
import { attachWindowEventLifecycle } from '../apps/desktop/main/window-event-lifecycle'
import { attachWindowLoadRecovery } from '../apps/desktop/main/window-load-recovery'

const root = process.env.PROBE_ROOT!
for (const key of ['userData', 'sessionData', 'cache', 'temp', 'logs', 'crashDumps'] as const) {
  const dir = path.join(root, key)
  fs.mkdirSync(dir, { recursive: true })
  app.setPath(key, dir)
}
app.disableHardwareAcceleration()
app.on('window-all-closed', () => {})
const trace: unknown[] = [], passed: string[] = []
const wait = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(check: () => boolean | Promise<boolean>, description: string) {
  const end = Date.now() + 8000
  while (Date.now() < end) { if (await check()) return; await wait(10) }
  throw new Error('Timed out: ' + description)
}
type E = { type: string; data?: unknown }
const document = `<!doctype html><meta charset="utf-8"><title>reload probe</title>
<body><script>
window.received = []; window.doc = crypto.randomUUID(); window.acks = 0;
window.listen = () => { window.acks++; window.orgtreeDesktop.onEvent(e => window.received.push(e)); };
if (!location.search.includes('idle')) window.listen();
</script></body>`

app.whenReady().then(async () => {
  let next: 'serve' | 'stall' | 'fail' | 'truncate' = 'serve'
  const stalled: http.ServerResponse[] = []
  let truncated: http.ServerResponse | undefined
  let requests = 0
  const server = http.createServer((req, res) => {
    if (req.url === '/favicon.ico') { res.writeHead(204); res.end(); return }
    if (req.url === '/bad-frame') { req.socket.destroy(); return }
    requests++
    const mode = next; next = 'serve'
    if (mode === 'stall') { stalled.push(res); return }
    if (mode === 'fail') { req.socket.destroy(); return }
    if (mode === 'truncate') {
      // Commit a real app-path response and run its preload, but never deliver
      // the application script. The test closes it only after observing commit.
      res.writeHead(200, { 'content-type': 'text/html', 'content-length': '100000', 'cache-control': 'no-store' })
      res.write('<!doctype html><body><div id="root">Loading...</div>' + ' '.repeat(4096))
      truncated = res
      return
    }
    res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' }); res.end(document)
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const release = () => { for (const res of stalled.splice(0)) {
    if (!res.destroyed) { res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' }); res.end(document) }
  } }
  const registry = orgWindowRegistry<BrowserWindow, E>()
  const window = new BrowserWindow({ show: false, webPreferences: {
    contextIsolation: true, sandbox: false, nodeIntegration: false,
    preload: path.join(root, 'preload.cjs'), additionalArguments: ['--orgtree-ui-origin=' + origin],
  } })
  const wc = window.webContents
  const record = { documentToken: '', outbox: windowOutbox<E>({ hold: t => t === 'notification-click' }) }
  registry.register({ id: 'probe', senderId: wc.id, window, kind: 'org', org: 'studio' })
  const handlers = new Map<string, (...args: any[]) => any>()
  registerHeldEventChannels({
    on: (channel, fn) => { handlers.set(channel, fn); return ipcMain.on(channel, fn) },
    handle: (channel, fn) => { handlers.set(channel, fn); ipcMain.handle(channel, fn) },
  }, {
    origin: () => origin, registry, record: () => record,
    token: r => r.documentToken, setToken: (r, t) => { r.documentToken = t; trace.push({ event: 'mint' }) },
    drain: r => r.outbox.drain(), send: (_r, e) => wc.send('desktop:event', e),
  })
  // Trace listeners are installed before production to capture entry state.
  let starts = 0, commits = 0, stops = 0, subFailures = 0
  wc.on('did-start-navigation', d => {
    if (d.isMainFrame && !d.isSameDocument) starts++
    trace.push({ event: 'start', main: d.isMainFrame, same: d.isSameDocument, url: d.url.slice(0, 100) })
  })
  wc.on('did-navigate', (_e, url) => { commits++; trace.push({ event: 'commit', url: url.slice(0, 100) }) })
  wc.on('did-finish-load', () => { trace.push({ event: 'finish', url: wc.getURL().slice(0, 100) }) })
  wc.on('did-stop-loading', () => { stops++; trace.push({ event: 'stop', loadingMain: wc.isLoadingMainFrame() }) })
  wc.on('did-fail-load', (_e, code, _desc, url, main) => {
    if (!main) subFailures++
    trace.push({ event: 'failure', code, main, url })
  })
  const lifecycle = attachWindowEventLifecycle(wc, record, e => wc.send('desktop:event', e))
  let timer: (() => void) | undefined, holdingPages = 0, retryLoads: string[] = []
  const recovery = attachWindowLoadRecovery(wc, {
    target: () => origin, builtFor: () => origin, route: () => '/o/studio',
    load: async url => { retryLoads.push(url); await window.loadURL(url) },
    showHolding: async html => { holdingPages++; await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html)) },
    documentLost: lifecycle.documentLost,
    record: (stage, detail) => trace.push({ event: stage, detail }),
    setTimer: fn => { timer = fn; return fn }, clearTimer: () => { timer = undefined },
  }, () => wc.getURL())
  // WebContents.executeJavaScript waits for loading to stop. The real old
  // frame can still run script during a stalled provisional navigation.
  const js = (code: string) => wc.mainFrame.executeJavaScript(code)
  const seen = async () => await js('({doc: window.doc, events: window.received, acks: window.acks, url: location.href})')
  const ready = () => until(async () => !!record.documentToken && !record.outbox.holding()
    && !!await js('window.doc'), 'renderer acknowledgement')
  const reveal = (n: number) => { const e = { type: 'notification-click', data: n }; if (record.outbox.offer(e)) wc.send('desktop:event', e) }
  const expectEvents = (values: number[]) => until(async () =>
    JSON.stringify((await seen()).events.map((e: E) => e.data)) === JSON.stringify(values), 'receipt ' + values)
  async function stallReload() {
    const before = { starts, commits, requests, stops }
    next = 'stall'; wc.reload()
    await until(() => starts > before.starts && requests > before.requests, 'stalled reload request')
    assert.equal(commits, before.commits)
    assert.equal(wc.isLoadingMainFrame(), true)
    return before
  }
  try {
    await window.loadURL(origin + '/o/studio'); await ready()
    const old = await seen(), oldToken = record.documentToken
    await stallReload(); reveal(1)
    assert.equal(record.outbox.pending(), 1)
    // The old document can still acknowledge/take during the provisional gap.
    await js('window.orgtreeDesktop.onEvent(() => {}); true')
    assert.deepEqual(await js('window.orgtreeDesktop.takePendingWindowEvents()'), [])
    assert.deepEqual((await seen()).events, [])
    release(); await ready(); await expectEvents([1])
    assert.notEqual((await seen()).doc, old.doc)
    assert.notEqual(record.documentToken, oldToken)
    passed.push('same-URL reload retains reveal for replacement document; provisional ack/take cannot drain')

    const beforeStop = await seen(), stopToken = record.documentToken
    const stopped = await stallReload(); reveal(2); wc.stop()
    await until(() => stops > stopped.stops && !wc.isLoadingMainFrame(), 'stop completion')
    await expectEvents([1, 2])
    assert.equal((await seen()).doc, beforeStop.doc)
    assert.equal((await seen()).acks, beforeStop.acks)
    assert.equal(record.documentToken, stopToken)
    assert.equal(recovery.isFailed, false)
    release(); passed.push('cancel/stop resumes existing listener without re-acknowledgement')

    // A superseded load must not release the held queue into the old document.
    await stallReload(); reveal(3)
    const supersededStarts = starts, supersededRequests = requests
    next = 'stall'
    const replacement = window.loadURL(origin + '/o/studio?replacement=1').catch(() => {})
    await until(() => starts > supersededStarts && requests > supersededRequests, 'successor provisional navigation')
    assert.equal(record.outbox.pending(), 1)
    assert.deepEqual((await seen()).events.map((e: E) => e.data), [1, 2])
    release(); await replacement; await ready(); await expectEvents([3])
    passed.push('supersession retains reveal until successor listener')

    const sameDoc = await seen(), sameToken = record.documentToken, sameCommits = commits
    await js("history.pushState(null, '', '/o/studio#same'); true")
    reveal(4); await expectEvents([3, 4])
    assert.equal(commits, sameCommits); assert.equal(record.documentToken, sameToken)
    assert.equal((await seen()).doc, sameDoc.doc)
    await js("let f = document.createElement('iframe'); f.src = '/bad-frame'; document.body.append(f); true")
    await until(() => subFailures > 0, 'real subframe failure')
    reveal(5); await expectEvents([3, 4, 5])
    assert.equal(record.documentToken, sameToken); assert.equal(recovery.isFailed, false)
    passed.push('same-document navigation and real subframe failure preserve live delivery')

    // The production guard is exercised against a real current frame, quoting
    // a genuinely obsolete token captured before the reload. No copied guard.
    record.outbox.rearm(); reveal(6)
    const event = { sender: wc, senderFrame: wc.mainFrame }
    handlers.get('desktop:events-listening')!(event, oldToken)
    assert.deepEqual(handlers.get('desktop:take-pending-events')!(event, oldToken), [])
    assert.equal(record.outbox.pending(), 1)
    await js('window.orgtreeDesktop.onEvent(() => {}); true')
    await expectEvents([3, 4, 5, 6])
    passed.push('stale ack and take cannot consume successor queue; current preload can')

    // Server emits a terminal transport failure. Production recovery shows its
    // real holding page and retries the same org route using a controlled clock.
    const failedToken = record.documentToken
    const failureTraceStart = trace.length
    next = 'fail'; wc.reload()
    await until(() => recovery.isFailed && !!timer && wc.getURL().startsWith('data:'), 'terminal holding page and retry')
    assert.equal(record.documentToken, '')
    reveal(7)
    handlers.get('desktop:events-listening')!({ sender: wc, senderFrame: wc.mainFrame }, failedToken)
    assert.deepEqual(handlers.get('desktop:take-pending-events')!({ sender: wc, senderFrame: wc.mainFrame }, failedToken), [])
    assert.equal(record.outbox.pending(), 1)
    const fire = timer!; timer = undefined; fire()
    await ready(); await expectEvents([7])
    assert.equal(wc.getURL(), origin + '/o/studio')
    assert.deepEqual(retryLoads, [origin + '/o/studio'])
    assert.equal(recovery.isStranded, false); assert.equal(recovery.isFailed, false)
    const recoveryTrace = trace.slice(failureTraceStart) as { event: string; url?: string }[]
    const recoveredAt = recoveryTrace.findIndex(e => e.event === 'window-load-recovered')
    const committedAt = recoveryTrace.findIndex(e => e.event === 'commit' && e.url === origin + '/o/studio')
    const finishedAt = recoveryTrace.findIndex(e => e.event === 'finish' && e.url === origin + '/o/studio')
    assert.ok(committedAt >= 0 && finishedAt > committedAt && recoveredAt > finishedAt,
      'only committed UI finish may record recovery, never error-page finish or loadURL resolution')
    passed.push('terminal failure retains reveal through holding page and real routed retry')

    const recovered = await seen(), recoveredToken = record.documentToken, pageCount = holdingPages
    // Deliberately delayed stale failure injected AFTER real recovery. Electron
    // normally reports it earlier; injection checks the required ordering guard.
    wc.emit('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', origin + '/o/studio', true)
    await wait(50)
    reveal(8); await expectEvents([7, 8])
    assert.equal(record.documentToken, recoveredToken)
    assert.equal((await seen()).doc, recovered.doc)
    assert.equal(holdingPages, pageCount); assert.equal(recovery.isFailed, false)
    passed.push('injected late same-URL terminal failure leaves recovered document and delivery intact')

    const beforeTruncation = { commits, token: record.documentToken }
    next = 'truncate'; wc.reload()
    await until(() => commits > beforeTruncation.commits && !!record.documentToken
      && record.documentToken !== beforeTruncation.token, 'truncated response commits and mints token')
    assert.equal(await js('document.querySelector("#root")?.textContent'), 'Loading...')
    assert.equal(await js('typeof window.received'), 'undefined', 'application listener never mounted')
    reveal(9)
    assert.equal(record.outbox.pending(), 1)
    truncated!.destroy()
    await until(() => recovery.isFailed && !!timer && wc.getURL().startsWith('data:'), 'committed truncation holding page and retry')
    assert.ok((trace as { event: string; code?: number }[]).some(e => e.event === 'failure' && e.code === -354),
      'real Content-Length truncation produced ERR_CONTENT_LENGTH_MISMATCH')
    assert.equal(record.documentToken, '')
    assert.equal(record.outbox.pending(), 1)
    const retryTruncation = timer!; timer = undefined; retryTruncation()
    await ready(); await expectEvents([9])
    assert.equal(wc.getURL(), origin + '/o/studio')
    assert.equal(recovery.isFailed, false)
    passed.push('committed response truncation before App mount recovers and delivers the retained reveal')
    fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify({ ok: true, passed, trace }, null, 2))
  } catch (error) {
    fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify({ ok: false, error: String((error as Error).stack), passed, trace }, null, 2))
    process.exitCode = 1
  } finally {
    recovery.dispose(); release(); window.destroy(); server.closeAllConnections(); server.close()
    app.exit(process.exitCode ?? 0)
  }
}).catch(error => {
  fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify({ ok: false, error: String(error), trace }))
  app.exit(1)
})
