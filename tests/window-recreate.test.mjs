// window-recreate.test.mjs — UI-02: show() must recreate a destroyed main
// window through the SAME construction path used at startup, never a second
// divergent one, then fall through to its existing show/restore/maximize/
// focus/broadcast logic unchanged.
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

test('show() guards a destroyed/missing main window and recreates it before falling through', () => {
  const main = read('apps/desktop/main/index.ts')

  assert.match(main, /const show = async \(\) => \{/,
    'show() must be async to await the recreate path')
  assert.match(main, /if \(\(!main \|\| main\.isDestroyed\(\)\) && createMainWindow\) await createMainWindow\(\)/,
    'show() must guard on a destroyed/missing main window and recreate through the shared helper')

  // The guard must run BEFORE the existing show/restore/maximize/focus/
  // broadcast body, so a recreated window still gets shown — not just built.
  const showBody = main.slice(main.indexOf('const show = async () => {'))
  const guardAt = showBody.indexOf('if ((!main || main.isDestroyed()) && createMainWindow) await createMainWindow()')
  const fallthroughAt = showBody.indexOf("restoreWindows = true; main.show();")
  assert.ok(guardAt > -1 && fallthroughAt > guardAt,
    'the recreate guard must precede the unchanged show/restore/maximize/focus/broadcast body')
})

test('createMainWindow is declared once in outer scope and assigned exactly once', () => {
  const main = read('apps/desktop/main/index.ts')

  assert.match(main, /let createMainWindow: \(\(\) => Promise<void>\) \| undefined/,
    'createMainWindow must be hoisted to a shared outer-scope binding, not redeclared per call site')

  const assignments = main.match(/createMainWindow = async \(\) => \{/g) ?? []
  assert.equal(assignments.length, 1,
    'createMainWindow must be assigned exactly once (inside app.whenReady()) — never a second, divergent construction path')
})

test('exactly one main-window construction literal exists (startup and recreate share it)', () => {
  const main = read('apps/desktop/main/index.ts')

  const constructions = main.match(/main = new BrowserWindow\(\{/g) ?? []
  assert.equal(constructions.length, 1,
    'there must be exactly one `main = new BrowserWindow(...)` literal — startup and the show() recreate branch call the same createMainWindow(), never a duplicated construction')

  // The startup path must call the shared helper, not inline a second build.
  assert.match(main, /await createMainWindow\(\)\s*\n\s*engineReady = true/,
    'the startup path must construct the window via the shared createMainWindow() helper')
})

test('app.on(activate, show) and window-all-closed are unchanged (already correct)', () => {
  const main = read('apps/desktop/main/index.ts')

  assert.match(main, /app\.on\('activate', show\)/,
    'activate must still trigger show(), which now recreates when needed')
  assert.match(main, /app\.on\('window-all-closed', \(\) => \{ \/\* Tray\/main remain alive by default\. \*\/ \}\)/,
    'window-all-closed must still leave the app running in the Dock — this plan does not change that behavior')
})
