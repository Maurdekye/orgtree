// Session 0 Electron capture runner for `tools/rig/letterchips-visual.mjs`.
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
  const groupSpec = [
    ['1-hire-tokens', '.hsof button:not(.hs-none):not(.project-token)'],
    ['2-desk-model-letter', '.tier:not(.quickchat-user-mark)'],
    ['3-node-model-letters', '.tier:not(.quickchat-user-mark)'],
    ['4-tier-pickers', '.tier:not(.quickchat-user-mark), .hsof button:not(.hs-none):not(.project-token)'],
    ['5-initials-avatars', '.org-logo-avatar'],
  ]
  const vw = window.innerWidth
  const vh = window.innerHeight
  const groups = []
  const groupRects = []
  const chips = []
  for (const [group, sel] of groupSpec) {
    const root = document.querySelector('[data-surface-group="' + group + '"]')
    if (!root) continue
    groups.push(group)
    const gr = root.getBoundingClientRect()
    groupRects.push({
      group,
      top: +gr.top.toFixed(2),
      left: +gr.left.toFixed(2),
      bottom: +gr.bottom.toFixed(2),
      right: +gr.right.toFixed(2),
      width: +gr.width.toFixed(2),
      height: +gr.height.toFixed(2),
      inViewport: gr.top >= 0 && gr.left >= 0 && gr.bottom <= vh && gr.right <= vw && gr.width > 0 && gr.height > 0,
    })
    for (const el of root.querySelectorAll(sel)) {
      const cs = getComputedStyle(el)
      const r = el.getBoundingClientRect()
      const range = document.createRange()
      range.selectNodeContents(el)
      const tr = range.getBoundingClientRect()
      chips.push({
        group,
        tag: el.tagName,
        className: el.className,
        hasLetterChipClass: el.classList.contains('letter-chip'),
        text: (el.textContent || '').trim(),
        display: cs.display,
        alignItems: cs.alignItems,
        justifyContent: cs.justifyContent,
        lineHeight: cs.lineHeight,
        paddingTop: cs.paddingTop,
        paddingBottom: cs.paddingBottom,
        paddingLeft: cs.paddingLeft,
        paddingRight: cs.paddingRight,
        fontSize: cs.fontSize,
        fontWeight: cs.fontWeight,
        color: cs.color,
        textAlign: cs.textAlign,
        letterSpacing: cs.letterSpacing,
        width: +r.width.toFixed(2),
        height: +r.height.toFixed(2),
        inViewport: r.top >= 0 && r.left >= 0 && r.bottom <= vh && r.right <= vw && r.width > 0 && r.height > 0,
        centerOffsetX: +(tr.left + tr.width / 2 - (r.left + r.width / 2)).toFixed(2),
        centerOffsetY: +(tr.top + tr.height / 2 - (r.top + r.height / 2)).toFixed(2),
      })
    }
  }
  return { viewport: { width: vw, height: vh }, groups, groupRects, count: chips.length, chips }
})()`

const step = name => console.log(`[letterchips] ${new Date().toISOString()} ${name}`)
setTimeout(() => { console.error('[letterchips] deadline: no result after 120 s'); app.exit(2) }, 120000).unref()

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
    width: 1160,
    height: 860,
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
  const waitAvatar = () =>
    js(`new Promise((resolve, reject) => {
      const ok = () => document.querySelector('.org-logo-avatar')?.textContent === 'OT'
      if (ok()) { resolve(true); return }
      const obs = new MutationObserver(() => { if (ok()) { obs.disconnect(); clearTimeout(t); resolve(true) } })
      obs.observe(document.body, { childList: true, subtree: true, characterData: true })
      const t = setTimeout(() => { obs.disconnect(); reject(new Error('org-logo-avatar did not settle to OT')) }, 10000)
    })`)
  const settle = async () => {
    await waitAvatar()
    await new Promise(resolve => setTimeout(resolve, 200))
    await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(r,120))))')
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

    const expectedGroups = [
      '1-hire-tokens',
      '2-desk-model-letter',
      '3-node-model-letters',
      '4-tier-pickers',
      '5-initials-avatars',
    ]
    const allGroupsPresent =
      expectedGroups.every(
        g =>
          beforeProbe.groups.includes(g) &&
          afterProbe.groups.includes(g) &&
          beforeProbe.groupRects.some(gr => gr.group === g && gr.inViewport) &&
          afterProbe.groupRects.some(gr => gr.group === g && gr.inViewport) &&
          beforeProbe.chips.some(c => c.group === g && c.width > 0 && c.height > 0 && c.inViewport) &&
          afterProbe.chips.some(c => c.group === g && c.width > 0 && c.height > 0 && c.inViewport),
      ) &&
      beforeProbe.chips.every(c => c.inViewport) &&
      afterProbe.chips.every(c => c.inViewport)
    const beforeIsAuthenticBase =
      beforeProbe.count >= 15 &&
      beforeProbe.chips.every(c => c.hasLetterChipClass === false) &&
      beforeProbe.chips.some(c => c.group === '1-hire-tokens' && (c.display === 'inline-block' || c.display === 'block')) &&
      beforeProbe.chips.some(c => c.group === '3-node-model-letters' && (c.display === 'grid' || c.display === 'inline-grid'))
    const afterAllCentred =
      afterProbe.count === beforeProbe.count &&
      afterProbe.chips.every(
        c =>
          c.hasLetterChipClass === true &&
          (c.display === 'inline-flex' || c.display === 'flex') &&
          c.alignItems === 'center' &&
          c.justifyContent === 'center' &&
          c.paddingTop === '0px' &&
          c.paddingBottom === '0px' &&
          c.paddingLeft === '0px' &&
          c.paddingRight === '0px' &&
          c.textAlign === 'center' &&
          c.width > 0 &&
          c.height > 0,
      )
    const stylePreserved =
      afterProbe.count === beforeProbe.count &&
      afterProbe.chips.every((c, i) => {
        const b = beforeProbe.chips[i]
        return (
          b &&
          c.group === b.group &&
          c.text === b.text &&
          c.fontSize === b.fontSize &&
          c.fontWeight === b.fontWeight &&
          c.color === b.color &&
          c.width === b.width &&
          c.height === b.height
        )
      })
    const clipboardCalls = [...beforeClipboard, ...afterClipboard]
    const result = {
      ok: allGroupsPresent && beforeIsAuthenticBase && afterAllCentred && stylePreserved && clipboardCalls.length === 0,
      baseRef,
      afterRef,
      sessionId,
      audioMuted: win.webContents.isAudioMuted(),
      permissions,
      clipboardCalls,
      allGroupsPresent,
      beforeIsAuthenticBase,
      afterAllCentred,
      stylePreserved,
      before: beforeProbe,
      after: afterProbe,
    }
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2))
    step(
      `done: ok=${result.ok} groups=${afterProbe.groups.length} chips=${afterProbe.count} authenticBase=${beforeIsAuthenticBase} stylePreserved=${stylePreserved}`,
    )
    app.exit(result.ok ? 0 : 1)
  } catch (err) {
    console.error(err)
    app.exit(1)
  }
})
