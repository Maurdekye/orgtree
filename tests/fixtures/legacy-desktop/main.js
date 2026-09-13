// Process double for an ALREADY-INSTALLED Orgtree desktop, used to measure what
// a new installer can actually do to a copy of the app that is already running.
//
// `legacy` reproduces the shipped 2.1.2 lifecycle exactly (git 45531f7): a second
// instance only raises the window, a window close hides to the tray because
// `exitOnClose` defaults to false, and `before-quit` is the only path that stops
// the managed engine.
// `modern` reproduces the 2.1.3 lifecycle, where a second instance carrying
// `--installer-upgrade` drives the dedicated refusal-safe shutdown.
//
// It never borrows the installed application's identity: the name, the userData
// path and therefore the single-instance lock below are the fixture's own, so it
// can neither join nor disturb a real Orgtree instance on the same machine.
const { app, BrowserWindow, Tray, nativeImage } = require('electron')
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')

const here = __dirname
const home = process.env.ORGTREE_FIXTURE_HOME || here
const mode = fs.readFileSync(path.join(home, 'mode.txt'), 'utf8').trim()
const logPath = process.env.ORGTREE_FIXTURE_LOG || path.join(home, 'events.log')
const record = (event, detail) => {
  try { fs.appendFileSync(logPath, JSON.stringify({ at: Date.now(), pid: process.pid, event, detail: detail ?? null }) + '\n') } catch { /* the probe asserts on what did land */ }
}

app.setName('OrgtreeUpgradeFixture')
app.setPath('userData', path.join(home, 'userdata'))

const INSTALLER_UPGRADE_ARG = '--installer-upgrade'
const hasInstallerUpgradeRequest = args => args.some(arg => arg === INSTALLER_UPGRADE_ARG)

const upgradeRequested = hasInstallerUpgradeRequest(process.argv)
const single = app.requestSingleInstanceLock()
if (!single) {
  record('secondary-instance-exit', { upgradeRequested })
  app.quit()
} else if (mode === 'modern' && upgradeRequested) {
  record('primary-control-invocation-exit')
  void app.whenReady().then(() => app.quit())
} else {
  runPrimary()
}

function runPrimary () {
  let main
  let tray
  let engine
  let engineStopped = false
  let quitting = false
  let quitComplete = false
  let installerUpgradeShutdown = false

  // Stands in for the managed engine: a real child process holding an open
  // handle inside the install directory, so "the app exited" and "the installed
  // files are released" stay two separately observable facts, as they are in the
  // product.
  const startEngine = () => {
    engine = spawn(process.execPath, [path.join(here, 'engine-double.js'), path.join(home, 'engine.lock')], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ORGTREE_FIXTURE_LOG: logPath },
      stdio: ['pipe', 'ignore', 'ignore'],
      windowsHide: true,
    })
    engine.on('exit', code => { engineStopped = true; record('engine-exit', { code }) })
    record('engine-start', { pid: engine.pid })
  }

  // The product's graceful stop asks the engine to finish and waits for it; it
  // never terminates it, and a refusal is reported rather than escalated.
  const stopEngineGracefully = budgetMs => new Promise(resolve => {
    if (!engine || engineStopped) return resolve(true)
    const timer = setTimeout(() => { record('engine-stop-timeout'); resolve(false) }, budgetMs)
    engine.once('exit', () => { clearTimeout(timer); resolve(true) })
    try { engine.stdin.write('stop\n') } catch { clearTimeout(timer); resolve(false) }
  })

  const show = () => {
    record('show')
    if (!main || main.isDestroyed()) return
    if (!main.isVisible()) main.show()
    main.focus()
  }

  const completeQuit = () => {
    quitComplete = true
    record('quit-complete')
    try { tray?.destroy() } catch { /* already gone */ }
    app.quit()
  }

  const requestInstallerUpgradeShutdown = async () => {
    if (installerUpgradeShutdown || quitComplete || quitting) return
    installerUpgradeShutdown = true
    record('installer-upgrade-shutdown-start')
    if (!await stopEngineGracefully(8000)) {
      record('installer-upgrade-shutdown-refused')
      installerUpgradeShutdown = false
      return
    }
    quitting = true
    completeQuit()
  }

  app.on('second-instance', (_event, commandLine) => {
    record('second-instance', { upgrade: hasInstallerUpgradeRequest(commandLine) })
    if (mode === 'modern' && hasInstallerUpgradeRequest(commandLine)) { void requestInstallerUpgradeShutdown(); return }
    // 2.1.2 ships exactly this: `app.on('second-instance', show)`.
    show()
  })

  app.on('window-all-closed', () => { record('window-all-closed') })

  // Observed, never acted on. 2.1.2 registers no session-end handler at all, so
  // whether the process survives a synthesized end-session is a property of
  // Electron itself, and measuring it is the reason this fixture exists.
  app.on('session-end', () => record('session-end'))

  app.on('before-quit', event => {
    record('before-quit', { quitComplete, quitting, installerUpgradeShutdown })
    if (quitComplete) return
    if (installerUpgradeShutdown) { event.preventDefault(); return }
    event.preventDefault()
    if (quitting) return
    quitting = true
    void stopEngineGracefully(8000).finally(() => completeQuit())
  })

  app.on('will-quit', () => record('will-quit'))
  app.on('quit', () => record('quit'))

  void app.whenReady().then(() => {
    startEngine()
    main = new BrowserWindow({ width: 420, height: 260, show: false, title: 'Orgtree (fixture)' })
    main.on('close', event => {
      // `exitOnClose` defaults to false, so the product hides here.
      if (quitting) { record('window-close-allowed'); return }
      event.preventDefault()
      record('window-close-hidden')
      main.hide()
    })
    void main.loadURL('data:text/html,<title>Orgtree fixture</title><body>fixture</body>')
    tray = new Tray(nativeImage.createFromBuffer(Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAG0lEQVQ4jWNgGAWjYBSMglEwCkbBKBgFo4AeAAAHAAGKUn0sAAAAAElFTkSuQmCC', 'base64')))
    tray.setToolTip('Orgtree fixture')
    main.once('ready-to-show', () => { main.show(); record('ready', { mode }) })
  })
}
