// A desk's tool calls while the fake CLI writes and runs them: samples the transcript DOM on every
// mutation (and every 25 ms) and reports each state in which one call is drawn twice, as a saved chip
// AND as its live "writing" row (4.5.1: the live row stayed under the saved one for 0.2-3 s).
// args: { agent: "<name>", mail: "<text that starts the scripted turn>", done: "<its last text>" }
// Silent and isolated (team TEST WINDOW ISOLATION / SILENT TESTS): audio muted, every permission refused,
// the clipboard stubbed out, input only through this window's CDP; the receipt records session and state.
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
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid}).SessionId`],
      { timeout: 20000, windowsHide: true }).toString().trim()
    return Number(out)
  } catch (e) { return `unknown: ${String(e.message || e).slice(0, 120)}` }
}

module.exports = async (page, { org, args }) => {
  const wc = page.win.webContents
  wc.setAudioMuted(true)
  wc.session.setPermissionRequestHandler((_wc, _permission, cb) => cb(false))
  wc.session.setPermissionCheckHandler(() => false)
  await page.cdp('Page.addScriptToEvaluateOnNewDocument', { source: CLIPBOARD_GUARD })
  await page.goto(`/o/${org}`)
  const isolation = {
    sessionId: sessionOf(process.pid), audioMuted: wc.isAudioMuted(),
    clipboard: await page.eval(() => navigator.clipboard.readText().then(() => 'readable', (e) => e.name)),
  }
  page.log('isolation', isolation)

  const card = `[data-copy-agent-name="${args.agent}"]`
  await page.waitFor(card, { timeout: 30000 })
  await page.sleep(800)
  await page.rightClick(card)
  await page.waitFor('.ctxmenu[role="menu"]')
  await page.hover({ selector: 'button.ctxmenu-item', text: '^Open( ▸)?$', regex: true })
  await page.sleep(300)
  const items = await page.eval(() => [...document.querySelectorAll('.ctxmenu[role="menu"] button.ctxmenu-item')].map((b) => (b.innerText || '').trim()))
  const desk = items.find((t) => /desk/i.test(t))
  if (!desk) throw new Error(`no desk item in the card menu: ${JSON.stringify(items)}`)
  await page.click({ selector: 'button.ctxmenu-item', text: `^${desk.replace(/[.*+?^${}()|[\]\\]/g, (c) => '\\' + c)}$`, regex: true })
  await page.waitFor('.msgs', { timeout: 30000 })
  await page.sleep(800)

  // the sampler: one record per state of the transcript's tool chips (a mutation batch or a 25 ms tick that
  // changed it), each chip as { call, writing }. Only changes are kept, with the time of the change.
  await page.eval(() => {
    const t0 = performance.now()
    window.__chips = []
    let last = ''
    const snap = (why) => {
      const root = document.querySelector('.msgs')
      if (!root) return
      const chips = [...root.querySelectorAll('.tchip')].map((c) => {
        const text = (c.querySelector('.tline')?.innerText ?? '').replace(/\s+/g, ' ').trim()
        const m = /call-\d+/.exec(text)
        return { call: m ? m[0] : text.slice(0, 40), writing: !!c.querySelector('.tool-writing-status') }
      })
      const sig = JSON.stringify(chips)
      if (sig === last) return
      last = sig
      window.__chips.push({ t: Math.round(performance.now() - t0), why, chips })
    }
    new MutationObserver(() => snap('mutation')).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true })
    window.__tick = setInterval(() => snap('tick'), 25)
    snap('start')
  })

  await page.api('POST', `/api/orgs/${org}/nodes/${encodeURIComponent(args.agent)}/message`, { text: args.mail, notice: false })
  // the turn's last text is a plain assistant row
  const end = Date.now() + 90000
  for (;;) {
    const seen = await page.eval((done) => [...document.querySelectorAll('.msgs')].some((m) => (m.innerText || '').includes(done)), args.done)
    if (seen) break
    if (Date.now() > end) throw new Error('the scripted turn never reached its last text')
    await page.sleep(250)
  }
  await page.sleep(2500)
  const samples = await page.eval(() => { clearInterval(window.__tick); return window.__chips })
  await page.screenshot('desk-final')

  // analysis, here so the proof and a human read the same numbers
  const both = []
  const seenWriting = new Set(), seenSaved = new Set()
  samples.forEach((s, i) => {
    const next = samples[i + 1]
    const per = new Map()
    for (const c of s.chips) {
      const e = per.get(c.call) ?? { writing: 0, saved: 0 }
      if (c.writing) { e.writing++; seenWriting.add(c.call) } else { e.saved++; seenSaved.add(c.call) }
      per.set(c.call, e)
    }
    const dup = [...per].filter(([, e]) => e.writing && e.saved).map(([call]) => call)
    if (dup.length) both.push({ t: s.t, forMs: next ? next.t - s.t : null, calls: dup, why: s.why })
  })
  return { isolation, samples: samples.length, callsSeenWriting: [...seenWriting].sort(), callsSeenSaved: [...seenSaved].sort(),
    both, bothMaxMs: both.reduce((m, b) => Math.max(m, b.forMs ?? 0), 0), all: samples }
}
