// apikeyemail.test.tsx — an API-key account has no email, so its account line
// says nothing in that place instead of "email unavailable".
//
// Docket `api-key-accounts-show-email-unavailable-in-the-a` (USER 2026-11-08
// 15:18:36Z mc6c4d386f4ab: "the claude-6 usage says email unavailable. it
// should just say nothing (or be a truncated prefix of the api key)"). The
// liaison chose nothing (no key fragment: the screen is sometimes streamed).
// The engine marks such rows `mode: "apikey"` (accounts.rs). A SUBSCRIPTION
// account whose email failed to load keeps "email unavailable".
//
//   §1 the identity string omits the email slot for a key account
//   §2 the account choosers (providerAccounts) read "claude-6", not "claude-6 · email unavailable"
//   §3 the usage head part carries no email for a key account (and always names the account)
//   §5 the Providers row of a key account: no Sign in button, no sign-in status, no email text; Refresh and Remove stay
//   §4 the controls: subscription rows without an email keep the wording
import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { AccountsPanel } from '../src/canvas/accounts'
import { accountIdentity, providerAccounts, usageIdentity, usageIdentityPart } from '../src/accountidentity'
import type { AccountChoiceRow } from '../src/accountidentity'

const rows: AccountChoiceRow[] = [
  { id: 'claude-5', provider: 'claude', identity: { email: 'a@example.test' } },
  { id: 'claude-6', provider: 'claude', mode: 'apikey', identity: {} },
  { id: 'claude-7', provider: 'claude', identity: {} },           // subscription, email failed to load
]

test('§1 a key account reads as its id alone', () => {
  assert.equal(accountIdentity('claude-6', undefined, true), 'claude-6')
  assert.equal(accountIdentity('claude-6', null, true), 'claude-6')
})

test('§2 the account choosers: key account has no email text, subscription rows are unchanged', () => {
  const text = (v: string) => providerAccounts(rows, 'claude').find((c) => c.value === v)?.text
  assert.equal(text('claude-6'), 'claude-6')
  assert.equal(text('claude-5'), 'claude-5 · a@example.test')
  assert.equal(text('claude-7'), 'claude-7 · email unavailable')
})

test('§3 usage head: a key account shows its id and an empty email, even when it is the only account', () => {
  assert.deepEqual(usageIdentityPart('claude-6', undefined, false, true), { id: 'claude-6', email: '' })
  assert.equal(usageIdentity('claude-6', undefined, false, true), 'claude-6')
  assert.equal(usageIdentity('claude-6', undefined, true, true), 'claude-6')
})

test('§4 controls: a subscription account with no email keeps "email unavailable"', () => {
  assert.equal(accountIdentity('claude-7', undefined), 'claude-7 · email unavailable')
  assert.deepEqual(usageIdentityPart('claude-7', undefined, true), { id: 'claude-7', email: 'email unavailable' })
  assert.deepEqual(usageIdentityPart('default', undefined, false), { email: 'email unavailable' })
})

test('§2b a key account in a chooser carries no sign-in-required suffix', () => {
  const key: AccountChoiceRow[] = [{ id: 'claude-6', provider: 'claude', mode: 'apikey', identity: {}, standing: { auth: 'unauthenticated' } },
    { id: 'claude-7', provider: 'claude', identity: {}, standing: { auth: 'unauthenticated' } }]
  const text = (v: string) => providerAccounts(key, 'claude').find((c) => c.value === v)?.text
  assert.equal(text('claude-6'), 'claude-6')
  assert.equal(text('claude-7'), 'claude-7 · email unavailable (sign-in required)')
})

test('§5 Providers row: a key account has no Sign in button, no sign-in status and no email text', async (t: TestContext) => {
  const mk = (id: string, mode?: string) => ({ id, provider: 'claude', label: id, name: id, ambient: false,
    credential: { kind: 'managed', path: 'C:/fixture/' + id }, ...(mode ? { mode } : {}),
    identity: {}, auth: 'unauthenticated', tint_ordinal: 1,
    standing: { auth: 'unauthenticated', state: 'ready', marks: {} }, bound: [] })
  const oldFetch = globalThis.fetch
  globalThis.fetch = (async (url: string) => {
    const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } })
    if (String(url).endsWith('/providers')) return json({ providers: ['claude', 'openai', 'google'].map((id) => ({
      id, label: id, cli: id, status: { installed: true, connected: true }, tiers: [], hire_enabled: true })) })
    if (String(url) === '/api/accounts') return json({ accounts: [mk('claude-6', 'apikey'), mk('claude-7')] })
    return json({})
  }) as typeof fetch
  const desk = window as unknown as { orgtreeDesktop?: unknown }
  desk.orgtreeDesktop = { getProviderLoginStatus: async () => ({ phase: 'idle' }), getPreferences: async () => ({}), onEvent: () => () => {} }
  const view = await mountView(<AccountsPanel toast={() => {}} close={() => {}} />, (el) => el)
  t.after(async () => { await view.unmount(); globalThis.fetch = oldFetch; delete desk.orgtreeDesktop })
  await inAct(async () => { await flush() })
  const lane = document.querySelector('.prov-claude')!.closest('.acct-provider-group')!
  const row = (id: string) => [...lane.querySelectorAll('.account-row')].find((r) => r.textContent?.includes(id))!
  const buttons = (r: Element) => [...r.querySelectorAll('button')].map((b) => b.textContent?.trim())
  const key = row('claude-6'), sub = row('claude-7')
  assert.ok(key && sub, 'both rows rendered')
  assert.ok(buttons(sub).some((b) => /^Sign in/.test(b ?? '')), 'control: a subscription row keeps Sign in')
  assert.match(sub.textContent ?? '', /Sign-in required/)
  assert.match(sub.textContent ?? '', /email unavailable/)
  assert.equal(buttons(key).some((b) => /^Sign in/.test(b ?? '')), false, `key row buttons: ${buttons(key)}`)
  assert.ok(buttons(key).includes('Refresh') && buttons(key).includes('Remove'), 'Refresh and Remove stay')
  assert.doesNotMatch(key.textContent ?? '', /sign-in|signed-in|email unavailable/i, key.textContent ?? '')
  assert.match(key.textContent ?? '', /claude-6/)
})
