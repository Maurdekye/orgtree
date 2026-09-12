/**
 * Measure a state transition without pretending that an unchanged state is a
 * transition. `transition` must return true when it changes state and false
 * for a no-op. The no-op control is always executed once, even for a single
 * iteration run.
 */
export function runTransitionBenchmark({ name, transition, iterations = 1,
  now = () => performance.now() } = {}) {
  if (!name || typeof name !== 'string') throw new TypeError('benchmark name is required')
  if (typeof transition !== 'function') throw new TypeError('benchmark transition is required')
  if (!Number.isInteger(iterations) || iterations < 1) throw new RangeError('iterations must be positive')
  const samples = []
  let changes = 0
  for (let i = 0; i < iterations; i++) {
    const started = now()
    const changed = transition()
    const elapsed = Math.max(0, now() - started)
    if (!changed) throw new Error(`${name}: transition iteration ${i + 1} was a no-op`)
    changes++
    samples.push({ label: 'transition', changed: true, elapsedMs: elapsed })
  }
  const started = now()
  const changed = transition()
  const elapsed = Math.max(0, now() - started)
  if (changed) throw new Error(`${name}: no-op control changed state`)
  samples.push({ label: 'no-op control', changed: false, elapsedMs: elapsed })
  return { name, iterations, changes, noOps: 1, samples }
}
