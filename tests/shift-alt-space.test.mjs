import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
const require = createRequire(process.env.ORGTREE_TEST_DEPS || new URL('../package.json', import.meta.url))
const { transformSync } = require('esbuild')
const source = fs.readFileSync('apps/desktop/main/shift-alt-space.ts', 'utf8')
const module = { exports: {} }
vm.runInNewContext(transformSync(source, { loader: 'ts', format: 'cjs' }).code,
  { module, exports: module.exports, process, setImmediate, clearImmediate })
const { installShiftAltSpace } = module.exports
function fixture(platform = 'win32') {
  const window = new EventEmitter(), contents = new EventEmitter(), hooks = new Map(), sent = []
  window.webContents = contents
  contents.isDestroyed = () => false
  contents.sendInputEvent = input => sent.push(input)
  window.hookWindowMessage = (id, callback) => hooks.set(id, callback)
  installShiftAltSpace(window, platform)
  const input = (patch = {}) => contents.emit('before-input-event', {},
    { type: 'keyDown', key: 'Alt', code: 'AltLeft', shift: true, alt: true, control: false, meta: false, ...patch })
  const native = (message = 0x106, word = 32, bits = 0x20390001) => {
    const w = Buffer.alloc(8), l = Buffer.alloc(8); w.writeUInt32LE(word); l.writeUInt32LE(bits)
    hooks.get(message)?.(w, l)
  }
  const menu = () => { let cancelled = false; window.emit('system-context-menu', { preventDefault() { cancelled = true } }); return cancelled }
  return { window, contents, hooks, sent, input, native, menu }
}
test('native Shift Alt Space cancels the system menu and forwards its missing renderer chord', () => {
  const f = fixture(); f.input(); f.native(); assert.equal(f.menu(), true)
  assert.equal(f.sent.length, 2); assert.equal(f.sent[0].type, 'keyDown'); assert.equal(f.sent[0].keyCode, 'Space')
})
test('plain Alt Space, AltGr and meta variants retain their system menu', () => {
  for (const patch of [{ shift: false }, { control: true }, { meta: true }]) {
    const f = fixture(); f.input(patch); f.native(); assert.equal(f.menu(), false); assert.equal(f.sent.length, 0)
  }
})
test('titlebar and other character requests stay native even with both modifiers held', () => {
  const f = fixture(); f.input()
  for (const message of [0x7b, 0xa5, 0x205]) { f.native(); f.native(message); assert.equal(f.menu(), false) }
  f.native(0x106, 65); assert.equal(f.menu(), false)
  assert.equal(f.sent.length, 0)
})
test('blur, modifier release and another window cannot reuse held modifiers', () => {
  const f = fixture(), other = fixture(); f.input(); other.native(); assert.equal(other.menu(), false)
  f.window.emit('blur'); f.native(); assert.equal(f.menu(), false)
  for (const key of ['Shift', 'Alt']) { f.input(); f.input({ type: 'keyUp', key }); f.native(); assert.equal(f.menu(), false) }
})
test('held-key repeats and an already delivered Space never run Fit twice', () => {
  const f = fixture(); f.input(); f.native(0x106, 32, 0x60390001); assert.equal(f.menu(), true); assert.equal(f.sent.length, 0)
  f.input({ key: ' ', code: 'Space' }); f.native(); assert.equal(f.menu(), true); assert.equal(f.sent.length, 0)
})
test('native marker expires and non-Windows windows install nothing', async () => {
  const f = fixture(); f.input(); f.native(); await new Promise(setImmediate); assert.equal(f.menu(), false)
  assert.equal(fixture('linux').hooks.size, 0)
})
test('every main-process BrowserWindow including popouts gets the same interceptor', () => {
  const index = fs.readFileSync('apps/desktop/main/index.ts', 'utf8')
  const start = index.indexOf("app.on('browser-window-created'")
  assert.ok(start >= 0); assert.match(index.slice(start, index.indexOf('\n  })', start)), /installShiftAltSpace\(window\)/)
})
