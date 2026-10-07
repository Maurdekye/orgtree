import { ringArcCentres } from './ringarcs'

export interface SpringRing {
  angles: number[]
  step: number
  /** Index on the preceding ring; -1 is the eye. Children stay contiguous. */
  parents: number[]
}

/** Relax parent/arc-centre springs together across every depth. Contact
 * projection supplies the repulsion: wider subordinate arcs push farther,
 * and their springs carry that displacement back to their superiors.
 * Angles remain unwrapped in tree order, including across the circle seam.
 * This runs only when layout changes, never in the animation frame loop. */
export function settleRingSprings(rings: SpringRing[]): number[][] {
  const links = rings.map(ring => {
    const groups: { parent: number; first: number; last: number }[] = []
    ring.parents.forEach((parent, i) => {
      const previous = groups[groups.length - 1]
      if (previous?.parent === parent) previous.last = i
      else groups.push({ parent, first: i, last: i })
    })
    return groups
  })
  const sizes = rings.map(r => r.angles.map(() => 1))
  let rest = rings.map(r => [...r.angles]), trial = rest, momentum = 1
  // Accelerated projected gradient on the quadratic spring energy. Each card
  // belongs to at most two springs; 1/4 is a safe step for that graph. The hard
  // cap bounds work even for a long chain or a completely packed ring.
  for (let iteration = 0; iteration < 256; iteration++) {
    const force = rings.map(r => r.angles.map(() => 0))
    for (let depth = 0; depth < rings.length; depth++) {
      for (const { parent, first, last } of links[depth]!) {
        const centre = (trial[depth]![first]! + trial[depth]![last]!) / 2
        const above = depth === 0 ? Math.PI / 2 : trial[depth - 1]![parent]!
        const pull = centre - above
        force[depth]![first]! -= pull / 2
        force[depth]![last]! -= pull / 2
        if (depth > 0) force[depth - 1]![parent]! += pull
      }
    }
    const next = rings.map((ring, depth) => ringArcCentres(
      trial[depth]!.map((angle, i) => angle + force[depth]![i]! / 4), sizes[depth]!, ring.step))
    let moved = 0
    for (let depth = 0; depth < rings.length; depth++)
      for (let i = 0; i < next[depth]!.length; i++)
        moved = Math.max(moved, Math.abs(next[depth]![i]! - rest[depth]![i]!))
    if (moved < 1e-8) { rest = next; break }
    const nextMomentum = (1 + Math.sqrt(1 + 4 * momentum * momentum)) / 2
    const carry = (momentum - 1) / nextMomentum
    trial = next.map((angles, depth) => angles.map((angle, i) => angle + carry * (angle - rest[depth]![i]!)))
    rest = next; momentum = nextMomentum
  }
  // Remove any residual rigid rotation: it costs no alignment or clearance,
  // and keeps the eye's reports centred at the bottom exactly as before.
  const top = rest[0]
  const rotation = top?.length ? Math.PI / 2 - (top[0]! + top[top.length - 1]!) / 2 : 0
  return rest.map(angles => angles.map(angle => angle + rotation))
}
