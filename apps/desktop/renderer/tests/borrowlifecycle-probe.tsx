// borrowlifecycle-probe.tsx — the borrow seam EXECUTED, not source-pinned.
//
// multi-window-design's review said the quiet part out loud: my borrow tests
// "mostly inspect source strings or call popupFeatures on a manually seeded
// row; they don't execute these lifecycle paths." That is true and it is the
// difference between believing a fix and having evidence for one. This drives
// a real `MovableSurface` in Chromium, with a real child window, through the
// four paths they named.
//
//   D1  borrow → ordinary redock → LATE restore  ⇒ must NOT reopen
//   D2  borrow → surface unmount → LATE restore  ⇒ must NOT reopen
//   D3  borrow → restore → restore               ⇒ exactly once, same rect
//   D4  move the window, borrow IMMEDIATELY      ⇒ the ACTUAL pre-borrow rect,
//       (inside the 250 ms geometry sample)         not the previous sample
//
// D4 is the one that cannot be faked in jsdom at all: it is a race against a
// real `setInterval` sampling a real window's real screen position.
//
// ⚠ A FAKE BRIDGE IS REQUIRED, not decoration. `captureWindow` early-returns
// without `desktop()`, so with no bridge no saved row is ever written and
// every rect assertion below would pass vacuously against `undefined`.
//
// Run:  node tools/run-probe.mjs apps/desktop/renderer/tests/borrowlifecycle-probe.tsx <outdir>
import { createRoot } from 'react-dom/client'
import { useEffect } from 'react'
import { MovableSurface, useSurface } from '../src/popout'
import { openSurfaces } from '../src/windowlife'
import { savedWindows, windowLayoutKey } from '../src/windowlayout'
import type { BorrowedSurface } from '../src/windowlife'
import '../src/styles.css'
import '../src/shell.css'

interface Probe { phase: string; done: boolean; [k: string]: unknown }
const PROBE: Probe = { phase: 'start', done: false }
;(window as unknown as { PROBE: Probe }).PROBE = PROBE
const mark = (p: string) => { PROBE.phase = p; document.title = p }

// the bridge `captureWindow` gates on. Deliberately minimal: no
// `getWindowState`, so `useRestoreWindows` allows restore and the surface
// behaves as it does in the packaged app.
;(window as unknown as { orgtreeDesktop: unknown }).orgtreeDesktop = {
  onEvent: () => () => {},
  getPreferences: async () => ({}),
}
try { localStorage.clear() } catch { /* fresh profile anyway */ }

const KIND = 'probe-desk'
const ORG = 'studio'
const KEY = windowLayoutKey(KIND, ORG)
const savedRow = () => savedWindows().find((r) => r.key === KEY)
const rectOf = () => { const r = savedRow(); return r ? { ...r.rect } : null }
const openRow = () => savedRow()?.open ?? null
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))

/** Hands the surface's own context out so the probe can drive open/redock the
 *  way the header buttons do, rather than reaching past the component. */
let ctl: { open: () => void; redock: () => void } | null = null
function Handle() {
  const s = useSurface()
  useEffect(() => { ctl = s ? { open: s.open, redock: s.redock } : null }, [s])
  return <div className="probe-body" style={{ width: 300, height: 200 }}>
    surface
    {/* AN UNSENT DRAFT. The composer's survival across a borrow is the whole
        reason the surface is re-PLACED rather than re-created, and a value
        check alone would not prove it: React can remount and restore a value
        from props while destroying everything uncontrolled about the node.
        So the probe holds the ELEMENT and compares identity. */}
    <input className="probe-draft" defaultValue="" />
  </div>
}

const host = document.getElementById('root')!
const mount = document.createElement('div')
host.appendChild(mount)
const root = createRoot(mount)
const anchor = document.createElement('div')
host.appendChild(anchor)

const surfaceEl = () =>
  <MovableSurface kind={KIND} title="Probe" org={ORG} anchor={anchor}
    sourceBox={() => ({ x: 20, y: 20, w: 420, h: 320 })}>
    <Handle />
  </MovableSurface>

/** The live windowlife entry for this surface, which is where `borrow` is. */
const entry = () => openSurfaces().find((s) => s.kind === KIND)
const childWindow = () => entry()?.window ?? null

async function detach(): Promise<boolean> {
  ctl?.open()
  for (let i = 0; i < 60 && !childWindow(); i++) await wait(100)
  await wait(400)          // let the adopt/style pass settle
  return !!childWindow()
}

async function run() {
  // ------------------------------------------------- D3 first: the happy path
  // Done first because it establishes that the machinery works at all; a
  // failure here would make D1/D2's "did not reopen" vacuously true.
  mark('D3-open')
  root.render(surfaceEl())
  await frame()
  const opened = await detach()
  PROBE.D3_detached = opened
  if (!opened) { PROBE.D3_note = 'child window never appeared; later phases are not meaningful'; PROBE.done = true; return }

  await wait(400)                      // let one 250 ms geometry sample land
  const beforeBorrow = rectOf()
  mark('D3-borrow')
  const h3 = entry()!.borrow!() as BorrowedSurface
  await wait(200)
  const duringBorrow = { open: openRow(), rect: rectOf(), hasWindow: !!childWindow() }
  mark('D3-restore')
  h3.restore()
  for (let i = 0; i < 40 && !childWindow(); i++) await wait(100)
  await wait(300)
  const afterRestore = { rect: rectOf(), hasWindow: !!childWindow() }
  // the second call must do nothing at all
  const windowsBefore = openSurfaces().length
  h3.restore()
  await wait(200)
  PROBE.D3 = {
    beforeBorrow, duringBorrow, afterRestore,
    rowStayedOpenDuringBorrow: duringBorrow.open === true,
    windowClosedDuringBorrow: duringBorrow.hasWindow === false,
    windowBackAfterRestore: afterRestore.hasWindow === true,
    secondRestoreAddedNothing: openSurfaces().length === windowsBefore,
  }

  // ----------------------------------------- D1 borrow → redock → late restore
  mark('D1')
  if (!childWindow()) await detach()
  await wait(400)
  const h1 = entry()!.borrow!() as BorrowedSurface
  await wait(150)
  // an ORDINARY redock happens while the borrow is outstanding — the user
  // returned the surface by another route, which clears the saved row
  ctl?.redock()
  await wait(250)
  const afterRedock = { open: openRow(), hasWindow: !!childWindow() }
  // …and only now is the stale handle used
  h1.restore()
  await wait(600)
  PROBE.D1 = {
    afterRedock,
    lateRestoreDidNotReopen: !childWindow(),
    rowNotResurrected: openRow() !== true,
    // ⚠ this is the defect multi-window-design found: before the epoch guard
    // this reopened a window the user had already closed
  }

  // --------------------------------------- D2 borrow → unmount → late restore
  mark('D2')
  root.render(surfaceEl())
  await frame()
  if (!childWindow()) await detach()
  await wait(400)
  const h2 = entry()!.borrow!() as BorrowedSurface
  await wait(150)
  root.render(<div>unmounted</div>)      // the surface goes away entirely
  await wait(400)
  const afterUnmount = { open: openRow(), surfaces: openSurfaces().length }
  h2.restore()
  await wait(600)
  PROBE.D2 = {
    afterUnmount,
    lateRestoreDidNotReopen: openSurfaces().filter((s) => s.kind === KIND).length === 0,
    rowNotResurrected: openRow() !== true,
  }

  // ------------------------- D4 the geometry race against the 250 ms sample
  mark('D4')
  root.render(surfaceEl())
  await frame()
  const up = await detach()
  PROBE.D4_detached = up
  if (up) {
    await wait(500)                       // a sample has definitely landed
    const sampled = rectOf()
    const w = childWindow()!
    // MOVE, then borrow INSIDE the sampling window. If the borrow relied on
    // the poll, the saved rect would still be `sampled`.
    try { w.moveTo(140, 160) } catch { /* platform may refuse */ }
    try { w.resizeTo(560, 420) } catch { /* platform may refuse */ }
    await wait(30)                        // « 250 ms: no sample can have run
    const actual = { x: w.screenX, y: w.screenY, width: w.outerWidth, height: w.outerHeight }
    const h4 = entry()!.borrow!() as BorrowedSurface
    await wait(200)
    const captured = rectOf()
    PROBE.D4 = {
      sampled, actual, captured,
      moveActuallyHappened: !!sampled && !!captured
        && (sampled.x !== actual.x || sampled.y !== actual.y
          || sampled.width !== actual.width || sampled.height !== actual.height),
      // ⚠ THE CLAIM: the borrow captured where the window REALLY was, not the
      // previous sample. Compared with a small tolerance because a window
      // manager may adjust a requested position by a pixel or two.
      capturedMatchesActual: !!captured
        && Math.abs(captured.x - actual.x) <= 2 && Math.abs(captured.y - actual.y) <= 2
        && Math.abs(captured.width - actual.width) <= 2
        && Math.abs(captured.height - actual.height) <= 2,
      capturedIsNotTheStaleSample: !!captured && !!sampled
        && (captured.x !== sampled.x || captured.y !== sampled.y
          || captured.width !== sampled.width || captured.height !== sampled.height),
    }
    // ⚠ THE VERDICT IS GATED ON THE SETUP HAVING WORKED. If the window did
    // not actually move, `capturedMatchesActual` is true only because nothing
    // changed, and reading it as a pass would be exactly the vacuous green
    // this phase exists to avoid. Say NOT EXERCISED instead.
    const d4 = PROBE.D4 as Record<string, unknown>
    PROBE.D4_verdict = d4.moveActuallyHappened
      ? (d4.capturedMatchesActual && d4.capturedIsNotTheStaleSample
        ? 'PASS — the borrow captured the real geometry, not the stale sample'
        : 'FAIL — the borrow used the stale sample')
      : 'NOT EXERCISED — the renderer could not move the child window, so this '
        + 'phase proves nothing about the capture-before-close ordering'
    h4.release()                          // leave nothing claiming a window
    await wait(200)
    PROBE.D4_releaseClearedRow = openRow() === false
  }

  // ------------------- D5 the draft and the composer survive a borrow intact
  //
  // multi-window-design asked for "unchanged draft/composer identity". Value
  // equality is the weak half: React could remount the subtree and refill a
  // controlled value while every uncontrolled thing about it — scroll,
  // selection, focus, an IME composition — was destroyed. So this compares
  // the NODE, and uses an uncontrolled input so a survived value can only
  // mean the node itself survived.
  mark('D5')
  root.render(surfaceEl())
  await frame()
  if (!childWindow()) await detach()
  await wait(400)
  const draftBefore = (childWindow()!.document ?? document)
    .querySelector<HTMLInputElement>('.probe-draft')
    ?? document.querySelector<HTMLInputElement>('.probe-draft')
  if (draftBefore) {
    draftBefore.value = 'half-written message'
    draftBefore.selectionStart = 4
    draftBefore.selectionEnd = 4
    const h5 = entry()!.borrow!() as BorrowedSurface
    await wait(250)
    const duringSameNode = draftBefore.isConnected
    const duringValue = draftBefore.value
    h5.restore()
    for (let i = 0; i < 40 && !childWindow(); i++) await wait(100)
    await wait(300)
    const afterDoc = childWindow()?.document ?? document
    const draftAfter = afterDoc.querySelector<HTMLInputElement>('.probe-draft')
    PROBE.D5 = {
      // ⚠ IDENTITY, not equality: the same element object came back, so the
      // React subtree was re-placed and never re-created
      sameNodeThroughout: draftAfter === draftBefore,
      valueSurvivedBorrow: duringValue === 'half-written message',
      valueSurvivedRestore: draftAfter?.value === 'half-written message',
      stillConnectedWhileBorrowed: duringSameNode,
      caretSurvived: draftAfter?.selectionStart === 4,
    }
  } else PROBE.D5 = { note: 'draft input not found; phase proves nothing' }

  // ------------------------------- D6 a destination that is gone: release
  //
  // v3-effort-opus's case: the borrow ends and the desk has nowhere valid to
  // go back to, because its agent's generation changed or its recorded
  // destination is gone. `restore()` would resurrect a window with nowhere to
  // be; doing nothing would leave the row claiming a window that does not
  // exist. `release()` is the third answer and this is it executed.
  mark('D6')
  root.render(surfaceEl())
  await frame()
  if (!childWindow()) await detach()
  await wait(400)
  const h6 = entry()!.borrow!() as BorrowedSurface
  await wait(200)
  const beforeRelease = { open: openRow(), hasWindow: !!childWindow() }
  h6.release()
  await wait(400)
  const afterRelease = { open: openRow(), hasWindow: !!childWindow() }
  // and the handle is spent: restoring after releasing must do nothing
  h6.restore()
  await wait(500)
  PROBE.D6 = {
    beforeRelease, afterRelease,
    rowClearedByRelease: afterRelease.open === false,
    releaseDidNotReopen: afterRelease.hasWindow === false,
    restoreAfterReleaseDidNothing: !childWindow(),
    mutuallyExclusive: afterRelease.open === false && !childWindow(),
  }

  mark('done')
  PROBE.done = true
}

run().catch((e) => {
  PROBE.error = String((e as Error)?.stack ?? e)
  PROBE.done = true
  document.title = 'error'
})
