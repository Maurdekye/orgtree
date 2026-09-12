import { useSyncExternalStore } from 'react'
import type { CSSProperties } from 'react'
import { SetToggle } from './settingskit'

/**
 * Anchor the canvas's own controls to the USABLE canvas rather than to the
 * whole canvas.
 *
 * THE COMPLAINT (user 2026-09-12): the zoom cluster and the Agents list sit
 * in the canvas's bottom-left corner, and a pinned modal or an expanded desk
 * over that corner leaves them looking detached from the area actually being
 * worked in.
 *
 * OFF BY DEFAULT, and opt-in on purpose: which corner a control belongs in is
 * a settled question, and this does not reopen it. The toggle changes only
 * the RECTANGLE those corners are measured from - the controls keep the same
 * corner and the same offsets within it.
 *
 * BROWSER-LOCAL, like every other preference in the Desk group: it is about
 * how this screen is arranged, not about the organization, so it never
 * belongs in the org document. Same store shape as `pinoverlap.tsx` next
 * door, deliberately - one reader, one writer, one subscription, and a
 * cross-tab `storage` listener so two windows on one machine agree.
 */
export const CANVAS_ANCHOR_KEY = 'orgtree-canvas-anchor-bounded'
export interface CanvasAnchorSetting { enabled: boolean }
const DEFAULT_ANCHOR: CanvasAnchorSetting = { enabled: false }

let anchorCache: CanvasAnchorSetting | null = null
const anchorSubs = new Set<() => void>()
const readAnchor = (): CanvasAnchorSetting => {
  if (anchorCache) return anchorCache
  try {
    const parsed = JSON.parse(localStorage.getItem(CANVAS_ANCHOR_KEY) || 'null') as Partial<CanvasAnchorSetting> | null
    if (parsed && typeof parsed.enabled === 'boolean') {
      anchorCache = { enabled: parsed.enabled }
      return anchorCache
    }
  } catch { /* private mode or malformed preference */ }
  anchorCache = DEFAULT_ANCHOR
  return anchorCache
}
const writeAnchor = (next: CanvasAnchorSetting): void => {
  anchorCache = next
  try { localStorage.setItem(CANVAS_ANCHOR_KEY, JSON.stringify(next)) } catch { /* private mode */ }
  for (const fn of [...anchorSubs]) fn()
}
const subscribeAnchor = (fn: () => void): (() => void) => {
  anchorSubs.add(fn)
  const onStorage = (e: StorageEvent) => { if (e.key === null || e.key === CANVAS_ANCHOR_KEY) { anchorCache = null; fn() } }
  window.addEventListener('storage', onStorage)
  return () => { anchorSubs.delete(fn); window.removeEventListener('storage', onStorage) }
}
export const useCanvasAnchor = (): CanvasAnchorSetting =>
  useSyncExternalStore(subscribeAnchor, readAnchor, () => DEFAULT_ANCHOR)
export const setCanvasAnchor = (setting: CanvasAnchorSetting): void =>
  writeAnchor({ enabled: !!setting.enabled })
/** test seam, mirroring forgetModalPins next door */
export const forgetCanvasAnchor = (): void => { anchorCache = null }

/**
 * The inset each edge of the usable rectangle sits at, as CSS variables for
 * the stylesheet to add its own offsets to.
 *
 * ⚠ VARIABLES, NOT COMPUTED POSITIONS. The 10px and 48px that place these
 * controls live in styles.css and belong there; duplicating them here would
 * make "the same corner position" a claim maintained in two files that could
 * drift apart. The stylesheet writes `calc(var(--free-left, 0px) + 10px)`, so
 * with the preference OFF - no variables set - it computes `calc(0px + 10px)`
 * and the placement is exactly what it has always been.
 *
 * It extends CSSProperties so React's `style` accepts it: custom properties
 * are not in the DOM typings, and a bare object of them is not assignable.
 */
export interface FreeInsets extends CSSProperties {
  '--free-left': string; '--free-top': string; '--free-bottom': string
}
/**
 * The smallest free rectangle worth anchoring into.
 *
 * ⚠ POSITIVE AREA IS NOT ENOUGH, and assuming it was is the defect
 * perf-review found in the first candidate. A 960px full-height desk in a
 * 1000px viewport leaves 28px once the region's own gap is taken: anchoring
 * there put the Agents toggle at x=1020 and the end of the zoom buttons at
 * x=1012, both outside a viewport that is `overflow: hidden`. A full-width
 * desk at y=80 leaves 68px at the top, which starts the four-button stack at
 * y=-66. The controls were not "placed tightly"; they were CLIPPED.
 *
 * Every number below is read off the stylesheet, and is written as the sum it
 * actually is so it stays checkable against that file:
 *   width  — `.tray-wrap`'s 48px offset plus `.tray`'s own `min-width: 200px`
 *   height — `.zoomhud`'s 10px bottom offset plus its four 28px buttons and
 *            the three 4px gaps between them
 * Below either, the honest answer is to place nothing and let the controls
 * stay where the stylesheet puts them, which is always on screen.
 */
const MIN_FREE_W = 48 + 200
const MIN_FREE_H = 10 + (4 * 28 + 3 * 4)

export const freeInsets = (
  region: { rect: { x: number; y: number; w: number; h: number }; status: string } | null,
  viewport: { w: number; h: number },
): FreeInsets | null => {
  // 'full' means nothing obstructs the canvas - or nothing has been measured
  // yet - and 'blocked' means no usable rectangle was found at all. Neither
  // is something to anchor to, and in both cases leaving the variables unset
  // is the honest answer: the controls stay where the stylesheet puts them.
  if (!region || region.status !== 'reduced') return null
  const { x, y, w, h } = region.rect
  if (!(w > 0 && h > 0) || !(viewport.w > 0 && viewport.h > 0)) return null
  if (![x, y, w, h].every(Number.isFinite)) return null
  // the controls have to FIT, not merely have somewhere positive to go
  if (w < MIN_FREE_W || h < MIN_FREE_H) return null
  return {
    '--free-left': `${Math.max(0, Math.round(x))}px`,
    '--free-top': `${Math.max(0, Math.round(y))}px`,
    '--free-bottom': `${Math.max(0, Math.round(viewport.h - (y + h)))}px`,
  }
}

/** Browser-local control for where the canvas's own controls anchor. */
export function CanvasAnchorSettings() {
  const setting = useCanvasAnchor()
  return <SetToggle label="keep canvas controls inside the area pins leave free"
    checked={setting.enabled}
    onChange={enabled => setCanvasAnchor({ enabled })} />
}
