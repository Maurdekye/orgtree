import { mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { UsageBars } from '../src/canvas/accounts'
import type { AccountUsage } from '../src/types'

for (const [provider, passed, expected] of [
  ['Muse', true, true], ['Claude', true, false], ['Muse', false, false],
] as const) {
  test(`${provider} unknown window, reset ${passed ? 'passed' : 'future'}: honest reset text and no invented bar`, async () => {
    const usage: AccountUsage = { provider, account: 'fixture', label: 'Fixture account', available: true,
      observed_at: new Date(Date.now() - 2 * 3600e3).toISOString(), limits: [
        { kind: 'session', group: 'window', label: '5 h', percent: null, is_active: null,
          severity: null, model: null, resets_at: new Date(Date.now() + (passed ? -3600e3 : 3600e3)).toISOString() },
        { kind: 'weekly_all', group: 'weekly', label: 'weekly', percent: 73, is_active: false,
          severity: 'normal', model: null, resets_at: new Date(Date.now() + 86400e3).toISOString() },
      ] }
    const view = await mountView(<UsageBars u={usage} />, el => el)
    try {
      const rows = view.el.querySelectorAll('.usage-row')
      assert.equal(rows.length, 2)
      const resetRow = rows[0], weeklyRow = rows[1]
      assert.ok(resetRow)
      assert.ok(weeklyRow)
      assert.equal(resetRow.textContent?.includes('reset; awaiting reading'), expected)
      assert.equal(resetRow.querySelector('.usage-track') === null, true)
      assert.equal(resetRow.querySelector('.u-pct') === null, true)
      assert.equal(weeklyRow.querySelectorAll('.usage-track').length, 1)
      assert.match(weeklyRow.textContent ?? '', /73%/)
    } finally { await view.unmount() }
  })
}
