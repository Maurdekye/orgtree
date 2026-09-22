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

test('a stale handle is INERT — it cannot resurrect a window past a boundary', () => {
  const popout = src('popout.tsx')
  // ⚠ THE DEFECT multi-window-design FOUND. The first version guarded only
  // with a local `returned` boolean, which stops the handle being used twice
  // and says nothing about the world moving on underneath it. An ordinary
  // redock, an unmount and any other open all bump the epoch — and each has
  // already cleared or reconciled the saved row — so a handle used after one
  // of those would have reopened a window the user had closed, at geometry
  // no longer recorded.
  assert.match(popout, /const mine = epoch\.current/,
    'the epoch is captured after the borrow own increment')
  assert.match(popout, /if \(done \|\| epoch\.current !== mine\) return false/,
    'and both the double-use and the boundary-crossed cases are refused')
  // the epoch really is bumped by each boundary, which is what makes the
  // check above mean anything
  assert.match(popout, /const returnHome = \(transient: boolean\) => \{[\s\S]{0,400}?epoch\.current\+\+/,
    'an ordinary redock bumps it')
  assert.match(popout, /const open = \(restoring = false\) => \{[\s\S]{0,200}?\+\+epoch\.current/,
    'so does opening')
  assert.match(popout, /useEffect\(\(\) => \(\) => \{[\s\S]{0,400}?epoch\.current\+\+/,
    'and so does unmount')
})

test('the live geometry is captured BEFORE the window is closed', () => {
  const popout = src('popout.tsx')
  // ⚠ THE SECOND DEFECT. The saved rect is sampled on a 250 ms poll, so a
  // move or resize immediately before a borrow was never recorded — and
  // returnHome closes the child, after which the real bounds are gone. The
  // return would then restore the previous SAMPLE rather than where the
  // window actually was.
  assert.match(popout, /captureWindow\(layoutKey, kind, org, w, true, latest\.current\.restore\)\s+returnHome\(true\)/,
    'capture first, then close — in that order, which is the whole fix')
  assert.match(popout, /window\.setInterval\(\(\) => \{ if \(w\?\.closed\) onGone\(\); else if \(w\) captureWindow/,
    'the 250ms sampling this compensates for still exists')
})

test('a borrow ends in exactly one of two ways, and both are idempotent', () => {
  const popout = src('popout.tsx')
  // ⚠ TWO OUTCOMES BECAUSE THERE REALLY ARE TWO, and fusing them was the
  // ambiguity v3-effort-opus hit: a borrow whose destination is gone must
  // not `restore` (it would resurrect a window with nowhere valid to be) and
  // must not simply stop (that leaves the saved row claiming a window that
  // does not exist).
  assert.match(popout, /restore: \(\) => \{ if \(claim\(\)\) open\(true\) \}/)
  assert.match(popout, /release: \(\) => \{ if \(claim\(\)\) closeSavedWindow\(layoutKey\) \}/)
  // one `claim` serves both, so they are mutually exclusive by construction
  // rather than by two flags somebody has to keep in step
  assert.match(popout, /const claim = \(\): boolean => \{/)
  const life = src('windowlife.ts')
  assert.match(life, /borrow\?: \(\) => BorrowedSurface/)
  assert.match(life, /export interface BorrowedSurface \{/)
})

test('the return re-detaches as a RESTORE, which is what carries the geometry home', () => {
  const popout = src('popout.tsx')
  // `popupFeatures` consults the saved rect when `restoring || saved.open`.
  // A borrow leaves `saved.open` true AND the return passes restoring — either
  // disjunct alone would do, and depending on both is deliberate belt and
  // braces on the property that actually failed.
  assert.match(popout, /restore: \(\) => \{ if \(claim\(\)\) open\(true\) \}/,
    'the restore path re-opens with restoring set')
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
  assert.match(popout, /if \(!w \|\| w\.closed\) return inert/,
    'no native window in play means nothing for this file to do')
  assert.match(popout, /const inert: BorrowedSurface = \{ restore: \(\) => \{\}, release: \(\) => \{\} \}/,
    'and the caller still gets a usable handle rather than having to null-check')
})

test('the four failure-recovery routes clear the row through the ordinary redock, not the borrow', () => {
  const popout = src('popout.tsx')
  // This was left out of the borrow seam on purpose and given its own item
  // (a-failed-pop-out-forgets-the-window-the-user-had). That item DECIDED the
  // failure routes clear the row — the reasons sit beside `recover` in
  // popout.tsx — and routed all four through that one helper. Its behaviour,
  // route by route, is pinned in popoutrecovery.test.tsx; this keeps the
  // seam-level half: recovery is a dismissal, never a borrow.
  const routes = [...popout.matchAll(/recover\([^\n]*\)[^\n]*\/\/ failure route \((\d)\)|\/\/ failure route \((\d)\)\r?\n\s*recover\(/g)]
  assert.deepEqual(routes.map((m) => m[1] ?? m[2]).sort(), ['1', '2', '3', '4'],
    'each of the four failure routes goes through recover()')
  assert.match(popout, /const recover = \(message: string\) => \{[\s\S]{0,300}?\bredock\(\)/,
    'and recover() uses the ordinary redock, which clears the saved row')
  assert.doesNotMatch(popout, /const recover = \(message: string\) => \{[\s\S]{0,300}?returnHome\(true\)/,
    'no failure path was quietly converted into a borrow')
  assert.doesNotMatch(popout, /setError\('Window styling failed/,
    'no styling failure bypasses recover() with its own inline redock')
})

test('the layout key is unchanged, so no saved arrangement is orphaned', () => {
  assert.equal(WINDOW_LAYOUT_KEY, 'orgtree-desktop-windows-v1')
})
