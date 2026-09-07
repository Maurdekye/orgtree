// codexusage.test.tsx — the shared header usage modal shows Codex limits too.

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
    { kind: 'session', group: 'codex_spark', percent: 82,
      severity: 'warning', resets_at: null, is_active: false,
      model: 'GPT-Spark', label: 'GPT-Spark · 5 hours' },
  ],
}

test('usage modal renders Claude and Codex limit bars together', async () => {
  const g = globalThis as unknown as Record<string, unknown>
  g.fetch = (url: string) => {
    const path = new URL(String(url), 'http://localhost').pathname
    const body = /\/accounts\/usage$/.test(path) ? CLAUDE
      : /\/codex\/usage$/.test(path) ? CODEX : null
    if (!body) return Promise.reject(new Error(`unexpected fetch: ${path}`))
    return Promise.resolve({ ok: true, status: 200, headers: new Headers(),
      json: () => Promise.resolve(body) })
  }
  try {
    const view = await mountView(
      <UsageModal close={() => {}} />, (el) => el)
    await inAct(async () => { await flush(8) })
    const text = view.el.textContent ?? ''
    assert.match(text, /usage limits/)
    assert.match(text, /claude@example\.test/)
    assert.match(text, /Codex · codex@example\.test/)
    assert.match(text, /Codex Pro Lite/)
    assert.match(text, /GPT-Spark · 5 hours/)
    assert.match(text, /82%/)
    assert.equal(view.el.querySelectorAll('.usage-track').length, 3)
  } finally {
    delete g.fetch
  }
})

test('Codex can drive the shared near-limit warning', () => {
  const claude: UsagePeek = { available: true, limits: [] }
  const codex: UsagePeek = { available: true, provider: 'Codex', limits: [
    { kind: 'session', group: 'codex', percent: 91, severity: 'critical',
      resets_at: null, is_active: false, model: null, label: '5 hours' },
  ] }
  const alert = usagePeak(claude, codex)
  assert.equal(alert?.sev, 'crit')
  assert.match(alert?.title ?? '', /5 hours at 91% — Codex usage/)
})
