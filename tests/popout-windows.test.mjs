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
const { popoutRegistry, parsePopoutFeatures, exactPopoutBounds, setExactPopoutBounds, configureWindow, revealPopout } = createRequire(import.meta.url)(out)

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

test('parsePopoutFeatures extracts minWidth and minHeight from popout features string', () => {
  assert.deepEqual(parsePopoutFeatures('popup,left=100,top=100,width=600,height=500,minWidth=320,minHeight=240'), {
    minWidth: 320, minHeight: 240,
  })
  assert.deepEqual(parsePopoutFeatures('popup,width=280,height=400,minWidth=200,minHeight=240'), {
    minWidth: 200, minHeight: 240,
  })
})

test('parsePopoutFeatures returns empty object when min dimensions are not declared', () => {
  assert.deepEqual(parsePopoutFeatures('popup,left=100,top=100,width=800,height=600'), {})
  assert.deepEqual(parsePopoutFeatures(''), {})
  assert.deepEqual(parsePopoutFeatures(undefined), {})
})

test('only explicit temporary desk geometry requests exact native bounds', () => {
  const fields = 'left=-1420,top=83,width=903,height=634'
  assert.deepEqual(exactPopoutBounds('popup,orgtreeExactRect=1,' + fields),
    {x: -1420, y: 83, width: 903, height: 634})
  assert.equal(exactPopoutBounds('popup,' + fields), null, 'ordinary pop-outs are unchanged')
  for (const bad of ['', 'left=1,top=2,width=0,height=3', 'left=1,top=2,width=4oops,height=3',
    'left=1,top=2,width=Infinity,height=3', 'left=1,top=2,width=4',
    'left=999999999999999,top=2,width=4,height=3']) {
    assert.equal(exactPopoutBounds('orgtreeExactRect=1,' + bad), null, bad)
  }
})

test('native creation applies the accepted rectangle once and only to its named child', () => {
  const make = () => {
    const events = new Map()
    let handler
    return {bounds: [], on() {}, isVisible: () => true, isMinimized: () => false,
      setBounds(rect) {this.bounds.push(rect)},
      getBounds() {return this.bounds.at(-1)},
      webContents: {getURL: () => 'http://127.0.0.1:1234/', setBackgroundThrottling() {},
        on(event, fn) {events.set(event, [...(events.get(event) ?? []), fn])},
        setWindowOpenHandler(fn) {handler = fn}},
      open(details) {return handler(details)},
      created(child, name) {for (const fn of events.get('did-create-window') ?? []) fn(child, {frameName: name, options: {}})},
    }
  }
  const parent = make(), first = make(), unrelated = make()
  configureWindow(parent, 'http://127.0.0.1:1234', true)
  const request = {url: 'about:blank', frameName: 'temporary-desk',
    features: 'popup,orgtreeExactRect=1,left=-1200,top=80,width=901,height=633'}
  assert.equal(parent.open(request).action, 'allow')
  parent.created(unrelated, 'another-desk')
  assert.deepEqual(unrelated.bounds, [])
  parent.created(first, 'temporary-desk')
  assert.deepEqual(first.bounds, [{x: -1200, y: 80, width: 901, height: 633}])
  parent.created(unrelated, 'temporary-desk')
  assert.deepEqual(unrelated.bounds, [], 'the placement is consumed at creation')
  parent.open(request)
  parent.open({...request, features: 'popup,width=500,height=400'})
  parent.created(unrelated, 'temporary-desk')
  assert.deepEqual(unrelated.bounds, [], 'an ordinary opening cannot inherit a failed placement')
})

test('native initial placement corrects measured frame drift and is bounded when the OS refuses', () => {
  const target = {x: -1000, y: 83, width: 901, height: 633}
  let actual, calls = 0
  setExactPopoutBounds({setBounds(rect) {calls++; actual = {...rect, x: rect.x - 1, width: rect.width + 2}},
    getBounds() {return actual}}, target)
  assert.deepEqual(actual, target)
  assert.equal(calls, 2, 'one measured frame adjustment is enough')
  calls = 0
  setExactPopoutBounds({setBounds() {calls++}, getBounds() {return {x: 0, y: 0, width: 300, height: 200}}}, target)
  assert.equal(calls, 3, 'an OS size constraint cannot cause an unbounded placement loop')
})

// ------------------------------------------------------- surfacing a window
// A presentation card whose document is already in one of these windows raises
// that window rather than opening a second reader (2026-09-14), which is the
// same native act as the placeholder's "Show window". The renderer cannot do
// any of it: it can only name the window.

/** A native window reduced to what revealPopout touches, recording the ORDER
 *  its calls arrived in — which is the whole of what that function decides. */
function fakeNativeWindow({ minimized = false } = {}) {
  const calls = []
  return {
    calls, minimized,
    isMinimized() { return this.minimized },
    restore() { calls.push('restore'); this.minimized = false },
    show() { calls.push('show') },
    focus() { calls.push('focus') },
  }
}

test('a minimized popout is restored BEFORE it is shown and focused', () => {
  const window = fakeNativeWindow({ minimized: true })
  assert.equal(revealPopout(window), true)
  // show() on a minimized window leaves it in the taskbar and focus() then
  // focuses something the user cannot see, so the order is the behaviour
  assert.deepEqual(window.calls, ['restore', 'show', 'focus'])
  assert.equal(window.minimized, false)
})

test('a window that is merely buried is shown and focused, and not disturbed further', () => {
  const window = fakeNativeWindow()
  assert.equal(revealPopout(window), true)
  assert.deepEqual(window.calls, ['show', 'focus'],
    'restore() must not be called on a window that was never minimized')
})

test('naming no window at all does nothing and says so', () => {
  // popoutRegistry answers `undefined` for an unknown name, a non-string, and a
  // window that has since gone — every one of those must be a no-op here
  // rather than an exception on the main process's IPC thread.
  for (const nothing of [undefined, null]) assert.equal(revealPopout(nothing), false)
  const registry = popoutRegistry(() => {})
  assert.equal(revealPopout(registry.window('never-opened')), false)
})

test('the name a command carries is the window revealPopout acts on', () => {
  const registry = popoutRegistry(() => {})
  const mine = fakeNativeWindow(), theirs = fakeNativeWindow()
  for (const w of [mine, theirs]) { w.isDestroyed = () => false; w.isMaximized = () => false; w.on = () => {}; w.once = () => {} }
  registry.track('orgtree-popout-1', mine)
  registry.track('orgtree-popout-2', theirs)
  revealPopout(registry.window('orgtree-popout-2'))
  assert.deepEqual(theirs.calls, ['show', 'focus'])
  assert.deepEqual(mine.calls, [], 'raising one presentation\'s window must never raise another\'s')
})
