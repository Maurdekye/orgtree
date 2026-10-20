import type { CanvasNode, Pt, Seg } from './shared'
import type { RingReorderSlot } from './ringreorder'

export type ProjectBunch = {
  members: CanvasNode[]
  offsets: Pt[]
  width: number
  height: number
}

/** Pack rows of a circle, then traverse alternate rows in opposite directions.
 * Chord weights decide each row's population; largest remainders keep the exact
 * count. A small brick stagger avoids aligned columns while all touching rows
 * and neighbours keep the same 8px clearance. This is deterministic O(n). */
export function bunchShape(count: number, card = 124): Pick<ProjectBunch, 'offsets' | 'width' | 'height'> {
  const rows = Math.ceil(Math.sqrt(count)), pitch = card + 8
  const weights = Array.from({ length: rows }, (_, r) => Math.sqrt(1 - ((2 * r + 1 - rows) / rows) ** 2))
  const total = weights.reduce((a, b) => a + b, 0)
  const ideal = weights.map(w => count * w / total), lengths = ideal.map(x => Math.max(1, Math.floor(x)))
  const priority = ideal.map((x, r) => ({ r, fraction: x - Math.floor(x) }))
    .sort((a, b) => b.fraction - a.fraction || a.r - b.r)
  const remaining = count - lengths.reduce((a, b) => a + b, 0)
  for (let i = 0; i < remaining; i++) lengths[priority[i]!.r]!++
  const offsets: Pt[] = []
  let previousStart = Infinity
  for (let r = 0; r < rows; r++) {
    const length = lengths[r]!
    let start = -(length - 1) * pitch / 2
    // Different odd/even row widths already supply a half-card stagger.
    // Otherwise stagger toward the previous row's exit, keeping turns local.
    const delta = (start - previousStart) / pitch
    if (r && Math.abs(delta - Math.round(delta)) < .1) {
      const entry = start + (r % 2 ? (length - 1) * pitch : 0)
      const toward = Math.sign(offsets[offsets.length - 1]!.x - entry) || (r % 2 ? 1 : -1)
      start += toward * pitch / 3
    }
    previousStart = start
    for (let i = 0; i < length; i++) offsets.push({
      x: start + (r % 2 ? length - 1 - i : i) * pitch, y: r * pitch,
    })
  }
  const left = Math.min(...offsets.map(p => p.x)), right = Math.max(...offsets.map(p => p.x))
  return { offsets: offsets.map(p => ({ x: p.x - left, y: p.y })),
    width: right - left + card, height: (rows - 1) * pitch + card }
}

/** Closest points on two card rectangles. Links stay in the small local gap,
 * including row turns; centre-to-centre trimming would draw across the blob. */
function nearestEdges(a: Pt, b: Pt, card: number): [Pt, Pt] {
  const axis = (x: number, y: number): [number, number] => {
    if (x + card <= y) return [x + card, y]
    if (y + card <= x) return [x, y + card]
    const midpoint = (Math.max(x, y) + Math.min(x + card, y + card)) / 2
    return [midpoint, midpoint]
  }
  const [ax, bx] = axis(a.x, b.x), [ay, by] = axis(a.y, b.y)
  return [{ x: ax, y: ay }, { x: bx, y: by }]
}

export function projectBunchLink(a: Pt, b: Pt, card = 124): Seg {
  const [start, end] = nearestEdges(a, b, card)
  const dx = end.x - start.x, dy = end.y - start.y, length = Math.hypot(dx, dy) || 1
  const bend = Math.min(4, length / 3), px = -dy / length * bend, py = dx / length * bend
  return { kind: 'c', pts: [start,
    { x: start.x + dx / 3 + px, y: start.y + dy / 3 + py },
    { x: end.x - dx / 3 - px, y: end.y - dy / 3 - py }, end] }
}

/** Pick the nearest insertion gap along the actual snake, never by screen x.
 * Card positions and returned marker points are top-left coordinates. */
export function projectBunchInsertion(ids: string[], positions: ReadonlyMap<string, Pt>,
  drop: Pt, card = 124): RingReorderSlot | undefined {
  const placed = ids.flatMap(id => { const p = positions.get(id); return p ? [{ id, p }] : [] })
  if (!placed.length) return undefined
  const candidates: RingReorderSlot[] = []
  for (let i = 1; i < placed.length; i++) {
    const previous = placed[i - 1]!, current = placed[i]!
    const [a, b] = nearestEdges(previous.p, current.p, card)
    candidates.push({ request: { before: current.id },
      point: { x: (a.x + b.x) / 2 - card / 2, y: (a.y + b.y) / 2 - card / 2 } })
  }
  const first = placed[0]!, last = placed[placed.length - 1]!
  const end = (row: typeof first, neighbour: typeof first | undefined, before: boolean) => {
    const dx = neighbour ? row.p.x - neighbour.p.x : (before ? -1 : 1)
    const dy = neighbour ? row.p.y - neighbour.p.y : 0
    const scale = (card / 2 + 8) / (Math.max(Math.abs(dx), Math.abs(dy)) || 1)
    candidates.push({ request: before ? { before: row.id } : { after: row.id },
      point: { x: row.p.x + dx * scale, y: row.p.y + dy * scale } })
  }
  end(first, placed[1], true); end(last, placed[placed.length - 2], false)
  return candidates.reduce((best, candidate) =>
    Math.hypot(candidate.point.x - drop.x, candidate.point.y - drop.y)
      < Math.hypot(best.point.x - drop.x, best.point.y - drop.y) ? candidate : best)
}

/** Only physical, unbroken project runs qualify, including archived projects
 * in the loaded retired pile front. Retirement/restoration changes no links.
 * The unpruned source map prevents hide-retired/piles from turning a real
 * split into a false chain; unloaded history is never fetched for bunching. */
export function projectBunches(root: CanvasNode, hidden: ReadonlyMap<string, string> = new Map(),
  source?: ReadonlyMap<string, CanvasNode>): Map<string, ProjectBunch> {
  const out = new Map<string, ProjectBunch>()
  const eligible = (n: CanvasNode) => n.kind === 'project'
    && (n.state === 'live' || n.state === 'archived') && !hidden.has(n.id)
  const walk = (start: CanvasNode) => {
    if (hidden.has(start.id)) return
    const members = [start]
    let last = start
    while (eligible(last)) {
      const physical = source?.get(last.id) ?? last
      if (physical.children.length !== 1 || physical.hidden_retired_children) break
      const next = last.children[0]
      if (last.children.length !== 1 || !next || !eligible(next)) break
      members.push(next)
      last = next
    }
    if (members.length > 1) {
      const bunch = { members, ...bunchShape(members.length) }
      for (const n of members) out.set(n.id, bunch)
    }
    for (const c of last.children) walk(c)
  }
  walk(root)
  return out
}

/** Layout-only contraction. IDs, parent links and live tree data stay intact
 * elsewhere; the head is a temporary layout block containing every card. */
export function contractBunches(root: CanvasNode, bunches: ReadonlyMap<string, ProjectBunch>): CanvasNode {
  const group = bunches.get(root.id)
  const tail = group ? group.members[group.members.length - 1]! : root
  return { ...root, children: tail.children.map(c => contractBunches(c, bunches)) }
}

export function expandBunches(positions: Map<string, Pt>, bunches: ReadonlyMap<string, ProjectBunch>, card = 124) {
  for (const [id, group] of bunches) {
    if (id !== group.members[0]!.id) continue
    const p = positions.get(id)
    if (!p) continue
    const x = p.x + card / 2 - group.width / 2, y = p.y + card / 2 - group.height / 2
    group.members.forEach((n, i) => positions.set(n.id,
      { x: x + group.offsets[i]!.x, y: y + group.offsets[i]!.y }))
  }
  return positions
}

/** Variable-size blocks reserve their whole silhouette, including all branches
 * below them. Ordinary siblings still have the old 186px horizontal pitch. */
export function layoutBunchRows(root: CanvasNode, hidden: ReadonlyMap<string, string>,
  bunches: ReadonlyMap<string, ProjectBunch>): Map<string, Pt> {
  const widths = new Map<string, number>(), out = new Map<string, Pt>()
  const children = (n: CanvasNode) => n.children.filter(c => !hidden.has(c.id))
  const measure = (n: CanvasNode): number => {
    const kids = children(n)
    const width = Math.max(bunches.get(n.id)?.width ?? 124,
      kids.reduce((sum, c) => sum + measure(c), 0) + Math.max(0, kids.length - 1) * 62)
    widths.set(n.id, width)
    return width
  }
  measure(root)
  const place = (n: CanvasNode, left: number, top: number): number => {
    const kids = children(n), group = bunches.get(n.id)
    const height = group?.height ?? 124, width = widths.get(n.id)!
    const childWidth = kids.reduce((sum, c) => sum + widths.get(c.id)!, 0) + Math.max(0, kids.length - 1) * 62
    let x = left + (width - childWidth) / 2
    const centres = kids.map(c => {
      const cx = place(c, x, top + height + 76)
      x += widths.get(c.id)! + 62
      return cx
    })
    const cx = !group && centres.length ? (centres[0]! + centres[centres.length - 1]!) / 2 : left + width / 2
    out.set(n.id, { x: cx - 62, y: top + height / 2 - 62 })
    return cx
  }
  place(root, 0, 90)
  return out
}
