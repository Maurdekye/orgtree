// deskheadfit.capture.cjs — USER 2026-11-19 mc14eea0faf60 "at certain desk widths the dnd and halt buttons overlap the
// status". Sweeps the desk header (fixture deskheadfit.visual.tsx: the real header frame, banner, controls and
// stylesheet) over desk widths, as a pinned desk (no name in the row) and as a plain one (short and long name), with
// DND off and armed ("DND next turn"), and a short, a long and the halted status. At every step no two header controls
// may share a pixel, none may leave the header's box, and the point in the middle of each must hit that control.
//
//   electron.exe deskheadfit.capture.cjs <outDir> <repoRoot> <node_modules dir> <label>
//
// Session 0 only, hidden off-screen window, muted, clipboard stubbed and denied, only file: data: blob: about: requests,
// no input at all. Writes only under <outDir>/<label>/.
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

async function bundle() {
  const esbuild = require(path.join(deps, 'esbuild'))
  try {
    await esbuild.build({
      entryPoints: [path.join(repo, 'apps/desktop/renderer/tests/deskheadfit.visual.tsx')],
      outfile: path.join(out, 'probe.js'), bundle: true, format: 'iife', platform: 'browser', jsx: 'automatic', logLevel: 'warning',
      nodePaths: [deps], loader: { '.png': 'dataurl', '.svg': 'dataurl', '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl' },
      define: { 'process.env.NODE_ENV': '"production"', __SRC_DIR__: '""' },
    })
  } finally { await esbuild.stop() }
  fs.writeFileSync(path.join(out, 'index.html'), '<!doctype html><html lang="en"><meta charset="utf-8"><link rel="stylesheet" href="probe.css"><body style="margin:0"><div id="root"></div><script src="probe.js"></script></body></html>')
}

// every visible control of the header row, its box, and what the point in its middle hits
const MEASURE = `(() => {
  const head = document.querySelector('.cc-head-top'), box = document.getElementById('box').getBoundingClientRect()
  const sels = ['.cc-head-left > .tier', '.cc-head-left > .cc-name', '.cc-context-seat', '.cc-process-seat', '.turn-status-banner',
    '.cc-actions > button', '.cc-tabs > button', '.cc-head-right > .popout-button', '.cc-head-right > .cc-icon']
  const items = []
  for (const s of sels) for (const el of head.querySelectorAll(s)) {
    const r = el.getBoundingClientRect(); if (!r.width || !r.height) continue
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    items.push({ what: s.replace(/^.*> /, '') + ':' + (el.textContent || '').trim().slice(0, 16), l: r.left, t: r.top, r: r.right, b: r.bottom,
      hit: !!hit && (hit === el || el.contains(hit)) })
  }
  const bad = []
  for (let i = 0; i < items.length; i++) { const a = items[i]
    if (a.l < box.left - .5 || a.r > box.right + .5) bad.push(a.what + ' leaves the header (' + Math.round(a.l) + '..' + Math.round(a.r) + ' of ' + Math.round(box.left) + '..' + Math.round(box.right) + ')')
    if (!a.hit) bad.push(a.what + ' is not what its middle hits')
    for (let j = i + 1; j < items.length; j++) { const b = items[j]
      const w = Math.min(a.r, b.r) - Math.max(a.l, b.l), h = Math.min(a.b, b.b) - Math.max(a.t, b.t)
      if (w > .5 && h > .5) bad.push(a.what + ' overlaps ' + b.what + ' by ' + Math.round(w) + ' px') } }
  const name = head.querySelector('.cc-head-left > .cc-name'), nr = name && name.getBoundingClientRect()
  return { bad, height: Math.round(head.getBoundingClientRect().height), name: nr && nr.width ? Math.round(nr.width) : null }
})()`

app.whenReady().then(async () => {
  const errors = [], problems = [], facts = []
  try {
    await bundle()
    const ses = session.fromPartition('deskheadfit-' + process.pid)
    ses.setPermissionCheckHandler(() => false); ses.setPermissionRequestHandler((_w, _p, done) => done(false))
    ses.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:|about:)/.test(d.url) }))
    const win = new BrowserWindow({ width: 1024, height: 220, useContentSize: true, show: false, frame: false,
      webPreferences: { session: ses, offscreen: true, backgroundThrottling: false, nodeIntegration: false, sandbox: true, contextIsolation: true } })
    const wc = win.webContents
    wc.setAudioMuted(true); wc.setWindowOpenHandler(() => ({ action: 'deny' }))
    for (const k of ['copy', 'cut', 'paste', 'pasteAndMatchStyle']) wc[k] = () => { throw Error('Clipboard denied') }
    wc.on('console-message', (_e, level, message) => { if (level >= 2 && !/Electron Security Warning/.test(message)) errors.push(message) })
    await wc.loadFile(path.join(out, 'index.html'))
    const js = code => wc.executeJavaScript(code, true)
    const settle = () => js('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(1))))')
    for (let i = 0; i < 100 && !(await js("!!window.deskHeadFit && !!document.querySelector('.cc-head-top .dnd-control')")); i++) await new Promise(r => setTimeout(r, 80))
    const shot = async name => fs.writeFileSync(path.join(out, 'png', name + '.png'), (await wc.capturePage()).toPNG())
    const kinds = [{ k: 'pinned', pinned: true, name: 'coordinator-opus' }, { k: 'plain', pinned: false, name: 'coordinator-opus' },
      { k: 'plain-long-name', pinned: false, name: 'a-very-long-agent-name-for-the-header-row-opus' }]
    const shots = new Set(['pinned|on|compacting|700', 'pinned|off|active|640', 'pinned|on|active|760', 'plain|on|compacting|820', 'plain-long-name|on|compacting|900', 'pinned|off|active|420'])
    for (const kind of kinds) for (const dnd of [false, true]) for (const status of ['active', 'compacting', 'halted']) {
      const badWidths = []; let first = null; const heights = {}
      for (let width = 300; width <= 1000; width += 4) {
        await js(`window.deskHeadFit(${JSON.stringify({ width, pinned: kind.pinned, name: kind.name, dnd, status })})`); await settle()
        const m = await js(MEASURE)
        if (m.bad.length) { badWidths.push(width); first = first || { width, bad: m.bad.slice(0, 4) } }
        heights[m.height] = heights[m.height] || width // the first width at which the row has this height
        const key = [kind.k, dnd ? 'on' : 'off', status, width].join('|')
        if (shots.has(key)) await shot(key.replace(/\|/g, '-'))
      }
      const row = { kind: kind.k, dnd, status, badCount: badWidths.length, badFrom: badWidths[0] ?? null, badTo: badWidths[badWidths.length - 1] ?? null, first, heights }
      facts.push(row)
      if (badWidths.length) problems.push(`${kind.k}, DND ${dnd ? 'next turn' : 'off'}, ${status}: ${badWidths.length} widths from ${row.badFrom} to ${row.badTo} px, e.g. at ${first.width}: ${first.bad.join('; ')}`)
    }
    const result = { label, status: problems.length ? 'FAIL' : 'PASS', problems, facts, versions: { electron: process.versions.electron, chrome: process.versions.chrome },
      sessionId: sid(process.pid), rendererSessionId: sid(wc.getOSProcessId()), muted: wc.isAudioMuted(), clipboardCalls, errors, pngs: fs.readdirSync(path.join(out, 'png')).sort() }
    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(result, null, 2))
    console.log(`${result.status}: ${problems.length} problems (Electron ${process.versions.electron}, Chromium ${process.versions.chrome})`)
    for (const p of problems) console.log('  - ' + p)
    app.exit(problems.length ? 1 : 0)
  } catch (e) {
    console.error(e)
    try { fs.writeFileSync(path.join(out, 'failure.json'), JSON.stringify({ error: String(e && e.stack || e), errors, problems, facts }, null, 2)) } catch {}
    app.exit(2)
  }
}).catch(e => { console.error(e); app.exit(2) })
