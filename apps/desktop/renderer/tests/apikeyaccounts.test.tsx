/** API-key accounts in the desktop (ticket redesign-api-key-inference-accounts,
 *  user decisions 2026-09-12). Three surfaces, each pinned to the RULE the
 *  ticket states rather than to its current markup:
 *    - the add-account dialog offers a key whether or not that provider has a
 *      subscription signed in, and never offers one for Google
 *    - the Usage answer for a key account is its SPEND, never a limit bar
 *    - the fallback toggle is hidden until an ENABLED key account exists
 */
import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { AccountsPanel, UsageBars } from '../src/canvas/accounts'
import type { AccountUsage } from '../src/types'

const account = (id: string, provider = 'claude', extra: Record<string, unknown> = {}) => ({
  id, provider, label: id, credential: { kind: 'managed', path: 'C:/fixture/' + id },
  identity: { email: id + '@example.test' }, auth: 'authenticated', tint_ordinal: 1,
  standing: { auth: 'authenticated', state: 'ready', marks: {} }, bound: [], ...extra,
})
const keyAccount = (id: string, provider = 'claude', enabled = true) =>
  account(id, provider, { mode: 'apikey', enabled, credential: { kind: 'apikey' } })

async function setup(t: TestContext, rows: unknown[], lanes: Record<string, unknown> = {}) {
  const oldFetch = globalThis.fetch
  const calls: { url: string; method: string; body: string }[] = []
  const state = { rows }
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const method = init?.method || 'GET'
    calls.push({ url: String(url), method, body: String(init?.body || '') })
    let body: unknown = {}
    const providers = {
      providers: ['claude', 'openai', 'google'].map((id, i) => ({
        id, label: ['Claude', 'Codex', 'Antigravity'][i], cli: id,
        status: { installed: true, connected: i !== 1 }, tiers: [], hire_enabled: true,
      })),
      apikey_fallback: { claude: false, openai: false },
      subscription_inference: { claude: true, openai: true, google: true },
      ...lanes,
    }
    if (String(url).includes('/providers')) body = providers
    else if (String(url).endsWith('/identity')) body = { auth: 'authenticated' }
    else if (method === 'POST') { body = account('new', 'claude') }
    else if (String(url) === '/api/accounts') body = { accounts: state.rows }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch
  const desk = window as unknown as { orgtreeDesktop?: unknown }
  desk.orgtreeDesktop = { getProviderLoginStatus: async () => ({ phase: 'idle' }), getPreferences: async () => ({}), onEvent: () => () => {} }
  const view = await mountView(<AccountsPanel toast={() => {}} close={() => {}} />, el => el)
  t.after(async () => { await view.unmount(); globalThis.fetch = oldFetch; delete desk.orgtreeDesktop })
  await inAct(async () => { await flush() })
  return { view, calls }
}
const lane = (provider: string) => document.querySelector('.prov-' + provider)!.closest('.acct-provider-group')!
const dialog = () => document.querySelector<HTMLElement>('.add-account-dialog')!
const button = (root: ParentNode, label: string) => [...root.querySelectorAll('button')].find(b => b.textContent === label)
const toggle = (provider: string, label: RegExp) =>
  [...lane(provider).querySelectorAll('input[type=checkbox]')]
    .find(i => label.test(i.getAttribute('aria-label') || '')) as HTMLInputElement | undefined

test('the API-key option is offered even when that provider is signed out, and never for Antigravity', async t => {
  // Codex is the signed-OUT provider in this fixture (connected: false).
  // That is the point: a key account must not require a subscription first.
  const { calls } = await setup(t, [account('existing')])
  await inAct(async () => { button(lane('openai'), 'Add secondary account')!.click(); await flush() })
  assert.ok(button(dialog(), 'Add API-key account'), 'signed-out provider still offers a key')
  const field = dialog().querySelector<HTMLInputElement>('input[type=password]')!
  assert.equal(button(dialog(), 'Add API-key account')!.disabled, true, 'no key typed yet')
  await inAct(() => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(field, '  sk-test-key  ')
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await inAct(async () => { button(dialog(), 'Add API-key account')!.click(); await flush() })
  assert.deepEqual(JSON.parse(calls.filter(c => c.method === 'POST').at(-1)!.body),
    { provider: 'openai', kind: 'apikey', key: 'sk-test-key' })

  await inAct(async () => { button(lane('google'), 'Add secondary account')!.click(); await flush() })
  assert.equal(button(dialog(), 'Add API-key account'), undefined,
    'Antigravity has no API-key login to offer')
})

test('a key account answers Usage with its spend, never a limit bar', async t => {
  const spent: AccountUsage = {
    account: 'claude-2', label: 'claude-2', available: true, mode: 'apikey',
    currency: 'USD', enabled: true,
    spend: { usd_total: 12.3456, turns: 3, since: 1789000000, updated_at: 1789000900 },
  }
  const view = await mountView(<UsageBars u={spent} />, el => el)
  t.after(async () => { await view.unmount() })
  const text = document.body.textContent!
  assert.match(text, /\$12\.35/, 'the authoritative total, rounded for reading')
  assert.match(text, /3 turns/)
  assert.equal(document.querySelector('.bar, .usage-bar, meter'), null, 'no limit bars for a metered key')
  assert.doesNotMatch(text, /%/, 'a percentage here would be a fabrication')
})

test('a key account that never ran says so instead of reading as zero spent', async t => {
  const fresh: AccountUsage = {
    account: 'claude-3', label: 'claude-3', available: true, mode: 'apikey',
    currency: 'USD', enabled: false, spend: { usd_total: 0, turns: 0 },
  }
  const view = await mountView(<UsageBars u={fresh} />, el => el)
  t.after(async () => { await view.unmount() })
  const text = document.body.textContent!
  assert.match(text, /no turns billed to this key yet/)
  assert.match(text, /off/, 'a disabled row says it is excluded from routing')
})

test('the fallback toggle appears only with an enabled key account; inference is always offered', async t => {
  await setup(t, [account('sub-only')])
  assert.equal(toggle('claude', /fall back to Claude API-key accounts/), undefined,
    'nothing to route to yet')
  assert.ok(toggle('claude', /use signed-in Claude subscription accounts/),
    'the inference control does not depend on key accounts')
})

test('a DISABLED key account still does not raise the fallback toggle', async t => {
  await setup(t, [keyAccount('claude-key', 'claude', false)])
  assert.equal(toggle('claude', /fall back to Claude API-key accounts/), undefined,
    'turning fallback on would still route nowhere')
})

test('an enabled key account raises the fallback toggle, off by default, and writes the machine setting', async t => {
  const { calls } = await setup(t, [keyAccount('claude-key')])
  const t1 = toggle('claude', /fall back to Claude API-key accounts/)!
  assert.ok(t1, 'the lane now exists')
  assert.equal(t1.checked, false, 'off by default')
  await inAct(async () => { t1.click(); await flush() })
  const put = calls.filter(c => c.method === 'PUT').at(-1)!
  assert.match(put.url, /\/api\/providers\/claude\/apikey-fallback$/)
  assert.deepEqual(JSON.parse(put.body), { enabled: true })
})

test('subscription inference can be turned off per provider', async t => {
  const { calls } = await setup(t, [keyAccount('claude-key')])
  const t1 = toggle('claude', /use signed-in Claude subscription accounts/)!
  assert.equal(t1.checked, true, 'on unless explicitly disabled')
  await inAct(async () => { t1.click(); await flush() })
  const put = calls.filter(c => c.method === 'PUT').at(-1)!
  assert.match(put.url, /\/api\/providers\/claude\/subscription-inference$/)
  assert.deepEqual(JSON.parse(put.body), { enabled: false })
})
