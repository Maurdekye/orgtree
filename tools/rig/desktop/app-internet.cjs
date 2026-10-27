// tools/rig/desktop/app-internet.cjs: the window half of
// tools/rig/proofs/app-internet.mjs. The real renderer bundle runs against the
// isolated rig engine; input goes only through CDP and the app's own frame.
// The app calls orgtree.net.fetch for a declared site (localhost:9, this
// machine: the engine's address guard refuses it after the grant check, so
// nothing leaves the PC); the native prompt is read and captured, Always allow
// this site is pressed, then App settings > Permissions is opened and captured.
// Refuses outside Session 0, refuses every permission, replaces each page
// clipboard path with a refusal, and is SILENT: every webContents is muted.
'use strict'
const { BrowserWindow, app, session } = require('electron')
const { execFileSync } = require('node:child_process')

const CLIPBOARD = `(() => { if (window.__clipboardCalls) return true
  const calls = []; Object.defineProperty(window, '__clipboardCalls', { value: calls })
  const deny = name => () => { calls.push(name); return Promise.reject(new DOMException('Clipboard denied', 'NotAllowedError')) }
  try { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: Object.freeze({ read: deny('read'), readText: deny('readText'), write: deny('write'), writeText: deny('writeText') }) }) } catch { calls.push('stub-failed') }
  const exec = Document.prototype.execCommand
  Document.prototype.execCommand = function (command, ...rest) { if (/^(copy|cut|paste)$/i.test(String(command))) { calls.push('execCommand:' + command); return false } return exec.call(this, command, ...rest) }
  return true })()`

// Press the first visible button whose text or aria-label is exactly `label`.
const press = label => `(() => { const b = [...document.querySelectorAll('button')].find(b => b.offsetParent !== null && (b.textContent.trim() === ${JSON.stringify(label)} || b.getAttribute('aria-label') === ${JSON.stringify(label)}))
  if (!b) return false; b.click(); return true })()`

module.exports = async (page, { org, args }) => {
  const sleep = page.sleep, main = page.win
  main.webContents.setAudioMuted(true)
  app.on('web-contents-created', (_e, contents) => { try { contents.setAudioMuted(true) } catch { /* gone */ } })
  const R = { steps: [] }
  const note = (name, detail) => { R.steps.push({ at: new Date().toISOString(), name, ...(detail === undefined ? {} : { detail }) }); page.log(name, detail === undefined ? '' : detail) }
  const sessionOf = pid => Number(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid}).SessionId`], { encoding: 'utf8', windowsHide: true }).trim())
  R.session = { electronPid: process.pid, sessionId: sessionOf(process.pid), rendererPid: main.webContents.getOSProcessId() }
  if (R.session.sessionId !== 0) throw new Error(`refusing to run outside Windows Session 0 (this Electron runs in Session ${R.session.sessionId})`)
  const permissions = []; R.permissions_requested = permissions
  session.defaultSession.setPermissionRequestHandler((_c, p, cb) => { permissions.push(p); cb(false) })
  session.defaultSession.setPermissionCheckHandler((_c, p) => { permissions.push('check:' + p); return false })
  await page.cdp('Page.enable')
  await page.cdp('Page.addScriptToEvaluateOnNewDocument', { source: CLIPBOARD })
  await page.goto('/o/' + org)
  await main.webContents.executeJavaScript(CLIPBOARD)
  const js = (code, gesture = false) => main.webContents.executeJavaScript(code, gesture)
  const until = async (get, ok, timeout) => { const t0 = Date.now(); let v = await get(); while (!ok(v) && Date.now() - t0 < timeout) { await sleep(150); v = await get() } return { v, ok: ok(v), ms: Date.now() - t0 } }
  // The capture app's own frame (its markup has #out), whatever else is open.
  const findFrame = async () => {
    for (const f of main.webContents.mainFrame.framesInSubtree) {
      if (f === main.webContents.mainFrame || f.url !== 'about:srcdoc') continue
      if (await f.executeJavaScript("!!document.getElementById('out')").catch(() => false)) return f
    }
    return null
  }

  await page.waitFor(`section.custom-app-window[data-custom-panel="${args.panel}"] iframe`, { timeout: 30000 })
  const frame = (await until(findFrame, f => !!f, 20000)).v
  if (!frame) throw new Error('no app frame')
  await until(() => frame.executeJavaScript('!!(window.orgtree && window.orgtree.net)').catch(() => false), v => v === true, 10000)
  note('frame ready')
  // The app's own call, as an app makes it; the native prompt blocks it.
  await frame.executeJavaScript("window.__net = window.orgtree.net.fetch('https://localhost:9/forecast?city=synthetic').then(r => ({ status: r.status }), e => ({ error: String(e && e.message || e) })); true", true)
  const prompt = await until(() => js(`(() => { const d = document.querySelector('[role="dialog"][aria-label="App permission"]'); return d ? { text: d.textContent, buttons: [...d.querySelectorAll('button')].map(b => b.textContent.trim()) } : null })()`), v => !!v, 15000)
  R.prompt = prompt.v
  R.prompt_shot = await page.screenshot('app-internet-prompt')
  note('prompt', { buttons: R.prompt?.buttons })
  R.pressedAlways = await js(press('Always allow this site'), true)
  R.fetch = (await until(() => frame.executeJavaScript('window.__net'), v => !!v, 20000)).v
  note('fetch', R.fetch)

  // App settings > Permissions, through the Apps menu's settings gear.
  await js(press('Apps'), true); await sleep(800)
  await js(`(() => { const b = document.querySelector('.custom-apps-menu-app [aria-label=${JSON.stringify('Settings for ' + args.name)}]'); if (!b) return false; b.click(); return true })()`, true)
  await sleep(800)
  await js(press('Permissions'), true)
  const ready = await until(() => js(`!!document.querySelector('select[aria-label="Internet access permission"]')`), v => v === true, 15000)
  R.permissions = await js(`(() => { const s = document.querySelector('section.custom-app-permissions'); const rows = {}
    for (const sel of document.querySelectorAll('select[aria-label$=" internet permission"]')) rows[sel.getAttribute('aria-label').replace(/ internet permission$/, '')] = sel.value
    return { capability: document.querySelector('select[aria-label="Internet access permission"]')?.value ?? null, rows, text: s ? s.textContent : document.body.textContent.slice(0, 4000) } })()`)
  R.permissions.ready = ready.ok
  R.permissions_shot = await page.screenshot('app-internet-permissions')
  // Permission history has its own App settings tab (USER 2026-10-27 m838e66af753b).
  await js(press('Permission history'), true)
  await until(() => js(`!!document.querySelector('[aria-label="Permission history"] li')`), v => v === true, 10000)
  R.permissions.history = await js(`document.querySelector('[aria-label="Permission history"]')?.textContent ?? ''`)
  await sleep(300)
  R.history_shot = await page.screenshot('app-internet-permission-history')
  note('permissions', { capability: R.permissions.capability, rows: R.permissions.rows })

  R.muted = BrowserWindow.getAllWindows().filter(w => !w.isDestroyed()).every(w => w.webContents.isAudioMuted())
  R.clipboard = await js('window.__clipboardCalls')
  return R
}
