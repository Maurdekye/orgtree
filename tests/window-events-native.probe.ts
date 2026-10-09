/** The window log and the reveal path against REAL windows
 *  (node tools/test-window-events-native.mjs).
 *
 *  tests/window-events.test.mjs and tests/window-reveal.test.mjs prove the
 *  rules with fakes. Only Electron can settle the rest: that a BrowserWindow
 *  really reports minimize, restore, show and hide into the log under those
 *  names, and that revealing one real window (show, maximize, focus — what a
 *  notification does for a new organization's window) fires no minimize or
 *  hide on another. The windows are small, skip the taskbar and live for a
 *  few seconds; Electron's profile and every file live in the runner's temp
 *  folder, so nothing here touches user data. */
import { app, BrowserWindow } from 'electron'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { WINDOW_EVENTS_LOG, WindowEventLog, watchWindowEvents } from '../apps/desktop/main/window-events'
import { revealOnly } from '../apps/desktop/main/window-reveal'

const root = process.env.ORGTREE_WINDOW_EVENTS_ROOT
if (!root) throw new Error('run through tools/test-window-events-native.mjs')
app.setPath('userData', path.join(root, 'userData'))
const file = path.join(root, WINDOW_EVENTS_LOG)
const log = new WindowEventLog(() => file)
type Line = { window: string; org?: string; event?: string; action?: string }
const lines = (): Line[] => fs.existsSync(file)
  ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l) as Line) : []
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function until(what: string, ok: () => boolean, timeout = 5000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { if (ok()) return; await pause(50) }
  throw new Error(`timed out waiting for ${what}`)
}
const saw = (window: string, event: string) => () => lines().some(l => l.window === window && l.event === event)

app.whenReady().then(async () => {
  const make = (name: string, org: string) => {
    const window = new BrowserWindow({ width: 320, height: 240, x: 40, y: 40, show: false, skipTaskbar: true, frame: false })
    watchWindowEvents(window, name, () => ({ kind: 'org', org }), log)
    return window
  }
  try {
    const a = make('A', 'orgtree')
    a.show(); await until('A show', saw('A', 'show'))
    a.minimize(); await until('A minimize', saw('A', 'minimize'))
    a.restore(); await until('A restore', saw('A', 'restore'))
    a.hide(); await until('A hide', saw('A', 'hide'))
    a.show(); await until('A shown again', () => lines().filter(l => l.window === 'A' && l.event === 'show').length === 2)
    const before = lines().length
    // B is revealed as a notification reveals a new organization's window
    const b = make('B', 'maurdekye-works')
    revealOnly({ id: 'B', window: b, restoreMaximized: true })
    await until('B show', saw('B', 'show'))
    await pause(1000)
    const onA = lines().slice(before).filter(l => l.window === 'A' && (l.event === 'minimize' || l.event === 'hide'))
    assert.deepEqual(onA, [], 'revealing B fired no minimize or hide on A')
    assert.equal(a.isMinimized(), false, 'A is not minimized')
    assert.equal(a.isVisible(), true, 'A is still shown')
    assert.equal(b.isMaximized(), true, 'B opened maximized, as its saved placement says')
    for (const l of lines()) assert.ok(l.org === 'orgtree' || l.org === 'maurdekye-works', 'every line names its organization')
    console.log(JSON.stringify({ ok: true, lines: lines().map(l => `${l.window}:${l.event ?? l.action}`) }))
    app.exit(0)
  } catch (error) {
    console.error(error)
    console.log(JSON.stringify({ ok: false, lines: lines().map(l => `${l.window}:${l.event ?? l.action}`) }))
    app.exit(1)
  }
})
