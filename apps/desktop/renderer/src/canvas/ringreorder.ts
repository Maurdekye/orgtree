import type { Pt } from './shared'

export interface RingReorderSlot {
  request: { before: string } | { after: string }
  point: Pt
}

/** Positions are card top-lefts, including the eye's layout position. Equal
 * card offsets cancel. Layout mirrors x, so this angle increases in the
 * existing counterclockwise sibling direction. Never sort by screen x/y. */
export function ringReorderSlot(ids: string[], target: ReadonlyMap<string, Pt>,
  eye: Pt, drop: Pt): RingReorderSlot | undefined {
  const placed = ids.flatMap(id => {
    const p = target.get(id)
    return p ? [{ id, p, angle: Math.atan2(p.y - eye.y, eye.x - p.x) }] : []
  })
  if (!placed.length) return undefined
  const tau = 2 * Math.PI
  const turn = (a: number) => ((a % tau) + tau) % tau
  // Unwrap in canonical sibling order: a group's arc can cross atan2's seam
  // anywhere, including after collision projection on a descendant ring.
  for (let i = 1; i < placed.length; i++) {
    const previous = placed[i - 1]!.angle
    placed[i]!.angle = previous + turn(placed[i]!.angle - previous)
  }
  const first = placed[0]!, last = placed[placed.length - 1]!
  // Split the open last-to-first gap in half. Each side chooses its nearest
  // list end; the angle's arbitrary -pi/pi seam must not become a list end.
  const cut = (last.angle + first.angle - tau) / 2
  const angle = cut + turn(Math.atan2(drop.y - eye.y, eye.x - drop.x) - cut)
  const at = placed.findIndex(row => row.angle > angle)
  const before = at < 0 ? undefined : placed[at]
  const after = at < 0 ? last : placed[at - 1]
  const anchor = before ?? last
  const gap = before && after ? (before.angle + after.angle) / 2
    : before ? (cut + first.angle) / 2 : (last.angle + cut + tau) / 2
  const radius = Math.hypot(anchor.p.x - eye.x, anchor.p.y - eye.y)
  return {
    request: before ? { before: before.id } : { after: last.id },
    point: { x: eye.x - radius * Math.cos(gap), y: eye.y + radius * Math.sin(gap) },
  }
}
