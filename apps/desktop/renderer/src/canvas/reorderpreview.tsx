import { NODE_H, NODE_W } from './shared'
import type { Pt } from './shared'
import type { RingReorderSlot } from './ringreorder'

/** Mirrors the existing tree drop's x-based request, without changing it.
 * The marker is the midpoint of the gap, or just outside an end card. */
export function rowReorderSlot(ids: string[], target: ReadonlyMap<string, Pt>, drop: Pt): RingReorderSlot | undefined {
  if (!ids.length) return undefined
  const at = ids.findIndex(id => (target.get(id)?.x ?? 0) > drop.x)
  const before = at < 0 ? undefined : ids[at]
  const after = at < 0 ? ids[ids.length - 1] : ids[at - 1]
  const left = after ? target.get(after) : undefined
  const right = before ? target.get(before) : undefined
  if (!left && !right) return undefined
  const centreX = left && right ? (left.x + NODE_W + right.x) / 2
    : right ? right.x - 16 : left!.x + NODE_W + 16
  return { request: before ? { before } : { after: after! }, point: {
    x: centreX - NODE_W / 2,
    y: left && right ? (left.y + right.y) / 2 : (right ?? left)!.y,
  } }
}

/** Card-centred vertical separator, radial when the ring's eye is supplied.
 * Coordinates remain in world space; only stroke width counters canvas zoom. */
export function ReorderMarker({ slot, eye, zoom }: { slot: RingReorderSlot; eye?: Pt; zoom: number }) {
  const x = slot.point.x + NODE_W / 2, y = slot.point.y + NODE_H / 2
  const dx = eye ? slot.point.x - eye.x : 0, dy = eye ? slot.point.y - eye.y : 1
  const length = Math.hypot(dx, dy) || 1
  const half = NODE_H / 2
  return <line
    data-reorder-before={'before' in slot.request ? slot.request.before : undefined}
    data-reorder-after={'after' in slot.request ? slot.request.after : undefined}
    x1={x - dx / length * half} y1={y - dy / length * half}
    x2={x + dx / length * half} y2={y + dy / length * half}
    stroke="var(--accent)" strokeWidth={2 / zoom} strokeLinecap="round" pointerEvents="none" />
}
