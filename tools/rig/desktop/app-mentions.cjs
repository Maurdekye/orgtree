// tools/rig/desktop/app-mentions.cjs: the window half of
// tools/rig/proofs/app-mentions.mjs. The real renderer bundle runs against the
// isolated rig engine; input goes only through CDP and DOM clicks in this window.
// Opens the user's inbox and the agent's mail with an app mention and a panel
// mention, reads both chips, then clicks each: the app's most recently used copy
// (running hidden) shows, then the stopped panel starts and opens.
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
  const paint = () => js('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 150))))')

  // The user's inbox, then the agent's mail.
  await page.waitFor('button.ask-bell', { timeout: 30000 })
  await js(`document.querySelector('button.ask-bell').click()`, true)
  await page.waitFor('.mailer-list .mailrow', { timeout: 30000 })
  // the inbox may already have selected the newest mail, and a click on the
  // selected row closes it: click only a row that is not selected
  await sleep(800)
  const opened = await js(`(() => { const row = [...document.querySelectorAll('.mailer-list .mailrow')].find(r => /caption tools/i.test(r.textContent)); if (!row) return 'missing'
    if (row.classList.contains('on')) return 'already selected'; row.click(); return 'clicked' })()`, true)
  note('mail', { opened })
  const sel = token => `.mailer-read [data-ref-token=${JSON.stringify(token)}]`
  const chip = token => js(`(() => { const c = document.querySelector(${JSON.stringify(sel(token))}); if (!c) return null
    const r = c.getBoundingClientRect(), m = c.querySelector('.ref-mark'), mr = m ? m.getBoundingClientRect() : null
    return { text: c.textContent, title: c.title, live: c.tagName === 'BUTTON', outcome: c.getAttribute('data-ref-outcome'),
      mark: m ? [...m.classList].find(x => x.startsWith('ref-mark-')) : null, markBox: mr ? [Math.round(mr.width), Math.round(mr.height)] : null,
      box: [Math.round(r.width), Math.round(r.height)], color: getComputedStyle(c).color } })()`)
  // the names arrive from the engine's refs read
  const named = await until(async () => ({ app: await chip(args.appRef), panel: await chip(args.panelRef) }),
    v => v.app?.outcome === 'ready' && v.panel?.outcome === 'ready' && v.app.title !== '' && v.panel.title !== '', 20000)
  R.chips = named.v
  await paint()
  R.mail_shot = await page.screenshot('app-mentions-mail')
  note('chips', R.chips)

  const shown = id => js(`(() => { const s = document.querySelector('section.custom-app-window[data-custom-panel=${JSON.stringify(id)}]'); if (!s || s.dataset.parked) return null
    const r = s.getBoundingClientRect(); return r.width > 0 && r.height > 0 ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : null })()`)
  const click = token => js(`(() => { const c = document.querySelector(${JSON.stringify(sel(token))}); if (!c || c.tagName !== 'BUTTON') return false; c.click(); return true })()`, true)

  // The app mention: the engine picks the most recently used copy, hidden until now.
  R.appClick = { before: await shown(args.second), clicked: await click(args.appRef) }
  const a = await until(() => shown(args.second), v => !!v, 20000)
  Object.assign(R.appClick, { shown: a.ok ? args.second : null, window: a.v, ms: a.ms })
  await paint()
  R.app_shot = await page.screenshot('app-mentions-app-clicked')
  note('app click', R.appClick)

  // The panel mention: a stopped copy starts and opens.
  R.panelClick = { before: await shown(args.first), clicked: await click(args.panelRef) }
  const b = await until(() => shown(args.first), v => !!v, 20000)
  Object.assign(R.panelClick, { shown: b.ok ? args.first : null, window: b.v, ms: b.ms })
  await paint()
  R.panel_shot = await page.screenshot('app-mentions-panel-clicked')
  note('panel click', R.panelClick)

  R.muted = BrowserWindow.getAllWindows().filter(w => !w.isDestroyed()).every(w => w.webContents.isAudioMuted())
  R.clipboard = await js('window.__clipboardCalls')
  return R
}
