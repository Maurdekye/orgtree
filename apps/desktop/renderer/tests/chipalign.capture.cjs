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
  const look = el => { const s = getComputedStyle(el); return { display: s.display, color: s.color, fontFamily: s.fontFamily, fontSize: s.fontSize, textDecorationLine: s.textDecorationLine, alignItems: s.alignItems } }
  const chipIn = (ctx, sel) => { const row = document.querySelector('[data-ctx="' + ctx + '"]'), e = row && row.querySelector(sel)
    return e ? { text: e.textContent, classes: String(e.className), mark: !!e.querySelector('.ref-mark-mail'), look: look(e) } : null }
  window.__mailFacts = () => ({
    msgMail: chipIn('msg-mail', '.ref-chip.ref-mail'), reactMail: chipIn('react-mail', '.ref-chip.ref-mail'), goneMail: chipIn('msg-mail-gone', '.ref-chip.ref-mail'),
    mixedMail: chipIn('msg-mail-mixed', '.ref-chip.ref-mail'), mixedItem: chipIn('msg-mail-mixed', '.ref-chip.ref-item'), mixedDoc: chipIn('msg-mail-mixed', '.ref-chip.ref-doc'),
    docketMail: chipIn('docket-mail', '.ref-chip.ref-mail'), docketItem: chipIn('docket-mail', '.ref-chip.ref-item'),
    toolMail: chipIn('tool-mail', '.ref-chip.ref-mail'), toolOpenButtons: (document.querySelector('[data-ctx="tool-mail"]') || document.body).querySelectorAll('.maillink').length })
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
    const all = [], mailFacts = {}
    const loadPage = (html, name) => guard.load(html, 'probe.js', name)

    // 1. the chips fixture, in both mention layouts
    await loadPage(pages.chips, 'chips')
    await wait("document.querySelectorAll('[data-ctx]').length >= 25 && window.chipFixture"); await js(INSTALL); await paint()
    for (const mode of ['flex', 'inline']) {
      await js(`window.chipFixture.wrap(${mode === 'inline'})`)
      if (mode === 'inline') await wait("document.documentElement.classList.contains('wrap-object-mentions')")
      else await wait("!document.documentElement.classList.contains('wrap-object-mentions')")
      await paint()
      await js("new Promise(r => { const end = Date.now() + 2500; (function c() { const e = document.querySelector('[data-ctx=\"msg-mail\"] .ref-chip.ref-mail'); if ((e && /^Please/.test(e.textContent)) || Date.now() > end) return r(); setTimeout(c, 50) })() })"); await paint(); await paint()
      const rows = await js("window.__chipMeasureAll('[data-ctx]')")
      mailFacts[mode] = await js('window.__mailFacts()')
      for (const r of rows) all.push({ page: 'chips', mode, ...r })
      for (const r of rows) await crop(`${mode}-${r.ctx}`, `[data-ctx="${r.ctx}"]`)
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
      'ask-fold-item', 'idle-ticket', 'tool-refs', 'answered-qtext', 'tray-sum-agent', 'msg-item-s', 'msg-doc-s', 'msg-app-s', 'react-control', 'msg-mail', 'msg-mail-mixed', 'msg-mail-gone', 'react-mail', 'docket-mail', 'tool-mail']
    const missing = []
    for (const mode of ['flex', 'inline']) for (const name of REQUIRED) if (!all.some(r => r.page === 'chips' && r.mode === mode && r.ctx === name)) missing.push(`chips/${mode}/${name}`)
    for (const name of ['inbox-sent', 'inbox-some']) if (!all.some(r => r.page === 'inbox' && r.ctx === name)) missing.push('inbox/' + name)
    // rows that may have no badge: the sent mail's tool row and the mail links, which have none at the base (the mail checks below decide those), and a link to a mail that is not there
    const NO_BADGE = ['tool-mail', 'msg-mail', 'react-mail', 'msg-mail-gone']
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
      if (f.toolOpenButtons !== 0) mailProblems.push(at(`${f.toolOpenButtons} "open" button(s) remain on the sent mail's tool row`))
    }
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
