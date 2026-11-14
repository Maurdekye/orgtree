/** A hire tile is offered when an account can run it.
 *
 *  An engine marked Claude and Codex hirable by its own default sign-in alone
 *  and did not count registered accounts (every engine through
 *  4.6.0-alpha.1; the v4.5.11 providers payload has the same fields as
 *  today's). A headless engine is signed in to account folders, with its
 *  default profile empty, so every tile of a window on it was greyed with
 *  "isn't signed in" while its agents ran on those accounts (user report
 *  2026-11-14, on a 4.5.11 engine).
 *
 *  The engine answers right from 4.6.0 on. A window can also be connected to
 *  an engine that still answers the old way, so it applies the same rule to
 *  the accounts list it is given. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { familyOffer, hireDisabledReason, hireOf, providersWithAccounts } from '../src/canvas/shared'
import type { AccountRegistryRow, ProviderInfo } from '../src/types'

const provider = (id: string, patch: Partial<ProviderInfo> = {}): ProviderInfo => ({
  id, label: id === 'openai' ? 'Codex' : 'Claude', cli: id === 'openai' ? 'codex' : 'claude', tiers: [],
  status: { installed: true, connected: false }, hire_enabled: false, hire_reason: 'signed_out',
  reason: `${id === 'openai' ? 'Codex' : 'Claude'} is installed but not signed in`, user_enabled: true, ...patch,
})
const account = (id: string, patch: Partial<AccountRegistryRow> = {}): AccountRegistryRow => ({
  id, provider: 'claude', harness: 'claude-code', label: '', credential: { kind: 'subscription', path: '/srv/orgtree/data/profiles/' + id },
  identity: {}, auth: 'authenticated', tint_ordinal: 0, enabled: true,
  standing: { auth: 'authenticated', state: 'ready', marks: {} } as AccountRegistryRow['standing'], bound: [], ...patch,
})
const offered = (providers: ProviderInfo[], accounts: AccountRegistryRow[] | null | undefined, id: string) => {
  const entry = providersWithAccounts(providers, accounts).find((p) => p.id === id)
  return { offer: familyOffer(hireOf(entry, true)), reason: entry?.reason ?? null, why: entry?.hire_reason ?? null }
}

test('a signed-in registered account makes Claude and Codex hirable when the engine says only its own sign-in is signed out', () => {
  const both = [provider('claude'), provider('openai')]
  // as the old engine answers, with nothing to go by: greyed, with the sentence
  assert.deepEqual(offered(both, [], 'claude'), { offer: 'disable', reason: 'Claude is installed but not signed in', why: 'signed_out' })
  assert.match(hireDisabledReason(hireOf(both[0], true), 'Claude'), /isn't signed in/)
  // an account folder that is signed in: offered, and nothing left to say
  assert.deepEqual(offered(both, [account('claude-2')], 'claude'), { offer: 'offer', reason: null, why: null })
  assert.deepEqual(offered(both, [account('openai-1', { provider: 'openai', harness: 'codex-cli' })], 'openai'), { offer: 'offer', reason: null, why: null })
  // an API key account
  assert.equal(offered(both, [account('claude-key', { auth: '', mode: 'apikey', credential: { kind: 'apikey', token_ref: 'claude-key' } })], 'claude').offer, 'offer')
  // each provider by its own accounts
  assert.equal(offered(both, [account('claude-2')], 'openai').offer, 'disable')
  assert.equal(offered(both, [account('openai-1', { provider: 'openai' })], 'claude').offer, 'disable')
})

test('what does not count, and what the rule never touches', () => {
  const claude = [provider('claude')]
  // switched off, not signed in, or the row that stands for the engine's own sign-in
  assert.equal(offered(claude, [account('claude-2', { enabled: false })], 'claude').offer, 'disable')
  assert.equal(offered(claude, [account('claude-2', { auth: 'unauthenticated' })], 'claude').offer, 'disable')
  assert.equal(offered(claude, [account('primary', { ambient: true })], 'claude').offer, 'disable')
  // a list that has not arrived says nothing
  assert.equal(offered(claude, null, 'claude').offer, 'disable')
  assert.equal(offered(claude, undefined, 'claude').offer, 'disable')
  // only "signed out" is answered by an account: not installed stays hidden, turned off stays hidden
  const signedIn = [account('claude-2')]
  assert.equal(offered([provider('claude', { status: { installed: false }, hire_reason: 'not_installed' })], signedIn, 'claude').offer, 'hide')
  assert.equal(offered([provider('claude', { user_enabled: false, hire_reason: 'turned_off' })], signedIn, 'claude').offer, 'hide')
  // an engine that already answers right is left as it is, object for object
  const fine = [provider('claude', { hire_enabled: true, hire_reason: null, reason: null })]
  assert.equal(providersWithAccounts(fine, signedIn)[0], fine[0])
  assert.equal(providersWithAccounts(claude, [])[0], claude[0])
  // other providers have their own rules in the engine (Muse counts its logins there)
  const muse = [provider('muse', { label: 'Muse' })]
  assert.equal(providersWithAccounts(muse, [account('muse-2', { provider: 'muse' })])[0], muse[0])
})
