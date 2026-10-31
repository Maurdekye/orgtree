import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'node:module'

import * as lib from '../lib.mjs'
import { runDesktop } from '../desktop.mjs'

// Rig proofs never open an unguarded desk window by default (docket
// rig-proofs-never-open-an-unguarded-desk-window-b, coordinator 2026-10-31):
// a run without --ui found an installed or integration renderer bundle by
// itself, and a proof's desk checks then launched the stock desktop harness,
// which had no mute and no clipboard guard (found by rig-sol-b on the
// effort-in-place job). No engine, database or Electron here: the desktop
// stand-in is plain node, which cannot open a window.
const require = createRequire(import.meta.url)

test('a run picks no renderer bundle unless one is asked for', () => {
  const saved = process.env.ORGTREE_RIG_UI
  delete process.env.ORGTREE_RIG_UI
  try {
    assert.equal(lib.uiDir(), null, 'no --ui and no ORGTREE_RIG_UI: headless')
    assert.equal(lib.uiDir(undefined), null)
    assert.equal(lib.uiDir(false), null, '--no-ui')
    const bundle = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-ui-'))
    fs.writeFileSync(path.join(bundle, 'index.html'), '<!doctype html>')
    assert.equal(lib.uiDir(bundle), bundle, 'an explicit --ui <dir> is used')
    process.env.ORGTREE_RIG_UI = bundle
    assert.equal(lib.uiDir(), bundle, 'ORGTREE_RIG_UI is an explicit request')
    assert.equal(lib.uiDir(false), null, '--no-ui wins over ORGTREE_RIG_UI')
    delete process.env.ORGTREE_RIG_UI
    const missing = path.join(bundle, 'no-such-bundle')
    assert.throws(() => lib.uiDir(missing), /no renderer bundle/, 'an explicit dir without index.html is an error, never a fallback to discovery')
    fs.rmSync(bundle, { recursive: true, force: true })
  } finally {
    if (saved === undefined) delete process.env.ORGTREE_RIG_UI
    else process.env.ORGTREE_RIG_UI = saved
  }
})

test('runDesktop refuses a headless run and starts nothing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-desk-'))
  const rig = { dir, url: 'http://127.0.0.1:9', token: 't', org: 'o', run: { ui: null } }
  // plain node in place of electron.exe: whatever happens, no window
  await assert.rejects(runDesktop(rig, path.join(dir, 'none.cjs'), { electron: process.execPath, out: path.join(dir, 'out'), timeout: 5000 }),
    /--ui/, 'a desk script on a run without a renderer bundle is refused')
  assert.equal(fs.existsSync(path.join(dir, 'electron.pid')), false, 'no desktop process was started')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('the desktop guards: clipboard permissions denied, clipboard APIs stubbed, copy keys refused', async () => {
  const g = require('../desktop/guards.cjs')
  for (const p of ['clipboard-read', 'clipboard-sanitized-write']) assert.equal(g.allowPermission(p), false, p)
  assert.equal(g.MUTE_SWITCH, 'mute-audio')

  // the page-side stub, in a page-like sandbox whose real clipboard records every write
  const real = []
  class Navigator {}
  Object.defineProperty(Navigator.prototype, 'clipboard', { configurable: true, get: () => ({ writeText: async t => { real.push(t) } }) })
  class Document { execCommand(cmd) { real.push('exec:' + cmd); return true } }
  const listeners = []
  const document = new Document()
  document.addEventListener = (type, fn, capture) => listeners.push({ type, fn, capture })
  const window = {}
  const ctx = vm.createContext({ Navigator, Document, navigator: new Navigator(), document, window })
  vm.runInContext(g.CLIPBOARD_STUB, ctx)
  await vm.runInContext('navigator.clipboard.writeText("secret")', ctx)
  assert.equal(await vm.runInContext('navigator.clipboard.readText()', ctx), 'secret', 'the app reads back its own copy')
  assert.equal(vm.runInContext('document.execCommand("copy")', ctx), false)
  assert.equal(vm.runInContext('document.execCommand("paste")', ctx), false)
  assert.deepEqual(real, [], 'nothing reached the real clipboard')
  for (const type of ['copy', 'cut', 'paste']) assert.ok(listeners.some(l => l.type === type && l.capture === true), `a capturing ${type} guard`)
  assert.equal(ctx.window.__rigClipboardGuard?.installed, true)

  // the driver's keys: Ctrl/Meta+C/X/V and Shift/Ctrl+Insert would reach the OS clipboard
  const CTRL = 2, META = 4, SHIFT = 8
  for (const [key, modifiers] of [['c', CTRL], ['x', CTRL], ['v', CTRL], ['C', META], ['Insert', CTRL], ['Insert', SHIFT]]) {
    assert.equal(g.refusedKey({ key, modifiers }), true, `${key} ${modifiers}`)
  }
  for (const [key, modifiers] of [['c', 0], ['a', CTRL], ['Enter', CTRL], ['v', SHIFT]]) {
    assert.equal(g.refusedKey({ key, modifiers }), false, `${key} ${modifiers}`)
  }
  assert.equal(g.refusedCdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'v', modifiers: CTRL }), true)
  assert.equal(g.refusedCdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'v', modifiers: 0 }), false)
  assert.equal(g.refusedCdp('Browser.grantPermissions', { permissions: ['clipboardReadWrite'] }), true)
  assert.equal(g.refusedCdp('Browser.setPermission', { permission: { name: 'clipboard-read' }, setting: 'granted' }), true)
  assert.equal(g.refusedCdp('Page.captureScreenshot', {}), false)
})

test('the stock desktop harness wires the guards in', () => {
  const main = fs.readFileSync(new URL('../desktop/main.cjs', import.meta.url), 'utf8')
  assert.match(main, /require\('\.\/guards\.cjs'\)/)
  assert.match(main, /appendSwitch\(guards\.MUTE_SWITCH\)/, 'Chromium starts muted')
  assert.match(main, /setAudioMuted\(true\)/, 'the window is muted')
  assert.match(main, /setPermissionRequestHandler/)
  assert.match(main, /setPermissionCheckHandler/)
  assert.match(main, /addScriptToEvaluateOnNewDocument[\s\S]*CLIPBOARD_STUB/, 'the stub runs at document start')
})
