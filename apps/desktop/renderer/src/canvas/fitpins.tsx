import { useSyncExternalStore } from 'react'
import { SetToggle } from './settingskit'

/**
 * FIT THE VIEW AROUND PINNED WINDOWS (USER 2026-11-27 13:30:10Z m56eddd849c57 "add a new display option that stops
 * re-fitting the active view to what's visible behind pinned windows when disabled. enabled by default (current
 * functionality)"; 13:31:21Z mc5532e448c3b "Ignore pinned windows entirely").
 *
 * ON (the default, and what the canvas has always done): the camera fits and focuses in the free region beside pinned
 * windows and modals (OrgCanvas `regionOf`), and re-fits when they open, move, resize or close. OFF: the camera
 * ignores them entirely - Fit, Focus, zoom and the desk/eye gates measured against the camera all use the whole
 * viewport, and a pin change moves nothing. Toggling alone never moves the camera; the next camera command follows.
 * Non-camera layout that dodges pins (the canvas controls' anchor, edge jump cards) is unchanged.
 *
 * BROWSER-LOCAL, like its Desk siblings and in the same store shape as `canvasanchor.tsx`: a preference never saved,
 * or malformed, reads as on.
 */
export const FIT_AROUND_PINS_KEY = 'orgtree-fit-around-pins'
export interface FitAroundPinsPref { enabled: boolean }
const DEFAULT_PREF: FitAroundPinsPref = { enabled: true }

let cache: FitAroundPinsPref | null = null
const subs = new Set<() => void>()
const read = (): FitAroundPinsPref => {
  if (cache) return cache
  try {
    const parsed = JSON.parse(localStorage.getItem(FIT_AROUND_PINS_KEY) || 'null') as Partial<FitAroundPinsPref> | null
    if (parsed && typeof parsed.enabled === 'boolean') { cache = { enabled: parsed.enabled }; return cache }
  } catch { /* private mode or malformed preference */ }
  cache = DEFAULT_PREF
  return cache
}
const write = (next: FitAroundPinsPref): void => {
  cache = next
  try { localStorage.setItem(FIT_AROUND_PINS_KEY, JSON.stringify(next)) } catch { /* private mode */ }
  for (const fn of [...subs]) fn()
}
const subscribe = (fn: () => void): (() => void) => {
  subs.add(fn)
  const onStorage = (e: StorageEvent) => { if (e.key === null || e.key === FIT_AROUND_PINS_KEY) { cache = null; fn() } }
  window.addEventListener('storage', onStorage)
  return () => { subs.delete(fn); window.removeEventListener('storage', onStorage) }
}
export const useFitAroundPins = (): FitAroundPinsPref => useSyncExternalStore(subscribe, read, () => DEFAULT_PREF)
export const setFitAroundPins = (pref: FitAroundPinsPref): void => write({ enabled: !!pref.enabled })
/** test seam, as `forgetCanvasAnchor` */
export const forgetFitAroundPins = (): void => { cache = null }

/** The Display › Desk row. */
export function FitAroundPinsSetting() {
  const pref = useFitAroundPins()
  return <SetToggle label="Fit the view around pinned windows" checked={pref.enabled}
    onChange={enabled => setFitAroundPins({ enabled })}
    hint="When on, the canvas fits and focuses in the space beside pinned windows and re-fits when they move. When off, pinned windows are ignored and the view uses the whole canvas." />
}
