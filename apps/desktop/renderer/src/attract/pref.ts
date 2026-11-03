/* Attract mode's on/off switch (USER 2026-11-02 mc8e118c58de9 "1 app menu
   toggle"), shown in App menu › Modes beside Streamer mode.

   A NATIVE DESKTOP PREFERENCE (`DesktopPreferences.attractMode`), the same
   shape as EPIC Mode's bit (epic/pref.ts) and for the same reason: the
   renderer's per-origin storage does not reliably survive a relaunch, and the
   main process broadcasts every write to every window, so the toggle is
   app-wide (coordinator gap-fill Q3, m082646bad468). In a plain browser the
   bit lives in localStorage instead.

   ⚠ OFF BY CONSTRUCTION: absent, or anything other than `true`, reads as off. */
import { useSyncExternalStore } from 'react'
import { desktop } from '../desktop'
import type { DesktopPreferences } from '../../../../../packages/contracts'

export const ATTRACT_KEY = 'orgtree-attract-mode'
const STORED = 'orgtree:attract-stored'

const attractOf = (prefs: unknown): boolean =>
  !!prefs && typeof prefs === 'object' && (prefs as Partial<DesktopPreferences>).attractMode === true

/** Follow the stored bit: `accept` runs with the current value and again on
 *  every change, whichever window made it, until the returned function stops it. */
export function watchAttract(accept: (on: boolean) => void): () => void {
  const bridge = desktop()
  if (!bridge) {
    const read = () => {
      let on = false
      try { on = localStorage.getItem(ATTRACT_KEY) === '1' } catch { /* private mode */ }
      accept(on)
    }
    const storage = (e: StorageEvent) => { if (e.key === ATTRACT_KEY || e.key === null) read() }
    read()
    window.addEventListener('storage', storage)
    window.addEventListener(STORED, read)
    return () => { window.removeEventListener('storage', storage); window.removeEventListener(STORED, read) }
  }
  let alive = true, revision = 0
  const stop = bridge.onEvent(e => {
    if (alive && e.type === 'preferences') { revision++; accept(attractOf(e.data)) }
  })
  const initial = revision
  void bridge.getPreferences()
    .then(p => { if (alive && revision === initial) accept(attractOf(p)) })
    .catch(() => {})
  return () => { alive = false; stop() }
}

async function saveAttract(on: boolean): Promise<void> {
  const bridge = desktop()
  if (bridge) { await bridge.setPreferences({ attractMode: on }); return }
  try { localStorage.setItem(ATTRACT_KEY, on ? '1' : '0') } catch { /* private mode */ }
  window.dispatchEvent(new Event(STORED))
}

// one shared subscription per document, as EPIC Mode's switch has
let stored = false
let shown = false
let stopShared: (() => void) | null = null
const subs = new Set<() => void>()
const show = (on: boolean) => { if (on !== shown) { shown = on; for (const s of [...subs]) s() } }

function subscribe(fn: () => void): () => void {
  subs.add(fn)
  if (!stopShared) stopShared = watchAttract(on => { stored = on; show(on) })
  return () => {
    subs.delete(fn)
    if (!subs.size && stopShared) { stopShared(); stopShared = null }
  }
}

/** The toggle's state for React. Off until the stored value has been read. */
export const useAttractMode = (): boolean =>
  useSyncExternalStore(subscribe, () => shown, () => false)

/** Show the flip at once; the broadcast confirms it, and a failed write puts
 *  the toggle back to what is really stored. */
export function setAttractMode(on: boolean): Promise<void> {
  show(on)
  return saveAttract(on).catch(() => show(stored))
}

// ---------------------------------------------------------------- start after
/* The idle delay (USER 2026-11-03 me67326548f6c "also allow attract mode's idle
   timeout to be configurable, as low as 0"): `DesktopPreferences.attractIdleSeconds`,
   whole seconds, 0 and up, no maximum, absent = 300. One app-wide value like
   the toggle; each window's timer reads it live. In a plain browser it lives
   in localStorage. */
export const DEFAULT_ATTRACT_IDLE_SECONDS = 300
export const ATTRACT_IDLE_KEY = 'orgtree-attract-idle'
export const ATTRACT_IDLE_EVENT = 'orgtree:attract-idle-stored'

/** a stored value is valid only as a whole number of seconds, 0 or more */
export const validAttractIdle = (n: unknown): n is number =>
  typeof n === 'number' && Number.isSafeInteger(n) && n >= 0
const idleOf = (v: unknown): number => validAttractIdle(v) ? v : DEFAULT_ATTRACT_IDLE_SECONDS
const idleOfPrefs = (prefs: unknown): number =>
  idleOf(prefs && typeof prefs === 'object' ? (prefs as Partial<DesktopPreferences>).attractIdleSeconds : undefined)

/** Follow the stored delay: `accept` runs with the current value and again on
 *  every change, whichever window made it. */
export function watchAttractIdle(accept: (seconds: number) => void): () => void {
  const bridge = desktop()
  if (!bridge) {
    const read = () => {
      let n: unknown
      try { const raw = localStorage.getItem(ATTRACT_IDLE_KEY); n = raw === null || raw.trim() === '' ? undefined : Number(raw) } catch { /* private mode */ }
      accept(idleOf(n))
    }
    const storage = (e: StorageEvent) => { if (e.key === ATTRACT_IDLE_KEY || e.key === null) read() }
    read()
    window.addEventListener('storage', storage)
    window.addEventListener(ATTRACT_IDLE_EVENT, read)
    return () => { window.removeEventListener('storage', storage); window.removeEventListener(ATTRACT_IDLE_EVENT, read) }
  }
  let alive = true, revision = 0
  const stop = bridge.onEvent(e => {
    if (alive && e.type === 'preferences') { revision++; accept(idleOfPrefs(e.data)) }
  })
  const initial = revision
  void bridge.getPreferences()
    .then(p => { if (alive && revision === initial) accept(idleOfPrefs(p)) })
    .catch(() => {})
  return () => { alive = false; stop() }
}

let idleStored = DEFAULT_ATTRACT_IDLE_SECONDS
let idleShown = DEFAULT_ATTRACT_IDLE_SECONDS
let stopIdleShared: (() => void) | null = null
const idleSubs = new Set<() => void>()
const showIdle = (n: number) => { if (n !== idleShown) { idleShown = n; for (const s of [...idleSubs]) s() } }

function subscribeIdle(fn: () => void): () => void {
  idleSubs.add(fn)
  if (!stopIdleShared) stopIdleShared = watchAttractIdle(n => { idleStored = n; showIdle(n) })
  return () => {
    idleSubs.delete(fn)
    if (!idleSubs.size && stopIdleShared) { stopIdleShared(); stopIdleShared = null }
  }
}

/** The delay in seconds, for React; 300 until the stored value has been read. */
export const useAttractIdleSeconds = (): number =>
  useSyncExternalStore(subscribeIdle, () => idleShown, () => DEFAULT_ATTRACT_IDLE_SECONDS)

/** Store the delay. Anything but a whole number of seconds, 0 or more, is
 *  refused: nothing is written or announced. A failed write puts back what is
 *  really stored. */
export async function setAttractIdleSeconds(seconds: number): Promise<void> {
  if (!validAttractIdle(seconds)) return
  showIdle(seconds)
  const bridge = desktop()
  try {
    if (bridge) { await bridge.setPreferences({ attractIdleSeconds: seconds }); return }
    try { localStorage.setItem(ATTRACT_IDLE_KEY, String(seconds)) } catch { /* private mode */ }
    window.dispatchEvent(new Event(ATTRACT_IDLE_EVENT))
  } catch { showIdle(idleStored) }
}
