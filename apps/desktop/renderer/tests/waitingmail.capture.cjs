// waitingmail.capture.cjs - docket project-mail-listeners-tab-waiting-mail-section-a (USER 2026-11-27 m7472b6f3a603
// "yes please, above recently finished"): the project Mail > listeners folder drawn by the real MailListenersView
// (fixture waitingmail.visual.tsx). One picture; `before` (the base) only records the sections, `after` checks Waiting
// mail sits above Recently Finished with its three rows in hand-out order, visible (hit-tested).
//
//   electron.exe waitingmail.capture.cjs <outDir> <repoRoot> <node_modules dir> <label> <before|after>
//
// Session 0, a hidden offscreen window, muted, clipboard stubbed and denied, only file: data: blob: about: requests,
// no input at all. Writes only under <outDir>/<label>/.
const { app, BrowserWindow, session, clipboard } = require('electron')
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const [outArg, repoArg, depsArg, label = 'run', mode = 'after'] = process.argv.slice(2)
const out = path.resolve(outArg, label), repo = path.resolve(repoArg), deps = path.resolve(depsArg)
const sid = pid => Number(execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Process -Id ${Number(pid)}).SessionId`], { encoding: 'utf8', windowsHide: true }).trim())
assert.equal(sid(process.pid), 0, 'Session 0 required before creating a window')
fs.mkdirSync(path.join(out, 'png'), { recursive: true })
app.setPath('userData', path.join(out, 'profile-' + process.pid)); app.setPath('sessionData', path.join(out, 'session-' + process.pid))
app.disableHardwareAcceleration(); app.commandLine.appendSwitch('mute-audio')
let clipboardCalls = 0
for (const k of Object.keys(clipboard)) if (typeof clipboard[k] === 'function') clipboard[k] = () => { clipboardCalls++; return k === 'availableFormats' ? [] : k === 'has' ? false : '' }

async function bundle() {
  const esbuild = require(path.join(deps, 'esbuild'))
  try {
    await esbuild.build({
      entryPoints: [path.join(repo, 'apps/desktop/renderer/tests/waitingmail.visual.tsx')],
      outfile: path.join(out, 'probe.js'), bundle: true, format: 'iife', platform: 'browser', jsx: 'automatic', logLevel: 'warning',
      nodePaths: [deps], loader: { '.png': 'dataurl', '.svg': 'dataurl', '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl' },
      define: { 'process.env.NODE_ENV': '"production"', __SRC_DIR__: '""' },
    })
  } finally { await esbuild.stop() }
  fs.writeFileSync(path.join(out, 'index.html'), '<!doctype html><html lang="en"><meta charset="utf-8"><link rel="stylesheet" href="probe.css"><body style="margin:0"><div id="root"></div><script src="probe.js"></script></body></html>')
}

const READ = `(() => {
  const titles = [...document.querySelectorAll('.mail-listeners-table tr.slot-section h4')].map(h => h.textContent)
  const rows = [...document.querySelectorAll('.mail-listeners-table .mail-waiting tr.waiting-mail')].map(r => {
    const link = r.querySelector('.listener-mail-link'), b = link && link.getBoundingClientRect()
    const at = b && document.elementFromPoint(b.left + Math.min(20, b.width / 2), b.top + b.height / 2)
    return { place: r.cells[0].textContent.trim(), mail: link && link.getAttribute('data-mail'), hit: !!at && link.contains(at),
      from: (r.querySelector('.listener-via') || {}).textContent || null, wait: r.querySelector('.slot-wait').textContent.trim(),
      inView: !!b && b.top >= 0 && b.bottom <= innerHeight }
  })
  return { titles, rows } })()`

app.whenReady().then(async () => {
  const errors = [], problems = [], facts = {}
  try {
    await bundle()
    const ses = session.fromPartition('waitingmail-' + process.pid)
    ses.setPermissionCheckHandler(() => false); ses.setPermissionRequestHandler((_w, _p, done) => done(false))
    ses.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:|about:)/.test(d.url) }))
    const win = new BrowserWindow({ width: 1016, height: 640, useContentSize: true, show: false, frame: false,
      webPreferences: { session: ses, offscreen: true, backgroundThrottling: false, nodeIntegration: false, sandbox: true, contextIsolation: true } })
    const wc = win.webContents
    wc.setAudioMuted(true)
    wc.setWindowOpenHandler(() => ({ action: 'deny' }))
    for (const k of ['copy', 'cut', 'paste', 'pasteAndMatchStyle']) wc[k] = () => { throw Error('Clipboard denied') }
    wc.on('console-message', (_e, level, message) => { if (level >= 2 && !/Electron Security Warning/.test(message)) errors.push(message) })
    await wc.loadFile(path.join(out, 'index.html'))
    await new Promise(r => setTimeout(r, 900))
    const read = await wc.executeJavaScript(READ)
    facts.read = read
    if (mode === 'after') {
      if (JSON.stringify(read.titles) !== JSON.stringify(['Working', 'Line', 'Waiting mail', 'Recently Finished'])) problems.push('sections: ' + read.titles.join(', '))
      if (JSON.stringify(read.rows.map(r => r.place + ':' + r.mail)) !== JSON.stringify(['1st:w1', '2nd:w2', '3rd:w3'])) problems.push('rows: ' + JSON.stringify(read.rows))
      for (const r of read.rows) if (!r.hit || !r.inView) problems.push('row not visible or covered: ' + JSON.stringify(r))
    } else if (read.titles.includes('Waiting mail')) problems.push('the base already has Waiting mail')
    fs.writeFileSync(path.join(out, 'png', (mode === 'after' ? '01-after-waiting-mail-above-recently-finished' : '01-before-no-waiting-mail') + '.png'),
      (await wc.capturePage()).toPNG())
    const result = { label, mode, status: problems.length ? 'FAIL' : 'PASS', problems, facts, versions: { electron: process.versions.electron, chrome: process.versions.chrome },
      sessionId: sid(process.pid), rendererSessionId: sid(wc.getOSProcessId()), muted: wc.isAudioMuted(), clipboardCalls, errors,
      pngs: fs.readdirSync(path.join(out, 'png')).sort() }
    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(result, null, 2))
    console.log(`${result.status}: ${problems.length} problems`)
    for (const p of problems) console.log('  - ' + p)
    app.exit(problems.length ? 1 : 0)
  } catch (e) {
    console.error(e)
    try { fs.writeFileSync(path.join(out, 'failure.json'), JSON.stringify({ error: String(e && e.stack || e), errors, problems, facts }, null, 2)) } catch {}
    app.exit(2)
  }
}).catch(e => { console.error(e); app.exit(2) })
