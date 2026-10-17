// Execute the shipping native tray builder and preference path, without Electron.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { build, transformSync } from 'esbuild'
import os from 'node:os'
import path from 'node:path'

const source = fs.readFileSync('apps/desktop/main/index.ts', 'utf8')
function slice(from, to) {
  const start = source.indexOf(from), end = source.indexOf(to, start)
  assert.ok(start >= 0 && end > start, 'shipping native tray source boundaries')
  return source.slice(start, end)
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'epic-tray-'))
const helperFile = 'apps/desktop/main/tray-epic.ts'
let helpers = {}
if (fs.existsSync(helperFile)) {
  const out = path.join(dir, 'tray-epic.cjs')
  await build({ entryPoints: [helperFile], outfile: out, bundle: true, platform: 'node', format: 'cjs' })
  helpers = createRequire(import.meta.url)(out)
}
const code = transformSync(slice('  const setPreferences =', '  // "RUN ON BOOT"') +
  slice('  const rebuildTray =', '  /** ⚠ THE SENDER') +
  '\nglobalThis.fixture={rebuildTray,setPreferences,getMenu:()=>trayMenu}', { loader: 'ts', target: 'node22' }).code

function fixture() {
  let saved = { epicMode: false, epicMuted: false }, current
  const events = []
  class Menu extends EventEmitter {
    constructor(rows) { super(); this.rows = rows }
    getMenuItemById(id) { return this.rows.find(row => row.id === id) }
    static buildFromTemplate(rows) { return new Menu(rows) }
  }
  const ctx = vm.createContext({ ...helpers, Menu, BrowserWindow: { getAllWindows: () => [] },
    tray: { setImage() {}, setToolTip() {}, setContextMenu(menu) { current = menu } },
    preferences: { get: () => ({ ...saved }), set: patch => (saved = { ...saved, ...patch }) },
    effectiveTheme: undefined, trayMenu: undefined, trayMenuOpen: false, startupChanging: false,
    runtimeIcon: () => ({ isEmpty: () => true }), attentionTotal: 0, applyWindowIcon() {},
    startupKind: () => 'boot', updatesSupported: false, label: () => 'test',
    hubMenuItem: () => ({ id: 'mailhub-status' }), trayHarnesses: null,
    harnessSetupMenu: () => [], detectHarnesses: () => [], NOTIFICATION_OPTIONS: [],
    refreshTrayUpdates() {}, refreshTrayEngine() {}, refreshTrayHub() {},
    loginPreference() {}, notifications: { configure() {} }, broadcastAll: e => events.push(e),
    setTimeout, console,
  })
  vm.runInContext(code, ctx)
  ctx.fixture.rebuildTray()
  return { ...ctx.fixture, events, saved: () => saved, menu: () => current }
}

test('shipping tray shows its mute checkbox only during EPIC and writes the broadcast preference', () => {
  const f = fixture()
  assert.equal(f.menu().getMenuItemById('epic-mute')?.visible ?? false, false)
  f.setPreferences({ epicMode: true })
  const item = f.menu().getMenuItemById('epic-mute')
  assert.equal(!!item, true, 'the shipping tray includes the EPIC mute control')
  assert.equal(item.label, 'Mute EPIC sounds'); assert.equal(item.type, 'checkbox')
  assert.equal(item.visible, true); assert.equal(item.checked, false)
  item.click({ checked: true })
  assert.equal(f.saved().epicMuted, true)
  assert.equal(f.events.at(-1).type, 'preferences')
  assert.equal(f.events.at(-1).data.epicMuted, true, 'all windows/popouts receive the existing broadcast')
  f.setPreferences({ epicMode: false })
  assert.equal(f.menu().getMenuItemById('epic-mute')?.visible ?? false, false)
})

test('an already open native menu refreshes EPIC visibility and check state without replacement', () => {
  const f = fixture(), original = f.menu()
  original.emit('menu-will-show')
  f.setPreferences({ epicMode: true, epicMuted: true })
  assert.equal(f.menu() === original, true)
  assert.equal(original.getMenuItemById('epic-mute')?.visible, true)
  assert.equal(original.getMenuItemById('epic-mute')?.checked, true)
  f.setPreferences({ epicMode: false })
  assert.equal(original.getMenuItemById('epic-mute')?.visible, false)
})
