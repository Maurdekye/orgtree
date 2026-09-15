// antigravityusage.test.tsx — Antigravity's real /usage buckets share the
// usage modal and header warning behavior used by Claude and Codex.

import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { UsageModal, usagePeak } from '../src/App'
import { UsageBars } from '../src/canvas/accounts'
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

test('UsageBars displays authoritative tier for Gemini account when available', async (t) => {
  const agy: AccountUsage = {
    account: 'antigravity', provider: 'Antigravity', label: 'agy@example.test',
    available: true, tier: 'Google AI Pro', limits: [
      { kind: 'weekly_scoped', group: 'gemini-weekly', percent: 25,
        severity: 'normal', resets_at: null, is_active: false, model: 'Gemini Models',
        label: 'Gemini Models · Weekly' },
    ],
  }
  const view = await mountView(<UsageBars u={agy} />, el => el)
  t.after(async () => { await view.unmount() })
  const text = view.el.textContent ?? ''
  assert.match(text, /Google AI Pro/)
  assert.doesNotMatch(text, /Antigravity Google AI Pro/)
  assert.match(text, /Gemini Models · Weekly/)
  assert.match(text, /25%/)
})

test('UsageBars displays tier unavailable when Gemini tier is missing', async (t) => {
  const agy: AccountUsage = {
    account: 'antigravity', provider: 'Antigravity', label: 'agy@example.test',
    available: true, limits: [
      { kind: 'weekly_scoped', group: 'gemini-weekly', percent: 25,
        severity: 'normal', resets_at: null, is_active: false, model: 'Gemini Models',
        label: 'Gemini Models · Weekly' },
    ],
  }
  const view = await mountView(<UsageBars u={agy} />, el => el)
  t.after(async () => { await view.unmount() })
  const text = view.el.textContent ?? ''
  assert.match(text, /Antigravity tier unavailable/)
  assert.match(text, /Gemini Models · Weekly/)
  assert.doesNotMatch(text, /Standard|Advanced|Pro|Consumer/)
})

test('multiple Gemini accounts can show different tiers without cross-account attribution', async (t) => {
  const amb: AccountUsage = {
    account: 'antigravity', provider: 'Antigravity', label: 'amb@example.test',
    available: true, tier: 'Google AI Pro', limits: [],
  }
  const sec: AccountUsage = {
    account: 'google-secondary', provider: 'google', label: 'sec@example.test',
    available: true, tier: 'Google AI Plus', limits: [],
  }
  const viewAmb = await mountView(<UsageBars u={amb} />, el => el)
  t.after(async () => { await viewAmb.unmount() })
  assert.match(viewAmb.el.textContent ?? '', /Google AI Pro/)
  assert.doesNotMatch(viewAmb.el.textContent ?? '', /Google AI Plus/)

  const viewSec = await mountView(<UsageBars u={sec} />, el => el)
  t.after(async () => { await viewSec.unmount() })
  assert.match(viewSec.el.textContent ?? '', /Google AI Plus/)
  assert.doesNotMatch(viewSec.el.textContent ?? '', /Google AI Pro/)
})

test('non-Gemini provider rows remain unchanged', async (t) => {
  const claudeWithPlan: AccountUsage = {
    account: 'primary', provider: 'Claude', label: 'claude@example.test',
    available: true, plan: 'max', limits: [],
  }
  const claudeNoPlan: AccountUsage = {
    account: 'primary', provider: 'Claude', label: 'claude@example.test',
    available: true, limits: [],
  }
  const codex: AccountUsage = {
    account: 'codex', provider: 'Codex', label: 'codex@example.test',
    available: true, limits: [],
  }

  const v1 = await mountView(<UsageBars u={claudeWithPlan} />, el => el)
  t.after(async () => { await v1.unmount() })
  assert.match(v1.el.textContent ?? '', /Claude max/)

  const v2 = await mountView(<UsageBars u={claudeNoPlan} />, el => el)
  t.after(async () => { await v2.unmount() })
  assert.doesNotMatch(v2.el.textContent ?? '', /tier unavailable/)
  assert.doesNotMatch(v2.el.textContent ?? '', /Claude max/)

  const v3 = await mountView(<UsageBars u={codex} />, el => el)
  t.after(async () => { await v3.unmount() })
  assert.doesNotMatch(v3.el.textContent ?? '', /tier unavailable/)
})

test('UsageBars and modal reproduce image-115 resolution with tier unavailable and intact quota buckets', async (t) => {
  const agy: AccountUsage = {
    account: 'antigravity', provider: 'Antigravity', label: 'ncolaprete@gmail.com',
    available: true, limits: [
      { kind: 'weekly_scoped', group: 'gemini-weekly', percent: 25.8,
        severity: 'normal', resets_at: '2026-09-19T19:40:25Z',
        is_active: false, model: 'Gemini Models',
        label: 'Gemini Models · Weekly' },
      { kind: 'session', group: 'gemini-5h', percent: 58.6,
        severity: 'normal', resets_at: '2026-09-14T17:09:59Z',
        is_active: false, model: 'Gemini Models',
        label: 'Gemini Models · Five Hour' },
      { kind: 'weekly_scoped', group: '3p-weekly', percent: 0,
        severity: 'normal', resets_at: '2026-09-21T13:46:17Z',
        is_active: false, model: 'Claude and GPT models',
        label: 'Claude and GPT models · Weekly' },
      { kind: 'session', group: '3p-5h', percent: 0,
        severity: 'normal', resets_at: '2026-09-14T18:46:17Z',
        is_active: false, model: 'Claude and GPT models',
        label: 'Claude and GPT models · Five Hour' },
    ],
  }
  const viewBars = await mountView(<UsageBars u={agy} />, el => el)
  t.after(async () => { await viewBars.unmount() })
  const barText = viewBars.el.textContent ?? ''
  assert.match(barText, /Antigravity tier unavailable/)
  assert.doesNotMatch(barText, /Consumer/)
  assert.match(barText, /Gemini Models · Weekly/)
  assert.match(barText, /26%/)
  assert.match(barText, /Gemini Models · Five Hour/)
  assert.match(barText, /59%/)

  const restore = stubFetch(agy)
  try {
    const viewModal = await mountView(<UsageModal close={() => {}} />, el => el)
    await inAct(async () => { await flush(8) })
    const modalText = viewModal.el.textContent ?? ''
    assert.match(modalText, /Antigravity tier unavailable/)
    assert.doesNotMatch(modalText, /Consumer/)
    assert.match(modalText, /ncolaprete@gmail\.com/)
    assert.match(modalText, /Gemini Models · Weekly/)
    assert.match(modalText, /Claude and GPT models · Five Hour/)
  } finally {
    restore()
  }
})

test('official Google AI paid plan names render directly without Antigravity prefix', async (t) => {
  for (const plan of ['Google AI Plus', 'Google AI Pro', 'Google AI Ultra']) {
    const u: AccountUsage = {
      account: 'antigravity', provider: 'Antigravity', label: 'user@example.test',
      available: true, tier: plan, limits: [],
    }
    const view = await mountView(<UsageBars u={u} />, el => el)
    t.after(async () => { await view.unmount() })
    const text = view.el.textContent ?? ''
    assert.match(text, new RegExp(plan))
    assert.doesNotMatch(text, new RegExp(`Antigravity ${plan}`))
  }
})


