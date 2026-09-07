import './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { costLabel, costTitle, showCost } from '../src/App'
import type { TreePayload } from '../src/types'

const tree = (cost: number, unknown = false, api = 0): TreePayload => ({
  cost_usd_total: cost, cost_usd_unknown: unknown, api_cost_usd_total: api,
  api_fallback: false, roots: [], audiences: [], audit: {
    no_cycles: true, no_overdraft: true, credits_conserved: true, problems: [],
  }, tiers: {}, slug: 'cost', name: 'cost', kiosk: null,
} as unknown as TreePayload)

test('org cost gate and label distinguish known zero from unresolved estimates', () => {
  const knownZero = tree(0)
  assert.equal(showCost(knownZero), false)
  assert.equal(costLabel(knownZero), '$0.00')

  const unknownZero = tree(0, true)
  assert.equal(showCost(unknownZero), true)
  assert.equal(costLabel(unknownZero), '$?')
  assert.equal(costTitle(unknownZero),
    'total spend — recorded numeric estimate; unresolved amounts are not accounted for')

  const incomplete = tree(1.25, true, 0.25)
  assert.equal(showCost(incomplete), true)
  assert.equal(costLabel(incomplete), '$1.25 estimated/incomplete')
  assert.match(costTitle(incomplete), /subscription \$1\.00 · api key \$0\.25/)
  assert.match(costTitle(incomplete, true),
    /^spend \/ limit — subscription .* — recorded numeric estimate;/)
  assert.doesNotMatch(costLabel(incomplete), /at least|≥/)
})

