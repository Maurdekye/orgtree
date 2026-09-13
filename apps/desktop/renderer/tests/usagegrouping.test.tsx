// usagegrouping.test.tsx — the Usage modal groups its account cards by
// provider (ticket: group-usage-accounts-by-provider).
//
// THE DEFECT THIS PINS. The modal drew the four HOST lanes first — Claude,
// Codex, Antigravity, OpenRouter — and then every registered account beneath
// them in registry order. So a machine with two Claude logins and one Codex
// login read Claude · Codex · Antigravity · <second Claude>: the two accounts
// a reader most wants to compare sat furthest apart, with two unrelated
// providers between them.
//
// TWO LAYERS ON PURPOSE. The pure rule (groupByProvider) is exercised
// directly, because its edge cases — an unknown provider, a provider present
// only in the registry, two same-provider cards that must not swap — are data
// facts that do not need a modal to state. The modal tests then prove the
// rendered list really is built through that rule, and that grouping moved
// cards WITHOUT changing what any card says.

import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { UsageModal } from '../src/App'
import { groupByProvider, USAGE_PROVIDER_ORDER } from '../src/usagegroups'
import type { AccountRegistryPayload, AccountRegistryRow, RegisteredAccountUsage, UsagePayload } from '../src/types'

/* ─── §1 the pure ordering rule ─────────────────────────────────────────── */

const ids = (cards: { provider: string; id: string }[]) =>
  groupByProvider(cards).map((c) => c.id)

test('§1a the ruled providers come out in the ruled order, from interleaved input', () => {
  assert.deepEqual(ids([
    { provider: 'google', id: 'g1' },
    { provider: 'claude', id: 'c1' },
    { provider: 'openai', id: 'o1' },
    { provider: 'google', id: 'g2' },
    { provider: 'claude', id: 'c2' },
    { provider: 'openai', id: 'o2' },
  ]), ['c1', 'c2', 'o1', 'o2', 'g1', 'g2'])
  // and the order it sorts into is the order the ticket names
  assert.deepEqual([...USAGE_PROVIDER_ORDER], ['claude', 'openai', 'google'])
})

test('§1b within a provider the input order survives exactly', () => {
  // ⚠ THE POINT OF THE TEST IS THE SUFFIX ORDER, NOT THE GROUPING. A rule that
  // grouped correctly but sorted accounts inside a group — by id, by label, by
  // anything — would renumber the reader's account list every time a provider
  // was added. The three claude entries are deliberately in an order no
  // comparison would produce on its own.
  assert.deepEqual(ids([
    { provider: 'claude', id: 'c-zulu' },
    { provider: 'openai', id: 'o-mike' },
    { provider: 'claude', id: 'c-alpha' },
    { provider: 'openai', id: 'o-bravo' },
    { provider: 'claude', id: 'c-mike' },
  ]), ['c-zulu', 'c-alpha', 'c-mike', 'o-mike', 'o-bravo'])
})

test('§1c an unruled provider follows the three, grouped rather than left interleaved', () => {
  // openrouter has no ruled position, so it sorts after google — but its two
  // cards must still end up ADJACENT. This is the case a stable sort with one
  // shared "everything else" rank gets wrong: it would leave or1/x1/or2 exactly
  // as given, which is the interleaving the ticket exists to remove.
  assert.deepEqual(ids([
    { provider: 'openrouter', id: 'or1' },
    { provider: 'xenon', id: 'x1' },
    { provider: 'openrouter', id: 'or2' },
    { provider: 'claude', id: 'c1' },
    { provider: 'xenon', id: 'x2' },
  ]), ['c1', 'or1', 'or2', 'x1', 'x2'])
})

test('§1d unruled providers are ordered by first appearance, not by name', () => {
  // 'zeta' appears before 'alpha', so zeta's group comes first. Deterministic
  // (same input, same output) without imposing an alphabetical order that
  // would have reshuffled the host lanes had it been applied to them too.
  assert.deepEqual(ids([
    { provider: 'zeta', id: 'z1' },
    { provider: 'alpha', id: 'a1' },
    { provider: 'zeta', id: 'z2' },
  ]), ['z1', 'z2', 'a1'])
})

test('§1e the same input always yields the same output, and the input is not mutated', () => {
  const input = [
    { provider: 'google', id: 'g1' },
    { provider: 'claude', id: 'c1' },
    { provider: 'openai', id: 'o1' },
    { provider: 'claude', id: 'c2' },
  ]
  const before = input.map((c) => c.id)
  const once = groupByProvider(input).map((c) => c.id)
  const twice = groupByProvider(input).map((c) => c.id)
  assert.deepEqual(once, ['c1', 'c2', 'o1', 'g1'])
  assert.deepEqual(twice, once, 'a refresh with identical data reorders identically')
  // ⚠ a poll re-runs this on the SAME arrays every 60s; an in-place sort would
  // make the second pass read a list the first pass had already rearranged
  assert.deepEqual(input.map((c) => c.id), before, 'the caller\'s array is untouched')
})

test('§1f nothing, and one card, are not special cases', () => {
  assert.deepEqual(groupByProvider([]), [])
  assert.deepEqual(ids([{ provider: 'xenon', id: 'only' }]), ['only'])
})

test('§1g no card is dropped or duplicated by the regrouping', () => {
  const cards = Array.from({ length: 24 }, (_, i) => ({
    provider: ['google', 'claude', 'openrouter', 'openai', 'xenon'][i % 5]!,
    id: `card-${i}`,
  }))
  const out = groupByProvider(cards)
  assert.equal(out.length, cards.length)
  assert.deepEqual(new Set(out.map((c) => c.id)).size, cards.length)
})

/* ─── §2 the modal ──────────────────────────────────────────────────────── */

const HOST_CLAUDE: UsagePayload = {
  available: true, plan: 'max', email: 'claude-host@example.test',
  limits: [{ kind: 'session', group: 'session', percent: 11,
    severity: 'normal', resets_at: null, is_active: false, model: null }],
}
const HOST_CODEX = {
  account: 'default', provider: 'Codex', available: true, plan: 'plus',
  email: 'codex-host@example.test',
  limits: [{ kind: 'weekly_all', group: 'weekly', percent: 22,
    severity: 'normal', resets_at: null, is_active: false, model: null }],
}
// ⚠ THE SAME `account: "default"` AS CODEX ABOVE, ON PURPOSE. Both host lanes
// legitimately report the ambient login that way, and the cards now live in
// ONE keyed array — so a key taken straight from `account` would collide and
// React would silently render one card instead of two. §2a counts the cards.
const HOST_AGY = {
  account: 'default', provider: 'Antigravity', available: true,
  email: 'agy-host@example.test',
  limits: [{ kind: 'session', group: 'session', percent: 33,
    severity: 'normal', resets_at: null, is_active: false, model: null }],
}
// OpenRouter is the REAL unruled provider this build ships with — a prepaid
// key, not a subscription lane — so it is the one that proves "followed by any
// other providers" against something other than an invented id.
const HOST_ORR = {
  account: 'openrouter', provider: 'OpenRouter', available: true,
  label: 'sk-or-v1-d3e...22c',
  limits: [{ kind: 'usage', group: 'credits', percent: 88,
    severity: 'warning', resets_at: null, is_active: false, model: null,
    label: '$44.00 of $50.00 spend cap' }],
}

const row = (id: string, provider: string, email: string): AccountRegistryRow => ({
  id, provider, harness: provider, label: id,
  credential: { kind: 'managed', path: `C:/data/profiles/${id}` },
  identity: { email }, auth: 'authenticated', tint_ordinal: 1, ambient: false,
  standing: { auth: 'authenticated', state: 'ready', marks: {} }, bound: [],
})

const usageFor = (id: string, provider: string, percent: number): RegisteredAccountUsage => ({
  account: id, provider, label: id, available: true, plan: 'Max',
  limits: [{ kind: 'session', group: 'session', percent,
    severity: 'normal', resets_at: null, is_active: false, model: null }],
  standing: { auth: 'authenticated', state: 'ready', marks: {} },
})

// INTERLEAVED ON PURPOSE — this is the registry order the backend may hand us,
// and the order the modal used to render underneath the host lanes.
const INTERLEAVED: AccountRegistryPayload = {
  primary: 'claude-1',
  accounts: [
    row('google-7', 'google', 'g7@example.test'),
    row('claude-4', 'claude', 'c4@example.test'),
    row('openai-1', 'openai', 'o1@example.test'),
    row('claude-9', 'claude', 'c9@example.test'),
    row('openai-5', 'openai', 'o5@example.test'),
  ],
}

const PROVIDERS = { providers: [
  { id: 'claude', hire_enabled: true, status: { installed: true } },
  { id: 'openai', hire_enabled: true, status: { installed: true } },
  { id: 'google', hire_enabled: true, status: { installed: true } },
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

const ROUTES = {
  '/api/usage': HOST_CLAUDE,
  '/api/codex/usage': HOST_CODEX,
  '/api/antigravity/usage': HOST_AGY,
  '/api/openrouter/usage': HOST_ORR,
  '/api/providers': PROVIDERS,
  '/api/accounts': INTERLEAVED,
  '/api/accounts/claude-4/usage': usageFor('claude-4', 'claude', 44),
  '/api/accounts/claude-9/usage': usageFor('claude-9', 'claude', 49),
  '/api/accounts/openai-1/usage': usageFor('openai-1', 'openai', 51),
  '/api/accounts/openai-5/usage': usageFor('openai-5', 'openai', 55),
  '/api/accounts/google-7/usage': usageFor('google-7', 'google', 77),
}

/** every card in DOM order, named: a registered row by its account id, a host
 *  lane by the harness name in its heading (it carries no account id). */
const cardOrder = (el: Element): string[] =>
  [...el.querySelectorAll('.usage-acct')].map((card) =>
    card.getAttribute('data-account')
      ?? 'host:' + (card.querySelector('.acct-label')?.textContent ?? '?'))

async function openModal() {
  const view = await mountView(
    <UsageModal close={() => {}} toast={() => {}} />, (el) => el)
  await inAct(async () => { await flush(10) })
  return view
}

test('§2a interleaved accounts render grouped: every Claude, then every Codex, then every Antigravity', async () => {
  const g = globalThis as unknown as Record<string, unknown>
  g.fetch = mockFetch(ROUTES)
  try {
    const view = await openModal()
    assert.deepEqual(cardOrder(view.el), [
      'host:Claude Code', 'claude-4', 'claude-9',
      'host:Codex', 'openai-1', 'openai-5',
      'host:Antigravity', 'google-7',
      'host:OpenRouter',
    ])
    // NINE CARDS, COUNTED — nothing was lost on the way into one array.
    assert.equal(view.el.querySelectorAll('.usage-acct').length, 9)
  } finally { delete g.fetch }
})

test('§2b within each provider the host lane leads and the registry order is kept', async () => {
  const g = globalThis as unknown as Record<string, unknown>
  // the same accounts, handed over in a DIFFERENT registry order: claude-9
  // now precedes claude-4. The groups must not change, and the order inside
  // the Claude group must follow the registry rather than the account id.
  g.fetch = mockFetch({ ...ROUTES, '/api/accounts': { primary: 'claude-1', accounts: [
    row('claude-9', 'claude', 'c9@example.test'),
    row('openai-5', 'openai', 'o5@example.test'),
    row('claude-4', 'claude', 'c4@example.test'),
    row('openai-1', 'openai', 'o1@example.test'),
  ] } })
  try {
    const view = await openModal()
    assert.deepEqual(cardOrder(view.el), [
      'host:Claude Code', 'claude-9', 'claude-4',
      'host:Codex', 'openai-5', 'openai-1',
      'host:Antigravity', 'host:OpenRouter',
    ])
  } finally { delete g.fetch }
})

test('§2c grouping moves cards and changes nothing a card says', async () => {
  const g = globalThis as unknown as Record<string, unknown>
  g.fetch = mockFetch(ROUTES)
  try {
    const view = await openModal()
    const text = (sel: string) =>
      view.el.querySelector(sel)?.textContent ?? ''
    // each account keeps ITS OWN percentage — nothing was summed, swapped or
    // attached to the neighbour it is now sitting beside
    assert.match(text('[data-account="claude-4"]'), /c4@example\.test/)
    assert.match(text('[data-account="claude-4"]'), /44%/)
    assert.match(text('[data-account="claude-9"]'), /49%/)
    assert.match(text('[data-account="openai-1"]'), /51%/)
    assert.match(text('[data-account="google-7"]'), /77%/)
    // the host lanes keep their identity, plan and percentages too
    const whole = view.el.textContent ?? ''
    assert.match(whole, /claude-host@example\.test/)
    assert.match(whole, /codex-host@example\.test/)
    assert.match(whole, /agy-host@example\.test/)
    assert.match(whole, /11%/)
    assert.match(whole, /22%/)
    assert.match(whole, /33%/)
    assert.match(whole, /88%/)
    assert.match(whole, /\$44\.00 of \$50\.00 spend cap/)
    // one bar per account, all nine accounted for: no card lost to a key
    assert.equal(view.el.querySelectorAll('.usage-track').length, 9)
    // and each card still offers its own refresh, so freshness stayed per card
    assert.equal(view.el.querySelectorAll('.usage-refresh-button').length, 9)
  } finally { delete g.fetch }
})

test('§2d reset information survives the move, on the card it belongs to', async () => {
  const g = globalThis as unknown as Record<string, unknown>
  const resets = new Date(Date.now() + 3 * 3600_000 + 10 * 60_000).toISOString()
  g.fetch = mockFetch({ ...ROUTES,
    '/api/accounts/openai-1/usage': { ...usageFor('openai-1', 'openai', 51),
      limits: [{ kind: 'weekly_all', group: 'weekly', percent: 51,
        severity: 'normal', resets_at: resets, is_active: false, model: null }] } })
  try {
    const view = await openModal()
    const card = view.el.querySelector('[data-account="openai-1"]')!
    assert.match(card.textContent ?? '', /resets in 3h/)
    // ⚠ AND NOWHERE ELSE. A reset line that leaked onto a neighbouring card
    // would still match the assertion above if it were read off the modal.
    const others = [...view.el.querySelectorAll('.usage-acct')]
      .filter((c) => c !== card).map((c) => c.textContent ?? '').join(' ')
    assert.doesNotMatch(others, /resets in/)
  } finally { delete g.fetch }
})

test('§2e a provider with no ruled position lands after the three, whole', async () => {
  const g = globalThis as unknown as Record<string, unknown>
  // 'xenon' is a provider this build has never heard of, arriving interleaved
  // between the known ones. It must not split, and it must not push a ruled
  // provider down. It lands after OpenRouter because OpenRouter's lane appears
  // first — first appearance is the tiebreak between two unruled providers,
  // and it is what keeps the four host lanes in the order they always had.
  g.fetch = mockFetch({ ...ROUTES, '/api/accounts': { primary: 'claude-1', accounts: [
    row('xenon-1', 'xenon', 'x1@example.test'),
    row('claude-4', 'claude', 'c4@example.test'),
    row('xenon-2', 'xenon', 'x2@example.test'),
    row('openai-1', 'openai', 'o1@example.test'),
  ] },
    '/api/accounts/xenon-1/usage': usageFor('xenon-1', 'xenon', 61),
    '/api/accounts/xenon-2/usage': usageFor('xenon-2', 'xenon', 62) })
  try {
    const view = await openModal()
    assert.deepEqual(cardOrder(view.el), [
      'host:Claude Code', 'claude-4',
      'host:Codex', 'openai-1',
      'host:Antigravity',
      'host:OpenRouter',
      'xenon-1', 'xenon-2',
    ])
  } finally { delete g.fetch }
})

test('§2f a single account per provider is grouped the same way, and one provider alone is untouched', async () => {
  const g = globalThis as unknown as Record<string, unknown>
  g.fetch = mockFetch({ ...ROUTES, '/api/accounts': { primary: 'claude-1', accounts: [
    row('claude-4', 'claude', 'c4@example.test'),
  ] } })
  try {
    const view = await openModal()
    assert.deepEqual(cardOrder(view.el), [
      'host:Claude Code', 'claude-4', 'host:Codex', 'host:Antigravity',
      'host:OpenRouter',
    ])
  } finally { delete g.fetch }
})

test('§2h the cards became one keyed list without two of them sharing a key', async () => {
  // ⚠ WHY THIS IS NOT PARANOIA. HOST_CODEX and HOST_AGY both report the
  // ambient login as `account: "default"` — which is what the real payloads do
  // — and the four host lanes are now siblings in ONE array instead of four
  // separate slots. Keying a lane on `account` alone therefore puts the same
  // key on two children. React's own words for that are "may cause children to
  // be duplicated and/or omitted — the behavior is unsupported and could
  // change in a future version": it renders both TODAY, so a card count can
  // never catch it, and the warning is the only observable evidence.
  const g = globalThis as unknown as Record<string, unknown>
  g.fetch = mockFetch(ROUTES)
  const complaints: string[] = []
  const realError = console.error
  console.error = (...args: unknown[]) => { complaints.push(String(args[0])) }
  try {
    const view = await openModal()
    assert.equal(view.el.querySelectorAll('.usage-acct').length, 9)
    assert.deepEqual(complaints.filter((c) => /same key/i.test(c)), [],
      'two usage cards were rendered under one React key')
  } finally { console.error = realError; delete g.fetch }
})

test('§2g an unreadable registry still says so, below the grouped host lanes', async () => {
  const g = globalThis as unknown as Record<string, unknown>
  // ⚠ the notice is NOT an account card, so the regrouping must neither sort
  // it nor swallow it — that line is the whole fix for an earlier defect
  // (usageaccounts.test.tsx) where accounts went missing in silence.
  g.fetch = mockFetch({ ...ROUTES, '/api/accounts': new Error('registry down') })
  try {
    const view = await openModal()
    assert.deepEqual(cardOrder(view.el),
      ['host:Claude Code', 'host:Codex', 'host:Antigravity', 'host:OpenRouter'])
    assert.match(view.el.textContent ?? '',
      /registered accounts unavailable: registry down/)
  } finally { delete g.fetch }
})
