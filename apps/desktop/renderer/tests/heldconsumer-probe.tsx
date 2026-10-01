// heldconsumer-probe.tsx — the renderer half of the held-event composition
// fixture: the SHIPPING bus feeding a SHIPPING consumer.
//
// ⚠ NOTHING HERE IS A MODEL OF THE RENDERER. `startHeldEvents` is the module
// main.tsx calls on its first line, and `useNativeNotifications` is the hook
// the product mounts — including its real `readNotices()` paging, its
// preference gate and its recheck-on-activation. What this file adds is a
// deliberate DELAY before mounting the consumer, because that delay is the
// defect's whole shape: in the product the consumer is a React effect, and a
// React effect has not run when the acknowledgement from the FIRST `onEvent`
// releases native's hold.
//
// ⚠ AND THE BUS IS STARTED FIRST, exactly as main.tsx starts it, before any
// other subscription in the document. Starting it after would not be a weaker
// version of the protection; it would be none of it.
//
// Modes, chosen by the query string, because a window's URL is the only thing
// the fixture can vary before the document exists:
//
//   ack-only  the fixture's main process makes `take-pending-events` return
//             nothing for this window, so the acknowledgement the preload
//             sends from inside `onEvent` is the ONLY thing that can release
//             the hold. That is the v2 renderer's situation, and the one
//             native's own probe explicitly could not cover.
//
//             ⚠ IT IS DONE IN MAIN, NOT HERE, and the first attempt taught me
//             why: `contextBridge` exposes a FROZEN object, so
//             `delete bridge.takePendingWindowEvents` throws — and it threw
//             before `startHeldEvents()` ran, which killed the whole bundle
//             and produced a run where nothing was received for a reason that
//             had nothing to do with what was being measured.
//   take      the ordinary path: both routes.
//   idle      start the bus, mount nothing, and wait to be driven.
//
// Run: node tools/run-composition-probe.mjs <outdir>
import { createRoot } from 'react-dom/client'
import { useEffect } from 'react'
import { heldEventStats, startHeldEvents } from '../src/events/heldbus'
import { useNativeNotifications } from '../src/notifications'
import type { DesktopNotice } from '../src/notifications'

interface Probe {
  mode: string
  /** ⚠ WHICH DOCUMENT THIS IS. The Homepage-bind case turns entirely on
   *  whether the OLD document or the NEW one received an event, and
   *  `executeJavaScript` always talks to whichever document is showing NOW —
   *  so without an identity per document, "the window reports it received it"
   *  cannot tell the two apart. A same-origin navigation can reuse the
   *  renderer PROCESS, which makes the confusion easy and quiet. */
  docId: string
  path: string
  opened: DesktopNotice[]
  waiting: number
  delivered: number
  mounted: boolean
  hasTake?: boolean
  late?: string[]
}
const mode = new URLSearchParams(location.search).get('mode') ?? 'take'
const PROBE: Probe = {
  mode, opened: [], waiting: 0, delivered: 0, mounted: false,
  // a fresh document gets a fresh one; a reused process does not change that,
  // because module state is rebuilt with the document
  docId: 'doc-' + Math.random().toString(36).slice(2, 10),
  path: location.pathname + location.search,
}
;(window as unknown as { PROBE: Probe }).PROBE = PROBE

// the bridge is exposed frozen by contextBridge; nothing here modifies it
PROBE.hasTake = typeof (window as unknown as {
  orgtreeDesktop?: { takePendingWindowEvents?: unknown }
}).orgtreeDesktop?.takePendingWindowEvents === 'function'

// FIRST, as in main.tsx
startHeldEvents()

const stats = () => {
  const s = heldEventStats()
  PROBE.waiting = s.waiting
  PROBE.delivered = s.delivered
}
stats()
setInterval(stats, 100)

function Consumer() {
  // the REAL hook, with the REAL routing callback. `owner` defaults true so
  // the global half runs too, which is what makes `readNotices()` page the
  // canned endpoint and the recheck-on-activation path execute.
  useNativeNotifications((notice) => { PROBE.opened.push(notice) })
  useEffect(() => { PROBE.mounted = true }, [])
  return <div>consumer</div>
}

const root = createRoot(document.getElementById('root')!)

if (mode !== 'idle') {
  // ⚠ THE DELAY IS THE POINT, and 400 ms is chosen to be unambiguously longer
  // than any commit the acknowledgement could be racing. In the product this
  // interval is one React commit; making it large here means a run that passes
  // cannot have passed by winning a race.
  setTimeout(() => { root.render(<Consumer />) }, 400)
} else {
  root.render(<div>idle</div>)
}
