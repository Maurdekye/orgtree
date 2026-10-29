// Session 0 Electron capture runner for `tools/rig/usage-retained-visual.mjs`.
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
  const cards = [...document.querySelectorAll('.usage-acct')].map(el => {
    const r = el.getBoundingClientRect()
    const who = (el.querySelector('.usage-acct-who')?.textContent || '').trim()
    const updated = el.querySelector('.usage-updated')?.textContent?.trim() || null
    const refreshError = el.querySelector('.usage-refresh-error')?.textContent?.trim() || null
    const alerts = [...el.querySelectorAll('[role="alert"]')].map(a => (a.textContent || '').trim())
    const tracks = el.querySelectorAll('.usage-track').length
    const rows = [...el.querySelectorAll('.usage-row')].map(row => ({
      label: row.querySelector('.u-label')?.textContent?.trim() || '',
      reset: row.querySelector('.u-reset')?.textContent?.trim() || '',
      pct: row.querySelector('.u-pct')?.textContent?.trim() || null,
      hasBar: Boolean(row.querySelector('.usage-track')),
    }))
    return {
      account: el.getAttribute('data-account') || who,
      who,
      updated,
      refreshError,
      alerts,
      tracks,
      rows,
      inViewport: r.width > 0 && r.height > 0 && r.top >= 0 && r.left >= 0 && r.bottom <= vh && r.right <= vw,
    }
  })
  return {
    viewport: { width: vw, height: vh },
    totalTracks: document.querySelectorAll('.usage-track').length,
    cardCount: cards.length,
    cards,
  }
})()`

const step = name => console.log(`[usage-retained] ${new Date().toISOString()} ${name}`)
setTimeout(() => { console.error('[usage-retained] deadline: no result after 120 s'); app.exit(2) }, 120000).unref()

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
    width: 1024,
    height: 768,
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
        if (window.__usageRetainedSettled && document.querySelectorAll('.usage-acct').length === 4) {
          requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 100)))
        } else if (Date.now() > deadline) {
          reject(new Error('UsageModal did not settle'))
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

    const claudePrimaryAfter = afterProbe.cards.find(c => c.who.includes('claude@example.test'))
    const claude5After = afterProbe.cards.find(c => c.account === 'claude-5')
    const codexAfter = afterProbe.cards.find(c => c.who.includes('codex@example.test'))
    const agyAfter = afterProbe.cards.find(c => c.who.includes('agy@example.test'))

    const checks = {
      beforeIsAuthenticBase: beforeProbe.cardCount === 4 && beforeProbe.totalTracks === 0,
      afterRetainsAllBars: afterProbe.cardCount === 4 && afterProbe.totalTracks === 6,
      allCardsInViewport:
        beforeProbe.cards.every(c => c.inViewport) &&
        afterProbe.cards.every(c => c.inViewport),
      claudePrimaryShowsBarsAgeAndAlert: Boolean(
        claudePrimaryAfter &&
        claudePrimaryAfter.tracks === 2 &&
        claudePrimaryAfter.updated === 'updated 8m ago' &&
        claudePrimaryAfter.alerts.some(a => a.includes('usage updates paused; next retry in 120 s')),
      ),
      passedResetShowsAwaitingReadingAndHidesOldPct: Boolean(
        claude5After &&
        claude5After.tracks === 1 &&
        claude5After.updated === 'updated 25m ago' &&
        claude5After.rows[0]?.reset === 'reset; awaiting reading' &&
        claude5After.rows[0]?.pct === null &&
        !claude5After.rows[0]?.hasBar &&
        claude5After.rows[1]?.pct === '52%' &&
        claude5After.rows[1]?.hasBar,
      ),
      siblingProvidersRetainBarsAndAge: Boolean(
        codexAfter &&
        codexAfter.tracks === 1 &&
        codexAfter.updated === 'updated 6m ago' &&
        codexAfter.alerts.some(a => a.includes('HTTPS 503 Service Unavailable')) &&
        agyAfter &&
        agyAfter.tracks === 2 &&
        agyAfter.updated === 'updated 12m ago' &&
        agyAfter.alerts.some(a => a.includes('Antigravity usage is not available right now')),
      ),
    }
    const clipboardCalls = [...beforeClipboard, ...afterClipboard]
    const result = {
      ok: Object.values(checks).every(Boolean) && clipboardCalls.length === 0,
      baseRef,
      afterRef,
      sessionId,
      audioMuted: win.webContents.isAudioMuted(),
      permissions,
      clipboardCalls,
      checks,
      before: beforeProbe,
      after: afterProbe,
    }
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2))
    step(`done: ok=${result.ok} beforeTracks=${beforeProbe.totalTracks} afterTracks=${afterProbe.totalTracks}`)
    app.exit(result.ok ? 0 : 1)
  } catch (err) {
    console.error(err)
    app.exit(1)
  }
})
