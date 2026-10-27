// chipicons.capture.cjs — USER 2026-10-27 22:34:06Z m2aeb0fd887cb ("center the icon appearing in all links to
// things"). Measures, in a real renderer, the vertical centre of every mention chip's icon against the centre of
// its label (the text's own line box), in both layouts (inline-flex buttons, and the "wrap object mentions"
// inline fragments) and at two font sizes, and that a chip does not change its line's height. It fails when any
// icon is more than 1 px off, and writes zoomed crops of each chip kind.
//
//   electron.exe chipicons.capture.cjs <outDir> <repoRoot> <node_modules dir> <label> [baseline results.json]
//
// With a baseline (the results.json of a run at the base), a chip also fails when it makes its line taller than
// it was there by more than half a pixel: the fix must not change the line height around a link.
//
// Session 0, hidden off-screen window, muted, clipboard stubbed and denied, only file: data: blob: requests, no
// OS input. Writes only under <outDir>/<label>/.
const { app, BrowserWindow, session, clipboard } = require('electron')
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const [outArg, repoArg, depsArg, label = 'run', baselineArg] = process.argv.slice(2)
const out = path.resolve(outArg, label), repo = path.resolve(repoArg), deps = path.resolve(depsArg)
const sid = pid => Number(execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Process -Id ${Number(pid)}).SessionId`], { encoding: 'utf8', windowsHide: true }).trim())
assert.equal(sid(process.pid), 0, 'Session 0 required before creating a window')
fs.mkdirSync(out, { recursive: true })
app.setPath('userData', path.join(out, 'profile-' + process.pid)); app.setPath('sessionData', path.join(out, 'session-' + process.pid))
app.disableHardwareAcceleration(); app.commandLine.appendSwitch('mute-audio')
let clipboardCalls = 0
for (const k of Object.keys(clipboard)) if (typeof clipboard[k] === 'function') clipboard[k] = () => { clipboardCalls++; return k === 'availableFormats' ? [] : k === 'has' ? false : '' }
const within = async (p, ms, what) => { let t; try { return await Promise.race([p, new Promise((_r, j) => { t = setTimeout(() => j(Error('Deadline: ' + what)), ms) })]) } finally { clearTimeout(t) } }

async function bundle() {
  const esbuild = require(path.join(deps, 'esbuild'))
  try {
    await esbuild.build({
      entryPoints: [path.join(repo, 'apps/desktop/renderer/tests/chipicons.visual.tsx')],
      outfile: path.join(out, 'probe.js'), bundle: true, format: 'iife', platform: 'browser', jsx: 'automatic', logLevel: 'warning',
      nodePaths: [deps], loader: { '.png': 'dataurl', '.svg': 'dataurl', '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl' },
      define: { 'process.env.NODE_ENV': '"production"', __SRC_DIR__: '""' },
    })
  } finally { await esbuild.stop() }
  fs.writeFileSync(path.join(out, 'index.html'), '<!doctype html><html lang="en"><meta charset="utf-8"><link rel="stylesheet" href="probe.css"><body style="margin:0"><div id="root"></div><script src="probe.js"></script></html>')
}

const MEASURE = `(() => {
  const MARK = '.ref-mark,.tier,.project-mark,.net-mark'
  const label = chip => {
    const rects = []
    const walk = n => {
      if (n.nodeType === 3) { if (n.textContent.trim()) { const r = document.createRange(); r.selectNodeContents(n); rects.push(...r.getClientRects()) } return }
      if (n.nodeType !== 1) return
      if (n.matches(MARK) || n.matches('.net-named .ref-id')) return
      if (n.matches('.net-name')) { rects.push(n.getBoundingClientRect()); return }
      for (const c of n.childNodes) walk(c)
    }
    walk(chip)
    const seen = rects.filter(r => r.width > 0 && r.height > 0)
    if (!seen.length) return null
    const top0 = Math.min(...seen.map(r => r.top)), line = seen.filter(r => Math.abs(r.top - top0) < 3)
    return { top: Math.min(...line.map(r => r.top)), bottom: Math.max(...line.map(r => r.bottom)) }
  }
  const result = []
  for (const sec of document.querySelectorAll('.chip-section')) {
    const control = sec.querySelector('[data-chip-row=control]').getBoundingClientRect().height
    for (const row of sec.querySelectorAll('[data-chip-row]')) {
      const name = row.dataset.chipRow
      if (name === 'control') continue
      const chip = row.querySelector('.ref-chip'), mark = chip && chip.querySelector(MARK), box = chip && label(chip)
      const rec = { size: Number(sec.dataset.size), row: name, tag: chip && chip.tagName.toLowerCase(), display: chip && getComputedStyle(chip).display }
      if (!chip || !mark || !box) { result.push({ ...rec, error: !chip ? 'no chip' : !mark ? 'no icon' : 'no label text' }); continue }
      const m = mark.getBoundingClientRect()
      const markCenter = (m.top + m.bottom) / 2, labelCenter = (box.top + box.bottom) / 2
      result.push({ ...rec, markClass: mark.className.baseVal ?? mark.className, markHeight: m.height, labelHeight: box.bottom - box.top,
        markCenter, labelCenter, off: +(markCenter - labelCenter).toFixed(2), rowHeight: row.getBoundingClientRect().height, controlHeight: control,
        lineDelta: +(row.getBoundingClientRect().height - control).toFixed(2) })
    }
  }
  return result
})()`

app.whenReady().then(async () => {
  const errors = []
  try {
    await bundle()
    const ses = session.fromPartition('chip-icons-' + process.pid)
    ses.setPermissionCheckHandler(() => false); ses.setPermissionRequestHandler((_w, _p, done) => done(false))
    ses.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:|about:)/.test(d.url) }))
    const win = new BrowserWindow({ width: 1024, height: 768, show: false, frame: false,
      webPreferences: { session: ses, offscreen: true, backgroundThrottling: false, nodeIntegration: false, sandbox: true, contextIsolation: true } })
    const wc = win.webContents
    wc.setAudioMuted(true); wc.setWindowOpenHandler(() => ({ action: 'deny' }))
    for (const k of ['copy', 'cut', 'paste', 'pasteAndMatchStyle']) wc[k] = () => { throw Error('Clipboard denied') }
    wc.on('console-message', (_e, level, message) => { if (level >= 2) errors.push(message) })
    const js = s => wc.executeJavaScript(s)
    const wait = s => js(`new Promise((resolve, reject) => { const end = Date.now() + 8000; (function check() { if (${s}) return resolve(); if (Date.now() > end) return reject(Error('Wait: ' + ${JSON.stringify(s)})); setTimeout(check, 25) })() })`)
    const paint = () => js('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 120))))')
    await within(win.loadFile(path.join(out, 'index.html')), 15000, 'load')
    await wait("document.querySelectorAll('[data-chip-row]').length >= 30"); await paint()

    const all = []
    for (const mode of ['flex', 'inline']) {
      await js(`window.chipFixture.wrap(${mode === 'inline'})`)
      if (mode === 'inline') await wait("document.documentElement.classList.contains('wrap-object-mentions') && document.querySelector('[data-chip-row=item] span[role=button]') && document.querySelector('[data-chip-row=md-item] span[role=button]')")
      else await wait("!document.documentElement.classList.contains('wrap-object-mentions')")
      await paint()
      const rows = await js(MEASURE)
      for (const r of rows) all.push({ mode, ...r })
      // zoomed crops of each chip kind, 13 px sentence, 3x. The window is as large as the display (1024 x 768 in
      // Session 0), so each row is scrolled into view and cropped from its own capture.
      await js("document.getElementById('stage').style.zoom = '3'"); await paint()
      fs.mkdirSync(path.join(out, 'png'), { recursive: true })
      const names = await js(`[...document.querySelectorAll('.chip-section[data-size="13"] [data-chip-row]')].map(r => r.dataset.chipRow).filter(n => n !== 'control')`)
      for (const name of names) {
        await js(`document.querySelector('.chip-section[data-size="13"] [data-chip-row="${name}"]').scrollIntoView({ block: 'center' })`); await paint()
        const c = await js(`(() => { const row = document.querySelector('.chip-section[data-size="13"] [data-chip-row="${name}"]'), p = row.getBoundingClientRect(), k = row.querySelector('.ref-chip').getBoundingClientRect()
          const y = Math.max(0, Math.floor(p.top - 6)); return { x: 0, y, w: Math.min(innerWidth, Math.ceil(k.right + 120)), h: Math.min(innerHeight - y, Math.ceil(p.height + 12)) } })()`)
        fs.writeFileSync(path.join(out, 'png', `${mode}-${name}.png`), (await wc.capturePage()).crop({ x: c.x, y: c.y, width: c.w, height: c.h }).toPNG())
      }
      await js('window.scrollTo(0, 0)')
      await js("document.getElementById('stage').style.zoom = '1'"); await paint()
    }

    const base = baselineArg ? new Map(JSON.parse(fs.readFileSync(path.resolve(baselineArg), 'utf8')).rows.map(r => [`${r.mode}/${r.size}/${r.row}`, r.lineDelta])) : null
    for (const r of all) { const was = base && base.get(`${r.mode}/${r.size}/${r.row}`); r.lineGrew = was === undefined || was === null ? 0 : +(r.lineDelta - was).toFixed(2) }
    const bad = all.filter(r => r.error || Math.abs(r.off) > 1 || r.lineGrew > 0.5)
    const result = { label, status: bad.length ? 'FAIL' : 'PASS', measured: all.length, failing: bad.length, sessionId: sid(process.pid),
      rendererSessionId: sid(wc.getOSProcessId()), muted: wc.isAudioMuted(), clipboardCalls, errors, rows: all }
    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(result, null, 2))
    fs.writeFileSync(path.join(out, 'all.png'), (await wc.capturePage()).toPNG())
    const line = r => `${r.mode.padEnd(6)} ${String(r.size).padStart(2)}px ${r.row.padEnd(14)} ${r.error ? 'ERROR ' + r.error : `off ${String(r.off).padStart(6)} px  line ${String(r.lineDelta).padStart(6)} px (${r.lineGrew >= 0 ? '+' : ''}${r.lineGrew})  icon ${r.markHeight.toFixed(1)}h label ${r.labelHeight.toFixed(1)}h  ${r.tag}/${r.display}`}`
    console.log(all.map(line).join('\n'))
    console.log(`${result.status}: ${all.length} measured, ${bad.length} failing (icon centre more than 1 px off its label, or a line taller than at the baseline by more than 0.5 px)`)
    assert.equal(clipboardCalls, 0)
    app.exit(bad.length ? 1 : 0)
  } catch (e) { console.error(e); try { fs.writeFileSync(path.join(out, 'failure.json'), JSON.stringify({ error: String(e), errors }, null, 2)) } catch {} app.exit(2) }
}).catch(e => { console.error(e); app.exit(2) })
