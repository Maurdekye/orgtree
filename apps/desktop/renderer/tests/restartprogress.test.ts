// The header must distinguish a waiting prime from one whose deploy helper
// has started.  These labels are compared directly so an implementation that
// always reports "primed" or always reports "in progress" cannot pass.

import test from 'node:test'
import assert from 'node:assert/strict'
import { primedRestartChip } from '../src/canvas/shared'

const ARMED = {
  state: 'armed', target: 'org', by_org: 'orgtree', by_node: 'coordinator',
  at: '2026-08-30T17:00:00.000Z', reason: 'ship it',
}

test('triggering changes the exact header status until shutdown', () => {
  const armed = primedRestartChip(ARMED)!
  const executing = primedRestartChip({
    ...ARMED, state: 'executing',
    triggered_at: '2026-08-30T17:01:00.000Z',
  })!

  assert.equal(armed.label, 'restart primed')
  assert.equal(executing.label, 'restart in progress...')
  assert.notEqual(executing.label, armed.label)
  assert.doesNotMatch(executing.label, /primed/)
  assert.match(executing.title, /deploy has started/)
  assert.doesNotMatch(executing.title, /disarm|cancel/,
    'an executing restart was still presented as cancellable')
})

test('old armed records remain armed, while every executing target uses the exact status', () => {
  assert.equal(primedRestartChip({ ...ARMED, state: undefined })!.label,
    'restart primed', 'pre-state persisted records are backward compatible')
  for (const target of ['org', 'mailhub', 'both']) {
    const chip = primedRestartChip({ ...ARMED, state: 'executing', target })!
    assert.equal(chip.label, 'restart in progress...', target)
  }
})
