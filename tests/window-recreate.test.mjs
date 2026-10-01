// window-recreate.test.mjs — UI-02: after every window is closed the app stays
// alive in the Dock, and activating it (Dock click, tray, second launch) must
// bring a window back through showLastUsedOrHomepage — restoring the last-used
// window, or creating a Homepage through the shared createMainWindow path when
// none exists.
//
// index.ts requires Electron and runs an application, so — same idiom as
// lifetime-wiring.test.mjs and updater-wiring.test.mjs — this asserts the
// wiring at source level rather than executing it.
//
// Run: node --test tests/window-recreate.test.mjs

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '..')
const read = file => fs.readFileSync(path.join(root, file), 'utf8')

test('UI-02: app.on(activate) routes to showLastUsedOrHomepage', () => {
  const main = read('apps/desktop/main/index.ts')

  assert.match(main, /app\.on\('activate', \(\) => \{\s*void showLastUsedOrHomepage\(\)\s*\}\)/,
    'activate must call showLastUsedOrHomepage(), which restores the last-used window or recreates a Homepage')
})

test('UI-02: window-all-closed does not quit the app', () => {
  const main = read('apps/desktop/main/index.ts')

  assert.match(main, /app\.on\('window-all-closed', \(\) => \{ \/\* Tray\/main remain alive by default\. \*\/ \}\)/,
    'window-all-closed must still leave the app running in the Dock so activate can recreate a window')

  const handler = main.match(/app\.on\('window-all-closed',[\s\S]*?\}\)/)
  assert.ok(handler, 'a window-all-closed handler must exist')
  assert.doesNotMatch(handler[0], /app\.quit\(/,
    'window-all-closed must not call app.quit() — that would defeat recreate-after-all-windows-closed')
})

test('UI-02: showLastUsedOrHomepage recreates a Homepage window when none exists', () => {
  const main = read('apps/desktop/main/index.ts').replace(/\r\n/g, '\n')

  const start = main.indexOf('const showLastUsedOrHomepage = async () => {')
  assert.ok(start > -1, 'showLastUsedOrHomepage must be an async function to await the recreate path')
  const end = main.indexOf('\n  }\n', start)
  assert.ok(end > start, 'showLastUsedOrHomepage body must be terminated')
  const body = main.slice(start, end)

  const restoreAt = body.search(/const record = lastUsed\(\)\s+if \(record\) \{ revealWindow\(record\); return \}/)
  const createAt = body.search(/const created = await createMainWindow\?\.\(\{ kind: 'homepage' \}\)/)
  const revealAt = body.search(/if \(created\) revealWindow\(created\)/)

  assert.ok(restoreAt > -1,
    'when lastUsed() yields a window it must be revealed and the function must return early')
  assert.ok(createAt > -1,
    "with no last-used window it must create a window through the shared createMainWindow({ kind: 'homepage' }) helper")
  assert.ok(revealAt > -1,
    'the freshly created window must be revealed, not just built')
  assert.ok(restoreAt < createAt && createAt < revealAt,
    'order must be: reuse last-used (early return), else create a Homepage, then reveal it')
})
