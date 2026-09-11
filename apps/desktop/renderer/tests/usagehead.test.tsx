// usagehead.test.tsx — every account card in the Usage modal wears the SAME
// head, and its stamp says how long ago the reading was taken.
//
// The user's screenshot (2026-09-11) showed two Claude Code cards in one
// modal aligned differently: the primary's identity sat on one row with its
// refresh button and time beside it, while a registered account's longer
// identity wrapped and left "updated 1:03 PM" stranded under the button.
// Each card wrote its own head. They share one component now, so §1 asserts
// the SHAPE OF EVERY CARD rather than one card's appearance — a card that
// goes back to writing its own head fails here even if it happens to look
// right on the day.
//
// ⚠ WHAT THIS FILE CANNOT SEE. Wrapping is CSS and jsdom does no layout, so
// nothing here can tell you the control stayed on the row. That is measured
// in a real browser, at the width the screenshot was taken at, by
// usagewrap_probe.py.

import './harness'
import { advance, flush, inAct, mountView } from './harness'
import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import { UsageModal } from '../src/App'
import type {
  AccountRegistryPayload, AccountUsage, RegisteredAccountUsage, UsagePayload,
} from '../src/types'

/** A fixed instant, and a reading taken two minutes before it. */
const NOW = Date.parse('2026-09-11T13:02:00Z')
const OBSERVED = new Date(NOW - 2 * 60_000).toISOString()

const limit = (percent: number) => ({
  kind: 'session', group: 'session', percent, severity: 'normal',
  resets_at: null, is_active: false, model: null,
})

const HOST_CLAUDE: UsagePayload = {
  available: true, plan: 'max', email: 'first@example.test',
  observed_at: OBSERVED, limits: [limit(65)],
}

const CODEX: AccountUsage = {
  account: 'codex', provider: 'Codex', label: 'codex-lane', available: true,
  plan: 'Pro', observed_at: OBSERVED, limits: [limit(12)],
}

const REGISTRY: AccountRegistryPayload = {
  primary: 'claude-1',
  accounts: [
    { id: 'claude-1', provider: 'claude', harness: 'claude-code',
      label: 'claude (machine login)',
      credential: { kind: 'imported', path: 'C:/Users/x/.claude', default_config: true },
      identity: { email: 'first@example.test' }, auth: 'authenticated',
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

const SECONDARY: RegisteredAccountUsage = {
  account: 'claude-4', provider: 'claude', label: 'claude-0', available: true,
  plan: 'Max', observed_at: OBSERVED, limits: [limit(42)],
  standing: { auth: 'authenticated', state: 'ready', marks: {} },
}

const AGY: AccountUsage = {
  account: 'antigravity', provider: 'Antigravity', label: 'agy-lane',
  available: true, plan: 'Ultra', observed_at: OBSERVED, limits: [limit(3)],
}

const ORR: AccountUsage = {
  account: 'openrouter', provider: 'OpenRouter', label: 'orr-lane',
  available: true, plan: 'credits', observed_at: OBSERVED, limits: [limit(8)],
}

const PROVIDERS = { providers: [
  { id: 'claude', hire_enabled: true, status: { installed: true } },
  { id: 'openai', hire_enabled: true, status: { installed: true } },
] }

/** Routes the modal is allowed to read. A path that is NOT listed rejects
 *  loudly rather than answering an empty object — an unnoticed extra call is
 *  how a card ends up rendering someone else's numbers. Each entry may be a
 *  body or an Error; `calls` records every path, in order, so a test can see
 *  a forced re-read actually reached the network. */
type Routes = Record<string, unknown>
function mockFetch(routes: Routes, calls: string[] = []) {
  return (url: string) => {
    const path = new URL(String(url), 'http://localhost').pathname
    calls.push(path)
    if (!(path in routes)) return Promise.reject(new Error(`unexpected fetch: ${path}`))
    const body = routes[path]
    if (body instanceof Error) return Promise.reject(body)
    return Promise.resolve({ ok: true, status: 200, headers: new Headers(),
      json: () => Promise.resolve(body) })
  }
}

/** ⚠ EVERY lane the modal renders answers here. A lane left unserved does
 *  not vanish — it renders a card carrying its failure, with no stamp on
 *  it — and §1 would then be comparing four healthy heads and skipping
 *  the fifth. §4 makes a card fail deliberately; nothing else should. */
const ALL: Routes = {
  '/api/usage': HOST_CLAUDE,
  '/api/providers': PROVIDERS,
  '/api/codex/usage': CODEX,
  '/api/antigravity/usage': AGY,
  '/api/openrouter/usage': ORR,
  '/api/accounts': REGISTRY,
  '/api/accounts/claude-4/usage': SECONDARY,
}

async function open(from: Routes = ALL, calls: string[] = []) {
  const g = globalThis as unknown as Record<string, unknown>
  // a COPY: §3 turns its routes into failures part-way through, and the
  // shared table it started from must not follow it into the next test
  const routes: Routes = { ...from }
  mock.timers.enable({ apis: ['Date', 'setInterval'], now: NOW })
  g.fetch = mockFetch(routes, calls)
  const view = await mountView(
    <UsageModal close={() => {}} toast={() => {}} />, (el) => el)
  await inAct(async () => { await flush(8) })
  return {
    view,
    calls,
    routes,
    close: async () => {
      await view.unmount()
      mock.timers.reset()
      delete g.fetch
    },
  }
}

const cards = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>('.usage-acct')]
const head = (card: HTMLElement) => card.querySelector<HTMLElement>('.usage-acct-head')!
const updated = (card: HTMLElement) =>
  card.querySelector<HTMLElement>('.usage-updated')?.textContent?.trim() ?? null

/** The head's structure, as a value two cards can be compared BY. */
const shapeOf = (card: HTMLElement) => {
  const h = head(card)
  const line = h.querySelector('.usage-refresh .usage-refresh-line')
  return {
    head: [...h.children].map((c) => c.className),
    who: [...(h.querySelector('.usage-acct-who')?.children ?? [])]
      .map((c) => c.className),
    line: [...(line?.children ?? [])]
      .map((c) => `${c.tagName.toLowerCase()}.${c.className}`),
  }
}

test('§1 every account card wears the same head, primary and registered alike',
  async () => {
    const t = await open()
    try {
      const all = cards(t.view.el)
      // POSITIVE CONTROL: every kind of card is really on screen — the
      // primary Claude lane, three other provider lanes and a registered
      // account. With fewer, "they all match" is a claim about nothing.
      assert.equal(all.length, 5, t.view.el.textContent ?? '')
      assert.ok(t.view.el.querySelector('[data-account="claude-4"]'),
        'the registered account card is missing, so §1 compares host lanes only')

      const expected = {
        head: ['usage-acct-who', 'usage-refresh'],
        who: ['acct-label', 'dim'],
        line: ['button.usage-refresh-button', 'span.usage-updated'],
      }
      for (const card of all) {
        assert.deepEqual(shapeOf(card), expected,
          `this card writes its own head: ${head(card).textContent}`)
      }
    } finally { await t.close() }
  })

test('§2 the stamp is how long ago, not what time it was', async () => {
  const t = await open()
  try {
    for (const card of cards(t.view.el)) {
      assert.equal(updated(card), 'updated 2m ago',
        head(card).textContent ?? '')
      // the clock reading it replaced must not survive anywhere in the head
      assert.doesNotMatch(head(card).textContent ?? '', /\d{1,2}:\d{2}/)
    }
    // …and the exact instant is still available on hover, so nothing was lost
    const stamp = t.view.el.querySelector('.usage-updated')!
    assert.match(stamp.getAttribute('title') ?? '', /^updated \d{1,2}:\d{2}/)
  } finally { await t.close() }
})

test('§3 the age keeps moving while refreshes fail, and never announces itself',
  async () => {
    const t = await open()
    try {
      assert.equal(updated(cards(t.view.el)[0]!), 'updated 2m ago')
      // ⚠ THE CASE THAT MATTERS: reads now fail, so no new stamp ever
      // arrives. The age must still advance — a frozen "2m ago" over a
      // reading that is by now eight minutes old is the lie this line
      // exists to prevent.
      for (const path of Object.keys(t.routes)) {
        t.routes[path] = new Error('upstream down')
      }
      const first = cards(t.view.el)[0]!
      await inAct(async () => {
        first.querySelector<HTMLButtonElement>('.usage-refresh-button')!.click()
        await flush(8)
      })
      assert.match(first.textContent ?? '', /refresh failed: upstream down/)
      assert.equal(updated(first), 'updated 2m ago',
        'a failed read must not restamp the reading it could not replace')
      await advance(6 * 60_000)
      assert.equal(updated(first), 'updated 8m ago')
      // it is not a live region: this text changes on its own every few
      // seconds, and a polite region would read it out each time
      assert.equal(first.querySelector('.usage-updated')!
        .getAttribute('aria-live'), null)
    } finally { await t.close() }
  })

test('§4 a card with no reading yet shows no age at all', async () => {
  const t = await open({ ...ALL, '/api/accounts/claude-4/usage': new Error('no route') })
  try {
    const card = t.view.el.querySelector<HTMLElement>('[data-account="claude-4"]')
    assert.ok(card, `no registered card rendered: ${t.view.el.textContent}`)
    assert.equal(updated(card), null,
      'a card that never got a reading invented a time for it')
    assert.doesNotMatch(card.textContent ?? '', /updated/)
    // …and it says what went wrong instead of going quiet
    assert.match(card.textContent ?? '', /refresh failed: no route/)
    // the cards that DID read still show their age — the absence above is
    // this card's own state, not the whole modal falling back
    assert.equal(updated(cards(t.view.el)[0]!), 'updated 2m ago')
  } finally { await t.close() }
})

test('§5 each card refreshes its own account, under its own name', async () => {
  const t = await open()
  try {
    const card = t.view.el.querySelector<HTMLElement>('[data-account="claude-4"]')
    assert.ok(card, `no registered card rendered: ${t.view.el.textContent}`)
    const button = card.querySelector<HTMLButtonElement>('.usage-refresh-button')!
    assert.equal(button.getAttribute('aria-label'), 'refresh claude-0 usage')
    assert.equal(cards(t.view.el)[0]!
      .querySelector('.usage-refresh-button')!.getAttribute('aria-label'),
    'refresh Claude usage')
    const before = t.calls.filter((p) => p === '/api/accounts/claude-4/usage').length
    await inAct(async () => { button.click(); await flush(8) })
    assert.equal(
      t.calls.filter((p) => p === '/api/accounts/claude-4/usage').length,
      before + 1, 'the button did not re-read this account')
    // and it read nobody else's
    assert.equal(t.calls.filter((p) => p === '/api/usage').length, 1)
  } finally { await t.close() }
})
