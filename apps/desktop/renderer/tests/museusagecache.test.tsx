import { mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { UsageBars } from '../src/canvas/accounts'
import type { AccountUsage } from '../src/types'

for (const [provider, passed, expected] of [
  ['Muse', true, true], ['Claude', true, false], ['Muse', false, false],
] as const) {
  test(`${provider} unknown window, reset ${passed ? 'passed' : 'future'}: honest reset text and no invented bar`, async () => {
    const usage: AccountUsage = { provider, account: 'fixture', available: true,
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
      assert.equal(rows[0].textContent?.includes('reset; awaiting reading'), expected)
      assert.equal(rows[0].querySelector('.usage-track') === null, true)
      assert.equal(rows[0].querySelector('.u-pct') === null, true)
      assert.equal(rows[1].querySelectorAll('.usage-track').length, 1)
      assert.match(rows[1].textContent ?? '', /73%/)
    } finally { await view.unmount() }
  })
}
