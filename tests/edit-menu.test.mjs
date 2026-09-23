// The editing context menu for text fields (user request 2026-09-18: "i should
// be able to copy cut and paste using the context menu in textboxes throughout
// the app").
//
// WHAT THIS FILE CAN AND CANNOT PROVE. It proves the RULES — which entries a
// press produces and which of them are enabled — and the WIRING, that every
// window the app configures, main and popped-out alike, carries the listener
// that pops them. It cannot prove that characters land in a field, because
// nothing here is Chromium. That half is measured against real Electron in
// tests/electron.probe.ts (`npm run test:electron`), which right-clicks a real
// input and watches Paste fill it.
//
// The enablement flags are NOT recomputed here or in the module under test.
// They are Chromium's `editFlags`, measured in Electron 44.2.0 before any of
// this was written: canPaste is false on an empty clipboard, canSelectAll is
// false in an empty field, and isEditable is false for readonly and for
// disabled inputs. The fixtures below carry those measured shapes.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'
import { createRequire } from 'node:module'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-editmenu-'))
// 'electron' is stubbed rather than bundled: outside an Electron process the
// real package resolves to the path of its own binary and refuses to load.
//
// The stub's Menu RECORDS EVERY POPUP into a global, deliberately: each bundle
// below carries its own copy of the stub, and windows.ts pops through its own
// copy of editmenu.ts. Recording centrally is what lets a test watch the menu
// the app's real wiring popped, rather than one a test injected a seam to see.
const STUB = `globalThis.__orgtreePopups = globalThis.__orgtreePopups || []
module.exports = { BrowserWindow: {}, shell: {}, Menu: { buildFromTemplate: template => ({ template,
  popup: options => globalThis.__orgtreePopups.push({ template, ...options }) }) } }`
const stubElectron = {
  name: 'stub-electron',
  setup(builder) {
    builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub-electron' }))
    builder.onLoad({ filter: /.*/, namespace: 'stub-electron' }, () => ({ contents: STUB, loader: 'js' }))
  },
}
const load = async (source, name) => {
  const out = path.join(dir, `${name}.cjs`)
  await build({ entryPoints: [source], outfile: out, bundle: true, platform: 'node', format: 'cjs', plugins: [stubElectron] })
  return createRequire(import.meta.url)(out)
}
/** the popups raised since this was last called */
function popups() {
  const raised = globalThis.__orgtreePopups ?? []
  globalThis.__orgtreePopups = []
  return raised
}
const { editMenuTemplate, attachEditMenu } = await load('apps/desktop/main/editmenu.ts', 'editmenu')
const { configureWindow } = await load('apps/desktop/main/windows.ts', 'windows')

/** Electron's `context-menu` params, in the shapes really observed. */
const EDITABLE_EMPTY_NO_CLIPBOARD = {                 // empty input, empty clipboard
  isEditable: true, selectionText: '',
  editFlags: { canCut: false, canCopy: false, canPaste: false, canSelectAll: false },
}
const EDITABLE_FILLED_WITH_CLIPBOARD = {              // filled input, clipboard holds text
  isEditable: true, selectionText: '',
  editFlags: { canCut: false, canCopy: false, canPaste: true, canSelectAll: true },
}
const EDITABLE_SELECTED = {                           // text selected inside the field
  isEditable: true, selectionText: 'hello',
  editFlags: { canCut: true, canCopy: true, canPaste: true, canSelectAll: true },
}
const READONLY_INPUT = {                              // readonly AND disabled inputs both look like this
  isEditable: false, selectionText: '',
  editFlags: { canCut: false, canCopy: false, canPaste: false, canSelectAll: true },
}
const PLAIN_TEXT_SELECTED = {
  isEditable: false, selectionText: 'plain static text',
  editFlags: { canCut: false, canCopy: true, canPaste: false, canSelectAll: true },
}
const PLAIN_TEXT = {
  isEditable: false, selectionText: '',
  editFlags: { canCut: false, canCopy: false, canPaste: false, canSelectAll: true },
}

function recordingTarget() {
  const calls = []
  return { calls, cut: () => calls.push('cut'), copy: () => calls.push('copy'),
    paste: () => calls.push('paste'), selectAll: () => calls.push('selectAll') }
}
const labels = template => template.filter(e => e.type !== 'separator').map(e => e.label)
const item = (template, label) => template.find(e => e.label === label)

test('an editable field offers cut, copy, paste and select all', () => {
  const template = editMenuTemplate(EDITABLE_SELECTED, recordingTarget())
  assert.deepEqual(labels(template), ['Cut', 'Copy', 'Paste', 'Select All'])
})

test('every entry runs its own operation on the webContents that was pressed', () => {
  const target = recordingTarget()
  const template = editMenuTemplate(EDITABLE_SELECTED, target)
  for (const label of ['Cut', 'Copy', 'Paste', 'Select All']) item(template, label).click()
  assert.deepEqual(target.calls, ['cut', 'copy', 'paste', 'selectAll'])
})

// THE GATES. Each is asserted against the flag shape Chromium really reports,
// and each is asserted BOTH WAYS: a rule that only ever says "disabled" would
// pass a one-sided test while gating nothing.
test('paste is disabled when the clipboard holds no text, and enabled when it does', () => {
  assert.equal(item(editMenuTemplate(EDITABLE_EMPTY_NO_CLIPBOARD, recordingTarget()), 'Paste').enabled, false)
  assert.equal(item(editMenuTemplate(EDITABLE_FILLED_WITH_CLIPBOARD, recordingTarget()), 'Paste').enabled, true)
})

test('cut and copy are disabled without a selection and enabled with one', () => {
  const none = editMenuTemplate(EDITABLE_FILLED_WITH_CLIPBOARD, recordingTarget())
  assert.equal(item(none, 'Cut').enabled, false)
  assert.equal(item(none, 'Copy').enabled, false)
  const some = editMenuTemplate(EDITABLE_SELECTED, recordingTarget())
  assert.equal(item(some, 'Cut').enabled, true)
  assert.equal(item(some, 'Copy').enabled, true)
})

test('select all is disabled in an empty field and enabled in a filled one', () => {
  assert.equal(item(editMenuTemplate(EDITABLE_EMPTY_NO_CLIPBOARD, recordingTarget()), 'Select All').enabled, false)
  assert.equal(item(editMenuTemplate(EDITABLE_FILLED_WITH_CLIPBOARD, recordingTarget()), 'Select All').enabled, true)
})

test('a readonly or disabled input offers neither cut nor paste', () => {
  // Chromium reports isEditable:false for both, so they never reach the
  // editable branch at all - the entries are absent, not merely greyed.
  assert.equal(editMenuTemplate(READONLY_INPUT, recordingTarget()), null)
})

test('a selection outside an editable field offers copy and nothing else', () => {
  const template = editMenuTemplate(PLAIN_TEXT_SELECTED, recordingTarget())
  assert.deepEqual(labels(template), ['Copy'])
  assert.equal(item(template, 'Copy').enabled, true)
})

test('an ordinary press with no field and no selection opens no menu', () => {
  assert.equal(editMenuTemplate(PLAIN_TEXT, recordingTarget()), null)
})

/** A native window reduced to what configureWindow and attachEditMenu read. */
function fakeWindow({ url = 'http://127.0.0.1:1/index.html' } = {}) {
  const listeners = new Map()
  const contentsListeners = new Map()
  const fire = (map, event, ...args) => (map.get(event) ?? []).forEach(l => l(...args))
  const window = {
    destroyed: false,
    isDestroyed() { return this.destroyed },
    isVisible: () => true,
    isMinimized: () => false,
    on(event, listener) { listeners.set(event, [...(listeners.get(event) ?? []), listener]) },
    once(event, listener) { this.on(event, listener) },
    webContents: {
      id: 1,
      calls: [],
      getURL: () => url,
      setBackgroundThrottling() {},
      setWindowOpenHandler() {},
      on(event, listener) { contentsListeners.set(event, [...(contentsListeners.get(event) ?? []), listener]) },
      cut() { this.calls.push('cut') },
      copy() { this.calls.push('copy') },
      paste() { this.calls.push('paste') },
      selectAll() { this.calls.push('selectAll') },
    },
    rightClick(params, x = 30, y = 40) { fire(contentsListeners, 'context-menu', {}, { ...params, x, y }) },
    createChild(child) { fire(contentsListeners, 'did-create-window', child, { frameName: 'popout', options: {} }) },
    handles(event) { return (contentsListeners.get(event) ?? []).length },
  }
  return window
}

test('a right-click in a field pops the menu in that window at the pressed point', () => {
  const window = fakeWindow()
  attachEditMenu(window)
  popups()
  window.rightClick(EDITABLE_SELECTED, 137, 219)
  const raised = popups()
  assert.equal(raised.length, 1)
  assert.equal(raised[0].window, window, 'popped in the window the press came from')
  // The coordinates are passed THROUGH, unconverted: they are client pixels in
  // this window's own viewport, and converting them is what breaks mixed DPI.
  assert.equal(raised[0].x, 137)
  assert.equal(raised[0].y, 219)
  assert.deepEqual(labels(raised[0].template), ['Cut', 'Copy', 'Paste', 'Select All'])
})

test('the menu acts on the webContents of the window that was pressed', () => {
  const window = fakeWindow()
  attachEditMenu(window)
  popups()
  window.rightClick(EDITABLE_SELECTED)
  item(popups()[0].template, 'Paste').click()
  assert.deepEqual(window.webContents.calls, ['paste'])
})

test('a press that earns no menu pops nothing', () => {
  const window = fakeWindow()
  attachEditMenu(window)
  popups()
  window.rightClick(PLAIN_TEXT)
  assert.equal(popups().length, 0)
})

test('a window destroyed between the press and the menu pops nothing', () => {
  const window = fakeWindow()
  attachEditMenu(window)
  window.destroyed = true
  popups()
  window.rightClick(EDITABLE_SELECTED)
  assert.equal(popups().length, 0)
})

// THROUGHOUT THE APP. The user asked for every textbox, and the app's textboxes
// are not all in the main window - a popped-out surface is a separate native
// window with its own webContents. configureWindow recurses into each one, so
// the menu has to arrive with that recursion rather than being attached once.
test('configureWindow gives the main window the editing menu', () => {
  const window = fakeWindow()
  configureWindow(window, () => 'http://127.0.0.1:1', true)
  assert.equal(window.handles('context-menu'), 1)
})

test('a popped-out window gets its own editing menu, on its own webContents', () => {
  const main = fakeWindow(), popout = fakeWindow({ url: 'about:blank' })
  configureWindow(main, () => 'http://127.0.0.1:1', true)
  main.createChild(popout)
  assert.equal(popout.handles('context-menu'), 1, 'the popout is configured too')
  // and that menu - the one the app's own wiring installed, not one the test
  // attached - is drawn in the POPOUT and acts on the POPOUT's webContents
  popups()
  popout.rightClick(EDITABLE_SELECTED, 12, 34)
  const raised = popups()
  assert.equal(raised.length, 1)
  assert.equal(raised[0].window, popout, 'drawn in the window the user clicked in')
  assert.equal(raised[0].x, 12)
  assert.equal(raised[0].y, 34)
  item(raised[0].template, 'Cut').click()
  assert.deepEqual(popout.webContents.calls, ['cut'])
  assert.deepEqual(main.webContents.calls, [], 'the main window was not touched')
})

test('the menu the main window itself was given works the same way', () => {
  // configureWindow's own listener, end to end: no attachEditMenu call here.
  const window = fakeWindow()
  configureWindow(window, () => 'http://127.0.0.1:1', true)
  popups()
  window.rightClick(EDITABLE_EMPTY_NO_CLIPBOARD, 5, 6)
  const raised = popups()
  assert.equal(raised.length, 1)
  assert.equal(item(raised[0].template, 'Paste').enabled, false, 'empty clipboard still gates through the real wiring')
  item(raised[0].template, 'Copy').click()
  assert.deepEqual(window.webContents.calls, ['copy'])
})
