export type GuideRect = { left: number; top: number; width: number; height: number }
type Side = 'left' | 'right' | 'above' | 'below'
export type GuidePlacement = GuideRect & { side: Side; path: string }

/** Keep the note outside the whole control group, rather than just its target. */
export function firstUsePlacement(target: GuideRect, group: GuideRect, viewport: GuideRect,
  height: number, preferred: 'left' | 'right'): GuidePlacement | null {
  const gap = 20, pad = 12
  const x0 = viewport.left + pad, y0 = viewport.top + pad
  const x1 = viewport.left + viewport.width - pad, y1 = viewport.top + viewport.height - pad
  const width = Math.min(280, x1 - x0)
  if (width <= 0 || height > y1 - y0) return null
  const clamp = (n: number, low: number, high: number) => Math.max(low, Math.min(high, n))
  const sideSpace = preferred === 'left' ? group.left - gap - x0 : x1 - group.left - group.width - gap
  let side: Side = preferred, w = width, left: number, top: number
  if (sideSpace >= Math.min(220, width)) {
    w = Math.min(width, sideSpace)
    left = preferred === 'left' ? group.left - gap - w : group.left + group.width + gap
    top = clamp(target.top + target.height / 2 - height / 2, y0, y1 - height)
  } else {
    left = clamp(group.left + group.width / 2 - width / 2, x0, x1 - width)
    // Narrow windows keep the entire group clear; never clamp a side note over it.
    if (group.top + group.height + gap + height <= y1) {
      side = 'below'; top = group.top + group.height + gap
    } else if (group.top - gap - height >= y0) {
      side = 'above'; top = group.top - gap - height
    } else return null
  }
  const cy = target.top + target.height / 2
  const start = side === 'left' ? [left + w, clamp(cy, top + 10, top + height - 10)]
    : side === 'right' ? [left, clamp(cy, top + 10, top + height - 10)]
      : [left + w / 2, side === 'above' ? top + height : top]
  const end = side === 'left' ? [target.left - 4, cy]
    : side === 'right' ? [target.left + target.width + 4, cy]
      : [group.left + group.width / 2, side === 'above' ? group.top - 4 : group.top + group.height + 4]
  return { left, top, width: w, height, side, path: `M ${start.join(' ')} L ${end.join(' ')}` }
}
