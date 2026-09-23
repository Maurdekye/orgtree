// app-menu-wiring.test.mjs — UI-03: a native macOS App Menu
// (Orgtree/Edit/Window, no File/Help) that reuses existing conventions:
// Preferences… broadcasts the same open-settings event App.tsx listens for,
// and Check for Updates… calls the exact same checkForUpdates() the tray's
// own "Check for updates" row already calls — one implementation, two entry
// points, never a forked copy.
//
// index.ts requires Electron and runs an application, and App.tsx is a
// 3000+ line component with no existing render-test harness for its
// bridge.onEvent listeners, so — same idiom as lifetime-wiring.test.mjs and
// updater-wiring.test.mjs — this asserts the wiring at source level rather
// than executing either file.
//
// Run: node --test tests/app-menu-wiring.test.mjs

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '..')
const read = file => fs.readFileSync(path.join(root, file), 'utf8')

test('DesktopEvent gains open-settings', () => {
  const contracts = read('packages/contracts/index.ts')
  // Appended after 'open-org' (not inserted before it) — traylist-wiring.test.mjs
  // pins 'popout-state' | 'open-org' as directly adjacent; this only adds a
  // new member, it does not renumber the existing sequence.
  assert.match(contracts, /'popout-state' \| 'open-org' \| 'open-settings'; data: unknown \}/,
    "DesktopEvent['type'] must gain 'open-settings' alongside the existing members")
})

test('a native App Menu exists: Orgtree/Edit/Window, no File/Help', () => {
  const main = read('apps/desktop/main/index.ts')

  assert.match(main, /Menu\.setApplicationMenu\(Menu\.buildFromTemplate\(\[/,
    'Menu.setApplicationMenu must be called with a built template')

  const templateMatch = /Menu\.setApplicationMenu\(Menu\.buildFromTemplate\(\[([\s\S]*?)\]\)\)/.exec(main)
  assert.ok(templateMatch, 'could not find the app menu template literal')
  const template = templateMatch[1]

  // exactly three top-level entries, in order: appMenu, editMenu, windowMenu
  const topLevelRoles = [...template.matchAll(/^\s*\{\s*role: '(appMenu|editMenu|windowMenu)'/gm)]
  assert.deepEqual(topLevelRoles.map(m => m[1]), ['appMenu', 'editMenu', 'windowMenu'],
    'top-level menu must be exactly appMenu, editMenu, windowMenu in order — no File/Help menu')

  assert.doesNotMatch(template, /role: 'fileMenu'|label: 'File'|label: 'Help'/,
    'nothing in scope needs a File or Help menu')

  // appMenu role auto-fills its own label from app.name — never hardcode "Orgtree"
  assert.doesNotMatch(main, /\{\s*role: 'appMenu',\s*label: 'Orgtree'/,
    'the appMenu role must not have a hardcoded "Orgtree" label — Electron auto-fills it from app.name')
})

test('appMenu submenu order: about, prefs, services, hide group, check-for-updates, quit', () => {
  const main = read('apps/desktop/main/index.ts')
  const appMenuMatch = /role: 'appMenu',\s*submenu: \[([\s\S]*?)\],?\s*\},\s*\{\s*role: 'editMenu'/.exec(main)
  assert.ok(appMenuMatch, 'could not find the appMenu submenu literal')
  const submenu = appMenuMatch[1]

  const order = [...submenu.matchAll(/\{\s*role: '(about|services|hide|hideOthers|unhide|quit)'\s*\}|label: '(Preferences…|Check for Updates…)'/g)]
    .map(m => m[1] ?? m[2])
  assert.deepEqual(order, ['about', 'Preferences…', 'services', 'hide', 'hideOthers', 'unhide', 'Check for Updates…', 'quit'],
    'appMenu submenu must be About, Preferences…, Services, Hide/HideOthers/Unhide, Check for Updates…, Quit — in order')

  assert.match(submenu, /label: 'Preferences…', accelerator: 'Cmd\+,'/,
    'Preferences… must carry the Cmd+, accelerator')
})

test('Preferences… broadcasts open-settings; Check for Updates… calls the tray\'s own checkForUpdates', () => {
  const main = read('apps/desktop/main/index.ts')

  assert.match(main, /label: 'Preferences…', accelerator: 'Cmd\+,', click: \(\) => \{ broadcast\(\{ type: 'open-settings', data: null \}\) \} \}/,
    "Preferences…'s click handler must call the existing broadcast() with { type: 'open-settings', data: null }")

  // "one implementation, two entry points": the App Menu's Check for
  // Updates… click handler must be byte-identical to the tray's own
  // update-check row handler(s) — rebuildTray() already has this exact
  // handler body on both its darwin and non-darwin branches (2 occurrences
  // pre-existing this task) — proven the same way updater-wiring.test.mjs
  // proves single-reference-ness elsewhere in this codebase.
  const handler = "click: () => { void checkForUpdates().catch(() => {}) } }"
  const trayOccurrences = (main.match(/id: 'update-check'/g) ?? []).length
  const totalOccurrences = main.split(handler).length - 1
  assert.equal(totalOccurrences, trayOccurrences + 1,
    'the exact checkForUpdates() click handler body must appear once per existing tray update-check row plus exactly one App Menu row — never a forked second implementation')
  assert.match(main, new RegExp(`label: 'Check for Updates…', ${handler.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
    "the App Menu's Check for Updates… row must use the same handler body as the tray's update-check row")
})

test("App.tsx's open-settings listener toggles the existing Settings surface", () => {
  const app = read('apps/desktop/renderer/src/App.tsx')

  assert.match(app, /if \(\(event\.type as string\) !== 'open-settings'\) return\s*\n\s*toggleSurface\('org-settings', showSettings, setShowSettings\)/,
    "App.tsx must have a bridge.onEvent listener that, on 'open-settings', calls the existing toggleSurface('org-settings', showSettings, setShowSettings) mechanism — the same one the Settings-gear button already uses")
})
