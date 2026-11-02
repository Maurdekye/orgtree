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
