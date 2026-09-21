// layoutnotify.test.tsx — the saved layout announces when it changes, and the
// transient borrow that must not look like a close.
//
// TWO SEAMS, ONE CAUSE. Both exist because the saved window layout was a
// localStorage store that nobody could observe and that one call site wrote
// unconditionally.
//
// §1 `saveWindow` notified nobody. A reader whose correctness depends on what
// the saved layout SAYS had no way to learn it had stopped saying it — and the
// case that exposed it is a FAILURE path, which is why no other signal covered
// it: when a restore fails, `MovableSurface` catches, redocks and calls
// `closeSavedWindow`, but nothing was ever registered in `windowlife`, so
// there is no unregister and no event at all. v3-attention-opus measured an
// indefinite hold in real Chromium.
//
// §2 `redock()` cleared the saved row unconditionally, so borrowing a detached
// desk into a modal and giving it back was recorded as the user closing it —
// and, less obviously, made the return land at a freshly computed position,
// because `popupFeatures` only consults the saved rect when
// `restoring || saved.open`.
//
// Run:  node apps/desktop/renderer/tests/run.mjs layoutnotify
// ⚠ THE HARNESS IS THE FIRST IMPORT, and it has to be. Its top-level code
// installs jsdom — and therefore localStorage — before any app module is
// reached; without it `windowlayout.ts` loads into a bare node global and
// every write throws ReferenceError. Importing shellbridge is not enough:
// that module only touches `window`, it does not create one.
import { flush } from './harness'
import { installBridge, removeBridge } from './shellbridge'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  captureWindow, closeSavedWindow, popupFeatures, saveWindow, savedWindows,
  subscribeWindowLayout, windowLayoutRevision, WINDOW_LAYOUT_KEY,
} from '../src/windowlayout'
import type { SavedWindow } from '../src/windowlayout'

declare const __SRC_DIR__: string
const src = (name: string) => fs.readFileSync(path.join(__SRC_DIR__, name), 'utf8')

void flush   // the import is for its jsdom side effect; this keeps it honest

const row = (key: string, patch: Partial<SavedWindow> = {}): SavedWindow => ({
  key, kind: 'desk', org: 'studio', open: true,
  rect: { x: 10, y: 20, width: 900, height: 760 }, ...patch,
})

/** Count notifications across one action. */
function watch(run: () => void): { calls: number; revBefore: number; revAfter: number } {
  let calls = 0
  const off = subscribeWindowLayout(() => { calls++ })
  const revBefore = windowLayoutRevision()
  try { run() } finally { off() }
  return { calls, revBefore, revAfter: windowLayoutRevision() }
}

// ------------------------------------------------- §1 the change event

test('a real write notifies, and the revision moves with it', () => {
  localStorage.clear()
  const r = watch(() => saveWindow(row('a')))
  assert.equal(r.calls, 1, 'one write, one notification')
  assert.equal(r.revAfter, r.revBefore + 1, 'the revision is what a store subscriber compares')
  assert.equal(savedWindows().length, 1, 'and the write actually happened')
})

test('an UNCHANGED write notifies nobody — no churn', () => {
  localStorage.clear()
  saveWindow(row('a'))
  // ⚠ this is the property that makes the notification cheap enough to put on
  // every writer: saveWindow already returns early when the row is
  // byte-identical to the stored one, so the notification sits after that
  // guard rather than needing an equality check of its own
  const r = watch(() => saveWindow(row('a')))
  assert.equal(r.calls, 0, 'writing the same row again is not a change')
  assert.equal(r.revAfter, r.revBefore, 'and the revision does not move')
})

test('an INVALID row is rejected before it can notify', () => {
  localStorage.clear()
  const r = watch(() => saveWindow({ ...row('bad'), rect: { x: 0, y: 0, width: 1, height: 1 } }))
  assert.equal(r.calls, 0, 'a row that cannot be persisted did not change the layout')
  assert.equal(savedWindows().length, 0)
})

test('EVERY writer publishes, which is what makes a new writer safe by construction', () => {
  localStorage.clear()
  saveWindow(row('a'))
  // closeSavedWindow is the one that matters: it is the call a FAILED restore
  // makes, and it was the write that reached no reader at all
  const closed = watch(() => closeSavedWindow('a'))
  assert.equal(closed.calls, 1, 'closing a saved window is a layout change')
  assert.equal(savedWindows().find((r) => r.key === 'a')?.open, false)

  // captureWindow is desktop-only — it early-returns without a bridge, which
  // is itself worth pinning, so check both sides of that gate
  const fake = { screenX: 1, screenY: 2, outerWidth: 800, outerHeight: 600 } as unknown as Window
  const noBridge = watch(() => captureWindow('b', 'desk', 'studio', fake))
  assert.equal(noBridge.calls, 0, 'a browser saves no window layout, so there is nothing to announce')
  const bridge = installBridge({})
  try {
    const captured = watch(() => captureWindow('b', 'desk', 'studio', fake))
    assert.equal(captured.calls, 1, 'capturing a window is a layout change too')
  } finally { removeBridge(bridge) }
})

test('closing something that was never saved changes nothing and says nothing', () => {
  localStorage.clear()
  const r = watch(() => closeSavedWindow('never-existed'))
  assert.equal(r.calls, 0, 'there was no row to flip')
})

test('unsubscribing really stops the notifications', () => {
  localStorage.clear()
  let calls = 0
  const off = subscribeWindowLayout(() => { calls++ })
  saveWindow(row('a'))
  assert.equal(calls, 1)
  off()
  saveWindow(row('b'))
  assert.equal(calls, 1, 'a listener that unsubscribed hears nothing further')
})

test('the store shape mirrors windowlife, so a consumer has nothing new to learn', () => {
  // useSyncExternalStore(subscribeWindowLayout, windowLayoutRevision, windowLayoutRevision)
  assert.equal(typeof subscribeWindowLayout(() => {}), 'function', 'subscribe returns its own teardown')
  assert.equal(typeof windowLayoutRevision(), 'number')
  const life = src('windowlife.ts')
  assert.match(life, /export const subscribeWindows/, 'the shape being mirrored still exists')
  assert.match(life, /export const windowRevision/)
})

// --------------------------------------------- §2 the transient borrow

test('the borrow flag is NOT reachable from an event handler', () => {
  const popout = src('popout.tsx')
  // ⚠ THE BUG THIS PINS. `redock` is wired straight to onClick in two places.
  // While it was one function taking `(transient = false)`, React handed it a
  // MouseEvent as that argument — truthy — so every "Return here" click was a
  // borrow that never cleared the saved row. The typechecker caught it; this
  // keeps it caught.
  assert.match(popout, /const redock = \(\) => returnHome\(false\)/,
    'the public form takes no arguments, so no event can tell it to borrow')
  assert.match(popout, /const returnHome = \(transient: boolean\) =>/,
    'the flag lives on an internal helper')
  assert.doesNotMatch(popout, /const redock = \(transient/,
    'and must never go back to being a defaulted parameter on the public one')
})

test('only a NON-transient return clears the saved row', () => {
  const popout = src('popout.tsx')
  assert.match(popout, /if \(!transient\) closeSavedWindow\(layoutKey\)/,
    'the single line that separates a borrow from a dismissal')
  // and the borrow goes through the same path, so the two cannot drift apart
  assert.match(popout, /returnHome\(true\)/, 'borrow reuses the ordinary return')
})

test('the return re-detaches as a RESTORE, which is what carries the geometry home', () => {
  const popout = src('popout.tsx')
  // `popupFeatures` consults the saved rect when `restoring || saved.open`.
  // A borrow leaves `saved.open` true AND the return passes restoring — either
  // disjunct alone would do, and depending on both is deliberate belt and
  // braces on the property that actually failed.
  assert.match(popout, /returned = true[\s\S]{0,400}?open\(true\)/,
    'the returned closure re-opens with restoring set')
  const layout = src('windowlayout.ts')
  assert.match(layout, /if \(saved\?\.rect && \(restoring \|\| saved\.open\)\)/,
    'the condition the borrow depends on is unchanged')
})

test('the saved rect really is what a restoring re-open uses', () => {
  localStorage.clear()
  saveWindow(row('desk:1', { rect: { x: 321, y: 123, width: 640, height: 480 } }))
  // this is the geometry half of "restore exact prior placement": with the row
  // still open, the features string carries the saved position rather than a
  // freshly computed one
  const features = popupFeatures('desk:1', { x: 0, y: 0, w: 100, h: 100 },
    { screenX: 0, screenY: 0 })
  assert.match(features, /left=321/)
  assert.match(features, /top=123/)
  assert.match(features, /width=640/)
  assert.match(features, /height=480/)

  // …and once the row is closed, as an ordinary redock does, it does not
  closed()
  function closed() {
    closeSavedWindow('desk:1')
    const after = popupFeatures('desk:1', { x: 0, y: 0, w: 100, h: 100 },
      { screenX: 0, screenY: 0 })
    assert.doesNotMatch(after, /left=321/,
      'a dismissed window is NOT restored to its old place — which is why a borrow must not look like one')
  }
})

test('borrowing something that is not detached is a no-op, not an error', () => {
  const popout = src('popout.tsx')
  assert.match(popout, /if \(!child\.current \|\| child\.current\.closed\) return \(\) => \{\}/,
    'no native window in play means nothing for this file to do')
})

test('the four failure-recovery redock sites are untouched', () => {
  const popout = src('popout.tsx')
  // Agreed with v3-effort-opus and multi-window-design: recording "Window
  // styling failed. Your surface was returned." as the user closing the panel
  // is the same smell, but it is EXISTING behaviour and folding it into the
  // borrow seam would make it an unreviewed extra. It gets its own item or it
  // stays as it is.
  const recoveries = [...popout.matchAll(/Window styling failed\. Your surface was returned\.'\); redock\(\)/g)]
  assert.ok(recoveries.length >= 3,
    'the failure-recovery path still calls the ordinary redock, unchanged')
  assert.doesNotMatch(popout, /Window styling failed[^\n]*returnHome\(true\)/,
    'and no failure path was quietly converted into a borrow')
})

test('the layout key is unchanged, so no saved arrangement is orphaned', () => {
  assert.equal(WINDOW_LAYOUT_KEY, 'orgtree-desktop-windows-v1')
})
