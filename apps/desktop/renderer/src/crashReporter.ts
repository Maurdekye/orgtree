// Crash reporting — the whole point is a channel that survives the app being
// broken, so THIS FILE MUST BE THE FIRST THING main.tsx IMPORTS. Module top-
// level code in an ES module graph runs before the importing module's own
// body, so importing this first means its window.addEventListener calls are
// live before React (or anything else) gets a chance to throw — including a
// failure during the very first render, before any component has mounted.
//
// No imports on purpose: pulling in api.ts (or anything else) would make this
// module's own initialization depend on other modules evaluating cleanly
// first, which is exactly the kind of fragility a crash reporter cannot have.
//
// Every report is written to localStorage SYNCHRONOUSLY before any attempt at
// delivery or display — durability first. Delivery then rides
// navigator.sendBeacon, the one browser API built to keep working while a
// page is dying or has already started unloading; fetch(keepalive) is the
// fallback for browsers without it.

const BASE = (location.pathname.match(/^\/k\/[A-Za-z0-9_-]+/) || [''])[0]
const REPORTS_KEY = 'orgtree.crashReports'
const MAX_REPORTS = 20
const MAX_BREADCRUMBS = 25

export type CrashKind = 'window-error' | 'unhandledrejection' | 'react-boundary'

export interface Breadcrumb {
  at: number
  kind: 'click' | 'route' | 'console-error'
  detail: string
}

export interface CrashReport {
  id: string
  at: number
  kind: CrashKind
  message: string
  stack: string
  componentStack?: string
  url: string
  userAgent: string
  breadcrumbs: Breadcrumb[]
  acked?: boolean
}

function safeParse<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

// ---------------------------------------------------------------- breadcrumbs
// "what had the user just done" — a rolling in-memory trail, cheap enough to
// update on every click with no per-component instrumentation anywhere else
// in the app (additive: this file is the only thing that changed to get it).
const breadcrumbs: Breadcrumb[] = []

function recordBreadcrumb(kind: Breadcrumb['kind'], detail: string): void {
  breadcrumbs.push({ at: Date.now(), kind, detail: detail.slice(0, 300) })
  while (breadcrumbs.length > MAX_BREADCRUMBS) breadcrumbs.shift()
}

function describeTarget(t: EventTarget | null): string {
  // window.Element (not the bare global) — correct in a real browser either
  // way, but also correct under a jsdom test realm that never put Element on
  // globalThis, only on its own window.
  if (!(t instanceof window.Element)) return String(t)
  const el = (t.closest('[aria-label],[title],button,a,[role="button"]') as HTMLElement) || t
  const label = el.getAttribute?.('aria-label') || el.getAttribute?.('title')
    || el.innerText?.trim().slice(0, 40) || ''
  const id = (el as HTMLElement).id
  return `${el.tagName.toLowerCase()}${id ? '#' + id : ''}${label ? ` "${label}"` : ''}`
}

window.addEventListener('click', (e) => {
  try { recordBreadcrumb('click', describeTarget(e.target)) } catch { /* never let a breadcrumb crash the app */ }
}, { capture: true })

// history.pushState doesn't fire an event of its own, and App owns every call
// to it — polling here is the only route-change signal that needs no change
// anywhere else. Cheap: one string compare a second.
let lastPath = location.pathname
const routePoll = setInterval(() => {
  if (location.pathname !== lastPath) {
    lastPath = location.pathname
    recordBreadcrumb('route', lastPath)
  }
}, 1000)
// A browser tab is meant to run this forever — but under node:test (jsdom),
// nothing else keeps the event loop alive after the last test finishes, so an
// un-ref'd interval would hang the process. Node's Timeout carries .unref();
// a browser's numeric timer id does not, so this is a no-op there.
;(routePoll as unknown as { unref?: () => void }).unref?.()

// React logs boundary-caught errors (and much else) through console.error —
// wrapping it gives free extra context in the breadcrumb trail without
// touching React's own error handling.
const origConsoleError = console.error.bind(console)
console.error = (...args: unknown[]) => {
  try { recordBreadcrumb('console-error', args.map((a) => String(a)).join(' ')) } catch { /* ignore */ }
  origConsoleError(...args)
}

// -------------------------------------------------------------- persistence
/** The page's localStorage, or null when the browser denies it. The GETTER
 *  ITSELF throws (SecurityError) where storage is blocked for the origin —
 *  "block all cookies", some enterprise policies, an opaque origin — so
 *  RESOLVING storage and READING it must both happen inside guarded code:
 *  `localStorage.getItem(...)` throws before getItem is ever reached, and a
 *  reference resolved outside the guard is a throw the guard never sees.
 *  Deliberately a local copy of what freezelog.ts's storageOf does rather
 *  than an import:
 *  this file has no imports on purpose (see the header) and a crash reporter
 *  that needed another module to evaluate cleanly first would be exactly the
 *  fragility it exists to survive. */
function storage(): Storage | null {
  try {
    return window.localStorage ?? null
  } catch {
    return null
  }
}

/** Never throws. flushPendingReports() runs BEFORE ReactDOM.createRoot in
 *  main.tsx, so a throw here left the whole app (and /debug/freezes) blank on
 *  a storage-denied browser — the reporter took the page down instead of the
 *  crash it exists to report (coordinator review, 2026-09-07). Denied storage
 *  reads as "no reports on file": nothing was persisted there either. */
function loadReports(): CrashReport[] {
  const s = storage()
  if (!s) return []
  try {
    return safeParse<CrashReport[]>(s.getItem(REPORTS_KEY), [])
  } catch {
    return []
  }
}

function persistLocally(report: CrashReport): void {
  try {
    const list = loadReports()
    list.push(report)
    while (list.length > MAX_REPORTS) list.shift()
    localStorage.setItem(REPORTS_KEY, JSON.stringify(list))
  } catch {
    // storage full or unavailable (private browsing) — the beacon below is
    // still attempted; a report that can't be filed locally can still ship
  }
}

function markAcked(id: string): void {
  try {
    const list = loadReports().map((r) => (r.id === id ? { ...r, acked: true } : r))
    localStorage.setItem(REPORTS_KEY, JSON.stringify(list))
  } catch { /* best effort */ }
}

function currentOrgSlug(): string | null {
  const m = location.pathname.slice(BASE.length).match(/^\/o\/([a-z0-9@-]+)/)
  return m ? m[1]! : null
}

function deliver(report: CrashReport): void {
  const payload = JSON.stringify({ org: currentOrgSlug(), report })
  const url = BASE + '/api/crash-report'
  let sent = false
  try {
    if (navigator.sendBeacon) {
      const blob = new Blob([payload], { type: 'application/json' })
      sent = navigator.sendBeacon(url, blob)
    }
  } catch { sent = false }
  if (sent) return
  try {
    fetch(url, { method: 'POST', body: payload, headers: { 'Content-Type': 'application/json' }, keepalive: true })
      .then(() => markAcked(report.id))
      .catch(() => { /* still saved locally — flushPending retries on next load */ })
  } catch { /* nothing more can be done from here */ }
}

/** Re-attempt delivery for anything that never got a beacon out (e.g. the tab
 *  died mid-crash, or the network was down). Call once on a healthy load. */
export function flushPendingReports(): void {
  const list = loadReports()
  const stale = list.filter((r) => !r.acked)
  for (const r of stale) {
    fetch(BASE + '/api/crash-report', {
      method: 'POST',
      body: JSON.stringify({ org: currentOrgSlug(), report: r }),
      headers: { 'Content-Type': 'application/json' },
    }).then((res) => { if (res.ok) markAcked(r.id) }).catch(() => { /* try again next load */ })
  }
}

let seq = 0
function makeId(): string {
  seq += 1
  return `${Date.now().toString(36)}-${seq}-${Math.random().toString(36).slice(2, 8)}`
}

/** The single entry point every capture path below funnels through. Order is
 *  the whole point: persist FIRST, before delivery and before React (if it's
 *  even still alive) attempts to render anything about the failure. */
export function reportCrash(input: { kind: CrashKind; message: string; stack: string; componentStack?: string }): CrashReport {
  const report: CrashReport = {
    id: makeId(),
    at: Date.now(),
    url: location.href,
    userAgent: navigator.userAgent,
    breadcrumbs: breadcrumbs.slice(),
    ...input,
  }
  persistLocally(report)
  deliver(report)
  // Stable external hook (agreed with the ui-harness rig, 2026-08-30): the
  // MOST RECENT report, always, so an outside browser-automation harness that
  // never touches this module's internals can still read exactly what the
  // app itself captured — real names, real stack, breadcrumbs and all —
  // instead of re-deriving a weaker version from a screenshot or a console
  // scrape. Set last, after persistence/delivery are already committed, so a
  // reader can never observe it before the report is durable.
  ;(window as unknown as Record<string, CrashReport>).__ORGTREE_CRASH__ = report
  return report
}

// ------------------------------------------------------------- catch-alls
// Covers what a React error boundary cannot: event handlers, timers, and any
// error thrown before a boundary has mounted (a first-render failure has no
// boundary above it yet — this listener is the only thing that catches it).
window.addEventListener('error', (e: ErrorEvent) => {
  reportCrash({
    kind: 'window-error',
    message: e.message || String(e.error),
    stack: (e.error && e.error.stack) || `${e.message} (${e.filename}:${e.lineno}:${e.colno})`,
  })
})

// Promise rejections never reach 'error' or a component boundary at all.
window.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
  const reason = e.reason as { message?: string; stack?: string } | undefined
  reportCrash({
    kind: 'unhandledrejection',
    message: (reason && reason.message) || String(e.reason),
    stack: (reason && reason.stack) || String(e.reason),
  })
})

// ------------------------------------------------------------ manual proof
// Gated behind a query param so it can never fire by accident: ?crashtest=
// render | fallback | handler | promise. Used to demonstrate that all four
// capture paths actually work end to end, including a failure inside the
// error UI's own render (which no boundary can catch — see CrashBoundary.tsx).
const crashTestMode = new URLSearchParams(location.search).get('crashtest')
if (crashTestMode === 'handler') {
  window.addEventListener('DOMContentLoaded', () => {
    setTimeout(() => {
      document.body.addEventListener('click', () => {
        throw new Error('crash-test: event handler')
      }, { once: true })
    }, 300)
  })
} else if (crashTestMode === 'promise') {
  setTimeout(() => { void Promise.reject(new Error('crash-test: unhandled rejection')) }, 300)
} else if (crashTestMode === 'render') {
  ;(window as unknown as Record<string, boolean>).__crashTestRender = true
} else if (crashTestMode === 'fallback') {
  ;(window as unknown as Record<string, boolean>).__crashTestRender = true
  ;(window as unknown as Record<string, boolean>).__crashTestFallback = true
}
