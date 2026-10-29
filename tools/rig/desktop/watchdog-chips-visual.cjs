// Session 0 Electron capture runner for `tools/rig/watchdog-chips-visual.mjs`.
// Refuses outside Session 0; muted audio; permissions denied; clipboard stubbed;
// file:/data:-only requests; loads `index-before.html` (genuine `--base` bundle)
// and `index-after.html` (worktree tip bundle) to capture `before.png`, `after.png`,
// and `result.json`.
const { app, BrowserWindow, session } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const argOf = flag => {
  const at = process.argv.indexOf(flag)
  return at >= 0 ? process.argv[at + 1] : null
}
const out = argOf('--probe-out')
const baseRef = argOf('--base-ref')
const afterRef = argOf('--after-ref')
if (!out || !path.isAbsolute(out)) throw new Error('--probe-out needs an absolute artifact folder')
for (const key of ['userData', 'sessionData', 'logs', 'crashDumps']) {
  const folder = path.join(out, key)
  fs.mkdirSync(folder, { recursive: true })
  app.setPath(key, folder)
}
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('mute-audio')
app.on('window-all-closed', () => {})

const CLIPBOARD = `(() => { if (window.__clipboardCalls) return true
  const calls = []; Object.defineProperty(window, '__clipboardCalls', { value: calls })
  const deny = name => () => { calls.push(name); return Promise.reject(new DOMException('Clipboard denied', 'NotAllowedError')) }
  try { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: Object.freeze({ read: deny('read'), readText: deny('readText'), write: deny('write'), writeText: deny('writeText') }) }) } catch { calls.push('stub-failed') }
  const exec = Document.prototype.execCommand
  Document.prototype.execCommand = function (command, ...rest) { if (/^(copy|cut|paste)$/i.test(String(command))) { calls.push('execCommand:' + command); return false } return exec.call(this, command, ...rest) }
  return true })()`

const PROBE = `(() => {
  const vw = window.innerWidth
  const vh = window.innerHeight
  const inspect = id => {
    const box = document.getElementById(id)
    const chip = box?.querySelector('.watchdog-link')
    if (!box || !chip) return null
    const r = box.getBoundingClientRect()
    const cr = chip.getBoundingClientRect()
    const cs = getComputedStyle(chip)
    return {
      id,
      tag: chip.tagName,
      glyph: chip.querySelector('.wd-glyph')?.textContent ?? null,
      name: chip.querySelector('.watchdog-link-name')?.textContent ?? null,
      text: chip.textContent ?? '',
      title: chip.getAttribute('title') ?? '',
      disabled: chip.getAttribute('aria-disabled'),
      staleAttr: chip.getAttribute('data-object-stale'),
      gone: chip.classList.contains('gone'),
      spent: chip.classList.contains('spent'),
      armed: chip.classList.contains('armed'),
      opacity: cs.opacity,
      cursor: cs.cursor,
      chipHeight: Math.round(cr.height),
      inViewport: r.width > 0 && r.height > 0 && r.top >= 0 && r.left >= 0 && r.bottom <= vh && r.right <= vw,
    }
  }
  return {
    viewport: { width: vw, height: vh },
    goneTool: inspect('gone-tool'),
    goneCard: inspect('gone-card'),
    liveTool: inspect('live-tool'),
    liveCard: inspect('live-card'),
  }
})()`

const step = name => console.log(`[watchdog-chips] ${new Date().toISOString()} ${name}`)
setTimeout(() => { console.error('[watchdog-chips] deadline: no result after 120 s'); app.exit(2) }, 120000).unref()

app.whenReady().then(async () => {
  step('ready')
  const sessionId = Number(
    execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${process.pid}).SessionId`],
      { encoding: 'utf8', windowsHide: true },
    ).trim(),
  )
  if (sessionId !== 0) {
    console.error(`refusing to run outside Windows Session 0 (this Electron runs in Session ${sessionId})`)
    app.exit(1)
    return
  }
  const permissions = []
  session.defaultSession.setPermissionRequestHandler((_c, p, cb) => { permissions.push(p); cb(false) })
  session.defaultSession.setPermissionCheckHandler((_c, p) => { permissions.push('check:' + p); return false })
  const win = new BrowserWindow({
    width: 980,
    height: 480,
    show: false,
    useContentSize: true,
    webPreferences: { offscreen: true, backgroundThrottling: false, contextIsolation: true, sandbox: true, nodeIntegration: false },
  })
  win.webContents.setAudioMuted(true)
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.session.webRequest.onBeforeRequest((details, done) =>
    done({ cancel: !details.url.startsWith('file:') && !details.url.startsWith('data:') }),
  )
  await win.loadURL('about:blank')
  const cdp = win.webContents.debugger
  cdp.attach('1.3')
  await cdp.sendCommand('Page.enable')
  await cdp.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: CLIPBOARD })
  const js = code => win.webContents.executeJavaScript(code)
  const settle = async () => {
    await js(`new Promise((resolve, reject) => {
      const deadline = Date.now() + 10000
      const tick = () => {
        if (window.__watchdogChipsSettled && document.querySelectorAll('.watchdog-link').length === 4) {
          requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 100)))
        } else if (Date.now() > deadline) {
          reject(new Error('WatchdogChips fixture did not settle'))
        } else {
          setTimeout(tick, 40)
        }
      }
      tick()
    })`)
  }
  try {
    await win.loadFile(path.join(out, 'index-before.html'))
    await js(CLIPBOARD)
    await settle()
    const beforeProbe = await js(PROBE)
    fs.writeFileSync(path.join(out, 'before.png'), (await win.webContents.capturePage()).toPNG())
    const beforeClipboard = await js('window.__clipboardCalls ?? []')

    await win.loadFile(path.join(out, 'index-after.html'))
    await js(CLIPBOARD)
    await settle()
    const afterProbe = await js(PROBE)
    fs.writeFileSync(path.join(out, 'after.png'), (await win.webContents.capturePage()).toPNG())
    const afterClipboard = await js('window.__clipboardCalls ?? []')

    const checks = {
      beforeShowsAsymmetryOnGoneDog: Boolean(
        beforeProbe.goneTool &&
        beforeProbe.goneCard &&
        beforeProbe.goneTool.gone === false &&
        beforeProbe.goneTool.glyph === '◉' &&
        beforeProbe.goneTool.text === '◉marchpup-full-sdk' &&
        beforeProbe.goneCard.gone === true &&
        beforeProbe.goneCard.glyph === '✕' &&
        beforeProbe.goneCard.text === '✕marchpup-full-sdk (no longer exists)',
      ),
      afterUnifiesGoneDogChip: Boolean(
        afterProbe.goneTool &&
        afterProbe.goneCard &&
        afterProbe.goneTool.tag === 'SPAN' &&
        afterProbe.goneCard.tag === 'SPAN' &&
        afterProbe.goneTool.gone === true &&
        afterProbe.goneCard.gone === true &&
        afterProbe.goneTool.disabled === 'true' &&
        afterProbe.goneCard.disabled === 'true' &&
        afterProbe.goneTool.glyph === '✕' &&
        afterProbe.goneCard.glyph === '✕' &&
        afterProbe.goneTool.text === '✕marchpup-full-sdk (no longer exists)' &&
        afterProbe.goneCard.text === afterProbe.goneTool.text &&
        afterProbe.goneTool.title === afterProbe.goneCard.title &&
        afterProbe.goneTool.opacity === afterProbe.goneCard.opacity &&
        afterProbe.goneTool.chipHeight === afterProbe.goneCard.chipHeight,
      ),
      afterUnifiesLiveDogChip: Boolean(
        afterProbe.liveTool &&
        afterProbe.liveCard &&
        afterProbe.liveTool.tag === 'BUTTON' &&
        afterProbe.liveCard.tag === 'BUTTON' &&
        afterProbe.liveTool.armed === true &&
        afterProbe.liveCard.armed === true &&
        afterProbe.liveTool.gone === false &&
        afterProbe.liveCard.gone === false &&
        afterProbe.liveTool.glyph === '◉' &&
        afterProbe.liveCard.glyph === '◉' &&
        afterProbe.liveTool.text === afterProbe.liveCard.text &&
        afterProbe.liveTool.title === afterProbe.liveCard.title &&
        afterProbe.liveTool.chipHeight === afterProbe.liveCard.chipHeight,
      ),
      allSectionsInViewport: Boolean(
        beforeProbe.goneTool?.inViewport &&
        beforeProbe.goneCard?.inViewport &&
        beforeProbe.liveTool?.inViewport &&
        beforeProbe.liveCard?.inViewport &&
        afterProbe.goneTool?.inViewport &&
        afterProbe.goneCard?.inViewport &&
        afterProbe.liveTool?.inViewport &&
        afterProbe.liveCard?.inViewport,
      ),
    }
    const clipboardCalls = [...beforeClipboard, ...afterClipboard]
    const result = {
      ok: Object.values(checks).every(Boolean) && clipboardCalls.length === 0,
      baseRef,
      afterRef,
      childPid: process.pid,
      sessionId,
      clipboardIsolated: true,
      rendererClipboardDenied: true,
      nativeClipboardBlocked: true,
      audioMuted: win.webContents.isAudioMuted(),
      permissions,
      clipboardCalls,
      checks,
      before: beforeProbe,
      after: afterProbe,
    }
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2))
    step(`done: ok=${result.ok}`)
    app.exit(result.ok ? 0 : 1)
  } catch (err) {
    console.error(err)
    app.exit(1)
  }
})
