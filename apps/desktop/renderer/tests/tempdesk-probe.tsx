// tempdesk-probe.tsx — BORROWING A POPPED-OUT DESK, EXECUTED.
//
// The ticket requires rendered evidence, and this is the half that cannot be
// had any other way. jsdom has no windows, so every jsdom test of this feature
// stops at "ownership moved" and says nothing about the thing the user ruled
// on: that opening the temporary modal on an agent whose desk is in its OWN
// NATIVE WINDOW pulls it in, and that closing the modal puts that window back
// where it was.
//
// v3-shell-opus's borrowlifecycle-probe.tsx executes the SEAM (late restore
// after a redock or an unmount, exactly-once, and the geometry race against the
// 250 ms sample). This executes the INTEGRATION above it: the desk registry and
// the modal actually driving that seam.
//
//   E1  desk popped out → open the modal  ⇒ the native window closes, the desk
//                                           is in the modal, and the saved row
//                                           STILL claims open with its rect
//   E2  close the modal                   ⇒ the window comes back and the
//                                           SAVED rect is preserved (not the
//                                           native bounds — see E2b's note)
//   E3  destination gone when it ends     ⇒ release, not restore: no window
//                                           comes back and the row stops
//                                           claiming one is open
//
// ⚠ THE BRIDGE STUB IS LOAD-BEARING, not decoration — `captureWindow`
// early-returns without `desktop()`, so with no bridge no saved row is ever
// written and every `open`/rect assertion below would pass vacuously against
// `undefined`. That is shell's finding, reused.
//
// Run:  node tools/run-probe.mjs apps/desktop/renderer/tests/tempdesk-probe.tsx .probe-tempdesk
// Reads: result.json — every entry of `checks` must have ok: true.
import { createRoot } from 'react-dom/client'
import { useEffect } from 'react'
import { DeskHosts, DeskSlot, useDeskActionsNow, deskIdentity } from '../src/canvas/deskhosts'
import { TempDeskModal } from '../src/canvas/tempdesk'
import { openSurfaces } from '../src/windowlife'
import { savedWindows, windowLayoutKey } from '../src/windowlayout'
import type { CanvasNode } from '../src/canvas/shared'
import type { OpResult } from '../src/types'
import '../src/styles.css'

interface Probe { phase: string; done: boolean; [k: string]: unknown }
const PROBE: Probe = { phase: 'start', done: false }
;(window as unknown as { PROBE: Probe }).PROBE = PROBE
const mark = (p: string) => { PROBE.phase = p; document.title = p }
const checks: { name: string; ok: boolean; detail: string }[] = []
const record = (name: string, ok: boolean, detail: string) => {
  checks.push({ name, ok, detail })
  PROBE.checks = checks
  PROBE.pass = checks.filter((c) => c.ok).length
  PROBE.fail = checks.filter((c) => !c.ok).length
}

// the bridge `captureWindow` gates on (shell's finding — without it the saved
// row is never written and the rect checks mean nothing)
;(window as unknown as { orgtreeDesktop: unknown }).orgtreeDesktop = {
  onEvent: () => () => {},
  getPreferences: async () => ({}),
}
try { localStorage.clear() } catch { /* fresh profile anyway */ }

// no server: the desk reads its conversation through these
window.fetch = ((url: string) => {
  const u = new URL(String(url), location.href)
  let body: unknown = { ok: true }
  if (/\/chat$/.test(u.pathname)) body = { items: [], more: false, cursor: null }
  else if (/\/history$/.test(u.pathname)) body = { items: [] }
  else if (/\/work-items$/.test(u.pathname)) {
    body = { items: [], counts: { attention: 0, active: 0, archived: 0, backlogged: 0 },
      now: new Date().toISOString() }
  } else if (/\/documents$/.test(u.pathname)) body = { documents: [], total: 0, next_offset: null }
  else if (/\/scratch$/.test(u.pathname)) body = { path: '', entries: [] }
  return Promise.resolve({ ok: true, status: 200,
    json: () => Promise.resolve(body), text: () => Promise.resolve(JSON.stringify(body)) })
}) as typeof window.fetch

const ORG = 'studio'
const node = {
  id: 'worker', title: 'worker', tier: 'opus', model_id: 'opus', state: 'live',
  seat: 1, grant: 0, free: 0, ui_order: 0, cost_usd: 0, occupancy: null,
  context_window: null, charter: null, mail_pending: 0, limit_locked: false,
  last_status: null, prev_status: null, inflight_at: null, last_denials: [],
  turns: [], frozen: null, audiences_held: [], bearer_state: null,
  generation: 0, children: [], lineage: [],
  scope: { permission_mode: 'default', add_dirs: [], tools: {}, org_visibility: 'team' },
} as unknown as CanvasNode
const map = new Map([[node.id, node]])
const op = () => Promise.resolve({} as OpResult)
const noop = () => {}

const KEY = windowLayoutKey(`desk:${deskIdentity(ORG, node)}`, ORG)
const savedRow = () => savedWindows().find((r) => r.key === KEY)
const rectOf = () => { const r = savedRow(); return r ? { ...r.rect } : null }
const openRow = () => savedRow()?.open ?? null
const deskWindow = () =>
  openSurfaces().find((s) => s.kind === `desk:${deskIdentity(ORG, node)}`)?.window ?? null
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))

/** pops the desk out the way the agent menu does — through the registry,
 *  not by reaching past it into `MovableSurface` */
let popout: (() => void) | null = null
function Popper() {
  const now = useDeskActionsNow(ORG)
  useEffect(() => { popout = () => now(node).requestPopout() }, [now])
  return null
}

const host = document.getElementById('root')!
const mount = document.createElement('div')
host.appendChild(mount)
const root = createRoot(mount)

/** `canvas` is the ordinary destination; `modal` is the borrowing one */
const scene = (modalOpen: boolean, withCanvas = true) =>
  <DeskHosts map={map} slug={ORG}>
    <Popper />
    {withCanvas && <div className="probe-canvas" style={{ width: 420, height: 320 }}>
      <DeskSlot node={node} map={map} op={op} slug={ORG} toast={noop} pub={false} bare />
    </div>}
    {modalOpen && <TempDeskModal node={node} close={noop}
      desk={{ map, op, slug: ORG, toast: noop, pub: false }} />}
  </DeskHosts>

const inModal = () => {
  const panel = document.querySelector('.tempdesk-panel')
  const ta = document.querySelector('textarea')
  return !!panel && !!ta && panel.contains(ta)
}
const canvasPlaceholder = () =>
  /desk is open elsewhere/.test(
    document.querySelector('.probe-canvas')?.textContent ?? '')

async function detach(): Promise<boolean> {
  popout?.()
  for (let i = 0; i < 60 && !deskWindow(); i++) await wait(100)
  await wait(500)   // let the adopt/style pass and one geometry sample land
  return !!deskWindow()
}

async function run() {
  // ---------------------------------------------------------------- E1 + E2
  mark('E1-open')
  root.render(scene(false))
  await frame(); await wait(600)
  record('E0 the desk mounts on the canvas destination',
    !!document.querySelector('textarea') && !canvasPlaceholder(),
    `textarea=${!!document.querySelector('textarea')} placeholder=${canvasPlaceholder()}`)

  const detached = await detach()
  record('E0b …and pops out into a REAL native window', detached,
    `deskWindow=${!!deskWindow()} openRow=${openRow()} rect=${JSON.stringify(rectOf())}`)
  if (!detached) {
    PROBE.note = 'the desk never popped out; E1-E3 would be vacuous'
    PROBE.done = true
    return
  }
  const rectBefore = rectOf()

  mark('E1-borrow')
  root.render(scene(true))
  await frame(); await wait(700)
  record('E1 opening the modal CLOSES the native window',
    !deskWindow(), `deskWindow=${!!deskWindow()}`)
  record('E1b …and the desk is now inside the modal',
    inModal(), `inModal=${inModal()}`)
  record('E1c …and the saved row STILL claims open, with its rect — a borrow '
    + 'is not a close',
    openRow() === true && JSON.stringify(rectOf()) === JSON.stringify(rectBefore),
    `open=${openRow()} rect=${JSON.stringify(rectOf())} before=${JSON.stringify(rectBefore)}`)

  mark('E2-close')
  root.render(scene(false))
  for (let i = 0; i < 40 && !deskWindow(); i++) await wait(100)
  await wait(500)
  record('E2 closing the modal brings the WINDOW back',
    !!deskWindow(), `deskWindow=${!!deskWindow()}`)
  // ⚠ WHAT THIS CHECK DOES AND DOES NOT PROVE. It compares the SAVED ROW's
  // rect before and after, so it proves the borrow PRESERVES the saved
  // geometry instead of clearing or recomputing it — which is the defect
  // v3-shell-opus found in the `redock`/`open` version, where the row was
  // cleared and the return landed at a freshly computed position. It does NOT
  // read the native BrowserWindow's actual bounds, so it is not evidence that
  // the window reappeared at the place the user had dragged it to. An earlier
  // version of this check was named "at the rect it actually had", which
  // claimed exactly that and was wrong (multi-window-design, 2026-09-21).
  // Authoritative moved-window geometry is a COMPOSITION gate owned by native:
  // shell's d4c8dd0 moved a real window through main's setBounds and found the
  // WindowProxy still reporting the old geometry immediately afterwards, so
  // distinguishing fixture timing from product behaviour there is native's to
  // settle, not something this probe can assert.
  record('E2b …and the SAVED rect is preserved across the borrow (not the '
    + 'native window bounds — see the note above)',
    JSON.stringify(rectOf()) === JSON.stringify(rectBefore),
    `saved row after=${JSON.stringify(rectOf())} before=${JSON.stringify(rectBefore)}`
    + ' — saved-row preservation only; actual moved-window bounds are a native'
    + ' composition gate and are NOT measured here')
  record('E2c …and the modal is gone',
    !document.querySelector('.tempdesk-panel'), 'panel removed')

  // ------------------------------------------------------------------- E3
  // The destination is gone when the borrow ends: ownership has nowhere valid
  // to return to, so the window must be RELEASED rather than restored — a row
  // left claiming `open` with nothing behind it makes startup reopen a window
  // nobody left open.
  mark('E3-borrow')
  root.render(scene(true))
  await frame(); await wait(700)
  const borrowedAgain = !deskWindow() && inModal()
  record('E3 borrowed a second time', borrowedAgain,
    `deskWindow=${!!deskWindow()} inModal=${inModal()}`)
  mark('E3-drop-both')
  // the modal closes AND the canvas destination is unmounted in the same commit
  root.render(scene(false, false))
  await wait(900)
  record('E3b with the destination gone, NO window is resurrected',
    !deskWindow(), `deskWindow=${!!deskWindow()}`)
  record('E3c …and the saved row stops claiming one is open',
    openRow() !== true, `open=${openRow()}`)

  PROBE.checks = checks
  PROBE.failed = checks.filter((c) => !c.ok).map((c) => c.name)
  mark('done')
  PROBE.done = true
}

run().catch((e) => {
  PROBE.error = String(e && (e as Error).stack || e)
  PROBE.done = true
})
