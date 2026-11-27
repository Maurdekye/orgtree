// fitpins.capture.cjs - USER 2026-11-27 m56eddd849c57 / mc5532e448c3b: the Display > Desk row "Fit the view around
// pinned windows", on by default, drawn by the real settings kit (fixture fitpins.visual.tsx). Two pictures: the row as
// it opens (on), and after a real click on its toggle (off), with the choice saved browser-local.
//
//   electron.exe fitpins.capture.cjs <outDir> <repoRoot> <node_modules dir> <label>
//
// Session 0, a hidden offscreen window, muted, clipboard stubbed and denied, only file: data: blob: about: requests,
// no OS input: the click goes to this script's own web contents. Writes only under <outDir>/<label>/.
const { app, BrowserWindow, session, clipboard } = require('electron')
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const [outArg, repoArg, depsArg, label = 'run'] = process.argv.slice(2)
const out = path.resolve(outArg, label), repo = path.resolve(repoArg), deps = path.resolve(depsArg)
const sid = pid => Number(execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Process -Id ${Number(pid)}).SessionId`], { encoding: 'utf8', windowsHide: true }).trim())
assert.equal(sid(process.pid), 0, 'Session 0 required before creating a window')
fs.mkdirSync(path.join(out, 'png'), { recursive: true })
app.setPath('userData', path.join(out, 'profile-' + process.pid)); app.setPath('sessionData', path.join(out, 'session-' + process.pid))
app.disableHardwareAcceleration(); app.commandLine.appendSwitch('mute-audio')
let clipboardCalls = 0
for (const k of Object.keys(clipboard)) if (typeof clipboard[k] === 'function') clipboard[k] = () => { clipboardCalls++; return k === 'availableFormats' ? [] : k === 'has' ? false : '' }
const LABEL = 'Fit the view around pinned windows'

async function bundle() {
  const esbuild = require(path.join(deps, 'esbuild'))
  try {
    await esbuild.build({
      entryPoints: [path.join(repo, 'apps/desktop/renderer/tests/fitpins.visual.tsx')],
      outfile: path.join(out, 'probe.js'), bundle: true, format: 'iife', platform: 'browser', jsx: 'automatic', logLevel: 'warning',
      nodePaths: [deps], loader: { '.png': 'dataurl', '.svg': 'dataurl', '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl' },
      define: { 'process.env.NODE_ENV': '"production"', __SRC_DIR__: '""' },
    })
  } finally { await esbuild.stop() }
  fs.writeFileSync(path.join(out, 'index.html'), '<!doctype html><html lang="en"><meta charset="utf-8"><link rel="stylesheet" href="probe.css"><body style="margin:0"><div id="root"></div><script src="probe.js"></script></body></html>')
}

app.whenReady().then(async () => {
  const errors = [], problems = [], facts = {}
  try {
    await bundle()
    const ses = session.fromPartition('fitpins-' + process.pid)
    ses.setPermissionCheckHandler(() => false); ses.setPermissionRequestHandler((_w, _p, done) => done(false))
    ses.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:|about:)/.test(d.url) }))
    const win = new BrowserWindow({ width: 700, height: 260, useContentSize: true, show: false, frame: false,
      webPreferences: { session: ses, offscreen: true, backgroundThrottling: false, nodeIntegration: false, sandbox: true, contextIsolation: true } })
    const wc = win.webContents
    wc.setAudioMuted(true)
    wc.setWindowOpenHandler(() => ({ action: 'deny' }))
    for (const k of ['copy', 'cut', 'paste', 'pasteAndMatchStyle']) wc[k] = () => { throw Error('Clipboard denied') }
    wc.on('console-message', (_e, level, message) => { if (level >= 2 && !/Electron Security Warning/.test(message)) errors.push(message) })
    const pause = ms => new Promise(r => setTimeout(r, ms))
    await wc.loadFile(path.join(out, 'index.html'))
    await pause(600)
    const js = code => wc.executeJavaScript(code)
    const row = () => js(`(() => { const b = document.querySelector('input[aria-label="${LABEL}"]'); if (!b) return null
      const r = b.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2, at = document.elementFromPoint(x, y)
      return { checked: b.checked, x, y, w: r.width, hit: !!at && (at === b || b.contains(at) || at.contains(b) || (at.closest('label') && at.closest('label').contains(b))),
        text: (b.closest('.set-row, label, div') || b.parentElement).parentElement.textContent.replace(/\\s+/g, ' ').trim(),
        stored: localStorage.getItem('orgtree-fit-around-pins') } })()`)
    const shot = async name => fs.writeFileSync(path.join(out, 'png', name + '.png'), (await wc.capturePage()).toPNG())
    const on = await row()
    facts.on = on
    if (!on) problems.push('the row is not drawn')
    else {
      if (on.checked !== true) problems.push('the row is not on by default')
      if (!on.hit) problems.push('the toggle is covered: its centre does not hit it')
      if (!/pinned windows are ignored and the view uses the whole canvas/.test(on.text)) problems.push('the row does not say what it does: ' + on.text)
      await shot('01-fit-the-view-around-pinned-windows-on-by-default')
      const x = Math.round(on.x), y = Math.round(on.y)
      wc.sendInputEvent({ type: 'mouseMove', x, y }); await pause(40)
      for (const type of ['mouseDown', 'mouseUp']) wc.sendInputEvent({ type, x, y, button: 'left', clickCount: 1 })
      await pause(400)
      const off = await row()
      facts.off = off
      if (!off || off.checked !== false) problems.push('a click does not turn it off')
      if (!off || off.stored !== '{"enabled":false}') problems.push('the choice is not saved browser-local: ' + (off && off.stored))
      await shot('02-turned-off-by-a-click')
    }
    const result = { label, status: problems.length ? 'FAIL' : 'PASS', problems, facts, versions: { electron: process.versions.electron, chrome: process.versions.chrome },
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
