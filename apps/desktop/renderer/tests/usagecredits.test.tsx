// usagecredits.test.tsx — an account's extra usage credits show in the usage
// panel when its provider reports them, and nothing shows when it does not
// (docket v3-usage-panel-show-extra-usage-credits-per-acco).

import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import { legacyAppBackend } from './appfeed-fixture'
import assert from 'node:assert/strict'
import { UsageModal } from '../src/App'
import { UsageBars, creditsText } from '../src/canvas/accounts'
import type { AccountUsage, UsageAllPayload } from '../src/types'

const WEEKLY_FULL = { kind: 'weekly_all', group: 'codex', percent: 100,
  severity: 'critical', resets_at: null, is_active: true, model: null,
  label: '7 days' }

// the shape openai/primary reported on 2026-10-01: a full weekly window
// beside ~62,000 credits
const CODEX: AccountUsage = {
  account: 'codex', provider: 'Codex', label: 'codex@example.test',
  available: true, plan: 'Pro', limits: [WEEKLY_FULL],
  credits: { balance: 62036.6481075, unit: 'credits', unlimited: false },
}

const CLAUDE: UsageAllPayload = { accounts: [{
  account: 'primary', label: 'claude@example.test', available: true,
  plan: 'max', limits: [{ kind: 'session', group: 'session', percent: 17,
    severity: 'normal', resets_at: null, is_active: false, model: null }],
}] }

test('creditsText formats what the provider reported and nothing else', () => {
  assert.equal(creditsText({ balance: 62036.6481075, unit: 'credits', unlimited: false }),
    'credits: 62,036')
  assert.equal(creditsText({ balance: 1.999, unit: 'credits', unlimited: false }),
    'credits: 1', 'whole credits truncate, never round up')
  // review-sol F1: a positive balance below one is still a balance — never "0"
  assert.equal(creditsText({ balance: 0.4, unit: 'credits', unlimited: false }),
    'credits: 0.4')
  assert.equal(creditsText({ balance: 0.999, unit: 'credits', unlimited: false }),
    'credits: 0.99', 'below one truncates too, never up to 1')
  assert.equal(creditsText({ balance: 0.0042, unit: 'credits', unlimited: false }),
    'credits: 0.0042')
  assert.equal(creditsText({ balance: 12.5, unit: 'USD', unlimited: false }),
    'credits: $12.50')
  assert.equal(creditsText({ balance: 7, unit: 'EUR', unlimited: false }),
    'credits: €7.00')
  assert.equal(creditsText({ balance: null, unit: 'credits', unlimited: true }),
    'credits: unlimited')
  assert.equal(creditsText({ balance: 3, unit: 'NOT-A-CODE', unlimited: false }),
    'credits: 3.00 NOT-A-CODE')
  for (const c of [undefined, null,
    { balance: 0, unit: 'credits', unlimited: false },
    { balance: -1, unit: 'USD', unlimited: false },
    { balance: null, unit: 'credits', unlimited: false },
    { balance: Number.NaN, unit: 'credits', unlimited: false }]) {
    assert.equal(creditsText(c), null, JSON.stringify(c))
  }
})

test('a reported balance shows on the account and the bars stay as they were', async (t) => {
  const view = await mountView(<UsageBars u={CODEX} />, el => el)
  t.after(async () => { await view.unmount() })
  const line = view.el.querySelectorAll('.usage-credits')
  assert.equal(line.length, 1)
  assert.equal(line[0].textContent, 'credits: 62,036')
  assert.equal(view.el.querySelectorAll('.usage-track').length, 1)
  assert.match(view.el.textContent ?? '', /100%/)
})

test('no reported credits shows no credit line at all', async (t) => {
  const { credits: _gone, ...plain } = CODEX
  const view = await mountView(<UsageBars u={plain} />, el => el)
  t.after(async () => { await view.unmount() })
  assert.equal(view.el.querySelectorAll('.usage-credits').length, 0)
  assert.doesNotMatch(view.el.textContent ?? '', /credits/)
})

test('a balance still shows when the windows could not be read', async (t) => {
  const view = await mountView(<UsageBars u={{ ...CODEX, available: false,
    limits: [], error: 'Codex reported no usage-limit windows' }} />, el => el)
  t.after(async () => { await view.unmount() })
  assert.match(view.el.textContent ?? '', /credits: 62,036/)
  assert.match(view.el.textContent ?? '', /no usage-limit windows/)
})

test('the usage modal puts the credit line on the account that has credits', async () => {
  const g = globalThis as unknown as Record<string, unknown>
  g.fetch = legacyAppBackend(((url: string) => {
    const path = new URL(String(url), 'http://localhost').pathname
    const body = path === '/api/usage' ? CLAUDE.accounts[0]
      : /\/codex\/usage$/.test(path) ? CODEX : null
    if (!body) return Promise.reject(new Error(`unexpected fetch: ${path}`))
    return Promise.resolve({ ok: true, status: 200, headers: new Headers(),
      json: () => Promise.resolve(body) })
  }) as typeof fetch)
  try {
    const view = await mountView(<UsageModal close={() => {}} toast={() => {}} />, (el) => el)
    await inAct(async () => { await flush(8) })
    const lines = view.el.querySelectorAll('.usage-credits')
    assert.equal(lines.length, 1, 'only the Codex account reports credits')
    assert.equal(lines[0].textContent, 'credits: 62,036')
    const card = lines[0].closest('.usage-acct')
    assert.match(card?.textContent ?? '', /codex@example\.test/)
    await view.unmount()
  } finally {
    delete g.fetch
  }
})
