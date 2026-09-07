import type { PinRect } from './pins'

export type SnapEdge = 'left' | 'right' | 'top' | 'bottom'
/** Alignment history, not a live constraint between windows. */
export interface PinSnap {
  target: string | null // null means the viewport; an agent may itself be named "viewport"
  edge: SnapEdge
  align?: 'start' | 'end'
}
export interface SnapCandidate { rect: PinRect; snap: PinSnap; label: string }
export interface SnapWindow { id: string; rect: PinRect }
export interface PinViewport { w: number; h: number }
export const PIN_SNAP_DISTANCE = 20
const CORNER_DISTANCE = 12
const EPS = 0.01
const edges: SnapEdge[] = ['left', 'right', 'top', 'bottom']
export const isPinSnap = (value: unknown): value is PinSnap => {
  if (!value || typeof value !== 'object') return false
  const s = value as PinSnap
  return (s.target === null || typeof s.target === 'string') && edges.includes(s.edge)
    && (s.align === undefined || s.align === 'start' || s.align === 'end')
}
export const rectsOverlap = (a: PinRect, b: PinRect): boolean =>
  a.x < b.x + b.w - EPS && a.x + a.w > b.x + EPS
  && a.y < b.y + b.h - EPS && a.y + a.h > b.y + EPS
const inside = (r: PinRect, vp: PinViewport): boolean =>
  r.x >= 0 && r.y >= 0 && r.x + r.w <= vp.w + EPS && r.y + r.h <= vp.h + EPS

/** Drag magnetism only: no resizing, neighbour motion, or camera coordinates.
 * Inputs are the CURRENT displayed rectangles, already clamped to viewport.
 * A rejected candidate is never clamped into a different, misleading snap. */
export function findPinSnap(id: string, r: PinRect, windows: SnapWindow[],
  vp: PinViewport | null): SnapCandidate | null {
  if (!vp || vp.w <= 0 || vp.h <= 0) return null
  const others = windows.filter((w) => w.id !== id)
  const candidates: (SnapCandidate & { distance: number; order: string })[] = []
  const offer = (target: string | null, t: PinRect, edge: SnapEdge) => {
    const vertical = edge === 'left' || edge === 'right'
    const p = vertical ? 'y' : 'x', size = vertical ? 'h' : 'w'
    const next = { ...r }
    if (edge === 'left') next.x = target === null ? 0 : t.x - r.w
    if (edge === 'right') next.x = target === null ? vp.w - r.w : t.x + t.w
    if (edge === 'top') next.y = target === null ? 0 : t.y - r.h
    if (edge === 'bottom') next.y = target === null ? vp.h - r.h : t.y + t.h
    const distance = Math.abs(vertical ? next.x - r.x : next.y - r.y)
    if (distance > PIN_SNAP_DISTANCE) return
    // Align nearby corners too, so equal desks form a clean row or column.
    const starts = Math.abs(r[p] - t[p]), ends = Math.abs(r[p] + r[size] - t[p] - t[size])
    const align = Math.min(starts, ends) <= CORNER_DISTANCE ? (starts <= ends ? 'start' : 'end') : undefined
    if (align) next[p] = align === 'start' ? t[p] : t[p] + t[size] - r[size]
    if (target !== null && Math.min(next[p] + r[size], t[p] + t[size]) - Math.max(next[p], t[p]) < 16) return
    if (!inside(next, vp) || others.some((w) => rectsOverlap(next, w.rect))) return
    candidates.push({ rect: next, snap: { target, edge, ...(align ? { align } : {}) },
      label: target === null ? `Snap to screen ${edge}` : `Snap ${edge} of ${target}`,
      distance: Math.hypot(next.x - r.x, next.y - r.y),
      order: `${target === null ? '1' : '0' + target}:${edges.indexOf(edge)}` })
  }
  for (const w of others) for (const edge of edges) offer(w.id, w.rect, edge)
  for (const edge of edges) offer(null, { x: 0, y: 0, w: vp.w, h: vp.h }, edge)
  // Stable under reordering, raising and identical distances. Never depend on locale.
  candidates.sort((a, b) => a.distance - b.distance || (a.order < b.order ? -1 : a.order > b.order ? 1 : 0))
  return candidates[0] ?? null
}

/** A stored snap describes a past alignment. Discard it if its target or
 * geometry changed; never pull a saved/free window back toward an old target. */
export function validPinSnap(id: string, r: PinRect, value: unknown,
  windows: SnapWindow[], vp: PinViewport | null): PinSnap | null {
  if (!isPinSnap(value) || value.target === id) return null
  const s = value
  const target = s.target === null ? (vp ? { x: 0, y: 0, w: vp.w, h: vp.h } : null)
    : windows.find((w) => w.id === s.target)?.rect
  if (!target) return s.target === null && !vp ? { ...s } : null
  const t = target
  const expected = s.edge === 'left' ? (s.target === null ? 0 : t.x - r.w)
    : s.edge === 'right' ? (s.target === null ? t.w - r.w : t.x + t.w)
      : s.edge === 'top' ? (s.target === null ? 0 : t.y - r.h)
        : (s.target === null ? t.h - r.h : t.y + t.h)
  const vertical = s.edge === 'left' || s.edge === 'right'
  if (Math.abs((vertical ? r.x : r.y) - expected) > EPS) return null
  const p = vertical ? 'y' : 'x', size = vertical ? 'h' : 'w'
  if (s.align && Math.abs(r[p] - (s.align === 'start' ? t[p] : t[p] + t[size] - r[size])) > EPS) return null
  return { ...s }
}
