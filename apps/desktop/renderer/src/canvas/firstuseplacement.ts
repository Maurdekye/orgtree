export type GuideRect = { left: number; top: number; width: number; height: number }
type Side = 'left' | 'right' | 'above' | 'below'
export type GuidePlacement = GuideRect & { side: Side; path: string }

/** Keep the note outside the whole control group, rather than just its target. */
export function firstUsePlacement(target: GuideRect, group: GuideRect, viewport: GuideRect,
  height: number, preferred: 'left' | 'right', obstacles: GuideRect[] = []): GuidePlacement | null {
  const gap = 20, pad = 12
  const x0 = viewport.left + pad, y0 = viewport.top + pad
  const x1 = viewport.left + viewport.width - pad, y1 = viewport.top + viewport.height - pad
  const width = Math.min(280, x1 - x0)
  if (width <= 0 || height > y1 - y0) return null
  const clamp = (n: number, low: number, high: number) => Math.max(low, Math.min(high, n))
  const clear = (left: number, top: number, width: number) => obstacles.every(r =>
    left + width + 6 <= r.left || left >= r.left + r.width + 6 || top + height + 6 <= r.top || top >= r.top + r.height + 6)
  const sideSpace = preferred === 'left' ? group.left - gap - x0 : x1 - group.left - group.width - gap
  let side: Side = preferred, w = width, left = 0, top = 0, placed = false
  if (sideSpace >= Math.min(220, width)) {
    w = Math.min(width, sideSpace)
    left = preferred === 'left' ? group.left - gap - w : group.left + group.width + gap
    top = clamp(target.top + target.height / 2 - height / 2, y0, y1 - height)
    const wanted = top
    const positions = [top, ...obstacles.flatMap(r => [r.top - height - gap, r.top + r.height + gap])]
      .filter(y => y >= y0 && y + height <= y1).sort((a, b) => Math.abs(a - wanted) - Math.abs(b - wanted))
    const free = positions.find(y => clear(left, y, w))
    if (free !== undefined) { top = free; placed = true }
  }
  if (!placed) {
    w = width
    left = clamp(group.left + group.width / 2 - width / 2, x0, x1 - width)
    // Narrow windows keep the entire group clear; never clamp a side note over it.
    if (group.top + group.height + gap + height <= y1 && clear(left, group.top + group.height + gap, width)) {
      side = 'below'; top = group.top + group.height + gap
    } else if (group.top - gap - height >= y0 && clear(left, group.top - gap - height, width)) {
      side = 'above'; top = group.top - gap - height
    } else return null
  }
  const cy = target.top + target.height / 2
  const start = side === 'left' ? [left + w, clamp(cy, top + 10, top + height - 10)]
    : side === 'right' ? [left, clamp(cy, top + 10, top + height - 10)]
      : [left + w / 2, side === 'above' ? top + height : top]
  const routeLeft = group.left - 10 >= x0
  const end = side === 'left' || (side !== 'right' && routeLeft) ? [target.left - 4, cy] : [target.left + target.width + 4, cy]
  const route = side === 'above' || side === 'below'
    ? ` L ${clamp(routeLeft ? group.left - 10 : group.left + group.width + 10, x0, x1)} ${start[1]} L ${clamp(routeLeft ? group.left - 10 : group.left + group.width + 10, x0, x1)} ${cy}` : ''
  return { left, top, width: w, height, side, path: `M ${start.join(' ')}${route} L ${end.join(' ')}` }
}
