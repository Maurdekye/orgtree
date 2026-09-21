// What happens when a main window is asked to close, driven directly.
//
// The invariant is stronger than "the popouts survive a refused close", and
// the stronger form is what review f3 asked for: A REFUSED CLOSE LEAVES THE
// RECORD EXACTLY AS IT WAS. Popouts open, reopen membership intact,
// `tearingDown` false. A test that only checked the children would pass over
// the flag, which was set on windows that were never torn down and never
// reset — so every later reader of it was reading a lie.
//
// And the mirror of it matters just as much: an ACCEPTED close must still tear
// down. Without that, a fix could satisfy every refusal test by never tearing
// down at all.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'
import { createRequire } from 'node:module'

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-window-close-test-'))
const out = path.join(temp, 'window-close.cjs')
await build({ entryPoints: ['apps/desktop/main/window-close.ts'], outfile: out, bundle: true, platform: 'node', format: 'cjs' })
const { performClose } = createRequire(import.meta.url)(out)

/** A record in the state it is in before the close, plus the calls made. */
const host = () => {
  const state = {
    prevented: false, hidden: false, quit: false, confirmed: false,
    // the record, exactly as the window factory holds it
    tearingDown: false, popoutsOpen: 3, inReopenSet: true,
  }
  return {
    state,
    preventDefault() { state.prevented = true },
    hide() { state.hidden = true },
    quit() { state.quit = true },
    confirmDiscard() { state.confirmed = true },
    teardown() {
      state.tearingDown = true
      state.inReopenSet = false
      state.popoutsOpen = 0
    },
  }
}
const UNTOUCHED = { tearingDown: false, popoutsOpen: 3, inReopenSet: true }
const record = s => ({ tearingDown: s.tearingDown, popoutsOpen: s.popoutsOpen, inReopenSet: s.inReopenSet })

const inputs = over => ({
  quitting: false, creation: 'close', otherMainsVisible: false,
  exitOnClose: false, otherViews: 0, ...over,
})

// ------------------------------------------------- refused closes touch nothing

test('REFUSED (tray hide): the record is left exactly as it was', () => {
  // exitOnClose off, last visible main window: closeAction says hide. The
  // window survives — so everything about it must survive too. This is the
  // path a user takes every day.
  const h = host()
  assert.equal(performClose(inputs({ exitOnClose: false }), h), 'hide')
  assert.equal(h.state.prevented, true)
  assert.equal(h.state.hidden, true)
  assert.deepEqual(record(h.state), UNTOUCHED,
    'popouts open, still in the reopen set, tearingDown false')
})

test('REFUSED (unfinished creation form): the record is left exactly as it was', () => {
  // The confirmation is on screen and the user has not answered. Tearing
  // anything down here defeats the confirmation entirely.
  const h = host()
  assert.equal(performClose(inputs({ creation: 'confirm' }), h), 'confirm')
  assert.equal(h.state.prevented, true)
  assert.equal(h.state.confirmed, true)
  assert.deepEqual(record(h.state), UNTOUCHED)
})

test('REFUSED (a confirmation is already up): nothing is asked twice and nothing is torn down', () => {
  const h = host()
  assert.equal(performClose(inputs({ creation: 'awaiting' }), h), 'refuse')
  assert.equal(h.state.prevented, true)
  assert.equal(h.state.confirmed, false, 'the standing question stays the only one')
  assert.deepEqual(record(h.state), UNTOUCHED)
})

test('REFUSED (exitOnClose quit): the record is left as it was; the quit path does the teardown', () => {
  // closeAction says quit, so this close is refused and app.quit() takes over.
  // before-quit captures the open set before teardown; tearing down here would
  // empty it first.
  const h = host()
  assert.equal(performClose(inputs({ exitOnClose: true }), h), 'quit')
  assert.equal(h.state.prevented, true)
  assert.equal(h.state.quit, true)
  assert.deepEqual(record(h.state), UNTOUCHED)
})

test('NEGATIVE CONTROL: no refusal path tears anything down, on any combination', () => {
  // Exhaustive over the inputs that can refuse, because the original defect
  // was not one bad branch - it was a second listener running under all of
  // them.
  for (const creation of ['close', 'confirm', 'awaiting']) {
    for (const exitOnClose of [true, false]) {
      for (const otherViews of [0, 2]) {
        const h = host()
        const outcome = performClose(inputs({ creation, exitOnClose, otherViews }), h)
        if (outcome === 'proceed') continue
        assert.deepEqual(record(h.state), UNTOUCHED,
          `${outcome} with creation=${creation} exitOnClose=${exitOnClose} otherViews=${otherViews}`)
        assert.equal(h.state.prevented, true, 'every refusal actually refuses')
      }
    }
  }
})

// ------------------------------------------- and an accepted close still acts

test('ACCEPTED: closing one of several windows closes it, and tears down its own state', () => {
  // The mirror of every test above. Without this, a fix could pass them all by
  // never tearing down at all.
  const h = host()
  assert.equal(performClose(inputs({ otherMainsVisible: true }), h), 'proceed')
  assert.equal(h.state.prevented, false, 'the close is not refused')
  assert.equal(h.state.hidden, false, 'and one of several is closed, not hidden')
  assert.deepEqual(record(h.state), { tearingDown: true, popoutsOpen: 0, inReopenSet: false })
})

test('the existing exitOnClose rule is reached unchanged, including its other-views case', () => {
  // closeAction's own rule, v2 verbatim: exitOnClose QUITS only when nothing
  // else is visible. With a popout still on screen the last main window hides
  // instead, because quitting would take that popout with it. Asserted here
  // because the multi-window change could plausibly have altered which windows
  // count, and it did not - `otherViews` is still every visible window, popouts
  // and artifact viewers included.
  const quits = host()
  assert.equal(performClose(inputs({ exitOnClose: true, otherViews: 0 }), quits), 'quit')
  const hides = host()
  assert.equal(performClose(inputs({ exitOnClose: true, otherViews: 1 }), hides), 'hide')
  assert.deepEqual(record(hides.state), UNTOUCHED, 'and a hide is still a refusal')
})

test('ACCEPTED during a shutdown: the close proceeds and does not stop to ask', () => {
  // The quit has already confirmed every unfinished form, once, before it
  // began. Asking again here would put the same question up per window.
  const h = host()
  assert.equal(performClose(inputs({ quitting: true, creation: 'confirm' }), h), 'proceed')
  assert.equal(h.state.confirmed, false, 'a shutdown does not re-ask')
  assert.equal(h.state.prevented, false)
  assert.equal(h.state.tearingDown, true)
})

test('the tray-retention rule belongs to the LAST window only', () => {
  // With another main window visible, exitOnClose never gets a say: closing
  // one of several closes it.
  for (const exitOnClose of [true, false]) {
    const h = host()
    assert.equal(performClose(inputs({ otherMainsVisible: true, exitOnClose }), h), 'proceed', String(exitOnClose))
    assert.equal(h.state.hidden, false)
    assert.equal(h.state.quit, false)
  }
})
