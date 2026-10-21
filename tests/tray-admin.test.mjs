// Run the shipping tray and Settings closures. Every OS/settings/dialog seam is fake.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { EventEmitter } from 'node:events'
import { transformSync } from 'esbuild'

const source = fs.readFileSync('apps/desktop/main/index.ts', 'utf8')
const slice = (from, to, optional = false) => {
  const start = source.indexOf(from), end = source.indexOf(to, start)
  if (optional && start < 0) return ''
  assert.ok(start >= 0 && end > start, from)
  return source.slice(start, end)
}
const code = transformSync(
  slice('  // "RUN AS ADMIN"', '  let trayHarnesses:', true) +
  slice('  const rebuildTray = () => {', '\n  /**') +
  slice('      const runAsAdministratorState =', '      /** "Run on boot"') +
  '\nthis.rebuild = rebuildTray;', { loader: 'ts', target: 'node22' }).code
const tick = () => new Promise(resolve => setImmediate(resolve))

async function fixture(initial = false, { platform = 'win32', installed = true } = {}) {
  let stored = initial, builds = 0, rejectRead = false, blocked = false
  const handlers = {}, writes = [], dialogs = [], pending = [], answers = [], restarts = []
  class Menu extends EventEmitter {
    constructor(items) { super(); this.items = items }
    getMenuItemById(id) { return this.items.find(item => item.id === id) }
    static buildFromTemplate(items) { builds++; return new Menu(items) }
  }
  const ctx = {
    Menu, trayMenu: undefined, trayMenuOpen: false,
    tray: { setImage() {}, setToolTip() {}, setContextMenu(menu) { this.menu = menu } },
    runtimeIcon: () => ({ isEmpty: () => true }), attentionTotal: 0,
    BrowserWindow: { getAllWindows: () => [] }, applyWindowIcon() {},
    preferences: { get: () => ({ startAtLogin: true }) }, startupKind: () => 'boot', startupChanging: false,
    refreshTrayUpdates() {}, refreshTrayEngine() {}, refreshTrayHub() {}, refreshTrayEpic() {},
    epicMuteTrayItem: () => ({}), label: () => 'Ready', updatesSupported: false,
    hubMenuItem: () => ({ label: 'Mail hub' }), NOTIFICATION_OPTIONS: [],
    detectHarnesses: () => [], harnessSetupMenu: () => [], trayHarnesses: null,
    app: { quit() {} }, setTimeout, process: { platform }, setPreferences() {},
    handleApp: (name, fn) => { handlers[name] = fn },
    removePhoneFirewallRule() {}, addPhoneFirewallRule() {},
    engineOptions: { binary: 'fake-engine' }, launchContext: async () => ({}), inConsole: () => true,
    backgroundEngineRestart: false, engineRestartBlocked: () => blocked,
    restartBackgroundEngine: async (...args) => { restarts.push(args) },
    readRunAsAdministrator: async () => { if (rejectRead) throw Error('read failed'); return stored },
    readStartupTasks: async () => ({ boot: installed ? true : null }),
    writeRunAsAdministrator: enabled => {
      writes.push(enabled)
      return new Promise((resolve, reject) => pending.push({
        yes: () => { stored = enabled; resolve() }, no: () => reject(Error('Windows did not give permission')),
      }))
    },
    dialog: { showMessageBox: async options => { dialogs.push(options); return { response: answers.shift() ?? 0 } } },
  }
  vm.runInNewContext(code, ctx)
  ctx.rebuild()
  await handlers['desktop:run-as-admin']()
  await tick()
  return {
    ctx, handlers, writes, dialogs, restarts, answers,
    get menu() { return ctx.tray.menu }, get builds() { return builds }, get stored() { return stored },
    get item() { return ctx.tray.menu.getMenuItemById('run-as-admin') },
    settings: (value, restart = false) => handlers['desktop:set-run-as-admin'](value, restart),
    click() { const item = this.item; assert.ok(item, 'tray has the admin checkbox'); item.checked = !item.checked; item.click(item) },
    async finish(ok = true) { await tick(); assert.equal(pending.length, 1); pending.shift()[ok ? 'yes' : 'no'](); await tick() },
    outside(value) { stored = value }, failReads() { rejectRead = true }, block() { blocked = true },
  }
}

test('admin checkbox is immediately after startup and mirrors the saved value', async () => {
  for (const initial of [true, false]) {
    const f = await fixture(initial)
    const index = f.menu.items.findIndex(item => item.id === 'run-on-startup')
    assert.equal(f.menu.items[index + 1]?.id, 'run-as-admin')
    assert.equal(f.item.type, 'checkbox'); assert.equal(f.item.label, 'Run as admin')
    assert.equal(f.item.checked, initial); assert.equal(f.item.enabled, true)
  }
})

for (const initial of [false, true]) {
  test(`tray change ${initial}: warning only for ON, one write, no implicit restart`, async () => {
    const f = await fixture(initial), menu = f.menu
    menu.emit('menu-will-show'); f.click(); await tick()
    assert.equal(f.menu, menu); assert.equal(f.item.checked, initial)
    assert.equal(f.item.enabled, false)
    assert.deepEqual(f.writes, [!initial]); assert.equal(f.dialogs.length, initial ? 0 : 1)
    if (!initial) assert.match(f.dialogs[0].detail, /Every agent.*full administrator rights/)
    await f.finish()
    assert.equal(f.item.checked, !initial); assert.equal(f.item.enabled, true)
    assert.deepEqual(f.restarts, [])
  })
  test(`declined Windows prompt preserves ${initial} and restores an open menu`, async () => {
    const f = await fixture(initial), menu = f.menu
    menu.emit('menu-will-show'); f.click(); await f.finish(false)
    assert.equal(f.stored, initial); assert.equal(f.menu, menu)
    assert.equal(f.item.checked, initial); assert.equal(f.item.enabled, true)
    assert.match(f.dialogs.at(-1).message, /did not give permission/)
  })
}

test('declining the full-admin warning never calls Windows', async () => {
  const f = await fixture(); f.answers.push(1); f.click(); await tick()
  assert.deepEqual(f.writes, []); assert.equal(f.stored, false)
  assert.equal(f.item.checked, false); assert.equal(f.item.enabled, true)
})

test('Settings and tray share one pending guard and state refresh', async () => {
  const f = await fixture()
  const first = f.settings(true)
  await assert.rejects(f.settings(false), /still changing.*administrator/)
  await tick(); assert.equal(f.item.enabled, false)
  await f.finish(); assert.equal((await first).enabled, true); assert.equal(f.item.checked, true)
  f.click()
  await assert.rejects(f.settings(true), /still changing.*administrator/)
  await f.finish(); assert.deepEqual(f.writes, [true, false])
  assert.equal(f.item.checked, false)
})

test('unavailable platform or missing boot task cannot expose an actionable checkbox', async () => {
  for (const options of [{ platform: 'linux' }, { platform: 'darwin' }, { installed: false }]) {
    const f = await fixture(false, options)
    assert.equal(!!f.item && f.item.visible !== false && f.item.enabled !== false, false)
    await assert.rejects(f.settings(true), /Windows|not installed|not available/)
    assert.deepEqual(f.writes, [])
  }
})

test('menu opening refreshes changes made outside the tray', async () => {
  const f = await fixture(), menu = f.menu
  f.outside(true); menu.emit('menu-will-show'); await tick()
  assert.equal(f.menu, menu); assert.equal(f.item.checked, true)
  assert.deepEqual(f.writes, [])
})

test('read failure clears pending and disables stale state, then permits another request', async () => {
  const f = await fixture(); f.failReads()
  await assert.rejects(f.settings(true), /read failed/)
  assert.equal(!!f.item && f.item.enabled !== false, false)
  await assert.rejects(f.settings(true), /read failed/)
  assert.deepEqual(f.writes, [])
})

test('busy restart refuses without prompting; invalid input and no-op preserve behavior', async () => {
  const f = await fixture()
  await assert.rejects(f.settings('yes'), /Invalid setting/)
  assert.equal((await f.settings(false)).enabled, false)
  assert.deepEqual(f.writes, []); assert.deepEqual(f.dialogs, [])
  f.block(); await assert.rejects(f.settings(true), /busy restarting or updating/)
  assert.deepEqual(f.writes, []); assert.deepEqual(f.dialogs, [])
})
