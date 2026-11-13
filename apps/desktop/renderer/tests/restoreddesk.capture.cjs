// restoreddesk.capture.cjs — Real Electron + native WM_NCHITTEST verification
// for `.popout-recovery.restored-desk` (@item:orgtree/4-5-13-alpha-1-unity-org-window-stuck-on-a-resto).
//
//   electron.exe restoreddesk.capture.cjs <outDir> <repoRoot> <node_modules dir> <label>
//
// Session 0 ONLY, muted audio, clipboard stubbed and denied, file:/data:/blob:/about:
// requests only, input only via webContents.sendInputEvent to this script's own
// window, WM_NCHITTEST (0x84) read-only against this script's own HWND.
const { app, BrowserWindow, screen, session, clipboard } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const { execFileSync, spawn } = require('node:child_process')

if (process.platform !== 'win32') throw Error('Windows native hit testing is required')
const [outArg, repoArg, depsArg, label = 'run'] = process.argv.slice(2)
const out = path.resolve(outArg, label)
const repo = path.resolve(repoArg)
const deps = path.resolve(depsArg)

const sid = (pid) => Number(execFileSync(
  'powershell.exe',
  ['-NoProfile', '-Command', `(Get-Process -Id ${Number(pid)}).SessionId`],
  { encoding: 'utf8', windowsHide: true },
).trim())
assert.equal(sid(process.pid), 0, 'Session 0 required before creating a window')

fs.mkdirSync(out, { recursive: true })
for (const stale of ['failure.json', 'results.json']) fs.rmSync(path.join(out, stale), { force: true })
app.setPath('userData', path.join(out, 'profile-' + process.pid))
app.setPath('sessionData', path.join(out, 'session-' + process.pid))
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('mute-audio')

let clipboardCalls = 0
for (const k of Object.keys(clipboard)) {
  if (typeof clipboard[k] === 'function') {
    clipboard[k] = () => {
      clipboardCalls++
      return k === 'availableFormats' ? [] : k === 'has' ? false : ''
    }
  }
}

const within = async (p, ms, what) => {
  let t
  try {
    return await Promise.race([
      p,
      new Promise((_r, j) => { t = setTimeout(() => j(Error('Deadline: ' + what)), ms) }),
    ])
  } finally {
    clearTimeout(t)
  }
}

fs.writeFileSync(path.join(out, 'hit.py'), `import ctypes, json, sys
from ctypes import wintypes
user = ctypes.WinDLL('user32', use_last_error=True)
user.SendMessageTimeoutW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM, wintypes.UINT, wintypes.UINT, ctypes.POINTER(ctypes.c_size_t)]
user.SendMessageTimeoutW.restype = wintypes.LPARAM
answer = []
for point in json.loads(sys.argv[2]):
    result = ctypes.c_size_t()
    packed = (int(point['x']) & 65535) | ((int(point['y']) & 65535) << 16)
    if not user.SendMessageTimeoutW(int(sys.argv[1]), 0x84, 0, packed, 2, 2000, ctypes.byref(result)):
        raise ctypes.WinError(ctypes.get_last_error())
    answer.append(result.value)
print(json.dumps(answer))
`)

async function bundle() {
  const esbuild = require(path.join(deps, 'esbuild'))
  let meta
  try {
    const res = await esbuild.build({
      entryPoints: [path.join(repo, 'apps/desktop/renderer/tests/restoreddesk.visual.tsx')],
      outfile: path.join(out, 'probe.js'),
      bundle: true,
      metafile: true,
      format: 'iife',
      platform: 'browser',
      jsx: 'automatic',
      tsconfigRaw: '{}',
      logLevel: 'warning',
      nodePaths: [deps],
      loader: { '.png': 'dataurl', '.svg': 'dataurl', '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl' },
      define: { 'process.env.NODE_ENV': '"production"', __SRC_DIR__: '""' },
    })
    meta = res.metafile
  } finally {
    await esbuild.stop()
  }
  const reactRoots = new Set(
    Object.keys(meta?.inputs ?? {})
      .map((p) => p.replace(/\\/g, '/'))
      .map((p) => /^(.*\/node_modules\/react)\//.exec(p)?.[1])
      .filter(Boolean),
  )
  assert.equal(reactRoots.size, 1, `Expected 1 React root in bundle, got: ${JSON.stringify([...reactRoots])}`)
  fs.writeFileSync(
    path.join(out, 'index.html'),
    '<!doctype html><html lang="en"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\' \'unsafe-inline\' data: blob:;"><link rel="stylesheet" href="probe.css"><body style="margin:0"><div id="root"></div><script src="probe.js"></script></body></html>',
  )
  return [...reactRoots]
}

const READ_DOM = `(() => {
  const rect = (el) => {
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }
  }
  const headerMain = document.querySelector('.shell-header-main')
  const dragMargin = document.querySelector('.canvas-stage > .window-drag-margin')
  const panel = document.querySelector('.popout-recovery.restored-desk')
  const btn = panel ? panel.querySelector('.row button') : null
  const space = document.querySelector('.viewport .space')
  const rawSaved = localStorage.getItem('orgtree-desktop-windows-v1')
  const saved = rawSaved ? JSON.parse(rawSaved) : []
  const canvasComposer = document.querySelector('.desk-over textarea')
  const panelComposer = panel ? panel.querySelector('textarea') : null
  return {
    window: [innerWidth, innerHeight],
    headerMain: rect(headerMain),
    dragMargin: rect(dragMargin),
    panelCount: document.querySelectorAll('.popout-recovery.restored-desk').length,
    panel: rect(panel),
    button: rect(btn),
    buttonText: btn ? btn.textContent.trim() : null,
    spaceTransform: space ? space.style.transform : null,
    saved,
    clicks: (window.__restoredDeskClicks || []).slice(),
    canvasComposerValue: canvasComposer ? canvasComposer.value : null,
    hasCanvasComposer: !!canvasComposer,
    panelComposerValue: panelComposer ? panelComposer.value : null,
    hasPanelComposer: !!panelComposer,
    placeholderText: panel ? ((panel.querySelector('.desk-elsewhere') || {}).textContent || null) : null,
  }
})()`

app.whenReady().then(async () => {
  const errors = []
  let win = null
  let child = null
  try {
    const reactRoots = await bundle()
    const ses = session.fromPartition('restoreddesk-' + process.pid)
    ses.setPermissionCheckHandler(() => false)
    ses.setPermissionRequestHandler((_w, _p, done) => done(false))
    ses.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:|about:)/.test(d.url) }))

    win = new BrowserWindow({
      width: 1180,
      height: 780,
      x: 60,
      y: 60,
      useContentSize: true,
      show: false,
      frame: false,
      webPreferences: {
        session: ses,
        backgroundThrottling: false,
        nodeIntegration: false,
        sandbox: true,
        contextIsolation: true,
      },
    })
    const wc = win.webContents
    wc.setAudioMuted(true)

    wc.setWindowOpenHandler(({ url }) => url && url !== 'about:blank'
      ? { action: 'deny' }
      : {
          action: 'allow',
          overrideBrowserWindowOptions: {
            useContentSize: true,
            show: false,
            frame: false,
            paintWhenInitiallyHidden: true,
            webPreferences: { backgroundThrottling: false },
          },
        })
    wc.on('did-create-window', (w) => {
      child = w
      w.webContents.setAudioMuted(true)
      w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      for (const k of ['copy', 'cut', 'paste', 'pasteAndMatchStyle']) {
        w.webContents[k] = () => { throw Error('Clipboard denied') }
      }
      w.webContents.on('console-message', (_e, level, message) => {
        if (level >= 2) errors.push('popout: ' + message)
      })
    })
    for (const k of ['copy', 'cut', 'paste', 'pasteAndMatchStyle']) {
      wc[k] = () => { throw Error('Clipboard denied') }
    }
    wc.on('console-message', (_e, level, message) => {
      if (level >= 2) errors.push(message)
    })

    const js = (s, gesture = false) => wc.executeJavaScript(s, gesture)
    const pause = (ms) => new Promise((r) => setTimeout(r, ms))
    const settle = () => pause(350)
    const until = async (fn, what, ms = 8000) => {
      const end = Date.now() + ms
      for (;;) {
        if (await fn()) return
        if (Date.now() > end) throw Error('Wait: ' + what)
        await pause(60)
      }
    }
    const readDom = () => js(READ_DOM)

    fs.mkdirSync(path.join(out, 'png'), { recursive: true })
    const shot = async (contents, name) => {
      try {
        await within(
          contents.executeJavaScript('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 150))))'),
          3000,
          'paint ' + name,
        )
      } catch {}
      try {
        const img = await within(contents.capturePage(), 5000, 'capture ' + name)
        const png = img.toPNG()
        fs.writeFileSync(path.join(out, 'png', name + '.png'), png)
        return { bytes: png.length, size: img.getSize() }
      } catch (e) {
        return { error: String(e) }
      }
    }

    const native = win.getNativeWindowHandle()
    const hwnd = native.length === 8 ? native.readBigUInt64LE().toString() : native.readUInt32LE().toString()
    const hitTest = async (clientPoints) => {
      const bounds = win.getContentBounds()
      const screenPts = clientPoints.map((pt) => screen.dipToScreenPoint({
        x: Math.round(bounds.x + pt.x),
        y: Math.round(bounds.y + pt.y),
      }))
      return new Promise((resolve, reject) => {
        const py = spawn(
          process.env.ORGTREE_PROBE_PYTHON || 'python',
          [path.join(out, 'hit.py'), hwnd, JSON.stringify(screenPts)],
          { windowsHide: true },
        )
        let stdout = ''
        let stderr = ''
        py.stdout.on('data', (b) => { stdout += b })
        py.stderr.on('data', (b) => { stderr += b })
        py.on('error', reject)
        py.on('exit', (code) => (code ? reject(Error(stderr || `hit.py exited ${code}`)) : resolve(JSON.parse(stdout))))
      })
    }

    const mouse = (type, x, y, extra = {}) => wc.sendInputEvent({
      type,
      x: Math.round(x),
      y: Math.round(y),
      button: 'left',
      clickCount: 1,
      ...extra,
    })
    const clickAt = async (x, y) => {
      mouse('mouseMove', x, y)
      await pause(30)
      mouse('mouseDown', x, y)
      mouse('mouseUp', x, y)
      await settle()
    }

    const loadScene = async (sceneName) => {
      if (child && !child.isDestroyed()) {
        child.destroy()
      }
      child = null
      await within(
        win.loadFile(path.join(out, 'index.html'), { query: { scene: sceneName }, hash: sceneName }),
        15000,
        'load ' + sceneName,
      )
      win.showInactive()
      await until(async () => {
        const d = await readDom()
        return d.panelCount === 1 && d.headerMain && d.button && d.button.width > 20
      }, 'restored-desk mount in ' + sceneName)
      await until(async () => {
        const d = await readDom()
        const hx = Math.round(d.headerMain.left + 260)
        const hy = Math.round(d.headerMain.top + d.headerMain.height / 2)
        const [ht] = await hitTest([{ x: hx, y: hy }])
        return ht === 2
      }, 'HTCAPTION positive control in ' + sceneName)
      await pause(150)
      return readDom()
    }

    const problems = []
    const steps = { reactRoots }
    const need = (ok, what) => { if (!ok) problems.push(what) }

    // --- 1. Docked restored desk: native WM_NCHITTEST + scroll safety ---
    const d1 = await loadScene('docked')
    steps.dockedInitialPng = await shot(wc, '1-docked-restored-desk')
    const headerPt = {
      x: Math.round(d1.headerMain.left + 260),
      y: Math.round(d1.headerMain.top + d1.headerMain.height / 2),
    }
    const panelTopOverlapPt = {
      x: Math.round(d1.panel.left + 80),
      y: Math.round(Math.max(d1.panel.top + 2, Math.min(d1.dragMargin.bottom - 2, d1.panel.top + 5))),
    }
    const btnTopPt = {
      x: Math.round(d1.button.left + d1.button.width / 2),
      y: Math.round(d1.button.top + 2),
    }
    const btnMidPt = {
      x: Math.round(d1.button.left + d1.button.width / 2),
      y: Math.round(d1.button.top + d1.button.height / 2),
    }
    const [htHeader, htPanelOverlap, htBtnTop, htBtnMid] = await hitTest([
      headerPt,
      panelTopOverlapPt,
      btnTopPt,
      btnMidPt,
    ])
    steps.dockedHit = {
      geometry: { headerMain: d1.headerMain, dragMargin: d1.dragMargin, panel: d1.panel, button: d1.button },
      points: { headerPt, panelTopOverlapPt, btnTopPt, btnMidPt },
      results: { htHeader, htPanelOverlap, htBtnTop, htBtnMid },
    }
    need(htHeader === 2, `positive control: shell header empty stretch expected HTCAPTION (2), got ${htHeader}`)
    need(htPanelOverlap === 1, `docked .restored-desk top strip over .window-drag-margin expected HTCLIENT (1), got ${htPanelOverlap}`)
    need(htBtnTop === 1, `docked "Return to canvas" top edge expected HTCLIENT (1), got ${htBtnTop}`)
    need(htBtnMid === 1, `docked "Return to canvas" center expected HTCLIENT (1), got ${htBtnMid}`)

    // Scroll content inside .restored-desk above the window top and confirm the title bar above stays HTCAPTION (2)
    await js(`(() => {
      const msgs = document.querySelector('.popout-recovery.restored-desk .msgs')
      if (msgs) {
        const tall = document.createElement('div')
        tall.style.height = '1400px'
        tall.textContent = 'tall transcript filler'
        msgs.appendChild(tall)
        msgs.scrollTop = 320
      }
      const panel = document.querySelector('.popout-recovery.restored-desk')
      if (panel) panel.scrollTop = 120
    })()`)
    await pause(250)
    const [htHeaderAfterScroll] = await hitTest([headerPt])
    steps.headerAfterScrollHit = htHeaderAfterScroll
    need(htHeaderAfterScroll === 2, `scrolling .restored-desk must not block .shell-header drag (expected 2, got ${htHeaderAfterScroll})`)

    // --- 2. Docked wheel carve-out + real click on "Return to canvas" ---
    const beforeWheel = await readDom()
    wc.sendInputEvent({
      type: 'mouseWheel',
      x: Math.round(beforeWheel.panel.left + 120),
      y: Math.round(beforeWheel.panel.top + 160),
      deltaX: 0,
      deltaY: -120,
      wheelTicksX: 0,
      wheelTicksY: -1,
      canScroll: true,
    })
    await settle()
    const afterWheel = await readDom()
    steps.wheel = { before: beforeWheel.spaceTransform, after: afterWheel.spaceTransform }
    need(
      beforeWheel.spaceTransform === afterWheel.spaceTransform,
      `wheel inside .restored-desk zoomed the canvas underneath (${beforeWheel.spaceTransform} -> ${afterWheel.spaceTransform})`,
    )

    if (afterWheel.hasPanelComposer) {
      const taBox = await js(`(() => {
        const r = document.querySelector('.popout-recovery.restored-desk textarea').getBoundingClientRect()
        return [r.left + r.width / 2, r.top + r.height / 2]
      })()`)
      await clickAt(taBox[0], taBox[1])
      await wc.insertText('draft-in-restored-desk')
      await pause(120)
    }

    await js('window.__restoredDeskClicks.length = 0')
    const preClick = await readDom()
    // Click the lower half of "Return to canvas" (below .window-drag-margin) so even when HTCAPTION is not hit,
    // .viewport pointer capture is directly tested by real Chromium mouseDown/mouseUp input.
    const safeBtnClickY = Math.round(Math.max(
      preClick.button.top + preClick.button.height / 2,
      Math.min(preClick.button.bottom - 2, preClick.dragMargin.bottom + 4),
    ))
    const safeBtnClickX = Math.round(preClick.button.left + preClick.button.width / 2)
    await clickAt(safeBtnClickX, safeBtnClickY)
    await pause(550)
    const afterDockedClick = await readDom()
    steps.dockedClick = {
      at: { x: safeBtnClickX, y: safeBtnClickY },
      clicks: afterDockedClick.clicks,
      panelCount: afterDockedClick.panelCount,
      saved: afterDockedClick.saved,
      hasCanvasComposer: afterDockedClick.hasCanvasComposer,
      canvasComposerValue: afterDockedClick.canvasComposerValue,
    }
    steps.dockedAfterPng = await shot(wc, '2-docked-after-return')
    const firstClickTag = afterDockedClick.clicks[0]?.tag ?? 'NONE'
    need(
      firstClickTag === 'BUTTON',
      `real click on "Return to canvas" did not land on BUTTON (got ${firstClickTag} class=${JSON.stringify(afterDockedClick.clicks[0]?.className ?? '')})`,
    )
    need(afterDockedClick.panelCount === 0, `docked .restored-desk stayed stuck on screen (panelCount=${afterDockedClick.panelCount})`)
    need(
      afterDockedClick.saved.length === 1 && afterDockedClick.saved[0].open === false,
      `docked Return to canvas left saved window row open: ${JSON.stringify(afterDockedClick.saved)}`,
    )
    need(
      afterDockedClick.hasCanvasComposer && afterDockedClick.canvasComposerValue === 'draft-in-restored-desk',
      `docked Return to canvas did not focus ascii-pup on canvas with preserved draft (has=${afterDockedClick.hasCanvasComposer}, val=${JSON.stringify(afterDockedClick.canvasComposerValue)})`,
    )

    // --- 3. Wrapped header: "Return to canvas" completely overlapped by .shell-header-main drag region ---
    const dWrapped = await loadScene('wrapped')
    const wrappedBtnPt = {
      x: Math.round(dWrapped.button.left + dWrapped.button.width / 2),
      y: Math.round(dWrapped.button.top + dWrapped.button.height / 2),
    }
    const [htWrappedBtn] = await hitTest([wrappedBtnPt])
    await clickAt(wrappedBtnPt.x, wrappedBtnPt.y)
    await pause(450)
    const afterWrappedClick = await readDom()
    steps.wrapped = {
      headerMain: dWrapped.headerMain,
      button: dWrapped.button,
      htWrappedBtn,
      panelCountAfterClick: afterWrappedClick.panelCount,
    }
    need(htWrappedBtn === 1, `wrapped-header "Return to canvas" center expected HTCLIENT (1), got ${htWrappedBtn}`)
    need(afterWrappedClick.panelCount === 0, `wrapped-header click did not close .restored-desk (panelCount=${afterWrappedClick.panelCount})`)

    // --- 4. Detached popout window: "Return to canvas" redocks child window and focuses canvas ---
    await loadScene('detached')
    await until(() => !!child && !child.isDestroyed(), 'detached popout child window')
    await until(
      () => child.webContents.executeJavaScript("!!document.querySelector('textarea')", true),
      'composer inside detached popout window',
    )
    await child.webContents.executeJavaScript(`(() => {
      const ta = document.querySelector('textarea')
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(ta), 'value').set
      setter.call(ta, 'detached-draft')
      ta.dispatchEvent(new Event('input', { bubbles: true }))
    })()`, true)
    await pause(200)
    const dDetached = await readDom()
    const detBtnPt = {
      x: Math.round(dDetached.button.left + dDetached.button.width / 2),
      y: Math.round(Math.max(dDetached.button.top + dDetached.button.height / 2, dDetached.dragMargin.bottom + 4)),
    }
    await clickAt(detBtnPt.x, detBtnPt.y)
    await pause(600)
    const afterDetachedClick = await readDom()
    const childClosed = !child || child.isDestroyed()
    steps.detached = {
      childClosed,
      panelCount: afterDetachedClick.panelCount,
      saved: afterDetachedClick.saved,
      hasCanvasComposer: afterDetachedClick.hasCanvasComposer,
      canvasComposerValue: afterDetachedClick.canvasComposerValue,
    }
    steps.detachedAfterPng = await shot(wc, '3-detached-after-return')
    need(childClosed, 'detached Return to canvas left the popped-out child BrowserWindow open')
    need(afterDetachedClick.panelCount === 0, `detached Return to canvas left .restored-desk mounted (panelCount=${afterDetachedClick.panelCount})`)
    need(
      afterDetachedClick.saved.length === 1 && afterDetachedClick.saved[0].open === false,
      `detached Return to canvas left saved window row open: ${JSON.stringify(afterDetachedClick.saved)}`,
    )
    need(
      afterDetachedClick.hasCanvasComposer && afterDetachedClick.canvasComposerValue === 'detached-draft',
      `detached Return to canvas did not return detached-draft to focused canvas desk (has=${afterDetachedClick.hasCanvasComposer}, val=${JSON.stringify(afterDetachedClick.canvasComposerValue)})`,
    )

    const result = {
      label,
      status: problems.length ? 'FAIL' : 'PASS',
      problems,
      steps,
      sessionId: sid(process.pid),
      rendererSessionId: sid(wc.getOSProcessId()),
      muted: wc.isAudioMuted() && (!child || child.isDestroyed() || child.webContents.isAudioMuted()),
      clipboardCalls,
      errors,
    }
    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(result, null, 2))
    console.log(`${result.status}: ${problems.length} problems`)
    for (const p of problems) console.log('  - ' + p)
    if (child && !child.isDestroyed()) child.destroy()
    win.destroy()
    app.exit(problems.length ? 1 : 0)
  } catch (e) {
    console.error(e)
    try {
      fs.writeFileSync(path.join(out, 'failure.json'), JSON.stringify({ error: String(e), stack: e?.stack, errors }, null, 2))
    } catch {}
    if (child && !child.isDestroyed()) child.destroy()
    if (win && !win.isDestroyed()) win.destroy()
    app.exit(2)
  }
}).catch((e) => {
  console.error(e)
  app.exit(2)
})
