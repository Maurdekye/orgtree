// nativepicker.capture.cjs — Session 0 Electron verification & visual capture
// for @item:orgtree/agent-settings-use-the-operating-system-s-native.
//
//   electron.exe nativepicker.capture.cjs <outDir> <repoRoot> <node_modules dir> [label]
//
// Session 0 ONLY (asserted before any window is created), muted audio, clipboard
// stubbed and denied in both main and renderer, file:/data:/blob:/about: only,
// input strictly via webContents.sendInputEvent to this process's own BrowserWindow,
// and any native #32770 dialog inspection/WM_CLOSE strictly restricted to windows
// whose GetWindowThreadProcessId equals this Electron process's own PID.
const { app, BrowserWindow, Menu, clipboard, dialog, ipcMain, nativeImage, session } = require('electron')
const assert = require('node:assert/strict')
const { execFileSync, spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

if (process.platform !== 'win32') throw new Error('Windows Session 0 required')
const rawArgs = process.argv.slice(2)
const probeOsDialog = rawArgs.includes('--probe-os-dialog')
const [outArg, repoArg, depsArg, label = 'green'] = rawArgs.filter((a) => a !== '--probe-os-dialog')
const out = path.resolve(outArg, label)
const pngDir = path.join(out, 'png')
const repo = path.resolve(repoArg)
const deps = path.resolve(depsArg)

const sid = (pid) =>
  Number(
    execFileSync(
      'powershell.exe',
      ['-NoProfile', '-Command', `(Get-Process -Id ${Number(pid)}).SessionId`],
      { encoding: 'utf8', windowsHide: true },
    ).trim(),
  )
const mySessionId = sid(process.pid)
assert.equal(mySessionId, 0, 'Session 0 required before creating any window')

const resultFileName = probeOsDialog ? 'results-os-probe.json' : 'results.json'
fs.mkdirSync(pngDir, { recursive: true })
for (const stale of ['failure.json', resultFileName]) fs.rmSync(path.join(out, stale), { force: true })

const seedAgentDir = path.join(out, 'seed-agent-dir')
const seedHireDir = path.join(out, 'seed-hire-dir')
fs.mkdirSync(seedAgentDir, { recursive: true })
fs.mkdirSync(seedHireDir, { recursive: true })

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
      new Promise((_r, j) => {
        t = setTimeout(() => j(new Error('Deadline: ' + what)), ms)
      }),
    ])
  } finally {
    clearTimeout(t)
  }
}

// Helper strictly scoped to targetPid: inspects whether Electron's dialog.showOpenDialog
// creates an owned #32770 dialog HWND in Session 0, captures it via PrintWindow if created,
// and closes ONLY that targetPid #32770 HWND via PostMessageW(WM_CLOSE).
// The probe is the test-only tools/test-native helper (`owned-dialog`; it was an inline hwnd_probe.py).
const testNative = process.env.ORGTREE_TEST_NATIVE || path.join(repo, 'tools', 'test-native', 'target', 'debug', 'orgtree-test-native.exe')
if (!fs.existsSync(testNative)) throw Error('orgtree-test-native.exe is not built: cargo build --manifest-path tools/test-native/Cargo.toml, or set ORGTREE_TEST_NATIVE')

async function bundleAssets() {
  const esbuild = require(path.join(deps, 'esbuild'))
  let meta
  try {
    const res = await esbuild.build({
      entryPoints: [path.join(repo, 'apps/desktop/renderer/tests/nativepicker.visual.tsx')],
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

    await esbuild.build({
      entryPoints: [path.join(repo, 'apps/desktop/main/folder-picker.ts')],
      outfile: path.join(out, 'folder-picker.cjs'),
      bundle: true,
      format: 'cjs',
      platform: 'node',
      tsconfigRaw: '{}',
      logLevel: 'warning',
    })
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
    path.join(out, 'capture-preload.cjs'),
    `const { contextBridge, ipcRenderer } = require('electron')
Object.defineProperty(navigator, 'clipboard', {
  configurable: false,
  value: {
    readText: () => Promise.reject(new Error('Clipboard blocked in isolated capture')),
    writeText: () => Promise.reject(new Error('Clipboard blocked in isolated capture')),
    read: () => Promise.reject(new Error('Clipboard blocked in isolated capture')),
    write: () => Promise.reject(new Error('Clipboard blocked in isolated capture')),
  },
})
document.execCommand = () => false
contextBridge.exposeInMainWorld('orgtreeDesktop', {
  pickFolder: async (defaultPath, popoutName) => {
    const res = await ipcRenderer.invoke(
      'desktop:pick-folder',
      typeof defaultPath === 'string' && defaultPath ? defaultPath : null,
      typeof popoutName === 'string' && popoutName ? popoutName : null,
    )
    if (res && typeof res === 'object' && res.remote) {
      throw Object.assign(new Error(String(res.error || 'Remote organization')), { remote: true })
    }
    return typeof res === 'string' && res ? res : null
  },
})
`,
    'utf8',
  )

  fs.writeFileSync(
    path.join(out, 'index.html'),
    '<!doctype html><html lang="en"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\' \'unsafe-inline\' data: blob:;"><link rel="stylesheet" href="probe.css"><body style="margin:0"><div id="root"></div><script src="probe.js"></script></body></html>',
    'utf8',
  )
  return [...reactRoots]
}

async function waitPaint(win, ms = 90) {
  await win.webContents.executeJavaScript(
    `new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, ${Number(ms)}))))`,
  )
}

async function saveShot(win, fileName) {
  await waitPaint(win, 90)
  const img = await win.webContents.capturePage()
  const dest = path.join(pngDir, fileName)
  fs.writeFileSync(dest, img.toPNG())
  return { file: dest, size: img.getSize() }
}

async function clickAt(win, x, y) {
  win.webContents.sendInputEvent({ type: 'mouseMove', x, y })
  win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
  win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
  await waitPaint(win, 120)
}

function probeRealOsDialog(ownerHwndInt, bmpFile, pngFile) {
  return new Promise((resolve) => {
    const child = spawn(testNative, ['owned-dialog', String(process.pid), String(ownerHwndInt), bmpFile], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d.toString('utf8') })
    child.stderr.on('data', (d) => { stderr += d.toString('utf8') })
    child.on('close', (code) => {
      let parsed
      try {
        parsed = JSON.parse(stdout.trim())
      } catch {
        parsed = { hwndCreated: false, parseError: stdout.trim(), stderr: stderr.trim(), exitCode: code }
      }
      if (parsed?.capture?.captured && fs.existsSync(bmpFile)) {
        const img = nativeImage.createFromPath(bmpFile)
        if (!img.isEmpty()) {
          fs.writeFileSync(pngFile, img.toPNG())
          parsed.capture.pngFile = pngFile
        }
        fs.rmSync(bmpFile, { force: true })
      }
      resolve(parsed)
    })
  })
}

async function main() {
  const problems = []
  let win
  try {
    const reactRoots = await bundleAssets()
    const { pickNativeFolder } = require(path.join(out, 'folder-picker.cjs'))

    Menu.setApplicationMenu(null)
    session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
    session.defaultSession.setPermissionCheckHandler(() => false)
    session.defaultSession.webRequest.onBeforeRequest((details, cb) => {
      const ok = /^(file:|data:|blob:|about:)/.test(details.url)
      cb({ cancel: !ok })
    })

    let mode = 'spy'
    let spyReturn = null
    const ipcCalls = []
    ipcMain.handle('desktop:pick-folder', async (_event, defaultPath, popoutName) => {
      const entry = { mode, defaultPath, popoutName, options: null, parentMatchesWin: false }
      ipcCalls.push(entry)
      if (mode === 'real-os-dialog') {
        const realApi = {
          showOpenDialog(parent, options) {
            entry.parentMatchesWin = parent === win
            entry.options = options
            return dialog.showOpenDialog(parent, options)
          },
        }
        return pickNativeFolder(realApi, win, undefined, defaultPath)
      }
      const spyApi = {
        async showOpenDialog(parent, options) {
          entry.parentMatchesWin = parent === win
          entry.options = options
          return spyReturn
        },
      }
      return pickNativeFolder(spyApi, win, undefined, defaultPath)
    })

    win = new BrowserWindow({
      width: 1100,
      height: 780,
      show: true,
      paintWhenInitiallyHidden: true,
      backgroundColor: '#11161d',
      webPreferences: {
        preload: path.join(out, 'capture-preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        backgroundThrottling: false,
      },
    })
    win.webContents.setAudioMuted(true)
    const hwndBuf = win.getNativeWindowHandle()
    const ownerHwndInt = Number(hwndBuf.length >= 8 ? hwndBuf.readBigUInt64LE(0) : hwndBuf.readUInt32LE(0))

    await within(win.loadFile(path.join(out, 'index.html')), 15000, 'load visual index.html')
    await waitPaint(win, 150)

    const rendererClipboardBlocked = await win.webContents.executeJavaScript(
      `navigator.clipboard.readText().then(() => false, () => true)`,
    )
    if (!rendererClipboardBlocked) problems.push('renderer clipboard was not blocked')

    // === SCENE 1: Local org — Agent settings (NodeConfig Scope > Folders) ===
    await win.webContents.executeJavaScript(
      `window.__pickerVisual.setScene('local-agent').then(() => window.__pickerVisual.setInput(${JSON.stringify(seedAgentDir)}))`,
    )
    await waitPaint(win, 120)
    const s1Before = await win.webContents.executeJavaScript(`window.__pickerVisual.state()`)
    if (!s1Before.hitBrowse || !s1Before.browseRect) problems.push('Scene 1 Browse button not hit-testable')
    const shot1Before = await saveShot(win, '01-local-agent-settings-before.png')

    let agentOsDialogProbe = null
    if (probeOsDialog) {
      mode = 'real-os-dialog'
      const agentProbePromise = probeRealOsDialog(
        ownerHwndInt,
        path.join(out, 'tmp-agent-hwnd.bmp'),
        path.join(pngDir, '01b-local-agent-native-os-dialog-session0.png'),
      )
      const clickRealAgentPromise = clickAt(win, s1Before.browseRect.cx, s1Before.browseRect.cy)
      agentOsDialogProbe = await within(agentProbePromise, 6000, 'Session 0 OS dialog probe (agent settings)')
      await within(clickRealAgentPromise, 5000, 'settle click after Session 0 OS dialog close')
    }

    // Controlled native dialog selection -> verify RW grant added in Agent settings:
    mode = 'spy'
    const pickedAgentDir = 'S:\\orgtree\\native-agent-grant'
    spyReturn = { canceled: false, filePaths: [pickedAgentDir] }
    await clickAt(win, s1Before.browseRect.cx, s1Before.browseRect.cy)
    const s1After = await win.webContents.executeJavaScript(`window.__pickerVisual.state()`)
    const shot1After = await saveShot(win, '01-local-agent-settings-picked.png')

    if (s1After.hasCustomOverlay || s1After.fsRequests.length > 0) {
      problems.push('Local agent settings opened custom /api/fs picker instead of native picker')
    }
    if (!s1After.chips.includes(pickedAgentDir)) {
      problems.push(`Local agent settings did not add ${pickedAgentDir}: got ${JSON.stringify(s1After.chips)}`)
    }

    // === SCENE 2: Local org — Hire dialog (DraftScopeModal Scope > Folders) ===
    await win.webContents.executeJavaScript(
      `window.__pickerVisual.setScene('local-hire').then(() => window.__pickerVisual.setInput(${JSON.stringify(seedHireDir)}))`,
    )
    await waitPaint(win, 120)
    const s2Before = await win.webContents.executeJavaScript(`window.__pickerVisual.state()`)
    if (!s2Before.hitBrowse || !s2Before.browseRect) problems.push('Scene 2 Hire Browse button not hit-testable')
    const shot2Before = await saveShot(win, '02-local-hire-dialog-before.png')

    let hireOsDialogProbe = null
    if (probeOsDialog) {
      mode = 'real-os-dialog'
      const hireProbePromise = probeRealOsDialog(
        ownerHwndInt,
        path.join(out, 'tmp-hire-hwnd.bmp'),
        path.join(pngDir, '02b-local-hire-native-os-dialog-session0.png'),
      )
      const clickRealHirePromise = clickAt(win, s2Before.browseRect.cx, s2Before.browseRect.cy)
      hireOsDialogProbe = await within(hireProbePromise, 6000, 'Session 0 OS dialog probe (hire dialog)')
      await within(clickRealHirePromise, 5000, 'settle click after Session 0 Hire OS dialog close')
    }

    // Controlled native dialog selection -> verify RW grant staged in Hire dialog:
    mode = 'spy'
    const pickedHireDir = 'S:\\orgtree\\native-hire-grant'
    spyReturn = { canceled: false, filePaths: [pickedHireDir] }
    await clickAt(win, s2Before.browseRect.cx, s2Before.browseRect.cy)
    const s2After = await win.webContents.executeJavaScript(`window.__pickerVisual.state()`)
    const shot2After = await saveShot(win, '02-local-hire-dialog-picked.png')

    if (s2After.hasCustomOverlay || s2After.fsRequests.length > 0) {
      problems.push('Local hire dialog opened custom /api/fs picker instead of native picker')
    }
    if (!s2After.chips.includes(pickedHireDir)) {
      problems.push(`Local hire dialog did not add ${pickedHireDir}: got ${JSON.stringify(s2After.chips)}`)
    }

    // === SCENE 3: Remote org ("Galaxy") — custom /api/fs folder picker ===
    const ipcCountBeforeRemote = ipcCalls.length
    await win.webContents.executeJavaScript(`window.__pickerVisual.setScene('remote-agent')`)
    await waitPaint(win, 120)
    const s3Before = await win.webContents.executeJavaScript(`window.__pickerVisual.state()`)
    if (!s3Before.hitBrowse || !s3Before.browseRect) problems.push('Scene 3 Remote Browse button not hit-testable')

    await clickAt(win, s3Before.browseRect.cx, s3Before.browseRect.cy)
    await waitPaint(win, 150)
    const s3After = await win.webContents.executeJavaScript(`window.__pickerVisual.state()`)
    const shot3Remote = await saveShot(win, '03-remote-org-custom-picker.png')

    if (ipcCalls.length !== ipcCountBeforeRemote) {
      problems.push(`Remote org invoked native desktop:pick-folder IPC (${ipcCalls.length - ipcCountBeforeRemote} calls)`)
    }
    if (!s3After.hasCustomOverlay || s3After.pickerHeading !== 'choose a folder on Galaxy') {
      problems.push(`Remote org custom picker heading mismatch: ${JSON.stringify(s3After.pickerHeading)}`)
    }
    if (s3After.fsRequests.length === 0) {
      problems.push('Remote org custom picker did not request /api/fs')
    }

    // Check options passed to pickNativeFolder in Scenes 1 & 2:
    const expectedSeeds = probeOsDialog
      ? [
          path.normalize(seedAgentDir),
          path.normalize(seedAgentDir),
          path.normalize(seedHireDir),
          path.normalize(seedHireDir),
        ]
      : [path.normalize(seedAgentDir), path.normalize(seedHireDir)]
    for (let idx = 0; idx < expectedSeeds.length; idx++) {
      const expectedSeed = expectedSeeds[idx]
      const c = ipcCalls[idx]
      if (!c || !c.parentMatchesWin) problems.push(`IPC call ${idx} missing parentMatchesWin`)
      if (JSON.stringify(c?.options?.properties) !== JSON.stringify(['openDirectory', 'createDirectory'])) {
        problems.push(`IPC call ${idx} wrong properties: ${JSON.stringify(c?.options)}`)
      }
      if (c?.options?.defaultPath !== expectedSeed) {
        problems.push(`IPC call ${idx} defaultPath=${c?.options?.defaultPath}, expected ${expectedSeed}`)
      }
    }

    if (sid(process.pid) !== 0) problems.push('SessionId drifted from 0')
    if (clipboardCalls !== 0) problems.push(`Main clipboard touched ${clipboardCalls} times`)

    const results = {
      ok: problems.length === 0,
      problems,
      sessionId: mySessionId,
      electronPid: process.pid,
      audioMuted: win.webContents.isAudioMuted(),
      clipboardCalls,
      rendererClipboardBlocked,
      reactRoots,
      ipcCalls,
      session0NativeDialogProbes: {
        agentSettings: agentOsDialogProbe,
        hireDialog: hireOsDialogProbe,
      },
      scenes: {
        localAgentBefore: s1Before,
        localAgentAfter: s1After,
        localHireAfter: s2After,
        remoteAgentPicker: s3After,
      },
      shots: [shot1Before, shot1After, shot2Before, shot2After, shot3Remote],
    }
    const resultFile = probeOsDialog ? 'results-os-probe.json' : 'results.json'
    fs.writeFileSync(path.join(out, resultFile), JSON.stringify(results, null, 2), 'utf8')
    console.log(
      results.ok
        ? `PASS: 0 problems (agentHwnd=${agentOsDialogProbe?.hwndCreated}, hireHwnd=${hireOsDialogProbe?.hwndCreated})`
        : `FAIL: ${problems.join('; ')}`,
    )
    win.destroy()
    app.exit(results.ok ? 0 : 1)
  } catch (err) {
    const failure = {
      ok: false,
      error: err instanceof Error ? err.stack || err.message : String(err),
      problems,
    }
    fs.writeFileSync(path.join(out, 'failure.json'), JSON.stringify(failure, null, 2), 'utf8')
    console.error(failure.error)
    try { win?.destroy() } catch {}
    app.exit(1)
  }
}

app.whenReady().then(main)
