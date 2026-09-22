// popoutrecovery.test.tsx — a FAILED pop-out, route by route.
//
// Docket item a-failed-pop-out-forgets-the-window-the-user-had asked whether
// the four failure routes in `MovableSurface` should keep or clear the saved
// window row. They CLEAR it, deliberately — the reasons are written beside
// `recover` in popout.tsx. What this file pins is that each of the four really
// reaches that decision, and that the user is told the truth about it:
//
//   route (1) a later style sync throws, seen by the MutationObserver
//   route (2) the same, seen by the 500 ms CSSOM poll
//   route (3) `restoreWhenStyled` sees a stylesheet fail
//   route (4) `open()` itself throws — here, a blocked window
//
// For each one: the surface comes back into the main document, the saved row
// ends `open: false` with its rect STILL THERE (it is marked closed, not
// erased), and the error says the window will not reopen by itself and will
// not use its old position. §5 is the other half of "the truth": a failure
// that had no saved window to lose must not claim it lost one.
//
// A route switched to `returnHome(true)` fails its own test here: the row
// stays open and the sentence about the saved window is missing.
//
// Run:  node apps/desktop/renderer/tests/run.mjs popoutrecovery
import { flush, inAct, mountView } from './harness'
import { installBridge, removeBridge } from './shellbridge'
import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { MovableSurface, PopoutButton } from '../src/popout'
import { captureWindow, savedWindows, windowLayoutKey } from '../src/windowlayout'

const KIND = 'recovery-fixture', ORG = 'org'
const KEY = windowLayoutKey(KIND, ORG)
const NOT_RESTORED = /will not reopen automatically, and popping it out again will not use its previous position\./
const STYLING = /^Window styling failed\. Your surface was returned\./
const row = () => savedWindows().find(r => r.key === KEY)

interface Rig {
  cw: Window
  el: HTMLElement
  input: HTMLInputElement
  alert: () => string
  unmount: () => Promise<void>
}

/** Mount one surface. `saved` pre-records it as an OPEN window at a known
 *  place, which is what the startup restore reads; `blocked` makes
 *  `window.open` return null the way a refused pop-up does. */
async function rig({ saved, blocked = false }: { saved: boolean; blocked?: boolean }): Promise<Rig> {
  localStorage.clear()
  // ⚠ THE BRIDGE IS LOAD-BEARING: without `desktop()` no saved row is ever
  // written and every row assertion below passes vacuously against undefined.
  // No `getWindowState`, so `useRestoreWindows` allows restoring at once.
  installBridge({})
  const child = new JSDOM('<html><head></head><body></body></html>', { url: 'http://localhost/' })
  const cw = child.window as unknown as Window
  Object.defineProperties(cw, { screenX: { value: 200 }, screenY: { value: 180 }, outerWidth: { value: 830 }, outerHeight: { value: 700 } })
  // rAF never fires, so `restoreWhenStyled` stays pending until a test acts
  cw.focus = () => {}; cw.requestAnimationFrame = () => 1; cw.cancelAnimationFrame = () => {}
  const originalOpen = window.open
  window.open = (() => blocked ? null : cw) as typeof window.open
  const g = globalThis as unknown as { MutationObserver?: typeof MutationObserver }
  const originalObserver = g.MutationObserver
  g.MutationObserver = (window as unknown as { MutationObserver: typeof MutationObserver }).MutationObserver
  if (saved) captureWindow(KEY, KIND, ORG, cw, true)
  const v = await mountView(<MovableSurface kind={KIND} org={ORG} title="Fixture">
    <input aria-label="kept" defaultValue="draft" /><PopoutButton />
  </MovableSurface>, el => el)
  await inAct(async () => { await flush(10) })
  const input = (v.el.querySelector('input') ?? cw.document.querySelector('input'))!
  // the child's document is gone once recovery closes the window
  const alert = () => (v.el.querySelector('[role="alert"]') ?? cw.document?.querySelector('[role="alert"]'))?.textContent ?? ''
  return {
    cw, el: v.el, input, alert,
    unmount: async () => {
      await v.unmount(); window.open = originalOpen; g.MutationObserver = originalObserver
      removeBridge(); child.window.close(); localStorage.clear()
    },
  }
}

/** Make every later style sync throw, the way an inaccessible document does.
 *  `syncStyles` writes the child's root className first thing. */
function breakStyling(cw: Window) {
  Object.defineProperty(cw.document.documentElement, 'className', {
    configurable: true, get: () => '', set: () => { throw new Error('styling broke') },
  })
}

/** The shared post-condition of every route that had a saved window. */
function assertRecovered(r: Rig, message: RegExp) {
  assert.ok(r.el.contains(r.input), 'the same surface is back in the main document')
  assert.ok(r.cw.closed || !r.cw.document?.querySelector('input'), 'and the failed window no longer holds it')
  const saved = row()
  assert.ok(saved, 'the saved row still exists')
  assert.equal(saved.open, false, 'a failure CLEARS the row — see recover() in popout.tsx for why')
  assert.deepEqual(saved.rect, { x: 200, y: 180, width: 830, height: 700 },
    'marked closed, NOT erased: the coordinates are kept, which is why the text must not say they were deleted')
  assert.match(r.alert(), message, 'the error still says what failed')
  assert.match(r.alert(), NOT_RESTORED, 'and says what happened to the saved window')
}

test('§0 positive control: the restore really lands in the window before anything breaks', async () => {
  const r = await rig({ saved: true })
  try {
    assert.equal(r.cw.document.querySelector('input'), r.input, 'the surface is in the child window')
    assert.equal(row()?.open, true)
    assert.equal(r.alert(), '')
  } finally { await r.unmount() }
})

test('§1 route (1): a style sync that throws on a head mutation clears the row and says so', async () => {
  const r = await rig({ saved: true })
  try {
    breakStyling(r.cw)
    const style = document.createElement('style')
    // well inside the 500 ms poll, so this can only be the observer's route
    await inAct(async () => { document.head.appendChild(style); await flush(5) })
    style.remove()
    assertRecovered(r, STYLING)
  } finally { await r.unmount() }
})

test('§2 route (2): the same failure found by the CSSOM poll, with no mutation at all', async () => {
  const r = await rig({ saved: true })
  try {
    breakStyling(r.cw)
    assert.equal(row()?.open, true, 'nothing has noticed yet — no mutation was made')
    await inAct(async () => { await new Promise(res => setTimeout(res, 650)); await flush(5) })
    assertRecovered(r, STYLING)
  } finally { await r.unmount() }
})

test('§3 route (3): a stylesheet that fails to load while the restore waits', async () => {
  const r = await rig({ saved: true })
  try {
    const link = r.cw.document.createElement('link'); link.rel = 'stylesheet'
    r.cw.document.head.appendChild(link)
    await inAct(async () => {
      link.dispatchEvent(new (r.cw as unknown as { Event: typeof Event }).Event('error'))
      await flush(5)
    })
    assertRecovered(r, STYLING)
  } finally { await r.unmount() }
})

test('§4 route (4): a blocked window on the startup restore', async () => {
  const r = await rig({ saved: true, blocked: true })
  try {
    // the restore ran on mount and failed synchronously inside open()
    assertRecovered(r, /^The browser blocked this window\./)
  } finally { await r.unmount() }
})

test('§5 a failure with NO saved window to lose does not claim it lost one', async () => {
  const r = await rig({ saved: false, blocked: true })
  try {
    assert.equal(row(), undefined, 'nothing saved before the attempt')
    const button = r.el.querySelector<HTMLButtonElement>('button[aria-label="Open in new window"]')!
    await inAct(async () => { button.click(); await flush(5) })
    assert.match(r.alert(), /^The browser blocked this window\./, 'the failure is still reported')
    assert.doesNotMatch(r.alert(), NOT_RESTORED, 'but nothing about a saved window, because there was none')
    assert.equal(row(), undefined, 'and no row was invented')
  } finally { await r.unmount() }
})
