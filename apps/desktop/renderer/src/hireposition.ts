import { useSyncExternalStore } from 'react'

// USER 2026-10-23: app-wide Display preference, applied once at creation.
// Existing nodes, explicit side/above positions and templates keep their order.
export type NewHirePosition = 'end' | 'start' | 'centre'
export const NEW_HIRE_POSITION_KEY = 'orgtree-new-hire-position'
export function newHirePositionOf(): NewHirePosition {
  try {
    const value = localStorage.getItem(NEW_HIRE_POSITION_KEY)
    return value === 'start' || value === 'centre' ? value : 'end'
  } catch { return 'end' }
}
const listeners = new Set<() => void>()
export function setNewHirePosition(position: NewHirePosition): void {
  try { localStorage.setItem(NEW_HIRE_POSITION_KEY, position) } catch { /* private mode */ }
  for (const fn of [...listeners]) fn()
}
function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  window.addEventListener('storage', fn)
  return () => { listeners.delete(fn); window.removeEventListener('storage', fn) }
}
export const useNewHirePosition = (): NewHirePosition =>
  useSyncExternalStore(subscribe, newHirePositionOf)

/** Zero-based insertion among LIVE direct children, including projects. */
export function newHireIndex(count: number, position: NewHirePosition): number {
  return position === 'start' ? 0 : position === 'centre' ? Math.ceil(count / 2) : count
}

/** Resolve against live siblings at admission, not a stale UI count.
 * Omitting End preserves the old request and template/agent-tool behavior. */
export function newHirePlacement(explicit = false): { user_position?: NewHirePosition } {
  const position = newHirePositionOf()
  return explicit || position === 'end' ? {} : { user_position: position }
}
