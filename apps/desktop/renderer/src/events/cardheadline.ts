import { useSyncExternalStore } from 'react'

// USER 2026-11-05 m2f08b7c44dcc ("make this an optional toggle in app display settings"), default off
// (m2edcc8040105): a profile view preference, like hirefocus.ts. When on, a websocket or MQTT watchdog
// message's words lead its card (events/firelines.ts headline); off keeps the plain JSON view.
// Anything but '1' reads as off.
export const EVENT_HEADLINE_KEY = 'orgtree-event-card-headline'
export function eventHeadlineOn(): boolean {
  try { return localStorage.getItem(EVENT_HEADLINE_KEY) === '1' } catch { return false }
}
const listeners = new Set<() => void>()
export function setEventHeadlineOn(on: boolean): void {
  try { localStorage.setItem(EVENT_HEADLINE_KEY, on ? '1' : '0') } catch { /* private mode */ }
  for (const fn of [...listeners]) fn()
}
function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  window.addEventListener('storage', fn)
  return () => { listeners.delete(fn); window.removeEventListener('storage', fn) }
}
export const useEventHeadline = (): boolean => useSyncExternalStore(subscribe, eventHeadlineOn)
