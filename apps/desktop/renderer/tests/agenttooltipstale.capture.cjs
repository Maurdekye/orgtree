// agenttooltipstale.capture.cjs — USER 2026-11-13 m34935c22a71e: the model tag of a node showed over every part of the
// agent's canvas desk that has no tooltip of its own. Measured in a real Chromium window with real mouse input. A native
// tooltip is drawn by the OS and cannot be photographed in a hidden window, so each step reads what the browser WOULD
// show at the pointer: the title of the nearest element under it that has one.
//   1. the pointer over the node: the tag
//   2. a click on the node (it becomes the desk), pointer not moved: nothing
//   3. the pointer over a plain part of the desk: nothing
//   4. the pointer over the agent's name on the desk: the tag
//   5. the pointer over a button with its own tooltip: that tooltip
//   6. back to the node, pointer over it: the tag again (node hover unchanged)
// Before the fix steps 2 and 3 show the tag.
//
//   electron.exe agenttooltipstale.capture.cjs <outDir> <repoRoot> <node_modules dir> <label>
//
// Session 0, one hidden off-screen window, muted, clipboard stubbed and denied, only file: data: blob: about: requests,
// no OS input: the mouse goes to this script's own web contents. Writes only under <outDir>/<label>/.
const { app, BrowserWindow, session, clipboard } = require('electron')
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const [outArg, repoArg, depsArg, label = 'run'] = process.argv.slice(2)
const out = path.resolve(outArg, label), repo = path.resolve(repoArg), deps = path.resolve(depsArg)
const sid = pid => Number(execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Process -Id ${Number(pid)}).SessionId`], { encoding: 'utf8', windowsHide: true }).trim())
assert.equal(sid(process.pid), 0, 'Session 0 required before creating a window')
fs.mkdirSync(path.join(out, 'png'), { recursive: true })
for (const stale of ['failure.json', 'results.json']) fs.rmSync(path.join(out, stale), { force: true })
app.setPath('userData', path.join(out, 'profile-' + process.pid)); app.setPath('sessionData', path.join(out, 'session-' + process.pid))
app.disableHardwareAcceleration(); app.commandLine.appendSwitch('mute-audio')
let clipboardCalls = 0
for (const k of Object.keys(clipboard)) if (typeof clipboard[k] === 'function') clipboard[k] = () => { clipboardCalls++; return k === 'availableFormats' ? [] : k === 'has' ? false : '' }
const within = async (p, ms, what) => { let t; try { return await Promise.race([p, new Promise((_r, j) => { t = setTimeout(() => j(Error('Deadline: ' + what)), ms) })]) } finally { clearTimeout(t) } }
const TAG = 'scout · Anthropic · Claude Opus 5.5 · effort high'

async function bundle() {
  const esbuild = require(path.join(deps, 'esbuild'))
  try {
    await esbuild.build({
      entryPoints: [path.join(repo, 'apps/desktop/renderer/tests/agenttooltipstale.visual.tsx')],
      outfile: path.join(out, 'probe.js'), bundle: true, format: 'iife', platform: 'browser', jsx: 'automatic', logLevel: 'warning',
      nodePaths: [deps], loader: { '.png': 'dataurl', '.svg': 'dataurl', '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl' },
      define: { 'process.env.NODE_ENV': '"production"', __SRC_DIR__: '""' },
    })
  } finally { await esbuild.stop() }
  fs.writeFileSync(path.join(out, 'index.html'), '<!doctype html><html lang="en"><meta charset="utf-8"><link rel="stylesheet" href="probe.css"><body style="margin:0"><div id="root"></div><script src="probe.js"></script></body></html>')
}

app.whenReady().then(async () => {
  const errors = []
  try {
    await bundle()
    const ses = session.fromPartition('hovertag-' + process.pid)
    ses.setPermissionCheckHandler(() => false); ses.setPermissionRequestHandler((_w, _p, done) => done(false))
    ses.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:|about:)/.test(d.url) }))
    const win = new BrowserWindow({ width: 900, height: 600, useContentSize: true, show: false, frame: false,
      webPreferences: { session: ses, offscreen: true, backgroundThrottling: false, nodeIntegration: false, sandbox: true, contextIsolation: true } })
    const wc = win.webContents
    wc.setAudioMuted(true); wc.setWindowOpenHandler(() => ({ action: 'deny' }))
    for (const k of ['copy', 'cut', 'paste', 'pasteAndMatchStyle']) wc[k] = () => { throw Error('Clipboard denied') }
    wc.on('console-message', (_e, level, message) => { if (level >= 2 && !/Electron Security Warning/.test(message)) errors.push(message) })
    const js = s => wc.executeJavaScript(s, true)
    const pause = ms => new Promise(r => setTimeout(r, ms))
    const until = async (fn, what, ms = 8000) => { const end = Date.now() + ms; for (;;) { if (await fn()) return; if (Date.now() > end) throw Error('Wait: ' + what); await pause(60) } }
    await within(win.loadFile(path.join(out, 'index.html')), 15000, 'load')
    await until(() => js("!!document.querySelector('#node-name')"), 'the node')
    let at = [0, 0]
    const centre = sel => js(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2] })()`)
    const moveTo = async (sel) => { at = await centre(sel); wc.sendInputEvent({ type: 'mouseMove', x: Math.round(at[0]) - 2, y: Math.round(at[1]) }); await pause(40); wc.sendInputEvent({ type: 'mouseMove', x: Math.round(at[0]), y: Math.round(at[1]) }); await pause(250) }
    const click = async () => { for (const type of ['mouseDown', 'mouseUp']) wc.sendInputEvent({ type, x: Math.round(at[0]), y: Math.round(at[1]), button: 'left', clickCount: 1 }); await pause(300) }
    // what the browser would show at the pointer: the nearest title at or above the element under it
    const shown = () => js(`(() => { const el = document.elementFromPoint(${at[0]}, ${at[1]}); const t = el && el.closest('[title]')
      return { under: el ? (el.id || el.tagName) : null, title: t ? t.getAttribute('title') : null, on: t ? (t.id || t.tagName) : null,
        desk: !document.querySelector('#node-name'), cardIsAnchor: document.querySelector('#card').hasAttribute('data-agent-tooltip') } })()`)
    const shot = async (name) => { try { const img = await within(wc.capturePage(), 5000, name); fs.writeFileSync(path.join(out, 'png', name + '.png'), img.toPNG()) } catch (e) { errors.push('capture ' + name + ': ' + e) } }
    const problems = [], steps = {}
    const need = (ok, what) => { if (!ok) problems.push(what) }

    await moveTo('#node-name')
    steps.node = await shown()
    need(steps.node.title === TAG && !steps.node.desk, `1. over the node: ${JSON.stringify(steps.node)}`)
    await shot('1-node')

    await click()
    steps.justOpened = await shown()
    need(steps.justOpened.desk && !steps.justOpened.cardIsAnchor, `control: the click did not open the desk: ${JSON.stringify(steps.justOpened)}`)
    need(steps.justOpened.title === null, `2. desk just opened, pointer not moved: the tooltip would read ${JSON.stringify(steps.justOpened.title)} (on ${steps.justOpened.on})`)

    await moveTo('#plain')
    steps.plain = await shown()
    need(steps.plain.title === null, `3. over a plain part of the desk: the tooltip would read ${JSON.stringify(steps.plain.title)} (on ${steps.plain.on})`)
    await shot('2-desk-plain-area')

    await moveTo('#desk-name')
    steps.name = await shown()
    need(steps.name.title === TAG && steps.name.on === 'desk-name', `4. over the agent's name on the desk: ${JSON.stringify(steps.name)}`)

    await moveTo('#own')
    steps.own = await shown()
    need(steps.own.title === 'settings for scout', `5. over a button with its own tooltip: ${JSON.stringify(steps.own)}`)

    await moveTo('#back'); await click()
    await until(() => js("!!document.querySelector('#node-name')"), 'the node again')
    await moveTo('#node-name')
    steps.nodeAgain = await shown()
    need(steps.nodeAgain.title === TAG, `6. over the node again: ${JSON.stringify(steps.nodeAgain)}`)

    const result = { label, status: problems.length ? 'FAIL' : 'PASS', problems, steps, sessionId: sid(process.pid), rendererSessionId: sid(wc.getOSProcessId()),
      muted: wc.isAudioMuted(), clipboardCalls, errors }
    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(result, null, 2))
    console.log(`${result.status}: ${problems.length} problems`)
    for (const p of problems) console.log('  - ' + p)
    app.exit(problems.length ? 1 : 0)
  } catch (e) {
    console.error(e)
    try { fs.writeFileSync(path.join(out, 'failure.json'), JSON.stringify({ error: String(e), errors }, null, 2)) } catch {}
    app.exit(2)
  }
}).catch(e => { console.error(e); app.exit(2) })
