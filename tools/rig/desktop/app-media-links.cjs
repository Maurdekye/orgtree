// tools/rig/desktop/app-media-links.cjs: the window half of
// tools/rig/proofs/app-media-links.mjs. The real renderer bundle runs against
// the isolated rig engine; input goes only through CDP and the app's own
// frame. Every play first seeks past what is buffered, so it needs a fresh
// byte range. Phases, floating then popped out: load; Hide (play while hidden)
// and Show; host-session renewal (the renderer's own, reached by moving its
// clock 31 minutes on); a Files grant (Allow); then the controls, power off
// and Deny. Refuses outside Session 0, refuses every permission, replaces each
// page clipboard path with a refusal, and is SILENT: every webContents is
// muted, as is the app's <video>.
'use strict'
const { BrowserWindow, app, session } = require('electron')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const CLIPBOARD = `(() => { if (window.__clipboardCalls) return true
  const calls = []; Object.defineProperty(window, '__clipboardCalls', { value: calls })
  const deny = name => () => { calls.push(name); return Promise.reject(new DOMException('Clipboard denied', 'NotAllowedError')) }
  try { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: Object.freeze({ read: deny('read'), readText: deny('readText'), write: deny('write'), writeText: deny('writeText') }) }) } catch { calls.push('stub-failed') }
  const exec = Document.prototype.execCommand
  Document.prototype.execCommand = function (command, ...rest) { if (/^(copy|cut|paste)$/i.test(String(command))) { calls.push('execCommand:' + command); return false } return exec.call(this, command, ...rest) }
  return true })()`

const VIDEO = `(() => { const v = document.getElementById('video'), q = id => document.getElementById(id)
  const ranges = []; for (let i = 0; i < v.buffered.length; i++) ranges.push([+v.buffered.start(i).toFixed(2), +v.buffered.end(i).toFixed(2)])
  return { readyState: v.readyState, error: v.error ? { code: v.error.code, message: v.error.message } : null, muted: v.muted,
    currentTime: +v.currentTime.toFixed(3), paused: v.paused, buffered: ranges, src: v.currentSrc || null,
    marker: window.__probeMarker ?? null, msg: q('msg') && !q('msg').hidden ? q('msg').textContent : null }
})()`

module.exports = async (page, { org, out, args }) => {
  const sleep = page.sleep, main = page.win
  // silent first: this window and every window the run creates
  main.webContents.setAudioMuted(true)
  app.on('web-contents-created', (_e, contents) => { try { contents.setAudioMuted(true) } catch { /* gone */ } })
  const R = { phases: {}, steps: [], windows: {} }
  const note = (name, detail) => { R.steps.push({ at: new Date().toISOString(), name, ...(detail === undefined ? {} : { detail }) }); page.log(name, detail === undefined ? '' : detail) }
  const sessionOf = pid => Number(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid}).SessionId`], { encoding: 'utf8', windowsHide: true }).trim())
  R.session = { electronPid: process.pid, sessionId: sessionOf(process.pid), rendererPid: main.webContents.getOSProcessId() }
  if (R.session.sessionId !== 0) throw new Error(`refusing to run outside Windows Session 0 (this Electron runs in Session ${R.session.sessionId})`)
  const permissions = []; R.permissions = permissions
  session.defaultSession.setPermissionRequestHandler((_c, p, cb) => { permissions.push(p); cb(false) })
  session.defaultSession.setPermissionCheckHandler((_c, p) => { permissions.push('check:' + p); return false })
  await page.cdp('Page.enable')
  await page.cdp('Page.addScriptToEvaluateOnNewDocument', { source: CLIPBOARD })
  await page.goto('/o/' + org)
  await main.webContents.executeJavaScript(CLIPBOARD)
  const apps = body => page.api('POST', `/api/orgs/${org}/apps`, body)
  const read = request => page.api('GET', `/api/orgs/${org}/apps?request=${encodeURIComponent(JSON.stringify(request))}`)
  const panelState = async () => { const p = await read({ action: 'panel_get', panel: args.panel }); return { open: p.open, running: p.running, generation: p.run_generation, mode: p.placement?.mode } }
  const muted = () => BrowserWindow.getAllWindows().filter(w => !w.isDestroyed()).every(w => w.webContents.isAudioMuted())

  // the app's frame, wherever the panel is (the main window or its popout)
  const findFrame = () => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (w.isDestroyed()) continue
      const f = w.webContents.mainFrame.framesInSubtree.find(f => f !== w.webContents.mainFrame && f.url === 'about:srcdoc')
      if (f) return { w, f }
    }
    return null
  }
  const until = async (get, ok, timeout) => { const t0 = Date.now(); let v = await get(); while (!ok(v) && Date.now() - t0 < timeout) { await sleep(150); v = await get() } return { v, ok: ok(v), ms: Date.now() - t0 } }
  const shoot = async (w, name) => {
    if (w === main) return page.screenshot(name)
    const file = path.join(out, `${name}.png`); fs.writeFileSync(file, (await w.webContents.capturePage()).toPNG()); return file
  }
  const status = async src => { if (!src) return null; const r = await fetch(src, { headers: { Range: 'bytes=0-1' } }).catch(e => ({ status: String(e) })); try { await r.body?.cancel() } catch { /* drained */ } return r.status }

  async function seekPlay(fx, seekTo) {
    await fx(`(() => { const v = document.getElementById('video'); v.muted = true; v.currentTime = ${seekTo}; return true })()`, true)
    await until(() => fx(VIDEO), v => !!v.error || (v.readyState >= 3 && Math.abs(v.currentTime - seekTo) < 2), 8000)
    await fx("document.getElementById('bplay').click(); true", true); await sleep(4000)
    const v = await fx(VIDEO)
    if (!v.paused) { await fx("document.getElementById('bplay').click(); true", true); await sleep(300) }
    return { ...v, played: +(v.currentTime - seekTo).toFixed(3) }
  }
  async function phase(name, seekTo, { fresh = false, before } = {}) {
    const ph = { started: new Date().toISOString() }; R.phases[name] = ph
    try {
      if (before) ph.setup = await before()
      const found = await until(async () => findFrame(), f => !!f, 20000)
      if (!found.v) { ph.error = 'no app frame'; return ph }
      const { w, f } = found.v, fx = (code, gesture = false) => f.executeJavaScript(code, gesture)
      ph.window = w === main ? 'main' : 'popout'
      if (fresh) {
        const loaded = await until(() => fx(VIDEO).catch(e => ({ error: String(e) })), v => !!v && (v.readyState >= 1 || !!v.error || !!v.msg), 25000)
        ph.loaded = loaded.ok
        await fx('window.__probeMarker = Math.random().toString(36).slice(2); true')
      }
      ph.before = await fx(VIDEO)
      ph.result = await seekPlay(fx, seekTo)
      ph.muted = muted() && ph.result.muted
      ph.shot = await shoot(w, `app-media-links-${name}`)
      ph.panel = await panelState()
    } catch (e) { ph.error = String(e && e.stack || e) } finally { ph.ended = new Date().toISOString() }
    note(name, { played: ph.result?.played, error: ph.result?.error ?? ph.error, msg: ph.result?.msg })
    return ph
  }
  const hideShow = async ({ hiddenSeek }) => {
    const { w, f } = findFrame(), marker = await f.executeJavaScript('window.__probeMarker')
    const at = { hide: new Date().toISOString(), window: w === main ? 'main' : 'popout' }
    // the panel header's own Hide (its X), in the window that holds the panel
    await w.webContents.executeJavaScript(`document.querySelector('section.custom-app-window[data-custom-panel="${args.panel}"] button[aria-label^="Hide "]').click(); true`, true)
    await sleep(1500)
    at.hidden = await panelState()
    at.whileHidden = await seekPlay((code, g = false) => f.executeJavaScript(code, g), hiddenSeek)
    at.show = new Date().toISOString()
    await apps({ action: 'panel_open', panel: args.panel })
    await sleep(2500)
    at.shown = await panelState()
    at.sameDocument = (await findFrame()?.f.executeJavaScript('window.__probeMarker').catch(() => null)) === marker
    return at
  }
  const renew = async () => {
    // the renderer renews its host session within 5 s of its 30 minutes; moving
    // the main realm's clock on makes the next file call do exactly that
    const { f } = findFrame(), marker = await f.executeJavaScript('window.__probeMarker')
    await main.webContents.executeJavaScript('(() => { const real = Date.now.bind(Date); window.__realNow = real; Date.now = () => real() + 31 * 60 * 1000; return true })()')
    let call
    try { call = await f.executeJavaScript('window.orgtree.files.roots().then(r => ({ ok: true }), e => ({ error: String(e && e.message || e) }))', true) }
    finally { await main.webContents.executeJavaScript('(() => { if (window.__realNow) Date.now = window.__realNow; return true })()') }
    return { call, sameDocument: (await f.executeJavaScript('window.__probeMarker')) === marker }
  }

  await page.waitFor(`section.custom-app-window[data-custom-panel="${args.panel}"] iframe`, { timeout: 30000 })
  await phase('floating', 100, { fresh: true })
  await phase('floating-hide-show', 180, { before: () => hideShow({ hiddenSeek: 140 }) })
  await phase('floating-renewal', 220, { before: renew })

  const created = new Promise(resolve => main.webContents.once('did-create-window', (child, details) => resolve([child, details.frameName])))
  await page.click(`section.custom-app-window[data-custom-panel="${args.panel}"] button[aria-label="Open in new window"]`)
  const [child, frameName] = await created
  child.webContents.setAudioMuted(true)
  await child.webContents.executeJavaScript(CLIPBOARD)
  R.windows.popout = { frameName, pid: child.webContents.getOSProcessId(), session: sessionOf(child.webContents.getOSProcessId()) }
  await phase('popped-out', 100, { fresh: true })
  await phase('popped-out-hide-show', 180, { before: () => hideShow({ hiddenSeek: 140 }) })
  await phase('popped-out-renewal', 220, { before: renew })
  await phase('popped-out-grant', 260, { before: async () => {
    const a = await read({ action: 'app_get', app: args.app })
    const x = await apps({ action: 'permission_set', app: args.app, capability: 'files.read', permission: 'allow', expected_rev: a.rev, expected_permission_rev: a.permission_rev })
    return { permissions: x.permissions ?? x }
  } })

  // controls: power off and Deny still end the ticket
  const c = {}; R.controls = c
  c.powerOffSrc = (await findFrame().f.executeJavaScript(VIDEO)).src
  c.beforePowerOff = await status(c.powerOffSrc)
  await apps({ action: 'panel_stop', panel: args.panel }); await sleep(1500)
  c.afterPowerOff = await status(c.powerOffSrc)
  await phase('restarted', 100, { fresh: true, before: async () => { await apps({ action: 'panel_open', panel: args.panel }); await sleep(3000); return panelState() } })
  c.denySrc = (await findFrame().f.executeJavaScript(VIDEO)).src
  c.beforeDeny = await status(c.denySrc)
  const a = await read({ action: 'app_get', app: args.app })
  await apps({ action: 'permission_set', app: args.app, capability: 'files.read', permission: 'deny', expected_rev: a.rev, expected_permission_rev: a.permission_rev })
  await sleep(1000)
  c.afterDeny = await status(c.denySrc)
  await phase('after-deny', 260)

  R.muted = muted() && Object.values(R.phases).every(ph => ph.muted !== false)
  R.clipboard = { main: await main.webContents.executeJavaScript('window.__clipboardCalls'), popout: child.isDestroyed() ? 'closed' : await child.webContents.executeJavaScript('window.__clipboardCalls').catch(() => 'unavailable') }
  // the tickets are bearer URLs: keep only their paths in the result
  for (const k of ['powerOffSrc', 'denySrc']) if (c[k]) c[k] = new URL(c[k]).pathname
  for (const ph of Object.values(R.phases)) for (const v of [ph.before, ph.result, ph.setup?.whileHidden]) if (v?.src) v.src = new URL(v.src).pathname
  return R
}
