// Execute the shipping tray closure and event wiring; no Electron/live app.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { EventEmitter } from 'node:events'
import { transformSync } from 'esbuild'

const source = fs.readFileSync(process.env.ORGTREE_TRAY_TEST_SOURCE || 'apps/desktop/main/index.ts', 'utf8')
const slice = (from, to) => {
  const start = source.indexOf(from), end = source.indexOf(to, start)
  assert.ok(start >= 0 && end > start, 'shipping tray source boundaries')
  return source.slice(start, end)
}
const code = transformSync(slice('  let trayPopup:', '  const loginPreference =') +
  slice("    tray.on('click'", '    rebuildTray()') +
  '\nglobalThis.closePopup = closeTrayPopup', { loader: 'ts', target: 'node22' }).code
const tick = () => new Promise(resolve => setImmediate(resolve))
const icon = { x: 500, y: 900, width: 24, height: 24 }

function fixture(platform = 'win32') {
  const windows = [], reads = [], loads = [], opened = []
  let now = 0, cursor = { x: 512, y: 912 }, homes = 0
  const tray = new EventEmitter(); tray.getBounds = () => icon
  class Popup extends EventEmitter {
    constructor() {
      super(); windows.push(this); this.destroyed = false; this.visible = false
      this.webContents = new EventEmitter()
      this.webContents.setWindowOpenHandler = callback => { this.navigation = callback }
    }
    isDestroyed() { return this.destroyed }
    isVisible() { return this.visible }
    destroy() { this.destroyed = true; this.visible = false; this.emit('closed') }
    loadURL() { return new Promise((resolve, reject) => loads.push({resolve, reject})) }
    show() { assert.equal(this.destroyed, false); this.visible = true }
    static getAllWindows() { return windows }
  }
  const ctx = vm.createContext({
    BrowserWindow: Popup, tray, quitting: false, process: { platform },
    performance: { now: () => now }, console,
    engine: { orgActivity: () => new Promise(resolve => reads.push(resolve)) },
    screen: { getCursorScreenPoint: () => cursor, getDisplayNearestPoint: () => ({ workArea: icon }) },
    popupBounds: () => icon, trayListHtml: () => '<html/>',
    trayNavigationSlug: url => url === 'valid-org' ? 'alpha' : null,
    preferences: { get: () => ({}) }, effectiveTheme: undefined,
    requestOrgWindow: async slug => { opened.push(slug) },
    showLastUsedOrHomepage: async () => { homes++ },
  })
  vm.runInContext(code, ctx)
  const click = () => tray.emit('click', {}, icon)
  const finish = async () => { reads.at(-1)([]); await tick(); loads.at(-1)?.resolve(); await tick() }
  return { windows, reads, loads, opened, click, finish, tray, ctx,
    advance: ms => { now += ms }, cursor: point => { cursor = point },
    visible: () => windows.filter(w => w.visible && !w.destroyed).length, homes: () => homes }
}

test('click opens, slow second click closes, next click opens a fresh list', async () => {
  const f = fixture(); f.click(); await f.finish(); assert.equal(f.visible(), 1)
  f.advance(2000); f.click(); await tick()
  assert.equal(f.visible(), 0); assert.equal(f.reads.length, 1)
  f.click(); await f.finish(); assert.equal(f.visible(), 1); assert.equal(f.reads.length, 2)
})

test('Windows blur then tray click closes once, with no extra read or reopening', async () => {
  const f = fixture(); f.click(); await f.finish()
  f.windows[0].emit('blur'); f.advance(30); f.click(); await tick()
  assert.equal(f.visible(), 0); assert.equal(f.reads.length, 1)
  f.click(); await f.finish(); assert.equal(f.visible(), 1)
})

test('outside blur never eats a following tray click, even immediately', async () => {
  const f = fixture(); f.click(); await f.finish()
  f.cursor({x: 0, y: 0}); f.windows[0].emit('blur'); f.click(); await f.finish()
  assert.equal(f.visible(), 1); assert.equal(f.reads.length, 2)
})

test('old blur over the icon does not suppress a later independent click', async () => {
  const f = fixture(); f.click(); await f.finish()
  f.windows[0].emit('blur'); f.advance(1000); f.click(); await f.finish()
  assert.equal(f.visible(), 1)
})

test('second click cancels pending org fetch; its late answer creates no popup', async () => {
  const f = fixture(); f.click(); f.click(); f.reads[0]([]); await tick()
  assert.equal(f.windows.length, 0); assert.equal(f.reads.length, 1)
  f.click(); await f.finish(); assert.equal(f.visible(), 1)
})

test('cancel then reopen: a stale first answer cannot replace the third click', async () => {
  const f = fixture(); f.click(); f.click(); f.click()
  f.reads[0]([]); await tick(); assert.equal(f.windows.length, 0)
  await f.finish(); assert.equal(f.visible(), 1); assert.equal(f.windows.length, 1)
})

test('second click during HTML loading destroys that popup; late load cannot show it', async () => {
  const f = fixture(); f.click(); f.reads[0]([]); await tick()
  f.click(); f.loads[0].resolve(); await tick()
  assert.equal(f.visible(), 0); assert.equal(f.windows[0].destroyed, true)
})

test('double click cancels pending list, opens app once; later click still opens list', async () => {
  const f = fixture(); f.click(); f.tray.emit('double-click')
  f.reads[0]([]); await tick(); assert.equal(f.windows.length, 0); assert.equal(f.homes(), 1)
  f.advance(1500); f.click(); await f.finish(); assert.equal(f.visible(), 1)
})

test('Escape and choosing an org dismiss without arming blur suppression', async () => {
  const f = fixture(); f.click(); await f.finish()
  let prevented = 0
  f.windows[0].webContents.emit('before-input-event', {preventDefault(){prevented++}}, {type:'keyDown',key:'Escape'})
  assert.equal(prevented, 1); assert.equal(f.visible(), 0)
  f.click(); await f.finish()
  assert.equal(f.windows[1].navigation({url:'valid-org'}).action,'deny')
  assert.deepEqual(f.opened,['alpha']); assert.equal(f.visible(),0)
  f.click(); await f.finish(); assert.equal(f.visible(),1)
})

test('old popup late blur/closed events cannot dismiss a replacement', async () => {
  const f=fixture(); f.click(); await f.finish(); const old=f.windows[0]
  f.ctx.closePopup(); f.click(); await f.finish()
  old.emit('blur'); old.emit('closed'); assert.equal(f.visible(),1)
})

test('failed HTML load clears intent so the next click retries', async () => {
  const f=fixture(); f.click(); f.reads[0]([]); await tick()
  f.loads[0].reject(new Error('synthetic load failure')); await tick()
  f.click(); await f.finish(); assert.equal(f.visible(),1)
})

for (const platform of ['darwin','linux']) test(`${platform}: open/pending toggle and ordinary blur remain usable`, async () => {
  const f=fixture(platform); f.click(); f.click(); f.reads[0]([]); await tick()
  assert.equal(f.windows.length,0)
  f.click(); await f.finish(); f.windows[0].emit('blur')
  f.click(); await f.finish(); assert.equal(f.visible(),1)
})
