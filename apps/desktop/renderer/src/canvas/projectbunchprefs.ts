import { useSyncExternalStore } from 'react'

const KEY = 'orgtree-project-bunches'
const REARRANGE_KEY = 'orgtree-project-bunch-rearrange'
const listeners = new Set<() => void>()
export function projectBunchesOn(): boolean {
  try { return localStorage.getItem(KEY) !== '0' } catch { return true }
}
export function setProjectBunchesOn(on: boolean) {
  try { localStorage.setItem(KEY, on ? '1' : '0') } catch { /* storage unavailable */ }
  listeners.forEach(f => f())
}
export function projectBunchRearrangeOn(): boolean {
  try { return localStorage.getItem(REARRANGE_KEY) === '1' } catch { return false }
}
export function setProjectBunchRearrangeOn(on: boolean) {
  try { localStorage.setItem(REARRANGE_KEY, on ? '1' : '0') } catch { /* storage unavailable */ }
  listeners.forEach(f => f())
}
function subscribe(f: () => void) {
  listeners.add(f)
  const storage = (e: StorageEvent) => { if (e.key === KEY || e.key === REARRANGE_KEY || e.key === null) f() }
  window.addEventListener('storage', storage)
  return () => { listeners.delete(f); window.removeEventListener('storage', storage) }
}
export const useProjectBunches = () => useSyncExternalStore(subscribe, projectBunchesOn, () => true)
export const useProjectBunchRearrange = () => useSyncExternalStore(subscribe, projectBunchRearrangeOn, () => false)
