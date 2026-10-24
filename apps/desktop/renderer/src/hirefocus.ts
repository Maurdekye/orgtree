import { useSyncExternalStore } from 'react'

// USER 2026-10-24: a profile view preference, not an organization/hire option.
// Read at completion and before a queued reveal; never change the hire itself.
export const HIRE_AUTO_FOCUS_KEY = 'orgtree-hire-auto-focus'
export function hireAutoFocusOn(): boolean {
  try { return localStorage.getItem(HIRE_AUTO_FOCUS_KEY) !== '0' } catch { return true }
}
const listeners = new Set<() => void>()
export function setHireAutoFocusOn(on: boolean): void {
  try { localStorage.setItem(HIRE_AUTO_FOCUS_KEY, on ? '1' : '0') } catch { /* private mode */ }
  for (const fn of [...listeners]) fn()
}
function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  window.addEventListener('storage', fn)
  return () => { listeners.delete(fn); window.removeEventListener('storage', fn) }
}
export const useHireAutoFocus = (): boolean => useSyncExternalStore(subscribe, hireAutoFocusOn)
