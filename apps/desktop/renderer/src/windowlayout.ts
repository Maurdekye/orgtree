import { desktop } from './desktop'
import { useEffect, useState } from 'react'

export const WINDOW_LAYOUT_KEY = 'orgtree-desktop-windows-v1'
export interface WindowRect { x: number; y: number; width: number; height: number }
export interface SavedWindow { key: string; kind: string; org: string | null; open: boolean; rect: WindowRect }
let exiting = false
export const windowExitStarted = () => exiting
export const beginWindowExit = () => { exiting = true }
export function useRestoreWindows() {
  const bridge = desktop()
  const [allowed, setAllowed] = useState(() => !!bridge && !bridge.getWindowState)
  useEffect(() => {
    if (!bridge?.getWindowState) return
    let alive = true
    void bridge.getWindowState().then(state => { if (alive) setAllowed(state.restoreWindows) }).catch(() => {})
    const unsubscribe = bridge.onEvent(event => {
      if ((event.type as string) === 'main-window-shown' && alive) {
        setAllowed((event.data as { restoreWindows?: boolean })?.restoreWindows === true)
      }
    })
    return () => { alive = false; unsubscribe() }
  }, [bridge])
  return allowed
}
export const windowLayoutKey = (kind: string, org: string | null) => JSON.stringify([org, kind])
const valid = (v: unknown): v is SavedWindow => {
  if (!v || typeof v !== 'object') return false
  const r = v as SavedWindow
  return typeof r.key === 'string' && r.key.length < 1024 && typeof r.kind === 'string'
    && (r.org === null || typeof r.org === 'string') && typeof r.open === 'boolean'
    && !!r.rect && [r.rect.x, r.rect.y, r.rect.width, r.rect.height].every(Number.isFinite)
    && r.rect.width >= 200 && r.rect.height >= 150 && r.rect.width <= 20000 && r.rect.height <= 20000
}
export function savedWindows(): SavedWindow[] {
  try {
    const rows: unknown = JSON.parse(localStorage.getItem(WINDOW_LAYOUT_KEY) ?? '[]')
    return Array.isArray(rows) ? rows.filter(valid).slice(-100) : []
  } catch { return [] }
}
export function saveWindow(row: SavedWindow) {
  if (!valid(row)) return
  try {
    const previous = savedWindows()
    if (JSON.stringify(previous.find(r => r.key === row.key)) === JSON.stringify(row)) return
    const rows = previous.filter(r => r.key !== row.key)
    rows.push(row)
    const value = JSON.stringify(rows.slice(-100))
    if (localStorage.getItem(WINDOW_LAYOUT_KEY) !== value) localStorage.setItem(WINDOW_LAYOUT_KEY, value)
  } catch { /* drafts and window operation still work when storage is full */ }
}
export const restoredWindows = (org: string | null) =>
  desktop() ? savedWindows().filter(r => r.open && r.org === org) : []
export const restoreWindowKind = (kind: string, org: string | null) =>
  restoredWindows(org).some(r => r.kind === kind)
export function captureWindow(key: string, kind: string, org: string | null, w: Window, open = true) {
  if (!desktop()) return
  try {
    saveWindow({ key, kind, org, open, rect: {
      x: w.screenX, y: w.screenY, width: w.outerWidth || 900, height: w.outerHeight || 760,
    } })
  } catch { /* a closing native window can lose its document first */ }
}
export function closeSavedWindow(key: string) {
  if (exiting) return
  const row = savedWindows().find(r => r.key === key)
  if (row) saveWindow({ ...row, open: false })
}
export function popupFeatures(key: string) {
  const rect = savedWindows().find(r => r.key === key)?.rect
  return rect ? `popup,left=${Math.round(rect.x)},top=${Math.round(rect.y)},width=${Math.round(rect.width)},height=${Math.round(rect.height)}`
    : 'popup,width=900,height=760'
}
export function savedDeskIdentities(org: string): [string, string, number][] {
  return restoredWindows(org).flatMap(r => {
    if (!r.kind.startsWith('desk:')) return []
    try {
      const value = JSON.parse(r.kind.slice(5))
      return Array.isArray(value) && value.length === 3 && value[0] === org
        && typeof value[1] === 'string' && Number.isSafeInteger(value[2]) && value[2] >= 0
        ? [value as [string, string, number]] : []
    } catch { return [] }
  })
}
