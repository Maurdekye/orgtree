import { app, BrowserWindow } from 'electron'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'

app.setPath('userData', path.join(os.tmpdir(), `orgtree-window-controls-${process.pid}`))
const waitFor = (window: BrowserWindow, event: 'maximize' | 'unmaximize' | 'minimize' | 'restore') =>
  new Promise<void>(resolve => window.once(event, () => resolve()))

app.whenReady().then(async () => {
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
  console.log('WINDOW_CONTROLS_NATIVE_PASS ' + JSON.stringify({ frame: false, resizable: true, maximize: true, restore: true, minimize: true, normalBounds: before }))
  window.destroy(); app.exit(0)
}).catch(error => { console.error(error); for (const window of BrowserWindow.getAllWindows()) window.destroy(); app.exit(1) })
setTimeout(() => { console.error('Window controls native probe timed out'); app.exit(1) }, 30000).unref()
