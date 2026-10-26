// tools/rig/desktop/app-history.cjs: the Panel settings History tab for
// tools/rig/proofs/app-history.mjs (USER 2026-10-26 md6edfebc1975: only fired
// events agents can listen to and the copy starting and stopping). The real
// renderer bundle runs against the isolated rig engine in the rig's offscreen
// window; input goes only through CDP to that window. It refuses to run outside
// Session 0, refuses every permission request and replaces each page clipboard
// path with a refusal.
'use strict'
const { session } = require('electron')
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
  const R = { steps: [] }
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
  const until = async (fn, arg, timeout = 10000) => {
    const end = Date.now() + timeout
    while (Date.now() < end) { if (await page.eval(fn, arg)) return true; await sleep(200) }
    return false
  }

  await page.click('.apps-button', { after: 800 })
  await page.waitFor('.custom-apps-menu', { timeout: 10000 })
  await page.click(`.custom-apps-menu [aria-label="Settings for ${args.label}"]`, { after: 1000 })
  await page.waitFor('[role="tab"]', { timeout: 10000 })
  R.tabs = await page.eval(() => [...document.querySelectorAll('[role="tab"]')].map(e => e.textContent.trim()))
  const tab = await page.eval(() => { const e = [...document.querySelectorAll('[role="tab"]')].find(b => b.textContent.trim() === 'History'); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })
  if (!tab) throw new Error('no History tab')
  await page.click(tab, { after: 800 })
  await until(() => document.querySelectorAll('.custom-app-history li').length > 0, undefined, 10000)
  await sleep(400)
  Object.assign(R, await page.eval(() => {
    const list = document.querySelector('.custom-app-history'), group = list?.closest('.set-group')
    return { lead: group?.querySelector(':scope > p.dim:first-child')?.textContent ?? null, entries: [...document.querySelectorAll('.custom-app-history li')].map(e => e.textContent.trim()) }
  }))
  await page.screenshot('01-history-tab')
  R.clipboard = { calls: await page.eval(() => window.__clipboardCalls.slice()), checks: permissions.clipboardChecks, requests: permissions.requests }
  return R
}
