// Closest ordered arc centres on a circle. Angles are unwrapped in tree order.
// Subtracting the required gaps turns separation into monotonicity; pooled
// adjacent violators gives its least-squares projection in O(groups). The
// wraparound constraint bounds the fitted range by the unused circumference.
export function ringArcCentres(ideal: number[], sizes: number[], step: number): number[] {
  if (!ideal.length) return []
  const offsets = [0]
  for (let i = 1; i < ideal.length; i++)
    offsets.push(offsets[i - 1]! + (sizes[i - 1]! + sizes[i]!) * step / 2)
  const slack = Math.max(0, 2 * Math.PI - sizes.reduce((sum, n) => sum + n, 0) * step)
  // A completely full ring has only one freedom: rigid rotation. Its exact
  // projection is the mean offset; avoid iterative interval fitting for the
  // many contact projections in the spring solver.
  if (slack < 1e-12) {
    const rotation = ideal.reduce((sum, angle, i) => sum + angle - offsets[i]!, 0) / ideal.length
    return offsets.map(offset => offset + rotation)
  }
  const blocks: { start: number; end: number; sum: number; count: number }[] = []
  for (let i = 0; i < ideal.length; i++) {
    blocks.push({ start: i, end: i + 1, sum: ideal[i]! - offsets[i]!, count: 1 })
    while (blocks.length > 1) {
      const b = blocks[blocks.length - 1]!, a = blocks[blocks.length - 2]!
      if (a.sum / a.count <= b.sum / b.count) break
      a.end = b.end; a.sum += b.sum; a.count += b.count
      blocks.pop()
    }
  }
  const fitted = new Array<number>(ideal.length)
  for (const b of blocks) fitted.fill(b.sum / b.count, b.start, b.end)
  if (fitted[fitted.length - 1]! - fitted[0]! > slack) {
    // Clamp to the best interval of length slack. Its convex derivative is
    // monotone; a fixed 60 bisections gives double precision, still O(groups).
    let lo = fitted[0]!, hi = fitted[fitted.length - 1]! - slack
    for (let k = 0; k < 60; k++) {
      const mid = (lo + hi) / 2
      let derivative = 0
      for (const b of blocks) {
        const value = b.sum / b.count
        derivative += b.count * (value < mid ? mid - value : value > mid + slack ? mid + slack - value : 0)
      }
      if (derivative < 0) lo = mid
      else hi = mid
    }
    const start = (lo + hi) / 2
    for (let i = 0; i < fitted.length; i++) fitted[i] = Math.max(start, Math.min(start + slack, fitted[i]!))
  }
  return fitted.map((angle, i) => angle + offsets[i]!)
}
