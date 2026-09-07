// openrouterusage.test.tsx — the shared header usage modal shows OpenRouter limits too.

import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { UsageModal, usagePeak } from '../src/App'
import type { AccountUsage, UsageAllPayload, UsagePeek } from '../src/types'

const CLAUDE: UsageAllPayload = { accounts: [{
  account: 'primary', label: 'claude@example.test', available: true,
  plan: 'max', limits: [{ kind: 'session', group: 'session', percent: 17,
    severity: 'normal', resets_at: null, is_active: false, model: null }],
}] }

const CODEX: AccountUsage = {
  account: 'codex', provider: 'Codex', label: 'codex@example.test',
  available: true, plan: 'Pro Lite', limits: [
    { kind: 'weekly_all', group: 'codex', percent: 9, severity: 'normal',
      resets_at: null, is_active: false, model: null, label: '7 days' },
  ],
}

const ORR_UNCAPPED: AccountUsage = {
  account: 'openrouter', provider: 'OpenRouter', label: 'sk-or-v1-d3e...22c',
  available: true, limits: [
    { kind: 'usage', group: 'credits', percent: null, severity: 'normal',
      resets_at: null, is_active: false, model: null,
      label: '$0.16 spent · no spend cap' },
  ],
}

const ORR_CAPPED: AccountUsage = {
  account: 'openrouter', provider: 'OpenRouter', label: 'capped-key',
  available: true, limits: [
    { kind: 'usage', group: 'credits', percent: 80, severity: 'warning',
      resets_at: null, is_active: false, model: null,
      label: '$40.00 of $50.00 spend cap · renews monthly' },
  ],
}

const stubFetch = (orr: AccountUsage) => {
  const g = globalThis as unknown as Record<string, unknown>
  g.fetch = (url: string) => {
    const path = new URL(String(url), 'http://localhost').pathname
    const body = /\/accounts\/usage$/.test(path) ? CLAUDE
      : /\/codex\/usage$/.test(path) ? CODEX
      : /\/openrouter\/usage$/.test(path) ? orr : null
    if (!body) return Promise.reject(new Error(`unexpected fetch: ${path}`))
    return Promise.resolve({ ok: true, status: 200, headers: new Headers(),
      json: () => Promise.resolve(body) })
  }
  return () => { delete g.fetch }
}

test('usage modal renders OpenRouter uncapped credits honestly without fake bar', async () => {
  const restore = stubFetch(ORR_UNCAPPED)
  try {
    const view = await mountView(<UsageModal close={() => {}} />, (el) => el)
    await inAct(async () => { await flush(8) })
    const text = view.el.textContent ?? ''
    assert.match(text, /usage limits/)
    assert.match(text, /claude@example\.test/)
    assert.match(text, /OpenRouter · sk-or-v1-d3e\.\.\.22c/)
    assert.match(text, /\$0\.16 spent · no spend cap/)
    // Claude has 1 track, Codex has 1 track; OpenRouter uncapped has NO track and NO 0% badge
    assert.equal(view.el.querySelectorAll('.usage-track').length, 2)
    assert.doesNotMatch(text, /0%/)
  } finally {
    restore()
  }
})

test('usage modal renders OpenRouter capped credits with percentage bar', async () => {
  const restore = stubFetch(ORR_CAPPED)
  try {
    const view = await mountView(<UsageModal close={() => {}} />, (el) => el)
    await inAct(async () => { await flush(8) })
    const text = view.el.textContent ?? ''
    assert.match(text, /OpenRouter · capped-key/)
    assert.match(text, /\$40\.00 of \$50\.00 spend cap/)
    assert.match(text, /80%/)
    // Claude (1) + Codex (1) + OpenRouter capped (1) = 3 tracks
    assert.equal(view.el.querySelectorAll('.usage-track').length, 3)
  } finally {
    restore()
  }
})

test('OpenRouter capped lane can drive the shared near-limit warning', () => {
  const claude: UsagePeek = { available: true, limits: [] }
  const orr: UsagePeek = { available: true, provider: 'OpenRouter', limits: [
    { kind: 'usage', group: 'credits', percent: 92, severity: 'critical',
      resets_at: null, is_active: false, model: null, label: 'spend cap' },
  ] }
  const alert = usagePeak(claude, null, null, orr)
  assert.equal(alert?.sev, 'crit')
  assert.match(alert?.title ?? '', /spend cap at 92% — OpenRouter usage/)
})
