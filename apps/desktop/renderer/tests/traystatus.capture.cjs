// traystatus.capture.cjs — USER 2026-10-28 10:59:43Z m06a44d7adc0c ("this is a problem, the status text shouldnt run
// into multiple rows"). Measures, in a real renderer, the agents list's status line (the tray row's second line)
// with long ticket / presentation / app / panel / agent chips in it, in both layouts (inline-flex buttons, and the
// "wrap object mentions" inline fragments) and at the tray's narrowest and widest (200 and 280 px). Every row must be as tall as a row whose status
// has no chip, every chip must be one line box (a wrapped inline chip has several client rects), a long line must
// be clipped (so the ellipsis is doing the work) and the age beside it must stay visible. Writes a crop per layout.
//
//   electron.exe traystatus.capture.cjs <outDir> <repoRoot> <node_modules dir> <label>
//
// Session 0, hidden off-screen window, muted, clipboard stubbed and denied, only file: data: blob: requests, no
// OS input. Writes only under <outDir>/<label>/.
const { app, BrowserWindow, session, clipboard } = require('electron')
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const [outArg, repoArg, depsArg, label = 'run'] = process.argv.slice(2)
const out = path.resolve(outArg, label), repo = path.resolve(repoArg), deps = path.resolve(depsArg)
const sid = pid => Number(execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Process -Id ${Number(pid)}).SessionId`], { encoding: 'utf8', windowsHide: true }).trim())
assert.equal(sid(process.pid), 0, 'Session 0 required before creating a window')
fs.mkdirSync(out, { recursive: true })
for (const stale of ['failure.json', 'results.json']) fs.rmSync(path.join(out, stale), { force: true })
app.setPath('userData', path.join(out, 'profile-' + process.pid)); app.setPath('sessionData', path.join(out, 'session-' + process.pid))
app.disableHardwareAcceleration(); app.commandLine.appendSwitch('mute-audio')
let clipboardCalls = 0
for (const k of Object.keys(clipboard)) if (typeof clipboard[k] === 'function') clipboard[k] = () => { clipboardCalls++; return k === 'availableFormats' ? [] : k === 'has' ? false : '' }
const within = async (p, ms, what) => { let t; try { return await Promise.race([p, new Promise((_r, j) => { t = setTimeout(() => j(Error('Deadline: ' + what)), ms) })]) } finally { clearTimeout(t) } }

async function bundle() {
  const esbuild = require(path.join(deps, 'esbuild'))
  try {
    await esbuild.build({
      entryPoints: [path.join(repo, 'apps/desktop/renderer/tests/traystatus.visual.tsx')],
      outfile: path.join(out, 'probe.js'), bundle: true, format: 'iife', platform: 'browser', jsx: 'automatic', logLevel: 'warning',
      nodePaths: [deps], loader: { '.png': 'dataurl', '.svg': 'dataurl', '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl' },
      define: { 'process.env.NODE_ENV': '"production"', __SRC_DIR__: '""' },
    })
  } finally { await esbuild.stop() }
  fs.writeFileSync(path.join(out, 'index.html'), '<!doctype html><html lang="en"><meta charset="utf-8"><link rel="stylesheet" href="probe.css"><body style="margin:0"><div id="root"></div><script src="probe.js"></script></html>')
}

// the chips each row must hold (a row whose chips did not render would pass every other test for the wrong reason)
const CHIPS = { 'item-long': 1, 'item-short': 1, 'two-items': 2, doc: 1, app: 1, panel: 1, agent: 1, none: 0 }
// at the narrow width (200 px) every row but the short and the empty one is longer than the line
const CLIPPED_AT_200 = ['item-long', 'two-items', 'doc', 'app', 'panel', 'agent']
const ONE_LINE_SLACK = 2

const MEASURE = `(() => {
  const out = []
  for (const sec of document.querySelectorAll('.tray-section')) {
    const rowOf = id => sec.querySelector('.tray-row[data-copy-agent-name="' + id + '"]')
    const ctl = rowOf('control'), ctlH = ctl.getBoundingClientRect().height, ctlSum = ctl.querySelector('.tray-sum').getBoundingClientRect().height
    for (const row of sec.querySelectorAll('.tray-row[data-copy-agent-name]')) {
      const id = row.dataset.copyAgentName
      if (id === 'control') continue
      const sum = row.querySelector('.tray-sum'), text = row.querySelector('.tray-sum-text'), age = row.querySelector('.tray-sum-at')
      const chips = [...row.querySelectorAll('.tray-sum .ref-chip')]
      const box = sum.getBoundingClientRect()
      out.push({ width: Number(sec.dataset.width), row: id, rowHeight: row.getBoundingClientRect().height, controlHeight: ctlH,
        rowDelta: +(row.getBoundingClientRect().height - ctlH).toFixed(2), sumHeight: box.height, controlSumHeight: ctlSum,
        chips: chips.length, chipRects: chips.map(c => c.getClientRects().length), chipDisplay: chips.map(c => getComputedStyle(c).display),
        chipWhiteSpace: chips.map(c => getComputedStyle(c).whiteSpace), textOverflow: text ? getComputedStyle(text).textOverflow : null,
        clipped: text ? text.scrollWidth > text.clientWidth + 1 : null,
        ageVisible: age ? age.getBoundingClientRect().width > 0 && age.getBoundingClientRect().right <= box.right + 0.5 : null })
    }
  }
  return out
})()`

app.whenReady().then(async () => {
  const errors = []
  try {
    await bundle()
    const ses = session.fromPartition('tray-status-' + process.pid)
    ses.setPermissionCheckHandler(() => false); ses.setPermissionRequestHandler((_w, _p, done) => done(false))
    ses.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:|about:)/.test(d.url) }))
    const win = new BrowserWindow({ width: 1024, height: 768, show: false, frame: false,
      webPreferences: { session: ses, offscreen: true, backgroundThrottling: false, nodeIntegration: false, sandbox: true, contextIsolation: true } })
    const wc = win.webContents
    wc.setAudioMuted(true); wc.setWindowOpenHandler(() => ({ action: 'deny' }))
    for (const k of ['copy', 'cut', 'paste', 'pasteAndMatchStyle']) wc[k] = () => { throw Error('Clipboard denied') }
    wc.on('console-message', (_e, level, message) => { if (level >= 2) errors.push(message) })
    const js = s => wc.executeJavaScript(s)
    const wait = s => js(`new Promise((resolve, reject) => { const end = Date.now() + 8000; (function check() { if (${s}) return resolve(); if (Date.now() > end) return reject(Error('Wait: ' + ${JSON.stringify(s)})); setTimeout(check, 50) })() })`)
    const paint = () => js('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 120))))')
    await within(win.loadFile(path.join(out, 'index.html')), 15000, 'load')
    await wait("document.querySelectorAll('.tray-row[data-copy-agent-name]').length >= 18"); await paint()

    const all = []
    for (const mode of ['flex', 'inline']) {
      await js(`window.trayFixture.wrap(${mode === 'inline'})`)
      if (mode === 'inline') await wait("document.documentElement.classList.contains('wrap-object-mentions') && getComputedStyle(document.querySelector('.tray-sum .ref-item')).display === 'inline'")
      else await wait("!document.documentElement.classList.contains('wrap-object-mentions') && getComputedStyle(document.querySelector('.tray-sum .ref-item')).display !== 'inline'")
      await paint()
      for (const r of await js(MEASURE)) all.push({ mode, ...r })
      // the whole stage (both widths) at 1.4x; the window is the display's size (1024 x 768 in Session 0)
      await js("document.getElementById('stage').style.zoom = '1.4'"); await paint()
      fs.mkdirSync(path.join(out, 'png'), { recursive: true })
      const c = await js(`(() => { const r = document.getElementById('stage').getBoundingClientRect(); return { x: 0, y: Math.max(0, Math.floor(r.top)), w: Math.min(innerWidth, Math.ceil(r.right + 8)), h: Math.min(innerHeight - Math.max(0, Math.floor(r.top)), Math.ceil(r.height + 8)) } })()`)
      fs.writeFileSync(path.join(out, 'png', `${mode}-stage.png`), (await wc.capturePage()).crop({ x: c.x, y: c.y, width: c.w, height: c.h }).toPNG())
      await js("document.getElementById('stage').style.zoom = '1'"); await paint()
    }

    const problems = r => {
      const p = []
      if (r.chips !== CHIPS[r.row]) p.push(`${r.chips} chips rendered, ${CHIPS[r.row]} expected`)
      // "one line": a chip's own border makes its line 1 to 1.3 px taller in either layout (measured at the base and
      // left alone: it is not the reported problem); a chip that wraps adds a whole line, 15 px or more
      if (Math.abs(r.rowDelta) > ONE_LINE_SLACK) p.push(`row is ${r.rowDelta} px taller than a row without a chip`)
      if (Math.abs(r.sumHeight - r.controlSumHeight) > ONE_LINE_SLACK) p.push(`status line is ${(r.sumHeight - r.controlSumHeight).toFixed(2)} px taller than a plain one`)
      if (r.chipRects.some(n => n > 1)) p.push(`a chip is split over ${Math.max(...r.chipRects)} line boxes`)
      if (r.width === 200 && CLIPPED_AT_200.includes(r.row) && !r.clipped) p.push('a line longer than the row is not clipped')
      if (r.ageVisible === false) p.push('the age is not visible')
      return p
    }
    for (const r of all) r.problems = problems(r)
    const bad = all.filter(r => r.problems.length)
    const result = { label, status: bad.length ? 'FAIL' : 'PASS', measured: all.length, failing: bad.length, sessionId: sid(process.pid),
      rendererSessionId: sid(wc.getOSProcessId()), muted: wc.isAudioMuted(), clipboardCalls, errors, rows: all }
    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(result, null, 2))
    fs.writeFileSync(path.join(out, 'all.png'), (await wc.capturePage()).toPNG())
    const line = r => `${r.mode.padEnd(6)} ${String(r.width).padStart(3)}px ${r.row.padEnd(10)} row ${String(r.rowDelta).padStart(6)} px  chip rects [${r.chipRects}] ${r.chipWhiteSpace[0] ?? '-'} clipped ${r.clipped}${r.problems.length ? '  FAIL: ' + r.problems.join('; ') : ''}`
    console.log(all.map(line).join('\n'))
    console.log(`${result.status}: ${all.length} measured, ${bad.length} failing`)
    assert.equal(clipboardCalls, 0)
    app.exit(bad.length ? 1 : 0)
  } catch (e) {
    console.error(e)
    let dom = null
    try { dom = await BrowserWindow.getAllWindows()[0].webContents.executeJavaScript("JSON.stringify({ html: document.documentElement.className, body: document.body.className, chip: (c => c && { tag: c.tagName, cls: c.className, display: getComputedStyle(c).display, ws: getComputedStyle(c).whiteSpace })(document.querySelector('.tray-sum .ref-item')) })") } catch {}
    try { fs.writeFileSync(path.join(out, 'failure.json'), JSON.stringify({ error: String(e), errors, dom }, null, 2)) } catch {}
    app.exit(2)
  }
}).catch(e => { console.error(e); app.exit(2) })
