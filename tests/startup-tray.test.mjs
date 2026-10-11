// Execute the actual main-process tray construction/refresh closure and the
// actual "run on startup" change (one at a time, pending state) with a native
// Menu double and stand-ins for the Windows task calls. No Electron process,
// UAC, tasks or live settings touched.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { transformSync } from 'esbuild'

const index = fs.readFileSync('apps/desktop/main/index.ts', 'utf8')
const slice = (from, to) => {
  const start = index.indexOf(from), end = index.indexOf(to, start)
  assert.ok(start >= 0 && end > start, `real source must contain ${from.trim()}`)
  return index.slice(start, end)
}
const code = transformSync(
  slice('  const loginPreference = () => {', '  /** What the switch shows is what really starts') +
  slice('  const rebuildTray = () => {', '\n  /**'), { loader: 'ts', target: 'node22' }).code

const PENDING = 'Run on startup (changing…)'
const tick = () => new Promise(resolve => setImmediate(resolve))

function fixture(initial) {
  let prefs = { startAtLogin: initial, automaticUpdates: true, notificationsEnabled: true }
  let buildCount = 0, boot = initial
  const writes = [], warnings = [], pending = []
  class MenuDouble {
    constructor(items) { this.items = items; this.events = new Map() }
    getMenuItemById(id) { return this.items.find(i => i.id === id) }
    on(name, fn) { this.events.set(name, fn) }
    emit(name) { this.events.get(name)?.() }
    get startup() { return this.getMenuItemById('run-on-startup') }
  }
  const ctx = {
    preferences: { get: () => ({ ...prefs }), set: patch => (prefs = { ...prefs, ...patch }, { ...prefs }) },
    trayMenu: undefined, trayMenuOpen: false,
    tray: { setImage() {}, setToolTip() {}, setContextMenu(menu) { this.menu = menu } },
    runtimeIcon: () => ({ isEmpty: () => true }), attentionTotal: 0,
    BrowserWindow: { getAllWindows: () => [] }, applyWindowIcon() {},
    refreshTrayUpdates() {}, refreshTrayEngine() {}, refreshTrayHub() {},
    label: () => 'Ready', updatesSupported: false,
    hubMenuItem: () => ({ id: 'mailhub-status', label: 'Mail hub' }),
    NOTIFICATION_OPTIONS: [], detectHarnesses: () => [],
    Menu: { buildFromTemplate(items) { buildCount++; return new MenuDouble(items) } },
    dialog: { showMessageBox(options) { warnings.push(options.message); return Promise.resolve({}) } },
    app: { isPackaged: true, quit() { throw new Error('not part of this test') }, setLoginItemSettings() {} },
    process: { platform: 'win32' },
    notifications: { configure() {} }, broadcastAll() {}, setTimeout,
    // the boot task as Windows reports it; a write waits until the test decides
    readStartupTasks: async () => ({ boot, helper: boot }),
    writeRunOnStartup(next) {
      writes.push(next)
      return new Promise((yes, no) => pending.push({ yes: () => { boot = next; yes() }, no }))
    },
  }
  vm.runInNewContext(code + '\nthis.rebuild = rebuildTray; this.change = changeRunOnStartup', ctx)
  ctx.rebuild()
  return {
    ctx, writes, warnings,
    get menu() { return ctx.tray.menu }, get builds() { return buildCount },
    get prefs() { return prefs },
    // the permission prompt answered and the change read back (or declined)
    commit: async () => { await tick(); pending.shift().yes(); await tick() },
    fail: async () => { await tick(); pending.shift().no(new Error('Windows did not give permission')); await tick() },
    saveOutsideTray(value) { prefs = { ...prefs, startAtLogin: value } },
  }
}

const click = menu => { menu.startup.checked = !menu.startup.checked; menu.startup.click(menu.startup) } // as Electron does

for (const initial of [false, true]) {
  test(`async startup commit refreshes current open menu: ${initial} -> ${!initial}`, async () => {
    const f = fixture(initial)
    const first = f.menu
    // Electron initially toggles the clicked item's bit. Before UAC finishes,
    // a normal refresh can build another menu from the still-old saved prefs.
    click(first)
    f.ctx.rebuild()
    const reopened = f.menu
    assert.notEqual(reopened, first)
    reopened.emit('menu-will-show')
    assert.equal(reopened.startup.checked, initial, 'pending UAC is not saved yet')
    const before = f.builds
    await f.commit()
    assert.equal(f.menu, reopened, 'do not replace a native menu while it is open')
    assert.equal(f.builds, before)
    assert.equal(reopened.startup.checked, !initial, 'first completed change must show on the current menu')
    assert.equal(reopened.startup.enabled, true)
    assert.deepEqual(f.writes, [!initial], 'one click, one operation')
  })

  test(`declined change restores authoritative checkmark while open: ${initial}`, async () => {
    const f = fixture(initial)
    const menu = f.menu
    menu.emit('menu-will-show')
    click(menu)
    await f.fail()
    assert.equal(f.menu, menu)
    assert.equal(menu.startup.checked, initial)
    assert.equal(menu.startup.enabled, true, 'a declined change ends the pending state')
    assert.deepEqual(f.warnings, ['Windows did not give permission'])
  })

  test(`a change under way shows in the tray until it has finished: ${initial} -> ${!initial}`, async () => {
    const f = fixture(initial)
    click(f.menu) // the click closed the menu first
    const during = f.menu
    assert.equal(during.startup.label, PENDING)
    assert.equal(during.startup.enabled, false, 'no second click while Windows is asked')
    assert.equal(during.startup.checked, initial, 'the checkmark stays the saved value')
    await f.commit()
    assert.notEqual(f.menu, during)
    assert.equal(f.menu.startup.label, 'Run on startup')
    assert.equal(f.menu.startup.enabled, true)
    assert.equal(f.menu.startup.checked, !initial)
    assert.equal(f.prefs.startAtLogin, !initial)
  })
}

test('opening an existing menu resynchronizes saved startup without a second click', () => {
  const f = fixture(false), menu = f.menu, before = f.builds
  f.saveOutsideTray(true)
  menu.emit('menu-will-show')
  assert.equal(menu.startup.checked, true)
  assert.equal(f.builds, before)
  assert.deepEqual(f.writes, [])
})

test('closed-menu rebuild still constructs the complete menu from committed preferences', () => {
  const f = fixture(false), before = f.menu
  f.saveOutsideTray(true)
  f.ctx.rebuild()
  assert.notEqual(f.menu, before)
  assert.equal(f.menu.startup.checked, true)
})

test('one change at a time: a second request is refused and leaves the first one pending', async () => {
  const f = fixture(false)
  const first = f.ctx.change(true) // from the tray or Settings, the same function
  await assert.rejects(f.ctx.change(false), /still changing "run on startup"/)
  await assert.rejects(f.ctx.change(true), /still changing "run on startup"/)
  assert.equal(f.menu.startup.label, PENDING, 'the refusal did not end the pending state')
  assert.equal(f.menu.startup.enabled, false)
  await f.commit()
  assert.equal((await first).startAtLogin, true)
  assert.deepEqual(f.writes, [true], 'one permission prompt')
  assert.equal(f.menu.startup.enabled, true)
  assert.equal(f.menu.startup.checked, true)
  // and the next change is accepted again
  const next = f.ctx.change(false)
  await f.commit()
  assert.equal((await next).startAtLogin, false)
  assert.deepEqual(f.writes, [true, false])
})

test('a refused second tray click restores the checkmark and says why', async () => {
  const f = fixture(false)
  const stale = f.menu // a menu built before the change began
  void f.ctx.change(true)
  click(stale)
  await tick()
  assert.equal(f.menu.startup.checked, false)
  assert.match(f.warnings[0], /still changing "run on startup"/)
  await f.commit()
  assert.deepEqual(f.writes, [true])
})

test('a failed read ends the pending state too', async () => {
  const f = fixture(false)
  f.ctx.readStartupTasks = async () => null
  await assert.rejects(f.ctx.change(true), /could not read its startup tasks/)
  assert.equal(f.menu.startup.label, 'Run on startup')
  assert.equal(f.menu.startup.enabled, true)
  assert.equal(f.menu.startup.checked, false)
  assert.deepEqual(f.writes, [])
})

test('a tray error as a change starts does not leave the guard set', async () => {
  const f = fixture(false)
  const icon = f.ctx.runtimeIcon
  f.ctx.runtimeIcon = () => { f.ctx.runtimeIcon = icon; throw new Error('tray refresh failed') } // once
  const failed = assert.rejects(f.ctx.change(true), /tray refresh failed/)
  await tick()
  assert.deepEqual(f.writes, [], 'the error ended the change before Windows was asked')
  await failed
  const later = f.ctx.change(true)
  await tick()
  assert.deepEqual(f.writes, [true], 'a later request is accepted and reaches Windows')
  await f.commit()
  assert.equal((await later).startAtLogin, true)
  assert.equal(f.menu.startup.enabled, true)
})

test('a menu open when the change starts or ends is rebuilt once it closes', async () => {
  const f = fixture(false)
  const open = f.menu
  open.emit('menu-will-show')
  click(open) // Electron may run the click before menu-will-close
  assert.equal(f.menu, open, 'never replaced while open')
  assert.equal(open.startup.enabled, false)
  open.emit('menu-will-close')
  await new Promise(resolve => setTimeout(resolve))
  const during = f.menu
  assert.notEqual(during, open)
  assert.equal(during.startup.label, PENDING)
  during.emit('menu-will-show')
  await f.commit()
  assert.equal(f.menu, during, 'never replaced while open')
  assert.equal(during.startup.checked, true)
  assert.equal(during.startup.enabled, true)
  during.emit('menu-will-close')
  await new Promise(resolve => setTimeout(resolve))
  assert.notEqual(f.menu, during)
  assert.equal(f.menu.startup.label, 'Run on startup')
  assert.equal(f.menu.startup.checked, true)
  const settled = f.menu, builds = f.builds
  settled.emit('menu-will-show'); settled.emit('menu-will-close')
  await new Promise(resolve => setTimeout(resolve))
  assert.equal(f.builds, builds, 'an unchanged menu is not rebuilt on close')
})
