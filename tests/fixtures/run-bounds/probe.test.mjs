// tests/fixtures/run-bounds/probe.test.mjs - run-bounds.test.mjs's probe. Not
// in the `tests/*.test.mjs` set (the glob does not recurse): it is only ever
// launched through tests/run.mjs by that suite, and reports what bounds the
// test process it lands in actually carries.
import test from 'node:test'
import v8 from 'node:v8'

test('reports its bounds', () => {
  const bounds = {
    heapMb: Math.round(v8.getHeapStatistics().heap_size_limit / 2 ** 20),
    guard: Boolean(globalThis[Symbol.for('orgtree.testguard.installed')]),
    timeout: process.execArgv.find((arg) => arg.startsWith('--test-timeout=')) ?? null,
    contained: process.env.ORGTREE_TEST_CONTAINED_MB ?? null,
  }
  console.log(`[probe] ${JSON.stringify(bounds)}`)
})

test('second probe test', () => {
  console.log('[probe] second ran')
})
