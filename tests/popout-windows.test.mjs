// Which native window a popped-out desk or modal's window command acts on.
// A popout's React handlers run in the MAIN window's realm, so every command
// arrives from the main window's bridge naming the window it meant; getting
// that name wrong means minimizing or closing somebody else's window.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'
import { createRequire } from 'node:module'

const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-popout-')), 'windows.cjs')
// 'electron' is stubbed, not bundled and not left external: outside an Electron
// process the real package resolves to the path of its own binary and refuses
// to load, while the registry under test reads nothing off it at all. The
// native window behaviour this module also contains is measured separately, in
// a real Electron window, by tools/test-popout-header-regions.mjs.
const stubElectron = {
  name: 'stub-electron',
  setup(builder) {
    builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub-electron' }))
    builder.onLoad({ filter: /.*/, namespace: 'stub-electron' }, () => ({ contents: 'module.exports = {}', loader: 'js' }))
  },
}
await build({ entryPoints: ['apps/desktop/main/windows.ts'], outfile: out, bundle: true, platform: 'node', format: 'cjs', plugins: [stubElectron] })
const { popoutRegistry } = createRequire(import.meta.url)(out)

/** A native window reduced to what the registry reads, plus the levers a test
 *  needs: it can be maximized, it can be destroyed, and it can fire its own
 *  events the way a user action does. */
function fakeWindow({ maximized = false } = {}) {
  const listeners = new Map()
  return {
    destroyed: false,
    maximized,
    isDestroyed() { return this.destroyed },
    isMaximized() { return this.maximized },
    on(event, listener) { listeners.set(event, [...(listeners.get(event) ?? []), listener]) },
    once(event, listener) { this.on(event, listener) },
    fire(event) { for (const listener of listeners.get(event) ?? []) listener() },
    events: listeners,
  }
}

test('a command reaches the window its name refers to, and no other', () => {
  const registry = popoutRegistry(() => {})
  const first = fakeWindow(), second = fakeWindow()
  registry.track('orgtree-popout-1', first)
  registry.track('orgtree-popout-2', second)
  assert.equal(registry.window('orgtree-popout-1'), first)
  assert.equal(registry.window('orgtree-popout-2'), second)
  assert.equal(registry.window('orgtree-popout-3'), undefined, 'an unknown name must resolve to nothing, not to a window')
})

test('anything that is not a known string name resolves to nothing', () => {
  const registry = popoutRegistry(() => {})
  const window = fakeWindow()
  registry.track('orgtree-popout-1', window)
  for (const name of [undefined, null, 42, {}, ['orgtree-popout-1'], '']) assert.equal(registry.window(name), undefined, String(name))
  assert.equal(registry.window('orgtree-popout-1'), window, 'the control: the real name still resolves')
})

test('a window opened as _blank is never addressable', () => {
  const registry = popoutRegistry(() => {})
  const stranger = fakeWindow()
  registry.track('', stranger)
  assert.equal(registry.window(''), undefined)
  assert.equal(stranger.events.size, 0, 'and nothing is subscribed to a window that was never taken')
})

test('a window that has gone resolves to nothing, and says so in its state', () => {
  const registry = popoutRegistry(() => {})
  const window = fakeWindow()
  registry.track('orgtree-popout-1', window)
  assert.deepEqual(registry.state('orgtree-popout-1'), { name: 'orgtree-popout-1', present: true, maximized: false })
  window.destroyed = true
  assert.equal(registry.window('orgtree-popout-1'), undefined)
  assert.deepEqual(registry.state('orgtree-popout-1'), { name: 'orgtree-popout-1', present: false, maximized: false })
  assert.deepEqual(registry.state('never-opened'), { name: 'never-opened', present: false, maximized: false })
})

test('state reports what the window is, so the header can draw restore or maximize', () => {
  const registry = popoutRegistry(() => {})
  const window = fakeWindow({ maximized: true })
  registry.track('orgtree-popout-1', window)
  assert.equal(registry.state('orgtree-popout-1').maximized, true)
  window.maximized = false
  assert.equal(registry.state('orgtree-popout-1').maximized, false)
})

test('every way the window can change size is published, including the ones no click handler sees', () => {
  const published = []
  const registry = popoutRegistry(state => published.push(state))
  const window = fakeWindow()
  registry.track('orgtree-popout-1', window)
  window.maximized = true
  window.fire('maximize')                       // also how a double-click on the drag region arrives
  window.maximized = false
  window.fire('unmaximize')
  window.fire('minimize')
  window.fire('restore')
  assert.deepEqual(published.map(state => state.maximized), [true, false, false, false])
  assert.ok(published.every(state => state.name === 'orgtree-popout-1' && state.present))
})

test('a window that is already gone publishes nothing', () => {
  const published = []
  const registry = popoutRegistry(state => published.push(state))
  const window = fakeWindow()
  registry.track('orgtree-popout-1', window)
  window.fire('maximize')
  assert.equal(published.length, 1, 'the control: a live window does publish')
  window.destroyed = true
  window.fire('maximize')
  assert.equal(published.length, 1)
})

test('closing forgets the window - but only if it is still the one holding the name', () => {
  const registry = popoutRegistry(() => {})
  const first = fakeWindow()
  registry.track('orgtree-popout-1', first)
  first.fire('closed')
  assert.equal(registry.window('orgtree-popout-1'), undefined)

  const reopened = fakeWindow(), replaced = fakeWindow()
  registry.track('orgtree-popout-2', reopened)
  registry.track('orgtree-popout-2', replaced)
  reopened.fire('closed')
  assert.equal(registry.window('orgtree-popout-2'), replaced,
    'the earlier window closing must not disable the controls of the one that took its name')
})
