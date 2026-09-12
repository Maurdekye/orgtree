import { desktop } from './desktop'
import { useEffect, useState } from 'react'

export const WINDOW_LAYOUT_KEY = 'orgtree-desktop-windows-v1'
export interface WindowRect { x: number; y: number; width: number; height: number }
export interface WindowRestore { agent?: string; generation?: number; document?: string; watchdog?: string }
export interface SavedWindow { restore?: WindowRestore; key: string; kind: string; org: string | null; open: boolean; rect: WindowRect }
let exiting = false
export const windowExitStarted = () => exiting
export const beginWindowExit = () => { exiting = true }
/** An exit can be ABANDONED - an update that refuses to replace files over an
 *  engine it cannot confirm has stopped puts the app back. Without this the
 *  flag stayed latched and the window silently stopped saving its layout. */
export const endWindowExit = () => { exiting = false }
export function useRestoreWindows() {
  const bridge = desktop()
  const [allowed, setAllowed] = useState<boolean>(() => !!bridge && !bridge.getWindowState)
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
const validRestore = (v: unknown): v is WindowRestore => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  return Object.entries(v).every(([key, value]) => key === 'generation'
    ? Number.isSafeInteger(value) && Number(value) >= 0
    : ['agent', 'document', 'watchdog'].includes(key) && typeof value === 'string' && value.length > 0 && value.length <= 512)
}
export function restoredAgent(row: SavedWindow | undefined, nodes: Map<string, { generation?: number }>): string | null {
  const target = row?.restore
  if (!target?.agent || !Number.isSafeInteger(target.generation)) return null
  return nodes.get(target.agent)?.generation === target.generation ? target.agent : null
}
const valid = (v: unknown): v is SavedWindow => {
  if (!v || typeof v !== 'object') return false
  const r = v as SavedWindow
  return typeof r.key === 'string' && r.key.length < 1024 && typeof r.kind === 'string'
    && (r.org === null || typeof r.org === 'string') && typeof r.open === 'boolean'
    && (r.restore === undefined || validRestore(r.restore))
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
export function captureWindow(key: string, kind: string, org: string | null, w: Window, open = true, restore?: WindowRestore) {
  if (!desktop()) return
  try {
    saveWindow({ key, kind, org, open, ...(restore ? { restore } : {}), rect: {
      x: w.screenX, y: w.screenY, width: w.outerWidth || 900, height: w.outerHeight || 760,
    } })
  } catch { /* a closing native window can lose its document first */ }
}
export function closeSavedWindow(key: string) {
  if (exiting) return
  const row = savedWindows().find(r => r.key === key)
  if (row) saveWindow({ ...row, open: false })
}
/** The shape a popped-out window opens at when it has never been opened
 *  before.
 *
 *  900x760 USED TO BE THE ONLY ANSWER - for a tall narrow desk, a wide
 *  docket, a small usage panel, everything. The content then arrived into
 *  proportions it was never laid out for, which is what the user reported on
 *  2026-09-12: the window "feels resized into the wrong proportions".
 *
 *  So the SHAPE comes from the surface being popped out and the SIZE does
 *  not. `source` is that surface's box on screen at the moment of the
 *  pop-out, which is already the app's own answer to "how big is this
 *  surface": a centred modal measures its default laid-out panel, and a
 *  pinned one measures the box the user dragged it to (`measureRect` in
 *  canvas/modalpin.tsx does exactly this when placing a fresh pin). Only its
 *  ASPECT is used - a desk on a canvas card is a 120px square on screen and
 *  a window that size would be useless - and the AREA stays what the single
 *  fixed size always was, so nothing gets bigger or smaller overall.
 *
 *  ⚠ THE ASPECT IS NOT CLAMPED, deliberately. A band of "reasonable" ratios
 *  would be two invented numbers, and the two real constraints are already
 *  here: the window cannot exceed the screen, and it cannot go below the
 *  size `valid()` above will persist. Scaling to fit the screen divides both
 *  sides equally, so fitting never distorts what it was asked to match.
 */
export const POPUP_DEFAULT = { width: 900, height: 760 }
const POPUP_AREA = POPUP_DEFAULT.width * POPUP_DEFAULT.height
/** the floor `valid()` enforces on a saved window: below it the size cannot
 *  even survive a restart, so there is no point opening one */
const POPUP_MIN = { width: 200, height: 150 }

export function popupSize(source?: { w: number; h: number } | null,
  screenBox?: { width: number; height: number } | null): { width: number; height: number } {
  const aspect = source && source.w > 0 && source.h > 0 ? source.w / source.h : NaN
  if (!Number.isFinite(aspect) || aspect <= 0) return { ...POPUP_DEFAULT }
  let width = Math.sqrt(POPUP_AREA * aspect)
  let height = Math.sqrt(POPUP_AREA / aspect)
  const limit = screenBox ?? (typeof screen === 'undefined' ? null
    : { width: screen.availWidth, height: screen.availHeight })
  if (limit && limit.width > 0 && limit.height > 0) {
    const fit = Math.min(1, limit.width / width, limit.height / height)
    width *= fit; height *= fit
  }
  return {
    width: Math.max(POPUP_MIN.width, Math.round(width)),
    height: Math.max(POPUP_MIN.height, Math.round(height)),
  }
}

/** Where a first-time popout opens, in screen coordinates.
 *
 *  THE PIN RULE, APPLIED TO A NATIVE WINDOW. A fresh pin is placed over the
 *  box the surface already occupied - "so the window appears exactly where
 *  the user was already looking" (`measureRect` in canvas/modalpin.tsx) - and
 *  then clamped into the box that has to contain it. Here the surface's box
 *  is in the OWNER WINDOW's client coordinates, the containing box is the
 *  screen, and the two are bridged by the owner window's own origin.
 *
 *  CENTRED ON THE SOURCE, not aligned to its corner: the window is a
 *  different size from the panel (the aspect is kept, the area is not), so
 *  matching top-left corners would drift further the more the shapes differ.
 *  Centres do not drift.
 *
 *  ⚠ THE MULTI-MONITOR GUARD IS THE WHOLE REASON THIS CAN RETURN NULL. A
 *  renderer only ever sees ONE screen through `screen.avail*` - the one the
 *  browser calls primary - so clamping a window that belongs to a main
 *  window on a second monitor would yank it onto the first. When the owner's
 *  own origin is not inside the screen box we are told about, that box is
 *  describing a different monitor and is not ours to clamp against: we
 *  return no position at all and let the platform place the window beside
 *  its parent, exactly as it did before any of this existed.
 */
export function popupPlacement(
  source: { x: number; y: number; w: number; h: number } | null | undefined,
  size: { width: number; height: number },
  owner?: { screenX: number; screenY: number } | null,
  screenBox?: { left: number; top: number; width: number; height: number } | null,
): { left: number; top: number } | null {
  if (!source || !owner) return null
  if (![source.x, source.y, source.w, source.h, owner.screenX, owner.screenY].every(Number.isFinite)) return null
  const centreX = owner.screenX + source.x + source.w / 2
  const centreY = owner.screenY + source.y + source.h / 2
  let left = centreX - size.width / 2
  let top = centreY - size.height / 2
  // `availLeft`/`availTop` are real in Chromium and absent from the DOM lib's
  // `Screen`; on a single-monitor setup they are 0, which is why the fallback
  // is not a guess.
  const avail = typeof screen === 'undefined' ? null
    : screen as Screen & { availLeft?: number; availTop?: number }
  const box = screenBox ?? (avail ? {
    left: avail.availLeft ?? 0, top: avail.availTop ?? 0,
    width: avail.availWidth, height: avail.availHeight,
  } : null)
  if (box && box.width > 0 && box.height > 0) {
    const ownerInside = owner.screenX >= box.left && owner.screenX < box.left + box.width
      && owner.screenY >= box.top && owner.screenY < box.top + box.height
    if (!ownerInside) return null
    left = Math.min(Math.max(left, box.left), box.left + box.width - size.width)
    top = Math.min(Math.max(top, box.top), box.top + box.height - size.height)
  }
  return { left: Math.round(left), top: Math.round(top) }
}

export function popupFeatures(key: string,
  source?: { x: number; y: number; w: number; h: number } | null,
  owner?: { screenX: number; screenY: number } | null) {
  // A window that has been opened before keeps the size and place the user
  // left it at; matching the source surface is only for the FIRST opening.
  const rect = savedWindows().find(r => r.key === key)?.rect
  if (rect) return `popup,left=${Math.round(rect.x)},top=${Math.round(rect.y)},width=${Math.round(rect.width)},height=${Math.round(rect.height)}`
  const size = popupSize(source)
  const at = popupPlacement(source, size, owner)
  return `popup,${at ? `left=${at.left},top=${at.top},` : ''}width=${size.width},height=${size.height}`
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
