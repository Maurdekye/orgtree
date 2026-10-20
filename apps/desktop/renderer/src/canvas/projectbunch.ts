import type { CanvasNode, Pt } from './shared'

export type ProjectBunch = {
  members: CanvasNode[]
  offsets: Pt[]
  width: number
  height: number
}

/** A compressed spring: advancing x, alternating upper/lower arcs. Same-side
 * cards have a 28px gap; adjacent opposite-side cards clear in y.
 * Keep whole hit boxes, names and badges rather than hiding overlapping cards. */
export function bunchShape(count: number, card = 124): Pick<ProjectBunch, 'offsets' | 'width' | 'height'> {
  const step = (card + 28) / 2, radius = (count - 1) * step / 2
  const offsets = Array.from({ length: count }, (_, i) => {
    const t = (2 * i - count + 1) / count
    const y = Math.max((card + 20) / 2, radius * Math.sqrt(1 - t * t))
    return { x: i * step, y: (i % 2 ? 1 : -1) * y }
  })
  const top = Math.min(...offsets.map(p => p.y))
  const bottom = Math.max(...offsets.map(p => p.y))
  return { offsets: offsets.map(p => ({ x: p.x, y: p.y - top })),
    width: (count - 1) * step + card, height: bottom - top + card }
}

/** Only physical, unbroken project runs qualify. The unpruned source map
 * prevents hide-retired/piles from turning a real split into a false chain. */
export function projectBunches(root: CanvasNode, hidden: ReadonlyMap<string, string> = new Map(),
  source?: ReadonlyMap<string, CanvasNode>): Map<string, ProjectBunch> {
  const out = new Map<string, ProjectBunch>()
  const eligible = (n: CanvasNode) => n.kind === 'project' && n.state === 'live' && !hidden.has(n.id)
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
