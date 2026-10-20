import { ringArcCentres } from './ringarcs'

export interface SpringRing {
  angles: number[]
  step: number
  /** Index on the preceding ring; -1 is the eye. Children stay contiguous. */
  parents: number[]
  /** Each card's arc slot in steps (default 1); a project bunch is wider. */
  widths?: number[]
}

// Status/feed updates rebuild CanvasNodes without changing geometry. Keep only
// the last numeric topology (no org/node data), so these reads stay O(nodes).
let cached: { input: SpringRing[]; output: number[][] } | undefined

/** Relax parent/arc-centre springs together across every depth. Contact
 * projection supplies the repulsion: wider subordinate arcs push farther,
 * and their springs carry that displacement back to their superiors.
 * Angles remain unwrapped in tree order, including across the circle seam.
 * This runs only when layout changes, never in the animation frame loop. */
export function settleRingSprings(rings: SpringRing[]): number[][] {
  if (cached && rings.length === cached.input.length && rings.every((ring, d) => {
    const previous = cached!.input[d]!
    return ring.step === previous.step && ring.angles.length === previous.angles.length
      && ring.angles.every((angle, i) => angle === previous.angles[i] && ring.parents[i] === previous.parents[i]
        && (ring.widths?.[i] ?? 1) === (previous.widths?.[i] ?? 1))
  })) return cached.output.map(angles => [...angles])
  // A card nobody on the next ring reports to is a leaf. Each end of a team
  // pulls the run of leaf siblings at that end as one block: a leaf has no
  // arc of its own to hold it apart, so it must never slide away from its
  // leaf neighbours (user 2026-10-20 10:46Z). A team of leaves moves rigidly.
  const links = rings.map((ring, depth) => {
    const leaf = ring.angles.map(() => true)
    for (const parent of rings[depth + 1]?.parents ?? []) leaf[parent] = false
    const groups: { parent: number; first: number; last: number; ends: [number, number][] }[] = []
    ring.parents.forEach((parent, i) => {
      const previous = groups[groups.length - 1]
      if (previous?.parent === parent) previous.last = i
      else groups.push({ parent, first: i, last: i, ends: [] })
    })
    for (const group of groups) {
      let head = group.first, tail = group.last
      if (leaf[head]) while (head < group.last && leaf[head + 1]) head++
      if (leaf[tail]) while (tail > group.first && leaf[tail - 1]) tail--
      group.ends = [[group.first, head], [tail, group.last]]
    }
    return groups
  })
  const sizes = rings.map(r => r.widths ?? r.angles.map(() => 1))
  // The middle of a group's whole arc, so a wide first or last slot (a bunch)
  // stays centred with its siblings; equal end slots add exactly zero.
  const middle = (depth: number, angles: number[], first: number, last: number) =>
    (angles[first]! + angles[last]!) / 2 + (sizes[depth]![last]! - sizes[depth]![first]!) * rings[depth]!.step / 4
  let rest = rings.map(r => [...r.angles]), trial = rest, momentum = 1
  // Accelerated projected gradient on the quadratic spring energy. Each card
  // belongs to at most two springs; 1/4 is a safe step for that graph. The hard
  // cap bounds work even for a long chain or a completely packed ring.
  for (let iteration = 0; iteration < 256; iteration++) {
    const force = rings.map(r => r.angles.map(() => 0))
    for (let depth = 0; depth < rings.length; depth++) {
      for (const { parent, first, last, ends } of links[depth]!) {
        const centre = middle(depth, trial[depth]!, first, last)
        const above = depth === 0 ? Math.PI / 2 : trial[depth - 1]![parent]!
        const pull = centre - above
        for (const [from, to] of ends)
          for (let i = from; i <= to; i++) force[depth]![i]! -= pull / 2 / (to - from + 1)
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
  const rotation = top?.length ? Math.PI / 2 - middle(0, top, 0, top.length - 1) : 0
  const output = rest.map(angles => angles.map(angle => angle + rotation))
  cached = { input: rings.map(r => ({ step: r.step, angles: [...r.angles], parents: [...r.parents],
    widths: r.widths && [...r.widths] })), output }
  return output.map(angles => [...angles])
}
