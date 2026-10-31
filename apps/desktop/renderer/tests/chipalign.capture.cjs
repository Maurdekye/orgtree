// chipalign.capture.cjs — USER 2026-10-31 08:44:26Z m4b300ae4cbd1 ("agent links are sometimes vertically
// misaligned with the surrounding text in places, can that be cleaned up?"). Measures, in a real renderer, for each
// inline link chip kind in each surface that draws it:
//   spread  — the largest difference between the baselines of the text runs on one visual line (the chip's label
//             against the words around it, and against the other chips beside it). It must be 0.5 px or less.
//   markOff — the badge's (tier letter, folder, kind icon, avatar) vertical centre against the centre of its label's line
//             box (the measure chipicons.capture.cjs holds to 1 px); markOffX is the same against the centre of the label's
//             lowercase letters (the baseline less half the x-height), which must stay within 2 px.
//   grew    — how much taller the row is than at the baseline run (a chip must not change its line's height): 0.5 px a
//             line at most; and a chat row, or a React sentence, with as many lines as its chip-less control is no taller than it
//             by 0.1 px (a chip adds nothing to its line).
// and writes zoomed crops of every row. Surfaces: chipalign.visual.tsx (chat prose, mail body, docket, event head,
// mail row, tray) in both mention layouts, and orginbox-delivered.visual.tsx (the org inbox's Sent line "@agent as
// @org -> @recipient" and the received mail's delivered-to line: the user's first screenshot).
//
//   electron.exe chipalign.capture.cjs <outDir> <repoRoot> <node_modules dir> <label> [baseline results.json]
//   CHIPALIGN_CSS=<file.css>  appends that stylesheet to every page (to try a rule before editing styles.css)
//
// Session 0, hidden off-screen window, muted, clipboard stubbed and denied, only file: data: blob: requests, no OS
// input. Writes only under <outDir>/<label>/. The isolation guard is chipcapture-guard.cjs (shared with chipicons.capture.cjs):
// each page is loaded INERT (stylesheets and an empty root, no script), and before the fixture script is injected every
// process (main and each Chromium child) is measured in Windows Session 0, the mute switch and every webContents' mute are
// checked, the permission handlers and the main clipboard stubs are checked, the page's main-world clipboard guard (a
// preload that runs before any page script) is checked structurally and then probed; after the run it measures again.
// Missing measurements (a required row, a row with no text run or no badge, a non-finite number) fail the run.
const { app } = require('electron')
const { createGuard } = require('./chipcapture-guard.cjs')
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const [outArg, repoArg, depsArg, label = 'run', baselineArg] = process.argv.slice(2)
const out = path.resolve(outArg, label), repo = path.resolve(repoArg), deps = path.resolve(depsArg)
const extraCss = process.env.CHIPALIGN_CSS ? fs.readFileSync(path.resolve(process.env.CHIPALIGN_CSS), 'utf8') : ''
const sid = pid => Number(execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Process -Id ${Number(pid)}).SessionId`], { encoding: 'utf8', windowsHide: true }).trim())
assert.equal(sid(process.pid), 0, 'Session 0 required before creating a window')
fs.mkdirSync(out, { recursive: true })
app.setPath('userData', path.join(out, 'profile-' + process.pid)); app.setPath('sessionData', path.join(out, 'session-' + process.pid))
app.disableHardwareAcceleration(); app.commandLine.appendSwitch('mute-audio')
const within = async (p, ms, what) => { let t; try { return await Promise.race([p, new Promise((_r, j) => { t = setTimeout(() => j(Error('Deadline: ' + what)), ms) })]) } finally { clearTimeout(t) } }

const PAGES = [
  { name: 'chips', entry: 'chipalign.visual.tsx' },
  { name: 'inbox', entry: 'orginbox-delivered.visual.tsx' },
]
async function bundle(page) {
  const esbuild = require(path.join(deps, 'esbuild'))
  const dir = path.join(out, page.name)
  fs.mkdirSync(dir, { recursive: true })
  try {
    await esbuild.build({
      entryPoints: [path.join(repo, 'apps/desktop/renderer/tests', page.entry)],
      outfile: path.join(dir, 'probe.js'), bundle: true, format: 'iife', platform: 'browser', jsx: 'automatic', logLevel: 'warning',
      nodePaths: [deps], loader: { '.png': 'dataurl', '.svg': 'dataurl', '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl' },
      define: { 'process.env.NODE_ENV': '"production"', __SRC_DIR__: '""' },
    })
  } finally { await esbuild.stop() }
  fs.writeFileSync(path.join(dir, 'extra.css'), extraCss)
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><html lang="en"><meta charset="utf-8"><link rel="stylesheet" href="probe.css"><link rel="stylesheet" href="extra.css"><body style="margin:0"><div id="root"></div></body></html>')
  return path.join(dir, 'index.html')
}

// Installed once per page. measure(rootSelectors) -> one record per root.
const INSTALL = `(() => {
  const SKIP = '.tier,.project-mark,.ref-mark,.net-mark,.letter-chip,svg'
  const MARK = '.tier,.project-mark,.ref-mark,.net-mark'
  const CHIP = '.ref-chip,.node-link,.sender,.docket-ref,.docket-mention,.net-chip,[data-hub-address],.cc-name,.queuekind'
  const ascents = new Map(), canvas = document.createElement('canvas').getContext('2d')
  const fontKey = cs => [cs.fontStyle, cs.fontWeight, cs.fontSize, cs.fontFamily, cs.letterSpacing].join('|')
  // the distance from a text run's content-area top to its baseline, in its own font (an inline-block with no height
  // sits on the baseline of the line it is in)
  const ascentOf = el => {
    const cs = getComputedStyle(el), key = fontKey(cs)
    if (!ascents.has(key)) {
      const s = document.createElement('span')
      s.style.cssText = 'position:absolute;left:0;top:0;visibility:hidden;white-space:nowrap;line-height:normal;font-style:' + cs.fontStyle + ';font-weight:' + cs.fontWeight + ';font-size:' + cs.fontSize + ';font-family:' + cs.fontFamily + ';letter-spacing:' + cs.letterSpacing
      s.appendChild(document.createTextNode('x'))
      const i = document.createElement('i'); i.style.cssText = 'display:inline-block;width:0;height:0'; s.appendChild(i)
      document.body.appendChild(s)
      const r = document.createRange(); r.selectNodeContents(s.firstChild)
      const xh = (canvas.font = cs.fontStyle + ' ' + cs.fontWeight + ' ' + cs.fontSize + ' ' + cs.fontFamily, canvas.measureText('x').actualBoundingBoxAscent)
      ascents.set(key, { asc: i.getBoundingClientRect().bottom - r.getBoundingClientRect().top, xh })
      s.remove()
    }
    return ascents.get(key)
  }
  const runsOf = root => {
    const runs = []
    const walk = n => {
      if (n.nodeType === 3) {
        if (!n.textContent.trim()) return
        const el = n.parentElement
        if (!el || el.closest(SKIP)) return
        const r = document.createRange(); r.selectNodeContents(n)
        const { asc, xh } = ascentOf(el)
        for (const rect of r.getClientRects()) if (rect.width > 0.5 && rect.height > 0.5)
          runs.push({ text: n.textContent.trim().slice(0, 14), top: rect.top, bottom: rect.bottom, left: rect.left, base: rect.top + asc, xh, node: n })
        return
      }
      if (n.nodeType === 1 && !/^(SCRIPT|STYLE)$/.test(n.tagName)) for (const c of n.childNodes) walk(c)
    }
    walk(root)
    return runs
  }
  const linesOf = runs => {
    const lines = []
    for (const r of [...runs].sort((a, b) => a.top - b.top)) {
      const line = lines.find(l => Math.min(l.bottom, r.bottom) - Math.max(l.top, r.top) > 0.5 * Math.min(l.bottom - l.top, r.bottom - r.top))
      if (line) { line.runs.push(r); line.top = Math.min(line.top, r.top); line.bottom = Math.max(line.bottom, r.bottom) }
      else lines.push({ top: r.top, bottom: r.bottom, runs: [r] })
    }
    return lines
  }
  const r2 = n => Math.round(n * 100) / 100
  window.__chipMeasure = (el) => {
    const runs = runsOf(el), lines = linesOf(runs)
    const lineRecs = lines.map(l => {
      const bases = l.runs.map(r => r.base)
      return { spread: r2(Math.max(...bases) - Math.min(...bases)), runs: l.runs.map(r => r.text + '@' + r2(r.base - l.top)) }
    })
    const marks = []
    for (const m of el.querySelectorAll(MARK)) {
      if (m.parentElement && m.parentElement.closest(MARK)) continue
      const chip = m.closest(CHIP) || m.parentElement
      const mine = runs.filter(r => chip.contains(r.node) && (m.compareDocumentPosition(r.node) & Node.DOCUMENT_POSITION_FOLLOWING))
      const label = mine[0]
      const b = m.getBoundingClientRect()
      if (!label) { marks.push({ cls: String(m.getAttribute('class') || m.tagName), error: 'no label run' }); continue }
      const centre = (b.top + b.bottom) / 2
      marks.push({ cls: String(m.getAttribute('class') || m.tagName).replace(/\\s+/g, '.').slice(0, 40), height: r2(b.height),
        offLine: r2(centre - (label.top + label.bottom) / 2), offX: r2(centre - (label.base - label.xh / 2)) })
    }
    const worst = lineRecs.reduce((a, l) => Math.max(a, l.spread), 0)
    return { height: r2(el.getBoundingClientRect().height), lines: lineRecs, spread: r2(worst), marks,
      markOff: r2(marks.reduce((a, m) => Math.max(a, Math.abs(m.offLine ?? 0)), 0)), markOffX: r2(marks.reduce((a, m) => Math.max(a, Math.abs(m.offX ?? 0)), 0)), lineCount: lineRecs.length }
  }
  // the @mail: link beside the other object links (USER 2026-10-31 mdffa16729677, m33189c8d6214, m4ad918885ce9): what each looks like
  const look = el => { const s = getComputedStyle(el); return { display: s.display, color: s.color, fontFamily: s.fontFamily, fontSize: s.fontSize, textDecorationLine: s.textDecorationLine, alignItems: s.alignItems, boxShadow: s.boxShadow, paddingLeft: s.paddingLeft } }
  const chipIn = (ctx, sel) => { const row = document.querySelector('[data-ctx="' + ctx + '"]'), e = row && row.querySelector(sel)
    return e ? { text: e.textContent, classes: String(e.className), mark: !!e.querySelector('.ref-mark-mail'), look: look(e) } : null }
  window.__mailFacts = () => ({
    msgMail: chipIn('msg-mail', '.ref-chip.ref-mail'), reactMail: chipIn('react-mail', '.ref-chip.ref-mail'), goneMail: chipIn('msg-mail-gone', '.ref-chip.ref-mail'),
    mixedMail: chipIn('msg-mail-mixed', '.ref-chip.ref-mail'), mixedItem: chipIn('msg-mail-mixed', '.ref-chip.ref-item'), mixedDoc: chipIn('msg-mail-mixed', '.ref-chip.ref-doc'),
    docketMail: chipIn('docket-mail', '.ref-chip.ref-mail'), docketItem: chipIn('docket-mail', '.ref-chip.ref-item'),
    unreadMsg: chipIn('msg-mail-unread', '.ref-chip.ref-mail'), unreadReact: chipIn('react-mail-unread', '.ref-chip.ref-mail'), unreadTool: chipIn('tool-mail-unread', '.ref-chip.ref-mail'),
    unreadMixedMail: chipIn('msg-mail-unread-mixed', '.ref-chip.ref-mail'), unreadMixedDoc: chipIn('msg-mail-unread-mixed', '.ref-chip.ref-doc'),
    toolMail: chipIn('tool-mail', '.ref-chip.ref-mail'), toolOpenButtons: (document.querySelector('[data-ctx="tool-mail"]') || document.body).querySelectorAll('.maillink').length })
  // the run state of an app or panel link (USER 2026-10-31 m8d5facfeae29, m9a790bb7a155, m16901ed8c657, m29a112a68005, m4c09dab3ee56): its flare classes, its left edge, any fill or dot
  const dot = e => { const b = getComputedStyle(e, '::before'); return { content: b.content, width: b.width, height: b.height, radius: b.borderTopLeftRadius, background: b.backgroundColor } }
  const runChip = ctx => { const row = document.querySelector('[data-ctx="' + ctx + '"]'), e = row && row.querySelector('.ref-chip.ref-app, .ref-chip.ref-panel')
    return e ? { text: e.textContent, classes: String(e.className), title: e.title, boxShadow: getComputedStyle(e).boxShadow, background: getComputedStyle(e).backgroundColor, dot: dot(e) } : null }
  window.__runFacts = () => ({ appRun: runChip('msg-app-run'), appDead: runChip('msg-app-dead'), appNone: runChip('msg-app-none'), panelRun: runChip('msg-panel-run'), panelDead: runChip('msg-panel-dead') })
  window.__chipMeasureAll = (sel) => [...document.querySelectorAll(sel)].map(el => ({ ctx: el.dataset.ctx || el.className.split(' ')[0], ...window.__chipMeasure(el) }))
})()`

app.whenReady().then(async () => {
  const errors = []
  try {
    const pages = {}
    for (const p of PAGES) pages[p.name] = await bundle(p)
    // the guarded window: main clipboard stubbed, preload guard, permission handlers, mute, native commands refused
    const guard = createGuard({ electron: require('electron'), out, partition: 'chip-align' })
    const { wc, js } = guard
    wc.on('console-message', (_e, level, message) => { if (level >= 2) errors.push(message) })
    const wait = s => js(`new Promise((resolve, reject) => { const end = Date.now() + 8000; (function check() { if (${s}) return resolve(); if (Date.now() > end) return reject(Error('Wait: ' + ${JSON.stringify(s)})); setTimeout(check, 25) })() })`)
    const paint = () => js('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 150))))')
    fs.mkdirSync(path.join(out, 'png'), { recursive: true })
    const crop = async (name, selector, index = 0, pad = 6, grow = 4) => {
      const r = await js(`(() => { const el = document.querySelectorAll(${JSON.stringify(selector)})[${index}]; if (!el) return null; el.scrollIntoView({ block: 'center' }); const b = el.getBoundingClientRect(); return { x: 0, y: Math.max(0, Math.floor(b.top - ${pad})), w: Math.min(innerWidth, Math.ceil(b.right + 40)), h: Math.ceil(b.height + 2 * ${pad}) } })()`)
      if (!r) return
      await paint()
      const img = (await wc.capturePage()).crop({ x: r.x, y: r.y, width: r.w, height: Math.min(r.h, 1500 - r.y) })
      fs.writeFileSync(path.join(out, 'png', name + '.png'), img.resize({ width: r.w * grow, quality: 'best' }).toPNG())
    }
    const all = [], mailFacts = {}, runFacts = {}
    const loadPage = (html, name) => guard.load(html, 'probe.js', name)

    // 1. the chips fixture, in both mention layouts
    await loadPage(pages.chips, 'chips')
    await wait("document.querySelectorAll('[data-ctx]').length >= 25 && window.chipFixture"); await js(INSTALL); await paint()
    for (const mode of ['flex', 'inline']) {
      await js(`window.chipFixture.wrap(${mode === 'inline'})`)
      if (mode === 'inline') await wait("document.documentElement.classList.contains('wrap-object-mentions')")
      else await wait("!document.documentElement.classList.contains('wrap-object-mentions')")
      await paint()
      await js("new Promise(r => { const end = Date.now() + 2500; (function c() { const done = ['msg-mail', 'msg-mail-unread', 'react-mail-unread', 'tool-mail-unread'].every(x => { const e = document.querySelector('[data-ctx=\"' + x + '\"] .ref-chip.ref-mail'); return e && /^Please/.test(e.textContent) }); if (done || Date.now() > end) return r(); setTimeout(c, 50) })() })"); await paint(); await paint()
      const rows = await js("window.__chipMeasureAll('[data-ctx]')")
      mailFacts[mode] = await js('window.__mailFacts()')
      for (const r of rows) all.push({ page: 'chips', mode, ...r })
      for (const r of rows) await crop(`${mode}-${r.ctx}`, `[data-ctx="${r.ctx}"]`)
      // the running app's last panel stops: its link goes from running to dark grey
      runFacts[mode] = { before: await js('window.__runFacts()') }
      await js('window.chipFixture.run(false)'); await paint()
      runFacts[mode].after = await js('window.__runFacts()')
      await crop(`${mode}-msg-app-run-after`, '[data-ctx="msg-app-run"]')
      await js('window.chipFixture.run(true)'); await paint()
    }

    // 2. the org inbox: the Sent line and the received mail's delivered-to line
    await loadPage(pages.inbox, 'inbox')
    await wait('window.deliveredFixture'); await js(INSTALL)
    for (const surface of ['sent', 'some']) {
      await js(`window.deliveredFixture.show('${surface}', 'dark')`)
      await wait("document.querySelector('.mailer-head') && document.querySelector('.mailer-body')"); await paint()
      const rec = await js("(() => { const h = document.querySelector('.mailer-head'); h.dataset.ctx = 'inbox-" + surface + "'; return window.__chipMeasure(h) })()")
      all.push({ page: 'inbox', mode: 'flex', ctx: 'inbox-' + surface, ...rec })
      await crop(`inbox-${surface}`, '.mailer-head', 0, 8)
    }

    // FAIL CLOSED: every row the criteria rest on was measured, in both layouts, with text and a badge
    const REQUIRED = ['control', 'msg-agent', 'msg-project', 'msg-item', 'msg-doc', 'msg-app', 'msg-panel', 'msg-net-person', 'msg-net-org', 'msg-user-agent',
      'msg-mixed', 'mail-body-agent', 'react-item', 'react-doc', 'react-app', 'react-panel', 'react-agent', 'react-project', 'react-net-person', 'react-net-org',
      'react-net-chat', 'react-net-unknown', 'docket-agent', 'docket-item', 'event-head', 'event-actor-name', 'docket-actor', 'mailrow-from', 'mailrow-hub',
      'ask-fold-item', 'idle-ticket', 'tool-refs', 'answered-qtext', 'tray-sum-agent', 'msg-item-s', 'msg-doc-s', 'msg-app-s', 'react-control', 'msg-mail', 'msg-mail-mixed', 'msg-mail-gone', 'react-mail', 'docket-mail', 'tool-mail',
      'msg-mail-unread', 'msg-mail-unread-mixed', 'react-mail-unread', 'tool-mail-unread',
      'msg-app-run', 'msg-app-dead', 'msg-app-none', 'msg-panel-run', 'msg-panel-dead']
    const missing = []
    for (const mode of ['flex', 'inline']) for (const name of REQUIRED) if (!all.some(r => r.page === 'chips' && r.mode === mode && r.ctx === name)) missing.push(`chips/${mode}/${name}`)
    for (const name of ['inbox-sent', 'inbox-some']) if (!all.some(r => r.page === 'inbox' && r.ctx === name)) missing.push('inbox/' + name)
    // rows that may have no badge: the sent mail's tool row and the mail links, which have none at the base (the mail checks below decide those), and a link to a mail that is not there
    const NO_BADGE = ['tool-mail', 'msg-mail', 'react-mail', 'msg-mail-gone', 'msg-mail-unread', 'react-mail-unread', 'tool-mail-unread']
    const unmeasured = all.filter(r => r.ctx !== 'control' && r.ctx !== 'react-control' && (!r.lines || !r.lines.length || !r.marks || (!r.marks.length && !NO_BADGE.includes(r.ctx))
      || ![r.height, r.spread, r.markOff, r.markOffX].every(Number.isFinite))).map(r => `${r.page}/${r.mode}/${r.ctx}`)
    assert.deepEqual(missing, [], 'required rows were not measured')
    assert.deepEqual(unmeasured, [], 'rows with no text run, no badge or a non-finite number')

    const key = r => `${r.page}/${r.mode}/${r.ctx}`
    const base = baselineArg ? new Map(JSON.parse(fs.readFileSync(path.resolve(baselineArg), 'utf8')).rows.map(r => [key(r), r.height])) : null
    for (const r of all) { const was = base && base.get(key(r)); r.grew = was === undefined || was === null ? 0 : +(r.height - was).toFixed(2) }
    const ctl = Object.fromEntries(all.filter(r => r.ctx === 'control').map(r => [r.mode, r.height]))
    const rctl = Object.fromEntries(all.filter(r => r.ctx === 'react-control').map(r => [r.mode, r.height]))
    const ctlLines = Object.fromEntries(all.filter(r => r.ctx === 'control').map(r => [r.mode, r.lineCount]))
    for (const r of all) if (r.ctx.startsWith('react-') && r.ctx !== 'react-control' && rctl[r.mode] !== undefined) r.vsControl = +(r.height - rctl[r.mode]).toFixed(2)
    // (a user message sits in a padded bubble the control is not in: it is measured against the baseline run only)
    for (const r of all) if (r.ctx.startsWith('msg-') && r.ctx !== 'msg-user-agent' && ctl[r.mode] !== undefined && r.lineCount === ctlLines[r.mode]) r.vsControl = +(r.height - ctl[r.mode]).toFixed(2)
    // THE MAIL LINK (red at the base, where an @mail: reference is an unstyled link, named "mail in ...", and a sent mail's tool row ends in an "open" button)
    const LABEL = 'Please review the at\u2026', SAME = ['display', 'color', 'fontFamily', 'fontSize', 'textDecorationLine', 'alignItems']
    const mailProblems = []
    for (const mode of ['flex', 'inline']) {
      const f = mailFacts[mode], at = what => `${mode}: ${what}`
      for (const k of ['msgMail', 'reactMail', 'mixedMail', 'docketMail', 'toolMail']) {
        if (!f[k]) { mailProblems.push(at(k + ' is not a mail link')); continue }
        if (f[k].text !== LABEL) mailProblems.push(at(`${k} reads "${f[k].text}", not the message's first 20 characters "${LABEL}"`))
        if (!f[k].mark) mailProblems.push(at(k + ' has no mail icon'))
        if (!/ref-message/.test(f[k].classes) || !/ref-ready/.test(f[k].classes)) mailProblems.push(at(k + ' is not a ready message link: ' + f[k].classes))
      }
      for (const [mail, item] of [['mixedMail', 'mixedItem'], ['mixedMail', 'mixedDoc'], ['docketMail', 'docketItem']]) {
        if (!f[mail] || !f[item]) continue
        const diff = SAME.filter(p => f[mail].look[p] !== f[item].look[p])
        if (diff.length) mailProblems.push(at(`${mail} is not styled like ${item}: ` + diff.map(p => `${p} ${f[mail].look[p]} vs ${f[item].look[p]}`).join(', ')))
      }
      if (!f.goneMail || !/ref-absent/.test(f.goneMail.classes) || !/@mail:chips\/user\/gone-1/.test(f.goneMail.text) || /Please/.test(f.goneMail.text)) mailProblems.push(at('a message that is not there must read as an unavailable reference and show nothing of any mail: ' + JSON.stringify(f.goneMail)))
      // THE UNREAD FLARE (USER 2026-10-31 m5345a1e44ad1 "mail has an unread highlight like presentations do"): a message the user has not read wears the flare an unread presentation link wears, in every place a message link is drawn; a read one wears none
      for (const k of ['unreadMsg', 'unreadReact', 'unreadTool', 'unreadMixedMail']) {
        if (!f[k]) { mailProblems.push(at(k + ' is not a mail link')); continue }
        if (!/ref-flare/.test(f[k].classes) || !/mail-new/.test(f[k].classes)) mailProblems.push(at(`${k} is an unread message but wears no unread flare: ${f[k].classes}`))
        if (!f[k].look.boxShadow || f[k].look.boxShadow === 'none') mailProblems.push(at(`${k} draws no flare edge (box-shadow ${f[k].look.boxShadow})`))
      }
      if (f.unreadMixedMail && f.unreadMixedDoc) {
        if (!/doc-new/.test(f.unreadMixedDoc.classes)) mailProblems.push(at('the fixture\'s unread presentation link lost its flare: ' + f.unreadMixedDoc.classes))
        const diff = ['boxShadow', 'paddingLeft'].filter(p => f.unreadMixedMail.look[p] !== f.unreadMixedDoc.look[p])
        if (diff.length) mailProblems.push(at('an unread message link is not flared like an unread presentation link: ' + diff.map(p => `${p} ${f.unreadMixedMail.look[p]} vs ${f.unreadMixedDoc.look[p]}`).join(', ')))
      }
      if (f.msgMail && (/ref-flare/.test(f.msgMail.classes) || f.msgMail.look.boxShadow !== 'none')) mailProblems.push(at('a message the user has read must wear no flare: ' + f.msgMail.classes + ' ' + f.msgMail.look.boxShadow))
      if (f.toolOpenButtons !== 0) mailProblems.push(at(`${f.toolOpenButtons} "open" button(s) remain on the sent mail's tool row`))
    }
    // THE RUN STATE (USER 2026-10-31 m4c09dab3ee56 "Left edge like unread" + "Provider colour"): a running app or panel link wears the unread highlight's own left edge in the accent, an app or panel that is off the same edge in a dark grey, an app with no panels none; no fill, no dot
    const runProblems = []
    // computed colours arrive as rgb()/rgba() or as CSS Color 4 `color(srgb r g b / a)` (channels 0 to 1, as color-mix() computes); a box-shadow carries its colour anywhere in the string
    const parse = s => { const m = /rgba?\((\d+), (\d+), (\d+)(?:, ([\d.]+))?/.exec(s || ''), n = /color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)(?: \/ ([\d.]+%?))?/.exec(s || '')
      const a = v => v === undefined ? 1 : String(v).endsWith('%') ? parseFloat(v) / 100 : +v
      return m ? { c: [+m[1], +m[2], +m[3]], a: a(m[4]) } : n ? { c: [+n[1] * 255, +n[2] * 255, +n[3] * 255], a: a(n[4]) } : null }
    const grey = s => { const p = parse(s); return !!p && Math.max(...p.c) - Math.min(...p.c) <= 14 }
    const warm = s => { const p = parse(s); return !!p && p.c[0] - p.c[2] >= 40 }
    const filled = s => { const p = parse(s); return !!p && p.a >= 0.02 }
    for (const mode of ['flex', 'inline']) {
      const f = runFacts[mode], at = what => `${mode}: ${what}`
      const edge = (name, chip, cls) => {
        if (!chip) { runProblems.push(at(name + ' is not an app or panel link')); return }
        if (!/ref-flare/.test(chip.classes) || !new RegExp(cls).test(chip.classes)) runProblems.push(at(`${name} wears no ${cls} state: ${chip.classes}`))
        if (!/3px/.test(chip.boxShadow) || !/inset/.test(chip.boxShadow)) runProblems.push(at(`${name} has no unread-style left edge (3px inset): ${chip.boxShadow}`))
        else if (cls === 'run-on' ? !warm(chip.boxShadow) : !grey(chip.boxShadow)) runProblems.push(at(`${name} edge is not ${cls === 'run-on' ? 'the accent' : 'grey'}: ${chip.boxShadow}`))
        if (filled(chip.background)) runProblems.push(at(`${name} has a fill: ${chip.background}`))
        if (chip.dot.content !== 'none' && chip.dot.content !== 'normal') runProblems.push(at(`${name} still draws a dot: ${JSON.stringify(chip.dot)}`))
      }
      edge('running app (before)', f.before.appRun, 'run-on'); edge('running panel', f.before.panelRun, 'run-on')
      edge('dead app', f.before.appDead, 'run-dead'); edge('dead panel', f.before.panelDead, 'run-dead'); edge('app after its last panel stopped', f.after.appRun, 'run-dead')
      if (f.before.appRun && f.after.appRun && f.before.appRun.boxShadow === f.after.appRun.boxShadow) runProblems.push(at('stopping the last panel did not change the app link\'s edge'))
      if (f.before.appDead && f.after.appRun && f.before.appDead.boxShadow !== f.after.appRun.boxShadow) runProblems.push(at('a dead app and an app whose last panel stopped differ'))
      if (f.before.appRun && f.before.panelRun && f.before.appRun.boxShadow !== f.before.panelRun.boxShadow) runProblems.push(at('a running app and a running panel differ'))
      const none = f.before.appNone
      if (!none || /ref-flare|run-/.test(none.classes) || none.boxShadow !== 'none' || filled(none.background) || (none.dot.content !== 'none' && none.dot.content !== 'normal')) runProblems.push(at('an app with no panels must wear nothing: ' + JSON.stringify(none)))
    }
    for (const problem of runProblems) mailProblems.push('run state: ' + problem)
    const failing = r => r.spread > 0.5 || r.markOff > 1 || r.markOffX > 2 || r.grew > 0.5 * Math.max(1, r.lineCount) || r.vsControl > 0.1 || r.marks.some(m => m.error)
    const isControl = r => r.ctx === 'control' || r.ctx === 'react-control'
    const bad = all.filter(r => !isControl(r) && failing(r))
    for (const problem of mailProblems) bad.push({ ctx: 'mail: ' + problem })
    const receipt = await guard.finish()
    assert.equal(receipt.pages.length, 2, 'both pages must have been attested before their scripts')
    const result = { label, status: bad.length ? 'FAIL' : 'PASS', measured: all.length, failing: bad.length, sessionId: sid(process.pid),
      rendererSessionId: sid(wc.getOSProcessId()), muted: wc.isAudioMuted(), clipboardCalls: guard.clipboardCalls(), guard: receipt, mailFacts, mailProblems, extraCss: Boolean(extraCss), errors, rows: all }
    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(result, null, 2))
    const line = r => `${(r.page + '/' + r.mode).padEnd(12)} ${r.ctx.padEnd(18)} spread ${String(r.spread).padStart(5)}  markOff ${String(r.markOff).padStart(5)}/${String(r.markOffX).padStart(4)}  h ${String(r.height).padStart(5)} (grew ${r.grew >= 0 ? '+' : ''}${r.grew}${r.vsControl !== undefined ? ', vs control ' + r.vsControl : ''})${!isControl(r) && failing(r) ? '  <-- FAIL' : ''}`
    console.log(all.map(line).join('\n'))
    for (const problem of mailProblems) console.log('MAIL  ' + problem)
    console.log(`${result.status}: ${all.length} measured, ${bad.length} failing (a line whose text runs differ in baseline by more than 0.5 px, a badge more than 1 px off its label's line centre or 2 px off its lowercase centre, or a row taller than at the baseline by more than 0.5 px a line, or than the same message without the chip by more than 0.1 px)`)
    assert.equal(result.clipboardCalls, 0)
    assert.equal(result.rendererSessionId, 0)
    assert.equal(result.muted, true)
    app.exit(bad.length ? 1 : 0)
  } catch (e) { console.error(e); try { fs.writeFileSync(path.join(out, 'failure.json'), JSON.stringify({ error: String(e), errors }, null, 2)) } catch {} app.exit(2) }
}).catch(e => { console.error(e); app.exit(2) })
