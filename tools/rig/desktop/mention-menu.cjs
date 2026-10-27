// tools/rig/desktop/mention-menu.cjs: the window half of
// tools/rig/proofs/mention-menu.mjs. The real renderer bundle runs against the
// isolated rig engine; input goes only through CDP in this window.
// Quick chat: type args.quick.type, read the @ list, Tab, read the box, then
// Enter (Quick chat hires an agent with that kickoff and focuses its desk) and
// read the sent message's chip. Then that desk's composer: args.desk.kinds.type
// (every kind found by a word) is read, captured and erased, then args.desk the
// same way as Quick chat, sent with Enter.
// Refuses outside Session 0, refuses every permission, replaces each page
// clipboard path with a refusal, and is SILENT: every webContents is muted.
'use strict'
const { app, session } = require('electron')
const { execFileSync } = require('node:child_process')

const CLIPBOARD = `(() => { if (window.__clipboardCalls) return true
  const calls = []; Object.defineProperty(window, '__clipboardCalls', { value: calls })
  const deny = name => () => { calls.push(name); return Promise.reject(new DOMException('Clipboard denied', 'NotAllowedError')) }
  try { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: Object.freeze({ read: deny('read'), readText: deny('readText'), write: deny('write'), writeText: deny('writeText') }) }) } catch { calls.push('stub-failed') }
  const exec = Document.prototype.execCommand
  Document.prototype.execCommand = function (command, ...rest) { if (/^(copy|cut|paste)$/i.test(String(command))) { calls.push('execCommand:' + command); return false } return exec.call(this, command, ...rest) }
  return true })()`

// the open @ list and its composer, with their on-screen boxes (runs in the page)
function probe(composer) {
  const box = e => { const r = e.getBoundingClientRect(); return { x: Math.floor(r.x), y: Math.floor(r.y), width: Math.ceil(r.width), height: Math.ceil(r.height) } }
  const shown = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
  const menu = [...document.querySelectorAll('.agent-mentions')].find(shown)
  const kinds = ['presentation', 'ticket', 'app', 'panel']
  const rows = menu ? [...menu.querySelectorAll('.agent-mention-item')].map(r => {
    const kind = kinds.find(k => r.classList.contains('mention-' + k)) ?? 'agent'
    return { kind, name: r.querySelector('.agent-mention-name')?.textContent ?? '',
      icon: kind === 'agent' ? !!r.querySelector('.tier') : !!r.querySelector(`.mention-${kind}-mark svg`),
      active: r.classList.contains('active'), label: r.getAttribute('aria-label'), box: box(r) }
  }) : []
  const input = [...document.querySelectorAll(composer)].find(shown)
  return { menu: menu ? box(menu) : null, below: !!menu && menu.classList.contains('below'), view: [innerWidth, innerHeight], rows,
    composer: input ? { value: input.value, box: box(input) } : null }
}
// a sent message's chip for this token, outside the @ list (runs in the page)
function chip(token) {
  const c = [...document.querySelectorAll('[data-ref-token]')].find(e => e.getAttribute('data-ref-token') === token
    && e.getBoundingClientRect().width > 0 && !e.closest('.agent-mentions, textarea, input'))
  if (!c) return null
  const m = c.querySelector('.ref-mark'), r = c.getBoundingClientRect()
  return { token, text: c.textContent, live: c.tagName === 'BUTTON', mark: m ? [...m.classList].find(x => x.startsWith('ref-mark-')) : null,
    box: [Math.round(r.width), Math.round(r.height)] }
}

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
  const paint = () => main.webContents.executeJavaScript('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 150))))')
  const until = async (fn, arg, ok, timeout = 15000) => {
    const t0 = Date.now(); let v = await page.eval(fn, arg)
    while (!ok(v) && Date.now() - t0 < timeout) { await sleep(150); v = await page.eval(fn, arg) }
    return v
  }
  await page.waitFor('.quickchat-input', { timeout: 30000 })
  await page.waitFor('[data-copy-agent-name="boss"]', { timeout: 30000 })
  await sleep(1200)

  // one composer: type, read the list once it holds the wanted presentations, Tab, Enter, read the chip
  async function complete(where, composer, want) {
    await page.click(composer)
    let kinds = null
    if (want.kinds) {
      // every kind found by one word, captured, then the word erased
      await page.type(want.kinds.type)
      await until(probe, composer, v => v.rows.length >= want.kinds.rows.length)
      await paint()
      kinds = await page.eval(probe, composer)
      note(where + ' kinds', { rows: kinds.rows.map(r => [r.kind, r.name]) })
      await page.screenshot(`${where}-0-kinds`)
      for (let i = 0; i < want.kinds.erase; i++) await page.press('Backspace')
      await paint()
    }
    await page.type(want.type)
    const listed = await until(probe, composer, v => v.rows.filter(r => r.kind === 'presentation').length >= want.rows.length)
    await paint()
    const shown = await page.eval(probe, composer)
    note(where + ' list', { rows: shown.rows.map(r => [r.kind, r.name]), waited: listed.rows.length })
    await page.screenshot(`${where}-1-menu`)
    await page.press('Tab')
    await paint()
    const completed = (await page.eval(probe, composer)).composer?.value ?? null
    note(where + ' completed', completed)
    await page.screenshot(`${where}-2-completed`)
    await page.press('Enter')
    // the chip shows the token until the title read answers, then the title
    const sent = await until(chip, want.token, v => !!v && v.text === want.title, 30000)
    await paint()
    note(where + ' chip', sent)
    await page.screenshot(`${where}-3-sent`)
    return { menu: shown.menu, below: shown.below, view: shown.view, rows: shown.rows, composer: shown.composer, completed, chip: sent,
      ...(kinds ? { kinds: { rows: kinds.rows, menu: kinds.menu, below: kinds.below } } : {}) }
  }
  R.quick = await complete('quick', '.quickchat-input', args.quick)
  // Quick chat focused the new agent's desk: its composer is the next one
  await page.waitFor('textarea[data-first-use-chat]', { timeout: 30000 })
  await sleep(800)
  R.desk = await complete('desk', 'textarea[data-first-use-chat]', args.desk)
  R.muted = main.webContents.isAudioMuted()
  R.clipboard = await main.webContents.executeJavaScript('window.__clipboardCalls ?? []')
  return R
}
