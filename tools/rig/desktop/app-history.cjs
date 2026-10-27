// tools/rig/desktop/app-history.cjs: the window half of tools/rig/proofs/app-history.mjs.
// USER 2026-10-27 md2006b10cf40: "make the hidtory tab reload in realtime, be more
// list like wity expandable rows, and lazily losd as you sfrollcdown (remof3 th4
// refresh button)"; m838e66af753b: "ssme for permission history, and put tgat on i6s
// own tab". Captures Panel settings > History and App settings > Permission history,
// each collapsed and with a row expanded; the hidden running copy fires from its own
// frame while History is open, a permission change is made on the Permissions tab
// while Permission history stays mounted, and both lists are scrolled to their end.
// The real renderer bundle runs against the isolated rig engine; input goes only
// through CDP to this window and the app's own frame. Refuses outside Session 0,
// refuses every permission request, replaces each page clipboard path with a
// refusal, and is SILENT: every webContents is muted.
'use strict'
const { app, session } = require('electron')
const { execFileSync } = require('node:child_process')

// Every page clipboard path refuses, from document start.
const CLIPBOARD = `(() => {
  const calls = []; Object.defineProperty(window, '__clipboardCalls', { value: calls })
  const deny = name => () => { calls.push(name); return Promise.reject(new DOMException('Clipboard denied', 'NotAllowedError')) }
  try { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: Object.freeze({ read: deny('read'), readText: deny('readText'), write: deny('write'), writeText: deny('writeText') }) }) } catch { calls.push('stub failed') }
  const exec = Document.prototype.execCommand
  Document.prototype.execCommand = function (command, ...rest) { if (/^(copy|cut|paste)$/i.test(String(command))) { calls.push('execCommand:' + command); return false } return exec.call(this, command, ...rest) }
})()`

module.exports = async (page, { org, args }) => {
  const wc = page.win.webContents, sleep = page.sleep
  wc.setAudioMuted(true)
  app.on('web-contents-created', (_e, contents) => { try { contents.setAudioMuted(true) } catch { /* gone */ } })
  const R = { steps: [] }
  const note = (name, detail) => { R.steps.push({ at: new Date().toISOString(), name, ...(detail === undefined ? {} : { detail }) }); page.log(name, detail === undefined ? '' : detail) }
  const sessionId = Number(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${process.pid}).SessionId`], { encoding: 'utf8', windowsHide: true }).trim())
  R.session = { electronPid: process.pid, sessionId, rendererPid: wc.getOSProcessId() }
  if (sessionId !== 0) throw new Error(`refusing to run outside Windows Session 0 (this Electron runs in Session ${sessionId})`)
  const permissions = { requests: [], clipboardChecks: 0 }
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => { permissions.requests.push(permission); callback(false) })
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => { if (/clipboard/i.test(permission)) { permissions.clipboardChecks++; return false } return true })
  await page.cdp('Page.enable')
  await page.cdp('Page.addScriptToEvaluateOnNewDocument', { source: CLIPBOARD })
  await page.goto('/o/' + org)
  await page.waitFor('.apps-button', { timeout: 30000 })
  R.installed = await page.eval(() => ({ clipboardStub: Array.isArray(window.__clipboardCalls) }))
  if (!R.installed.clipboardStub) throw new Error('the clipboard refusal did not install')
  R.muted = wc.isAudioMuted()
  // Polls get() until ok(value); returns the last value and whether it passed.
  const until = async (get, ok, timeout = 10000) => { const t0 = Date.now(); let v = await get(); while (!ok(v) && Date.now() - t0 < timeout) { await sleep(200); v = await get() } return { v, ok: ok(v), ms: Date.now() - t0 } }

  // One list's rows as the user sees them.
  const state = label => page.eval(label => {
    const list = document.querySelector(`ol[aria-label="${label}"]`)
    if (!list) return null
    const rows = [...list.querySelectorAll(':scope > li > button[aria-expanded]')]
    return { rows: rows.length, more: !!list.querySelector('.custom-app-log-more'), scrolls: list.scrollHeight > list.clientHeight + 1,
      maxRow: Math.round(Math.max(0, ...rows.slice(0, 12).map(b => b.getBoundingClientRect().height))), expanded: rows.filter(b => b.getAttribute('aria-expanded') === 'true').length,
      top: rows[0]?.textContent ?? null, second: rows[1]?.textContent ?? null, last: rows.at(-1)?.textContent ?? null,
      gap: Math.round(list.scrollHeight - list.clientHeight - list.scrollTop) }
  }, label)
  const tab = async name => {
    const at = await page.eval(name => { const e = [...document.querySelectorAll('[role="tab"]')].find(b => b.textContent.trim() === name && b.offsetParent !== null); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } }, name)
    if (!at) throw new Error('no ' + name + ' tab')
    await page.click(at, { after: 700 })
  }
  const tabs = () => page.eval(() => [...document.querySelectorAll('[role="tab"]')].filter(b => b.offsetParent !== null).map(e => e.textContent.trim()))
  const panelText = () => page.eval(() => document.querySelector('[role="tabpanel"]:not([hidden])')?.textContent ?? '')
  const refresh = () => page.eval(() => [...document.querySelectorAll('[role="tabpanel"]:not([hidden]) button')].some(b => /refresh/i.test(b.textContent)))
  // A row's button (it stays in view inside its own list) and its open details.
  const row = async (label, i) => {
    const at = await page.eval((label, i) => { const b = document.querySelectorAll(`ol[aria-label="${label}"] > li > button[aria-expanded]`)[i]; if (!b) return null; b.scrollIntoView({ block: 'nearest' }); const r = b.getBoundingClientRect(); return { x: r.x + Math.min(r.width / 2, 160), y: r.y + r.height / 2 } }, label, i)
    if (!at) throw new Error(`no row ${i} in ${label}`)
    await page.click(at, { after: 500 })
    return page.eval((label, i) => { const b = document.querySelectorAll(`ol[aria-label="${label}"] > li > button[aria-expanded]`)[i]; const id = b.getAttribute('aria-controls'); return { state: b.getAttribute('aria-expanded'), text: id ? document.getElementById(id)?.textContent ?? null : null } }, label, i)
  }
  // Mouse-wheel over the list until every page has loaded and it rests at its end, counting the pages that arrive.
  const wheel = async label => {
    const c = await page.eval(label => { const l = document.querySelector(`ol[aria-label="${label}"]`).getBoundingClientRect(); return { x: l.x + l.width / 2, y: l.y + l.height / 2 } }, label)
    await page.cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', x: c.x, y: c.y, deltaX: 0, deltaY: 1500 })
    await sleep(600)
  }
  const toEnd = async label => {
    let last = await state(label), pages = 0
    for (let i = 0; i < 40 && (last.more || last.gap > 1); i++) { await wheel(label); const now = await state(label); if (now.rows > last.rows) pages++; last = now }
    return { ...last, pages }
  }

  // Panel settings > History of the hidden running copy.
  await page.click('.apps-button', { after: 800 })
  await page.waitFor('.custom-apps-menu', { timeout: 10000 })
  await page.click(`.custom-apps-menu [aria-label="Settings for ${args.label}"]`, { after: 1000 })
  await page.waitFor('[role="tab"]', { timeout: 10000 })
  R.panelTabs = await tabs()
  await tab('History')
  const H = R.history = {}
  await until(() => state('History'), s => !!s && s.rows > 0, 10000)
  await sleep(400)
  H.lead = await page.eval(() => document.querySelector('[role="tabpanel"]:not([hidden]) .set-group > p.dim')?.textContent ?? null)
  H.refresh = await refresh()
  H.first = await state('History')
  note('history first page', H.first)
  await page.screenshot('01-history')
  H.expanded = await row('History', 0)
  await page.screenshot('02-history-expanded')
  H.collapsed = (await row('History', 0)).state
  await row('History', 0)
  // The copy's own frame fires; nothing is clicked while the row arrives.
  const findFrame = async () => { for (const f of wc.mainFrame.framesInSubtree) { if (f === wc.mainFrame) continue; if (await f.executeJavaScript("!!document.getElementById('history-capture-app')").catch(() => false)) return f } return null }
  const frame = (await until(findFrame, f => !!f, 20000)).v
  if (!frame) throw new Error('no app frame for the running copy')
  await until(() => frame.executeJavaScript('!!(window.orgtree && window.fireNow)').catch(() => false), v => v === true, 10000)
  const rowsBefore = (await state('History')).rows
  await frame.executeJavaScript('window.fireNow(1).then(() => true, e => String(e))')
  const live = await until(() => state('History'), s => s.rows === rowsBefore + 1 && /app/.test(s.top ?? ''), 15000)
  H.live = { ok: live.ok, ms: live.ms, rows: live.v.rows, top: live.v.top, second: live.v.second, expanded: live.v.expanded }
  note('history live app fire', H.live)
  await page.screenshot('03-history-live')
  H.scrolled = await toEnd('History')
  note('history scrolled', H.scrolled)
  await page.screenshot('04-history-end')
  await page.press('Escape')
  await page.waitFor('[role="tab"]', { gone: true, timeout: 10000 })

  // App settings > Permission history of the Feed app.
  if (!await page.eval(() => !!document.querySelector('.custom-apps-menu'))) await page.click('.apps-button', { after: 800 })
  await page.waitFor('.custom-apps-menu', { timeout: 10000 })
  await page.click(`.custom-apps-menu [aria-label="Settings for ${args.app}"]`, { after: 1000 })
  await page.waitFor('[role="tab"]', { timeout: 10000 })
  R.appTabs = await tabs()
  const P = R.permissions = {}
  await tab('Permissions')
  P.inPermissions = (await panelText()).includes('Permission history')
  await tab('Permission history')
  await until(() => state('Permission history'), s => !!s && s.rows > 0, 10000)
  await sleep(400)
  P.refresh = await refresh()
  P.first = await state('Permission history')
  await page.screenshot('05-permission-history')
  P.expanded = await row('Permission history', 0)
  await page.screenshot('06-permission-history-expanded')
  // A change on the Permissions tab; the history list stays mounted and shows it on top.
  await tab('Permissions')
  const changed = await page.eval(() => { const s = document.querySelector('[role="tabpanel"]:not([hidden]) select[aria-label="Internet access permission"]'); if (!s) return null; const to = s.value === 'ask' ? 'deny' : 'ask'; s.value = to; s.dispatchEvent(new Event('change', { bubbles: true })); return to })
  await sleep(1200)
  await tab('Permission history')
  const want = changed === 'ask' ? /Internet access: set to Ask/ : /Internet access: denied/
  const plive = await until(() => state('Permission history'), s => s.rows === P.first.rows + 1 && want.test(s.top ?? ''), 15000)
  P.live = { ok: plive.ok && !!changed, ms: plive.ms, changed, top: plive.v.top, rows: plive.v.rows, kept: await page.eval(() => document.querySelectorAll('ol[aria-label="Permission history"] > li > button[aria-expanded]')[1]?.getAttribute('aria-expanded') ?? null) }
  note('permission history live change', P.live)
  await page.screenshot('07-permission-history-live')
  P.scrolled = await toEnd('Permission history')
  note('permission history scrolled', P.scrolled)
  R.clipboard = { calls: await page.eval(() => window.__clipboardCalls.slice()), checks: permissions.clipboardChecks, requests: permissions.requests }
  return R
}
