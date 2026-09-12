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
    const body = path === '/api/usage' ? CLAUDE.accounts[0]
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
    assert.match(text, /Usage/)
    assert.doesNotMatch(text, /Usage limits/)
    assert.match(text, /Claude Code/)
    assert.match(text, /Codex · codex@example\.test/)
    assert.match(text, /Codex Pro Lite/)
    assert.match(text, /GPT-Spark · 5 hours/)
    assert.match(text, /82%/)
    assert.equal(view.el.querySelectorAll('.usage-track').length, 3)
  } finally {
    delete g.fetch
  }
})

test('each provider refresh is gated and reports its update time', async () => {
  const g = globalThis as unknown as Record<string, unknown>
  let codexRequests = 0
  const codexQueries: string[] = []
  let settleCodex: ((value: AccountUsage) => void) | null = null
  g.fetch = (url: string) => {
    const parsed = new URL(String(url), 'http://localhost')
    const path = parsed.pathname
    if (path === '/api/providers') return Promise.resolve({ ok: true, status: 200,
      headers: new Headers(), json: () => Promise.resolve({
        providers: [
          { id: 'claude', hire_enabled: true, status: { installed: true } },
          { id: 'openai', hire_enabled: true, status: { installed: true } },
        ],
      }) })
    if (path === '/api/usage') return Promise.resolve({ ok: true, status: 200,
      headers: new Headers(), json: () => Promise.resolve(CLAUDE.accounts[0]) })
    if (/\/codex\/usage$/.test(path)) {
      codexRequests++
      codexQueries.push(parsed.search)
      return new Promise((resolve) => { settleCodex = (value) => resolve({
        ok: true, status: 200, headers: new Headers(), json: () => Promise.resolve(value),
      }) })
    }
    return Promise.reject(new Error(`unexpected fetch: ${path}`))
  }
  try {
    const view = await mountView(<UsageModal close={() => {}} />, (el) => el)
    await inAct(async () => { await flush(4) })
    assert.equal(codexRequests, 1, 'the initial provider read is in flight')
    assert.deepEqual(codexQueries, [''], 'normal reads stay cache-backed')
    const button = view.el.querySelector<HTMLButtonElement>(
      '[aria-label="refresh Codex usage"]')
    assert.ok(button)
    await inAct(() => { button!.click() })
    assert.equal(codexRequests, 1, 'a pending manual click does not overlap the initial read')
    settleCodex!(CODEX)
    await inAct(async () => { await flush(5) })
    assert.match(view.el.textContent ?? '', /updated/)
    button.click()
    await inAct(async () => { await flush(2) })
    assert.equal(codexRequests, 2, 'a later click starts one new provider read')
    assert.deepEqual(codexQueries, ['', '?force=true'],
      'manual refresh reaches the provider force-read path')
    button.click()
    assert.equal(codexRequests, 2, 'a duplicate click cannot overlap the read')
    settleCodex!(CODEX)
    await inAct(async () => { await flush(3) })
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
