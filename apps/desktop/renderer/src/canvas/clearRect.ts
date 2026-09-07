/** FR-3 follow-on (w14aace89): the region of the viewport a camera command
 *  should aim at when pinned windows (pins.tsx) are covering part of it.
 *
 *  THE PROBLEM. Pins are screen-space windows floating over the canvas.
 *  `focusView` and `fitView` both centre on the WHOLE viewport, so focusing an
 *  agent while a pin covers the middle of the screen lands the card underneath
 *  the pin: the camera obeys, and the thing you asked to look at is hidden.
 *
 *  THE APPROACH (user ruling 2026-09-05, simplifying an earlier draft).
 *  Pick the SINGLE LARGEST empty rectangle by AREA, and use that one region
 *  for every camera command — agent focus, switchboard focus and full view
 *  alike. The region does NOT depend on what is being focused; the target is
 *  fitted inside it afterwards. That is deliberately simpler than ranking
 *  regions by the zoom each would give the current target: one visible
 *  "free space", the same for every command, is predictable to a user in a
 *  way that a region silently changing shape per target is not.
 *
 *  ⚠ SUPERSEDED DESIGN, recorded so it is not reintroduced: the first cut
 *  ranked candidate regions by the fit zoom they afforded the specific
 *  content, area only breaking ties. That is target-DEPENDENT and was
 *  explicitly withdrawn. Do not restore it without a new ruling.
 *
 *  Only the CAMERA COMMANDS ask for this — manual panning and zooming are
 *  untouched, so the user can always drag anything anywhere, including back
 *  under a pin.
 *
 *  ⚠ THIS FILE IS PURE GEOMETRY ON PURPOSE. No React, no DOM, no pin storage:
 *  it takes plain rectangles and returns one. That is what makes it testable
 *  headlessly against planted fixtures, and it is also the file boundary that
 *  keeps this work out of OrgCanvas.tsx, which another agent is editing.
 */

/** Screen-space rectangle. x/y are the LEFT/TOP in viewport coordinates —
 *  the same convention `PinRect` uses, so a pin drops straight in. */
export interface Rect { x: number; y: number; w: number; h: number }

/** Breathing room between focused content and a pin. Applied by GROWING the
 *  obstacle, so the gap is honoured on whichever sides actually abut a pin. */
export const PIN_GAP = 12

/** What the returned region is, so the caller can tell "I centred you in the
 *  space that was left" from "there was no space and I did not move the
 *  camera". The caller decides what to SAY; this only reports. */
export type RegionStatus =
  /** no pins cover anything: the whole viewport, unchanged behaviour */
  | 'full'
  /** a genuinely smaller region was chosen */
  | 'reduced'
  /** the viewport is entirely covered — caller keeps the camera put */
  | 'blocked'

export interface Region { rect: Rect; status: RegionStatus }

const EMPTY: Rect = { x: 0, y: 0, w: 0, h: 0 }

const right = (r: Rect) => r.x + r.w
const bottom = (r: Rect) => r.y + r.h
const area = (r: Rect) => Math.max(0, r.w) * Math.max(0, r.h)

/** Do two rectangles share any interior? Touching edges do NOT overlap —
 *  that is what lets a candidate sit flush against a pin's gap boundary. */
const overlaps = (a: Rect, b: Rect): boolean =>
  a.x < right(b) && b.x < right(a) && a.y < bottom(b) && b.y < bottom(a)

/** Clip `pin` to `vp`, then grow it by `gap`, but only into the viewport.
 *  Returns null when the pin covers nothing (fully offscreen, or flush).
 *
 *  ⚠ CLIP BEFORE GROWING, NOT AFTER. A pin hanging off the left edge has a
 *  negative x; growing first and clipping second would push its gap in from
 *  the viewport edge and eat 12px of perfectly usable screen for an obstacle
 *  that is not actually on screen. This is also what makes the result
 *  BORDER-INDEPENDENT: a pin half off the top behaves exactly like one
 *  abutting the top, because only the visible part ever becomes an obstacle. */
export function obstacleOf(pin: Rect, vp: Rect, gap = PIN_GAP): Rect | null {
  const x0 = Math.max(pin.x, vp.x)
  const y0 = Math.max(pin.y, vp.y)
  const x1 = Math.min(right(pin), right(vp))
  const y1 = Math.min(bottom(pin), bottom(vp))
  if (x1 <= x0 || y1 <= y0) return null
  const gx0 = Math.max(vp.x, x0 - gap)
  const gy0 = Math.max(vp.y, y0 - gap)
  const gx1 = Math.min(right(vp), x1 + gap)
  const gy1 = Math.min(bottom(vp), y1 + gap)
  return { x: gx0, y: gy0, w: gx1 - gx0, h: gy1 - gy0 }
}

/** Distance from a region's centre to the viewport's centre — the first
 *  tie-break, so equal-area regions prefer the one that moves the picture
 *  least. This is the region's OWN centre; centres are never averaged
 *  across separate holes. */
const centreDrift = (r: Rect, vp: Rect): number => {
  const dx = (r.x + r.w / 2) - (vp.x + vp.w / 2)
  const dy = (r.y + r.h / 2) - (vp.y + vp.h / 2)
  return Math.hypot(dx, dy)
}

/** Candidate edge coordinates: the viewport's own sides, plus every obstacle
 *  side falling strictly inside it. A maximal empty rectangle always has each
 *  side flush against one of these, so this set is sufficient — we are not
 *  sampling or guessing at positions. */
function edges(lo: number, hi: number, cuts: number[]): number[] {
  const out = new Set<number>([lo, hi])
  for (const c of cuts) if (c > lo && c < hi) out.add(c)
  return [...out].sort((a, b) => a - b)
}

/** Strict ordering for two candidates of identical area and identical centre
 *  drift, so the choice is deterministic rather than dependent on iteration
 *  order. Smaller x wins, then smaller y, then wider, then taller. */
function beatsOnCoords(a: Rect, b: Rect): boolean {
  if (a.x !== b.x) return a.x < b.x
  if (a.y !== b.y) return a.y < b.y
  if (a.w !== b.w) return a.w > b.w
  return a.h > b.h
}

/**
 * The single largest empty rectangle of `vp` not covered by any pin.
 *
 * Ranking is AREA ONLY, target-independent (user ruling). Ties break on
 * nearest viewport centre, then on a deterministic coordinate order.
 *
 * Occupancy is the UNION of the clipped, gap-grown pins: overlapping pins
 * make one combined obstacle rather than being counted twice. Where that
 * union leaves several separate holes, each is evaluated on its own merits —
 * areas of distinct holes are never added together, and their centres are
 * never averaged. The winner is one real rectangle you could draw on screen.
 */
export function clearRegion(
  vp: Rect,
  pins: readonly Rect[],
  opts: { gap?: number } = {},
): Region {
  const gap = opts.gap ?? PIN_GAP
  if (vp.w <= 0 || vp.h <= 0) return { rect: EMPTY, status: 'blocked' }

  const obstacles: Rect[] = []
  for (const p of pins) {
    const o = obstacleOf(p, vp, gap)
    if (o) obstacles.push(o)
  }

  // NO PINS IS THE IDENTITY CASE, checked before the search so the unpinned
  // camera is provably the old behaviour rather than the search happening to
  // rediscover the viewport.
  if (obstacles.length === 0) return { rect: vp, status: 'full' }

  const xs = edges(vp.x, right(vp), obstacles.flatMap((o) => [o.x, right(o)]))
  const ys = edges(vp.y, bottom(vp), obstacles.flatMap((o) => [o.y, bottom(o)]))

  let best: Rect | null = null
  for (let i = 0; i < xs.length - 1; i++) {
    const x0 = xs[i]! // nUIA: i < xs.length - 1
    for (let j = i + 1; j < xs.length; j++) {
      const x1 = xs[j]! // nUIA: j < xs.length
      for (let k = 0; k < ys.length - 1; k++) {
        const y0 = ys[k]! // nUIA: k < ys.length - 1
        for (let l = k + 1; l < ys.length; l++) {
          const y1 = ys[l]! // nUIA: l < ys.length
          const r: Rect = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
          let hit = false
          for (const o of obstacles) {
            if (overlaps(r, o)) { hit = true; break }
          }
          if (hit) continue
          if (best === null) { best = r; continue }
          const da = area(r) - area(best)
          if (da > 1e-9) { best = r; continue }
          if (da < -1e-9) continue
          const dc = centreDrift(r, vp) - centreDrift(best, vp)
          if (dc < -1e-9) { best = r; continue }
          if (dc > 1e-9) continue
          if (beatsOnCoords(r, best)) best = r
        }
      }
    }
  }

  if (!best) return { rect: EMPTY, status: 'blocked' }
  const full = best.w >= vp.w && best.h >= vp.h
  return { rect: best, status: full ? 'full' : 'reduced' }
}

/** The zoom at which content of `w`x`h` world units fits `r`, leaving
 *  `margin` screen px. Never negative: a region smaller than the margin
 *  yields 0, not a nonsense negative that would read as "fits". */
export function fitZoom(r: Rect, w: number, h: number, margin: number): number {
  if (w <= 0 || h <= 0) return 0
  const availW = r.w - margin
  const availH = r.h - margin
  if (availW <= 0 || availH <= 0) return 0
  return Math.min(availW / w, availH / h)
}
