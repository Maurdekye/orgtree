// tools/rig/desktop/ticket-titles.cjs: the window half of
// tools/rig/proofs/ticket-titles.mjs. The real renderer bundle runs against the
// isolated rig engine; input goes only through CDP and DOM clicks in this window.
// Opens the user's inbox and the agent's mail naming a docket item, reads the
// ticket chip and captures it in a dark and a light theme, then writes the
// `ready` flag the proof waits for and keeps the window open while the agent
// renames the item: the chip must follow without a reload.
// Refuses outside Session 0, refuses every permission, replaces each page
// clipboard path with a refusal, and is SILENT: every webContents is muted.
'use strict'
const { BrowserWindow, app, session } = require('electron')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')

const CLIPBOARD = `(() => { if (window.__clipboardCalls) return true
  const calls = []; Object.defineProperty(window, '__clipboardCalls', { value: calls })
  const deny = name => () => { calls.push(name); return Promise.reject(new DOMException('Clipboard denied', 'NotAllowedError')) }
  try { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: Object.freeze({ read: deny('read'), readText: deny('readText'), write: deny('write'), writeText: deny('writeText') }) }) } catch { calls.push('stub-failed') }
  const exec = Document.prototype.execCommand
  Document.prototype.execCommand = function (command, ...rest) { if (/^(copy|cut|paste)$/i.test(String(command))) { calls.push('execCommand:' + command); return false } return exec.call(this, command, ...rest) }
  return true })()`
// the contrast themes as the app applies them (contrast.tsx): one class on the root
const CONTRASTS = ['obsidian-black', 'charcoal', 'solarized-light', 'light']

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
  const contrast = id => js(`(() => { for (const c of ${JSON.stringify(CONTRASTS)}) document.documentElement.classList.toggle('contrast-' + c, c === ${JSON.stringify(id)}); return true })()`)

  // The user's inbox, then the agent's mail (click only a row that is not selected:
  // the inbox may already show the newest mail, and a click on it closes it).
  await page.waitFor('button.ask-bell', { timeout: 30000 })
  await js(`document.querySelector('button.ask-bell').click()`, true)
  await page.waitFor('.mailer-list .mailrow', { timeout: 30000 })
  await sleep(800)
  const opened = await js(`(() => { const row = [...document.querySelectorAll('.mailer-list .mailrow')].find(r => /tracked in/i.test(r.textContent)); if (!row) return 'missing'
    if (row.classList.contains('on')) return 'already selected'; row.click(); return 'clicked' })()`, true)
  note('mail', { opened })
  const sel = `.mailer-read [data-ref-token=${JSON.stringify(args.token)}]`
  const chip = () => js(`(() => { const c = document.querySelector(${JSON.stringify(sel)}); if (!c) return null
    const m = c.querySelector('.ref-mark'), mr = m ? m.getBoundingClientRect() : null
    return { token: c.getAttribute('data-ref-token'), text: c.textContent, copy: c.getAttribute('data-copy-ticket-title'), live: c.tagName === 'BUTTON',
      mark: m ? [...m.classList].find(x => x.startsWith('ref-mark-')) : null, markBox: mr ? [Math.round(mr.width), Math.round(mr.height)] : null,
      ink: getComputedStyle(c).color, markColor: m ? getComputedStyle(m).color : null } })()`)
  const titled = await until(chip, v => v?.text === args.title, 20000)
  R.chip = titled.v
  note('chip', { ...R.chip, ms: titled.ms })

  R.themes = []
  for (const [name, id] of [['dark', 'charcoal'], ['light', 'light']]) {
    await contrast(id); await paint()
    R.themes.push({ theme: name, shot: await page.screenshot('ticket-title-' + name), ...(await chip()) })
  }
  note('themes', R.themes.map(t => ({ theme: t.theme, ink: t.ink, mark: t.markColor })))

  // the agent renames the item now; the chip must follow without a reload
  fs.writeFileSync(args.ready, new Date().toISOString())
  const renamed = await until(chip, v => v?.text === args.renamed, 30000)
  await paint()
  R.renamed = { ...renamed.v, ms: renamed.ms, shot: await page.screenshot('ticket-title-renamed') }
  note('renamed', { text: R.renamed.text, ms: renamed.ms })

  R.muted = BrowserWindow.getAllWindows().filter(w => !w.isDestroyed()).every(w => w.webContents.isAudioMuted())
  R.clipboard = await js('window.__clipboardCalls')
  return R
}
