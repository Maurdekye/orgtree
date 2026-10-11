// Execute the actual main-process tray construction/refresh closure with a
// native Menu double. No Electron process, UAC, tasks or live settings touched.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { transformSync } from 'esbuild'

const index = fs.readFileSync('apps/desktop/main/index.ts', 'utf8')
const start = index.indexOf('  const rebuildTray = () => {')
const end = index.indexOf('\n  /**', start)
assert.ok(start >= 0 && end > start, 'real tray closure must be present')
const code = transformSync(index.slice(start, end), { loader: 'ts', target: 'node22' }).code

function fixture(initial) {
  let prefs = { startAtLogin: initial, automaticUpdates: true, notificationsEnabled: true }
  let buildCount = 0, writes = [], warnings = [], resolve, reject
  class MenuDouble {
    constructor(items) { this.items = items; this.events = new Map() }
    getMenuItemById(id) { return this.items.find(i => i.id === id) }
    on(name, fn) { this.events.set(name, fn) }
    emit(name) { this.events.get(name)?.() }
    get startup() { return this.items.find(i => i.label === 'Run on startup') }
  }
  const ctx = {
    preferences: { get: () => ({ ...prefs }) },
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
    app: { quit() { throw new Error('not part of this test') } },
    changeRunOnStartup(next) {
      writes.push(next)
      return new Promise((yes, no) => {
        resolve = () => { prefs = { ...prefs, startAtLogin: next }; ctx.rebuild(); yes(prefs) }
        reject = no
      })
    },
  }
  vm.runInNewContext(code + '\nthis.rebuild = rebuildTray', ctx)
  ctx.rebuild()
  return {
    ctx, writes, warnings,
    get menu() { return ctx.tray.menu }, get builds() { return buildCount },
    commit: () => resolve(), fail: () => reject(new Error('Windows did not give permission')),
    saveOutsideTray(value) { prefs = { ...prefs, startAtLogin: value } },
  }
}

for (const initial of [false, true]) {
  test(`async startup commit refreshes current open menu: ${initial} -> ${!initial}`, async () => {
    const f = fixture(initial)
    const first = f.menu
    // Electron initially toggles the clicked item's bit. Before UAC finishes,
    // a normal refresh can build another menu from the still-old saved prefs.
    first.startup.checked = !initial
    first.startup.click(first.startup)
    f.ctx.rebuild()
    const reopened = f.menu
    assert.notEqual(reopened, first)
    reopened.emit('menu-will-show')
    assert.equal(reopened.startup.checked, initial, 'pending UAC is not saved yet')
    const before = f.builds
    f.commit()
    await Promise.resolve()
    assert.equal(f.menu, reopened, 'do not replace a native menu while it is open')
    assert.equal(f.builds, before)
    assert.equal(reopened.startup.checked, !initial, 'first completed change must show on the current menu')
    assert.deepEqual(f.writes, [!initial], 'one click, one operation')
  })

  test(`declined change restores authoritative checkmark while open: ${initial}`, async () => {
    const f = fixture(initial)
    const menu = f.menu
    menu.emit('menu-will-show')
    menu.startup.checked = !initial
    menu.startup.click(menu.startup)
    f.fail()
    await Promise.resolve()
    assert.equal(f.menu, menu)
    assert.equal(menu.startup.checked, initial)
    assert.deepEqual(f.warnings, ['Windows did not give permission'])
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
