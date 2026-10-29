// A ticket link's hover names its slug, not the title the link already shows (USER 2026-10-29 m3ad5633675ff).
// Builds nothing itself: tickettooltip-visual.mjs bundles tickettooltip-visual.tsx and runs this in offscreen
// Electron. Real CDP pointer hover on each surface's link (tool row "open" button, typed reference, Markdown
// mention, inbox reply target, another org's ticket); the native title is read back from the hovered element
// (an offscreen window paints no OS tooltip) and written into the page's readout for the screenshot.
// Silent and isolated (team TEST WINDOW ISOLATION / SILENT TESTS): Session 0 required, audio muted, every
// permission refused, the clipboard stubbed out, input only through this window's CDP.
'use strict'
const { execFileSync } = require('node:child_process')

const CLIPBOARD_GUARD = `(() => {
  const no = () => Promise.reject(new DOMException('clipboard disabled in the rig', 'NotAllowedError'))
  const stub = { readText: no, writeText: no, read: no, write: no, addEventListener() {}, removeEventListener() {} }
  try { Object.defineProperty(Navigator.prototype, 'clipboard', { get: () => stub, configurable: false }) } catch (e) {}
  const exec = Document.prototype.execCommand
  Document.prototype.execCommand = function (cmd, ...rest) {
    if (/^(copy|cut|paste)$/i.test(String(cmd))) return false
    return exec.call(this, cmd, ...rest)
  }
  for (const ev of ['copy', 'cut', 'paste']) window.addEventListener(ev, (e) => { e.preventDefault(); e.stopImmediatePropagation() }, true)
})()`

function sessionOf(pid) {
  try {
    return Number(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid}).SessionId`],
      { timeout: 20000, windowsHide: true }).toString().trim())
  } catch (e) { return `unknown: ${String(e.message || e).slice(0, 120)}` }
}

const SLUG = 'project-card-resize'
const TITLE = 'Project card shrinks and grows as it is highlighted and unhighlighted'

module.exports = async (page) => {
  const wc = page.win.webContents
  wc.setAudioMuted(true)
  wc.session.setPermissionRequestHandler((_wc, _permission, cb) => cb(false))
  wc.session.setPermissionCheckHandler(() => false)
  await page.cdp('Page.addScriptToEvaluateOnNewDocument', { source: CLIPBOARD_GUARD })
  await page.resize('1000x700')
  await page.goto('/')
  await page.waitFor('[data-object-nav="ticket"]', { timeout: 10000 })
  const isolation = {
    sessionId: sessionOf(process.pid), audioMuted: wc.isAudioMuted(),
    clipboard: await page.eval(() => navigator.clipboard.readText().then(() => 'readable', (e) => e.name)),
  }
  page.log('isolation', isolation)
  if (isolation.sessionId !== 0) throw new Error(`not Session 0: ${JSON.stringify(isolation)}`)
  if (!isolation.audioMuted || isolation.clipboard !== 'NotAllowedError') throw new Error(`not isolated: ${JSON.stringify(isolation)}`)

  // tag each surface's ticket link by its section heading
  const tagged = await page.eval(() => {
    const surfaces = [['tool', 'Transcript tool row'], ['typed', 'Typed reference'], ['markdown', 'Markdown mention'], ['reply', 'Inbox reply target']]
    for (const [key, heading] of surfaces) {
      const section = [...document.querySelectorAll('section')].find((s) => s.querySelector('h2')?.textContent === heading)
      section?.querySelector('[data-object-nav="ticket"]')?.setAttribute('data-cap', key)
    }
    document.querySelector('[data-surface="away"]')?.setAttribute('data-cap', 'away')
    return [...document.querySelectorAll('[data-cap]')].map((e) => [e.getAttribute('data-cap'), (e.textContent || '').trim().slice(0, 40)])
  })
  page.log('tagged', tagged)
  if (tagged.length !== 5) throw new Error(`expected 5 ticket links, found ${JSON.stringify(tagged)}`)

  const hovered = []
  const hoverRead = async (key, status, label, shot) => {
    await page.eval((s) => window.setTicketState(s), status)
    // leave the previous link first (onto the sticky readout, always in view), so its title is cleared
    // and the next hover reads afresh; bring the link to mid-window, clear of the readout, then hover it
    await page.hover('#hover-readout')
    await page.sleep(150)
    await page.eval((k) => document.querySelector(`[data-cap="${k}"]`).scrollIntoView({ block: 'center' }), key)
    await page.sleep(150)
    await page.hover(`[data-cap="${key}"]`)
    // the native hover clears the static title and sets the read one; wait for the status-led text
    for (const end = Date.now() + 8000; ; await page.sleep(100)) {
      const now = await page.eval((k) => document.querySelector(`[data-cap="${k}"]`)?.getAttribute('title') || '', key)
      if (/^(Open|In progress|Blocked|Done|Archived) · /.test(now)) break
      if (Date.now() > end) throw new Error(`no hover title on ${key}: ${JSON.stringify(now)}`)
    }
    const row = await page.eval((k, l) => {
      const el = document.querySelector(`[data-cap="${k}"]`)
      const title = el.getAttribute('title') || ''
      const line = document.createElement('div')
      line.textContent = `${l}: ${title}`
      document.getElementById('hover-readout').appendChild(line)
      return { key: k, shown: (el.textContent || '').trim(), title }
    }, key, label)
    hovered.push(row)
    if (shot) row.screenshot = await page.screenshot(shot)
    return row
  }
  await hoverRead('tool', 'open', 'Transcript tool row ("open" button)')
  await hoverRead('typed', 'open', 'Typed reference')
  await hoverRead('markdown', 'open', 'Markdown mention')
  await hoverRead('reply', 'open', 'Inbox reply target')
  await hoverRead('away', 'open', "Another org's ticket", 'ticket-hover-slug-open-1000x700')
  await hoverRead('typed', 'in_progress', 'Typed reference, now in progress')
  await hoverRead('markdown', 'blocked', 'Markdown mention, now blocked', 'ticket-hover-slug-states-1000x700')

  const expected = { tool: `Open · ${SLUG}`, typed: `Open · ${SLUG}`, markdown: `Open · ${SLUG}`, reply: `Open · ${SLUG}`, away: `Open · away/${SLUG}` }
  const bad = hovered.filter((h, i) => i < 5 ? h.title !== expected[h.key]
    : h.title !== (h.key === 'typed' ? `In progress · ${SLUG}` : `Blocked · ${SLUG}`))
  const leaked = hovered.filter((h) => h.title.includes('Project card shrinks'))
  if (bad.length || leaked.length) throw new Error(`hover text is wrong: ${JSON.stringify({ bad, leaked })}`)
  return { isolation, hovered: hovered.map(({ key, shown, title }) => ({ key, shown, title })),
    screenshots: hovered.map((h) => h.screenshot).filter(Boolean) }
}
