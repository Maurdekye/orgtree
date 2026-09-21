// borrowgeometry-probe.tsx — the one borrow case that needed a main process.
//
// THE CLAIM UNDER TEST. A borrow captures where the window REALLY is, not the
// last 250 ms geometry sample. Without that, moving or resizing a popout and
// then borrowing it restores the window to the PREVIOUS sample — the desk
// comes back in the right slot at the wrong place, which reads as working.
//
// THE CONTROL multi-window-design SPECIFIED, and it is the part that makes
// this worth running at all:
//
//   1. the window's ACTUAL bounds must be shown to DIFFER from the saved
//      sample immediately before the borrow — otherwise "captured matches
//      actual" is true because nothing ever changed, which is exactly the
//      vacuous pass the first attempt produced;
//   2. then the captured rect must match those ACTUAL bounds;
//   3. monitor-fit adjustment is allowed explicitly — the assertion is
//      against the bounds the window manager GRANTED, read back from the main
//      process, not against the bounds that were requested.
//
// ⚠ THE PRECONDITION IS A RACE AND IS TREATED AS ONE. The geometry poll runs
// every 250 ms and writes the saved row whenever the rect changed, so it can
// close the gap between the move and the borrow on its own. This retries, and
// if the precondition never holds it reports NOT EXERCISED rather than
// dressing a missed race as a pass.
//
// Run: node apps/desktop/renderer/tests/run-borrowgeometry.mjs \
//        apps/desktop/renderer/tests/borrowgeometry-probe.tsx <outdir>
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

// `captureWindow` early-returns without a bridge, so without this no saved row
// is ever written and every rect assertion would compare undefined to
// undefined and pass
;(window as unknown as { orgtreeDesktop: unknown }).orgtreeDesktop = {
  onEvent: () => () => {},
  getPreferences: async () => ({}),
}
try { localStorage.clear() } catch { /* fresh profile */ }

const KIND = 'probe-desk'
const ORG = 'studio'
const KEY = windowLayoutKey(KIND, ORG)
type Rect = { x: number; y: number; width: number; height: number }
const savedRect = (): Rect | null => {
  const r = savedWindows().find((s) => s.key === KEY)
  return r ? { ...r.rect } : null
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const same = (a: Rect | null, b: Rect | null, tol = 2) =>
  !!a && !!b && Math.abs(a.x - b.x) <= tol && Math.abs(a.y - b.y) <= tol
  && Math.abs(a.width - b.width) <= tol && Math.abs(a.height - b.height) <= tol

let ctl: { open: () => void; redock: () => void } | null = null
function Handle() {
  const s = useSurface()
  useEffect(() => { ctl = s ? { open: s.open, redock: s.redock } : null }, [s])
  return <div style={{ width: 300, height: 200 }}>surface</div>
}

const host = document.getElementById('root')!
const root = createRoot(host)
const anchor = document.createElement('div')
host.appendChild(anchor)
const entry = () => openSurfaces().find((s) => s.kind === KIND)

async function detach(): Promise<boolean> {
  ctl?.open()
  for (let i = 0; i < 60 && !entry(); i++) await wait(100)
  await wait(400)
  return !!entry()
}

const moved = () => (window as unknown as { __MOVED?: Rect }).__MOVED ?? null

async function attempt(n: number) {
  ;(window as unknown as { __MOVED?: Rect }).__MOVED = undefined
  root.render(<MovableSurface kind={KIND} title="Probe" org={ORG} anchor={anchor}
    sourceBox={() => ({ x: 20, y: 20, w: 420, h: 320 })}><Handle /></MovableSurface>)
  await wait(200)
  if (!entry() && !(await detach())) return { attempt: n, note: 'no child window' }

  // let a sample land, so the saved row definitely holds the PRE-move rect
  await wait(500)
  const sampled = savedRect()

  // ask the main process to move it; the title is the channel that survives a
  // busy renderer
  mark('MOVE-NOW')
  for (let i = 0; i < 80 && !moved(); i++) await wait(25)
  const actual = moved()
  if (!actual) return { attempt: n, sampled, note: 'main process never reported a move' }

  // ⚠ BORROW AS SOON AS THE MOVE IS VISIBLE, and read the saved row in the
  // SAME task first, so the precondition is observed rather than assumed.
  const beforeBorrow = savedRect()
  const preconditionHeld = !same(beforeBorrow, actual)
  // ⚠ DIAGNOSTIC: can the RENDERER see the move at all? `captureWindow` reads
  // w.screenX/screenY/outerWidth/outerHeight, and so does the 250 ms poll. If
  // those do not track a window the main process demonstrably moved, then the
  // borrow is capturing faithfully and the READ PATH is what cannot see it —
  // which is a different defect, in a different place, affecting the poll
  // equally. Distinguishing the two is the whole point of recording this.
  const w = entry()!.window
  const rendererSees = {
    screenX: w.screenX, screenY: w.screenY,
    outerWidth: w.outerWidth, outerHeight: w.outerHeight,
  }
  const h = entry()!.borrow!() as BorrowedSurface
  await wait(250)
  const captured = savedRect()
  h.release()
  await wait(250)
  root.render(<div>idle</div>)
  await wait(300)
  return {
    attempt: n, sampled, actual, beforeBorrow, captured, rendererSees,
    rendererCanSeeTheMove: Math.abs(rendererSees.screenX - actual.x) <= 2
      && Math.abs(rendererSees.outerWidth - actual.width) <= 2,
    preconditionHeld,
    capturedMatchesActual: same(captured, actual),
    capturedIsNotTheStaleSample: !same(captured, beforeBorrow),
  }
}

/** ⚠ A SEPARATE QUESTION FROM THE BORROW, and multi-window-design was right
 *  that the first version conflated them. The immediate phase samples the
 *  proxy in the same continuation as `setBounds` and then closes the child,
 *  which establishes an IMMEDIATE mismatch and nothing about whether the
 *  geometry would have propagated a moment later. So this phase moves the
 *  window, lets propagation SETTLE across several poll intervals without
 *  borrowing at all, and then compares three things: what the main process
 *  says the bounds are, what the child sees about ITSELF, and what the parent
 *  sees through the proxy it holds. Those three can disagree in different
 *  ways and the difference matters — a parent-proxy that never updates is a
 *  product-level read defect, whereas one that updates late is only a
 *  sampling question. */
async function settleDiagnostic() {
  ;(window as unknown as { __MOVED?: Rect }).__MOVED = undefined
  root.render(<MovableSurface kind={KIND} title="Probe" org={ORG} anchor={anchor}
    sourceBox={() => ({ x: 20, y: 20, w: 420, h: 320 })}><Handle /></MovableSurface>)
  await wait(200)
  if (!entry() && !(await detach())) return { note: 'no child window' }
  await wait(500)
  const before = savedRect()
  mark('MOVE-NOW')
  for (let i = 0; i < 80 && !moved(); i++) await wait(25)
  const actual = moved()
  if (!actual) return { before, note: 'main process never reported a move' }

  const w = entry()!.window
  const readProxy = () => ({ screenX: w.screenX, screenY: w.screenY,
    outerWidth: w.outerWidth, outerHeight: w.outerHeight })
  const immediately = readProxy()
  // let it settle across several 250 ms poll intervals — the window is NOT
  // borrowed or closed here, so propagation has every chance
  const samples: { afterMs: number; proxy: ReturnType<typeof readProxy>; saved: Rect | null }[] = []
  for (const ms of [250, 500, 1000, 2000]) {
    await wait(ms === 250 ? 250 : ms - samples[samples.length - 1]!.afterMs)
    samples.push({ afterMs: ms, proxy: readProxy(), saved: savedRect() })
  }
  // and what the CHILD says about itself, which is a different question again
  let childSelf: unknown = null
  try {
    childSelf = (w as unknown as { eval?: (s: string) => unknown }).eval
      ? (w as unknown as { eval: (s: string) => unknown })
        .eval('({screenX:screenX,screenY:screenY,outerWidth:outerWidth,outerHeight:outerHeight})')
      : 'no cross-document eval'
  } catch (e) { childSelf = 'blocked: ' + String(e) }

  const settled = samples[samples.length - 1]!
  const proxyEverUpdated = samples.some((s) =>
    Math.abs(s.proxy.screenX - actual.x) <= 2 && Math.abs(s.proxy.outerWidth - actual.width) <= 2)
  const pollEverRecorded = samples.some((s) => same(s.saved, actual))
  entry()?.borrow!().release()
  await wait(200)
  root.render(<div>idle</div>)
  await wait(200)
  return {
    before, nativeBounds: actual, immediately, samples, settled, childSelf,
    proxyEverUpdated, pollEverRecorded,
    verdict: proxyEverUpdated
      ? 'the parent-held proxy DOES catch up — the immediate mismatch is a '
        + 'propagation delay, not blindness, and the 250 ms poll would record it'
      : 'the parent-held proxy NEVER caught up across 2s and four poll '
        + 'intervals, so the 250 ms poll would not have recorded the move '
        + 'either — in THIS harness',
  }
}

async function run() {
  const tries: unknown[] = []
  let winner: Record<string, unknown> | null = null
  // the poll can close the gap on its own; retry until the precondition holds
  for (let n = 1; n <= 4 && !winner; n++) {
    mark('attempt-' + n)
    const r = await attempt(n) as Record<string, unknown>
    tries.push(r)
    if (r.preconditionHeld) winner = r
  }
  PROBE.attempts = tries
  PROBE.D4 = winner ?? null
  // the separate, narrower question — run after the borrow attempts so it
  // cannot disturb them
  mark('settle-diagnostic')
  PROBE.settle = await settleDiagnostic()
  PROBE.D4_verdict = !winner
    ? 'NOT EXERCISED — the saved row was refreshed by the 250 ms poll before the '
      + 'borrow in every attempt, so no run observed the window actually ahead of '
      + 'its sample. Nothing is claimed.'
    : (winner.capturedMatchesActual && winner.capturedIsNotTheStaleSample
      ? 'PASS — with the saved row demonstrably behind the window, the borrow '
        + 'captured the ACTUAL granted bounds and not the stale sample'
      : winner.rendererCanSeeTheMove === false
        ? 'INCONCLUSIVE — the READ PATH is blind in this harness, so the claim '
          + 'cannot be tested here. The main process moved the child and the '
          + 'renderer w.screenX/outerWidth still report the PARENT geometry, '
          + 'so captureWindow faithfully recorded what it was given and the '
          + '250 ms poll would have recorded exactly the same wrong value. This '
          + 'neither confirms nor refutes the capture-before-close ordering: it '
          + 'says the distinction is unobservable while the read is blind. '
          + 'Whether the PRODUCT read path differs is a window-creation question '
          + 'for the native owner, not something this probe can settle.'
        : 'FAIL — the borrow used the stale sample despite the renderer being '
          + 'able to see the move')
  mark('done')
  PROBE.done = true
}

run().catch((e) => {
  PROBE.error = String((e as Error)?.stack ?? e)
  PROBE.done = true
  document.title = 'error'
})
