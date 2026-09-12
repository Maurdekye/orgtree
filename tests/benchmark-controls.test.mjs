import assert from 'node:assert/strict'
import test from 'node:test'
import { runTransitionBenchmark } from './fixtures/benchmark.mjs'

test('benchmark records real transitions and a labelled no-op control', () => {
  let state = 0
  const result = runTransitionBenchmark({
    name: 'fixture transition',
    iterations: 2,
    transition: () => {
      if (state >= 2) return false
      state++
      return true
    },
  })
  assert.equal(result.changes, 2)
  assert.equal(result.noOps, 1)
  assert.deepEqual(result.samples.map(sample => sample.label),
    ['transition', 'transition', 'no-op control'])
  assert.equal(result.samples.at(-1).changed, false)
})

test('benchmark rejects a control that never changes state', () => {
  assert.throws(() => runTransitionBenchmark({ name: 'inert', transition: () => false }), /no-op/)
})
