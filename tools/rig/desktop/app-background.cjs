// tools/rig/desktop/app-background.cjs: background-panel captures and
// measurements for tools/rig/proofs/app-background-visual.mjs. The real renderer
// bundle runs against the isolated rig engine in the rig's offscreen window;
// input goes only through CDP to that window. It refuses to run outside
// Session 0, refuses every permission request and replaces each page clipboard
// path with a refusal. The control window it opens is never shown.
'use strict'
const { BrowserWindow, app, session } = require('electron')
const { execFileSync } = require('node:child_process')

// Every page clipboard path refuses, from document start.
const CLIPBOARD = `(() => {
  const calls = []; Object.defineProperty(window, '__clipboardCalls', { value: calls })
  const deny = name => () => { calls.push(name); return Promise.reject(new DOMException('Clipboard denied', 'NotAllowedError')) }
  try { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: Object.freeze({ read: deny('read'), readText: deny('readText'), write: deny('write'), writeText: deny('writeText') }) }) } catch { calls.push('stub-failed') }
  const exec = Document.prototype.execCommand
  Document.prototype.execCommand = function (command, ...rest) { if (/^(copy|cut|paste)$/i.test(String(command))) { calls.push('execCommand:' + command); return false } return exec.call(this, command, ...rest) }
})()`

// A stand-in for the two desktop bridge members the panel runtime uses, added
// AFTER the shell booted: a bridge present at boot switches the shell into
// native-window mode, which needs the real preload. CPU requests are answered
// with the shipping main-process sampler's last result. The preference members
// are inert for components that subscribe later.
const BRIDGE = `(() => {
  const pending = new Map(); let seq = 0
  Object.defineProperty(window, '__rigDeliver', { value: (id, value) => { const r = pending.get(id); pending.delete(id); if (r) r(value) } })
  window.orgtreeDesktop = Object.freeze({
    samplePanels: panels => new Promise(resolve => { const id = ++seq; pending.set(id, resolve); console.debug('__rigSample ' + JSON.stringify({ id, count: panels.length })) }),
    setPanelRuntime: count => { console.debug('__rigRuntime ' + count); return Promise.resolve() },
    onEvent: () => () => {},
    getPreferences: () => new Promise(() => {}),
    setPreferences: () => new Promise(() => {}),
  })
})()`

// The throttling control: plain sandboxed frames like panel hosts, placed the
// ways Chromium throttles (display:none, outside the viewport) and the way a
// parked panel sits (transparent, inside the viewport, under everything).
const CONTROL = '<script>let raf=0,timer=0;setInterval(()=>timer++,100);const f=()=>{raf++;requestAnimationFrame(f)};requestAnimationFrame(f);setInterval(()=>parent.postMessage({rigControl:NAME,raf,timer},"*"),500)</' + 'script>'
const PLACES = { 'display-none': 'display:none', offscreen: 'position:fixed;left:-4000px;top:0;width:240px;height:160px;border:0', parked: 'position:fixed;left:0;top:0;width:240px;height:160px;border:0;opacity:0;z-index:-1;pointer-events:none', visible: 'position:fixed;right:0;bottom:0;width:120px;height:80px;border:0' }

module.exports = async (page, { org, args }) => {
  const wc = page.win.webContents, sleep = page.sleep, preset = args.preset
  const R = { electron: process.versions.electron, chrome: process.versions.chrome, steps: [], bounds: {}, rates: {}, rows: [], controls: {}, native: {}, phases: [], workers: {}, runtimeCounts: [], sampleRequests: 0, samples: {} }
  const note = (name, detail) => { R.steps.push({ at: new Date().toISOString(), name, ...(detail === undefined ? {} : { detail }) }); page.log(name, detail === undefined ? '' : detail) }
  const sessionId = Number(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${process.pid}).SessionId`], { encoding: 'utf8', windowsHide: true }).trim())
  R.session = { electronPid: process.pid, sessionId, rendererPid: wc.getOSProcessId() }
  if (sessionId !== 0) throw new Error(`refusing to run outside Windows Session 0 (this Electron runs in Session ${sessionId})`)

  const permissions = { requests: [], clipboardChecks: 0 }
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => { permissions.requests.push(permission); callback(false) })
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => { if (/clipboard/i.test(permission)) { permissions.clipboardChecks++; return false } return true })
  let lastSamples = []
  wc.on('console-message', (event, _level, message) => {
    const text = typeof event?.message === 'string' ? event.message : String(message ?? '')
    if (text.startsWith('__rigSample ')) {
      const { id } = JSON.parse(text.slice(12)); R.sampleRequests++
      wc.executeJavaScript(`window.__rigDeliver(${Number(id)}, ${JSON.stringify(lastSamples)})`).catch(() => {})
    } else if (text.startsWith('__rigRuntime ')) R.runtimeCounts.push({ at: Date.now(), count: Number(text.slice(13)) })
  })
  // New-document scripts run only while the Page domain is enabled.
  await page.cdp('Page.enable')
  await page.cdp('Page.addScriptToEvaluateOnNewDocument', { source: CLIPBOARD })
  await page.goto('/o/' + org)
  await page.waitFor('.apps-button', { timeout: 30000 })
  await wc.executeJavaScript(BRIDGE)
  R.installed = await page.eval(() => ({ bridge: typeof window.orgtreeDesktop?.samplePanels === 'function', clipboardStub: Array.isArray(window.__clipboardCalls) }))
  note('loaded', R.installed)
  if (!R.installed.bridge || !R.installed.clipboardStub) throw new Error('the desktop bridge stand-in or the clipboard refusal did not install')

  const until = async (fn, arg, timeout = 10000) => {
    const end = Date.now() + timeout
    while (Date.now() < end) { if (await page.eval(fn, arg)) return true; await sleep(200) }
    return false
  }
  const appsApi = body => page.api('POST', `/api/orgs/${org}/apps`, body)
  const get = async id => { const p = await appsApi({ action: 'panel_get', panel: id }); if (!p?.id) throw new Error('panel_get failed: ' + JSON.stringify(p).slice(0, 200)); return p }
  const saved = async id => { const p = await get(id); return { open: p.open, running: p.running, run_generation: p.run_generation } }
  const power = async (id, action) => { const p = await appsApi({ action, panel: id }); if (!p?.id) throw new Error(action + ' failed: ' + JSON.stringify(p).slice(0, 200)); return p }
  const sel = id => `section[data-custom-panel="${id}"]`
  const frameOf = id => `iframe[data-orgtree-runtime^="${id}:"]`
  const exists = s => page.eval(q => !!document.querySelector(q), s)
  const parked = s => page.eval(q => document.querySelector(q)?.hasAttribute('data-parked') ?? null, s)
  const runtimeOf = id => page.eval(q => document.querySelector(q)?.dataset.orgtreeRuntime ?? null, frameOf(id))
  const box = selector => page.eval(s => {
    const e = document.querySelector(s); if (!e) return null
    const r = e.getBoundingClientRect()
    return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height), onScreen: r.width > 0 && r.height > 0 && r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight, label: e.getAttribute('aria-label'), title: e.getAttribute('title') }
  }, selector)
  const menuOpen = async () => { if (!(await exists('.custom-apps-menu'))) { await page.click('.apps-button', { after: 600 }); await page.waitFor('.custom-apps-menu') } }
  // The panel saves {timer, raf, worker, boot, at, ...} every 2 s; rates come
  // from two committed saves.
  const saveAfter = async (id, after, timeout = 15000) => {
    const end = Date.now() + timeout
    while (Date.now() < end) { const s = (await get(id)).state; if (s?.at > after) return s; await sleep(300) }
    throw new Error(`no state save from ${id} after ${after}`)
  }
  const rate = async (id, ms) => {
    const a = await saveAfter(id, Date.now()); await sleep(ms); const b = await saveAfter(id, a.at + ms - 500)
    const s = (b.at - a.at) / 1000
    return { seconds: s, timer: +((b.timer - a.timer) / s).toFixed(2), raf: +((b.raf - a.raf) / s).toFixed(2), worker: +((b.worker - a.worker) / s).toFixed(2), sameBoot: a.boot === b.boot, boot: b.boot, visibility: b.vis, workerFetch: b.workerFetch, frameFetch: b.frameFetch, violations: b.violations }
  }
  // The shipping sampler attaches its own CDP client; the rig's steps aside.
  const sampleCpu = async panels => {
    const sampler = require(args.sampler)
    wc.debugger.detach()
    let samples
    try { samples = await sampler.samplePanels([wc], panels, 1000) } finally { wc.debugger.attach('1.3'); await page.resize(preset) }
    lastSamples = samples
    return samples
  }
  const running = async () => (await appsApi({ action: 'list', kind: 'panels', running: true, limit: 200 })).items.map(p => ({ panel: p.id, generation: p.run_generation }))
  // Dedicated workers and out-of-process frames, from CDP auto-attach.
  const targets = async () => {
    const found = []
    const onMessage = (_e, method, params, parent) => {
      if (method !== 'Target.attachedToTarget') return
      found.push({ type: params.targetInfo.type, url: String(params.targetInfo.url).slice(0, 48), session: params.sessionId, parent: parent ?? null })
      if (params.targetInfo.type === 'iframe') wc.debugger.sendCommand('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, params.sessionId).catch(() => {})
    }
    wc.debugger.on('message', onMessage)
    try { await wc.debugger.sendCommand('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }); await sleep(1000) } finally {
      wc.debugger.removeListener('message', onMessage)
      await wc.debugger.sendCommand('Target.setAutoAttach', { autoAttach: false, waitForDebuggerOnStart: false, flatten: true }).catch(() => {})
      for (const t of [...found].reverse()) await wc.debugger.sendCommand('Target.detachFromTarget', { sessionId: t.session }).catch(() => {})
    }
    return { iframes: found.filter(t => t.type === 'iframe').length, workers: found.filter(t => t.type === 'worker').map(t => t.url) }
  }
  // Per process over a window: CPU from cumulative CPU seconds (100 = one core;
  // percentCPUUsage averages since whichever getAppMetrics call came before).
  const snapshot = () => new Map(app.getAppMetrics().map(m => [m.pid, m]))
  const measure = async (ms, contents) => {
    const m0 = snapshot(), t0 = Date.now(); await sleep(ms); const m1 = snapshot(), s = (Date.now() - t0) / 1000
    const panelPids = [...new Set(contents.mainFrame.framesInSubtree.filter(f => f !== contents.mainFrame).map(f => f.osProcessId))]
    const processes = [...m1.values()].map(m => {
      const a = m0.get(m.pid), used = a && a.cpu.cumulativeCPUUsage !== undefined && m.cpu.cumulativeCPUUsage !== undefined ? (m.cpu.cumulativeCPUUsage - a.cpu.cumulativeCPUUsage) / s * 100 : null
      return { pid: m.pid, type: m.type, role: m.pid === contents.getOSProcessId() ? 'page' : panelPids.includes(m.pid) ? 'panel frames' : m.serviceName || m.type, cpuOneCore: used === null ? null : +used.toFixed(1), privateMB: m.memory.privateBytes ? +(m.memory.privateBytes / 1024).toFixed(1) : null, workingSetMB: +(m.memory.workingSetSize / 1024).toFixed(1) }
    })
    const sum = key => +processes.reduce((n, x) => n + (x[key] ?? 0), 0).toFixed(1)
    return { seconds: s, processes, total: { cpuOneCore: sum('cpuOneCore'), privateMB: sum('privateMB'), workingSetMB: sum('workingSetMB') } }
  }

  // 1. A visible panel: its header's Hide and Power off, centered and on the canvas.
  const V = args.visible, H = args.hidden, O = args.off
  await page.waitFor(`${sel(V.id)} ${frameOf(V.id)}`, { timeout: 30000 })
  R.restored = { visible: { parked: await parked(sel(V.id)), mounted: await exists(frameOf(V.id)) }, hidden: { parked: await parked(sel(H.id)), mounted: await exists(frameOf(H.id)) }, off: { mounted: await exists(frameOf(O.id)) } }
  const header = async key => { R.bounds[key] = { panel: await box(sel(V.id)), hide: await box(`${sel(V.id)} [aria-label="Hide ${V.label}"]`), power: await box(`${sel(V.id)} .custom-app-power`) } }
  await header('centered'); await page.screenshot('01-header-centered')
  R.rates.visible = await rate(V.id, 8000)
  await page.click(`${sel(V.id)} [aria-label="Pin to canvas"]`, { after: 800 })
  await until(() => !document.querySelector('.custom-app-centered'))
  await header('canvas'); R.bounds.canvasParked = await parked(sel(V.id))
  await page.screenshot('02-header-on-canvas'); note('header captured', R.bounds)
  const shownRuntime = await runtimeOf(V.id)

  // 2. Hide keeps the same runtime, parked; the throttling control runs meanwhile.
  await page.click(`${sel(V.id)} [aria-label="Hide ${V.label}"]`, { after: 600 })
  await until(s => document.querySelector(s)?.hasAttribute('data-parked'), sel(V.id))
  R.hidden = { parked: await parked(sel(V.id)), runtime: await runtimeOf(V.id), shownRuntime, saved: await saved(V.id) }
  await page.screenshot('03-hidden-running'); note('hidden', R.hidden)
  R.rates.hidden = await rate(V.id, 10000)
  await page.eval((control, places) => {
    window.__rigControl = {}
    addEventListener('message', e => { if (e.data && typeof e.data.rigControl === 'string') window.__rigControl[e.data.rigControl] = { raf: e.data.raf, timer: e.data.timer, at: Date.now() } })
    for (const [name, style] of Object.entries(places)) {
      const f = document.createElement('iframe'); f.className = 'rig-control'; f.setAttribute('sandbox', 'allow-scripts'); f.setAttribute('style', style)
      f.srcdoc = control.replace('NAME', JSON.stringify(name)); document.body.appendChild(f)
    }
  }, CONTROL, PLACES)
  await sleep(2000); const c0 = await page.eval(() => JSON.parse(JSON.stringify(window.__rigControl)))
  await sleep(5000); const c1 = await page.eval(() => JSON.parse(JSON.stringify(window.__rigControl)))
  for (const name of Object.keys(PLACES)) {
    const a = c0[name], b = c1[name], s = a && b ? (b.at - a.at) / 1000 : 0
    R.controls[name] = s > 0 ? { raf: +((b.raf - a.raf) / s).toFixed(2), timer: +((b.timer - a.timer) / s).toFixed(2) } : { raf: null, timer: null, reported: !!b }
  }
  await page.eval(() => { for (const f of document.querySelectorAll('iframe.rig-control')) f.remove() })
  note('rates', { rates: R.rates, controls: R.controls })

  // 3. Show the same copy again from its saved row: same runtime, same boot.
  await menuOpen()
  await page.click(`button.custom-apps-saved[aria-label^="${V.label},"]`, { after: 800 })
  await until(s => { const e = document.querySelector(s); return !!e && !e.hasAttribute('data-parked') }, sel(V.id))
  R.reshown = { parked: await parked(sel(V.id)), runtime: await runtimeOf(V.id), boot: (await saveAfter(V.id, Date.now())).boot, saved: await saved(V.id) }

  // 4. Three states on the saved rows, with CPU from the shipping sampler.
  R.samples.threeStates = await sampleCpu(await running()); note('samples', R.samples.threeStates)
  await menuOpen()
  await until(() => document.querySelectorAll('.custom-app-cpu').length >= 2, undefined, 10000)
  R.rows = await page.eval(() => [...document.querySelectorAll('.custom-apps-saved-row')].map(row => {
    const button = row.querySelector('button.custom-apps-saved'), dot = row.querySelector('.custom-app-dot'), cpu = row.querySelector('.custom-app-cpu'), power = row.querySelector('.custom-apps-saved-power')
    const rect = e => { if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height), onScreen: r.width > 0 && r.height > 0 && r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight } }
    const style = dot && getComputedStyle(dot)
    return { aria: button?.getAttribute('aria-label'), title: button?.getAttribute('title'), dot: dot?.className, dotRect: rect(dot), dotStyle: style && { background: style.backgroundColor, border: `${style.borderTopWidth} ${style.borderTopStyle} ${style.borderTopColor}` }, cpu: cpu?.textContent ?? null, power: rect(power), powerLabel: power?.getAttribute('aria-label') ?? null }
  }))
  await page.screenshot('04-apps-menu-three-states'); note('rows', R.rows)

  // 5. Right-click the powered-off row: Start running runs it hidden.
  const offRow = await page.eval(label => { const row = [...document.querySelectorAll('.custom-apps-saved-row')].find(r => r.querySelector('button.custom-apps-saved')?.getAttribute('aria-label')?.startsWith(label + ',')); if (!row) return null; const r = row.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } }, O.label)
  if (!offRow) throw new Error('the powered-off row is missing')
  await page.rightClick(offRow, { after: 500 })
  await page.waitFor({ selector: '.ctxmenu[role="menu"] [role="menuitem"]', text: 'Start running' }, { timeout: 5000 })
  R.contextMenu = { at: { x: Math.round(offRow.x), y: Math.round(offRow.y) }, menu: await box('.ctxmenu[role="menu"]'), items: await page.eval(() => [...document.querySelectorAll('.ctxmenu[role="menu"] [role="menuitem"]')].map(i => i.textContent.trim())) }
  await page.screenshot('05-row-context-menu')
  await page.click({ selector: '.ctxmenu[role="menu"] [role="menuitem"]', text: 'Start running' }, { after: 800 })
  await until(s => !!document.querySelector(s), frameOf(O.id), 15000)
  R.started = { saved: await saved(O.id), mounted: await exists(frameOf(O.id)), parked: await parked(sel(O.id)) }
  note('started', R.started)

  // 6. Row Power off ends the copy, its frame and its worker.
  R.workers.before = await targets()
  await menuOpen()
  await page.click(`.custom-apps-saved-row [aria-label="Power off ${H.label}"]`, { after: 800 })
  await until(s => !document.querySelector(s), frameOf(H.id))
  R.rowPowerOff = { saved: await saved(H.id), frameGone: !(await exists(frameOf(H.id))) }
  await sleep(500); R.workers.afterRowPowerOff = await targets()
  await page.screenshot('06-after-row-power-off')

  // 7. The visible copy's header Power off.
  await page.press('Escape'); await sleep(300)
  await page.click(`${sel(V.id)} .custom-app-power`, { after: 800 })
  await until(s => !document.querySelector(s), frameOf(V.id))
  R.headerPowerOff = { saved: await saved(V.id), frameGone: !(await exists(frameOf(V.id))) }
  await sleep(500); R.workers.afterHeaderPowerOff = await targets()
  note('powered off', { row: R.rowPowerOff, header: R.headerPowerOff, workers: R.workers })

  // 8. Memory and CPU with 0, 1 and N hidden copies (timers only, and a game
  // loop), in a real window: offscreen rendering paints only on damage, so
  // parked frames there drew 1-8 frames a second. Measured copies are made only
  // now, as the agent (closed and off), so the rows above showed the three
  // captured states. The rig's window then leaves the org, so one window hosts
  // the copies. The real window is shown on Session 0's own display (no person
  // sees it) with background throttling off, as the desktop sets a window
  // hosting panels, and is finally hidden the way the tray hides one.
  const agentApps = async input => { const r = await page.api('POST', '/api/rig/tool', { org, agent: 'boss', tool: 'orgtree_apps', args: input }); if (!r?.ok) throw new Error('agent orgtree_apps failed: ' + JSON.stringify(r).slice(0, 200)); return r.json }
  const light = [], loop = []
  for (let i = 1; i <= args.copies; i++) light.push((await agentApps({ action: 'panel_open', app: args.app, new: true, label: 'Timers ' + i })).id)
  for (let i = 1; i <= args.copies; i++) {
    const p = await agentApps({ action: 'panel_open', app: args.app, new: true, label: 'Loop ' + i })
    const set = await appsApi({ action: 'state_set', panel: p.id, expected_rev: p.rev, state: { busy_ms: args.busyMs, probe: args.probe } })
    if (!set?.id) throw new Error('state_set failed: ' + JSON.stringify(set).slice(0, 200))
    loop.push(p.id)
  }
  for (const p of await running()) await power(p.panel, 'panel_stop')
  R.clipboard = { calls: await page.eval(() => (window.__clipboardCalls ?? ['stub missing']).slice()) }
  await page.goto('about:blank'); await sleep(1500)
  const sampler = require(args.sampler)
  const nw = new BrowserWindow({ show: false, x: 0, y: 0, width: 1024, height: 768, skipTaskbar: true, focusable: false, webPreferences: { sandbox: true, contextIsolation: true } })
  try {
    nw.webContents.setBackgroundThrottling(false)
    // CDP on a window's blank initial document can hang Electron 44: navigate first.
    await nw.loadURL('about:blank')
    nw.webContents.debugger.attach('1.3')
    await nw.webContents.debugger.sendCommand('Page.enable')
    await nw.webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: CLIPBOARD })
    nw.showInactive()
    await nw.loadURL(new URL('/o/' + org, page.base).href)
    nw.webContents.debugger.detach()
    const nwEval = (fn, arg) => nw.webContents.executeJavaScript(`(${fn.toString()})(${JSON.stringify(arg ?? null)})`, true)
    const nwUntil = async (fn, arg, timeout = 20000) => { const end = Date.now() + timeout; while (Date.now() < end) { if (await nwEval(fn, arg).catch(() => false)) return true; await sleep(200) } return false }
    R.realWindow = { booted: await nwUntil(() => !!document.querySelector('.apps-button'), null, 30000), shown: nw.isVisible(), bounds: nw.getBounds(), sessionId: R.session.sessionId, visibility: await nwEval(() => document.visibilityState), clipboardStub: await nwEval(() => Array.isArray(window.__clipboardCalls)) }
    note('real window', R.realWindow)
    const stopAll = async () => { for (const p of await running()) await power(p.panel, 'panel_stop'); await nwUntil(() => !document.querySelector('iframe[data-orgtree-runtime]'), null, 15000) }
    const phase = async (label, ids) => {
      await stopAll(); await sleep(2000)
      for (const id of ids) await power(id, 'panel_start')
      await nwUntil(n => document.querySelectorAll('iframe[data-orgtree-runtime]').length === n, ids.length, 20000)
      const mounted = await nwEval(() => document.querySelectorAll('iframe[data-orgtree-runtime]').length)
      const parkedAll = await nwEval(() => [...document.querySelectorAll('section[data-custom-panel]')].every(s => s.hasAttribute('data-parked')))
      const first = Date.now(); for (const id of ids) await saveAfter(id, first, 20000)
      const before = await Promise.all(ids.map(async id => (await get(id)).state))
      const window = await measure(5000, nw.webContents)
      const after = await Promise.all(ids.map(async id => (await get(id)).state))
      const panels = ids.length ? await running() : []
      const samples = ids.length ? await sampler.samplePanels([nw.webContents], panels, 1000) : []
      // The fallback path: with another CDP client attached the sampler cannot
      // profile, so it reports the hosting processes' CPU, labelled shared.
      let shared = []
      if (ids.length) { nw.webContents.debugger.attach('1.3'); try { shared = await sampler.samplePanels([nw.webContents], panels, 1000) } finally { nw.webContents.debugger.detach() } }
      const loops = ids.map((id, i) => { const a = before[i], b = after[i], s = (b.at - a.at) / 1000; return s > 0 ? { panel: id, timer: +((b.timer - a.timer) / s).toFixed(2), tick: +((b.tick - a.tick) / s).toFixed(2), raf: +((b.raf - a.raf) / s).toFixed(2), worker: +((b.worker - a.worker) / s).toFixed(2), visibility: b.vis } : { panel: id, timer: null } })
      R.phases.push({ label, copies: ids.length, mounted, parked: parkedAll, processes: window.processes, total: window.total, samples, shared, loops })
      note('phase ' + label, { total: window.total, processes: window.processes, samples: samples.map(s => [s.cpu_percent, s.method]), shared: shared.slice(0, 1).map(s => [s.cpu_percent, s.method]), loops: loops.map(l => [l.timer, l.tick, l.raf, l.worker, l.visibility]) })
    }
    await phase('none', [])
    await phase('timers x1', light.slice(0, 1))
    await phase(`timers x${light.length}`, light)
    await phase('game loop x1', loop.slice(0, 1))
    await phase(`game loop x${loop.length}`, loop)
    nw.hide(); await sleep(1500)
    R.realWindow.hiddenVisibility = await nwEval(() => document.visibilityState)
    await phase(`game loop x${loop.length}, window hidden`, loop)
    await stopAll()
    R.realWindow.clipboardCalls = await nwEval(() => (window.__clipboardCalls ?? ['stub missing']).slice())
  } finally { nw.destroy() }

  // 9. The native mechanism, in Session 0 only: a window that is actually
  // hidden (never painted, or shown offscreen and then hidden the way the tray
  // hides one), with Chromium's background throttling on and then switched off
  // the way the desktop does while a window hosts running panels.
  const nativeWindow = async shownFirst => {
    const w = new BrowserWindow({ show: false, x: -32000, y: -32000, width: 320, height: 200, paintWhenInitiallyHidden: false, skipTaskbar: true, focusable: false, webPreferences: { sandbox: true, contextIsolation: true } })
    try {
      await w.loadURL('data:text/html,' + encodeURIComponent('<script>window.c={raf:0,timer:0};setInterval(()=>c.timer++,10);const f=()=>{c.raf++;requestAnimationFrame(f)};requestAnimationFrame(f)</' + 'script>'))
      const read = () => w.webContents.executeJavaScript('({raf:window.c.raf,timer:window.c.timer,vis:document.visibilityState,at:Date.now()})')
      const span = async () => { const a = await read(); await sleep(4000); const b = await read(); const s = (b.at - a.at) / 1000; return { timer: +((b.timer - a.timer) / s).toFixed(2), raf: +((b.raf - a.raf) / s).toFixed(2), visibility: b.vis } }
      const out = {}
      if (shownFirst) { w.showInactive(); await sleep(1500); out.shown = await span(); w.hide() }
      await sleep(1500); out.hiddenThrottled = await span()
      w.webContents.setBackgroundThrottling(false); await sleep(1000)
      out.hiddenUnthrottled = await span(); out.visibleAtEnd = w.isVisible()
      return out
    } finally { w.destroy() }
  }
  R.native.neverShown = await nativeWindow(false)
  R.native.shownThenHidden = await nativeWindow(true)
  note('native', R.native)

  R.clipboard = { ...R.clipboard, permissionRequestsDenied: permissions.requests, clipboardChecksDenied: permissions.clipboardChecks, navigatorClipboard: 'stubbed: every method refuses', execCommand: 'copy/cut/paste refused', mainProcessClipboardUsed: false }
  return R
}
