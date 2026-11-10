import { useSyncExternalStore } from 'react'
import type { PinRect } from './pins'

/**
 * THE CANVAS CONTROLS' GUTTER (4.5.11 UI audit problems 5+6, coordinator
 * 2026-11-10: "No canvas overlay control may cover any part of a pinned
 * panel"; user m1a4a3c0b76a7).
 *
 * The zoom stack and the Agents toggle sit in the canvas's bottom-left corner
 * ABOVE every pinned surface (`.zoomhud, .tray-wrap { z-index: 17 }`, so
 * navigation stays reachable). `canvasanchor.tsx` already moves them into the
 * rectangle pins leave free — but at 1280x720 a pinned inbox or docket fills
 * the canvas, no free rectangle fits the controls, and they fell back to the
 * corner, ON TOP of the pin's own footer ("Mark all read", the docket's
 * archive note).
 *
 * There is nowhere left to reflow the controls to, so in exactly that case
 * the pins give way, by the smallest amount that keeps the user-specified
 * vertical stack intact:
 *   1. the Agents toggle joins the top of the zoom column (icon-only, same
 *      icon and tooltip), so every control lives in one 48px-wide column;
 *   2. any pinned surface reaching into that column is drawn starting at its
 *      right edge — translated when there is room, otherwise narrowed.
 * The gutter is render-time only: stored pin geometry is never rewritten, so
 * a larger window or an unblocked corner draws every pin exactly as saved.
 *
 * Every number is the stylesheet's (`.zoomhud`, `.tray-wrap`), written as the
 * sum it is so it stays checkable against styles.css.
 */

/** `.zoomhud`'s 10px left offset + its 30px buttons + an 8px gap: the same
 *  48px `.tray-wrap` already uses as its left offset beside the stack. */
export const CONTROL_GUTTER_W = 10 + 30 + 8
/** the column with the Agents toggle on top: 10px bottom offset, five 28px
 *  buttons and four 4px gaps, plus the 8px gap above it */
export const CONTROL_GUTTER_H = 10 + 5 * 28 + 4 * 4 + 8
/** the controls' ordinary corner footprint: the stack's column and, beside
 *  it at the bottom, the Agents toggle (`.tray-wrap` left 48px + the toggle's
 *  own width, generously). A pin anywhere in this box collides with them. */
export const CONTROL_FOOTPRINT_W = 48 + 112

type Box = { x: number; y: number; w: number; h: number }
const hits = (a: Box, b: Box) =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y

/** The box, in viewport px, that pins collide with when the controls sit in
 *  the corner. Tall enough for the guttered column, so drawing a pin out of
 *  the gutter never takes it out of this box (no flip-flop between modes). */
export const controlFootprint = (vp: { w: number; h: number }): Box => ({
  x: 0, y: vp.h - CONTROL_GUTTER_H, w: Math.min(CONTROL_FOOTPRINT_W, vp.w), h: CONTROL_GUTTER_H,
})

/** The gutter pins must stay out of, or null when the controls are not
 *  blocked: `anchored` (the controls already moved into a free rectangle),
 *  no measured viewport, or no surface in the corner. */
export const controlGutter = (
  vp: { w: number; h: number }, surfaces: readonly Box[], anchored: boolean,
): Box | null => {
  if (anchored || !(vp.w > 0 && vp.h > 0)) return null
  const foot = controlFootprint(vp)
  if (!surfaces.some(r => r.w > 0 && r.h > 0 && hits(r, foot))) return null
  return { x: 0, y: vp.h - CONTROL_GUTTER_H, w: CONTROL_GUTTER_W, h: CONTROL_GUTTER_H }
}

/** Draw `r` clear of the gutter: translate it right when it still fits the
 *  viewport, otherwise keep its right edge and narrow it. Unchanged when it
 *  does not reach into the gutter. */
export const avoidControlGutter = (r: PinRect, gutter: Box | null, vp: { w: number; h: number } | null): PinRect => {
  if (!gutter || !hits(r, gutter)) return r
  const x = gutter.x + gutter.w
  if (vp && vp.w > 0 && x + r.w <= vp.w) return { ...r, x }
  return { ...r, x, w: Math.max(0, r.x + r.w - x) }
}

// one gutter per org, published by OrgCanvas and read by every pinned
// surface of that org (desk windows and pinned modals share viewport px)
let gutters: Record<string, Box | null> = {}
const subs = new Set<() => void>()
const same = (a: Box | null | undefined, b: Box | null) =>
  (a ?? null) === b || (!!a && !!b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h)
export const setControlGutter = (org: string, gutter: Box | null): void => {
  if (same(gutters[org], gutter)) return
  gutters = { ...gutters, [org]: gutter }
  for (const fn of [...subs]) fn()
}
const subscribe = (fn: () => void) => { subs.add(fn); return () => { subs.delete(fn) } }
export const readControlGutter = (org: string | null | undefined): Box | null => (org ? gutters[org] ?? null : null)
export const useControlGutter = (org: string | null | undefined): Box | null =>
  useSyncExternalStore(subscribe, () => readControlGutter(org), () => null)
