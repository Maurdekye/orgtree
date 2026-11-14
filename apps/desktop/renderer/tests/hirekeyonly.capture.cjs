// hirekeyonly.capture.cjs: only a metered API key can run the model (coordinator's ruling 2026-11-14 m30df0e222e4d).
//   1. the draft card of an Opus hire, named: its button reads "choose account" in one line, not "hire"
//   2. that button clicked: the settings open on the Model tab, the Account row reads "Choose an account"; nothing hired
//   3. the key picked there and the settings closed: the button reads "hire"; clicked, the hire names the key
//   electron.exe hirekeyonly.capture.cjs <outDir> <repoRoot> <node_modules dir> <label>
// Session 0, hidden off-screen window, muted, clipboard stubbed and denied, input only to this script's own web contents.
const { app, BrowserWindow, session, clipboard } = require('electron')
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const [outArg, repoArg, depsArg, label = 'run'] = process.argv.slice(2)
const out = path.resolve(outArg, label), repo = path.resolve(repoArg), deps = path.resolve(depsArg)
const sid = pid => Number(execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Process -Id ${Number(pid)}).SessionId`], { encoding: 'utf8', windowsHide: true }).trim())
assert.equal(sid(process.pid), 0, 'Session 0 required before creating a window')
fs.mkdirSync(out, { recursive: true })
for (const stale of ['failure.json', 'results.json']) { try { fs.unlinkSync(path.join(out, stale)) } catch { /* not there */ } }
app.setPath('userData', path.join(out, 'profile-' + process.pid)); app.setPath('sessionData', path.join(out, 'session-' + process.pid))
app.disableHardwareAcceleration(); app.commandLine.appendSwitch('mute-audio')
let clipboardCalls = 0
for (const k of Object.keys(clipboard)) if (typeof clipboard[k] === 'function') clipboard[k] = () => { clipboardCalls++; return k === 'availableFormats' ? [] : k === 'has' ? false : '' }
const within = async (p, ms, what) => { let t; try { return await Promise.race([p, new Promise((_r, j) => { t = setTimeout(() => j(Error('Deadline: ' + what)), ms) })]) } finally { clearTimeout(t) } }
const W = 1000, H = 720

async function bundle() {
  const esbuild = require(path.join(deps, 'esbuild'))
  try {
    await esbuild.build({
      entryPoints: [path.join(repo, 'apps/desktop/renderer/tests/hirekeyonly.visual.tsx')],
      outfile: path.join(out, 'probe.js'), bundle: true, format: 'iife', platform: 'browser', jsx: 'automatic', logLevel: 'warning',
      nodePaths: [deps], loader: { '.png': 'dataurl', '.svg': 'dataurl', '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl' },
      define: { 'process.env.NODE_ENV': '"production"', __SRC_DIR__: '""' },
    })
  } finally { await esbuild.stop() }
  fs.writeFileSync(path.join(out, 'index.html'), '<!doctype html><html lang="en"><meta charset="utf-8"><link rel="stylesheet" href="probe.css"><body style="margin:0"><div id="root"></div><script src="probe.js"></script></body></html>')
}

// what the eye would check, read from the document
const LOOK = `(() => {
  const primary = document.querySelector('.df-foot button.primary')
  const account = document.querySelector('select[aria-label="Account"]')
  const centre = el => { if (!el) return null; const r = el.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2, Math.round(r.width), Math.round(r.height)] }
  const seen = el => { if (!el) return false; const c = centre(el); const hit = document.elementFromPoint(c[0], c[1]); return !!hit && (hit === el || el.contains(hit) || hit.contains(el)) }
  return {
    button: primary && { text: primary.textContent.trim(), disabled: primary.disabled, title: primary.title, at: centre(primary), seen: seen(primary) },
    name: document.querySelector('.df-name') && { value: document.querySelector('.df-name').value, at: centre(document.querySelector('.df-name')) },
    tab: (document.querySelector('[role="tab"][aria-selected="true"]') || {}).textContent || null,
    account: account && { value: account.value, disabled: account.disabled, options: [...account.options].map(o => [o.value, o.textContent, o.disabled]),
      shown: account.options[account.selectedIndex] ? account.options[account.selectedIndex].textContent : null, at: centre(account), seen: seen(account) },
    machineDefault: [...document.querySelectorAll('button')].some(b => /Use machine default/.test(b.textContent)),
    done: (() => { const b = [...document.querySelectorAll('.overlay button, .modal button, dialog button')].find(b => /^(Done|Close)$/.test(b.textContent.trim())); return b ? centre(b) : null })(),
    hired: window.hired,
  }
})()`

app.whenReady().then(async () => {
  const errors = []
  try {
    await bundle()
    const ses = session.fromPartition('hirekeyonly-' + process.pid)
    ses.setPermissionCheckHandler(() => false); ses.setPermissionRequestHandler((_w, _p, done) => done(false))
    ses.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:|about:)/.test(d.url) }))
    const win = new BrowserWindow({ width: W, height: H, useContentSize: true, show: false, frame: false,
      webPreferences: { session: ses, offscreen: true, backgroundThrottling: false, nodeIntegration: false, sandbox: true, contextIsolation: true } })
    const wc = win.webContents
    wc.setAudioMuted(true)
    wc.setWindowOpenHandler(() => ({ action: 'deny' }))
    for (const k of ['copy', 'cut', 'paste', 'pasteAndMatchStyle']) wc[k] = () => { throw Error('Clipboard denied') }
    wc.on('console-message', (_e, level, message) => { if (level >= 2) errors.push(message) })
    const js = s => wc.executeJavaScript(s)
    const pause = ms => new Promise(r => setTimeout(r, ms))
    const until = async (fn, what, ms = 8000) => { const end = Date.now() + ms; for (;;) { if (await fn()) return; if (Date.now() > end) throw Error('Wait: ' + what); await pause(60) } }
    const look = () => js(LOOK)
    const shot = async name => {
      try { await within(js('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 200))))'), 3000, 'paint ' + name) } catch {}
      try { const img = await within(wc.capturePage(), 5000, 'capture ' + name); const png = img.toPNG(); fs.writeFileSync(path.join(out, 'png', name + '.png'), png); return { bytes: png.length, size: img.getSize() } }
      catch (e) { return { error: String(e) } }
    }
    // real input, to this window only
    const click = async at => {
      const [x, y] = [Math.round(at[0]), Math.round(at[1])]
      wc.sendInputEvent({ type: 'mouseMove', x, y }); await pause(40)
      wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 }); wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
      await pause(350)
    }
    fs.mkdirSync(path.join(out, 'png'), { recursive: true })
    await within(win.loadFile(path.join(out, 'index.html')), 15000, 'load')
    await until(() => js("!!document.querySelector('.df-foot button.primary')"), 'the draft card')
    await pause(400)
    const problems = [], steps = {}
    const need = (ok, what) => { if (!ok) problems.push(what) }

    // 1. the card, named
    await click((await look()).name.at)
    for (const ch of 'worker') { wc.sendInputEvent({ type: 'char', keyCode: ch }); await pause(20) }
    await pause(300)
    const card = steps.card = { look: await look() }
    card.png = await shot('1-draft-card-choose-an-account')
    need(card.look.name.value === 'worker', `the name is ${JSON.stringify(card.look.name.value)}`)
    need(card.look.button.text === 'choose account' && !card.look.button.disabled && card.look.button.seen, `the card's button is ${JSON.stringify(card.look.button)}`)
    need(/Only a metered API key can run opus here/.test(card.look.button.title), `the button's title is ${JSON.stringify(card.look.button.title)}`)

    // 2. the button opens the settings at the Account row and hires nothing
    await click(card.look.button.at)
    await until(() => js(`!!document.querySelector('select[aria-label="Account"]')`), 'the settings with the Account row')
    await pause(300)
    const settings = steps.settings = { look: await look() }
    settings.png = await shot('2-settings-account-row-choose-an-account')
    need(settings.look.tab === 'Model', `the open tab is ${JSON.stringify(settings.look.tab)}`)
    need(settings.look.account.value === '' && settings.look.account.shown === 'Choose an account' && !settings.look.account.disabled && settings.look.account.seen,
      `the Account row is ${JSON.stringify(settings.look.account)}`)
    need(JSON.stringify(settings.look.account.options.map(o => o[0])) === JSON.stringify(['', 'claude-key']), `the choices are ${JSON.stringify(settings.look.account.options)}`)
    need(!settings.look.machineDefault, 'Use machine default is offered')
    need(settings.look.hired.length === 0, `something was hired: ${JSON.stringify(settings.look.hired)}`)

    // 3. the key picked (the select's own change, as a pick from its list makes it), the settings closed, then hire
    await js(`(() => { const s = document.querySelector('select[aria-label="Account"]'); s.value = 'claude-key'; s.dispatchEvent(new Event('change', { bubbles: true })) })()`)
    await pause(400)
    const picked = steps.picked = { look: await look() }
    picked.png = await shot('3-settings-key-chosen')
    need(picked.look.account.value === 'claude-key', `after the pick the Account row is ${JSON.stringify(picked.look.account)}`)
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' }); wc.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
    await pause(500)
    if (await js(`!!document.querySelector('select[aria-label="Account"]')`) && picked.look.done) await click(picked.look.done)
    await until(() => js(`!document.querySelector('select[aria-label="Account"]')`), 'the settings to close')
    const ready = steps.ready = { look: await look() }
    ready.png = await shot('4-draft-card-hire')
    need(ready.look.button.text === 'hire' && !ready.look.button.disabled, `after the pick the card's button is ${JSON.stringify(ready.look.button)}`)
    await click(ready.look.button.at)
    const end = steps.hired = { look: await look() }
    need(JSON.stringify(end.look.hired) === JSON.stringify([{ name: 'worker', account: 'claude-key' }]), `the hire was ${JSON.stringify(end.look.hired)}`)

    const result = { label, status: problems.length ? 'FAIL' : 'PASS', problems, steps, sessionId: sid(process.pid), rendererSessionId: sid(wc.getOSProcessId()),
      muted: wc.isAudioMuted(), clipboardCalls, errors }
    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(result, null, 2))
    console.log(`${result.status}: ${problems.length} problems`)
    for (const p of problems) console.log('  - ' + p)
    console.log('  errors ' + JSON.stringify(errors).slice(0, 600))
    app.exit(problems.length ? 1 : 0)
  } catch (e) {
    console.error(e)
    try { fs.writeFileSync(path.join(out, 'failure.json'), JSON.stringify({ error: String(e), errors }, null, 2)) } catch {}
    app.exit(2)
  }
}).catch(e => { console.error(e); app.exit(2) })
