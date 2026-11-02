// The capture guard must never let a CDP command reach a window that has not loaded a page yet: on Electron 44,
// Emulation.setDeviceMetricsOverride sent to the guard's offscreen window before its first navigation kills the whole
// app (crashpad "not connected", exit 4294930435 = 0xFFFF7003), before any fixture or guard receipt (measured 2026-11-02,
// item capture-harness-electron-crashes-at-startup-cras). This test drives createGuard with a fake electron module.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'

const { createGuard } = createRequire(import.meta.url)('../apps/desktop/renderer/tests/chipcapture-guard.cjs')
const temp = mkdtempSync(path.join(tmpdir(), 'orgtree-chipcapture-guard-'))
test.after(() => rmSync(temp, { recursive: true, force: true }))

function fakeElectron() {
  const events = []
  let finishLoad = null
  class WebContents extends EventEmitter {
    constructor() {
      super(); this.url = ''; this.attached = false
      this.debugger = {
        attach: () => { this.attached = true; events.push('attach') },
        isAttached: () => this.attached,
        detach: () => { this.attached = false },
        sendCommand: async (method) => { events.push((this.url ? 'cdp after load: ' : 'cdp BEFORE load: ') + method); return {} },
      }
    }
    setAudioMuted() {} isAudioMuted() { return true } setWindowOpenHandler() {}
    copy() {} cut() {} paste() {} pasteAndMatchStyle() {}
    executeJavaScript() { return Promise.resolve(null) }
  }
  class BrowserWindow {
    constructor() { this.webContents = new WebContents() }
    // a load finishes only when the test says so, the way a real first navigation takes time
    loadURL(url) { events.push('load ' + url); return new Promise(resolve => { finishLoad = () => { this.webContents.url = url; this.webContents.emit('did-finish-load'); resolve() } }) }
    loadFile(file) { return this.loadURL('file://' + file) }
    setContentSize() {}
  }
  const ses = { setPermissionCheckHandler() {}, setPermissionRequestHandler() {}, webRequest: { onBeforeRequest() {} } }
  const clipboard = { clear() {}, has() {}, read() {}, readText() {}, write() {}, writeText() {} }
  const electron = { app: { getAppMetrics: () => [], commandLine: { hasSwitch: () => true } }, BrowserWindow, session: { fromPartition: () => ses }, clipboard }
  return { electron, events, finishLoad: () => finishLoad() }
}

test('device-metrics emulation waits for the guard window\'s first page load', async () => {
  const { electron, events, finishLoad } = fakeElectron()
  const guard = createGuard({ electron, out: temp, width: 1280, height: 900, partition: 'emu' })
  // the failing captures' exact order: attach and emulate straight after createGuard, before loading their page
  guard.wc.debugger.attach('1.3')
  const sent = guard.wc.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })
  await new Promise(r => setTimeout(r, 20))
  assert.ok(!events.some(e => e.startsWith('cdp BEFORE load')), 'a CDP command reached a window with no page: ' + JSON.stringify(events))
  finishLoad()
  await sent
  assert.ok(events.includes('cdp after load: Emulation.setDeviceMetricsOverride'), JSON.stringify(events))
})

test('emulate() loads a page first, attaches once and sets the metrics', async () => {
  const { electron, events, finishLoad } = fakeElectron()
  const guard = createGuard({ electron, out: temp, width: 1024, height: 768, partition: 'emu2' })
  assert.equal(typeof guard.emulate, 'function')
  const done = guard.emulate({ width: 1024, height: 768 })
  await new Promise(r => setTimeout(r, 20))
  finishLoad()
  await done
  await guard.emulate({ width: 800, height: 600 })
  assert.deepEqual(events.filter(e => e.startsWith('cdp') || e === 'attach'),
    ['attach', 'cdp after load: Emulation.setDeviceMetricsOverride', 'cdp after load: Emulation.setDeviceMetricsOverride'])
})
