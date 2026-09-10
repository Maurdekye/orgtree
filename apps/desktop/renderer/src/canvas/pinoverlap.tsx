import { useSyncExternalStore } from 'react'
import { SetRow, SetToggle } from './settingskit'
export const MODAL_OVERLAP_KEY = 'orgtree-modal-overlap-fade'
export interface ModalOverlapSetting { enabled: boolean; opacity: number }
const DEFAULT_OVERLAP: ModalOverlapSetting = { enabled: false, opacity: 0.7 }
let overlapCache: ModalOverlapSetting | null = null
const overlapSubs = new Set<() => void>()
const readOverlap = (): ModalOverlapSetting => {
  if (overlapCache) return overlapCache
  try {
    const parsed = JSON.parse(localStorage.getItem(MODAL_OVERLAP_KEY) || 'null') as Partial<ModalOverlapSetting> | null
    if (parsed && typeof parsed.enabled === 'boolean' && typeof parsed.opacity === 'number' && Number.isFinite(parsed.opacity)) {
      overlapCache = { enabled: parsed.enabled, opacity: Math.min(0.9, Math.max(0.2, parsed.opacity)) }
      return overlapCache
    }
  } catch { /* private mode or malformed preference */ }
  overlapCache = DEFAULT_OVERLAP
  return overlapCache
}
const writeOverlap = (next: ModalOverlapSetting): void => {
  overlapCache = next
  try { localStorage.setItem(MODAL_OVERLAP_KEY, JSON.stringify(next)) } catch { /* private mode */ }
  for (const fn of [...overlapSubs]) fn()
}
const subscribeOverlap = (fn: () => void): (() => void) => {
  overlapSubs.add(fn)
  const onStorage = (e: StorageEvent) => { if (e.key === null || e.key === MODAL_OVERLAP_KEY) { overlapCache = null; fn() } }
  window.addEventListener('storage', onStorage)
  return () => { overlapSubs.delete(fn); window.removeEventListener('storage', onStorage) }
}
export const useModalOverlap = (): ModalOverlapSetting =>
  useSyncExternalStore(subscribeOverlap, readOverlap, () => DEFAULT_OVERLAP)
export const setModalOverlap = (setting: ModalOverlapSetting): void =>
  writeOverlap({ enabled: setting.enabled, opacity: Number.isFinite(setting.opacity) ? Math.min(0.9, Math.max(0.2, setting.opacity)) : DEFAULT_OVERLAP.opacity })

/** Browser-local controls for the overlap treatment of pinned modal windows. */
export function ModalOverlapSettings() {
  const setting = useModalOverlap()
  return <>
    <SetToggle label="fade pinned desks and modals over expanded desks" checked={setting.enabled}
      onChange={enabled => setModalOverlap({ ...setting, enabled })} />
    <SetRow label="overlap opacity">
      <input aria-label="Overlap opacity" type="range" min="0.2" max="0.9" step="0.05" value={setting.opacity}
        disabled={!setting.enabled}
        onChange={e => setModalOverlap({ ...setting, opacity: Number(e.target.value) })} />
      <span className="set-value">{Math.round(setting.opacity * 100)}%</span>
    </SetRow>
  </>
}
