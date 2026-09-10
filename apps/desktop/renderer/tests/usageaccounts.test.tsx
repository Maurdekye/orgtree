// usageaccounts.test.tsx — the header usage modal lists every REGISTERED
// account, not only the host lanes (user report 2026-09-10: a signed-in
// secondary Claude account's usage showed in App settings but was absent
// from the general Usage modal).
//
// The registry's `ambient` rows are exactly the accounts the provider lanes
// already render, so the modal must show every non-ambient row ONCE, with
// its own label and its own independent bars — and must SAY when the
// registry list cannot be read rather than silently omitting accounts.

import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { UsageModal } from '../src/App'
import type { AccountRegistryPayload, RegisteredAccountUsage, UsagePayload } from '../src/types'

const HOST_CLAUDE: UsagePayload = {
  available: true, plan: 'max', email: 'primary@example.test',
  limits: [{ kind: 'session', group: 'session', percent: 17,
    severity: 'normal', resets_at: null, is_active: false, model: null }],
}

const REGISTRY: AccountRegistryPayload = {
  primary: 'claude-1',
  accounts: [
    { id: 'claude-1', provider: 'claude', harness: 'claude-code',
      label: 'claude (machine login)',
      credential: { kind: 'imported', path: 'C:/Users/x/.claude', default_config: true },
      identity: { email: 'primary@example.test' }, auth: 'authenticated',
      tint_ordinal: 1, ambient: true,
      standing: { auth: 'authenticated', state: 'ready', marks: {} }, bound: [] },
    { id: 'claude-4', provider: 'claude', harness: 'claude-code',
      label: 'claude-0',
      credential: { kind: 'managed', path: 'C:/data/profiles/claude-4' },
      identity: { email: 'second@example.test' }, auth: 'authenticated',
      tint_ordinal: 4, ambient: false,
      standing: { auth: 'authenticated', state: 'ready', marks: {} }, bound: [] },
  ],
}

const SECONDARY_USAGE: RegisteredAccountUsage = {
  account: 'claude-4', provider: 'claude', label: 'claude-0', available: true,
  plan: 'Max', limits: [
    { kind: 'session', group: 'session', percent: 42, severity: 'normal',
      resets_at: null, is_active: false, model: null },
    { kind: 'weekly_all', group: 'weekly', percent: 67, severity: 'normal',
      resets_at: null, is_active: false, model: null },
  ],
  standing: { auth: 'authenticated', state: 'ready',
    marks: { pooled: { until: 4102444800, provenance: 'inferred' } } },
}

const PROVIDERS = { providers: [
  { id: 'claude', hire_enabled: true, status: { installed: true } },
] }

function mockFetch(routes: Record<string, unknown>) {
  return (url: string) => {
    const path = new URL(String(url), 'http://localhost').pathname
    if (!(path in routes)) return Promise.reject(new Error(`unexpected fetch: ${path}`))
    const body = routes[path]
    if (body instanceof Error) return Promise.reject(body)
    return Promise.resolve({ ok: true, status: 200, headers: new Headers(),
      json: () => Promise.resolve(body) })
  }
}

test('the usage modal renders each registered non-ambient account once, labelled', async () => {
  const g = globalThis as unknown as Record<string, unknown>
  g.fetch = mockFetch({
    '/api/usage': HOST_CLAUDE,
    '/api/providers': PROVIDERS,
    '/api/accounts': REGISTRY,
    '/api/accounts/claude-4/usage': SECONDARY_USAGE,
  })
  try {
    const view = await mountView(
      <UsageModal close={() => {}} toast={() => {}} />, (el) => el)
    await inAct(async () => { await flush(8) })
    const text = view.el.textContent ?? ''
    // the host lane is still the host lane
    assert.match(text, /Claude Code/)
    assert.match(text, /17%/)
    // the secondary account has its OWN section, named and identified
    assert.ok(view.el.querySelector('[data-account="claude-4"]'),
      'the registered secondary account gets a section')
    assert.match(text, /claude-0/)
    assert.match(text, /second@example\.test/)
    assert.match(text, /42%/)
    assert.match(text, /67%/)
    // its standing marks travel with it, provenance shown
    assert.match(text, /pooled limited until/)
    assert.match(text, /\(inferred\)/)
    // the ambient/primary registry row is NOT duplicated as a second section
    assert.equal(view.el.querySelector('[data-account="claude-1"]'), null,
      'the primary row is the host lane, never a second section')
    // 1 host bar + 2 secondary bars, and nothing summed across them
    assert.equal(view.el.querySelectorAll('.usage-track').length, 3)
  } finally {
    delete g.fetch
  }
})

test('an unreadable registry list says so instead of omitting accounts silently', async () => {
  const g = globalThis as unknown as Record<string, unknown>
  g.fetch = mockFetch({
    '/api/usage': HOST_CLAUDE,
    '/api/providers': PROVIDERS,
    '/api/accounts': new Error('registry down'),
  })
  try {
    const view = await mountView(
      <UsageModal close={() => {}} toast={() => {}} />, (el) => el)
    await inAct(async () => { await flush(8) })
    const text = view.el.textContent ?? ''
    assert.match(text, /Claude Code/)
    assert.match(text, /registered accounts unavailable: registry down/)
  } finally {
    delete g.fetch
  }
})

test('a registry answering an alien shape reads as an older backend, not as no accounts', async () => {
  const g = globalThis as unknown as Record<string, unknown>
  g.fetch = mockFetch({
    '/api/usage': HOST_CLAUDE,
    '/api/providers': PROVIDERS,
    // the LEGACY readout shape (no `accounts` array) — an older backend
    '/api/accounts': { version: 1, primary: { signed_in: true, email: 'x@y' } },
  })
  try {
    const view = await mountView(
      <UsageModal close={() => {}} toast={() => {}} />, (el) => el)
    await inAct(async () => { await flush(8) })
    assert.match(view.el.textContent ?? '',
      /registered accounts unavailable: .*older backend/)
  } finally {
    delete g.fetch
  }
})
