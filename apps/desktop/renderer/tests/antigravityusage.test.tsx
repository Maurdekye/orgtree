// antigravityusage.test.tsx — Antigravity's real /usage buckets share the
// usage modal and header warning behavior used by Claude and Codex.

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
  available: true, limits: [
    { kind: 'weekly_all', group: 'codex', percent: 9, severity: 'normal',
      resets_at: null, is_active: false, model: null, label: '7 days' },
  ],
}

const ANTIGRAVITY: AccountUsage = {
  account: 'antigravity', provider: 'Antigravity', label: 'agy@example.test',
  available: true, observed_at: '2026-09-12T12:04:17Z', limits: [
    { kind: 'weekly_scoped', group: 'gemini-weekly', percent: 28.78,
      severity: 'normal', resets_at: '2026-09-17T19:40:25Z',
      is_active: false, model: 'Gemini Models',
      label: 'Gemini Models · Weekly' },
    { kind: 'session', group: 'gemini-5h', percent: 64.4,
      severity: 'normal', resets_at: '2026-09-12T14:35:27Z',
      is_active: false, model: 'Gemini Models',
      label: 'Gemini Models · Five Hour' },
    { kind: 'weekly_scoped', group: '3p-weekly', percent: 0,
      severity: 'normal', resets_at: '2026-09-19T12:04:17Z',
      is_active: false, model: 'Claude and GPT models',
      label: 'Claude and GPT models · Weekly' },
    { kind: 'session', group: '3p-5h', percent: 0,
      severity: 'normal', resets_at: '2026-09-12T17:04:17Z',
      is_active: false, model: 'Claude and GPT models',
      label: 'Claude and GPT models · Five Hour' },
  ],
}

const stubFetch = (agy: AccountUsage) => {
  const g = globalThis as unknown as Record<string, unknown>
  g.fetch = (url: string) => {
    const path = new URL(String(url), 'http://localhost').pathname
    const body = path === '/api/usage' ? CLAUDE.accounts[0]
      : /\/codex\/usage$/.test(path) ? CODEX
      : /\/antigravity\/usage$/.test(path) ? agy : null
    if (!body) return Promise.reject(new Error(`unexpected fetch: ${path}`))
    return Promise.resolve({ ok: true, status: 200, headers: new Headers(),
      json: () => Promise.resolve(body) })
  }
  return () => { delete g.fetch }
}

test('usage modal renders all real Antigravity quota buckets', async () => {
  const restore = stubFetch(ANTIGRAVITY)
  try {
    const view = await mountView(<UsageModal close={() => {}} />, (el) => el)
    await inAct(async () => { await flush(8) })
    const text = view.el.textContent ?? ''
    assert.match(text, /Antigravity · agy@example\.test/)
    assert.match(text, /Gemini Models · Weekly/)
    assert.match(text, /29%/)
    assert.match(text, /Gemini Models · Five Hour/)
    assert.match(text, /64%/)
    assert.match(text, /Claude and GPT models · Weekly/)
    // one Claude, one Codex, and four Antigravity bars
    assert.equal(view.el.querySelectorAll('.usage-track').length, 6)
    assert.ok(!view.el.querySelector('[data-testid="agy-estimate"]'),
      'the obsolete inferred token estimate is gone')
  } finally {
    restore()
  }
})

test('a real Antigravity near-limit bucket drives the shared header glow', () => {
  const claude: UsagePeek = { available: true, limits: [] }
  const codex: UsagePeek = { available: true, provider: 'Codex', limits: [] }
  const agy: UsagePeek = { available: true, provider: 'Antigravity', limits: [
    { kind: 'session', group: 'gemini-5h', percent: 94,
      severity: 'critical', resets_at: '2026-09-12T14:35:27Z',
      is_active: false, model: 'Gemini Models',
      label: 'Gemini Models · Five Hour' },
  ] }
  const alert = usagePeak(claude, codex, agy)
  assert.equal(alert?.sev, 'crit')
  assert.match(alert?.title ?? '', /Five Hour at 94%/)
  assert.match(alert?.title ?? '', /Antigravity usage$/)
})
