/* EPIC Mode — the secret switch's one stored bit.

   A NATIVE DESKTOP PREFERENCE (`DesktopPreferences.epicMode`), like the
   Rainbow theme beside it, because the renderer's own per-origin storage does
   not reliably survive a relaunch (contracts/index.ts). The main process
   broadcasts every preference write to every window, so turning EPIC Mode on
   in one window turns it on in all of them. In a plain browser, which has no
   native bridge, the same bit lives in localStorage instead.

   ⚠ OFF BY CONSTRUCTION. The key is absent until the switch is first used, and
   anything other than `true` reads as off: a fresh install, an older
   preferences file and a corrupt value all get the ordinary, restrained app,
   with nothing to migrate. */
import { useSyncExternalStore } from 'react'
import { desktop } from '../desktop'
import type { DesktopPreferences } from '../../../../../packages/contracts'

export const EPIC_KEY = 'orgtree-epic-mode'
const STORED = 'orgtree:epic-stored'

const epicOf = (prefs: unknown): boolean =>
  !!prefs && typeof prefs === 'object' && (prefs as Partial<DesktopPreferences>).epicMode === true

/** Follow the stored bit: `accept` runs with the current value and again on
 *  every change, until the returned function stops it. */
export function watchEpic(accept: (on: boolean) => void): () => void {
  const bridge = desktop()
  if (!bridge) {
    const read = () => {
      let on = false
      try { on = localStorage.getItem(EPIC_KEY) === '1' } catch { /* private mode */ }
      accept(on)
    }
    const storage = (e: StorageEvent) => { if (e.key === EPIC_KEY || e.key === null) read() }
    read()
    window.addEventListener('storage', storage)
    window.addEventListener(STORED, read)
    return () => { window.removeEventListener('storage', storage); window.removeEventListener(STORED, read) }
  }
  let alive = true, revision = 0
  const stop = bridge.onEvent(e => {
    if (alive && e.type === 'preferences') { revision++; accept(epicOf(e.data)) }
  })
  const initial = revision
  void bridge.getPreferences()
    .then(p => { if (alive && revision === initial) accept(epicOf(p)) })
    .catch(() => {})
  return () => { alive = false; stop() }
}

export async function saveEpic(on: boolean): Promise<void> {
  const bridge = desktop()
  if (bridge) { await bridge.setPreferences({ epicMode: on }); return }
  try { localStorage.setItem(EPIC_KEY, on ? '1' : '0') } catch { /* private mode */ }
  window.dispatchEvent(new Event(STORED))
}

/* One shared subscription per document for the React switch, so the settings
   row and anything else that asks read the same value without each opening
   its own native subscription. */
let stored = false      // the last value the store reported
let shown = false       // what the switch draws: `stored`, or a click in flight
let stopShared: (() => void) | null = null
const subs = new Set<() => void>()
const notify = () => { for (const s of [...subs]) s() }
const show = (on: boolean) => { if (on !== shown) { shown = on; notify() } }

function subscribe(fn: () => void): () => void {
  subs.add(fn)
  if (!stopShared) stopShared = watchEpic(on => { stored = on; show(on) })
  // the last known value stays for the next mount, so reopening settings with
  // EPIC Mode on does not draw the switch hidden for a frame before the read
  return () => {
    subs.delete(fn)
    if (!subs.size && stopShared) { stopShared(); stopShared = null }
  }
}

/** The switch's state for React. Off until the stored value has been read. */
export const useEpicMode = (): boolean =>
  useSyncExternalStore(subscribe, () => shown, () => false)

/** Show a click at once; the store's broadcast confirms it, and a failed
 *  write puts the switch back to what is really stored. */
export function setEpicMode(on: boolean): Promise<void> {
  clickedAt = performance.now()
  show(on)
  return saveEpic(on).catch(() => show(stored))
}

/* Which window flipped the switch: the broadcast reaches every window, and
   only the one the user clicked in plays the full fanfare. */
let clickedAt = -Infinity
export const tookLocalClick = (): boolean => performance.now() - clickedAt < 3000
