import { app, BrowserWindow, nativeImage } from 'electron'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

app.setPath('userData', path.join(os.tmpdir(), `orgtree-window-controls-${process.pid}`))
const waitFor = (window: BrowserWindow, event: 'maximize' | 'unmaximize' | 'minimize' | 'restore') =>
  new Promise<void>(resolve => window.once(event, () => resolve()))

app.whenReady().then(async () => {
  const assetRoot = path.join(process.cwd(), 'apps/desktop/assets')
  for (const name of ['orgtree-eye.ico', 'orgtree-eye-tray-grey.ico', 'orgtree-eye-tray-orgtree.ico', 'orgtree-eye-tray-claude.ico', 'orgtree-eye-tray-codex.ico', 'orgtree-eye-tray-antigravity.ico', 'orgtree-eye-tray-openrouter.ico']) {
    const asset = path.join(assetRoot, name)
    assert.equal(fs.existsSync(asset), true, `icon asset exists: ${name}`)
    const image = nativeImage.createFromPath(asset)
    assert.equal(image.isEmpty(), false, `Electron nativeImage loads: ${name}`)
    assert.ok(image.getSize().width >= 16, `Electron nativeImage has dimensions: ${name}`)
  }
  const window = new BrowserWindow({ width: 720, height: 480, show: false, frame: false, resizable: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
  assert.equal(window.isDestroyed(), false)
  window.show()
  const before = window.getSize()
  const maximizing = waitFor(window, 'maximize')
  window.maximize(); await maximizing
  assert.equal(window.isMaximized(), true, 'frameless window maximizes')
  const unmaximizing = waitFor(window, 'unmaximize')
  window.unmaximize(); await unmaximizing
  assert.equal(window.isMaximized(), false, 'frameless window restores')
  const minimizing = waitFor(window, 'minimize')
  window.minimize(); await minimizing
  assert.equal(window.isMinimized(), true, 'frameless window minimizes')
  const restoring = waitFor(window, 'restore')
  window.restore(); await restoring
  assert.equal(window.isMinimized(), false, 'frameless window restores from taskbar')
  assert.deepEqual(window.getSize(), before, 'normal bounds survive maximize/minimize')
  // This probe intentionally exercises Electron's native state transitions
  // only. Rendered bridge/button wiring and drag regions are covered by the
  // renderer checks; icon/theme transitions are covered by icon-assets tests.
  console.log('WINDOW_CONTROLS_NATIVE_PASS ' + JSON.stringify({ scope: 'native BrowserWindow state operations only', frame: false, resizable: true, maximize: true, restore: true, minimize: true, normalBounds: before, nativeImageAssets: true }))
  window.destroy(); app.exit(0)
}).catch(error => { console.error(error); for (const window of BrowserWindow.getAllWindows()) window.destroy(); app.exit(1) })
setTimeout(() => { console.error('Window controls native probe timed out'); app.exit(1) }, 30000).unref()
