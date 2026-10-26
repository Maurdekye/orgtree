'use strict'
// Capture and isolation proof for inline HTML presentations (docket
// 4-5-0-render-html-presentations-inline-in-the-pr). Electron main process:
// serves the Presented documents fixture (htmlpresentation-ui.tsx) and its
// synthetic presentations from a local server, installs the desktop's own
// session guard (main/windows.ts configureEngineSession, bundled from this
// checkout) and drives one offscreen window by CDP input only.
//
// Evidence in HTMLP_OUT: PNGs plus capture.json with frame geometry, in-frame
// probe results, every request the server saw (and whether it carried the
// desktop token), frame navigation/load-failure events, process session IDs
// and renderer memory.
//
// Run from the repository root, in Session 0 under the build permit
// (docs/agents/development-and-verification.md, test-window isolation):
//   set HTMLP_OUT=C:\orgtree-build\<agent>\<folder>   (required, owned)
//   set HTMLP_NODE_MODULES=<existing node_modules>   (default ./node_modules)
//   <node_modules>\electron\dist\electron.exe apps\desktop\renderer\tests\htmlpresentation-capture.cjs
// No clipboard use; permissions follow the real guard (all denied here).
const { app, BrowserWindow, session } = require('electron')
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), cp = require('node:child_process')

const REPO = process.cwd()
const OUT = process.env.HTMLP_OUT || ''
const NM = process.env.HTMLP_NODE_MODULES || path.join(REPO, 'node_modules')
const SLUG = 'synthetic-presentations', TOKEN = 'capture-token-' + process.pid
const LIMIT = 4 * 1024 * 1024
const AT = Date.UTC(2026, 9, 26, 20)
const receipt = { started: new Date().toISOString(), requests: [], windowOpens: [], frameNavigations: [],
  frameLoadFailures: [], console: [], shots: [], checks: {}, memory: [], problems: [] }
const fail = (e) => { console.error(e && e.stack || e); app.exit(1) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** The synthetic presentations, newest first. `port` is the sentinel's. */
function presentations(port) {
  const sentinel = `http://127.0.0.1:${port}/sentinel`
  const card = (i) => `<div class="card"><span>Metric ${i}</span><b>${(i * 37) % 100}%</b><div class="bar"><i style="width:${(i * 37) % 100}%"></i></div></div>`
  const wide = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Release dashboard</title><style>
body{margin:0;font:14px system-ui,sans-serif;background:#f4f6fa;color:#1d2433}
.board{width:1600px;padding:24px;box-sizing:border-box}h1{margin:0 0 16px;font-size:28px}
.cards{display:grid;grid-template-columns:repeat(6,1fr);gap:16px}
.card{background:#fff;border-radius:10px;padding:16px;box-shadow:0 1px 3px rgba(0,0,0,.15)}
.card b{display:block;font-size:30px;margin-top:6px}.bar{height:12px;background:#dde3ee;border-radius:6px;margin-top:10px}
.bar i{display:block;height:100%;border-radius:6px;background:#3b6fe0}
.edge{margin-top:18px;display:flex;justify-content:space-between;font-weight:700;color:#b42318}
</style></head><body><div class="board" id="board"><h1>Release dashboard, 1600 px wide</h1>
<div class="cards">${[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(card).join('')}</div>
<div class="edge"><span>&#9664; left edge</span><span>right edge &#9654;</span></div></div></body></html>`
  const narrow = `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>
body{margin:0;font:15px system-ui,sans-serif;background:#fff;color:#1d2433}
.card{max-width:420px;margin:24px auto;padding:20px;border:1px solid #d0d7e2;border-radius:12px}
input{display:block;width:100%;box-sizing:border-box;margin:8px 0 12px;padding:8px}
button{padding:8px 16px;border:0;border-radius:6px;background:#3b6fe0;color:#fff}
</style></head><body><div class="card" id="narrow"><h2>Narrow sign-up card</h2>
<p>At most 420 px wide, so Fit width leaves it at its actual size.</p>
<label>Email<input placeholder="you@example.com"></label><button>Join</button></div></body></html>`
  const interactive = `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>
body{margin:0;padding:16px 20px;font:15px system-ui,sans-serif;background:#fffdf6;color:#1d2433}
button{font:inherit;padding:6px 14px;border:1px solid #9aa6b8;border-radius:6px;background:#fff;cursor:pointer}
#count{font-size:18px;padding:10px 18px;background:#e8f0ff}.tabs{margin:14px 0 8px;display:flex;gap:6px}
.tabs .on{background:#1d2433;color:#fff}.pane{padding:12px;border:1px dashed #9aa6b8;border-radius:6px}
</style></head><body><h2>Interactive presentation</h2>
<button id="count">Clicked 0 times</button>
<div class="tabs"><button data-tab="a" class="on">Overview</button><button data-tab="b">Details</button></div>
<div id="tab-a" class="pane">Overview pane</div><div id="tab-b" class="pane" hidden>Details pane, switched by the presentation's own script</div>
<p><a id="external" href="${sentinel}/link">A link to another page (does nothing here)</a> &middot; <a id="jump" href="#section-3">Jump to section 3</a></p>
<div style="height:900px"></div><h3 id="section-3">Section 3</h3>
<script>let n=0;const count=document.getElementById('count');count.onclick=()=>{n++;count.textContent='Clicked '+n+(n===1?' time':' times')};
document.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>{document.querySelectorAll('[data-tab]').forEach(x=>x.classList.toggle('on',x===b));
document.querySelectorAll('.pane').forEach(p=>{p.hidden=p.id!=='tab-'+b.dataset.tab})})</script></body></html>`
  const network = `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>
body{margin:0;padding:16px 20px;font:14px system-ui,sans-serif;background:#fff;color:#1d2433}li{margin:3px 0}
</style></head><body><h2>Network and isolation probe</h2><ul id="results"></ul>
<script>
const out=(k,v)=>{const li=document.createElement('li');li.id='r-'+k;li.textContent=k+': '+v;document.getElementById('results').append(li)}
const violations=[];document.addEventListener('securitypolicyviolation',e=>violations.push(e.violatedDirective+' '+e.blockedURI))
fetch('${sentinel}/fetch').then(()=>out('fetch','REACHED'),e=>out('fetch','blocked ('+e.name+')'))
fetch('http://127.0.0.1:${port}/api/orgs/${SLUG}/documents').then(()=>out('app-api','REACHED'),e=>out('app-api','blocked ('+e.name+')'))
const img=new Image();img.onload=()=>out('image','REACHED');img.onerror=()=>out('image','blocked');img.src='${sentinel}/image.png'
try{const ws=new WebSocket('ws://127.0.0.1:${port}/sentinel/ws');ws.onopen=()=>out('websocket','REACHED');ws.onerror=()=>out('websocket','blocked')}catch(e){out('websocket','blocked ('+e.name+')')}
setTimeout(()=>out('violations',violations.length+' '+violations.join(' | ')),1500)
window.probes=()=>{
 let w=null;try{w=window.open('${sentinel}/popup')}catch(e){}out('popup',w?'OPENED':'blocked')
 try{const f=document.createElement('form');f.action='${sentinel}/form';f.method='post';document.body.append(f);f.submit();out('form','submit called')}catch(e){out('form','blocked ('+e.name+')')}
 try{top.location='${sentinel}/top';out('top-navigation','assigned')}catch(e){out('top-navigation','blocked ('+e.name+')')}
 try{out('parent-dom','READ '+parent.document.title)}catch(e){out('parent-dom','blocked ('+e.name+')')}
 try{localStorage.setItem('k','v');out('storage','AVAILABLE')}catch(e){out('storage','blocked ('+e.name+')')}
 try{document.cookie='k=v';out('cookie',document.cookie?'SET':'empty')}catch(e){out('cookie','blocked ('+e.name+')')}
 try{alert('x');out('alert','returned')}catch(e){out('alert','blocked ('+e.name+')')}
}
window.navigateAway=()=>{location.href='${sentinel}/navigate'}
</script></body></html>`
  let rows = ''
  for (let i = 0; rows.length < 4_150_000; i++) rows += `<tr><td>${i}</td><td>Line item ${i}: synthetic text that fills a four mebibyte presentation for the memory measurement.</td></tr>`
  const heavyText = `<!doctype html><html><head><meta charset="utf-8"><style>body{font:13px system-ui;margin:12px}td{border-bottom:1px solid #ddd;padding:2px 6px}</style></head><body><h2>Four MiB of text</h2><table>${rows}</table><p id="last-row">end</p></body></html>`
  let images = ''
  for (const name of ['orgtree-4-4-project-bunches.png', 'orgtree-4-2-workspace.png', 'orgtree-4-3-workspace.png', 'orgtree-4-workspace.png', 'orgtree-3-desks.png', 'orgtree-3-canvas.png']) {
    const tag = `<img alt="${name}" src="data:image/png;base64,${fs.readFileSync(path.join(REPO, 'docs/images', name)).toString('base64')}">`
    if (images.length + tag.length > 4_150_000) break
    images += tag
  }
  const heavyImage = `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:12px;font:13px system-ui}img{display:block;max-width:100%;margin:0 0 12px}</style></head><body><h2>About four MiB of embedded screenshots</h2>${images}<p id="last-row">end</p></body></html>`
  const overCap = '<!doctype html><p>Too large to show inline.</p><!--' + 'x'.repeat(5 * 1024 * 1024) + '-->'
  return [
    { id: 'wide', title: 'Wide dashboard (1600 px)', html: wide },
    { id: 'narrow', title: 'Narrow sign-up card', html: narrow },
    { id: 'interactive', title: 'Interactive presentation', html: interactive },
    { id: 'network', title: 'Network and isolation probe', html: network },
    { id: 'heavy-text', title: 'Four MiB of text', html: heavyText },
    { id: 'heavy-image', title: 'Embedded screenshots', html: heavyImage },
    { id: 'over-cap', title: 'Too large to show here', html: overCap },
    { id: 'notes', title: 'Plain Markdown notes', markdown: '# Plain Markdown notes\n\nA Markdown presentation, for the memory baseline.' },
  ].map((d, i) => ({ ...d, at: new Date(AT - i * 3600_000).toISOString(), format: d.html === undefined ? 'markdown' : 'html' }))
}

function startServer(files) {
  let docs = []
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture'), p = url.pathname
    receipt.requests.push({ at: Date.now(), method: req.method, path: p,
      token: req.headers['x-orgtree-desktop-token'] === TOKEN, dest: req.headers['sec-fetch-dest'] || '' })
    const send = (status, type, body, extra = {}) => {
      const buf = Buffer.isBuffer(body) ? body : Buffer.from(body)
      res.writeHead(status, { 'Content-Type': type, 'Content-Length': buf.length, 'Cache-Control': 'no-store', ...extra })
      res.end(buf)
    }
    const json = (v, status = 200) => send(status, 'application/json', JSON.stringify(v))
    if (p.startsWith('/sentinel/')) return send(200, 'text/plain', 'reached')
    if (p === '/') return send(200, 'text/html; charset=utf-8', '<!doctype html><meta charset="utf-8">'
      + '<link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/shell.css">'
      + '<div id="root"></div><script type="module" src="/fixture.js"></script>')
    if (files[p]) return send(200, files[p].type, fs.readFileSync(files[p].file))
    const prefix = `/api/orgs/${SLUG}/documents`
    if (p === prefix) {
      const rows = docs.map((d) => ({ id: d.id, node: 'synthetic-presenter', presented_by: 'synthetic-presenter', title: d.title,
        at: d.at, viewed_at: d.id === 'wide' ? null : d.at, format: d.format, bytes: Buffer.byteLength(d.html ?? d.markdown),
        node_state: 'live', evicted: false, tier: 'sol' }))
      return json({ documents: rows, total: rows.length, next_offset: null, offset: 0,
        ...(url.searchParams.has('opening') ? { opening_id: 'wide', opening_position: 0 } : {}) })
    }
    if (p === prefix + '/viewed') return json({ ok: true })
    const mock = p.match(/^\/api\/orgs\/[^/]+\/documents\/([^/]+)\/mockup$/)
    if (mock) {
      const d = docs.find((x) => x.id === decodeURIComponent(mock[1]))
      if (!d || d.html === undefined) return json({ detail: 'that document is not an HTML presentation' }, 400)
      return send(200, 'text/html; charset=utf-8', d.html, { 'Content-Security-Policy': "sandbox allow-scripts; default-src 'none'" })
    }
    const one = p.match(/^\/api\/orgs\/[^/]+\/documents\/([^/]+)$/)
    if (one) {
      const d = docs.find((x) => x.id === decodeURIComponent(one[1]))
      if (!d) return json({ detail: 'that document no longer exists' }, 404)
      return json({ id: d.id, node: 'synthetic-presenter', presented_by: 'synthetic-presenter', title: d.title,
        body: d.html ?? d.markdown, at: d.at, format: d.format, bytes: Buffer.byteLength(d.html ?? d.markdown), viewed_at: d.at })
    }
    return json({ detail: 'not in this fixture' }, 404)
  })
  server.on('upgrade', (req, socket) => {
    receipt.requests.push({ at: Date.now(), method: 'UPGRADE', path: req.url, token: req.headers['x-orgtree-desktop-token'] === TOKEN })
    socket.destroy()
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    docs = presentations(server.address().port)
    resolve(server)
  }))
}

let windows
try {
  if (!/^C:[\\/]orgtree-build[\\/][^\\/]+[\\/]/i.test(OUT)) throw Error('HTMLP_OUT must be an owned C:\\orgtree-build\\<agent>\\ folder')
  fs.mkdirSync(OUT, { recursive: true })
  const esbuild = require(path.join(NM, 'esbuild'))
  esbuild.buildSync({ entryPoints: [path.join(REPO, 'apps/desktop/renderer/tests/htmlpresentation-ui.tsx')], bundle: true,
    platform: 'browser', format: 'esm', jsx: 'automatic', outfile: path.join(OUT, 'fixture.js'), nodePaths: [NM],
    loader: { '.css': 'empty' }, define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'warning' })
  esbuild.buildSync({ entryPoints: [path.join(REPO, 'apps/desktop/main/windows.ts')], bundle: true, platform: 'node',
    format: 'cjs', outfile: path.join(OUT, 'windows.cjs'), external: ['electron'], nodePaths: [NM], logLevel: 'warning' })
  windows = require(path.join(OUT, 'windows.cjs'))
  for (const key of ['userData', 'sessionData', 'logs', 'crashDumps']) {
    const dir = path.join(OUT, 'profile', key); fs.mkdirSync(dir, { recursive: true }); app.setPath(key, dir)
  }
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('force-device-scale-factor', '1')
  app.commandLine.appendSwitch('js-flags', '--expose-gc')
} catch (e) { fail(e) }

const sessionOf = (pid) => {
  try { return Number(cp.execFileSync('powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${pid}).SessionId`]).toString().trim()) } catch { return null }
}

app.whenReady().then(async () => {
  const css = (name) => ({ type: 'text/css', file: path.join(REPO, 'apps/desktop/renderer/src', name) })
  const server = await startServer({ '/fixture.js': { type: 'text/javascript', file: path.join(OUT, 'fixture.js') },
    '/styles.css': css('styles.css'), '/shell.css': css('shell.css') })
  const origin = `http://127.0.0.1:${server.address().port}`
  const register = windows.configureEngineSession(session.defaultSession, origin, TOKEN)
  const win = new BrowserWindow({ width: 1024, height: 760, useContentSize: true, show: false, paintWhenInitiallyHidden: true,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } })
  register(win)
  const wc = win.webContents
  wc.setFrameRate(30)
  wc.setWindowOpenHandler(({ url }) => { receipt.windowOpens.push({ url, artifactRoute: windows.artifactUrl(url, origin) }); return { action: 'deny' } })
  wc.on('will-frame-navigate', (e) => { if (!e.isMainFrame) receipt.frameNavigations.push(e.url) })
  wc.on('did-fail-load', (_e, code, desc, url, isMain) => { if (!isMain) receipt.frameLoadFailures.push({ code, desc, url }) })
  wc.on('console-message', (e, level, message) => {
    const text = String(message ?? e?.message ?? '')
    if (receipt.console.length < 80) receipt.console.push(text.slice(0, 300))
  })
  const dbg = wc.debugger
  dbg.attach('1.3')
  const js = (code) => wc.executeJavaScript(code, true)
  const settle = () => js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(r,300))))')
  const until = async (probe, what, ms = 10000) => {
    const end = Date.now() + ms
    for (;;) {
      let value; try { value = await probe() } catch { value = null }
      if (value) return value
      if (Date.now() > end) throw Error('timed out waiting for ' + what)
      await sleep(60)
    }
  }
  // about:srcdoc, plus #fragment after an in-document link
  const presentationFrame = () => wc.mainFrame.frames.find((f) => /^about:srcdoc(#|$)/.test(f.url))
  const inFrame = (code) => { const f = presentationFrame(); if (!f) throw Error('no presentation frame'); return f.executeJavaScript(code, true) }
  const click = async (x, y) => {
    await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
    await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  }
  const box = (code) => js(`(()=>{const el=${code};const r=el&&el.getBoundingClientRect();return r&&r.width>0&&r.height>0?{x:r.left,y:r.top,w:r.width,h:r.height}:null})()`)
  const clickAt = async (code, what) => {
    const b = await until(() => box(code), what)
    await click(Math.round(b.x + b.w / 2), Math.round(b.y + b.h / 2))
  }
  const row = (title) => `[...document.querySelectorAll('.doc-gallery-row')].find(r=>r.querySelector('.mfrom')?.textContent===${JSON.stringify(title)})`
  const button = (label) => `[...document.querySelectorAll('.html-presentation-size button')].find(b=>b.textContent===${JSON.stringify(label)})`
  // The presentation frame runs out of process. In this offscreen window CDP
  // mouse input at its coordinates did not reach it (measured 2026-10-26: the
  // counter stayed at 0), so controls inside the frame are activated in the
  // frame's own document; parent controls keep CDP input.
  receipt.inFrameInput = 'element.click() in the frame document; parent controls by CDP mouse input'
  const clickInFrame = (selector) => inFrame(`document.querySelector(${JSON.stringify(selector)}).click();true`)
  const open = async (title, marker) => {
    await clickAt(row(title), 'row ' + title)
    await until(() => js(`!!document.querySelector('.doc-gallery-row.on') && document.querySelector('.doc-gallery-row.on .mfrom').textContent===${JSON.stringify(title)}`), 'selection ' + title)
    if (marker) await until(() => presentationFrame() && inFrame(`document.readyState==='complete'&&!!document.querySelector(${JSON.stringify(marker)})`), 'frame ' + title)
    await settle()
  }
  const shot = async (name) => {
    await settle()
    const image = await wc.capturePage()
    if (image.isEmpty()) throw Error('empty capture ' + name)
    fs.writeFileSync(path.join(OUT, name + '.png'), image.toPNG())
    receipt.shots.push(name + '.png')
  }
  const geometry = async () => ({
    frame: await box(`document.querySelector('iframe.html-presentation-frame')`),
    inner: await inFrame(`({zoom:document.documentElement.style.zoom||'',scrollWidth:document.documentElement.scrollWidth,clientWidth:document.documentElement.clientWidth,scrollHeight:document.documentElement.scrollHeight})`),
  })
  let rendererPid = 0
  // Per renderer process: the app's own renderer, and the presentation
  // frame's process while one is shown. `gone` names an earlier frame
  // process to wait for (up to 10 s) before measuring, so a closed frame's
  // memory is not counted twice.
  const memory = async (label, gone) => {
    await js('typeof gc==="function"&&gc()')
    const end = Date.now() + 10000
    while (gone && Date.now() < end && app.getAppMetrics().some((m) => m.pid === gone)) await sleep(250)
    await sleep(1500)
    const frame = presentationFrame()?.osProcessId ?? null
    const tabs = app.getAppMetrics().filter((m) => m.type === 'Tab').map((m) => ({ pid: m.pid,
      role: m.pid === rendererPid ? 'app' : m.pid === frame ? 'presentation frame' : 'other',
      workingSetKB: m.memory.workingSetSize, privateKB: m.memory.privateBytes }))
    const sum = (k) => tabs.reduce((n, m) => n + (m[k] || 0), 0)
    receipt.memory.push({ label, framePid: frame, earlierFrameExited: gone ? !app.getAppMetrics().some((m) => m.pid === gone) : null,
      tabs, workingSetKB: sum('workingSetKB'), privateKB: sum('privateKB'),
      jsHeapBytes: await js('performance.memory?performance.memory.usedJSHeapSize:null') })
    return frame
  }
  const sentinelHits = () => receipt.requests.filter((r) => r.path.startsWith('/sentinel/')).length
  const problems = receipt.problems
  const expect = (ok, what) => { if (!ok) problems.push(what) }
  try {
    await wc.loadURL(origin + '/')
    receipt.processes = { main: { pid: process.pid, session: sessionOf(process.pid) } }
    rendererPid = wc.getOSProcessId()
    receipt.processes.renderer = { pid: rendererPid, session: sessionOf(rendererPid) }
    receipt.clipboard = 'not used; the real session guard decided permissions'
    // 1. wide: Fit width, then 100% (no reload), then back
    await until(() => presentationFrame() && inFrame(`document.readyState==='complete'&&!!document.getElementById('board')`), 'wide presentation')
    await settle()
    const framePid = presentationFrame().osProcessId
    receipt.processes.frame = { pid: framePid, session: sessionOf(framePid) }
    receipt.checks.expandedList = await js(`!!document.querySelector('.mailer:not(.narrow-list)')`)
    receipt.checks.wideFit = await geometry()
    await shot('wide-fit')
    await inFrame(`window.__captureMark='kept';true`)
    await clickAt(button('100%'), '100% button')
    await until(() => inFrame(`document.documentElement.style.zoom===''`), 'zoom removed')
    receipt.checks.wideActual = await geometry()
    receipt.checks.wideActual.mark = await inFrame('window.__captureMark||null')
    receipt.checks.wideActual.pressed = await js(`${button('100%')}.getAttribute('aria-pressed')`)
    await shot('wide-100')
    await clickAt(button('Fit width'), 'Fit width button')
    await until(() => inFrame(`document.documentElement.style.zoom!==''`), 'zoom back')
    const wf = receipt.checks.wideFit, wa = receipt.checks.wideActual
    expect(Number(wf.inner.zoom) > 0 && Number(wf.inner.zoom) < 1, 'wide Fit width zoom ' + wf.inner.zoom)
    expect(wa.inner.zoom === '' && wa.inner.scrollWidth > wa.inner.clientWidth + 100, 'wide 100% keeps actual size')
    expect(wa.mark === 'kept', 'switching reloaded the presentation')
    expect(wf.frame && wf.frame.w > 400 && wf.frame.h > 300, 'frame geometry ' + JSON.stringify(wf.frame))
    // 2. narrow: Fit width leaves it alone
    await open('Narrow sign-up card', '#narrow')
    receipt.checks.narrowFit = await geometry()
    await shot('narrow-fit')
    await clickAt(button('100%'), '100% button')
    await settle()
    receipt.checks.narrowActual = await geometry()
    await shot('narrow-100')
    await clickAt(button('Fit width'), 'Fit width button')
    expect(receipt.checks.narrowFit.inner.zoom === '' && receipt.checks.narrowActual.inner.zoom === '', 'narrow presentation was scaled')
    // 3. interactive: its own script answers CDP clicks; links behave as in the window
    await open('Interactive presentation', '#count')
    await clickInFrame('#count')
    await until(() => inFrame(`document.getElementById('count').textContent==='Clicked 1 time'`), 'counter')
    await clickInFrame('[data-tab="b"]')
    await until(() => inFrame(`!document.getElementById('tab-b').hidden`), 'tab switch')
    receipt.checks.interactive = await inFrame(`({count:document.getElementById('count').textContent,details:!document.getElementById('tab-b').hidden})`)
    await shot('interactive')
    await clickInFrame('#external')
    await sleep(800)
    receipt.checks.externalLink = { stillHere: await inFrame(`location.href+' '+!!document.getElementById('count')`), sentinelHits: sentinelHits() }
    await clickInFrame('#jump')
    await sleep(500)
    receipt.checks.fragmentLink = await inFrame(`({hash:location.hash,scrollY:Math.round(scrollY)})`)
    expect(receipt.checks.interactive.count === 'Clicked 1 time' && receipt.checks.interactive.details, 'interaction')
    expect(receipt.checks.externalLink.stillHere === 'about:srcdoc true' && receipt.checks.externalLink.sentinelHits === 0, 'external link left the document')
    expect(receipt.checks.fragmentLink.hash === '#section-3' && receipt.checks.fragmentLink.scrollY > 100, 'fragment link')
    // 4. window link: the real main process routes it to the isolated viewer
    await clickAt(`document.querySelector('a.html-presentation-window')`, 'window link')
    await until(() => receipt.windowOpens.length > 0, 'window open')
    receipt.checks.windowLink = receipt.windowOpens[0]
    expect(/\/documents\/interactive\/mockup$/.test(receipt.windowOpens[0].url) && receipt.windowOpens[0].artifactRoute, 'window link')
    // 5. network and isolation probe
    await open('Network and isolation probe', '#r-violations')
    await inFrame('probes();true')
    await sleep(600)
    receipt.checks.network = await inFrame(`[...document.querySelectorAll('#results li')].map(li=>li.textContent)`)
    await shot('network-blocked')
    const before = receipt.frameLoadFailures.length
    await inFrame('navigateAway();true')
    await sleep(1500)
    receipt.checks.scriptNavigation = { frameUrls: wc.mainFrame.frames.map((f) => f.url), loadFailures: receipt.frameLoadFailures.slice(before) }
    await shot('network-script-navigation')
    const results = receipt.checks.network.join('\n')
    for (const k of ['fetch', 'app-api', 'image', 'websocket', 'popup', 'parent-dom', 'storage']) {
      expect(new RegExp('^' + k + ': blocked', 'm').test(results), k + ' not blocked: ' + results)
    }
    // top navigation and form submission may fail silently: the app page and the sentinel decide
    receipt.checks.mainFrameUrl = wc.mainFrame.url
    expect(receipt.checks.mainFrameUrl === origin + '/', 'the app page was navigated: ' + receipt.checks.mainFrameUrl)
    expect(sentinelHits() === 0, 'sentinel reached ' + sentinelHits() + ' times')
    expect(!receipt.requests.some((r) => !r.token), 'an unsigned request reached the server')
    // 6. a stored preview over 4 MiB keeps only its window link
    await open('Too large to show here')
    await until(() => js(`!!document.querySelector('.html-presentation-note')`), 'over-cap note')
    receipt.checks.overCap = await js(`document.querySelector('.html-presentation-note').textContent`)
    await shot('over-cap')
    expect(/^This presentation is 5\.0 MiB\. Presentations over 4 MiB open only in their own window\.$/.test(receipt.checks.overCap), 'over-cap note')
    // 7. memory: Markdown baseline, then four MiB of text and of images inline
    await open('Plain Markdown notes')
    await memory('markdown-baseline')
    await open('Four MiB of text', '#last-row')
    const textFrame = await memory('text-4mib-inline')
    await open('Plain Markdown notes')
    await memory('after-text', textFrame)
    await open('Embedded screenshots', '#last-row')
    await until(() => inFrame(`Promise.all([...document.images].map(i=>i.decode())).then(()=>document.images.length)`), 'images decoded')
    await shot('heavy-image')
    const imageFrame = await memory('image-4mib-inline')
    await open('Plain Markdown notes')
    await memory('after-image', imageFrame)
    receipt.sizes = Object.fromEntries(presentations(server.address().port).map((d) => [d.id, Buffer.byteLength(d.html ?? d.markdown)]))
    expect(receipt.sizes['heavy-text'] <= LIMIT && receipt.sizes['heavy-image'] <= LIMIT, 'heavy fixtures exceed the cap')
  } catch (e) {
    problems.push(String(e && e.stack || e))
    try { await shot('failure') } catch { /* nothing to capture */ }
  } finally {
    receipt.ok = problems.length === 0
    receipt.finished = new Date().toISOString()
    fs.writeFileSync(path.join(OUT, 'capture.json'), JSON.stringify(receipt, null, 2))
    console.log(JSON.stringify({ ok: receipt.ok, problems, processes: receipt.processes, checks: receipt.checks, memory: receipt.memory }))
    win.destroy()
    server.close()
  }
  app.exit(receipt.ok ? 0 : 1)
}).catch(fail)
