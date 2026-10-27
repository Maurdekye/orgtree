// tools/rig/desktop/row-tokens.cjs: the window half of tools/rig/proofs/row-tokens.mjs.
// USER 2026-10-27 m10e4ca6d8934: "token counts in messages of all kinds (agent, monitor
// event, system, etc)"; m4bad9bdbd3a1: counts in the message header, next to the time, and
// m7c48d80b13f4: "+xyt" for the turn envelope. Opens each agent's desk, reads every count
// with its tooltip and where it sits, and screenshots it. The real renderer bundle
// runs against the isolated rig engine; input goes only through CDP to this window.
// Refuses outside Session 0, refuses every permission request, replaces each page
// clipboard path with a refusal, and is SILENT: every webContents is muted.
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
  const R = { desks: {} }
  const sessionId = Number(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${process.pid}).SessionId`], { encoding: 'utf8', windowsHide: true }).trim())
  R.session = { electronPid: process.pid, sessionId, rendererPid: wc.getOSProcessId() }
  if (sessionId !== 0) throw new Error(`refusing to run outside Windows Session 0 (this Electron runs in Session ${sessionId})`)
  const permissions = { requests: [], clipboardChecks: 0 }
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => { permissions.requests.push(permission); callback(false) })
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => { if (/clipboard/i.test(permission)) { permissions.clipboardChecks++; return false } return true })
  await page.cdp('Page.enable')
  await page.cdp('Page.addScriptToEvaluateOnNewDocument', { source: CLIPBOARD })
  R.muted = wc.isAudioMuted()
  for (const agent of args.agents) {
    await page.goto('/o/' + org)
    const card = `[data-copy-agent-name="${agent}"]`
    await page.waitFor(card, { timeout: 30000 })
    if (!R.installed) {
      R.installed = await page.eval(() => ({ clipboardStub: Array.isArray(window.__clipboardCalls) }))
      if (!R.installed.clipboardStub) throw new Error('the clipboard refusal did not install')
    }
    await sleep(800)
    await page.rightClick(card)
    await page.waitFor('.ctxmenu[role="menu"]')
    await page.hover({ selector: 'button.ctxmenu-item', text: '^Open( ▸)?$', regex: true })
    await sleep(300)
    const items = await page.eval(() => [...document.querySelectorAll('.ctxmenu[role="menu"] button.ctxmenu-item')].map(b => (b.innerText || '').trim()))
    const desk = items.find(t => /desk/i.test(t))
    if (!desk) throw new Error('no desk item in ' + JSON.stringify(items))
    await page.click({ selector: 'button.ctxmenu-item', text: `^${desk.replace(/[.*+?^${}()|[\]\\]/g, c => '\\' + c)}$`, regex: true })
    await page.waitFor(() => document.querySelectorAll('.own-tokens').length >= 2, { timeout: 30000 })
    await sleep(800)
    R.desks[agent] = await page.eval(() => {
      const read = el => ({ text: el.textContent.replace(/\s+/g, ' ').trim().replace(/^·\s*/, ''), title: el.getAttribute('title') ?? '',
        afterTime: el.closest('.msg-tokens')?.previousElementSibling?.tagName === 'TIME' && !!el.closest('.turn-mail-head') })
      const counts = [...document.querySelectorAll('.token-count')]
      return { owns: [...document.querySelectorAll('.own-tokens')].map(read), envelopes: [...document.querySelectorAll('.envelope-tokens')].map(read),
        margins: document.querySelectorAll('.row-tokens, .row-tokens-line').length,
        // a count anywhere but a message header, a tool chip or a thought line
        stray: counts.filter(el => !el.closest('.turn-mail-head') && !el.matches('.thinking-tokens, .tool-input-tokens, .tool-output-tokens')).map(read),
        inputs: [...document.querySelectorAll('.tool-input-tokens')].map(read),
        thinking: [...document.querySelectorAll('.thinking-tokens')].map(read), outputs: [...document.querySelectorAll('.tool-output-tokens')].map(read) }
    })
    await page.eval(() => { const at = document.querySelector('.envelope-tokens') ?? document.querySelector('.own-tokens'); at?.closest('.turn-mail')?.scrollIntoView({ block: 'start' }) })
    await sleep(500)
    await page.screenshot(`${agent}-desk`)
  }
  R.clipboard = { calls: await page.eval(() => window.__clipboardCalls.slice()), checks: permissions.clipboardChecks, requests: permissions.requests }
  return R
}
