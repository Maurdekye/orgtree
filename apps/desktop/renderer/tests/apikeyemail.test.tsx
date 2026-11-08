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
//   §4 the controls: subscription rows without an email keep the wording
import test from 'node:test'
import assert from 'node:assert/strict'
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
