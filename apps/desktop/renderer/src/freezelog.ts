// Freeze log — a passive in-page recorder of the moments the UI stopped
// painting, kept so that a freeze the user felt can be lined up with the
// host-side memory sampler and Chrome's own GPU-process crash dumps
// (docket: diagnose-ui-lag-freezes-and-browser-crashes, user approval
// 2026-09-07). It records; it never repairs, retries or reports anywhere.
//
// WHAT IT RECORDS, and only these:
//   gap        two consecutive animation frames further apart than the
//              threshold (default 250 ms — a 60 Hz page paints every 16 ms,
//              so this is ~15 missed frames, well past "a heavy render")
//   longtask   a PerformanceObserver 'longtask' entry, where the browser
//              supports it (Chrome): the main thread held for ≥50 ms, with
//              the attribution the browser gives
//   visibility document.visibilityState changed — the time a hidden tab spent
//              hidden is NOT a freeze and is never measured; the interval from
//              the change to the first frame after it IS, and says so, and so
//              is a long interval from the last frame to the moment the tab
//              went hidden (a freeze the user switched away from)
//   lifecycle  pagehide / pageshow / freeze / resume (Page Lifecycle API):
//              the events around a tab being discarded or restored
//   start      the recorder was installed — one per page load, so a reload
//              after a crash shows as a new start with the previous tab's
//              last entries still ahead of it
//
// WHERE IT LIVES: localStorage, ONE KEY PER TAB, deliberately.
//   • Not sessionStorage: it is scoped to the tab, and after a GPU-process
//     loss or a renderer crash whether it comes back depends on Chrome's
//     session restore — sometimes it does, sometimes the tab is simply gone.
//     localStorage is durable regardless, and is readable from ANOTHER tab,
//     which is what lets `/debug/freezes` show the log of a tab that is gone.
//   • One key per tab (`orgtree.freezes.<tab>`), never one shared ring: two
//     open orgtree tabs each read-modify-write, and a shared key would let one
//     tab's write silently drop the other's entry. The tab id is random, kept
//     in sessionStorage so it is stable for that tab's life and nothing else's.
// RETENTION, explicit: each tab's ring keeps its last 200 entries (a few dozen
// bytes each); on every install the tab keys are pruned to the 10 most recent
// by last entry, and any key whose newest entry is older than 7 days goes.
// Reading merges every tab's ring by time. Clear removes every tab's key.
//
// COST: one requestAnimationFrame callback per painted frame that does a
// subtraction and a compare, and a storage write only when something is
// recorded — which, on a healthy page, is never. No imports, for the same
// reason crashReporter.ts has none: an instrument for a broken page must not
// depend on the page loading cleanly.
//
// NOT A GPU MEASUREMENT: there is no web API for GPU memory. This shows
// freezes as the page experienced them; the sampler shows the budget.
//
// WHAT A LONE HUGE GAP CAN ALSO MEAN (redteam-opus, 2026-09-07), for whoever
// reads /debug/freezes: a Chromium window that is fully covered by another
// window still reports 'visible' but stops painting, so any frame-based
// detector logs that as one long gap; and a "before the tab was hidden" entry
// right after a `start` measures from install, i.e. it can be page load.
// Neither is a freeze of the page's own making; both are still real time
// during which the page did not paint.

export type FreezeKind = 'gap' | 'longtask' | 'visibility' | 'lifecycle' | 'start'

export interface FreezeEntry {
  /** epoch ms — the same clock as the sampler's ts_utc column */
  at: number
  kind: FreezeKind
  /** gap / longtask: the duration */
  ms?: number
  detail: string
  /** document.visibilityState when recorded */
  vis: string
  /** the tab this came from */
  tab: string
  /** Chrome only: performance.memory.usedJSHeapSize, MB */
  heap_mb?: number
}

/** every tab's ring lives under this prefix + its tab id */
export const FREEZE_LOG_PREFIX = 'orgtree.freezes.'
export const freezeLogKey = (tab: string): string => FREEZE_LOG_PREFIX + tab
const TAB_KEY = 'orgtree.freezes-tab'   // sessionStorage: this tab's id (not under the prefix)
const LEGACY_KEY = 'orgtree.freezes'    // the one shared ring of the first build; removed at install and by Clear
export const FREEZE_LOG_CAP = 200
export const FREEZE_LOG_TABS_KEPT = 10
export const FREEZE_LOG_MAX_AGE_MS = 7 * 24 * 3600 * 1000

export interface FreezeLogOptions {
  /** frame gap at or above this is recorded (ms) */
  thresholdMs?: number
  cap?: number
  /** injection points for tests; production uses the browser's own */
  raf?: (cb: (t: number) => void) => number
  caf?: (id: number) => void
  now?: () => number
  storage?: Storage
  doc?: Document
  win?: Window
}

function safeParse(raw: string | null): FreezeEntry[] {
  if (!raw) return []
  try {
    const v = JSON.parse(raw) as unknown
    return Array.isArray(v) ? (v as FreezeEntry[]) : []
  } catch {
    return []
  }
}

function tabKeys(storage: Storage): string[] {
  const keys: string[] = []
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i)
    if (k && k.startsWith(FREEZE_LOG_PREFIX)) keys.push(k)
  }
  return keys
}

/** The page's localStorage, or null when the browser denies it. The GETTER
 *  itself throws (SecurityError) when storage is blocked for the origin,
 *  and main.tsx installs the recorder BEFORE React mounts, so an unguarded
 *  `localStorage` here would have the recorder throw at startup for the sake
 *  of an optional instrument (coordinator review, 2026-09-07). Every entry
 *  point acquires storage through this and treats null as "recorder off".
 *  This guards THE RECORDER only: whether the app as a whole starts on a
 *  storage-denied browser also depends on the other startup code that
 *  touches storage (crashReporter's flushPendingReports runs first in
 *  main.tsx and is not guarded — a separate item, redteam-opus 2026-09-07). */
function storageOf(win: Window, given?: Storage): Storage | null {
  if (given) return given
  try {
    return win.localStorage ?? null
  } catch {
    return null
  }
}

/** Every tab's entries, merged and ordered by time (oldest first); empty
 *  when storage is unavailable. */
export function readFreezeLog(storage?: Storage): FreezeEntry[] {
  const s = storageOf(window, storage)
  if (!s) return []
  try {
    const all: FreezeEntry[] = []
    for (const k of tabKeys(s)) all.push(...safeParse(s.getItem(k)))
    return all.sort((a, b) => a.at - b.at)
  } catch {
    return []
  }
}

/** One tab's ring, as stored. */
export function readTabFreezeLog(tab: string, storage?: Storage): FreezeEntry[] {
  const s = storageOf(window, storage)
  if (!s) return []
  try {
    return safeParse(s.getItem(freezeLogKey(tab)))
  } catch {
    return []
  }
}

export function clearFreezeLog(storage?: Storage): void {
  const s = storageOf(window, storage)
  if (!s) return
  try {
    for (const k of tabKeys(s)) s.removeItem(k)
    s.removeItem(LEGACY_KEY)
  } catch {
    // denied mid-way: nothing to clear that we can reach
  }
}

/** Retention: drop tab rings whose newest entry is older than maxAge, then
 *  keep only the `keep` most recent rings by newest entry. Never touches the
 *  ring named in `except` (the installing tab's own). */
export function pruneFreezeLog(storage: Storage, now: number, except: string,
  keep: number = FREEZE_LOG_TABS_KEPT, maxAge: number = FREEZE_LOG_MAX_AGE_MS): void {
  const rings = tabKeys(storage)
    .filter((k) => k !== freezeLogKey(except))
    .map((k) => {
      const ring = safeParse(storage.getItem(k))
      const newest = ring.length ? ring[ring.length - 1]!.at : 0
      return { k, newest }
    })
  const stale = rings.filter((r) => now - r.newest > maxAge)
  const fresh = rings.filter((r) => now - r.newest <= maxAge).sort((a, b) => b.newest - a.newest)
  for (const r of stale) storage.removeItem(r.k)
  for (const r of fresh.slice(Math.max(0, keep - 1))) storage.removeItem(r.k)   // -1: the installing tab counts
}

function tabId(win: Window): string {
  try {
    const s = win.sessionStorage
    let id = s.getItem(TAB_KEY)
    if (!id) {
      id = Math.random().toString(36).slice(2, 8)
      s.setItem(TAB_KEY, id)
    }
    return id
  } catch {
    return 'unknown'
  }
}

function heapMb(win: Window): number | undefined {
  const mem = (win.performance as unknown as { memory?: { usedJSHeapSize?: number } }).memory
  const used = mem?.usedJSHeapSize
  return typeof used === 'number' ? Math.round(used / 1048576) : undefined
}

/** Eviction order when a ring is over cap: the churn kinds first. A day of
 *  tab switching is hundreds of visibility entries, and the freeze they
 *  would otherwise push out is the one the log exists to keep (redteam-opus
 *  FL1, 2026-09-07: a real 802 ms gap was gone after 210 visibility events).
 *  `visibility` and `lifecycle` go first, oldest first; only when none is
 *  left does the oldest gap/longtask/start go. */
const CHURN: ReadonlySet<FreezeKind> = new Set<FreezeKind>(['visibility', 'lifecycle'])
export function trimRing(ring: FreezeEntry[], cap: number): void {
  while (ring.length > cap) {
    const i = ring.findIndex((e) => CHURN.has(e.kind))
    ring.splice(i >= 0 ? i : 0, 1)
  }
}

/** Start recording. Returns a function that stops it (and detaches every
 *  listener), which is what a test needs and what production never calls.
 *  A denied storage getter does not make this throw: the recorder is simply
 *  off and the returned stop is a no-op (see storageOf for what this does
 *  and does not cover). */
export function installFreezeLog(opts: FreezeLogOptions = {}): () => void {
  const threshold = opts.thresholdMs ?? 250
  const cap = opts.cap ?? FREEZE_LOG_CAP
  const win = opts.win ?? window
  const doc = opts.doc ?? document
  const storage = storageOf(win, opts.storage)
  if (!storage) return () => {}
  const raf = opts.raf ?? ((cb) => win.requestAnimationFrame(cb))
  const caf = opts.caf ?? ((id) => win.cancelAnimationFrame(id))
  const now = opts.now ?? (() => win.performance.now())
  const tab = tabId(win)
  const key = freezeLogKey(tab)

  const record = (kind: FreezeKind, detail: string, ms?: number): void => {
    const entry: FreezeEntry = { at: Date.now(), kind, detail, vis: doc.visibilityState, tab }
    if (ms !== undefined) entry.ms = Math.round(ms)
    const heap = heapMb(win)
    if (heap !== undefined) entry.heap_mb = heap
    try {
      // this tab's ring only: no other tab writes this key, so the
      // read-modify-write cannot lose anyone else's entry
      const ring = safeParse(storage.getItem(key))
      ring.push(entry)
      trimRing(ring, cap)
      try {
        storage.setItem(key, JSON.stringify(ring))
      } catch {
        // quota: keep the newest few rather than silently keeping nothing
        storage.setItem(key, JSON.stringify(ring.slice(-20)))
      }
    } catch {
      // storage unavailable: the recorder stays quiet rather than throwing
    }
  }

  try {
    storage.removeItem(LEGACY_KEY)   // the pre-per-tab shared ring, orphaned in any profile that ran it
    pruneFreezeLog(storage, Date.now(), tab)
  } catch { /* same rule */ }
  record('start', win.location.pathname)

  // ---- frame gaps
  // `last` is the start of the interval being measured. A visibility or
  // lifecycle event RESETS it, so the time the tab spent hidden (no frames
  // are painted while hidden) is never measured as a gap — and the first
  // interval after the tab returns IS measured, from the event to the first
  // frame, and recorded with the event named: "I switched back and it hung
  // for three seconds" is one of the shapes this exists to catch (redteam-
  // opus FL2, 2026-09-07; the first cut threw that interval away). A frame
  // that somehow arrives while the document is hidden only resets the start.
  let last = now()
  let sinceEvent: string | null = null   // the event the current interval started at
  let stopped = false
  let handle = 0
  const frame = (): void => {
    if (stopped) return
    const t = now()
    if (doc.visibilityState !== 'hidden') {   // 'visible' — or jsdom's 'prerender' under test
      const gap = t - last
      if (gap >= threshold) {
        record('gap', `${Math.round(gap)} ms ${sinceEvent ? `from ${sinceEvent} to the first frame` : 'between frames'}`, gap)
      }
    }
    sinceEvent = null
    last = t
    handle = raf(frame)
  }
  handle = raf(frame)

  // ---- visibility and lifecycle
  const mark = (name: string): void => {
    sinceEvent = name
    last = now()
  }
  const onVisibility = (): void => {
    // going HIDDEN: the interval since the last frame was a VISIBLE interval,
    // so if it is long it was a real freeze — one the user switched away from
    // mid-block, which no frame will ever measure because the tab is hidden by
    // the time the next one could run. Measure it here, on the hide side only
    // (on the show side the interval is the hidden time itself).
    if (doc.visibilityState === 'hidden') {
      const gap = now() - last
      if (gap >= threshold) record('gap', `${Math.round(gap)} ms before the tab was hidden`, gap)
    }
    record('visibility', doc.visibilityState)
    mark(`visibility ${doc.visibilityState}`)
  }
  doc.addEventListener('visibilitychange', onVisibility)
  const lifecycle = ['pagehide', 'pageshow', 'freeze', 'resume'] as const
  const onLifecycle = (e: Event): void => {
    const persisted = (e as { persisted?: boolean }).persisted
    record('lifecycle', e.type + (persisted === undefined ? '' : ` persisted=${persisted}`))
    mark(e.type)
  }
  for (const ev of lifecycle) win.addEventListener(ev, onLifecycle)

  // ---- long tasks (Chrome)
  let observer: PerformanceObserver | null = null
  try {
    const PO = (win as unknown as { PerformanceObserver?: typeof PerformanceObserver }).PerformanceObserver
    if (PO && (PO.supportedEntryTypes ?? []).includes('longtask')) {
      observer = new PO((list) => {
        for (const e of list.getEntries()) {
          const attr = (e as unknown as { attribution?: Array<{ name?: string; containerType?: string }> }).attribution
          const who = attr && attr.length ? ` ${attr.map((a) => a.containerType ?? a.name ?? '').filter(Boolean).join(',')}` : ''
          record('longtask', `${Math.round(e.duration)} ms main thread${who}`, e.duration)
        }
      })
      observer.observe({ entryTypes: ['longtask'] })
    }
  } catch {
    observer = null
  }

  return () => {
    stopped = true
    caf(handle)
    doc.removeEventListener('visibilitychange', onVisibility)
    for (const ev of lifecycle) win.removeEventListener(ev, onLifecycle)
    observer?.disconnect()
  }
}
